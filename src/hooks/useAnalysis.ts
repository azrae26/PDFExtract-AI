/**
 * 功能：PDF 頁面分析核心邏輯 Custom Hook
 * 職責：跨檔案 worker pool 並行分析、單頁重送（支援多頁累加計數）、佇列頁面取消、per-file analyzingPagesMap、整合雙擊識別、券商校正後動態恢復被省略頁面
 * 依賴：react、pdfjs、types、analysisHelpers、useRegionRecognize
 *
 * 重要設計：
 * - 所有非同步操作都傳入 pdfDoc 快照 + sessionId，避免切換檔案後存取已銷毀的 PDF document
 * - 所有寫入統一走 updateFileRegions(fileId, updater) 直接更新 files 陣列（Single Source of Truth）
 * - 不依賴共用的 pageRegions state，與 view 層完全解耦
 * - analysisFileIdRef 追蹤目前分析的主要目標檔案 ID
 * - queuedPagesMap（per-file）追蹤排隊中的頁碼，skippedPagesRef（per-file）記錄被使用者取消的頁碼
 * - analyzeAllPages 支援 getNextFile callback，worker 在 task queue 耗盡時自動拉入下一個排隊檔案
 * - initialSkipRef（per-file）記錄分析啟動時的 effectiveSkip，addPagesToQueueRef 支援券商校正後動態插入頁面
 * - 雙擊區域識別委託給 useRegionRecognize hook，isAnalyzing 合併兩者狀態
 */

import { useState, useCallback, useRef } from 'react';
import { pdfjs } from 'react-pdf';
import { Region } from '@/lib/types';
import {
  FileRegionsUpdater,
  FileReportUpdater,
  FileProgressUpdater,
  analyzePageWithRetry,
  mergePageResult,
} from './analysisHelpers';
import useRegionRecognize from './useRegionRecognize';

interface UseAnalysisOptions {
  pdfDocRef: React.MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  /** 直接更新 files 陣列中指定檔案的 pageRegions */
  updateFileRegions: FileRegionsUpdater;
  /** 更新指定檔案的券商名（report） */
  updateFileReport: FileReportUpdater;
  /** 更新指定檔案的 per-file 分析進度 */
  updateFileProgress: FileProgressUpdater;
  prompt: string;
  tablePrompt: string;
  model: string;
  batchSize: number;
}

