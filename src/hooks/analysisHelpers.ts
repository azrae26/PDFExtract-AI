/**
 * 功能：PDF 分析核心純函式工具模組
 * 職責：PDF 頁面渲染、API 呼叫（含失敗自動重試最多 2 次、429 速率限制等 10s 重試 + 連 2 次退回 Flash、前端傳入 apiKey）、分析結果合併（回傳空文字 region 清單）、
 *       頁面 canvas 渲染與區域裁切（renderPageCanvas + cropRegionFromCanvas，支援同頁多 region 複用同一 canvas）、
 *       區域截圖裁切、區域識別 API、date/code/report metadata 候選值更新、
 *       畸形 bbox 偵測（isMalformedBbox：座標反轉或極端長形）
 * 依賴：pdfjs、types、constants、pdfTextExtract、brokerUtils、kaiuCmap（亂碼偵測）
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
import { isCompleteDate, shouldIgnoreBroker } from '@/lib/brokerUtils';
import { isCidPassthrough } from '@/lib/kaiuCmap';

/** 判定文字是否為亂碼（CID passthrough、錯誤編碼等），應觸發 AI 識別
 *  可讀字元：CJK、ASCII 可列印、常用標點。若可讀比例過低則視為亂碼 */
function isGarbledText(str: string): boolean {
  const t = str.trim();
  if (!t || t.length < 4) return false;
  if (isCidPassthrough(t)) return true;
  let readable = 0;
  for (let i = 0; i < t.length; i++) {
    const cp = t.codePointAt(i)!;
    if (cp >= 0x4e00 && cp <= 0x9fff) readable++;
    else if (cp >= 0x20 && cp <= 0x7e) readable++;
    else if (cp >= 0x3000 && cp <= 0x303f) readable++;
    else if (cp >= 0xff00 && cp <= 0xffef) readable++;
    else if (cp >= 0x2000 && cp <= 0x206f) readable++; // 通用標點
  }
  return readable / t.length < 0.35;
}

/** 判定 bbox 是否為畸形框（座標反轉或極端長形），AI 產出此類框時應退回重跑該頁
 *  座標格式 [x1, y1, x2, y2]，範圍 0~1000
 *  isPortrait：直式頁面 true、橫式頁面 false（直式 4%/15%，橫式 3%/20%）*/
export function isMalformedBbox(bbox: [number, number, number, number], isPortrait: boolean): boolean {
  const [x1, y1, x2, y2] = bbox;
  const w = x2 - x1;
  const h = y2 - y1;
  // 座標反轉（負寬或負高）
  if (w <= 0 || h <= 0) return true;
  // 極端長形：直的頁面 4%/15%，橫的頁面 3%/20%
  const narrow = isPortrait ? 40 : 30;   // 直 4%, 橫 3%
  const long = isPortrait ? 150 : 200;  // 直 15%, 橫 20%
  if ((w < narrow && h > long) || (h < narrow && w > long)) return true;
  return false;
}

// === API 失敗重試設定 ===
export const MAX_RETRIES = 2; // 最多重試 2 次（總共 3 次嘗試）
export const RETRY_BASE_DELAY_MS = 1500; // 首次重試等待 1.5 秒，之後遞增
/** 畸形 bbox 導致該頁重跑的最大次數 */
export const MAX_MALFORMED_RETRIES = 5;
/** 429 速率限制等待時間（毫秒） */
export const RATE_LIMIT_DELAY_MS = 10_000;
/** 429 連續命中次數上限（安全閥），超過即放棄 */
export const MAX_RATE_LIMIT_RETRIES = 4;
/** 429 連續 2 次後退回的模型 */
export const RATE_LIMIT_FALLBACK_MODEL = 'gemini-3-flash-preview';

