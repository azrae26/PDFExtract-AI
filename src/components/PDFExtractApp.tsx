/**
 * 功能：PDFExtract AI 主應用元件
 * 職責：管理 UI 配置狀態（prompt / model / 面板寬度等）、Region CRUD、四欄佈局渲染、
 *       hover / scroll 互動、全頁面三區域拖放上傳（左=背景跑、中=當前頁並跑、右=僅加入列表）
 * 依賴：useFileManager hook（檔案生命週期 + 分析流程）、usePanelResize hook（面板拖動 resize）、
 *       FileListPanel、PdfUploader、PdfViewer、TextPanel
 *
 * 重要設計：
 * - files 陣列是唯一資料來源（Single Source of Truth），由 useFileManager 管理
 * - pageRegions 從 activeFile.pageRegions 衍生（唯讀），所有寫入統一走 updateActiveFileRegions
 * - 多 PdfViewer 預掛載（mountedFileIds 決定掛載範圍，CSS visibility toggle 實現零延遲切換）
 * - 切檔 = 改 activeFileId → CSS visibility toggle，不需要 swap/sync/remount
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { pdfjs } from 'react-pdf';
import PdfUploader from './PdfUploader';
import PdfViewer from './PdfViewer';
import TextPanel from './TextPanel';
import FileListPanel from './FileListPanel';
import { Region } from '@/lib/types';
import { DEFAULT_PROMPT, DEFAULT_TABLE_PROMPT } from '@/lib/constants';
import { DEFAULT_BROKER_SKIP_MAP } from '@/lib/brokerUtils';
import { DEFAULT_MODEL } from './PdfUploader';
import useFileManager from '@/hooks/useFileManager';
import usePanelResize from '@/hooks/usePanelResize';

// === 預設批次並行數量 ===
const DEFAULT_BATCH_SIZE = 3;

// === localStorage 持久化 key ===
const STORAGE_KEY = 'pdfextract-ai-config';

/** 從 localStorage 讀取已儲存的配置 */
function loadConfig(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

/** 將配置寫入 localStorage */
function saveConfig(patch: Record<string, unknown>) {
  try {
    const existing = loadConfig();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, ...patch }));
  } catch { /* ignore */ }
}

/** 空 Set 常數（避免每次 render 建立新物件導致不必要的 re-render） */
const EMPTY_SET = new Set<number>();

// 設定 PDF.js worker（使用 CDN，避免 bundler 問題）
if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
}

