/**
 * 功能：PDFExtract AI 主應用元件
 * 職責：管理 UI 配置狀態（prompt / model / 券商設定 / 面板寬度等）、Region CRUD、四欄佈局渲染、
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
import { DEFAULT_BROKER_ALIAS_GROUPS, DEFAULT_BROKER_SKIP_MAP } from '@/lib/brokerUtils';
import { DEFAULT_MODEL, isOpenRouterModel } from './PdfUploader';
import useFileManager from '@/hooks/useFileManager';
import usePanelResize from '@/hooks/usePanelResize';
import { extractTextForRegions } from '@/lib/pdfTextExtract';

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

/** DEVMODE 偵測：localhost 時設定變動自動上傳到伺服器（免密碼） */
const IS_DEV_MODE = typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

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
  // Gemini API 金鑰（持久化到 localStorage）
  const [apiKey, setApiKey] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.apiKey === 'string' ? cfg.apiKey : '';
  });
  // OpenRouter API 金鑰（持久化到 localStorage）
  const [openRouterApiKey, setOpenRouterApiKey] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.openRouterApiKey === 'string' ? cfg.openRouterApiKey : '';
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
  // 券商映射群組（例：凱基, 凱基(法說memo), 凱基(一般報告), KGI）
  const [brokerAliasGroups, setBrokerAliasGroups] = useState<string[]>(() => {
    const cfg = loadConfig();
    if (Array.isArray(cfg.brokerAliasGroups)) {
      return (cfg.brokerAliasGroups as unknown[])
        .filter((v): v is string => typeof v === 'string')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [...DEFAULT_BROKER_ALIAS_GROUPS];
  });

  /** DEVMODE: 初始設定載入完成後才啟用自動上傳，避免載入設定時觸發上傳 */
  const devAutoUploadReadyRef = useRef(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  /** Hover PdfViewer 的 BoundingBox → 讓 TextPanel 滾動到對應文字框 */
  const [scrollToTextKey, setScrollToTextKey] = useState<string | null>(null);
  /** 切換顯示校正前/校正後 bbox（全域，跨檔案共享） */
  const [showOriginalBbox, setShowOriginalBbox] = useState(false);

  // === 匯出報告狀態 ===
  const [exportSingleState, setExportSingleState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [exportSingleError, setExportSingleError] = useState('');
  const [exportAllState, setExportAllState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [exportAllResult, setExportAllResult] = useState<{ success: number; failed: number; errors: string[] } | null>(null);

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
    selectFileMetadata, addFileMetadataCandidate, removeFileMetadataCandidate, clearFileMetadataCandidates,
    mountedFileIds,
  } = useFileManager({
    prompt, tablePrompt, model, batchSize, skipLastPages, brokerSkipMap, brokerAliasGroups, apiKey, openRouterApiKey,
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
  useEffect(() => { saveConfig({ brokerAliasGroups }); }, [brokerAliasGroups]);
  useEffect(() => { saveConfig({ apiKey }); }, [apiKey]);
  useEffect(() => { saveConfig({ openRouterApiKey }); }, [openRouterApiKey]);
  useEffect(() => { saveConfig({ fileListWidth }); }, [fileListWidth]);
  useEffect(() => { saveConfig({ leftWidth }); }, [leftWidth]);
  useEffect(() => { saveConfig({ rightWidth }); }, [rightWidth]);

  // 切換活躍檔案時重置單篇匯出狀態，避免舊的成功/失敗狀態誤導
  useEffect(() => {
    setExportSingleState('idle');
    setExportSingleError('');
  }, [activeFileId]);

  // === 啟動時從伺服器載入共享設定（覆蓋本地 localStorage） ===
  useEffect(() => {
    fetch('/api/settings')
      .then((res) => res.json())
      .then((json) => {
        if (!json.success || !json.data) return;
        const d = json.data;
        if (typeof d.prompt === 'string') setPrompt(d.prompt);
        if (typeof d.tablePrompt === 'string') setTablePrompt(d.tablePrompt);
        if (typeof d.model === 'string') setModel(d.model);
        if (typeof d.batchSize === 'number') setBatchSize(d.batchSize);
        if (typeof d.skipLastPages === 'number') setSkipLastPages(d.skipLastPages);
        if (typeof d.brokerSkipMap === 'object' && d.brokerSkipMap !== null) {
          setBrokerSkipMap(d.brokerSkipMap);
        }
        if (Array.isArray(d.brokerAliasGroups)) {
          setBrokerAliasGroups(
            (d.brokerAliasGroups as unknown[])
              .filter((v): v is string => typeof v === 'string')
              .map((s) => s.trim())
              .filter(Boolean)
          );
        }
        if (typeof d.fileListWidth === 'number') setFileListWidth(d.fileListWidth);
        if (typeof d.leftWidth === 'number') setLeftWidth(d.leftWidth);
        if (typeof d.rightWidth === 'number') setRightWidth(d.rightWidth);
      })
      .catch(() => { /* 網路錯誤靜默失敗，繼續使用本地設定 */ })
      .finally(() => {
        // 延遲啟用 DEVMODE 自動上傳，確保初始設定的 state 更新已套用完畢
        setTimeout(() => { devAutoUploadReadyRef.current = true; }, 1000);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // === 上傳設定到伺服器 ===
  const handleUploadSettings = useCallback(async () => {
    const password = window.prompt('請輸入上傳密碼');
    if (!password) return;

    const settings = {
      prompt, tablePrompt, model, batchSize, skipLastPages, brokerSkipMap,
      brokerAliasGroups,
      fileListWidth, leftWidth, rightWidth,
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, settings }),
      });
      const json = await res.json();
      if (json.success) {
        alert('設定已上傳到伺服器！');
      } else {
        alert(`上傳失敗：${json.error || '未知錯誤'}`);
      }
    } catch {
      alert('上傳失敗：無法連線到伺服器');
    }
  }, [prompt, tablePrompt, model, batchSize, skipLastPages, brokerSkipMap, brokerAliasGroups, fileListWidth, leftWidth, rightWidth]);

  // === DEVMODE: 任何設定改動後 5 秒自動上傳到伺服器（免密碼） ===
  useEffect(() => {
    if (!IS_DEV_MODE || !devAutoUploadReadyRef.current) return;

    const timer = setTimeout(async () => {
      const settings = {
        prompt, tablePrompt, model, batchSize, skipLastPages, brokerSkipMap,
        brokerAliasGroups,
        fileListWidth, leftWidth, rightWidth,
      };
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings }),
        });
        const json = await res.json();
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        if (json.success) {
          console.log(`[PDFExtractApp][${ts}] ✅ DEVMODE auto-saved settings to server`);
        } else {
          console.warn(`[PDFExtractApp][${ts}] ⚠️ DEVMODE auto-save failed: ${json.error}`);
        }
      } catch { /* 靜默失敗 */ }
    }, 5000);

    return () => clearTimeout(timer);
  }, [prompt, tablePrompt, model, batchSize, skipLastPages, brokerSkipMap, brokerAliasGroups, fileListWidth, leftWidth, rightWidth]);

  // === 切換活躍檔案 ===
  const handleSelectFile = useCallback((fileId: string) => {
    setScrollTarget(null); // 清除前一個檔案的滾動目標，避免新檔案繼承舊的 scrollIntoView 位置
    setHoveredRegionId(null); // 清除 hover 狀態，避免切換後殘留高亮
    setActiveFileId(fileId);
    setCurrentPage(1);
  }, [setActiveFileId]);

  // === E / D 全域快捷鍵：上一個 / 下一個檔案（輸入狀態時不觸發）===
  useEffect(() => {
    const handleFileSwitchKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName?.toUpperCase();
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el?.isContentEditable ?? false);
      if (isInput) return;
      if (e.key !== 'e' && e.key !== 'E' && e.key !== 'd' && e.key !== 'D') return;

      const currentFiles = filesRef.current;
      if (currentFiles.length === 0) return;
      const currentIdx = currentFiles.findIndex((f) => f.id === activeFileIdRef.current);
      if (currentIdx < 0) return;

      let nextIdx: number;
      if (e.key === 'e' || e.key === 'E') {
        nextIdx = Math.max(0, currentIdx - 1);
      } else {
        nextIdx = Math.min(currentFiles.length - 1, currentIdx + 1);
      }
      if (nextIdx === currentIdx) return;

      e.preventDefault();
      handleSelectFile(currentFiles[nextIdx].id);
    };
    document.addEventListener('keydown', handleFileSwitchKeyDown);
    return () => document.removeEventListener('keydown', handleFileSwitchKeyDown);
  }, [handleSelectFile]);

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
              r.id === regionId && !r.text?.startsWith('⏳') ? { ...r, text: extracted.text, _debug: extracted._debug } : r
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

      // 右欄自動滾動到新出現的文字框
      setScrollToTextKey(`${page}-${newId}`);

      try {
        if (!pdfDocRef.current) return;
        const pdfPage = await pdfDocRef.current.getPage(page);
        const [extracted] = await extractTextForRegions(pdfPage, [newRegion]);
        updateActiveFileRegions((prev) => {
          const updated = new Map(prev);
          const regions = updated.get(page);
          if (regions) {
            updated.set(page, regions.map((r) =>
              r.id === newId ? { ...r, text: extracted.text, _debug: extracted._debug } : r
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

  // === 使用者手動編輯 region 文字 ===
  const handleRegionTextChange = useCallback((page: number, regionId: number, newText: string) => {
    updateActiveFileRegions((prev) => {
      const updated = new Map(prev);
      const regions = updated.get(page);
      if (regions) {
        updated.set(page, regions.map((r) =>
          r.id === regionId ? { ...r, text: newText, userModified: true } : r
        ));
      }
      return updated;
    });
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] ✏️ Region ${regionId} text edited on page ${page}`);
  }, [updateActiveFileRegions]);

  // === 匯出報告：組合提取文字內容 ===
  const buildExportContent = (pageRegionsMap: Map<number, Region[]>): string => {
    const lines: string[] = [];
    for (const [, regions] of Array.from(pageRegionsMap.entries()).sort(([a], [b]) => a - b)) {
      for (const r of regions) {
        if (r.text?.trim()) {
          lines.push(r.text);
          lines.push('');
        }
      }
    }
    return lines.join('\n').trim();
  };

  // === 匯出報告：呼叫代理 API（含前端必填驗證）===
  const callExportAPI = async (file: { selectedCode?: string; selectedBroker?: string; selectedDate?: string; pageRegions: Map<number, Region[]>; name: string }) => {
    if (!file.selectedCode || !file.selectedBroker || !file.selectedDate) {
      throw new Error('請先確認股票代號、券商名、日期');
    }
    const content = buildExportContent(file.pageRegions);
    // API 要求 YYYY-MM-DD 格式，UI 可能存為 YYYY/MM/DD，統一轉換
    const dateForApi = file.selectedDate.replace(/\//g, '-');
    const res = await fetch('/api/export-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'company',
        name: file.selectedCode,
        provider: file.selectedBroker,
        date: dateForApi,
        content,
        info: content,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      const msg = Array.isArray(data?.error?.message)
        ? data.error.message[0]
        : data?.error?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  };

  // === 匯出單篇報告（當前活躍檔案）===
  const handleExportSingle = useCallback(async () => {
    if (!activeFile) return;
    setExportSingleState('loading');
    setExportSingleError('');
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    try {
      await callExportAPI(activeFile);
      setExportSingleState('success');
      console.log(`[PDFExtractApp][${ts}] ✅ 匯出成功: ${activeFile.name}`);
      setTimeout(() => setExportSingleState('idle'), 1500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '未知錯誤';
      setExportSingleState('error');
      setExportSingleError(msg);
      console.error(`[PDFExtractApp][${ts}] ❌ 匯出失敗: ${activeFile.name} — ${msg}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFile]);

  // === 匯出全部報告（依序處理有內容的檔案）===
  const handleExportAll = useCallback(async () => {
    const targets = files.filter((f) => f.pageRegions.size > 0);
    if (targets.length === 0) return;
    setExportAllState('loading');
    setExportAllResult(null);
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    let success = 0;
    const errors: string[] = [];
    for (const file of targets) {
      try {
        await callExportAPI(file);
        success++;
        console.log(`[PDFExtractApp][${ts}] ✅ 匯出全部 - 成功: ${file.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '未知錯誤';
        errors.push(`${file.name}: ${msg}`);
        console.error(`[PDFExtractApp][${ts}] ❌ 匯出全部 - 失敗: ${file.name} — ${msg}`);
      }
    }
    setExportAllState('done');
    setExportAllResult({ success, failed: errors.length, errors });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  // === 點擊文字框 → 滾動 PDF 到對應框 ===
  const handleClickRegion = useCallback((regionKey: string) => {
    setScrollTarget(null);
    requestAnimationFrame(() => setScrollTarget(regionKey));
  }, []);

  // === Hover PdfViewer 的 BoundingBox → 滾動 TextPanel 到對應文字框 ===
  const handleBboxClick = useCallback((regionKey: string) => {
    setScrollToTextKey(regionKey);
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
        // 依目前選擇的模型判斷有效金鑰是否已設定
        const hasKey = isOpenRouterModel(model) ? !!openRouterApiKey : !!apiKey;
        // 無金鑰 → 強制 idle（不觸發分析）
        if (!hasKey) {
          handleFilesUpload(droppedFiles, 'idle');
        } else {
          // 左=當前頁並跑, 中=背景跑, 右=僅加入列表
          const mode = zone === 'left' ? 'active' : zone === 'right' ? 'idle' : 'background';
          handleFilesUpload(droppedFiles, mode);
        }
      }
    },
    [handleFilesUpload, dragZone, apiKey, openRouterApiKey, model]
  );

  // === 全域分析 toggle handler（FileListPanel 用）===
  const handleToggleAnalysis = useCallback(() => {
    const hasKey = isOpenRouterModel(model) ? !!openRouterApiKey : !!apiKey;
    if (!hasKey && !isAnalyzing) return; // 無金鑰時不允許啟動分析
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
  }, [isAnalyzing, apiKey, openRouterApiKey, model, handleStop, setFiles, filesRef, triggerQueueProcessing]);

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

  const activeBroker = activeFile?.selectedBroker || activeFile?.report || '';
  const activeRawReport = activeFile?.report || '';
  const effectiveSkipForActive =
    (activeRawReport && brokerSkipMap[activeRawReport] !== undefined) ? brokerSkipMap[activeRawReport]
    : (activeBroker && brokerSkipMap[activeBroker] !== undefined) ? brokerSkipMap[activeBroker]
    : skipLastPages;

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
          brokerSkipMap={brokerSkipMap}
          skipLastPages={skipLastPages}
          onExportAll={handleExportAll}
          exportAllState={exportAllState}
          exportAllResult={exportAllResult}
          onExportAllReset={() => { setExportAllState('idle'); setExportAllResult(null); }}
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
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          openRouterApiKey={openRouterApiKey}
          onOpenRouterApiKeyChange={setOpenRouterApiKey}
          isAnalyzing={activeFile?.status === 'processing'}
          progress={{ current: activeFile?.pageRegions?.size ?? 0, total: Math.max(1, numPages - effectiveSkipForActive) }}
          numPages={numPages}
          onReanalyze={() => {
            const hasKey = isOpenRouterModel(model) ? !!openRouterApiKey : !!apiKey;
            if (!activeFileId || !activeFile || !hasKey) return;
            // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
            handleReanalyzeFile(Math.max(1, numPages - effectiveSkipForActive), activeFileId, activeFile.url);
          }}
          onStop={() => {
            if (activeFileId) handleStopFile(activeFileId);
          }}
          hasFile={!!activeFile}
          error={error}
          fileName={activeFile?.name ?? null}
          report={activeFile?.report || activeBroker || null}
          dateCandidates={activeFile?.dateCandidates ?? []}
          codeCandidates={activeFile?.codeCandidates ?? []}
          brokerCandidates={activeFile?.brokerCandidates ?? []}
          selectedDate={activeFile?.selectedDate ?? ''}
          selectedCode={activeFile?.selectedCode ?? ''}
          selectedBroker={activeBroker}
          onSelectMetadata={(field, value) => {
            if (!activeFileId) return;
            selectFileMetadata(activeFileId, field, value);
          }}
          onAddMetadataCandidate={(field, value) => {
            if (!activeFileId) return;
            addFileMetadataCandidate(activeFileId, field, value);
          }}
          onRemoveMetadataCandidate={(field, value) => {
            if (!activeFileId) return;
            removeFileMetadataCandidate(activeFileId, field, value);
          }}
          onClearMetadataCandidates={(field) => {
            if (!activeFileId) return;
            clearFileMetadataCandidates(activeFileId, field);
          }}
          brokerSkipMap={brokerSkipMap}
          onBrokerSkipMapChange={setBrokerSkipMap}
          brokerAliasGroups={brokerAliasGroups}
          onBrokerAliasGroupsChange={setBrokerAliasGroups}
          activeFileStatus={activeFile?.status}
          onUploadSettings={handleUploadSettings}
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
                onReanalyzePage={(pageNum: number) => {
                  const hasKey = isOpenRouterModel(model) ? !!openRouterApiKey : !!apiKey;
                  if (hasKey) handleReanalyzePage(pageNum, file.id);
                }}
                analyzingPages={fileAnalyzingPages}
                queuedPages={fileQueuedPages}
                onCancelQueuedPage={(pageNum: number) => cancelQueuedPage(file.id, pageNum)}
                onRemoveAllRegions={handleRemoveAllRegions}
                showOriginalBbox={showOriginalBbox}
                onToggleOriginalBbox={() => setShowOriginalBbox(prev => !prev)}
                onBboxClick={handleBboxClick}
                onRegionDoubleClick={(page: number, regionId: number) => {
                  const hasKey = isOpenRouterModel(model) ? !!openRouterApiKey : !!apiKey;
                  if (!hasKey) return;
                  const region = file.pageRegions.get(page)?.find((r) => r.id === regionId);
                  if (region) {
                    handleRegionDoubleClick(page, region, file.id);
                  }
                }}
                fileName={file.name}
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
          onRegionTextChange={handleRegionTextChange}
          scrollToRegionKey={scrollToTextKey}
          onExportReport={handleExportSingle}
          exportState={exportSingleState}
          exportError={exportSingleError}
        />
      </div>
    </div>
  );
}
