/**
 * 功能：PDF 頁面分析核心邏輯 Custom Hook
 * 職責：頁面轉圖、API 呼叫（含失敗自動重試最多 2 次）、批次並行分析、單頁重送（支援多頁累加計數）、雙擊截圖識別
 * 依賴：react、pdfjs、types、constants、pdfTextExtract
 *
 * 重要設計：
 * - 所有非同步操作都傳入 pdfDoc 快照 + sessionId，避免切換檔案後存取已銷毀的 PDF document
 * - 使用 updateFileRegions(targetFileId, updater) 寫入分析結果，支援切檔後分析繼續在背景執行
 * - analysisFileIdRef 追蹤目前分析的目標檔案 ID
 */

import { useState, useCallback, useRef } from 'react';
import { pdfjs } from 'react-pdf';
import { Region } from '@/lib/types';
import { RENDER_SCALE, JPEG_QUALITY, NORMALIZED_MAX } from '@/lib/constants';
import { extractTextForRegions } from '@/lib/pdfTextExtract';

// === API 失敗重試設定 ===
const MAX_RETRIES = 2; // 最多重試 2 次（總共 3 次嘗試）
const RETRY_BASE_DELAY_MS = 1500; // 首次重試等待 1.5 秒，之後遞增

/** 檔案級 regions 更新器：自動判斷寫入 shared state 或 files 陣列 */
type FileRegionsUpdater = (
  targetFileId: string,
  updater: (prev: Map<number, Region[]>) => Map<number, Region[]>,
) => void;

interface UseAnalysisOptions {
  pdfDocRef: React.MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  pageRegions: Map<number, Region[]>;
  setPageRegions: React.Dispatch<React.SetStateAction<Map<number, Region[]>>>;
  /** 檔案級 regions 更新器（切檔後分析結果能寫回正確檔案） */
  updateFileRegions: FileRegionsUpdater;
  prompt: string;
  tablePrompt: string;
  model: string;
  batchSize: number;
}

