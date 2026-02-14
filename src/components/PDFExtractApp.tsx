/**
 * 功能：PDFExtract AI 主應用元件
 * 職責：管理全域狀態（多檔案佇列、PDF、分析結果、hover 互動）、四欄可拖動分界線佈局，串接上傳→轉圖→送API→畫框→顯示文字的完整流程
 * 依賴：react-pdf (pdfjs)、useAnalysis hook、FileListPanel、PdfUploader、PdfViewer、TextPanel、API route /api/analyze
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { pdfjs } from 'react-pdf';
import PdfUploader from './PdfUploader';
import PdfViewer from './PdfViewer';
import TextPanel from './TextPanel';
import FileListPanel from './FileListPanel';
import { Region, FileEntry } from '@/lib/types';
import { DEFAULT_PROMPT, DEFAULT_TABLE_PROMPT } from '@/lib/constants';
import { DEFAULT_MODEL } from './PdfUploader';
import useAnalysis from '@/hooks/useAnalysis';

// === 預設批次並行數量 ===
const DEFAULT_BATCH_SIZE = 5;

// === 分界線拖動的最小/最大寬度限制 ===
const MIN_PANEL_WIDTH = 120;
const MAX_PANEL_WIDTH = Infinity;
const DEFAULT_FILE_LIST_WIDTH = 180;
const DEFAULT_LEFT_WIDTH = 420;
// 右側文字面板預設佔視窗 30%（在 useEffect 中計算）
const DEFAULT_RIGHT_RATIO = 0.3;

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

/** 產生唯一 ID */
let _fileIdCounter = 0;
function generateFileId(): string {
  return `file-${Date.now()}-${++_fileIdCounter}`;
}

// 設定 PDF.js worker（使用 CDN，避免 bundler 問題）
if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
}

