/**
 * 功能：PDF 頁面分析核心邏輯 Custom Hook
 * 職責：頁面轉圖、API 呼叫（含失敗自動重試最多 2 次）、跨檔案 worker pool 並行分析、單頁重送（支援多頁累加計數）、雙擊截圖識別、佇列頁面取消、per-file analyzingPagesMap
 * 依賴：react、pdfjs、types、constants、pdfTextExtract
 *
 * 重要設計：
 * - 所有非同步操作都傳入 pdfDoc 快照 + sessionId，避免切換檔案後存取已銷毀的 PDF document
 * - 所有寫入統一走 updateFileRegions(fileId, updater) 直接更新 files 陣列（Single Source of Truth）
 * - 不依賴共用的 pageRegions state，與 view 層完全解耦
 * - analysisFileIdRef 追蹤目前分析的主要目標檔案 ID
 * - queuedPagesMap（per-file）追蹤排隊中的頁碼，skippedPagesRef（per-file）記錄被使用者取消的頁碼
 * - analyzeAllPages 支援 getNextFile callback，worker 在 task queue 耗盡時自動拉入下一個排隊檔案
 */

import { useState, useCallback, useRef } from 'react';
import { pdfjs } from 'react-pdf';
import { Region } from '@/lib/types';
import { RENDER_SCALE, JPEG_QUALITY, NORMALIZED_MAX } from '@/lib/constants';
import { extractTextForRegions } from '@/lib/pdfTextExtract';

// === API 失敗重試設定 ===
const MAX_RETRIES = 2; // 最多重試 2 次（總共 3 次嘗試）
const RETRY_BASE_DELAY_MS = 1500; // 首次重試等待 1.5 秒，之後遞增

/** 檔案級 regions 更新器：直接寫入 files 陣列（Single Source of Truth） */
type FileRegionsUpdater = (
  targetFileId: string,
  updater: (prev: Map<number, Region[]>) => Map<number, Region[]>,
) => void;

/** 檔案級 report 更新器：更新指定檔案的券商名 */
type FileReportUpdater = (targetFileId: string, report: string) => void;

interface UseAnalysisOptions {
  pdfDocRef: React.MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  /** 直接更新 files 陣列中指定檔案的 pageRegions */
  updateFileRegions: FileRegionsUpdater;
  /** 更新指定檔案的券商名（report） */
  updateFileReport: FileReportUpdater;
  prompt: string;
  tablePrompt: string;
  model: string;
  batchSize: number;
}

