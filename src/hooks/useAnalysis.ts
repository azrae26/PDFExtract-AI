/**
 * 功能：PDF 頁面分析核心邏輯 Custom Hook
 * 職責：跨檔案 worker pool 並行分析、空文字 region 自動 AI 識別（統一隊列）、單頁重送、佇列頁面取消、per-file 停止（不影響 pool）、per-file analyzingPagesMap、整合雙擊識別、券商校正後動態恢復被省略頁面
 * 依賴：react、pdfjs、types、analysisHelpers（含 cropRegionToBase64/recognizeRegionWithRetry）、useRegionRecognize
 *
 * 重要設計：
 * - 所有非同步操作都傳入 pdfDoc 快照 + sessionId，避免切換檔案後存取已銷毀的 PDF document
 * - 所有寫入統一走 updateFileRegions(fileId, updater) 直接更新 files 陣列（Single Source of Truth）
 * - 不依賴共用的 pageRegions state，與 view 層完全解耦
 * - analysisFileIdRef 追蹤目前分析的主要目標檔案 ID
 * - queuedPagesMap（per-file）追蹤排隊中的頁碼，skippedPagesRef（per-file）記錄被使用者取消的頁碼
 * - analyzeAllPages 支援 getNextFile callback，worker 在 task queue 耗盡時自動拉入下一個排隊檔案
 * - initialSkipRef（per-file）記錄分析啟動時的 effectiveSkip，addPagesToQueueRef 支援券商校正後動態插入頁面
 * - 統一隊列：空文字 region 的識別任務統一插入 worker pool 的 taskQueue 前端（插隊），與頁面分析共用 batchSize 並行度
 * - addRecognizeTasksRef：pool 跑中時，handleReanalyzePage 的識別任務也注入同一隊列；pool 沒跑時用分批 Promise.all（此時只有它在呼叫 API，batchSize 自然有效）
 * - 雙擊區域識別委託給 useRegionRecognize hook，isAnalyzing 合併兩者狀態
 */

import { useState, useCallback, useRef } from 'react';
import { pdfjs } from 'react-pdf';
import { Region } from '@/lib/types';
import {
  FileRegionsUpdater,
  FileReportUpdater,
  FileMetadataUpdater,
  FileProgressUpdater,
  analyzePageWithRetry,
  mergePageResult,
  cropRegionToBase64,
  recognizeRegionWithRetry,
} from './analysisHelpers';
import useRegionRecognize from './useRegionRecognize';

interface UseAnalysisOptions {
  pdfDocRef: React.MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  /** 直接更新 files 陣列中指定檔案的 pageRegions */
  updateFileRegions: FileRegionsUpdater;
  /** 更新指定檔案的券商名（report） */
  updateFileReport: FileReportUpdater;
  /** 更新指定檔案的 metadata 候選值（date/code/broker） */
  updateFileMetadata: FileMetadataUpdater;
  /** 更新指定檔案的 per-file 分析進度 */
  updateFileProgress: FileProgressUpdater;
  prompt: string;
  tablePrompt: string;
  model: string;
  batchSize: number;
  /** Gemini API 金鑰（前端使用者輸入） */
  apiKey: string;
  /** 按需載入指定檔案的 PDFDocumentProxy（快取 miss 時用）*/
  loadPdfDoc: (fileId: string) => Promise<pdfjs.PDFDocumentProxy | null>;
}

