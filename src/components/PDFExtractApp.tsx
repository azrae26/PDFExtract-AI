/**
 * 功能：PDFExtract AI 主應用元件
 * 職責：管理全域狀態（多檔案佇列、PDF、hover 互動）、四欄可拖動分界線佈局，串接上傳→轉圖→送API→畫框→顯示文字的完整流程
 * 依賴：react-pdf (pdfjs)、useAnalysis hook、FileListPanel、PdfUploader、PdfViewer、TextPanel、API route /api/analyze
 *
 * 重要設計：
 * - files 陣列是唯一資料來源（Single Source of Truth），每個 FileEntry 擁有自己的 pageRegions
 * - pageRegions 從 activeFile.pageRegions 衍生（唯讀），所有寫入統一走 updateFileRegions / updateActiveFileRegions
 * - 多 PdfViewer 預掛載（preload window 內的檔案同時掛載，CSS visibility toggle 實現零延遲切換）
 * - 切檔 = 改 activeFileId → CSS visibility toggle，不需要 swap/sync/remount
 */

'use client';

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
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

/** 預設券商忽略末尾頁數映射（使用者可自行調整） */
const DEFAULT_BROKER_SKIP_MAP: Record<string, number> = {
  'Nomura': 4, 'Daiwa': 4, 'JPM': 4, 'HSBC': 4, 'GS': 4, 'MS': 4, 'Citi': 4,
  '凱基': 4, '國票': 4, '兆豐': 4, '統一': 4, '永豐': 4, '元大': 4, '中信': 4,
  '元富': 4, '群益': 4, '宏遠': 4, '康和': 4, '富邦': 4, '一銀': 4, '福邦': 4,
};

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

/** 券商英文縮寫 / 別名 → brokerSkipMap 中使用的中文名 */
const BROKER_ALIASES: Record<string, string> = {
  'KGI': '凱基',
};

/** 檢查字串是否像日期（7~8 位純數字，如 1150205 或 20250829） */
function looksLikeDate(s: string): boolean {
  return /^\d{7,8}$/.test(s);
}

/**
 * 從檔名解析券商名稱，支援多種格式：
 *   `_` 分隔：2454聯發科_1150205_台新.pdf / 20250318_KGI_資安產業.pdf
 *   `-` 分隔：統一-3217-優群-20250815.pdf / 合庫投顧-3363-上詮-20250526.pdf
 *   `|` 分隔：2313 華通 | 20260123 | 直邦.pdf
 *
 * 解析策略：
 *   Phase 1 — 用 knownBrokers + 別名在各段中精確/包含匹配（最可靠）
 *   Phase 2 — 位置啟發式 fallback（`-` 分隔取第一段，其餘取最後一段，須非日期/純數字/過長）
 */
function parseBrokerFromFilename(filename: string, knownBrokers: string[]): string | undefined {
  const nameWithoutExt = filename.replace(/\.pdf$/i, '');

  // === 偵測主分隔符並分段（優先 _ → | → -）===
  let segments: string[] = [];
  let separator: '_' | '|' | '-' | null = null;

  const underscoreParts = nameWithoutExt.split('_').map((s) => s.trim()).filter(Boolean);
  if (underscoreParts.length >= 3) {
    segments = underscoreParts;
    separator = '_';
  } else {
    const pipeParts = nameWithoutExt.split('|').map((s) => s.trim()).filter(Boolean);
    if (pipeParts.length >= 3) {
      segments = pipeParts;
      separator = '|';
    } else {
      const dashParts = nameWithoutExt.split('-').map((s) => s.trim()).filter(Boolean);
      if (dashParts.length >= 3) {
        segments = dashParts;
        separator = '-';
      }
    }
  }

  if (segments.length < 3 || !separator) return undefined;

  // === Phase 1：用 knownBrokers + 別名匹配 ===
  // 優先順序：最後一段 → 第一段 → 第二段 → 其餘中間段
  const checkOrder = [
    segments[segments.length - 1],
    segments[0],
    segments[1],
    ...segments.slice(2, -1),
  ];

  for (const seg of checkOrder) {
    // 別名精確匹配（如 KGI → 凱基）
    const alias = BROKER_ALIASES[seg];
    if (alias) return alias;

    // 精確匹配
    if (knownBrokers.includes(seg)) return seg;

    // 包含匹配（如「凱基投顧」包含「凱基」、「元大投顧」包含「元大」）
    for (const broker of knownBrokers) {
      if (seg.includes(broker)) return broker;
    }
  }

  // === Phase 2：位置啟發式 fallback ===
  if (separator === '-') {
    // `-` 分隔格式：券商通常在第一段（如「統一-3217-優群-20250815.pdf」）
    const first = segments[0].replace(/投顧$/, '').trim();
    if (first && !looksLikeDate(first) && !/^\d+$/.test(first) && first.length <= 10) {
      return first;
    }
  } else {
    // `_` 或 `|` 分隔格式：券商通常在最後一段
    const last = segments[segments.length - 1];
    if (last && !looksLikeDate(last) && !/^\d+$/.test(last) && last.length <= 10) {
      return last;
    }
  }

  return undefined;
}

