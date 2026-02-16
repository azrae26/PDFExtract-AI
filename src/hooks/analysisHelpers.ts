/**
 * 功能：PDF 分析核心純函式工具模組
 * 職責：PDF 頁面渲染、API 呼叫（含失敗自動重試最多 2 次、前端傳入 apiKey）、分析結果合併（回傳空文字 region 清單）、
 *       頁面 canvas 渲染與區域裁切（renderPageCanvas + cropRegionFromCanvas，支援同頁多 region 複用同一 canvas）、
 *       區域截圖裁切、區域識別 API
 * 依賴：pdfjs、types、constants、pdfTextExtract
 *
 * 重要設計：
 * - 所有函式皆為純函式（不依賴 React state），接受 isSessionValid callback 作為參數
 * - 可獨立單元測試
 * - 共用型別：FileRegionsUpdater、FileReportUpdater、FileProgressUpdater、SessionValidator
 */

import { pdfjs } from 'react-pdf';
import { Region } from '@/lib/types';
import { RENDER_SCALE, JPEG_QUALITY, NORMALIZED_MAX } from '@/lib/constants';
import { extractTextForRegions } from '@/lib/pdfTextExtract';

// === API 失敗重試設定 ===
export const MAX_RETRIES = 2; // 最多重試 2 次（總共 3 次嘗試）
export const RETRY_BASE_DELAY_MS = 1500; // 首次重試等待 1.5 秒，之後遞增

/** 檔案級 regions 更新器：直接寫入 files 陣列（Single Source of Truth） */
export type FileRegionsUpdater = (
  targetFileId: string,
  updater: (prev: Map<number, Region[]>) => Map<number, Region[]>,
) => void;

/** 檔案級 report 更新器：更新指定檔案的券商名 */
export type FileReportUpdater = (targetFileId: string, report: string) => void;

/** per-file 分析進度更新器：設定絕對值或增減量 */
export type FileProgressUpdater = (
  targetFileId: string,
  update: {
    analysisPages?: number;   // 設定分析目標頁數（絕對值）
    completedPages?: number;  // 設定已完成頁數（絕對值）
    completedDelta?: number;  // 已完成頁數增減量
    analysisDelta?: number;   // 分析目標頁數增減量
    status?: 'processing' | 'done' | 'stopped' | 'error'; // 同時更新檔案狀態（可選）
  },
) => void;

/** Session 有效性檢查函式型別 */
export type SessionValidator = (sessionId: number) => boolean;

// === 將 PDF 單頁渲染為 JPEG 圖片 ===
// 傳入 pdfDoc 快照 + sessionId，避免使用可能已被替換的 pdfDocRef.current
export async function renderPageToImage(
  pageNum: number,
  pdfDoc: pdfjs.PDFDocumentProxy,
  sessionId: number,
  isSessionValid: SessionValidator,
): Promise<string | null> {
  if (!isSessionValid(sessionId)) return null;

  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`[analysisHelpers][${timestamp}] 🖼️ Rendering page ${pageNum} to image...`);

  try {
    const page = await pdfDoc.getPage(pageNum);
    if (!isSessionValid(sessionId)) return null;

    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d')!;

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    if (!isSessionValid(sessionId)) {
      canvas.remove();
      return null;
    }

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    const w = canvas.width;
    const h = canvas.height;
    canvas.remove();

    const base64 = dataUrl.split(',')[1];
    const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
    const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[analysisHelpers][${ts2}] 📐 Page ${pageNum} JPEG: ${w}x${h}px, ${sizeKB} KB (scale=${RENDER_SCALE}, quality=${JPEG_QUALITY})`);
    return base64;
  } catch (e) {
    // RenderingCancelledException 或 document 已銷毀 → 靜默返回 null
    const eName = (e as { name?: string })?.name ?? '';
    const isCancel = eName === 'RenderingCancelledException' || !isSessionValid(sessionId);
    if (isCancel || String(e).includes('sendWithPromise')) {
      const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[analysisHelpers][${ts2}] ⚠️ Rendering cancelled for page ${pageNum} (file switched or aborted)`);
      return null;
    }
    throw e;
  }
}