export default function useAnalysis({
  pdfDocRef,
  updateFileRegions,
  updateFileReport,
  updateFileMetadata,
  updateFileProgress,
  prompt,
  tablePrompt,
  model,
  batchSize,
  apiKey,
  loadPdfDoc,
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
  // 動態插入識別任務到 worker pool 的 taskQueue（pool 跑中時，handleReanalyzePage 的識別任務注入同一隊列）
  const addRecognizeTasksRef = useRef<((fileId: string, pageNum: number, regions: Region[], pdfDoc: pdfjs.PDFDocumentProxy) => void) | null>(null);

  // 用來在分析被中斷時標記
  const abortRef = useRef(false);
  // 追蹤正在飛行中的單頁重送數量（修正多頁同時重送時計數不累加的 bug）
  const inFlightPageRef = useRef(0);
  // per-file 的 in-flight 計數器（修正：多檔案同時重跑單頁時，各檔案獨立恢復 status）
  const inFlightPerFileRef = useRef<Map<string, number>>(new Map());
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
    updateFileProgress,
    tablePrompt,
    model,
    apiKey,
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
      tablePromptText: string,
      concurrency: number,
      targetFileId: string,
      fileUrl: string,
      getNextFile?: () => Promise<{ fileId: string; url: string; totalPages: number; effectiveSkip?: number; alreadyCompletedPages?: Set<number> } | null>,
      onFileComplete?: (fileId: string, error?: boolean) => void,
      effectiveSkip?: number,
      alreadyCompletedPages?: Set<number>,
      apiKeyText?: string,
    ) => {
      // 記錄分析目標檔案 ID（primary file）
      // 記錄分析目標檔案 ID（primary file）
      analysisFileIdRef.current = targetFileId;

      // 遞增 session，讓舊的非同步操作全部失效
      const sessionId = ++analysisSessionRef.current;

      // 計算需要跑的頁數（扣除已完成的）
      const alreadyDoneCount = alreadyCompletedPages?.size || 0;
      const pagesToRun = totalPages - alreadyDoneCount;

      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${timestamp}] 🚀 Starting analysis (session=${sessionId}, file=${targetFileId}) of ${totalPages} pages (${alreadyDoneCount} already done, ${pagesToRun} remaining) with concurrency=${concurrency} (model: ${modelId})...`);

      abortRef.current = false;
      stoppedByUserRef.current = false;
      skippedPagesRef.current = new Map();
      // 記錄第一個檔案分析啟動時的 effectiveSkip
      if (effectiveSkip !== undefined) {
        initialSkipRef.current.set(targetFileId, effectiveSkip);
      }
      setBatchIsAnalyzing(true);
      setError(null);

      // 如果所有頁面都已完成，直接標記完成不啟動 pool
      if (pagesToRun <= 0) {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${ts2}] ✅ All pages already completed for ${targetFileId}, skipping analysis`);
        if (onFileComplete) onFileComplete(targetFileId);
        setBatchIsAnalyzing(false);
        analysisFileIdRef.current = null;
        return;
      }

      // === 跨檔案 worker pool 資料結構 ===
      // recognizeRegion 有值 = 區域識別任務（插隊到 queue 前端，與頁面分析共用 worker pool）
      const taskQueue: { fileId: string; pageNum: number; recognizeRegion?: Region }[] = [];
      const pdfDocMap = new Map<string, pdfjs.PDFDocumentProxy>();
      const totalPerFile = new Map<string, number>();
      const completedPerFile = new Map<string, number>();
      const fileCompletedSet = new Set<string>(); // 避免重複觸發 onFileComplete
      let globalTotal = pagesToRun;
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
      totalPerFile.set(targetFileId, pagesToRun);
      completedPerFile.set(targetFileId, 0);

      // 設定 per-file 分析進度（寫入 FileEntry）
      // 繼續分析時：analysisPages = 總頁數，completedPages = 已完成數
      updateFileProgress(targetFileId, { analysisPages: totalPages, completedPages: alreadyDoneCount });

      // 清除未完成頁面的非 userModified regions，保留已完成頁面的所有 regions
      updateFileRegions(targetFileId, (prev) => {
        const kept = new Map<number, Region[]>();
        prev.forEach((regions, page) => {
          if (alreadyCompletedPages?.has(page)) {
            // 已完成頁面：保留所有 regions
            kept.set(page, regions);
          } else {
            // 未完成頁面：只保留 userModified
            const userRegions = regions.filter((r) => r.userModified);
            if (userRegions.length > 0) kept.set(page, userRegions);
          }
        });
        return kept;
      });

      // 填入第一個檔案的 tasks（跳過已完成的頁面）
      const queuedPages = new Set<number>();
      for (let p = 1; p <= totalPages; p++) {
        if (!alreadyCompletedPages?.has(p)) {
          taskQueue.push({ fileId: targetFileId, pageNum: p });
          queuedPages.add(p);
        }
      }

      // 初始化排隊頁面集合（per-file，只包含未完成的頁面）
      setQueuedPagesMap((prev) => {
        const nm = new Map(prev);
        nm.set(targetFileId, queuedPages);
        return nm;
      });
      setAnalysisProgress({ current: 0, total: pagesToRun });

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

      // === 動態注入識別任務到 worker pool（handleReanalyzePage 用）===
      addRecognizeTasksRef.current = (fileId: string, pageNum: number, regions: Region[], pdfDoc: pdfjs.PDFDocumentProxy) => {
        if (!isSessionValid(sessionId)) return;

        // 確保 pdfDoc 可用（檔案可能已被 pool 標為完成並銷毀 pdfDocMap 中的 doc）
        if (!pdfDocMap.has(fileId)) {
          pdfDocMap.set(fileId, pdfDoc);
        }

        // 允許 handleFileDone 再次觸發（檔案可能先前已被標為完成）
        fileCompletedSet.delete(fileId);

        // 插入識別任務到 queue 前端（插隊）
        const recognizeTasks = regions.map((r) => ({ fileId, pageNum, recognizeRegion: r }));
        taskQueue.unshift(...recognizeTasks);

        // 更新計數
        globalTotal += recognizeTasks.length;
        const ft = totalPerFile.get(fileId) || 0;
        totalPerFile.set(fileId, ft + recognizeTasks.length);
        setAnalysisProgress({ current: globalCompleted, total: globalTotal });
        updateFileProgress(fileId, { analysisDelta: recognizeTasks.length, status: 'processing' });

        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${ts}] 🔍 Injected ${recognizeTasks.length} recognize task(s) for page ${pageNum} into pool queue (file=${fileId})`);
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

            // 計算此檔案需要跑的頁數（扣除已完成的）
            const nextAlreadyDone = next.alreadyCompletedPages?.size || 0;
            const nextPagesToRun = next.totalPages - nextAlreadyDone;

            const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
            console.log(`[useAnalysis][${ts}] 📂 Worker pool pulling next file: ${next.fileId} (${next.totalPages} pages, ${nextAlreadyDone} already done, ${nextPagesToRun} remaining)`);

            // 所有頁面都已完成，直接標記完成
            if (nextPagesToRun <= 0) {
              handleFileDone(next.fileId, false);
              return false;
            }

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
            totalPerFile.set(next.fileId, nextPagesToRun);
            completedPerFile.set(next.fileId, 0);

            // 設定 per-file 分析進度（寫入 FileEntry）
            // 繼續分析時：analysisPages = 總頁數，completedPages = 已完成數
            updateFileProgress(next.fileId, { analysisPages: next.totalPages, completedPages: nextAlreadyDone });

            // 記錄此檔案分析啟動時的 effectiveSkip
            if (next.effectiveSkip !== undefined) {
              initialSkipRef.current.set(next.fileId, next.effectiveSkip);
            }

            // 清除未完成頁面的非 userModified regions，保留已完成頁面的所有 regions
            updateFileRegions(next.fileId, (prev) => {
              const kept = new Map<number, Region[]>();
              prev.forEach((regions, page) => {
                if (next.alreadyCompletedPages?.has(page)) {
                  kept.set(page, regions);
                } else {
                  const userRegions = regions.filter((r) => r.userModified);
                  if (userRegions.length > 0) kept.set(page, userRegions);
                }
              });
              return kept;
            });

            // 填入新 tasks（跳過已完成的頁面）
            const nextQueuedPages = new Set<number>();
            for (let p = 1; p <= next.totalPages; p++) {
              if (!next.alreadyCompletedPages?.has(p)) {
                taskQueue.push({ fileId: next.fileId, pageNum: p });
                nextQueuedPages.add(p);
              }
            }

            // 更新全域進度
            globalTotal += nextPagesToRun;
            setAnalysisProgress((prev) => ({ ...prev, total: globalTotal }));

            // 更新 queuedPagesMap（per-file，只包含未完成的頁面）
            setQueuedPagesMap((prev) => {
              const nm = new Map(prev);
              nm.set(next.fileId, nextQueuedPages);
              return nm;
            });

            return true;
          } finally {
            pendingFetch = null;
          }
        })();

        return pendingFetch;
      };

      // bbox 比對（歸一化整數座標，精確匹配）— processTask 的分析/識別分支共用
      const bboxEq = (a: number[], b: number[]) =>
        a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

      // === 處理單一任務（頁面分析 或 區域識別）===
      const processTask = async (task: { fileId: string; pageNum: number; recognizeRegion?: Region }) => {
        const { fileId, pageNum } = task;
        if (!isSessionValid(sessionId)) return;

        const pdfDoc = pdfDocMap.get(fileId);
        if (!pdfDoc) return;

        // ====== 區域識別任務（空文字 region 自動 AI 識別）======
        if (task.recognizeRegion) {
          const region = task.recognizeRegion;
          const regionBbox = region.bbox;

          // 標記為識別中（用 bbox 比對）
          updateFileRegions(fileId, (prev) => {
            const updated = new Map(prev);
            const rs = updated.get(pageNum);
            if (rs) {
              updated.set(pageNum, rs.map((r) =>
                bboxEq(r.bbox, regionBbox) && !r.userModified ? { ...r, text: '⏳ AI 識別中...' } : r
              ));
            }
            return updated;
          });

          try {
            // 裁切 + 送 AI 識別（每個任務獨立渲染頁面，允許並行）
            const { base64, width, height, sizeKB } = await cropRegionToBase64(pdfDoc, pageNum, region);
            const arTs = new Date().toLocaleTimeString('en-US', { hour12: false });
            console.log(`[useAnalysis][${arTs}] 📐 Auto-recognize region bbox=[${regionBbox}]: ${width}x${height}px, ${sizeKB} KB`);

            const recognizeResult = await recognizeRegionWithRetry(base64, tablePromptText, modelId, pageNum, region.id, apiKeyText);

            if (!isSessionValid(sessionId)) return;

            if (recognizeResult.success && recognizeResult.text) {
              updateFileRegions(fileId, (prev) => {
                const updated = new Map(prev);
                const rs = updated.get(pageNum);
                if (rs) {
                  updated.set(pageNum, rs.map((r) =>
                    bboxEq(r.bbox, regionBbox) && !r.userModified ? { ...r, text: recognizeResult.text!, userModified: true } : r
                  ));
                }
                return updated;
              });
              const arTs2 = new Date().toLocaleTimeString('en-US', { hour12: false });
              console.log(`[useAnalysis][${arTs2}] ✅ Auto-recognized region bbox=[${regionBbox}]: ${recognizeResult.text!.length} chars`);
            } else {
              updateFileRegions(fileId, (prev) => {
                const updated = new Map(prev);
                const rs = updated.get(pageNum);
                if (rs) {
                  updated.set(pageNum, rs.map((r) =>
                    bboxEq(r.bbox, regionBbox) && !r.userModified ? { ...r, text: `❌ 識別失敗: ${recognizeResult.error}` } : r
                  ));
                }
                return updated;
              });
            }
          } catch (e) {
            if (isSessionValid(sessionId)) {
              console.warn(`[useAnalysis] ⚠️ Auto-recognize failed for page ${pageNum} region bbox=[${regionBbox}]:`, e);
            }
          }

          // 識別完成：更新進度 + 檢查檔案完成
          if (!isSessionValid(sessionId)) return;
          globalCompleted++;
          const fileDone = (completedPerFile.get(fileId) || 0) + 1;
          completedPerFile.set(fileId, fileDone);
          setAnalysisProgress({ current: globalCompleted, total: globalTotal });
          updateFileProgress(fileId, { completedDelta: 1 });
          if (fileDone >= (totalPerFile.get(fileId) || 0)) handleFileDone(fileId);
          return;
        }

        // ====== 頁面分析任務（原有邏輯）======

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

        const result = await analyzePageWithRetry(pageNum, promptText, modelId, pdfDoc, sessionId, isSessionValid, apiKeyText);

        // 分析完成，移除標記
        removeAnalyzingPage(fileId, pageNum);

        if (!isSessionValid(sessionId)) return;

        if (result) {
          const emptyRegions = await mergePageResult(
            pageNum,
            result,
            pdfDoc,
            sessionId,
            isSessionValid,
            fileId,
            updateFileRegions,
            updateFileReport,
            updateFileMetadata,
          );

          // === 空文字 region → 插入識別任務到 queue 前端（插隊，與頁面分析並行處理）===
          if (emptyRegions.length > 0 && isSessionValid(sessionId)) {
            const recognizeTasks = emptyRegions.map((r) => ({ fileId, pageNum, recognizeRegion: r }));
            taskQueue.unshift(...recognizeTasks);

            // 更新計數（識別任務也計入進度，檔案完成前須全部跑完）
            globalTotal += recognizeTasks.length;
            const ft = totalPerFile.get(fileId) || 0;
            totalPerFile.set(fileId, ft + recognizeTasks.length);
            updateFileProgress(fileId, { analysisDelta: recognizeTasks.length });

            const arTs = new Date().toLocaleTimeString('en-US', { hour12: false });
            console.log(`[useAnalysis][${arTs}] 🔍 Queued ${recognizeTasks.length} auto-recognize task(s) for page ${pageNum} (file=${fileId}), inserted at queue front`);
          }
        }

        // 頁面分析完成計數（必須在 mergePageResult + 識別任務排隊之後，
        // 避免多 worker 競態：Worker B 的 fileDone check 跑在 Worker A 的 totalPerFile 更新之前）
        globalCompleted++;
        const fileDone = (completedPerFile.get(fileId) || 0) + 1;
        completedPerFile.set(fileId, fileDone);
        setAnalysisProgress({ current: globalCompleted, total: globalTotal });
        updateFileProgress(fileId, { completedDelta: 1 });

        // 檢查此檔案是否全部完成（此時 totalPerFile 已包含識別任務數量）
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
          await processTask(task);
        }
      };

      await Promise.all(
        Array.from({ length: concurrency }, () => worker())
      );

      // 清理剩餘的 pdfDoc（正常情況下 handleFileDone 已清理）
      pdfDocMap.forEach((doc) => { try { doc.destroy(); } catch { /* ignore */ } });

      // 清理動態插入 ref（pool 已結束，無法再插入）
      addPagesToQueueRef.current = null;
      addRecognizeTasksRef.current = null;

      // 只有 session 仍有效時才設定完成狀態（否則可能覆蓋新 session 的狀態）
      // 注意：不在這裡清除 analysisFileIdRef，由 PDFExtractApp 的 completion effect 讀取後清除
      if (isSessionValid(sessionId)) {
        setBatchIsAnalyzing(false);
        setQueuedPagesMap(new Map());
        const endTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useAnalysis][${endTimestamp}] 🏁 All analysis complete (session=${sessionId}).`);
      }
    },
    [updateFileRegions, updateFileReport, updateFileMetadata, updateFileProgress, isSessionValid, addAnalyzingPage, removeAnalyzingPage]
  );

  // === 停止分析 ===
  const handleStop = useCallback(() => {
    abortRef.current = true;
    stoppedByUserRef.current = true;
    analysisSessionRef.current++; // 讓飛行中操作全部失效
    analysisFileIdRef.current = null;
    addPagesToQueueRef.current = null;
    addRecognizeTasksRef.current = null;
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
    inFlightPerFileRef.current = new Map();
    addPagesToQueueRef.current = null;
    addRecognizeTasksRef.current = null;
    setBatchIsAnalyzing(false);
    setAnalysisProgress({ current: 0, total: 0 });
    setAnalyzingPagesMap(new Map());
    setQueuedPagesMap(new Map());
    skippedPagesRef.current = new Map();
    initialSkipRef.current = new Map();
  }, []);

  // === 停止單一檔案的分析（不影響 worker pool，其他檔案繼續跑）===
  // 把該檔案所有剩餘排隊頁碼加入 skippedPagesRef，workers 遇到時自動跳過
  // 不遞增 analysisSessionRef、不設 abortRef，pool 繼續跑其他檔案
  const stopSingleFile = useCallback((fileId: string) => {
    // 取得該檔案所有排隊中的頁碼，全部加入 skippedPagesRef
    setQueuedPagesMap((prev) => {
      const queued = prev.get(fileId);
      if (queued && queued.size > 0) {
        const skipped = skippedPagesRef.current.get(fileId) || new Set<number>();
        queued.forEach((p) => skipped.add(p));
        skippedPagesRef.current.set(fileId, skipped);
      }
      const nm = new Map(prev);
      nm.delete(fileId);
      return nm;
    });
    // 清除該檔案的 analyzingPagesMap（視覺清理，飛行中的請求仍會完成）
    setAnalyzingPagesMap((prev) => {
      if (!prev.has(fileId)) return prev;
      const nm = new Map(prev);
      nm.delete(fileId);
      return nm;
    });
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useAnalysis][${ts}] ⏹️ Stopped single file: ${fileId} (pool continues)`);
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
        analyzeAllPages(numPages, prompt, model, tablePrompt, batchSize, targetFileId, fileUrl, undefined, undefined, undefined, undefined, apiKey);
      }
    },
    [prompt, model, tablePrompt, batchSize, apiKey, analyzeAllPages, updateFileRegions]
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

      let pdfDoc = pdfDocRef.current;
      if (!pdfDoc) {
        // 快取 miss（通常因驅逐）→ 按需重新載入
        const loadedDoc = await loadPdfDoc(targetFileId);
        if (!loadedDoc) {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.warn(`[useAnalysis][${ts}] ⚠️ Cannot re-analyze page ${pageNum}: pdfDoc unavailable for ${targetFileId}`);
          return;
        }
        pdfDoc = loadedDoc;
        pdfDocRef.current = loadedDoc;
      }
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
      } else {
        // 獨立重跑（頁面已完成）：per-file 分析總數 +1（完成時會 +1 completedPages）
        updateFileProgress(targetFileId, { analysisDelta: 1 });
      }

      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useAnalysis][${ts}] 🔄 Re-analyzing page ${pageNum}...`);

      // 重置 abort 標記（切檔時 invalidateSession 會設為 true，單頁重送需要恢復）
      abortRef.current = false;

      // 累加進度，而非覆蓋
      inFlightPageRef.current++;
      inFlightPerFileRef.current.set(targetFileId, (inFlightPerFileRef.current.get(targetFileId) || 0) + 1);
      setBatchIsAnalyzing(true);
      // 設定檔案狀態為 processing（讓列表與設定面板顯示轉圈圈圖示）
      updateFileProgress(targetFileId, { status: 'processing' });
      setAnalysisProgress((prev) => ({
        current: prev.current,
        total: prev.total + 1,
      }));
      setError(null);

      // 標記此頁正在分析（per-file）
      addAnalyzingPage(targetFileId, pageNum);

      const result = await analyzePageWithRetry(pageNum, prompt, model, pdfDoc, sessionId, isSessionValid, apiKey);

      // 完成：累加 current，而非直接設定
      setAnalysisProgress((prev) => ({
        ...prev,
        current: prev.current + 1,
      }));

      // 分析完成，移除標記（per-file）
      removeAnalyzingPage(targetFileId, pageNum);

      // 追蹤是否把識別任務注入到 pool（注入後由 pool 負責設回 done，這裡不設）
      let injectedToPool = false;

      if (result && isSessionValid(sessionId)) {
        const emptyRegions = await mergePageResult(
          pageNum,
          result,
          pdfDoc,
          sessionId,
          isSessionValid,
          targetFileId,
          updateFileRegions,
          updateFileReport,
          updateFileMetadata,
        );

        // === 空文字 region → 識別任務進入隊列 ===
        if (emptyRegions.length > 0 && isSessionValid(sessionId)) {
          // bbox 比對
          const bboxEq2 = (a: number[], b: number[]) =>
            a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

          // 先全部標為「AI 識別中」
          updateFileRegions(targetFileId, (prev) => {
            const updated = new Map(prev);
            const rs = updated.get(pageNum);
            if (rs) {
              const emptyBboxes = emptyRegions.map((r) => r.bbox);
              updated.set(pageNum, rs.map((r) => {
                if (!r.userModified && emptyBboxes.some((b) => bboxEq2(r.bbox, b))) {
                  return { ...r, text: '⏳ AI 識別中...' };
                }
                return r;
              }));
            }
            return updated;
          });

          if (addRecognizeTasksRef.current) {
            // === Pool 在跑：注入到同一個 taskQueue，共用 batchSize 並行度 ===
            // 注入後由 pool 的 handleFileDone → handlePoolFileComplete 負責設回 done
            injectedToPool = true;
            const arTs = new Date().toLocaleTimeString('en-US', { hour12: false });
            console.log(`[useAnalysis][${arTs}] 🔍 Injecting ${emptyRegions.length} recognize task(s) from re-analyzed page ${pageNum} into pool queue`);
            addRecognizeTasksRef.current(targetFileId, pageNum, emptyRegions, pdfDoc);
          } else {
            // === Pool 沒在跑：用分批 Promise.all（此時只有這裡在呼叫 API，batchSize 自然有效）===
            const arTs = new Date().toLocaleTimeString('en-US', { hour12: false });
            console.log(`[useAnalysis][${arTs}] 🔍 Auto-recognizing ${emptyRegions.length} empty region(s) on re-analyzed page ${pageNum} (batch=${batchSize})...`);

            // 累加進度（識別任務計入總數）
            const recCount = emptyRegions.length;
            inFlightPageRef.current += recCount;
            inFlightPerFileRef.current.set(targetFileId, (inFlightPerFileRef.current.get(targetFileId) || 0) + recCount);
            setAnalysisProgress((prev) => ({ current: prev.current, total: prev.total + recCount }));
            updateFileProgress(targetFileId, { analysisDelta: recCount });

            // 單個識別任務
            const processRecognition = async (region: Region) => {
              if (!isSessionValid(sessionId)) return;
              const regionBbox = region.bbox;

              try {
                const { base64, width, height, sizeKB } = await cropRegionToBase64(pdfDoc, pageNum, region);
                const arTs2 = new Date().toLocaleTimeString('en-US', { hour12: false });
                console.log(`[useAnalysis][${arTs2}] 📐 Auto-recognize region bbox=[${regionBbox}]: ${width}x${height}px, ${sizeKB} KB`);

                const recognizeResult = await recognizeRegionWithRetry(base64, tablePrompt, model, pageNum, region.id, apiKey);

                if (!isSessionValid(sessionId)) return;

                if (recognizeResult.success && recognizeResult.text) {
                  updateFileRegions(targetFileId, (prev) => {
                    const updated = new Map(prev);
                    const rs = updated.get(pageNum);
                    if (rs) {
                      updated.set(pageNum, rs.map((r) =>
                        bboxEq2(r.bbox, regionBbox) && !r.userModified ? { ...r, text: recognizeResult.text!, userModified: true } : r
                      ));
                    }
                    return updated;
                  });
                  const arTs3 = new Date().toLocaleTimeString('en-US', { hour12: false });
                  console.log(`[useAnalysis][${arTs3}] ✅ Auto-recognized region bbox=[${regionBbox}]: ${recognizeResult.text!.length} chars`);
                } else {
                  updateFileRegions(targetFileId, (prev) => {
                    const updated = new Map(prev);
                    const rs = updated.get(pageNum);
                    if (rs) {
                      updated.set(pageNum, rs.map((r) =>
                        bboxEq2(r.bbox, regionBbox) && !r.userModified ? { ...r, text: `❌ 識別失敗: ${recognizeResult.error}` } : r
                      ));
                    }
                    return updated;
                  });
                }
              } catch (e) {
                if (isSessionValid(sessionId)) {
                  console.warn(`[useAnalysis] ⚠️ Auto-recognize failed for page ${pageNum} region bbox=[${regionBbox}]:`, e);
                }
              } finally {
                setAnalysisProgress((prev) => ({ ...prev, current: prev.current + 1 }));
                updateFileProgress(targetFileId, { completedDelta: 1 });
                inFlightPageRef.current--;
                // per-file 計數器遞減
                const pfc = (inFlightPerFileRef.current.get(targetFileId) || 1) - 1;
                if (pfc <= 0) inFlightPerFileRef.current.delete(targetFileId);
                else inFlightPerFileRef.current.set(targetFileId, pfc);
              }
            };

            // 分批並行：每批最多 batchSize 個
            for (let i = 0; i < emptyRegions.length; i += batchSize) {
              if (!isSessionValid(sessionId)) break;
              const batch = emptyRegions.slice(i, i + batchSize);
              await Promise.all(batch.map(processRecognition));
            }
          }
        }
      }

      // 更新 per-file 已完成頁數（無論是從佇列拉出或獨立重跑，都要同步進度到列表與設定面板）
      updateFileProgress(targetFileId, { completedDelta: 1 });

      // === per-file 計數器遞減：此檔案所有 in-flight 完成時立刻設回 done（不等其他檔案）===
      inFlightPageRef.current--;
      const thisFileCount = (inFlightPerFileRef.current.get(targetFileId) || 1) - 1;
      if (thisFileCount <= 0) {
        inFlightPerFileRef.current.delete(targetFileId);
        // 此檔案所有 in-flight 頁面完成，立即設回 done（不等全域計數歸零）
        // 注入 pool 的由 handlePoolFileComplete 負責
        if (!injectedToPool) {
          updateFileProgress(targetFileId, { status: 'done' });
        }
      } else {
        inFlightPerFileRef.current.set(targetFileId, thisFileCount);
      }

      // === 全域計數歸零：重置全域分析狀態 ===
      if (inFlightPageRef.current === 0) {
        // 守衛：若 batch pool 還在跑（analysisFileIdRef !== null），不能碰 batchIsAnalyzing / analysisProgress
        // 否則會觸發 completion effect 把仍在 processing 的檔案全部標為 done
        const poolStillRunning = analysisFileIdRef.current !== null;
        if (!poolStillRunning) {
          setBatchIsAnalyzing(false);
          // 重置進度（避免下次累計混亂）
          setAnalysisProgress({ current: 0, total: 0 });
        }
      }
    },
    [prompt, model, tablePrompt, batchSize, apiKey, pdfDocRef, updateFileRegions, updateFileReport, updateFileMetadata, updateFileProgress, isSessionValid, queuedPagesMap, addAnalyzingPage, removeAnalyzingPage, loadPdfDoc]
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
    /** 停止單一檔案的分析（不影響 pool） */
    stopSingleFile,
    /** 取消佇列中的單頁 */
    cancelQueuedPage,
    /** 每個檔案分析啟動時的 effectiveSkip（用於券商校正計算差額） */
    initialSkipRef,
    /** 動態插入頁面到佇列（券商校正後恢復被省略頁面） */
    addPagesToQueueRef,
  };
}