/** 空 Map / Set 常數（避免每次 render 建立新物件導致不必要的 re-render） */
const EMPTY_MAP = new Map<number, Region[]>();
const EMPTY_SET = new Set<number>();

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
  const numPages = activeFile?.numPages ?? 0;

  // === pageRegions 從 activeFile 衍生（唯讀，Single Source of Truth） ===
  const pageRegions = useMemo(
    () => activeFile?.pageRegions ?? EMPTY_MAP,
    [activeFile?.pageRegions]
  );

  /** 更新指定檔案的 pageRegions（統一寫入 files 陣列） */
  const updateFileRegions = useCallback(
    (targetFileId: string, updater: (prev: Map<number, Region[]>) => Map<number, Region[]>) => {
      setFiles((prev) =>
        prev.map((f) => (f.id === targetFileId ? { ...f, pageRegions: updater(f.pageRegions) } : f))
      );
    },
    []
  );

  /** 更新指定檔案的券商名（report），並依券商特定忽略末尾頁數取消多餘排隊頁面 */
  const updateFileReport = useCallback(
    (targetFileId: string, report: string) => {
      setFiles((prev) =>
        prev.map((f) => (f.id === targetFileId ? { ...f, report } : f))
      );

      // 若券商有特定忽略末尾頁數，且比目前分析使用的全域預設值多，取消多餘排隊頁面
      // 注意：不修改全域 skipLastPages（那是使用者手動設的預設值，僅在無法辨識券商時使用）
      const brokerSkip = brokerSkipMapRef.current[report];
      if (brokerSkip !== undefined) {
        const file = filesRef.current.find((f) => f.id === targetFileId);
        if (file && file.numPages > 0) {
          const oldPages = Math.max(1, file.numPages - skipLastPagesRef.current);
          const newPages = Math.max(1, file.numPages - brokerSkip);
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(
            `[PDFExtractApp][${ts}] 🏢 Broker "${report}" detected (brokerSkip=${brokerSkip}, globalDefault=${skipLastPagesRef.current})`
          );

          // 若需分析更少頁面（brokerSkip > 全域預設值），取消多餘排隊頁面
          if (newPages < oldPages) {
            for (let p = newPages + 1; p <= oldPages; p++) {
              cancelQueuedPageRef.current(targetFileId, p);
            }
            console.log(
              `[PDFExtractApp][${ts}] ⏭️ Cancelled queued pages ${newPages + 1}–${oldPages} for file ${targetFileId}`
            );
          }
        }
      }
    },
    []
  );

  /** 更新活躍檔案的 pageRegions（便利函式） */
  const updateActiveFileRegions = useCallback(
    (updater: (prev: Map<number, Region[]>) => Map<number, Region[]>) => {
      const id = activeFileIdRef.current;
      if (!id) return;
      setFiles((prev) =>
        prev.map((f) => (f.id === id ? { ...f, pageRegions: updater(f.pageRegions) } : f))
      );
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
  const brokerSkipMapRef = useRef(brokerSkipMap);
  const skipLastPagesRef = useRef(skipLastPages);
  // cancelQueuedPage 來自 useAnalysis（在 updateFileReport 之後才可用），用 ref 橋接
  const cancelQueuedPageRef = useRef<(fid: string, p: number) => void>(() => {});
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

  // === PDF Document 預載快取（預載：目前 + 後4份；釋放：超過7份才驅逐，從上方檔案先釋放）===
  const pdfDocCacheRef = useRef<Map<string, pdfjs.PDFDocumentProxy>>(new Map());
  /** 追蹤由我們自行透過 pdfjs.getDocument() 載入的 doc fileId（可安全 destroy）。
   *  react-pdf 的 <Document> 內部建立的 doc 不在此 set 中，不可由我們 destroy。 */
  const selfLoadedDocIdsRef = useRef<Set<string>>(new Set());
  const PDF_PRELOAD_WINDOW = 5; // 預載視窗大小（目前 + 後 4 份）
  const PDF_CACHE_MAX = 7;      // 快取超過此數量才開始驅逐

  // === useAnalysis Hook ===
  const {
    isAnalyzing,
    analysisProgress,
    error,
    abortRef,
    analysisFileIdRef,
    stoppedByUserRef,
    analyzingPagesMap,
    queuedPagesMap,
    analyzeAllPages,
    handleStop,
    invalidateSession,
    handleReanalyze,
    handleReanalyzePage,
    handleRegionDoubleClick,
    cancelQueuedPage,
  } = useAnalysis({
    pdfDocRef,
    updateFileRegions,
    updateFileReport,
    prompt,
    tablePrompt,
    model,
    batchSize,
  });
  // 橋接 cancelQueuedPage 到 ref（供 updateFileReport 回呼使用）
  cancelQueuedPageRef.current = cancelQueuedPage;

  // === 跨檔案 worker pool 的 getNextFile callback ===
  // 從 files 中找下一個 queued 檔案，標記為 processing，回傳檔案資訊
  const getNextFileForPool = useCallback(async (): Promise<{ fileId: string; url: string; totalPages: number } | null> => {
    const latestFiles = filesRef.current;
    const nextQueued = latestFiles.find((f) => f.status === 'queued');
    if (!nextQueued) return null;

    // 標記為 processing
    setFiles((prev) =>
      prev.map((f) => (f.id === nextQueued.id ? { ...f, status: 'processing' as const } : f))
    );

    // 取得頁數
    let pages = nextQueued.numPages;
    // 優先從預載快取取得 numPages
    if (pages === 0) {
      const cachedDoc = pdfDocCacheRef.current.get(nextQueued.id);
      if (cachedDoc) {
        pages = cachedDoc.numPages;
        setFiles((prev) =>
          prev.map((f) => (f.id === nextQueued.id ? { ...f, numPages: pages } : f))
        );
      }
    }
    // 快取也沒有，則載入取得頁數
    if (pages === 0) {
      try {
        const tempDoc = await pdfjs.getDocument(nextQueued.url).promise;
        pages = tempDoc.numPages;
        // 存入快取（避免重複載入）
        pdfDocCacheRef.current.set(nextQueued.id, tempDoc);
        selfLoadedDocIdsRef.current.add(nextQueued.id); // 標記為自行載入（可安全 destroy）
        setFiles((prev) =>
          prev.map((f) => (f.id === nextQueued.id ? { ...f, numPages: pages } : f))
        );
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[PDFExtractApp][${ts}] 📄 Loaded page count for queued file: ${pages} pages`);
      } catch (e) {
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.error(`[PDFExtractApp][${ts}] ❌ Failed to load queued PDF:`, e);
        setFiles((prev) =>
          prev.map((f) => (f.id === nextQueued.id ? { ...f, status: 'error' as const } : f))
        );
        return null;
      }
    }

    // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
    const effectiveSkip = (nextQueued.report && brokerSkipMapRef.current[nextQueued.report] !== undefined)
      ? brokerSkipMapRef.current[nextQueued.report]
      : skipLastPages;
    const pagesToAnalyze = Math.max(1, pages - effectiveSkip);
    return { fileId: nextQueued.id, url: nextQueued.url, totalPages: pagesToAnalyze };
  }, [skipLastPages]);

  // === 跨檔案 worker pool 的 onFileComplete callback ===
  // 將完成的檔案標記為 done（或 error）
  const handlePoolFileComplete = useCallback((fileId: string, hasError?: boolean) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status: hasError ? 'error' as const : 'done' as const } : f))
    );
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] ${hasError ? '❌' : '✅'} File ${fileId} marked as ${hasError ? 'error' : 'done'}`);
  }, []);

  // === 切換檔案時：清理 pdfDocRef，條件性中斷 session ===
  // 不需要 swap/sync pageRegions，因為 pageRegions 直接從 files 衍生
  const prevActiveFileIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeFileId === prevActiveFileIdRef.current) return;

    // 只要有任何檔案正在分析，就不中斷 session（分析結果透過 updateFileRegions 直接寫入 files 陣列）
    const anyProcessing = filesRef.current.some((f) => f.status === 'processing');
    if (anyProcessing) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] 🔄 Switching files while analysis is running, keeping session alive`);
    } else {
      invalidateSession();
    }

    // 從快取立即設定 pdfDocRef（若有），讓分析操作可立即使用
    if (activeFileId && pdfDocCacheRef.current.has(activeFileId)) {
      pdfDocRef.current = pdfDocCacheRef.current.get(activeFileId)!;
    } else {
      pdfDocRef.current = null;
    }

    prevActiveFileIdRef.current = activeFileId;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileId]);

  // === PDF 滑動視窗預載：目前檔案 + 後 4 份 ===
  useEffect(() => {
    const cache = pdfDocCacheRef.current;
    const currentFiles = filesRef.current;
    const currentIdx = currentFiles.findIndex((f) => f.id === activeFileId);
    if (currentIdx === -1) return;

    // 計算視窗內的 fileIds（目前 + 後 PDF_PRELOAD_WINDOW-1 份）
    const windowFileIds = new Set<string>();
    for (let i = currentIdx; i < Math.min(currentIdx + PDF_PRELOAD_WINDOW, currentFiles.length); i++) {
      windowFileIds.add(currentFiles[i].id);
    }

    // 預載視窗內尚未快取的檔案
    windowFileIds.forEach((fid) => {
      if (cache.has(fid)) return;
      const fileEntry = currentFiles.find((f) => f.id === fid);
      if (!fileEntry) return;

      // 非同步預載（不阻塞 UI）
      pdfjs.getDocument(fileEntry.url).promise.then((doc) => {
        // 檢查此檔案是否還在 files 中（可能已被刪除）
        const stillExists = filesRef.current.some((f) => f.id === fid);
        if (!stillExists) {
          doc.destroy();
          return;
        }
        cache.set(fid, doc);
        selfLoadedDocIdsRef.current.add(fid); // 標記為自行載入（可安全 destroy）

        // 順便更新 numPages（若為 0）
        const entry = filesRef.current.find((f) => f.id === fid);
        if (entry && entry.numPages === 0) {
          setFiles((prev) =>
            prev.map((f) => (f.id === fid ? { ...f, numPages: doc.numPages } : f))
          );
        }

        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[PDFExtractApp][${ts}] 📦 Pre-loaded PDF: ${fileEntry.name} (${doc.numPages} pages)`);
      }).catch((e) => {
        console.warn(`[PDFExtractApp] ⚠️ Failed to pre-load PDF ${fid}:`, e);
      });
    });

    // 驅逐：超過 PDF_CACHE_MAX 才釋放，從目前檔案上方（index 更小的）先驅逐
    if (cache.size > PDF_CACHE_MAX) {
      // 收集所有快取中的 fileId，依在 files 陣列中的 index 排序
      const cachedIds = Array.from(cache.keys());
      const fileIdToIdx = new Map(currentFiles.map((f, i) => [f.id, i]));

      // 排出驅逐優先順序：目前檔案上方的 → index 由小到大（最遠的先驅逐）
      const aboveIds = cachedIds
        .filter((fid) => (fileIdToIdx.get(fid) ?? -1) < currentIdx)
        .sort((a, b) => (fileIdToIdx.get(a) ?? 0) - (fileIdToIdx.get(b) ?? 0));
      // 下方超出視窗的（距離目前越遠越先驅逐）
      const belowIds = cachedIds
        .filter((fid) => (fileIdToIdx.get(fid) ?? -1) > currentIdx + PDF_PRELOAD_WINDOW - 1)
        .sort((a, b) => (fileIdToIdx.get(b) ?? 0) - (fileIdToIdx.get(a) ?? 0));
      // 已不在 files 中的孤兒條目（最優先驅逐）
      const orphanIds = cachedIds.filter((fid) => !fileIdToIdx.has(fid));

      const evictOrder = [...orphanIds, ...aboveIds, ...belowIds];
      let toEvict = cache.size - PDF_CACHE_MAX;
      for (const fid of evictOrder) {
        if (toEvict <= 0) break;
        const doc = cache.get(fid);
        if (doc) {
          // 只 destroy 由我們自行載入的 doc；react-pdf 內部建立的 doc 由 react-pdf 自行管理生命週期
          if (selfLoadedDocIdsRef.current.has(fid)) {
            doc.destroy();
            selfLoadedDocIdsRef.current.delete(fid);
          }
          cache.delete(fid);
          toEvict--;
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileId, files.length]);

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
  // === 同步 refs（供 updateFileReport 回呼穩定存取最新值）===
  useEffect(() => { skipLastPagesRef.current = skipLastPages; }, [skipLastPages]);
  useEffect(() => { brokerSkipMapRef.current = brokerSkipMap; }, [brokerSkipMap]);
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
  // 不自動切換 activeFileId（使用者留在目前檢視的檔案），僅在無活躍檔案時才設定
  // 若 pdfDocCacheRef 已有該檔案的 doc（PdfViewer 預掛載已載入），直接呼叫 analyzeAllPages
  // 否則等 handleDocumentLoadForFile 觸發（防止雙重啟動由 analysisFileIdRef 守衛）
  const processNextInQueue = useCallback(() => {
    const latestFiles = filesRef.current;
    const nextQueued = latestFiles.find((f) => f.status === 'queued');
    if (!nextQueued) {
      processingQueueRef.current = false;
      return;
    }

    // 只在沒有活躍檔案時才自動切換（首次上傳 / 全部清空後），否則分析在背景進行
    if (!activeFileIdRef.current) {
      setActiveFileId(nextQueued.id);
    }
    setFiles((prev) =>
      prev.map((f) =>
        f.id === nextQueued.id ? { ...f, status: 'processing' as const } : f
      )
    );

    // 如果 PDF 已在預載快取中，直接啟動分析（不等 handleDocumentLoadForFile）
    const cachedDoc = pdfDocCacheRef.current.get(nextQueued.id);
    if (cachedDoc) {
      const pages = nextQueued.numPages || cachedDoc.numPages;
      // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
      const effectiveSkip2 = (nextQueued.report && brokerSkipMapRef.current[nextQueued.report] !== undefined)
        ? brokerSkipMapRef.current[nextQueued.report]
        : skipLastPages;
      const pagesToAnalyze = Math.max(1, pages - effectiveSkip2);
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] 🚀 PDF already cached, starting analysis directly for ${nextQueued.id}`);
      analyzeAllPages(pagesToAnalyze, prompt, model, batchSize, nextQueued.id, nextQueued.url, getNextFileForPool, handlePoolFileComplete);
    }
    // else: PdfViewer 尚未載入，等 handleDocumentLoadForFile 觸發
  }, [skipLastPages, prompt, model, batchSize, analyzeAllPages, getNextFileForPool, handlePoolFileComplete]);

  // === 檔案上傳（支援多檔）===
  const handleFilesUpload = useCallback(
    (newFiles: File[]) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${timestamp}] 📁 ${newFiles.length} file(s) uploaded`);

      const pdfFiles = newFiles.filter((f) => f.type === 'application/pdf');
      if (pdfFiles.length === 0) return;

      const knownBrokers = Object.keys(brokerSkipMapRef.current);
      const newEntries: FileEntry[] = pdfFiles.map((file) => {
        const broker = parseBrokerFromFilename(file.name, knownBrokers);
        if (broker) {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`[PDFExtractApp][${ts}] 🏢 Broker "${broker}" detected from filename: ${file.name}`);
        }
        return {
          id: generateFileId(),
          file,
          url: URL.createObjectURL(file),
          name: file.name,
          status: 'queued' as const,
          numPages: 0,
          pageRegions: new Map(),
          report: broker,
        };
      });

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

  // === PDF Document 載入完成（per-file scoped，由 react-pdf 觸發）===
  const handleDocumentLoadForFile = useCallback(
    (fileId: string, pdf: pdfjs.PDFDocumentProxy) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${timestamp}] 📄 PDF loaded (${fileId}): ${pdf.numPages} pages`);

      // 存入預載快取（若尚未快取）
      if (!pdfDocCacheRef.current.has(fileId)) {
        pdfDocCacheRef.current.set(fileId, pdf);
      }

      // 僅活躍檔案才設定 pdfDocRef（供 useAnalysis 使用）
      if (fileId === activeFileIdRef.current) {
        pdfDocRef.current = pdf;
      }

      // 更新檔案的 numPages
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, numPages: pdf.numPages } : f))
      );

      // 如果此檔案是 processing 狀態且尚未在分析中，自動開始分析
      // 重要：若 analysisFileIdRef.current 已等於此檔案 ID，表示分析正在進行，不要重啟
      const currentFile = filesRef.current.find((f) => f.id === fileId);
      if (currentFile?.status === 'processing' && analysisFileIdRef.current !== fileId) {
        // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
        const effectiveSkipDoc = (currentFile.report && brokerSkipMapRef.current[currentFile.report] !== undefined)
          ? brokerSkipMapRef.current[currentFile.report]
          : skipLastPages;
        const pagesToAnalyze = Math.max(1, pdf.numPages - effectiveSkipDoc);
        analyzeAllPages(pagesToAnalyze, prompt, model, batchSize, fileId, currentFile.url, getNextFileForPool, handlePoolFileComplete);
      }
    },
    [prompt, model, batchSize, skipLastPages, analyzeAllPages, getNextFileForPool, handlePoolFileComplete]
  );

  // === 分析完成後，標記殘餘 processing 檔案 + 處理 stopped 狀態 ===
  // 注意：跨檔案 pool 中，各檔案完成時已由 handlePoolFileComplete 即時標記為 done
  // 此 effect 僅處理 pool 整體結束後的收尾工作
  useEffect(() => {
    if (isAnalyzing) return;

    // 判斷是否由使用者主動停止
    const wasStopped = stoppedByUserRef.current;
    stoppedByUserRef.current = false;

    // 找到剛完成分析的主要檔案（可能不是目前活躍的檔案）
    const targetFileId = analysisFileIdRef.current;
    // 讀取完後立即清除 ref（避免重複觸發）
    analysisFileIdRef.current = null;

    // 決定目標狀態：使用者中斷 → stopped，正常完成 → done
    const finishedStatus = wasStopped ? ('stopped' as const) : ('done' as const);

    // 安全網：標記所有仍在 processing 的檔案（正常情況下 handlePoolFileComplete 已處理）
    const processingFiles = filesRef.current.filter((f) => f.status === 'processing');
    if (processingFiles.length > 0 || (targetFileId && filesRef.current.find((f) => f.id === targetFileId)?.status === 'processing')) {
      setFiles((prev) =>
        prev.map((f) => (f.status === 'processing' ? { ...f, status: finishedStatus } : f))
      );
    }

    // 使用者主動停止 → 將所有 queued 檔案標記為 idle，停止佇列處理
    if (wasStopped) {
      setFiles((prev) =>
        prev.map((f) => (f.status === 'queued' ? { ...f, status: 'idle' as const } : f))
      );
      processingQueueRef.current = false;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] 🛑 Queue stopped by user, queued files marked as idle`);
      return;
    }

    // Pool 結束，檢查是否有在 pool 運行期間新增的 queued 檔案
    if (targetFileId || processingFiles.length > 0) {
      const remainingQueued = filesRef.current.some((f) => f.status === 'queued');
      if (remainingQueued) {
        // 有新上傳的 queued 檔案，啟動新的 pool
        setTimeout(() => processNextInQueue(), 100);
      } else {
        processingQueueRef.current = false;
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAnalyzing]);

  // === 切換活躍檔案 ===
  const handleSelectFile = useCallback((fileId: string) => {
    setScrollTarget(null); // 清除前一個檔案的滾動目標，避免新檔案繼承舊的 scrollIntoView 位置
    setHoveredRegionId(null); // 清除 hover 狀態，避免切換後殘留高亮
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

    // 釋放 URL + 清理預載快取
    URL.revokeObjectURL(file.url);
    const cachedDoc = pdfDocCacheRef.current.get(fileId);
    if (cachedDoc) {
      // 只 destroy 由我們自行載入的 doc；react-pdf 的 doc 由其元件 unmount 時自行清理
      if (selfLoadedDocIdsRef.current.has(fileId)) {
        cachedDoc.destroy();
        selfLoadedDocIdsRef.current.delete(fileId);
      }
      pdfDocCacheRef.current.delete(fileId);
    }

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
        pdfDocRef.current = null;
      }
      setCurrentPage(1);
    }

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] 🗑️ Removed file: ${file.name}`);
  }, [activeFileId, invalidateSession]);

  // === 清空所有檔案 ===
  const handleClearAll = useCallback(() => {
    // 中斷進行中的分析
    invalidateSession();

    // 釋放所有 URL + 清理預載快取
    for (const file of filesRef.current) {
      URL.revokeObjectURL(file.url);
    }
    // 只 destroy 由我們自行載入的 doc；react-pdf 的 doc 由其元件 unmount 時自行清理
    pdfDocCacheRef.current.forEach((doc, fid) => {
      if (selfLoadedDocIdsRef.current.has(fid)) {
        doc.destroy();
      }
    });
    pdfDocCacheRef.current.clear();
    selfLoadedDocIdsRef.current.clear();

    setFiles([]);
    setActiveFileId(null);
    pdfDocRef.current = null;

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] 🗑️ Cleared all files`);
  }, [invalidateSession]);

  // === 更新單一區域的 bbox（拖動/resize 後）→ 標記 userModified + 自動重新提取文字 ===
  const handleRegionUpdate = useCallback(
    async (page: number, regionId: number, newBbox: [number, number, number, number]) => {
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
    [updateActiveFileRegions]
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
    [updateActiveFileRegions]
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


  // === 多 PdfViewer 預掛載：以活躍檔案為中心，前後展開最多 PDF_CACHE_MAX（7）個 ===
  // 檔案數 ≤ 7 時全部掛載，超過時以活躍檔案為中心的滑動視窗
  const mountedFileIds = useMemo(() => {
    const ids = new Set<string>();
    if (files.length <= PDF_CACHE_MAX) {
      // 檔案數量在上限內，全部掛載 → 任意方向切換零延遲
      for (const f of files) ids.add(f.id);
    } else {
      // 超過上限，以活躍檔案為中心前後展開
      const currentIdx = Math.max(0, files.findIndex((f) => f.id === activeFileId));
      const half = Math.floor(PDF_CACHE_MAX / 2);
      let start = Math.max(0, currentIdx - half);
      let end = start + PDF_CACHE_MAX;
      if (end > files.length) {
        end = files.length;
        start = Math.max(0, end - PDF_CACHE_MAX);
      }
      for (let i = start; i < end; i++) {
        ids.add(files[i].id);
      }
    }
    return ids;
  }, [files, activeFileId]);


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
          onClearAll={handleClearAll}
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
          numPages={numPages}
          onReanalyze={() => {
            if (!activeFileId || !activeFile) return;
            // 設為 processing 讓檔案列表顯示轉圈
            setFiles((prev) =>
              prev.map((f) => (f.id === activeFileId ? { ...f, status: 'processing' as const } : f))
            );
            // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
            const effectiveSkipRe = (activeFile.report && brokerSkipMap[activeFile.report] !== undefined)
              ? brokerSkipMap[activeFile.report]
              : skipLastPages;
            handleReanalyze(Math.max(1, numPages - effectiveSkipRe), activeFileId, activeFile.url);
          }}
          onStop={handleStop}
          hasFile={!!activeFile}
          error={error}
          fileName={analysisFileName}
          report={activeFile?.report ?? null}
          brokerSkipMap={brokerSkipMap}
          onBrokerSkipMapChange={setBrokerSkipMap}
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
 