export default function useAnalysis({
  pdfDocRef,
  updateFileRegions,
  updateFileReport,
  prompt,
  tablePrompt,
  model,
  batchSize,
}: UseAnalysisOptions) {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  // 正在分析中的頁碼（per-file Map），key = fileId, value = Set<pageNum>
  const [analyzingPagesMap, setAnalyzingPagesMap] = useState<Map<string, Set<number>>>(new Map());
  // 排隊等待分析的頁碼集合（per-file Map，用於 UI 顯示 X 取消按鈕）
  const [queuedPagesMap, setQueuedPagesMap] = useState<Map<string, Set<number>>>(new Map());
  // 被使用者取消的頁碼（per-file Map，processPage 會檢查跳過）
  const skippedPagesRef = useRef<Map<string, Set<number>>>(new Map());

  // 用來在分析被中斷時標記
  const abortRef = useRef(false);
  // 追蹤正在飛行中的單頁重送數量（修正多頁同時重送時計數不累加的 bug）
  const inFlightPageRef = useRef(0);
  // Session ID：每次啟動新的全頁分析或切換檔案時遞增，非同步操作用此判斷是否已過期
  const analysisSessionRef = useRef(0);
  // 目前分析的目標檔案 ID（支援切檔後分析繼續）
  const analysisFileIdRef = useRef<string | null>(null);
  // 是否由使用者主動停止（用於區分 stopped vs done 狀態）
  const stoppedByUserRef = useRef(false);

  /** 檢查 session 是否仍有效 */
  const isSessionValid = useCallback((sessionId: number) => {
    return analysisSessionRef.current === sessionId && !abortRef.current;
  }, []);

  /** 將某頁加入 analyzingPagesMap（per-file） */
  const addAnalyzingPage = useCallback((fileId: string, pageNum: number) => {
    setAnalyzingPagesMap((prev) => {
      const next = new Map(prev);
      const s = new Set(next.get(fileId) || []);
      s.add(pageNum);
      next.set(fileId, s);
      return next;
    });
  }, []);

  /** 將某頁從 analyzingPagesMap 移除（per-file） */
  const removeAnalyzingPage = useCallback((fileId: string, pageNum: number) => {
    setAnalyzingPagesMap((prev) => {
      const next = new Map(prev);
      const s = next.get(fileId);
      if (s) {
        const ns = new Set(s);
        ns.delete(pageNum);
        if (ns.size > 0) next.set(fileId, ns);
        else next.delete(fileId);
      }
      return next;
    });
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

  /** 處理單頁分析結果：提取文字 + merge 到 pageRegions + 儲存券商名 */
  // 傳入 pdfDoc 快照 + sessionId + targetFileId
  const mergePageResult = useCallback(
    async (
      pageNum: number,
      result: { hasAnalysis: boolean; report?: string; regions: Region[] },
      pdfDoc: pdfjs.PDFDocumentProxy,
      sessionId: number,
      targetFileId: string,
    ) => {
      // 儲存券商名（只要有 report 就更新，即使沒有 regions）
      if (result.report) {
        updateFileReport(targetFileId, result.report);
      }

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
    [isSessionValid, updateFileRegions, updateFileReport]
  );

  // === 自動分析所有頁面（跨檔案 worker pool，merge 不覆蓋 userModified）===
  // 自己用 pdfjs.getDocument 載入獨立 pdfDoc，不依賴 react-pdf 的 document（切檔不會被銷毀）
  // 當 worker pool 的 task queue 耗盡時，透過 getNextFile callback 自動拉入下一個排隊檔案的頁面
  const analyzeAllPages = useCallback(
    async (
      totalPages: number,
      promptText: string,
      modelId: string,
      concurrency: number,
      targetFileId: string,
      fileUrl: string,
      getNextFile?: () => Promise<{ fileId: string; url: string; totalPages: number } | null>,
      onFileComplete?: (fileId: string, error?: boolean) => void,
    ) => {
      // 記錄分析目標檔案 ID（primary file）
      analysisFileIdRef.current = targetFileId;

      // 遞增 session，讓舊的非同步操作全部失效
      const sessionId = ++analysisSessionRef.current;

      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${timestamp}] 🚀 Starting analysis (session=${sessionId}, file=${targetFileId}) of ${totalPages} pages with concurrency=${concurrency} (model: ${modelId})...`);

      abortRef.current = false;
      stoppedByUserRef.current = false;
      skippedPagesRef.current = new Map();
      setIsAnalyzing(true);
      setError(null);

      // === 跨檔案 worker pool 資料結構 ===
      const taskQueue: { fileId: string; pageNum: number }[] = [];
      const pdfDocMap = new Map<string, pdfjs.PDFDocumentProxy>();
      const totalPerFile = new Map<string, number>();
      const completedPerFile = new Map<string, number>();
      const fileCompletedSet = new Set<string>(); // 避免重複觸發 onFileComplete
      let globalTotal = totalPages;
      let globalCompleted = 0;

      // === 載入第一個檔案 ===
      let firstDoc: pdfjs.PDFDocumentProxy;
      try {
        firstDoc = await pdfjs.getDocument(fileUrl).promise;
      } catch (e) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.error(`[useAnalysis][${ts2}] ❌ Failed to load PDF for analysis:`, e);
        setError('無法載入 PDF 檔案');
        setIsAnalyzing(false);
        analysisFileIdRef.current = null;
        return;
      }

      if (!isSessionValid(sessionId)) {
        firstDoc.destroy();
        return;
      }

      pdfDocMap.set(targetFileId, firstDoc);
      totalPerFile.set(targetFileId, totalPages);
      completedPerFile.set(targetFileId, 0);

      // 清除非 userModified 的 regions，保留手動修改/新增的
      updateFileRegions(targetFileId, (prev) => {
        const kept = new Map<number, Region[]>();
        prev.forEach((regions, page) => {
          const userRegions = regions.filter((r) => r.userModified);
          if (userRegions.length > 0) kept.set(page, userRegions);
        });
        return kept;
      });

      // 填入第一個檔案的 tasks
      for (let p = 1; p <= totalPages; p++) {
        taskQueue.push({ fileId: targetFileId, pageNum: p });
      }

      // 初始化排隊頁面集合（per-file）
      setQueuedPagesMap((prev) => {
        const nm = new Map(prev);
        nm.set(targetFileId, new Set(Array.from({ length: totalPages }, (_, i) => i + 1)));
        return nm;
      });
      setAnalysisProgress({ current: 0, total: totalPages });

      // === 單個檔案完成處理 ===
      const handleFileDone = (fileId: string, hasError?: boolean) => {
        if (fileCompletedSet.has(fileId)) return;
        fileCompletedSet.add(fileId);

        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${ts}] ${hasError ? '❌' : '✅'} File ${fileId} analysis ${hasError ? 'failed' : 'complete'}`);

        // Destroy pdfDoc for completed file
        const doc = pdfDocMap.get(fileId);
        if (doc) {
          try { doc.destroy(); } catch { /* ignore */ }
          pdfDocMap.delete(fileId);
        }

        // Clear queuedPages for this file
        setQueuedPagesMap((prev) => {
          const nm = new Map(prev);
          nm.delete(fileId);
          return nm;
        });

        if (onFileComplete) onFileComplete(fileId, hasError);
      };

      // === 拉取下一個檔案（防止多 worker 重複拉取）===
      let pendingFetch: Promise<boolean> | null = null;
      let noMoreFiles = !getNextFile;

      const tryFetchNextFile = async (): Promise<boolean> => {
        if (noMoreFiles || !isSessionValid(sessionId)) return false;
        if (pendingFetch) return pendingFetch;

        pendingFetch = (async () => {
          try {
            const next = await getNextFile!();
            if (!next || !isSessionValid(sessionId)) {
              noMoreFiles = true;
              return false;
            }

            const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
            console.log(`[useAnalysis][${ts}] 📂 Worker pool pulling next file: ${next.fileId} (${next.totalPages} pages)`);

            // 載入新檔案的 pdfDoc
            let newDoc: pdfjs.PDFDocumentProxy;
            try {
              newDoc = await pdfjs.getDocument(next.url).promise;
            } catch (e) {
              const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
              console.error(`[useAnalysis][${ts2}] ❌ Failed to load PDF for file ${next.fileId}:`, e);
              // 標記該檔案失敗，不設 noMoreFiles（後面可能還有其他檔案）
              handleFileDone(next.fileId, true);
              return false;
            }

            if (!isSessionValid(sessionId)) {
              newDoc.destroy();
              return false;
            }

            pdfDocMap.set(next.fileId, newDoc);
            totalPerFile.set(next.fileId, next.totalPages);
            completedPerFile.set(next.fileId, 0);

            // 清除非 userModified 的 regions
            updateFileRegions(next.fileId, (prev) => {
              const kept = new Map<number, Region[]>();
              prev.forEach((regions, page) => {
                const userRegions = regions.filter((r) => r.userModified);
                if (userRegions.length > 0) kept.set(page, userRegions);
              });
              return kept;
            });

            // 填入新 tasks
            for (let p = 1; p <= next.totalPages; p++) {
              taskQueue.push({ fileId: next.fileId, pageNum: p });
            }

            // 更新全域進度
            globalTotal += next.totalPages;
            setAnalysisProgress((prev) => ({ ...prev, total: globalTotal }));

            // 更新 queuedPagesMap（per-file）
            setQueuedPagesMap((prev) => {
              const nm = new Map(prev);
              nm.set(next.fileId, new Set(Array.from({ length: next.totalPages }, (_, i) => i + 1)));
              return nm;
            });

            return true;
          } finally {
            pendingFetch = null;
          }
        })();

        return pendingFetch;
      };

      // === 處理單頁 ===
      const processPage = async (task: { fileId: string; pageNum: number }) => {
        const { fileId, pageNum } = task;
        if (!isSessionValid(sessionId)) return;

        const pdfDoc = pdfDocMap.get(fileId);
        if (!pdfDoc) return;

        // 檢查是否被使用者取消（或券商忽略末尾頁數）
        // 被跳過的頁面：減少 total 而非增加 completed（不假裝已完成）
        if (skippedPagesRef.current.get(fileId)?.has(pageNum)) {
          globalTotal--;
          const fileTotal = (totalPerFile.get(fileId) || 1) - 1;
          totalPerFile.set(fileId, fileTotal);
          setAnalysisProgress({ current: globalCompleted, total: globalTotal });
          // 檢查此檔案是否全部完成（已完成數 >= 減少後的總數）
          const fileDone = completedPerFile.get(fileId) || 0;
          if (fileTotal <= 0 || fileDone >= fileTotal) handleFileDone(fileId);
          return;
        }

        // 從排隊集合移除，標記為正在分析
        setQueuedPagesMap((prev) => {
          const nm = new Map(prev);
          const s = nm.get(fileId);
          if (s) {
            const ns = new Set(s);
            ns.delete(pageNum);
            if (ns.size > 0) nm.set(fileId, ns);
            else nm.delete(fileId);
          }
          return nm;
        });
        addAnalyzingPage(fileId, pageNum);

        const result = await analyzePage(pageNum, promptText, modelId, pdfDoc, sessionId);

        // 分析完成，移除標記
        removeAnalyzingPage(fileId, pageNum);

        if (!isSessionValid(sessionId)) return;

        globalCompleted++;
        const fileDone = (completedPerFile.get(fileId) || 0) + 1;
        completedPerFile.set(fileId, fileDone);
        setAnalysisProgress({ current: globalCompleted, total: globalTotal });

        if (result) {
          await mergePageResult(pageNum, result, pdfDoc, sessionId, fileId);
        }

        // 檢查此檔案是否全部完成
        if (fileDone >= (totalPerFile.get(fileId) || 0)) handleFileDone(fileId);
      };

      // === Worker pool：永遠保持 concurrency 個同時飛行，跨檔案自動補貨 ===
      const worker = async () => {
        while (true) {
          if (!isSessionValid(sessionId)) return;

          if (taskQueue.length === 0) {
            if (noMoreFiles) return;
            // Task queue 空了，嘗試拉取下一個檔案
            const got = await tryFetchNextFile();
            if (!got) {
              if (noMoreFiles) return; // 確實沒有更多檔案了
              continue; // 此檔案載入失敗，繼續嘗試下一個
            }
            if (taskQueue.length === 0) continue; // 安全檢查
          }

          const task = taskQueue.shift()!;
          await processPage(task);
        }
      };

      await Promise.all(
        Array.from({ length: concurrency }, () => worker())
      );

      // 清理剩餘的 pdfDoc（正常情況下 handleFileDone 已清理）
      pdfDocMap.forEach((doc) => { try { doc.destroy(); } catch { /* ignore */ } });

      // 只有 session 仍有效時才設定完成狀態（否則可能覆蓋新 session 的狀態）
      // 注意：不在這裡清除 analysisFileIdRef，由 PDFExtractApp 的 completion effect 讀取後清除
      if (isSessionValid(sessionId)) {
        setIsAnalyzing(false);
        setQueuedPagesMap(new Map());
        const endTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${endTimestamp}] 🏁 All analysis complete (session=${sessionId}).`);
      }
    },
    [analyzePage, mergePageResult, updateFileRegions, isSessionValid, addAnalyzingPage, removeAnalyzingPage]
  );

  // === 停止分析 ===
  const handleStop = useCallback(() => {
    abortRef.current = true;
    stoppedByUserRef.current = true;
    analysisSessionRef.current++; // 讓飛行中操作全部失效
    analysisFileIdRef.current = null;
    setIsAnalyzing(false);
    setAnalyzingPagesMap(new Map());
    setQueuedPagesMap(new Map());
    skippedPagesRef.current = new Map();
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
    setAnalyzingPagesMap(new Map());
    setQueuedPagesMap(new Map());
    skippedPagesRef.current = new Map();
  }, []);

  // === 取消佇列中的單頁（使用者點 X 按鈕）===
  const cancelQueuedPage = useCallback((fileId: string, pageNum: number) => {
    const skipped = skippedPagesRef.current.get(fileId) || new Set<number>();
    skipped.add(pageNum);
    skippedPagesRef.current.set(fileId, skipped);
    setQueuedPagesMap((prev) => {
      const nm = new Map(prev);
      const s = nm.get(fileId);
      if (s) {
        const ns = new Set(s);
        ns.delete(pageNum);
        if (ns.size > 0) nm.set(fileId, ns);
        else nm.delete(fileId);
      }
      return nm;
    });
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useAnalysis][${ts}] ⏭️ Page ${pageNum} (file=${fileId}) removed from queue by user.`);
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
  // 如果該頁在佇列中，先從佇列移除（標記 skipped），避免批次迴圈重複處理
  const handleReanalyzePage = useCallback(
    async (pageNum: number, targetFileId: string) => {
      const pdfDoc = pdfDocRef.current;
      if (!pdfDoc || !targetFileId) return;
      const sessionId = analysisSessionRef.current; // 用當前 session（不遞增，因為是單頁操作）

      // 如果該頁在佇列中，先取消（讓批次迴圈跳過它）
      const fileQueued = queuedPagesMap.get(targetFileId);
      if (fileQueued?.has(pageNum)) {
        const skipped = skippedPagesRef.current.get(targetFileId) || new Set<number>();
        skipped.add(pageNum);
        skippedPagesRef.current.set(targetFileId, skipped);
        setQueuedPagesMap((prev) => {
          const nm = new Map(prev);
          const s = nm.get(targetFileId);
          if (s) {
            const ns = new Set(s);
            ns.delete(pageNum);
            if (ns.size > 0) nm.set(targetFileId, ns);
            else nm.delete(targetFileId);
          }
          return nm;
        });
        const ts0 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${ts0}] ⏭️ Page ${pageNum} pulled from queue for immediate re-analysis.`);
      }

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

      // 標記此頁正在分析（per-file）
      addAnalyzingPage(targetFileId, pageNum);

      // 清除該頁的非 userModified regions
      updateFileRegions(targetFileId, (prev) => {
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

      // 分析完成，移除標記（per-file）
      removeAnalyzingPage(targetFileId, pageNum);

      if (result && isSessionValid(sessionId)) {
        await mergePageResult(pageNum, result, pdfDoc, sessionId, targetFileId);
      }

      // 只有當所有飛行中的頁面都完成時才停止分析狀態
      inFlightPageRef.current--;
      if (inFlightPageRef.current === 0) {
        setIsAnalyzing(false);
        // 重置進度（避免下次累計混亂）
        setAnalysisProgress({ current: 0, total: 0 });
      }
    },
    [prompt, model, analyzePage, mergePageResult, pdfDocRef, updateFileRegions, isSessionValid, queuedPagesMap, addAnalyzingPage, removeAnalyzingPage]
  );

  // === 雙擊框框 → 截圖該區域 → 送 AI 識別（表格/圖表） ===
  // 由呼叫端傳入完整 region 物件 + fileId，不依賴共用 state
  const handleRegionDoubleClick = useCallback(
    async (page: number, region: Region, targetFileId: string) => {
      const pdfDoc = pdfDocRef.current;
      if (!pdfDoc || !targetFileId) return;
      const regionId = region.id;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${ts}] 🖱️ Double-click on page ${page} region ${regionId}, capturing...`);

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
        updateFileRegions(targetFileId, (prev) => {
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
              updateFileRegions(targetFileId, (prev) => {
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
        updateFileRegions(targetFileId, (prev) => {
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
        updateFileRegions(targetFileId, (prev) => {
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
    [pdfDocRef, tablePrompt, model, updateFileRegions]
  );

  return {
    isAnalyzing,
    analysisProgress,
    error,
    setError,
    abortRef,
    /** 目前分析目標檔案 ID（分析進行中不為 null） */
    analysisFileIdRef,
    /** 是否由使用者主動停止（用於區分 stopped vs done） */
    stoppedByUserRef,
    /** 正在分析中的頁碼 Map（key=fileId, value=Set<pageNum>） */
    analyzingPagesMap,
    /** 排隊等待分析的頁碼 Map（per-file，key=fileId, value=Set<pageNum>，用於 X 取消按鈕） */
    queuedPagesMap,
    analyzeAllPages,
    handleStop,
    invalidateSession,
    handleReanalyze,
    handleReanalyzePage,
    handleRegionDoubleClick,
    /** 取消佇列中的單頁 */
    cancelQueuedPage,
  };
}