export default function useAnalysis({
  pdfDocRef,
  pageRegions,
  setPageRegions,
  updateFileRegions,
  prompt,
  tablePrompt,
  model,
  batchSize,
}: UseAnalysisOptions) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  // 用來在分析被中斷時標記
  const abortRef = useRef(false);
  // 追蹤正在飛行中的單頁重送數量（修正多頁同時重送時計數不累加的 bug）
  const inFlightPageRef = useRef(0);
  // Session ID：每次啟動新的全頁分析或切換檔案時遞增，非同步操作用此判斷是否已過期
  const analysisSessionRef = useRef(0);
  // 目前分析的目標檔案 ID（支援切檔後分析繼續）
  const analysisFileIdRef = useRef<string | null>(null);

  /** 檢查 session 是否仍有效 */
  const isSessionValid = useCallback((sessionId: number) => {
    return analysisSessionRef.current === sessionId && !abortRef.current;
  }, []);

  // === 將 PDF 單頁渲染為 JPEG 圖片 ===
  // 傳入 pdfDoc 快照 + sessionId，避免使用可能已被替換的 pdfDocRef.current
  const renderPageToImage = useCallback(async (
    pageNum: number,
    pdfDoc: pdfjs.PDFDocumentProxy,
    sessionId: number,
  ): Promise<string | null> => {
    if (!isSessionValid(sessionId)) return null;

    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useAnalysis][${timestamp}] 🖼️ Rendering page ${pageNum} to image...`);

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
      console.log(`[useAnalysis][${ts2}] 📐 Page ${pageNum} JPEG: ${w}x${h}px, ${sizeKB} KB (scale=${RENDER_SCALE}, quality=${JPEG_QUALITY})`);
      return base64;
    } catch (e) {
      // RenderingCancelledException 或 document 已銷毀 → 靜默返回 null
      const eName = (e as { name?: string })?.name ?? '';
      const isCancel = eName === 'RenderingCancelledException' || !isSessionValid(sessionId);
      if (isCancel || String(e).includes('sendWithPromise')) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${ts2}] ⚠️ Rendering cancelled for page ${pageNum} (file switched or aborted)`);
        return null;
      }
      throw e;
    }
  }, [isSessionValid]);

  // === 分析單頁（含失敗自動重試最多 2 次）===
  const analyzePage = useCallback(
    async (
      pageNum: number,
      promptText: string,
      modelId: string,
      pdfDoc: pdfjs.PDFDocumentProxy,
      sessionId: number,
    ) => {
      const imageBase64 = await renderPageToImage(pageNum, pdfDoc, sessionId);
      if (!imageBase64) return null; // rendering 被取消或 session 失效

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (!isSessionValid(sessionId)) return null;

        const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

        try {
          if (attempt > 0) {
            console.log(`[useAnalysis][${timestamp}] 🔄 Page ${pageNum} retry ${attempt}/${MAX_RETRIES}...`);
          } else {
            console.log(`[useAnalysis][${timestamp}] 📤 Sending page ${pageNum} to API (model: ${modelId})...`);
          }

          const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              image: imageBase64,
              prompt: promptText,
              page: pageNum,
              model: modelId,
            }),
          });

          const result = await response.json();

          if (result.success) {
            console.log(
              `[useAnalysis][${timestamp}] ✅ Page ${pageNum}: ${result.data.regions.length} regions found`
            );
            return result.data;
          }

          console.error(`[useAnalysis][${timestamp}] ❌ Page ${pageNum} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, result.error);

          if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
            console.log(`[useAnalysis][${timestamp}] ⏳ Waiting ${delay}ms before retry...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          return null;
        } catch (err) {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.error(`[useAnalysis][${ts}] ❌ Error analyzing page ${pageNum} (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`, err);

          if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
            console.log(`[useAnalysis][${ts}] ⏳ Waiting ${delay}ms before retry...`);
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }

          return null;
        }
      }

      return null;
    },
    [renderPageToImage, isSessionValid]
  );

  /** 處理單頁分析結果：提取文字 + merge 到 pageRegions */
  // 傳入 pdfDoc 快照 + sessionId + targetFileId
  const mergePageResult = useCallback(
    async (
      pageNum: number,
      result: { hasAnalysis: boolean; regions: Region[] },
      pdfDoc: pdfjs.PDFDocumentProxy,
      sessionId: number,
      targetFileId: string,
    ) => {
      if (!result.hasAnalysis || result.regions.length === 0) return;
      if (!isSessionValid(sessionId)) return;

      let regionsWithText = result.regions;
      try {
        const pdfPage = await pdfDoc.getPage(pageNum);
        if (!isSessionValid(sessionId)) return;
        regionsWithText = await extractTextForRegions(pdfPage, result.regions);
      } catch (e) {
        // document 已銷毀時不要噴錯
        if (!isSessionValid(sessionId)) return;
        console.warn(`[useAnalysis] ⚠️ Text extraction failed for page ${pageNum}`, e);
      }

      if (!isSessionValid(sessionId)) return;

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
    },
    [isSessionValid, updateFileRegions]
  );

  // === 自動分析所有頁面（批次並行，merge 不覆蓋 userModified）===
  // 自己用 pdfjs.getDocument 載入獨立 pdfDoc，不依賴 react-pdf 的 document（切檔不會被銷毀）
  const analyzeAllPages = useCallback(
    async (totalPages: number, promptText: string, modelId: string, concurrency: number, targetFileId: string, fileUrl: string) => {
      // 記錄分析目標檔案 ID
      analysisFileIdRef.current = targetFileId;

      // 遞增 session，讓舊的非同步操作全部失效
      const sessionId = ++analysisSessionRef.current;

      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${timestamp}] 🚀 Starting analysis (session=${sessionId}, file=${targetFileId}) of ${totalPages} pages in batches of ${concurrency} (model: ${modelId})...`);

      abortRef.current = false;
      setIsAnalyzing(true);
      setError(null);

      // 載入獨立的 pdfDoc（不受 react-pdf 切檔銷毀影響）
      let pdfDoc: pdfjs.PDFDocumentProxy;
      try {
        pdfDoc = await pdfjs.getDocument(fileUrl).promise;
      } catch (e) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.error(`[useAnalysis][${ts2}] ❌ Failed to load PDF for analysis:`, e);
        setError('無法載入 PDF 檔案');
        setIsAnalyzing(false);
        analysisFileIdRef.current = null;
        return;
      }

      if (!isSessionValid(sessionId)) {
        pdfDoc.destroy();
        return;
      }

      // 清除非 userModified 的 regions，保留手動修改/新增的
      updateFileRegions(targetFileId, (prev) => {
        const kept = new Map<number, Region[]>();
        prev.forEach((regions, page) => {
          const userRegions = regions.filter((r) => r.userModified);
          if (userRegions.length > 0) kept.set(page, userRegions);
        });
        return kept;
      });
      setAnalysisProgress({ current: 0, total: totalPages });

      let completed = 0;

      /** 單頁完成後立即處理並顯示 */
      const processPage = async (pageNum: number) => {
        if (!isSessionValid(sessionId)) return;

        const result = await analyzePage(pageNum, promptText, modelId, pdfDoc, sessionId);

        if (!isSessionValid(sessionId)) return;

        completed++;
        setAnalysisProgress({ current: completed, total: totalPages });

        if (result) {
          await mergePageResult(pageNum, result, pdfDoc, sessionId, targetFileId);
        }
      };

      // 用並行池（concurrency 個同時跑），每頁回來就立刻顯示
      for (let batchStart = 1; batchStart <= totalPages; batchStart += concurrency) {
        if (!isSessionValid(sessionId)) {
          console.log(`[useAnalysis][${timestamp}] ⚠️ Analysis aborted at batch starting page ${batchStart} (session=${sessionId})`);
          break;
        }

        const batchEnd = Math.min(batchStart + concurrency - 1, totalPages);
        const pageNums = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

        await Promise.all(pageNums.map((p) => processPage(p)));
      }

      // 清理獨立的 pdfDoc
      try { pdfDoc.destroy(); } catch { /* ignore */ }

      // 只有 session 仍有效時才設定完成狀態（否則可能覆蓋新 session 的狀態）
      // 注意：不在這裡清除 analysisFileIdRef，由 PDFExtractApp 的 completion effect 讀取後清除
      if (isSessionValid(sessionId)) {
        setIsAnalyzing(false);
        const endTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${endTimestamp}] 🏁 Analysis complete (session=${sessionId}).`);
      }
    },
    [analyzePage, mergePageResult, updateFileRegions, isSessionValid]
  );

  // === 停止分析 ===
  const handleStop = useCallback(() => {
    abortRef.current = true;
    analysisSessionRef.current++; // 讓飛行中操作全部失效
    analysisFileIdRef.current = null;
    setIsAnalyzing(false);
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useAnalysis][${timestamp}] 🛑 Analysis stopped by user.`);
  }, []);

  // === 使 session 失效（切換檔案時由外部呼叫）===
  const invalidateSession = useCallback(() => {
    abortRef.current = true;
    analysisSessionRef.current++;
    inFlightPageRef.current = 0;
    setIsAnalyzing(false);
    setAnalysisProgress({ current: 0, total: 0 });
  }, []);

  // === 重新分析（清除所有框，包含手動修改的）===
  const handleReanalyze = useCallback(
    (numPages: number, targetFileId: string, fileUrl: string) => {
      if (numPages > 0 && fileUrl) {
        updateFileRegions(targetFileId, () => new Map());
        analyzeAllPages(numPages, prompt, model, batchSize, targetFileId, fileUrl);
      }
    },
    [prompt, model, batchSize, analyzeAllPages, updateFileRegions]
  );

  // === 重新分析單頁（修正：支援多頁同時重送，計數會累加而非覆蓋）===
  // 單頁重送一定是活躍檔案，由外部傳入 targetFileId
  const handleReanalyzePage = useCallback(
    async (pageNum: number, targetFileId?: string) => {
      const pdfDoc = pdfDocRef.current;
      if (!pdfDoc) return;
      const sessionId = analysisSessionRef.current; // 用當前 session（不遞增，因為是單頁操作）
      const fileId = targetFileId || analysisFileIdRef.current || '';

      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${ts}] 🔄 Re-analyzing page ${pageNum}...`);

      // 累加進度，而非覆蓋
      inFlightPageRef.current++;
      setIsAnalyzing(true);
      setAnalysisProgress((prev) => ({
        current: prev.current,
        total: prev.total + 1,
      }));
      setError(null);

      // 清除該頁的非 userModified regions
      setPageRegions((prev) => {
        const updated = new Map(prev);
        const existing = updated.get(pageNum) || [];
        const userRegions = existing.filter((r) => r.userModified);
        if (userRegions.length > 0) {
          updated.set(pageNum, userRegions);
        } else {
          updated.delete(pageNum);
        }
        return updated;
      });

      const result = await analyzePage(pageNum, prompt, model, pdfDoc, sessionId);

      // 完成：累加 current，而非直接設定
      setAnalysisProgress((prev) => ({
        ...prev,
        current: prev.current + 1,
      }));

      if (result && isSessionValid(sessionId)) {
        await mergePageResult(pageNum, result, pdfDoc, sessionId, fileId);
      }

      // 只有當所有飛行中的頁面都完成時才停止分析狀態
      inFlightPageRef.current--;
      if (inFlightPageRef.current === 0) {
        setIsAnalyzing(false);
        // 重置進度（避免下次累計混亂）
        setAnalysisProgress({ current: 0, total: 0 });
      }
    },
    [prompt, model, analyzePage, mergePageResult, pdfDocRef, setPageRegions, isSessionValid]
  );

  // === 雙擊框框 → 截圖該區域 → 送 AI 識別（表格/圖表） ===
  const handleRegionDoubleClick = useCallback(
    async (page: number, regionId: number) => {
      const pdfDoc = pdfDocRef.current;
      if (!pdfDoc) return;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${ts}] 🖱️ Double-click on page ${page} region ${regionId}, capturing...`);

      // 找到該 region 的 bbox
      const regions = pageRegions.get(page);
      const region = regions?.find((r) => r.id === regionId);
      if (!region) return;

      setIsAnalyzing(true);
      setAnalysisProgress({ current: 0, total: 1 });
      setError(null);

      try {
        // 用 pdfjs 渲染整頁到 canvas，然後裁切目標區域
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

        fullCanvas.remove();
        cropCanvas.remove();

        console.log(`[useAnalysis][${ts}] 📐 Cropped region: ${cropCanvas.width}x${cropCanvas.height}px, ${sizeKB} KB`);

        // 標記載入中（先在文字欄顯示「識別中...」）
        setPageRegions((prev) => {
          const updated = new Map(prev);
          const rs = updated.get(page);
          if (rs) {
            updated.set(page, rs.map((r) =>
              r.id === regionId ? { ...r, text: '⏳ AI 識別中...', userModified: true } : r
            ));
          }
          return updated;
        });

        // 送 API（含重試）
        let lastError = '';
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            if (attempt > 0) {
              const retryTs = new Date().toLocaleTimeString('en-US', { hour12: false });
              console.log(`[useAnalysis][${retryTs}] 🔄 Region recognize retry ${attempt}/${MAX_RETRIES}...`);
            }

            const response = await fetch('/api/recognize', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                image: base64,
                prompt: tablePrompt,
                model,
                page,
                regionId,
              }),
            });
            const result = await response.json();

            setAnalysisProgress({ current: 1, total: 1 });

            if (result.success && result.text) {
              setPageRegions((prev) => {
                const updated = new Map(prev);
                const rs = updated.get(page);
                if (rs) {
                  updated.set(page, rs.map((r) =>
                    r.id === regionId ? { ...r, text: result.text, userModified: true } : r
                  ));
                }
                return updated;
              });
              const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
              console.log(`[useAnalysis][${ts2}] ✅ Region ${regionId} recognized: ${result.text.length} chars`);
              return; // 成功，結束
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

        // 所有重試都失敗
        setPageRegions((prev) => {
          const updated = new Map(prev);
          const rs = updated.get(page);
          if (rs) {
            updated.set(page, rs.map((r) =>
              r.id === regionId ? { ...r, text: `❌ 識別失敗: ${lastError}` } : r
            ));
          }
          return updated;
        });
      } catch (e) {
        // document 銷毀的錯誤靜默處理
        if (String(e).includes('sendWithPromise') || (e as { name?: string })?.name === 'RenderingCancelledException') {
          console.log(`[useAnalysis][${ts}] ⚠️ Region double-click cancelled (file switched)`);
          return;
        }
        console.error(`[useAnalysis][${ts}] ❌ Region double-click error:`, e);
        setPageRegions((prev) => {
          const updated = new Map(prev);
          const rs = updated.get(page);
          if (rs) {
            updated.set(page, rs.map((r) =>
              r.id === regionId ? { ...r, text: `❌ 識別失敗: ${e instanceof Error ? e.message : '未知錯誤'}` } : r
            ));
          }
          return updated;
        });
      } finally {
        setIsAnalyzing(false);
      }
    },
    [pdfDocRef, pageRegions, tablePrompt, model, setPageRegions]
  );

  return {
    isAnalyzing,
    analysisProgress,
    error,
    setError,
    abortRef,
    /** 目前分析目標檔案 ID（分析進行中不為 null） */
    analysisFileIdRef,
    analyzeAllPages,
    handleStop,
    invalidateSession,
    handleReanalyze,
    handleReanalyzePage,
    handleRegionDoubleClick,
  };
}