export default function useAnalysis({
  pdfDocRef,
  updateFileRegions,
  updateFileReport,
  updateFileProgress,
  prompt,
  tablePrompt,
  model,
  batchSize,
}: UseAnalysisOptions) {
  const [batchIsAnalyzing, setBatchIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  // 正在分析中的頁碼（per-file Map），key = fileId, value = Set<pageNum>
  const [analyzingPagesMap, setAnalyzingPagesMap] = useState<Map<string, Set<number>>>(new Map());
  // 排隊等待分析的頁碼集合（per-file Map，用於 UI 顯示 X 取消按鈕）
  const [queuedPagesMap, setQueuedPagesMap] = useState<Map<string, Set<number>>>(new Map());
  // 被使用者取消的頁碼（per-file Map，processPage 會檢查跳過）
  const skippedPagesRef = useRef<Map<string, Set<number>>>(new Map());
  // 每個檔案分析啟動時實際使用的 effectiveSkip（用於券商校正時正確計算需恢復的頁面差額）
  const initialSkipRef = useRef<Map<string, number>>(new Map());
  // 動態插入頁面到 worker pool 的 taskQueue（由 analyzeAllPages closure 內設定，外部透過此 ref 呼叫）
  const addPagesToQueueRef = useRef<((fileId: string, pageNums: number[]) => void) | null>(null);

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

  // === 雙擊區域識別（委託給獨立 hook）===
  const { handleRegionDoubleClick, isRecognizing } = useRegionRecognize({
    pdfDocRef,
    updateFileRegions,
    tablePrompt,
    model,
  });

  // 合併分析狀態：批次分析 或 區域識別 任一進行中即為 true
  const isAnalyzing = batchIsAnalyzing || isRecognizing;

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
      getNextFile?: () => Promise<{ fileId: string; url: string; totalPages: number; effectiveSkip?: number } | null>,
      onFileComplete?: (fileId: string, error?: boolean) => void,
      effectiveSkip?: number,
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
      // 記錄第一個檔案分析啟動時的 effectiveSkip
      if (effectiveSkip !== undefined) {
        initialSkipRef.current.set(targetFileId, effectiveSkip);
      }
      setBatchIsAnalyzing(true);
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
        setBatchIsAnalyzing(false);
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

      // 設定 per-file 分析進度（寫入 FileEntry）
      updateFileProgress(targetFileId, { analysisPages: totalPages, completedPages: 0 });

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

      // === 動態插入頁面到佇列（供券商校正後恢復被省略的頁面）===
      addPagesToQueueRef.current = (fileId: string, pageNums: number[]) => {
        if (!isSessionValid(sessionId)) return;

        // 找到 taskQueue 中該 fileId 最後一個 task 的位置，在其後方插入（維持頁碼順序）
        let insertIdx = -1;
        for (let i = taskQueue.length - 1; i >= 0; i--) {
          if (taskQueue[i].fileId === fileId) {
            insertIdx = i + 1;
            break;
          }
        }
        const newTasks = pageNums.map((p) => ({ fileId, pageNum: p }));
        if (insertIdx === -1) {
          // 該檔案已無 task 在佇列中，插入最前面（優先處理）
          taskQueue.unshift(...newTasks);
        } else {
          taskQueue.splice(insertIdx, 0, ...newTasks);
        }

        // 更新計數
        globalTotal += pageNums.length;
        const ft = totalPerFile.get(fileId) || 0;
        totalPerFile.set(fileId, ft + pageNums.length);
        setAnalysisProgress({ current: globalCompleted, total: globalTotal });

        // 更新 queuedPagesMap
        setQueuedPagesMap((prev) => {
          const nm = new Map(prev);
          const s = nm.get(fileId) || new Set<number>();
          const ns = new Set(s);
          pageNums.forEach((p) => ns.add(p));
          nm.set(fileId, ns);
          return nm;
        });

        // 從 skippedPagesRef 移除（防止 processPage 跳過）
        const skipped = skippedPagesRef.current.get(fileId);
        if (skipped) {
          pageNums.forEach((p) => skipped.delete(p));
        }

        // 更新 per-file 分析進度
        updateFileProgress(fileId, { analysisDelta: pageNums.length });

        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${ts}] ➕ Dynamically added pages [${pageNums.join(', ')}] to queue for file ${fileId}`);
      };

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

            // 設定 per-file 分析進度（寫入 FileEntry）
            updateFileProgress(next.fileId, { analysisPages: next.totalPages, completedPages: 0 });

            // 記錄此檔案分析啟動時的 effectiveSkip
            if (next.effectiveSkip !== undefined) {
              initialSkipRef.current.set(next.fileId, next.effectiveSkip);
            }

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
          // 更新 per-file 分析進度
          updateFileProgress(fileId, { analysisDelta: -1 });
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

        const result = await analyzePageWithRetry(pageNum, promptText, modelId, pdfDoc, sessionId, isSessionValid);

        // 分析完成，移除標記
        removeAnalyzingPage(fileId, pageNum);

        if (!isSessionValid(sessionId)) return;

        globalCompleted++;
        const fileDone = (completedPerFile.get(fileId) || 0) + 1;
        completedPerFile.set(fileId, fileDone);
        setAnalysisProgress({ current: globalCompleted, total: globalTotal });

        // 更新 per-file 已完成頁數
        updateFileProgress(fileId, { completedDelta: 1 });

        if (result) {
          await mergePageResult(pageNum, result, pdfDoc, sessionId, isSessionValid, fileId, updateFileRegions, updateFileReport);
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

      // 清理動態插入 ref（pool 已結束，無法再插入）
      addPagesToQueueRef.current = null;

      // 只有 session 仍有效時才設定完成狀態（否則可能覆蓋新 session 的狀態）
      // 注意：不在這裡清除 analysisFileIdRef，由 PDFExtractApp 的 completion effect 讀取後清除
      if (isSessionValid(sessionId)) {
        setBatchIsAnalyzing(false);
        setQueuedPagesMap(new Map());
        const endTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${endTimestamp}] 🏁 All analysis complete (session=${sessionId}).`);
      }
    },
    [updateFileRegions, updateFileReport, updateFileProgress, isSessionValid, addAnalyzingPage, removeAnalyzingPage]
  );

  // === 停止分析 ===
  const handleStop = useCallback(() => {
    abortRef.current = true;
    stoppedByUserRef.current = true;
    analysisSessionRef.current++; // 讓飛行中操作全部失效
    analysisFileIdRef.current = null;
    addPagesToQueueRef.current = null;
    setBatchIsAnalyzing(false);
    setAnalyzingPagesMap(new Map());
    setQueuedPagesMap(new Map());
    skippedPagesRef.current = new Map();
    initialSkipRef.current = new Map();
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useAnalysis][${timestamp}] 🛑 Analysis stopped by user.`);
  }, []);

  // === 使 session 失效（切換檔案時由外部呼叫）===
  const invalidateSession = useCallback(() => {
    abortRef.current = true;
    analysisSessionRef.current++;
    inFlightPageRef.current = 0;
    addPagesToQueueRef.current = null;
    setBatchIsAnalyzing(false);
    setAnalysisProgress({ current: 0, total: 0 });
    setAnalyzingPagesMap(new Map());
    setQueuedPagesMap(new Map());
    skippedPagesRef.current = new Map();
    initialSkipRef.current = new Map();
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
      if (!targetFileId) return;

      // 先清除該頁的 ALL regions（先清再跑，包含 userModified）
      updateFileRegions(targetFileId, (prev) => {
        const updated = new Map(prev);
        updated.delete(pageNum);
        return updated;
      });

      const pdfDoc = pdfDocRef.current;
      if (!pdfDoc) return;
      const sessionId = analysisSessionRef.current; // 用當前 session（不遞增，因為是單頁操作）

      // 如果該頁在佇列中，先取消（讓批次迴圈跳過它）
      const fileQueued = queuedPagesMap.get(targetFileId);
      const wasInQueue = fileQueued?.has(pageNum) ?? false;
      if (wasInQueue) {
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
        // 抵消 processPage skip 將產生的 analysisDelta -1（此頁仍會被分析）
        updateFileProgress(targetFileId, { analysisDelta: 1 });
        const ts0 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${ts0}] ⏭️ Page ${pageNum} pulled from queue for immediate re-analysis.`);
      }

      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${ts}] 🔄 Re-analyzing page ${pageNum}...`);

      // 重置 abort 標記（切檔時 invalidateSession 會設為 true，單頁重送需要恢復）
      abortRef.current = false;

      // 累加進度，而非覆蓋
      inFlightPageRef.current++;
      setBatchIsAnalyzing(true);
      setAnalysisProgress((prev) => ({
        current: prev.current,
        total: prev.total + 1,
      }));
      setError(null);

      // 標記此頁正在分析（per-file）
      addAnalyzingPage(targetFileId, pageNum);

      const result = await analyzePageWithRetry(pageNum, prompt, model, pdfDoc, sessionId, isSessionValid);

      // 完成：累加 current，而非直接設定
      setAnalysisProgress((prev) => ({
        ...prev,
        current: prev.current + 1,
      }));

      // 分析完成，移除標記（per-file）
      removeAnalyzingPage(targetFileId, pageNum);

      if (result && isSessionValid(sessionId)) {
        await mergePageResult(pageNum, result, pdfDoc, sessionId, isSessionValid, targetFileId, updateFileRegions, updateFileReport);
      }

      // 如果此頁原本在佇列中（首次分析，非重跑），更新 per-file 已完成頁數
      if (wasInQueue) {
        updateFileProgress(targetFileId, { completedDelta: 1 });
      }

      // 只有當所有飛行中的頁面都完成時才停止分析狀態
      inFlightPageRef.current--;
      if (inFlightPageRef.current === 0) {
        setBatchIsAnalyzing(false);
        // 重置進度（避免下次累計混亂）
        setAnalysisProgress({ current: 0, total: 0 });
      }
    },
    [prompt, model, pdfDocRef, updateFileRegions, updateFileReport, updateFileProgress, isSessionValid, queuedPagesMap, addAnalyzingPage, removeAnalyzingPage]
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
    /** 每個檔案分析啟動時的 effectiveSkip（用於券商校正計算差額） */
    initialSkipRef,
    /** 動態插入頁面到佇列（券商校正後恢復被省略頁面） */
    addPagesToQueueRef,
  };
}