export default function PDFExtractApp() {
  // === 多檔案狀態 ===
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  // 用 ref 追蹤最新的 files / activeFileId，避免 callback 內 closure stale
  const filesRef = useRef<FileEntry[]>([]);
  filesRef.current = files;
  const activeFileIdRef = useRef<string | null>(null);
  activeFileIdRef.current = activeFileId;
  // 標記是否正在自動處理佇列（避免重複觸發）
  const processingQueueRef = useRef(false);

  // === 目前活躍檔案的衍生狀態 ===
  const activeFile = files.find((f) => f.id === activeFileId) ?? null;
  const pdfUrl = activeFile?.url ?? null;
  const numPages = activeFile?.numPages ?? 0;

  // === 目前活躍檔案的 pageRegions（雙向同步） ===
  const [pageRegions, setPageRegions] = useState<Map<number, Region[]>>(new Map());

  /** 檔案級 regions 更新器：自動判斷寫入 shared state（活躍檔案）或 files 陣列（背景檔案） */
  const updateFileRegions = useCallback(
    (targetFileId: string, updater: (prev: Map<number, Region[]>) => Map<number, Region[]>) => {
      if (targetFileId === activeFileIdRef.current) {
        // 目標就是活躍檔案 → 更新 shared pageRegions state（UI 即時反映）
        setPageRegions(updater);
      } else {
        // 背景檔案 → 直接寫入 files 陣列
        setFiles((prev) =>
          prev.map((f) => (f.id === targetFileId ? { ...f, pageRegions: updater(f.pageRegions) } : f))
        );
      }
    },
    []
  );

  const [currentPage, setCurrentPage] = useState(1);
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
    return typeof cfg.skipLastPages === 'number' ? cfg.skipLastPages : 4;
  });
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  // === 四欄可拖動分界線 ===
  const [fileListWidth, setFileListWidth] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.fileListWidth === 'number' ? cfg.fileListWidth : DEFAULT_FILE_LIST_WIDTH;
  });
  const [leftWidth, setLeftWidth] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.leftWidth === 'number' ? cfg.leftWidth : DEFAULT_LEFT_WIDTH;
  });
  const [rightWidth, setRightWidth] = useState(() => {
    const cfg = loadConfig();
    if (typeof cfg.rightWidth === 'number') return cfg.rightWidth;
    if (typeof window !== 'undefined') {
      return Math.max(MIN_PANEL_WIDTH, Math.round(window.innerWidth * DEFAULT_RIGHT_RATIO));
    }
    return 400;
  });
  const isDraggingPanel = useRef<'fileList' | 'left' | 'right' | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);

  // === useAnalysis Hook ===
  const {
    isAnalyzing,
    analysisProgress,
    error,
    abortRef,
    analysisFileIdRef,
    analyzeAllPages,
    handleStop,
    invalidateSession,
    handleReanalyze,
    handleReanalyzePage,
    handleRegionDoubleClick,
  } = useAnalysis({
    pdfDocRef,
    pageRegions,
    setPageRegions,
    updateFileRegions,
    prompt,
    tablePrompt,
    model,
    batchSize,
  });

  // === 切換檔案時：儲存舊檔案 regions → 載入新檔案 regions ===
  // 若舊檔案正在分析中，不中斷 session（分析結果會透過 updateFileRegions 寫回正確檔案）
  const prevActiveFileIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeFileId === prevActiveFileIdRef.current) return;

    const prevId = prevActiveFileIdRef.current;
    const prevFile = prevId ? filesRef.current.find((f) => f.id === prevId) : null;
    const prevIsAnalyzing = prevFile?.status === 'processing';

    if (prevIsAnalyzing) {
      // 舊檔案正在分析中 → 不中斷 session，分析結果透過 updateFileRegions 直接寫入 files 陣列
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] 🔄 Switching away from analyzing file, analysis continues in background`);
    } else {
      // 舊檔案沒在分析 → 正常中斷 session
      invalidateSession();
    }

    // 儲存前一個檔案的 regions
    if (prevId) {
      setFiles((prev) =>
        prev.map((f) => (f.id === prevId ? { ...f, pageRegions: new Map(pageRegions) } : f))
      );
    }

    // 切換 pdfDocRef（新檔案會由 handleDocumentLoad 設定）
    pdfDocRef.current = null;

    // 載入新檔案的 regions
    const newFile = filesRef.current.find((f) => f.id === activeFileId);
    setPageRegions(newFile ? new Map(newFile.pageRegions) : new Map());

    prevActiveFileIdRef.current = activeFileId;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileId]);

  // 同步 pageRegions 回 files（當 regions 變化時）
  useEffect(() => {
    if (!activeFileId) return;
    setFiles((prev) =>
      prev.map((f) => (f.id === activeFileId ? { ...f, pageRegions: new Map(pageRegions) } : f))
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageRegions]);

  // === 自動儲存配置到 localStorage ===
  useEffect(() => { saveConfig({ prompt }); }, [prompt]);
  useEffect(() => { saveConfig({ tablePrompt }); }, [tablePrompt]);
  useEffect(() => { saveConfig({ model }); }, [model]);
  useEffect(() => { saveConfig({ batchSize }); }, [batchSize]);
  useEffect(() => { saveConfig({ skipLastPages }); }, [skipLastPages]);
  useEffect(() => { saveConfig({ fileListWidth }); }, [fileListWidth]);
  useEffect(() => { saveConfig({ leftWidth }); }, [leftWidth]);
  useEffect(() => { saveConfig({ rightWidth }); }, [rightWidth]);

  // === 分界線拖動事件處理 ===
  const handlePanelMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingPanel.current) return;
    const delta = e.clientX - dragStartX.current;

    if (isDraggingPanel.current === 'fileList') {
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartWidth.current + delta));
      setFileListWidth(newWidth);
    } else if (isDraggingPanel.current === 'left') {
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartWidth.current + delta));
      setLeftWidth(newWidth);
    } else {
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartWidth.current - delta));
      setRightWidth(newWidth);
    }
  }, []);

  const handlePanelMouseUp = useCallback(() => {
    isDraggingPanel.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', handlePanelMouseMove);
    document.removeEventListener('mouseup', handlePanelMouseUp);
  }, [handlePanelMouseMove]);

  const handleDividerMouseDown = useCallback(
    (side: 'fileList' | 'left' | 'right') => (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingPanel.current = side;
      dragStartX.current = e.clientX;
      dragStartWidth.current =
        side === 'fileList' ? fileListWidth :
        side === 'left' ? leftWidth : rightWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handlePanelMouseMove);
      document.addEventListener('mouseup', handlePanelMouseUp);
    },
    [fileListWidth, leftWidth, rightWidth, handlePanelMouseMove, handlePanelMouseUp]
  );

  // 清理：元件卸載時移除事件
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handlePanelMouseMove);
      document.removeEventListener('mouseup', handlePanelMouseUp);
    };
  }, [handlePanelMouseMove, handlePanelMouseUp]);

  // 清理所有檔案的 object URL
  useEffect(() => {
    return () => {
      filesRef.current.forEach((f) => URL.revokeObjectURL(f.url));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === 處理佇列中的下一個檔案 ===
  const processNextInQueue = useCallback(() => {
    setFiles((prev) => {
      const nextQueued = prev.find((f) => f.status === 'queued');
      if (!nextQueued) {
        processingQueueRef.current = false;
        return prev;
      }
      // 將下一個設為 processing 並切換為活躍檔案
      setActiveFileId(nextQueued.id);
      return prev.map((f) =>
        f.id === nextQueued.id ? { ...f, status: 'processing' as const } : f
      );
    });
  }, []);

  // === 檔案上傳（支援多檔）===
  const handleFilesUpload = useCallback(
    (newFiles: File[]) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${timestamp}] 📁 ${newFiles.length} file(s) uploaded`);

      const pdfFiles = newFiles.filter((f) => f.type === 'application/pdf');
      if (pdfFiles.length === 0) return;

      const newEntries: FileEntry[] = pdfFiles.map((file) => ({
        id: generateFileId(),
        file,
        url: URL.createObjectURL(file),
        name: file.name,
        status: 'queued' as const,
        numPages: 0,
        pageRegions: new Map(),
      }));

      setFiles((prev) => [...prev, ...newEntries]);

      // 如果目前沒在處理，啟動佇列
      if (!processingQueueRef.current) {
        processingQueueRef.current = true;
        setTimeout(() => processNextInQueue(), 0);
      }
    },
    [processNextInQueue]
  );

  // === 全頁面拖放 PDF（支援多檔案） ===
  const [isPageDragging, setIsPageDragging] = useState(false);
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
    }
  }, []);

  const handlePageDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handlePageDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsPageDragging(false);
      dragCounterRef.current = 0;

      const droppedFiles = Array.from(e.dataTransfer.files).filter(
        (f) => f.type === 'application/pdf'
      );
      if (droppedFiles.length > 0) {
        handleFilesUpload(droppedFiles);
      }
    },
    [handleFilesUpload]
  );

  // === PDF Document 載入完成（由 react-pdf 觸發）===
  const handleDocumentLoad = useCallback(
    (pdf: pdfjs.PDFDocumentProxy) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${timestamp}] 📄 PDF loaded: ${pdf.numPages} pages`);

      pdfDocRef.current = pdf;

      // 用 filesRef 讀取最新的 files（避免 closure stale）
      const currentFiles = filesRef.current;
      const currentActiveId = activeFileId;

      // 更新檔案的 numPages
      if (currentActiveId) {
        setFiles((prev) =>
          prev.map((f) => (f.id === currentActiveId ? { ...f, numPages: pdf.numPages } : f))
        );
      }

      setCurrentPage(1);

      // 如果此檔案是 processing 狀態，自動開始分析（扣除忽略的末尾頁數）
      const currentFile = currentFiles.find((f) => f.id === currentActiveId);
      if (currentFile?.status === 'processing' && currentActiveId) {
        const pagesToAnalyze = Math.max(1, pdf.numPages - skipLastPages);
        analyzeAllPages(pagesToAnalyze, prompt, model, batchSize, currentActiveId, currentFile.url);
      }
    },
    [activeFileId, prompt, model, batchSize, skipLastPages, analyzeAllPages]
  );

  // === 分析完成後，標記目標檔案為 done 並處理下一個 ===
  useEffect(() => {
    if (isAnalyzing) return;

    // 找到剛完成分析的檔案（可能不是目前活躍的檔案）
    const targetFileId = analysisFileIdRef.current;
    // 讀取完後立即清除 ref（避免重複觸發）
    analysisFileIdRef.current = null;

    // 也檢查所有 'processing' 的檔案（停止/中斷時 ref 可能已被清除）
    const processingFiles = filesRef.current.filter((f) => f.status === 'processing');

    // 標記目標檔案為 done
    if (targetFileId) {
      const targetFile = filesRef.current.find((f) => f.id === targetFileId);
      if (targetFile?.status === 'processing') {
        setFiles((prev) =>
          prev.map((f) => (f.id === targetFileId ? { ...f, status: 'done' as const } : f))
        );
      }
    }

    // 安全網：標記所有其他仍在 processing 的檔案為 done
    processingFiles.forEach((pf) => {
      if (pf.id !== targetFileId) {
        setFiles((prev) =>
          prev.map((f) => (f.id === pf.id ? { ...f, status: 'done' as const } : f))
        );
      }
    });

    // 處理佇列中的下一個 queued 檔案
    const hasProcessingOrTarget = targetFileId || processingFiles.length > 0;
    if (hasProcessingOrTarget) {
      setTimeout(() => {
        const latestFiles = filesRef.current;
        const nextQueued = latestFiles.find((f) => f.status === 'queued');
        if (nextQueued) {
          setFiles((prev) =>
            prev.map((f) => (f.id === nextQueued.id ? { ...f, status: 'processing' as const } : f))
          );
          // 如果已在該檔案，直接啟動分析（handleDocumentLoad 不會再觸發）
          if (nextQueued.id === activeFileIdRef.current && nextQueued.numPages > 0) {
            const pagesToAnalyze = Math.max(1, nextQueued.numPages - skipLastPages);
            analyzeAllPages(pagesToAnalyze, prompt, model, batchSize, nextQueued.id, nextQueued.url);
          } else {
            // 切到該檔案，handleDocumentLoad 會啟動分析
            setActiveFileId(nextQueued.id);
          }
        } else {
          processingQueueRef.current = false;
        }
      }, 100);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnalyzing]);

  // === 切換活躍檔案 ===
  const handleSelectFile = useCallback((fileId: string) => {
    setActiveFileId(fileId);
    setCurrentPage(1);
  }, []);

  // === 刪除檔案 ===
  const handleRemoveFile = useCallback((fileId: string) => {
    const file = filesRef.current.find((f) => f.id === fileId);
    if (!file) return;

    // 如果正在處理這個檔案，先中斷分析
    if (file.status === 'processing') {
      invalidateSession();
    }

    // 釋放 URL
    URL.revokeObjectURL(file.url);

    setFiles((prev) => prev.filter((f) => f.id !== fileId));

    // 如果刪的是目前顯示的檔案，切換到另一個
    if (fileId === activeFileId) {
      const remaining = filesRef.current.filter((f) => f.id !== fileId);
      if (remaining.length > 0) {
        // 優先切到下一個，否則切到最後一個
        const idx = filesRef.current.findIndex((f) => f.id === fileId);
        const nextFile = remaining[Math.min(idx, remaining.length - 1)];
        setActiveFileId(nextFile.id);
      } else {
        setActiveFileId(null);
        setPageRegions(new Map());
        pdfDocRef.current = null;
      }
      setCurrentPage(1);
    }

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] 🗑️ Removed file: ${file.name}`);
  }, [activeFileId, invalidateSession]);

  // === 更新單一區域的 bbox（拖動/resize 後）→ 標記 userModified + 自動重新提取文字 ===
  const handleRegionUpdate = useCallback(
    async (page: number, regionId: number, newBbox: [number, number, number, number]) => {
      const { extractTextForRegions } = await import('@/lib/pdfTextExtract');

      setPageRegions((prev) => {
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

        setPageRegions((prev) => {
          const updated = new Map(prev);
          const regions = updated.get(page);
          if (regions) {
            const updatedRegions = regions.map((r) =>
              r.id === regionId ? { ...r, text: extracted.text } : r
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
    []
  );

  // === 刪除單一 region ===
  const handleRegionRemove = useCallback((page: number, regionId: number) => {
    setPageRegions((prev) => {
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
  }, []);

  // === 新增 region（使用者在 PDF 上手動畫框）===
  const handleRegionAdd = useCallback(
    async (page: number, bbox: [number, number, number, number]) => {
      const { extractTextForRegions } = await import('@/lib/pdfTextExtract');

      const newId = (() => {
        const regions = pageRegions.get(page) || [];
        return regions.reduce((max, r) => Math.max(max, r.id), 0) + 1;
      })();

      const newRegion: Region = {
        id: newId,
        bbox,
        label: `手動框 ${newId}`,
        text: '',
        userModified: true,
      };

      setPageRegions((prev) => {
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
        setPageRegions((prev) => {
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
    [pageRegions]
  );

  // === 重新排序某頁的 regions ===
  const handleReorderRegions = useCallback((page: number, reorderedRegions: Region[]) => {
    setPageRegions((prev) => {
      const updated = new Map(prev);
      updated.set(page, reorderedRegions);
      return updated;
    });
  }, []);

  // === 點擊文字框 → 滾動 PDF 到對應框 ===
  const handleClickRegion = useCallback((regionKey: string) => {
    setScrollTarget(null);
    requestAnimationFrame(() => setScrollTarget(regionKey));
  }, []);

  // === 計算當前頁面之前所有頁面的 region 數量（用於跨頁顏色累計）===
  const getGlobalColorOffset = useCallback(
    (page: number): number => {
      let offset = 0;
      const sortedPages = Array.from(pageRegions.keys()).sort((a, b) => a - b);
      for (const p of sortedPages) {
        if (p >= page) break;
        offset += pageRegions.get(p)?.length ?? 0;
      }
      return offset;
    },
    [pageRegions]
  );

  // 分析中的檔案名（可能不是活躍檔案）
  const analysisFileName = (() => {
    if (!isAnalyzing) return activeFile?.name ?? null;
    const targetId = analysisFileIdRef.current;
    if (targetId) {
      const targetFile = files.find((f) => f.id === targetId);
      return targetFile?.name ?? null;
    }
    return activeFile?.name ?? null;
  })();

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
      {/* 全頁面拖放覆蓋層 */}
      {isPageDragging && (
        <div className="absolute inset-0 z-50 bg-blue-500/10 border-4 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-xl shadow-2xl px-8 py-5 flex items-center gap-3">
            <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <span className="text-lg font-medium text-blue-700">放開以上傳 PDF（可多檔）</span>
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
          isAnalyzing={isAnalyzing}
          progress={analysisProgress}
          onReanalyze={() => {
            if (!activeFileId || !activeFile) return;
            // 設為 processing 讓檔案列表顯示轉圈
            setFiles((prev) =>
              prev.map((f) => (f.id === activeFileId ? { ...f, status: 'processing' as const } : f))
            );
            handleReanalyze(Math.max(1, numPages - skipLastPages), activeFileId, activeFile.url);
          }}
          onStop={handleStop}
          hasFile={!!activeFile}
          error={error}
          fileName={analysisFileName}
        />
      </div>

      {/* 左側分界線 */}
      <Divider side="left" />

      {/* 中間面板 — PDF 顯示 + Bounding Boxes（連續頁面） */}
      <PdfViewer
        pdfUrl={pdfUrl}
        numPages={numPages}
        pageRegions={pageRegions}
        hoveredRegionId={hoveredRegionId}
        onHover={setHoveredRegionId}
        onDocumentLoad={handleDocumentLoad}
        onRegionUpdate={handleRegionUpdate}
        onRegionRemove={handleRegionRemove}
        onRegionAdd={handleRegionAdd}
        getGlobalColorOffset={getGlobalColorOffset}
        scrollToRegionKey={scrollTarget}
        onReanalyzePage={(pageNum: number) => handleReanalyzePage(pageNum, activeFileId ?? undefined)}
        onRegionDoubleClick={handleRegionDoubleClick}
      />

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