// === 全域 429 速率限制暫停（模組級 singleton，所有 worker 共享）===
// 任一 worker 遇到 429 → 設定暫停時間戳 → 其他 worker 在下一次 API 呼叫前等待
let _rateLimitResumeAt = 0;
/** 設定全域 429 暫停（所有 worker 在此時間之前不送出新 API 呼叫） */
function setGlobalRateLimitPause() {
  _rateLimitResumeAt = Date.now() + RATE_LIMIT_DELAY_MS;
}
/** 等待全域 429 暫停結束（若無暫停或已過期則立即返回） */
async function waitForGlobalRateLimit() {
  const remaining = _rateLimitResumeAt - Date.now();
  if (remaining > 0) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[analysisHelpers][${ts}] ⏸️ Global rate limit pause: waiting ${Math.ceil(remaining / 1000)}s...`);
    await new Promise((r) => setTimeout(r, remaining));
  }
}

/** 檔案級 regions 更新器：直接寫入 files 陣列（Single Source of Truth） */
export type FileRegionsUpdater = (
  targetFileId: string,
  updater: (prev: Map<number, Region[]>) => Map<number, Region[]>,
) => void;

/** 檔案級 report 更新器：更新指定檔案的券商名 */
export type FileReportUpdater = (targetFileId: string, report: string) => void;

/** 檔案級 metadata 更新器：追加 date/code/broker 候選值（來源通常為 AI） */
export type FileMetadataUpdater = (
  targetFileId: string,
  patch: { date?: string; code?: string; broker?: string; source: 'filename' | 'ai' | 'manual' },
) => void;

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

    await page.render({ canvasContext: ctx, viewport }).promise;

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

// === 分析單頁（含失敗自動重試 + 429 速率限制特殊處理）===
// 429 處理：等 10 秒重試同模型；連續 2 次 429 → 該頁退回 RATE_LIMIT_FALLBACK_MODEL，其他頁不影響
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
  if (!imageBase64) return null;

  let currentModel = modelId;
  let rateLimitHits = 0;
  let errorRetries = 0;

  while (true) {
    if (!isSessionValid(sessionId)) return null;

    // 全域 429 暫停：任一 worker 觸發後，所有 worker 送出前都會等
    await waitForGlobalRateLimit();
    if (!isSessionValid(sessionId)) return null;

    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

    try {
      if (errorRetries > 0 || rateLimitHits > 0) {
        console.log(`[analysisHelpers][${timestamp}] 🔄 Page ${pageNum} retry (errors: ${errorRetries}, 429s: ${rateLimitHits}, model: ${currentModel})...`);
      } else {
        console.log(`[analysisHelpers][${timestamp}] 📤 Sending page ${pageNum} to API (model: ${currentModel})...`);
      }

      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: imageBase64,
          prompt: promptText,
          page: pageNum,
          model: currentModel,
          ...(apiKey ? { apiKey } : {}),
        }),
      });

      const result = await response.json();

      if (result.success) {
        if (currentModel !== modelId) {
          console.log(`[analysisHelpers][${timestamp}] ✅ Page ${pageNum}: ${result.data.regions.length} regions found (fallback: ${currentModel})`);
        } else {
          console.log(`[analysisHelpers][${timestamp}] ✅ Page ${pageNum}: ${result.data.regions.length} regions found`);
        }
        return result.data;
      }

      // 429 速率限制：設定全域暫停 + per-page 計數決定是否退回模型
      if (result.rateLimited) {
        rateLimitHits++;
        setGlobalRateLimitPause();
        if (rateLimitHits >= 2 && currentModel !== RATE_LIMIT_FALLBACK_MODEL) {
          console.log(`[analysisHelpers][${timestamp}] 🔀 Page ${pageNum}: 連續 ${rateLimitHits} 次 429，退回 ${RATE_LIMIT_FALLBACK_MODEL}`);
          currentModel = RATE_LIMIT_FALLBACK_MODEL;
        }
        if (rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
          console.error(`[analysisHelpers][${timestamp}] ❌ Page ${pageNum}: 429 超過 ${MAX_RATE_LIMIT_RETRIES} 次，放棄`);
          return null;
        }
        console.log(`[analysisHelpers][${timestamp}] ⏳ Page ${pageNum}: 429 速率限制，全域暫停 ${RATE_LIMIT_DELAY_MS / 1000}s`);
        continue; // 下一輪迴圈開頭的 waitForGlobalRateLimit() 會等
      }

      // 一般錯誤
      errorRetries++;
      console.error(`[analysisHelpers][${timestamp}] ❌ Page ${pageNum} failed (error ${errorRetries}/${MAX_RETRIES + 1}):`, result.error);
      if (errorRetries > MAX_RETRIES) return null;

      const delay = RETRY_BASE_DELAY_MS * errorRetries;
      console.log(`[analysisHelpers][${timestamp}] ⏳ Waiting ${delay}ms before retry...`);
      await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      errorRetries++;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.error(`[analysisHelpers][${ts}] ❌ Error analyzing page ${pageNum} (error ${errorRetries}/${MAX_RETRIES + 1}):`, err);
      if (errorRetries > MAX_RETRIES) return null;

      const delay = RETRY_BASE_DELAY_MS * errorRetries;
      console.log(`[analysisHelpers][${ts}] ⏳ Waiting ${delay}ms before retry...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** 處理單頁分析結果：提取文字 + merge 到 pageRegions + 儲存券商名
 *  回傳空文字 region 清單（含 bbox），供呼叫端決定是否自動 AI 識別
 *  注意：空 region 的 bbox 用於後續 cropRegionFromCanvas，呼叫端用 bbox 比對來更新 state */
// 傳入 pdfDoc 快照 + sessionId + targetFileId
export async function mergePageResult(
  pageNum: number,
  result: { hasAnalysis: boolean; date?: string; code?: string; report?: string; regions: Region[] },
  pdfDoc: pdfjs.PDFDocumentProxy,
  sessionId: number,
  isSessionValid: SessionValidator,
  targetFileId: string,
  updateFileRegions: FileRegionsUpdater,
  updateFileReport: FileReportUpdater,
  updateFileMetadata?: FileMetadataUpdater,
): Promise<Region[]> {
  const useDate = result.date && isCompleteDate(result.date);
  const useBroker = result.report && !shouldIgnoreBroker(result.report);
  if (updateFileMetadata && (useDate || result.code || useBroker)) {
    updateFileMetadata(targetFileId, {
      date: useDate ? result.date : undefined,
      code: result.code,
      broker: useBroker ? result.report : undefined,
      source: 'ai',
    });
  }

  // 儲存券商名（unknow/unknown 不更新、不顯示）
  if (useBroker) {
    updateFileReport(targetFileId, result.report!);
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

  // 在 state updater 之外直接收集需 AI 識別的 region：空文字 或 亂碼（CID passthrough、錯誤編碼等）
  const toRecognize: Region[] = [];
  let regionsToMerge = regionsWithText;
  for (const r of regionsWithText) {
    const t = r.text?.trim() ?? '';
    if (!t) toRecognize.push(r);
    else if (isGarbledText(t)) {
      toRecognize.push({ ...r, text: '' }); // 亂碼清空文字，顯示為灰框並送 AI 識別
      regionsToMerge = regionsToMerge.map((x) => (x === r ? { ...r, text: '' } : x));
    }
  }
  if (toRecognize.length > 0) {
    const emptyCount = regionsWithText.filter((r) => !r.text?.trim()).length;
    const garbledCount = toRecognize.length - emptyCount;
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const suffix = garbledCount > 0 ? `, ${garbledCount} garbled` : '';
    console.log(`[analysisHelpers][${ts}] 🔘 Page ${pageNum}: ${toRecognize.length} region(s) → AI 識別 (${emptyCount} empty${suffix}, ${regionsWithText.length} total)`);
  }

  // Merge：保留 userModified 的 regions，追加 AI 新結果（亂碼已清空文字）
  const mergeUpdater = (prev: Map<number, Region[]>) => {
    const updated = new Map(prev);
    const existing = updated.get(pageNum) || [];
    const userRegions = existing.filter((r) => r.userModified);
    const maxExistingId = userRegions.reduce((max, r) => Math.max(max, r.id), 0);
    const aiRegions = regionsToMerge.map((r: Region, i: number) => ({
      ...r,
      id: maxExistingId + i + 1,
      userModified: false,
    }));
    updated.set(pageNum, [...userRegions, ...aiRegions]);
    return updated;
  };
  updateFileRegions(targetFileId, mergeUpdater);
  return toRecognize;
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
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;
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
  await pdfPage.render({ canvasContext: ctx, viewport }).promise;

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

/** 呼叫 /api/recognize 識別區域內容（含失敗自動重試 + 429 速率限制特殊處理）
 *  429 處理：等 10 秒重試同模型；連續 2 次 429 → 退回 RATE_LIMIT_FALLBACK_MODEL */
export async function recognizeRegionWithRetry(
  base64: string,
  promptText: string,
  modelId: string,
  page: number,
  regionId: number,
  apiKey?: string,
): Promise<{ success: boolean; text?: string; error?: string }> {
  let lastError = '';
  let currentModel = modelId;
  let rateLimitHits = 0;
  let errorRetries = 0;

  while (true) {
    // 全域 429 暫停：任一 worker 觸發後，所有 worker 送出前都會等
    await waitForGlobalRateLimit();

    try {
      if (errorRetries > 0 || rateLimitHits > 0) {
        const retryTs = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[analysisHelpers][${retryTs}] 🔄 Region p${page}r${regionId} retry (errors: ${errorRetries}, 429s: ${rateLimitHits}, model: ${currentModel})...`);
      }

      const response = await fetch('/api/recognize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64,
          prompt: promptText,
          model: currentModel,
          page,
          regionId,
          ...(apiKey ? { apiKey } : {}),
        }),
      });
      const result = await response.json();

      if (result.success && result.text) {
        return { success: true, text: result.text };
      }

      // 429 速率限制：設定全域暫停 + per-region 計數決定是否退回模型
      if (result.rateLimited) {
        rateLimitHits++;
        setGlobalRateLimitPause();
        if (rateLimitHits >= 2 && currentModel !== RATE_LIMIT_FALLBACK_MODEL) {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`[analysisHelpers][${ts}] 🔀 Region p${page}r${regionId}: 連續 ${rateLimitHits} 次 429，退回 ${RATE_LIMIT_FALLBACK_MODEL}`);
          currentModel = RATE_LIMIT_FALLBACK_MODEL;
        }
        if (rateLimitHits > MAX_RATE_LIMIT_RETRIES) {
          return { success: false, error: `429 超過 ${MAX_RATE_LIMIT_RETRIES} 次` };
        }
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[analysisHelpers][${ts}] ⏳ Region p${page}r${regionId}: 429 速率限制，全域暫停 ${RATE_LIMIT_DELAY_MS / 1000}s`);
        continue; // 下一輪迴圈開頭的 waitForGlobalRateLimit() 會等
      }

      // 一般錯誤
      lastError = result.error || '未知錯誤';
      errorRetries++;
      if (errorRetries > MAX_RETRIES) return { success: false, error: lastError };

      const delay = RETRY_BASE_DELAY_MS * errorRetries;
      await new Promise((r) => setTimeout(r, delay));
    } catch (err) {
      lastError = err instanceof Error ? err.message : '未知錯誤';
      errorRetries++;
      if (errorRetries > MAX_RETRIES) return { success: false, error: lastError };

      const delay = RETRY_BASE_DELAY_MS * errorRetries;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