// === 分析單頁（含失敗自動重試最多 2 次）===
export async function analyzePageWithRetry(
  pageNum: number,
  promptText: string,
  modelId: string,
  pdfDoc: pdfjs.PDFDocumentProxy,
  sessionId: number,
  isSessionValid: SessionValidator,
  apiKey?: string,
) {
  const imageBase64 = await renderPageToImage(pageNum, pdfDoc, sessionId, isSessionValid);
  if (!imageBase64) return null; // rendering 被取消或 session 失效

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (!isSessionValid(sessionId)) return null;

    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

    try {
      if (attempt > 0) {
        console.log(`[analysisHelpers][${timestamp}] 🔄 Page ${pageNum} retry ${attempt}/${MAX_RETRIES}...`);
      } else {
        console.log(`[analysisHelpers][${timestamp}] 📤 Sending page ${pageNum} to API (model: ${modelId})...`);
      }

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageBase64,
          prompt: promptText,
          page: pageNum,
          model: modelId,
          ...(apiKey ? { apiKey } : {}),
        }),
      });

      const result = await response.json();

      if (result.success) {
        console.log(
          `[analysisHelpers][${timestamp}] ✅ Page ${pageNum}: ${result.data.regions.length} regions found`
        );
        return result.data;
      }

      console.error(`[analysisHelpers][${timestamp}] ❌ Page ${pageNum} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, result.error);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        console.log(`[analysisHelpers][${timestamp}] ⏳ Waiting ${delay}ms before retry...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return null;
    } catch (err) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.error(`[analysisHelpers][${ts}] ❌ Error analyzing page ${pageNum} (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, err);

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        console.log(`[analysisHelpers][${ts}] ⏳ Waiting ${delay}ms before retry...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return null;
    }
  }

  return null;
}

/** 處理單頁分析結果：提取文字 + merge 到 pageRegions + 儲存券商名
 *  回傳空文字 region 清單（含 bbox），供呼叫端決定是否自動 AI 識別
 *  注意：空 region 的 bbox 用於後續 cropRegionFromCanvas，呼叫端用 bbox 比對來更新 state */