export default function PDFExtractApp() {
  // === UI 配置狀態（持久化到 localStorage）===
  const [prompt, setPrompt] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.prompt === 'string' ? cfg.prompt : DEFAULT_PROMPT;
  });
  const [tablePrompt, setTablePrompt] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.tablePrompt === 'string' ? cfg.tablePrompt : DEFAULT_TABLE_PROMPT;
  });
  const [model, setModel] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.model === 'string' ? cfg.model : DEFAULT_MODEL;
  });
  const [batchSize, setBatchSize] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.batchSize === 'number' ? cfg.batchSize : DEFAULT_BATCH_SIZE;
  });
  const [skipLastPages, setSkipLastPages] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.skipLastPages === 'number' ? cfg.skipLastPages : 2;
  });
  // 券商 → 忽略末尾頁數映射（持久化到 localStorage）
  const [brokerSkipMap, setBrokerSkipMap] = useState<Record<string, number>>(() => {
    const cfg = loadConfig();
    // 若 localStorage 中有非空的 brokerSkipMap 就使用，否則用預設值
    if (typeof cfg.brokerSkipMap === 'object' && cfg.brokerSkipMap !== null
        && Object.keys(cfg.brokerSkipMap as Record<string, number>).length > 0) {
      return cfg.brokerSkipMap as Record<string, number>;
    }
    return { ...DEFAULT_BROKER_SKIP_MAP };
  });

  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  // === useFileManager Hook（檔案生命週期 + 分析流程）===
  const {
    files, setFiles,
    activeFileId, setActiveFileId,
    activeFile, numPages, pageRegions,
    filesRef, activeFileIdRef, pdfDocRef,
    updateActiveFileRegions,
    handleFilesUpload,
    handleRemoveFile,
    handleClearAll,
    handleDocumentLoadForFile,
    isAnalyzing, analysisProgress, error,
    handleStop, handleReanalyze, handleReanalyzePage, handleRegionDoubleClick,
    analyzingPagesMap, queuedPagesMap, cancelQueuedPage,
    analysisFileIdRef,
    handleStopFile, handleReanalyzeFile, triggerQueueProcessing,
    mountedFileIds,
  } = useFileManager({
    prompt, tablePrompt, model, batchSize, skipLastPages, brokerSkipMap,
  });

  // === usePanelResize Hook（四欄分界線拖動）===
  const {
    fileListWidth, leftWidth, rightWidth,
    setFileListWidth, setLeftWidth, setRightWidth,
    handleDividerMouseDown,
  } = usePanelResize();

  // === 自動儲存配置到 localStorage ===
  useEffect(() => { saveConfig({ prompt }); }, [prompt]);
  useEffect(() => { saveConfig({ tablePrompt }); }, [tablePrompt]);
  useEffect(() => { saveConfig({ model }); }, [model]);
  useEffect(() => { saveConfig({ batchSize }); }, [batchSize]);
  useEffect(() => { saveConfig({ skipLastPages }); }, [skipLastPages]);
  useEffect(() => { saveConfig({ brokerSkipMap }); }, [brokerSkipMap]);
  useEffect(() => { saveConfig({ fileListWidth }); }, [fileListWidth]);
  useEffect(() => { saveConfig({ leftWidth }); }, [leftWidth]);
  useEffect(() => { saveConfig({ rightWidth }); }, [rightWidth]);

  // === 同步 brokerSkipMap 到 prompt 中的「券商有：{{...}}」區塊 ===
  useEffect(() => {
    const brokerNames = Object.keys(brokerSkipMap);
    if (brokerNames.length === 0) return;
    const newBlock = `券商有：{{${brokerNames.join('、')}}}`;
    setPrompt((prev) => {
      const pattern = /券商有：\{\{[^}]*\}\}/;
      if (!pattern.test(prev)) return prev; // prompt 中沒有此區塊，不修改
      const updated = prev.replace(pattern, newBlock);
      return updated === prev ? prev : updated; // 內容相同時回傳原參考，避免不必要的 re-render
    });
  }, [brokerSkipMap]);

  // === 切換活躍檔案 ===
  const handleSelectFile = useCallback((fileId: string) => {
    setScrollTarget(null); // 清除前一個檔案的滾動目標，避免新檔案繼承舊的 scrollIntoView 位置
    setHoveredRegionId(null); // 清除 hover 狀態，避免切換後殘留高亮
    setActiveFileId(fileId);
    setCurrentPage(1);
  }, [setActiveFileId]);

  // === 更新單一區域的 bbox（拖動/resize 後）→ 標記 userModified + 自動重新提取文字 ===
  const handleRegionUpdate = useCallback(
    async (page: number, regionId: number, newBbox: [number, number, number, number]) => {
      // bbox 沒變就跳過（雙擊時 onDragStop 也會觸發，但 bbox 不變，不需要重新提取文字）
      const currentFile = filesRef.current.find((f) => f.id === activeFileIdRef.current);
      const currentRegion = currentFile?.pageRegions.get(page)?.find((r) => r.id === regionId);
      if (currentRegion) {
        const [cx1, cy1, cx2, cy2] = currentRegion.bbox;
        const [nx1, ny1, nx2, ny2] = newBbox;
        if (cx1 === nx1 && cy1 === ny1 && cx2 === nx2 && cy2 === ny2) return;
      }

      const { extractTextForRegions } = await import('@/lib/pdfTextExtract');

      updateActiveFileRegions((prev) => {
        const updated = new Map(prev);
        const regions = updated.get(page);
        if (regions) {
          const updatedRegions = regions.map((r) =>
            r.id === regionId ? { ...r, bbox: newBbox, userModified: true } : r
          );
          updated.set(page, updatedRegions);
        }
        return updated;
      });

      try {
        if (!pdfDocRef.current) return;
        const pdfPage = await pdfDocRef.current.getPage(page);
        const tempRegion: Region = { id: regionId, bbox: newBbox, label: '', text: '' };
        const [extracted] = await extractTextForRegions(pdfPage, [tempRegion]);

        updateActiveFileRegions((prev) => {
          const updated = new Map(prev);
          const regions = updated.get(page);
          if (regions) {
            const updatedRegions = regions.map((r) =>
              // 若正在 AI 識別中（text 以 ⏳ 開頭），不覆蓋
              r.id === regionId && !r.text?.startsWith('⏳') ? { ...r, text: extracted.text } : r
            );
            updated.set(page, updatedRegions);
          }
          return updated;
        });

        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[PDFExtractApp][${ts}] 📝 Re-extracted text for page ${page} region ${regionId}`);
      } catch (e) {
        console.warn(`[PDFExtractApp] ⚠️ Failed to re-extract text for page ${page} region ${regionId}`, e);
      }
    },
    [updateActiveFileRegions, pdfDocRef]
  );

  // === 刪除單一 region ===
  const handleRegionRemove = useCallback((page: number, regionId: number) => {
    updateActiveFileRegions((prev) => {
      const updated = new Map(prev);
      const regions = updated.get(page);
      if (regions) {
        const filtered = regions.filter((r) => r.id !== regionId);
        if (filtered.length > 0) {
          updated.set(page, filtered);
        } else {
          updated.delete(page);
        }
      }
      return updated;
    });
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] 🗑️ Removed region ${regionId} from page ${page}`);
  }, [updateActiveFileRegions]);

  // === 刪除某頁的所有 region ===
  const handleRemoveAllRegions = useCallback((page: number) => {
    updateActiveFileRegions((prev) => {
      const updated = new Map(prev);
      updated.delete(page);
      return updated;
    });
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] 🗑️ Removed all regions from page ${page}`);
  }, [updateActiveFileRegions]);

  // === 新增 region（使用者在 PDF 上手動畫框）===
  const handleRegionAdd = useCallback(
    async (page: number, bbox: [number, number, number, number]) => {
      const { extractTextForRegions } = await import('@/lib/pdfTextExtract');

      // 從 filesRef 讀取最新 regions 計算 newId（避免 closure stale）
      const currentFile = filesRef.current.find((f) => f.id === activeFileIdRef.current);
      const currentRegions = currentFile?.pageRegions.get(page) || [];
      const newId = currentRegions.reduce((max, r) => Math.max(max, r.id), 0) + 1;

      const newRegion: Region = {
        id: newId,
        bbox,
        label: `手動框 ${newId}`,
        text: '',
        userModified: true,
      };

      updateActiveFileRegions((prev) => {
        const updated = new Map(prev);
        const existing = updated.get(page) || [];
        const [nx1, ny1] = bbox;
        let insertIdx = existing.length;
        for (let i = 0; i < existing.length; i++) {
          const [ex1, ey1] = existing[i].bbox;
          const yDiff = ey1 - ny1;
          if (yDiff > 15 || (Math.abs(yDiff) <= 15 && ex1 > nx1)) {
            insertIdx = i;
            break;
          }
        }
        const newList = [...existing];
        newList.splice(insertIdx, 0, newRegion);
        updated.set(page, newList);
        return updated;
      });

      try {
        if (!pdfDocRef.current) return;
        const pdfPage = await pdfDocRef.current.getPage(page);
        const [extracted] = await extractTextForRegions(pdfPage, [newRegion]);
        updateActiveFileRegions((prev) => {
          const updated = new Map(prev);
          const regions = updated.get(page);
          if (regions) {
            updated.set(page, regions.map((r) =>
              r.id === newId ? { ...r, text: extracted.text } : r
            ));
          }
          return updated;
        });
      } catch (e) {
        console.warn(`[PDFExtractApp] ⚠️ Text extraction failed for new region on page ${page}`, e);
      }

      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] ➕ Added new region ${newId} on page ${page}`);
    },
    [updateActiveFileRegions, filesRef, activeFileIdRef, pdfDocRef]
  );

  // === 重新排序某頁的 regions ===
  const handleReorderRegions = useCallback((page: number, reorderedRegions: Region[]) => {
    updateActiveFileRegions((prev) => {
      const updated = new Map(prev);
      updated.set(page, reorderedRegions);
      return updated;
    });
  }, [updateActiveFileRegions]);

  // === 點擊文字框 → 滾動 PDF 到對應框 ===
  const handleClickRegion = useCallback((regionKey: string) => {
    setScrollTarget(null);
    requestAnimationFrame(() => setScrollTarget(regionKey));
  }, []);

  // === 全頁面拖放 PDF（三區域模式：左=背景跑、中=當前頁並跑、右=僅加入列表）===
  const [isPageDragging, setIsPageDragging] = useState(false);
  const [dragZone, setDragZone] = useState<'left' | 'center' | 'right' | null>(null);
  const dragCounterRef = useRef(0);

  const handlePageDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsPageDragging(true);
    }
  }, []);

  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsPageDragging(false);
      setDragZone(null);
    }
  }, []);

  const handlePageDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 根據滑鼠 X 位置判斷在哪個區域（左 27.5% / 中 45% / 右 27.5%）
    const ratio = e.clientX / window.innerWidth;
    if (ratio < 0.275) {
      setDragZone('left');
    } else if (ratio < 0.725) {
      setDragZone('center');
    } else {
      setDragZone('right');
    }
  }, []);

  const handlePageDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const zone = dragZone;
      setIsPageDragging(false);
      setDragZone(null);
      dragCounterRef.current = 0;

      const droppedFiles = Array.from(e.dataTransfer.files).filter(
        (f) => f.type === 'application/pdf'
      );
      if (droppedFiles.length > 0) {
        // 左=當前頁並跑, 中=背景跑, 右=僅加入列表
        const mode = zone === 'left' ? 'active' : zone === 'right' ? 'idle' : 'background';
        handleFilesUpload(droppedFiles, mode);
      }
    },
    [handleFilesUpload, dragZone]
  );

  // === 全域分析 toggle handler（FileListPanel 用）===
  const handleToggleAnalysis = useCallback(() => {
    if (isAnalyzing) {
      // 全域暫停
      handleStop();
    } else {
      const hasUnfinished = filesRef.current.some((f) => f.status === 'idle' || f.status === 'stopped');
      const allDone = filesRef.current.length > 0 && filesRef.current.every((f) => f.status === 'done');

      if (hasUnfinished) {
        // 繼續分析：將 idle/stopped 設為 queued 並觸發佇列
        setFiles((prev) =>
          prev.map((f) =>
            f.status === 'idle' || f.status === 'stopped'
              ? { ...f, status: 'queued' as const }
              : f
          )
        );
        setTimeout(() => triggerQueueProcessing(), 0);
      } else if (allDone) {
        // 全部重新分析：清除所有檔案結果，設為 queued
        setFiles((prev) =>
          prev.map((f) => ({
            ...f,
            status: 'queued' as const,
            pageRegions: new Map(),
            analysisPages: 0,
            completedPages: 0,
          }))
        );
        setTimeout(() => triggerQueueProcessing(), 0);
      }
    }
  }, [isAnalyzing, handleStop, setFiles, filesRef, triggerQueueProcessing]);

  // 分界線共用的 UI 元素
  const Divider = ({ side }: { side: 'fileList' | 'left' | 'right' }) => (
    <div
      onMouseDown={handleDividerMouseDown(side)}
      className="w-1.5 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors flex-shrink-0 relative group"
      title="拖動調整面板寬度"
    >
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="w-1 h-1 rounded-full bg-white" />
        <div className="w-1 h-1 rounded-full bg-white" />
        <div className="w-1 h-1 rounded-full bg-white" />
      </div>
    </div>
  );

  return (
    <div
      className="flex h-screen bg-gray-50 overflow-hidden relative"
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
      {/* 全頁面拖放覆蓋層（三區域：左=開啟並分析 27.5%、中=背景分析 45%、右=僅加入列表 27.5%） */}
      {isPageDragging && (
        <div className="absolute inset-0 z-50 flex pointer-events-none backdrop-blur-md">
          {/* 左區 — 開啟並分析 (27.5%) */}
          <div className={`flex flex-col items-center justify-center gap-3 border-4 border-dashed transition-all duration-150 ${
            dragZone === 'left'
              ? 'bg-green-500/25 border-green-500'
              : 'bg-green-500/5 border-green-400/60'
          }`} style={{ width: '27.5%' }}>
            <div className={`rounded-full p-4 transition-all duration-150 ${
              dragZone === 'left' ? 'bg-green-500/20 scale-110' : 'bg-green-500/15'
            }`}>
              <svg className={`w-10 h-10 transition-colors duration-150 ${dragZone === 'left' ? 'text-green-600' : 'text-green-500'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div className="text-center">
              <p className={`text-lg font-bold transition-colors duration-150 ${dragZone === 'left' ? 'text-green-700' : 'text-green-600'}`}>開啟並分析</p>
              <p className={`text-sm mt-1 transition-colors duration-150 ${dragZone === 'left' ? 'text-green-600' : 'text-green-500'}`}>立即切換至此檔案</p>
            </div>
          </div>
          {/* 中區 — 背景分析 (45%) */}
          <div className={`flex flex-col items-center justify-center gap-3 border-4 border-dashed transition-all duration-150 ${
            dragZone === 'center'
              ? 'bg-blue-500/25 border-blue-500'
              : 'bg-blue-500/5 border-blue-300/50'
          }`} style={{ width: '45%' }}>
            <div className={`rounded-full p-4 transition-all duration-150 ${
              dragZone === 'center' ? 'bg-blue-500/20 scale-110' : 'bg-blue-500/10'
            }`}>
              <svg className={`w-10 h-10 transition-colors duration-150 ${dragZone === 'center' ? 'text-blue-600' : 'text-blue-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </div>
            <div className="text-center">
              <p className={`text-lg font-bold transition-colors duration-150 ${dragZone === 'center' ? 'text-blue-700' : 'text-blue-500'}`}>背景分析</p>
              <p className={`text-sm mt-1 transition-colors duration-150 ${dragZone === 'center' ? 'text-blue-600' : 'text-blue-400'}`}>排入佇列，背景執行</p>
            </div>
          </div>
          {/* 右區 — 僅加入列表 (27.5%) */}
          <div className={`flex flex-col items-center justify-center gap-3 border-4 border-dashed transition-all duration-150 ${
            dragZone === 'right'
              ? 'bg-gray-500/25 border-gray-500'
              : 'bg-gray-500/5 border-gray-300/50'
          }`} style={{ width: '27.5%' }}>
            <div className={`rounded-full p-4 transition-all duration-150 ${
              dragZone === 'right' ? 'bg-gray-500/20 scale-110' : 'bg-gray-500/10'
            }`}>
              <svg className={`w-10 h-10 transition-colors duration-150 ${dragZone === 'right' ? 'text-gray-600' : 'text-gray-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="text-center">
              <p className={`text-lg font-bold transition-colors duration-150 ${dragZone === 'right' ? 'text-gray-700' : 'text-gray-500'}`}>僅加入列表</p>
              <p className={`text-sm mt-1 transition-colors duration-150 ${dragZone === 'right' ? 'text-gray-600' : 'text-gray-400'}`}>放進列表，不執行分析</p>
            </div>
          </div>
        </div>
      )}

      {/* 最左側面板 — 檔案列表 */}
      <div className="h-full flex-shrink-0" style={{ width: fileListWidth }}>
        <FileListPanel
          files={files}
          activeFileId={activeFileId}
          onSelectFile={handleSelectFile}
          onRemoveFile={handleRemoveFile}
          onClearAll={handleClearAll}
          isAnalyzing={isAnalyzing}
          onToggleAnalysis={handleToggleAnalysis}
        />
      </div>

      {/* 檔案列表分界線 */}
      <Divider side="fileList" />

      {/* 左側面板 — 設定 & Prompt */}
      <div className="h-full flex-shrink-0" style={{ width: leftWidth }}>
        <PdfUploader
          prompt={prompt}
          onPromptChange={setPrompt}
          tablePrompt={tablePrompt}
          onTablePromptChange={setTablePrompt}
          model={model}
          onModelChange={setModel}
          batchSize={batchSize}
          onBatchSizeChange={setBatchSize}
          skipLastPages={skipLastPages}
          onSkipLastPagesChange={setSkipLastPages}
          isAnalyzing={activeFile?.status === 'processing'}
          progress={{ current: activeFile?.completedPages ?? 0, total: activeFile?.analysisPages ?? 0 }}
          numPages={numPages}
          onReanalyze={() => {
            if (!activeFileId || !activeFile) return;
            // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
            const effectiveSkipRe = (activeFile.report && brokerSkipMap[activeFile.report] !== undefined)
              ? brokerSkipMap[activeFile.report]
              : skipLastPages;
            handleReanalyzeFile(Math.max(1, numPages - effectiveSkipRe), activeFileId, activeFile.url);
          }}
          onStop={() => {
            if (activeFileId) handleStopFile(activeFileId);
          }}
          hasFile={!!activeFile}
          error={error}
          fileName={activeFile?.name ?? null}
          report={activeFile?.report ?? null}
          brokerSkipMap={brokerSkipMap}
          onBrokerSkipMapChange={setBrokerSkipMap}
          activeFileStatus={activeFile?.status}
        />
      </div>

      {/* 左側分界線 */}
      <Divider side="left" />

      {/* 中間面板 — 多 PdfViewer stacking（preload window 內的檔案同時掛載，CSS visibility 切換） */}
      <div className="flex-1 relative overflow-hidden">
        {files.filter((f) => mountedFileIds.has(f.id)).map((file) => {
          const isActive = file.id === activeFileId;
          const fileAnalyzingPages = analyzingPagesMap.get(file.id) ?? EMPTY_SET;
          const fileQueuedPages = queuedPagesMap.get(file.id) ?? EMPTY_SET;

          // per-file getGlobalColorOffset（用各檔案自己的 pageRegions 計算配色偏移）
          const fileGetGlobalColorOffset = (page: number): number => {
            let offset = 0;
            const sorted = Array.from(file.pageRegions.keys()).sort((a, b) => a - b);
            for (const p of sorted) {
              if (p >= page) break;
              offset += file.pageRegions.get(p)?.length ?? 0;
            }
            return offset;
          };

          return (
            <div
              key={file.id}
              style={{
                position: 'absolute',
                inset: 0,
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
                zIndex: isActive ? 1 : 0,
              }}
            >
              <PdfViewer
                pdfUrl={file.url}
                numPages={file.numPages}
                pageRegions={file.pageRegions}
                hoveredRegionId={isActive ? hoveredRegionId : null}
                onHover={setHoveredRegionId}
                onDocumentLoad={(pdf: pdfjs.PDFDocumentProxy) => handleDocumentLoadForFile(file.id, pdf)}
                onRegionUpdate={handleRegionUpdate}
                onRegionRemove={handleRegionRemove}
                onRegionAdd={handleRegionAdd}
                getGlobalColorOffset={fileGetGlobalColorOffset}
                scrollToRegionKey={isActive ? scrollTarget : null}
                onReanalyzePage={(pageNum: number) => handleReanalyzePage(pageNum, file.id)}
                analyzingPages={fileAnalyzingPages}
                queuedPages={fileQueuedPages}
                onCancelQueuedPage={(pageNum: number) => cancelQueuedPage(file.id, pageNum)}
                onRemoveAllRegions={handleRemoveAllRegions}
                onRegionDoubleClick={(page: number, regionId: number) => {
                  const region = file.pageRegions.get(page)?.find((r) => r.id === regionId);
                  if (region) {
                    handleRegionDoubleClick(page, region, file.id);
                  }
                }}
              />
            </div>
          );
        })}
      </div>

      {/* 右側分界線 */}
      <Divider side="right" />

      {/* 右側面板 — 提取文字 */}
      <div className="h-full flex-shrink-0" style={{ width: rightWidth }}>
        <TextPanel
          pageRegions={pageRegions}
          hoveredRegionId={hoveredRegionId}
          onHover={setHoveredRegionId}
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          onClickRegion={handleClickRegion}
          onRegionRemove={handleRegionRemove}
          onReorderRegions={handleReorderRegions}
        />
      </div>
    </div>
  );
}