// 傳入 pdfDoc 快照 + sessionId + targetFileId
export async function mergePageResult(
  pageNum: number,
  result: { hasAnalysis: boolean; report?: string; regions: Region[] },
  pdfDoc: pdfjs.PDFDocumentProxy,
  sessionId: number,
  isSessionValid: SessionValidator,
  targetFileId: string,
  updateFileRegions: FileRegionsUpdater,
  updateFileReport: FileReportUpdater,
): Promise<Region[]> {
  // 儲存券商名（只要有 report 就更新，即使沒有 regions）
  if (result.report) {
    updateFileReport(targetFileId, result.report);
  }

  if (!result.hasAnalysis || result.regions.length === 0) {
    // 即使沒有區域，也在 pageRegions 標記該頁已完成（空陣列）
    // 這樣「繼續分析」才能知道哪些頁面已跑過，不需重跑
    if (isSessionValid(sessionId)) {
      updateFileRegions(targetFileId, (prev) => {
        const updated = new Map(prev);
        if (!updated.has(pageNum)) {
          updated.set(pageNum, []);
        }
        return updated;
      });
    }
    return [];
  }
  if (!isSessionValid(sessionId)) return [];

  let regionsWithText = result.regions;
  try {
    const pdfPage = await pdfDoc.getPage(pageNum);
    if (!isSessionValid(sessionId)) return [];
    regionsWithText = await extractTextForRegions(pdfPage, result.regions);
  } catch (e) {
    // document 已銷毀時不要噴錯
    if (!isSessionValid(sessionId)) return [];
    console.warn(`[analysisHelpers] ⚠️ Text extraction failed for page ${pageNum}`, e);
  }

  if (!isSessionValid(sessionId)) return [];

  // 在 state updater 之外直接收集空文字 region（React 18 batching 會延遲 updater 執行）
  const emptyRegions = regionsWithText.filter((r) => !r.text.trim());
  if (emptyRegions.length > 0) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[analysisHelpers][${ts}] 🔘 Page ${pageNum}: ${emptyRegions.length} empty region(s) kept as gray (${regionsWithText.length} total)`);
  }

  // Merge：保留 userModified 的 regions，追加 AI 新結果
  const mergeUpdater = (prev: Map<number, Region[]>) => {
    const updated = new Map(prev);
    const existing = updated.get(pageNum) || [];
    const userRegions = existing.filter((r) => r.userModified);
    const maxExistingId = userRegions.reduce((max, r) => Math.max(max, r.id), 0);
    const aiRegions = regionsWithText.map((r: Region, i: number) => ({
      ...r,
      id: maxExistingId + i + 1,
      userModified: false,
    }));
    updated.set(pageNum, [...userRegions, ...aiRegions]);
    return updated;
  };
  updateFileRegions(targetFileId, mergeUpdater);
  return emptyRegions;
}

/** 渲染 PDF 頁面到 canvas（不銷毀），供多次裁切複用。呼叫端負責 canvas.remove() */
export async function renderPageCanvas(
  pdfDoc: pdfjs.PDFDocumentProxy,
  page: number,
): Promise<{ canvas: HTMLCanvasElement; viewport: { width: number; height: number } }> {
  const pdfPage = await pdfDoc.getPage(page);
  const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
  return { canvas, viewport: { width: viewport.width, height: viewport.height } };
}

/** 從已渲染的 canvas 裁切指定 region 為 base64 JPEG（不銷毀來源 canvas） */
export function cropRegionFromCanvas(
  canvas: HTMLCanvasElement,
  viewport: { width: number; height: number },
  region: Region,
): { base64: string; width: number; height: number; sizeKB: number } {
  const [x1, y1, x2, y2] = region.bbox;
  const sx = (x1 / NORMALIZED_MAX) * viewport.width;
  const sy = (y1 / NORMALIZED_MAX) * viewport.height;
  const sw = ((x2 - x1) / NORMALIZED_MAX) * viewport.width;
  const sh = ((y2 - y1) / NORMALIZED_MAX) * viewport.height;

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = Math.round(sw);
  cropCanvas.height = Math.round(sh);
  const cropCtx = cropCanvas.getContext('2d')!;
  cropCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);

  const dataUrl = cropCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const base64 = dataUrl.split(',')[1];
  const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
  const width = cropCanvas.width;
  const height = cropCanvas.height;

  cropCanvas.remove();
  return { base64, width, height, sizeKB };
}

/** 將 PDF 頁面中的指定區域截圖裁切為 base64 JPEG */
export async function cropRegionToBase64(
  pdfDoc: pdfjs.PDFDocumentProxy,
  page: number,
  region: Region,
): Promise<{ base64: string; width: number; height: number; sizeKB: number }> {
  const pdfPage = await pdfDoc.getPage(page);
  const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });

  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = viewport.width;
  fullCanvas.height = viewport.height;
  const ctx = fullCanvas.getContext('2d')!;
  await pdfPage.render({ canvas: fullCanvas, canvasContext: ctx, viewport }).promise;

  // bbox 歸一化座標 → 像素座標
  const [x1, y1, x2, y2] = region.bbox;
  const sx = (x1 / NORMALIZED_MAX) * viewport.width;
  const sy = (y1 / NORMALIZED_MAX) * viewport.height;
  const sw = ((x2 - x1) / NORMALIZED_MAX) * viewport.width;
  const sh = ((y2 - y1) / NORMALIZED_MAX) * viewport.height;

  // 裁切到新 canvas
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = Math.round(sw);
  cropCanvas.height = Math.round(sh);
  const cropCtx = cropCanvas.getContext('2d')!;
  cropCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);

  // 轉 base64 JPEG
  const dataUrl = cropCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const base64 = dataUrl.split(',')[1];
  const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
  const width = cropCanvas.width;
  const height = cropCanvas.height;

  fullCanvas.remove();
  cropCanvas.remove();

  return { base64, width, height, sizeKB };
}

/** 呼叫 /api/recognize 識別區域內容（含失敗自動重試最多 2 次） */
export async function recognizeRegionWithRetry(
  base64: string,
  promptText: string,
  modelId: string,
  page: number,
  regionId: number,
  apiKey?: string,
): Promise<{ success: boolean; text?: string; error?: string }> {
  let lastError = '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const retryTs = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[analysisHelpers][${retryTs}] 🔄 Region recognize retry ${attempt}/${MAX_RETRIES}...`);
      }

      const response = await fetch('/api/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64,
          prompt: promptText,
          model: modelId,
          page,
          regionId,
          ...(apiKey ? { apiKey } : {}),
        }),
      });
      const result = await response.json();

      if (result.success && result.text) {
        return { success: true, text: result.text };
      }

      lastError = result.error || '未知錯誤';
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : '未知錯誤';
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }

  return { success: false, error: lastError };
}
