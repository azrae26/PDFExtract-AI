/**
 * 功能：多檔案生命週期管理 Custom Hook
 * 職責：管理 files[] 狀態（唯一資料來源）、PDF 預載快取、分析佇列協調、檔案上傳（三模式：背景跑/當前頁並跑/僅加入列表）/刪除/清空、
 *       整合 useAnalysis hook、PDF Document 載入回呼、分析完成收尾、mountedFileIds 衍生計算、券商映射正規化、
 *       per-file 停止（handleStopFile）、重新分析排隊制（handleReanalyzeFile + priorityFileIdRef）
 * 依賴：react、react-pdf (pdfjs)、useAnalysis hook、brokerUtils、persistence (IndexedDB)
 *
 * 重要設計：
 * - files 陣列是唯一資料來源（Single Source of Truth），每個 FileEntry 擁有自己的 pageRegions
 * - 所有寫入統一走 updateFileRegions / updateActiveFileRegions → setFiles
 * - 多 PdfViewer 預掛載由 mountedFileIds 控制（以活躍檔案為中心的滑動視窗）
 * - PDF 預載快取：目前 + 後 4 份共 5 份，快取上限 7 份，超過才驅逐
 * - 跨檔案 worker pool：getNextFileForPool / handlePoolFileComplete 串接 useAnalysis
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { pdfjs } from 'react-pdf';
import { Region, FileEntry, MetadataCandidate } from '@/lib/types';
import { FileProgressUpdater } from '@/hooks/analysisHelpers';
import { buildBrokerAliasMap, normalizeBrokerByAlias, parseMetadataFromFilename } from '@/lib/brokerUtils';
import useAnalysis from '@/hooks/useAnalysis';
import { saveSession, loadSession, savePdfBlob, deletePdfBlob, clearAll as clearAllPersistence } from '@/lib/persistence';

// === PDF 預載 / 快取常數 ===
const PDF_PRELOAD_WINDOW = 5; // 預載視窗大小（目前 + 後 4 份）
const PDF_CACHE_MAX = 7;      // 快取超過此數量才開始驅逐

/** 空 Map 常數（避免每次 render 建立新物件導致不必要的 re-render） */
const EMPTY_MAP = new Map<number, Region[]>();

/** 產生唯一 ID */
let _fileIdCounter = 0;
function generateFileId(): string {
  return `file-${Date.now()}-${++_fileIdCounter}`;
}

type MetadataField = 'date' | 'code' | 'broker';

function normalizeMetaValue(value: string): string {
  return value.trim();
}

function appendMetaCandidate(
  prev: MetadataCandidate[] | undefined,
  rawValue: string | undefined,
  source: MetadataCandidate['source'],
): MetadataCandidate[] {
  const value = normalizeMetaValue(rawValue || '');
  const base = prev ?? [];
  if (!value) return base;
  const existed = base.some((c) => normalizeMetaValue(c.value).toLowerCase() === value.toLowerCase());
  if (existed) return base;
  return [...base, { value, source }];
}

function removeMetaCandidate(
  prev: MetadataCandidate[] | undefined,
  rawValue: string,
): MetadataCandidate[] {
  const value = normalizeMetaValue(rawValue).toLowerCase();
  return (prev ?? []).filter((c) => normalizeMetaValue(c.value).toLowerCase() !== value);
}

function getFieldKeys(field: MetadataField): {
  candidates: 'dateCandidates' | 'codeCandidates' | 'brokerCandidates';
  selected: 'selectedDate' | 'selectedCode' | 'selectedBroker';
} {
  if (field === 'date') return { candidates: 'dateCandidates', selected: 'selectedDate' };
  if (field === 'code') return { candidates: 'codeCandidates', selected: 'selectedCode' };
  return { candidates: 'brokerCandidates', selected: 'selectedBroker' };
}

/** 查找券商忽略末尾頁數：優先用原始名稱（如「凱基(一般報告)」），找不到才用已映射名稱 */
function lookupBrokerSkip(
  entry: FileEntry | null | undefined,
  skipMap: Record<string, number>,
): number | undefined {
  if (!entry) return undefined;
  if (entry.report && skipMap[entry.report] !== undefined) return skipMap[entry.report];
  if (entry.selectedBroker && skipMap[entry.selectedBroker] !== undefined) return skipMap[entry.selectedBroker];
  return undefined;
}

// === Hook 輸入介面 ===
interface UseFileManagerOptions {
  prompt: string;
  tablePrompt: string;
  model: string;
  batchSize: number;
  skipLastPages: number;
  brokerSkipMap: Record<string, number>;
  brokerAliasGroups: string[];
  /** Gemini API 金鑰（前端使用者輸入） */
  apiKey: string;
}

// === Hook 輸出介面 ===
export interface FileManagerResult {
  // Core state
  files: FileEntry[];
  setFiles: React.Dispatch<React.SetStateAction<FileEntry[]>>;
  activeFileId: string | null;
  setActiveFileId: React.Dispatch<React.SetStateAction<string | null>>;
  activeFile: FileEntry | null;
  numPages: number;
  pageRegions: Map<number, Region[]>;

  // Refs（供 region CRUD 使用）
  filesRef: React.MutableRefObject<FileEntry[]>;
  activeFileIdRef: React.MutableRefObject<string | null>;
  pdfDocRef: React.MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  updateActiveFileRegions: (updater: (prev: Map<number, Region[]>) => Map<number, Region[]>) => void;

  // File operations
  /** mode: 'background'=背景跑(預設), 'active'=設為當前頁並跑, 'idle'=僅加入列表不跑 */
  handleFilesUpload: (newFiles: File[], mode?: 'background' | 'active' | 'idle') => void;
  handleRemoveFile: (fileId: string) => void;
  handleClearAll: () => void;
  handleDocumentLoadForFile: (fileId: string, pdf: pdfjs.PDFDocumentProxy) => void;

  // Analysis（轉發自 useAnalysis）
  isAnalyzing: boolean;
  analysisProgress: { current: number; total: number };
  error: string | null;
  handleStop: () => void;
  handleReanalyze: (numPages: number, targetFileId: string, fileUrl: string) => void;
  handleReanalyzePage: (pageNum: number, fileId: string) => void;
  handleRegionDoubleClick: (page: number, region: Region, fileId: string) => void;
  analyzingPagesMap: Map<string, Set<number>>;
  queuedPagesMap: Map<string, Set<number>>;
  cancelQueuedPage: (fileId: string, pageNum: number) => void;
  analysisFileIdRef: React.MutableRefObject<string | null>;
  /** 停止單一檔案的分析（per-file 停止，不影響全域 pool） */
  handleStopFile: (fileId: string) => void;
  /** 重新分析指定檔案（pool 跑中→插隊；pool 沒跑→直接啟動） */
  handleReanalyzeFile: (numPages: number, targetFileId: string, fileUrl: string) => void;
  /** 觸發佇列處理（將 queued 檔案開始分析） */
  triggerQueueProcessing: () => void;
  /** 設定指定欄位為已確認值（不刪除其他候選值） */
  selectFileMetadata: (fileId: string, field: MetadataField, value: string) => void;
  /** 新增指定欄位候選值（手動輸入） */
  addFileMetadataCandidate: (fileId: string, field: MetadataField, value: string) => void;
  /** 刪除指定欄位候選值 */
  removeFileMetadataCandidate: (fileId: string, field: MetadataField, value: string) => void;
  /** 清空指定欄位所有候選值 */
  clearFileMetadataCandidates: (fileId: string, field: MetadataField) => void;

  // Derived
  mountedFileIds: Set<string>;
}

export default function useFileManager({
  prompt,
  tablePrompt,
  model,
  batchSize,
  skipLastPages,
  brokerSkipMap,
  brokerAliasGroups,
  apiKey,
}: UseFileManagerOptions): FileManagerResult {
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

  // === IndexedDB 持久化 ===
  /** 標記 IndexedDB 恢復是否已完成（防止初始 files=[] 覆蓋已存的資料） */
  const initializedRef = useRef(false);
  /** debounce 自動存檔的 timer */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // === 券商相關 refs ===
  const brokerSkipMapRef = useRef(brokerSkipMap);
  const brokerAliasMapRef = useRef<Record<string, string>>(buildBrokerAliasMap(brokerAliasGroups));
  const skipLastPagesRef = useRef(skipLastPages);
  useEffect(() => {
    brokerAliasMapRef.current = buildBrokerAliasMap(brokerAliasGroups);
  }, [brokerAliasGroups]);

  const normalizeBrokerName = useCallback((raw: string | undefined): string => {
    return normalizeBrokerByAlias(raw, brokerAliasMapRef.current)?.trim() || '';
  }, []);

  // cancelQueuedPage 來自 useAnalysis（在 updateFileReport 之後才可用），用 ref 橋接
  const cancelQueuedPageRef = useRef<(fid: string, p: number) => void>(() => {});
  // 防止同一檔案重複恢復被省略頁面（多頁回傳同一券商名時只執行一次）
  const brokerPagesRestoredRef = useRef<Set<string>>(new Set());

  /** 更新指定檔案的券商名（report），並依券商特定忽略末尾頁數調整排隊頁面
   *  - brokerSkip > initialSkip → 取消多餘排隊頁面
   *  - brokerSkip < initialSkip → 恢復被省略的頁面（插隊到佇列正確位置）
   */
  const updateFileReport = useCallback(
    (targetFileId: string, report: string) => {
      const rawReport = report.trim();
      const canonicalReport = normalizeBrokerName(rawReport);
      if (!canonicalReport) return;
      setFiles((prev) =>
        prev.map((f) => (
          f.id === targetFileId
            ? { ...f, report: rawReport, selectedBroker: f.selectedBroker || canonicalReport }
            : f
        ))
      );

      // 若券商有特定忽略末尾頁數，比較與分析啟動時實際使用的 skip 值
      // 注意：不修改全域 skipLastPages（那是使用者手動設的預設值，僅在無法辨識券商時使用）
      // 優先用原始名稱查找（如「凱基(一般報告)」），找不到才用映射名稱（如「凱基」）
      const brokerSkip = brokerSkipMapRef.current[rawReport] ?? brokerSkipMapRef.current[canonicalReport];
      if (brokerSkip !== undefined) {
        const file = filesRef.current.find((f) => f.id === targetFileId);
        if (file && file.numPages > 0) {
          // 使用分析啟動時實際的 effectiveSkip（而非全域預設值），正確處理「檔名誤判券商」的情況
          const usedSkip = initialSkipRef.current.get(targetFileId) ?? skipLastPagesRef.current;
          const oldPages = Math.max(1, file.numPages - usedSkip);
          const newPages = Math.max(1, file.numPages - brokerSkip);
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(
            `[useFileManager][${ts}] 🏢 Broker "${report}" detected (brokerSkip=${brokerSkip}, initialSkip=${usedSkip}, globalDefault=${skipLastPagesRef.current})`
          );

          // 若需分析更少頁面（brokerSkip > initialSkip），取消多餘排隊頁面
          if (newPages < oldPages) {
            for (let p = newPages + 1; p <= oldPages; p++) {
              cancelQueuedPageRef.current(targetFileId, p);
            }
            console.log(
              `[useFileManager][${ts}] ⏭️ Cancelled queued pages ${newPages + 1}–${oldPages} for file ${targetFileId}`
            );
          }

          // 若需分析更多頁面（brokerSkip < initialSkip），恢復被省略的頁面到佇列
          if (newPages > oldPages && !brokerPagesRestoredRef.current.has(targetFileId)) {
            brokerPagesRestoredRef.current.add(targetFileId);
            const pagesToAdd: number[] = [];
            for (let p = oldPages + 1; p <= newPages; p++) {
              pagesToAdd.push(p);
            }
            if (addPagesToQueueRef.current) {
              addPagesToQueueRef.current(targetFileId, pagesToAdd);
              console.log(
                `[useFileManager][${ts}] ➕ Restored pages ${oldPages + 1}–${newPages} to queue for file ${targetFileId}`
              );
            } else {
              console.warn(
                `[useFileManager][${ts}] ⚠️ Cannot restore pages ${oldPages + 1}–${newPages}: worker pool already finished`
              );
            }
            // 更新 initialSkipRef 為新的 brokerSkip（避免後續重複計算差異）
            initialSkipRef.current.set(targetFileId, brokerSkip);
          }
        }
      }
    },
    [normalizeBrokerName]
  );

  /** 追加指定檔案的 metadata 候選值（date/code/broker） */
  const updateFileMetadata = useCallback(
    (
      targetFileId: string,
      patch: { date?: string; code?: string; broker?: string; source: MetadataCandidate['source'] },
    ) => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== targetFileId) return f;

          const nextDateCandidates = patch.date
            ? appendMetaCandidate(f.dateCandidates, patch.date, patch.source)
            : f.dateCandidates;
          const nextCodeCandidates = patch.code
            ? appendMetaCandidate(f.codeCandidates, patch.code, patch.source)
            : f.codeCandidates;
          const nextBrokerCandidates = patch.broker
            ? appendMetaCandidate(f.brokerCandidates, normalizeBrokerName(patch.broker), patch.source)
            : f.brokerCandidates;

          return {
            ...f,
            dateCandidates: nextDateCandidates,
            codeCandidates: nextCodeCandidates,
            brokerCandidates: nextBrokerCandidates,
            selectedDate: f.selectedDate || normalizeMetaValue(patch.date || ''),
            selectedCode: f.selectedCode || normalizeMetaValue(patch.code || ''),
            selectedBroker: f.selectedBroker || normalizeBrokerName(patch.broker),
            report: patch.broker ? (patch.broker.trim() || f.report) : f.report,
          };
        })
      );
    },
    [normalizeBrokerName]
  );

  /** 設定指定欄位為已確認值（僅切換選中狀態，不刪除其他候選值） */
  const selectFileMetadata = useCallback((fileId: string, field: MetadataField, value: string) => {
    const normalized = normalizeMetaValue(value);
    if (!normalized) return;
    const keys = getFieldKeys(field);
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId) return f;
        return {
          ...f,
          [keys.selected]: field === 'broker' ? normalizeBrokerName(normalized) : normalized,
          ...(field === 'broker' ? { report: normalizeBrokerName(normalized) } : {}),
        };
      })
    );
  }, [normalizeBrokerName]);

  /** 新增指定欄位候選值（手動輸入） */
  const addFileMetadataCandidate = useCallback((fileId: string, field: MetadataField, value: string) => {
    const normalized = normalizeMetaValue(value);
    if (!normalized) return;
    const keys = getFieldKeys(field);
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId) return f;
        const nextCandidates = appendMetaCandidate(
          (f as FileEntry)[keys.candidates] as MetadataCandidate[] | undefined,
          field === 'broker' ? normalizeBrokerName(normalized) : normalized,
          'manual',
        );
        const nextValue = field === 'broker' ? normalizeBrokerName(normalized) : normalized;
        return {
          ...f,
          [keys.candidates]: nextCandidates,
          [keys.selected]: nextValue,
          ...(field === 'broker' ? { report: nextValue } : {}),
        };
      })
    );
  }, [normalizeBrokerName]);

  /** 刪除指定欄位候選值 */
  const removeFileMetadataCandidate = useCallback((fileId: string, field: MetadataField, value: string) => {
    const keys = getFieldKeys(field);
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId) return f;
        const nextCandidates = removeMetaCandidate(
          (f as FileEntry)[keys.candidates] as MetadataCandidate[] | undefined,
          value,
        );
        const currentSelected = (f as FileEntry)[keys.selected] as string | undefined;
        const removedSelected = currentSelected
          && normalizeMetaValue(currentSelected).toLowerCase() === normalizeMetaValue(value).toLowerCase();
        const fallbackSelected = nextCandidates[0]?.value || '';
        const nextSelected = removedSelected ? fallbackSelected : (currentSelected || fallbackSelected);
        return {
          ...f,
          [keys.candidates]: nextCandidates,
          [keys.selected]: nextSelected,
          ...(field === 'broker' ? { report: nextSelected || f.report } : {}),
        };
      })
    );
  }, []);

  /** 清空指定欄位所有候選值 */
  const clearFileMetadataCandidates = useCallback((fileId: string, field: MetadataField) => {
    const keys = getFieldKeys(field);
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId) return f;
        return {
          ...f,
          [keys.candidates]: [],
          [keys.selected]: '',
          ...(field === 'broker' ? { report: '' } : {}),
        };
      })
    );
  }, []);

  /** 更新指定檔案的 per-file 分析進度（analysisPages / completedPages） */
  const updateFileProgress: FileProgressUpdater = useCallback(
    (targetFileId, update) => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== targetFileId) return f;
          let ap = update.analysisPages !== undefined ? update.analysisPages : f.analysisPages;
          let cp = update.completedPages !== undefined ? update.completedPages : f.completedPages;
          if (update.analysisDelta) ap += update.analysisDelta;
          if (update.completedDelta) cp += update.completedDelta;
          const newStatus = update.status ?? f.status;
          return { ...f, analysisPages: ap, completedPages: cp, status: newStatus };
        })
      );
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

  // === PDF Document refs ===
  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);

  // === PDF Document 預載快取（預載：目前 + 後4份；釋放：超過7份才驅逐，從上方檔案先釋放）===
  const pdfDocCacheRef = useRef<Map<string, pdfjs.PDFDocumentProxy>>(new Map());
  /** 追蹤由我們自行透過 pdfjs.getDocument() 載入的 doc fileId（可安全 destroy）。
   *  react-pdf 的 <Document> 內部建立的 doc 不在此 set 中，不可由我們 destroy。 */
  const selfLoadedDocIdsRef = useRef<Set<string>>(new Set());

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
    stopSingleFile,
    cancelQueuedPage,
    initialSkipRef,
    addPagesToQueueRef,
  } = useAnalysis({
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
  });
  // 橋接 cancelQueuedPage 到 ref（供 updateFileReport 回呼使用）
  cancelQueuedPageRef.current = cancelQueuedPage;

  // === 同步 refs（供 updateFileReport 回呼穩定存取最新值）===
  useEffect(() => { skipLastPagesRef.current = skipLastPages; }, [skipLastPages]);
  useEffect(() => { brokerSkipMapRef.current = brokerSkipMap; }, [brokerSkipMap]);

  // === 跨檔案 worker pool 的 getNextFile callback ===
  // 從 files 中找下一個 queued 檔案，標記為 processing，回傳檔案資訊
  // 優先檢查 priorityFileIdRef（重新分析插隊）
  const getNextFileForPool = useCallback(async (): Promise<{ fileId: string; url: string; totalPages: number; effectiveSkip?: number; alreadyCompletedPages?: Set<number> } | null> => {
    const latestFiles = filesRef.current;

    // 優先拉取 priority 檔案
    let nextQueued: FileEntry | undefined;
    const priorityId = priorityFileIdRef.current;
    if (priorityId) {
      const priorityFile = latestFiles.find((f) => f.id === priorityId && f.status === 'queued');
      if (priorityFile) {
        nextQueued = priorityFile;
        priorityFileIdRef.current = null; // 消費掉 priority
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useFileManager][${ts}] ⚡ Priority file ${priorityId} pulled from queue`);
      } else {
        priorityFileIdRef.current = null; // priority 檔案不在 queued 狀態，清除
      }
    }
    if (!nextQueued) {
      nextQueued = latestFiles.find((f) => f.status === 'queued');
    }
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
        console.log(`[useFileManager][${ts}] 📄 Loaded page count for queued file: ${pages} pages`);
      } catch (e) {
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.error(`[useFileManager][${ts}] ❌ Failed to load queued PDF:`, e);
        setFiles((prev) =>
          prev.map((f) => (f.id === nextQueued.id ? { ...f, status: 'error' as const } : f))
        );
        return null;
      }
    }

    // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
    const effectiveSkip = lookupBrokerSkip(nextQueued, brokerSkipMapRef.current) ?? skipLastPages;
    const pagesToAnalyze = Math.max(1, pages - effectiveSkip);

    // 收集已完成的頁面（pageRegions 中有 entry 的頁碼，包含空陣列＝AI 判斷無區域）
    const alreadyCompletedPages = new Set<number>();
    nextQueued.pageRegions.forEach((_regions, pageNum) => {
      if (pageNum >= 1 && pageNum <= pagesToAnalyze) {
        alreadyCompletedPages.add(pageNum);
      }
    });

    return {
      fileId: nextQueued.id, url: nextQueued.url, totalPages: pagesToAnalyze, effectiveSkip,
      alreadyCompletedPages: alreadyCompletedPages.size > 0 ? alreadyCompletedPages : undefined,
    };
  }, [skipLastPages]);

  // === 跨檔案 worker pool 的 onFileComplete callback ===
  // 將完成的檔案標記為 done（或 error）
  // 守衛：若檔案已是 stopped 狀態（per-file 停止），不覆蓋為 done
  const handlePoolFileComplete = useCallback((fileId: string, hasError?: boolean) => {
    setFiles((prev) =>
      prev.map((f) => {
        if (f.id !== fileId) return f;
        // 守衛：per-file 停止後不覆蓋
        if (f.status === 'stopped') return f;
        return { ...f, status: hasError ? 'error' as const : 'done' as const };
      })
    );
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useFileManager][${ts}] ${hasError ? '❌' : '✅'} File ${fileId} marked as ${hasError ? 'error' : 'done'}`);
  }, []);

  // === 優先排隊的檔案 ID（重新分析時插隊）===
  const priorityFileIdRef = useRef<string | null>(null);

  // === 停止單一檔案的分析（per-file 停止，不影響全域 pool）===
  const handleStopFile = useCallback((fileId: string) => {
    const file = filesRef.current.find((f) => f.id === fileId);
    if (!file) return;

    if (file.status === 'queued') {
      // queued 狀態直接標記為 stopped
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, status: 'stopped' as const } : f))
      );
    } else if (file.status === 'processing') {
      // processing 狀態：先呼叫 stopSingleFile 跳過剩餘頁面，再標記為 stopped
      stopSingleFile(fileId);
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, status: 'stopped' as const } : f))
      );
    }

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useFileManager][${ts}] ⏹️ File ${fileId} stopped by user (per-file)`);
  }, [stopSingleFile]);

  // === 重新分析活躍檔案（支援排隊制：pool 跑中→插隊；pool 沒跑→直接啟動）===
  const handleReanalyzeFile = useCallback(
    (numPagesToAnalyze: number, targetFileId: string, fileUrl: string) => {
      if (numPagesToAnalyze <= 0 || !fileUrl) return;

      // 清除該檔案的 pageRegions / completedPages / analysisPages
      updateFileRegions(targetFileId, () => new Map());
      updateFileProgress(targetFileId, { analysisPages: 0, completedPages: 0 });

      if (isAnalyzing) {
        // Pool 正在跑 → 如果此檔案正在 processing，先 per-file stop
        const file = filesRef.current.find((f) => f.id === targetFileId);
        if (file?.status === 'processing') {
          stopSingleFile(targetFileId);
        }
        // 設為 queued + 設 priorityFileIdRef 讓 getNextFileForPool 優先拉取
        setFiles((prev) =>
          prev.map((f) => (f.id === targetFileId ? { ...f, status: 'queued' as const, analysisPages: 0, completedPages: 0 } : f))
        );
        priorityFileIdRef.current = targetFileId;
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useFileManager][${ts}] 🔄 File ${targetFileId} queued with priority for re-analysis`);
      } else {
        // Pool 沒在跑 → 直接啟動（同原有行為）
        setFiles((prev) =>
          prev.map((f) => (f.id === targetFileId ? { ...f, status: 'processing' as const, analysisPages: 0, completedPages: 0 } : f))
        );
        analyzeAllPages(numPagesToAnalyze, prompt, model, tablePrompt, batchSize, targetFileId, fileUrl, getNextFileForPool, handlePoolFileComplete, undefined, undefined, apiKey);
      }
    },
    [isAnalyzing, prompt, model, tablePrompt, batchSize, apiKey, analyzeAllPages, updateFileRegions, updateFileProgress, stopSingleFile, getNextFileForPool, handlePoolFileComplete]
  );

  // === 切換檔案時：清理 pdfDocRef，條件性中斷 session ===
  // 不需要 swap/sync pageRegions，因為 pageRegions 直接從 files 衍生
  const prevActiveFileIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeFileId === prevActiveFileIdRef.current) return;

    // 只要有任何分析操作正在進行，就不中斷 session（分析結果透過 updateFileRegions 直接寫入 files 陣列）
    // anyProcessing：批次分析中（file status = processing）
    // isAnalyzing：單頁重跑 或 雙擊識別 也會設 true，但不改 file status，需額外檢查
    const anyProcessing = filesRef.current.some((f) => f.status === 'processing');
    if (anyProcessing || isAnalyzing) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useFileManager][${ts}] 🔄 Switching files while analysis is running, keeping session alive`);
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
        console.log(`[useFileManager][${ts}] 📦 Pre-loaded PDF: ${fileEntry.name} (${doc.numPages} pages)`);
      }).catch((e) => {
        console.warn(`[useFileManager] ⚠️ Failed to pre-load PDF ${fid}:`, e);
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

  // 清理所有檔案的 object URL
  useEffect(() => {
    return () => {
      filesRef.current.forEach((f) => URL.revokeObjectURL(f.url));
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === 從 IndexedDB 恢復 session（mount-only）===
  useEffect(() => {
    loadSession().then((restored) => {
      if (restored && restored.files.length > 0) {
        setFiles(restored.files);
        setActiveFileId(restored.activeFileId);
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useFileManager][${ts}] ✅ Restored ${restored.files.length} file(s) from IndexedDB`);
      }
      initializedRef.current = true;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // === 自動存檔到 IndexedDB（debounced 2s）===
  useEffect(() => {
    if (!initializedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveSession(activeFileId, files);
    }, 2000);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [files, activeFileId]);

  // === beforeunload：頁面卸載前 flush pending save ===
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        saveSession(activeFileIdRef.current, filesRef.current);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  // === 處理佇列中的下一個檔案 ===
  // 不自動切換 activeFileId（使用者留在目前檢視的檔案），僅在無活躍檔案時才設定
  // 若 pdfDocCacheRef 已有該檔案的 doc（PdfViewer 預掛載已載入），直接呼叫 analyzeAllPages
  // 否則等 handleDocumentLoadForFile 觸發（防止雙重啟動由 analysisFileIdRef 守衛）
  const processNextInQueue = useCallback(() => {
    // 無 API 金鑰時不啟動分析
    if (!apiKey) {
      processingQueueRef.current = false;
      return;
    }
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

    // 收集已完成的頁面（pageRegions 中有 entry 的頁碼，包含空陣列＝AI 判斷無區域）
    const buildCompletedPages = (file: FileEntry, pagesToAnalyze: number): Set<number> | undefined => {
      const completed = new Set<number>();
      file.pageRegions.forEach((_regions, pageNum) => {
        if (pageNum >= 1 && pageNum <= pagesToAnalyze) {
          completed.add(pageNum);
        }
      });
      return completed.size > 0 ? completed : undefined;
    };

    // 如果 PDF 已在預載快取中，直接啟動分析（不等 handleDocumentLoadForFile）
    const cachedDoc = pdfDocCacheRef.current.get(nextQueued.id);
    if (cachedDoc) {
      const pages = nextQueued.numPages || cachedDoc.numPages;
      // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
      const effectiveSkip2 = lookupBrokerSkip(nextQueued, brokerSkipMapRef.current) ?? skipLastPages;
      const pagesToAnalyze = Math.max(1, pages - effectiveSkip2);
      const completedPages = buildCompletedPages(nextQueued, pagesToAnalyze);
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useFileManager][${ts}] 🚀 PDF already cached, starting analysis directly for ${nextQueued.id} (${completedPages?.size || 0} pages already done)`);
      analyzeAllPages(pagesToAnalyze, prompt, model, tablePrompt, batchSize, nextQueued.id, nextQueued.url, getNextFileForPool, handlePoolFileComplete, effectiveSkip2, completedPages, apiKey);
    } else {
      // PDF 不在快取中（檔案可能不在預載視窗內，PdfViewer 未掛載）→ 主動載入 PDF 後啟動分析
      const queuedFileId = nextQueued.id;
      const queuedFileUrl = nextQueued.url;
      const queuedFileSkip = lookupBrokerSkip(nextQueued, brokerSkipMapRef.current);
      const queuedFileNumPages = nextQueued.numPages;
      const queuedFilePageRegions = nextQueued.pageRegions;
      pdfjs.getDocument(queuedFileUrl).promise.then((doc) => {
        // 存入快取
        if (!pdfDocCacheRef.current.has(queuedFileId)) {
          pdfDocCacheRef.current.set(queuedFileId, doc);
          selfLoadedDocIdsRef.current.add(queuedFileId);
        }
        // 更新 numPages
        const pages = queuedFileNumPages || doc.numPages;
        if (queuedFileNumPages === 0) {
          setFiles((prev) =>
            prev.map((f) => (f.id === queuedFileId ? { ...f, numPages: doc.numPages } : f))
          );
        }
        // 計算有效忽略頁數 + 已完成頁面
        const effectiveSkipAsync = queuedFileSkip ?? skipLastPages;
        const pagesToAnalyze = Math.max(1, pages - effectiveSkipAsync);
        const completedPagesAsync = new Set<number>();
        queuedFilePageRegions.forEach((_regions, pageNum) => {
          if (pageNum >= 1 && pageNum <= pagesToAnalyze) {
            completedPagesAsync.add(pageNum);
          }
        });
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[useFileManager][${ts2}] 🚀 PDF loaded on-demand, starting analysis for ${queuedFileId} (${completedPagesAsync.size} pages already done)`);
        analyzeAllPages(pagesToAnalyze, prompt, model, tablePrompt, batchSize, queuedFileId, queuedFileUrl, getNextFileForPool, handlePoolFileComplete, effectiveSkipAsync, completedPagesAsync.size > 0 ? completedPagesAsync : undefined, apiKey);
      }).catch((e) => {
        const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.error(`[useFileManager][${ts2}] ❌ Failed to load PDF on-demand for ${queuedFileId}:`, e);
        setFiles((prev) =>
          prev.map((f) => (f.id === queuedFileId ? { ...f, status: 'error' as const } : f))
        );
        processingQueueRef.current = false;
      });
    }
  }, [skipLastPages, prompt, model, tablePrompt, batchSize, apiKey, analyzeAllPages, getNextFileForPool, handlePoolFileComplete]);

  // === 觸發佇列處理（供外部呼叫，如「繼續分析」「全部重新分析」後啟動佇列）===
  const triggerQueueProcessing = useCallback(() => {
    if (!processingQueueRef.current) {
      processingQueueRef.current = true;
      setTimeout(() => processNextInQueue(), 0);
    }
  }, [processNextInQueue]);

  // === 檔案上傳（支援多檔，支援三種模式）===
  // mode: 'background'=背景跑(預設), 'active'=設為當前頁並跑, 'idle'=僅加入列表不跑
  const handleFilesUpload = useCallback(
    (newFiles: File[], mode: 'background' | 'active' | 'idle' = 'background') => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      const modeLabel = mode === 'background' ? '背景跑' : mode === 'active' ? '當前頁並跑' : '僅加入列表';
      console.log(`[useFileManager][${timestamp}] 📁 ${newFiles.length} file(s) uploaded (mode: ${modeLabel})`);

      const pdfFiles = newFiles.filter((f) => f.type === 'application/pdf');
      if (pdfFiles.length === 0) return;

      const fileStatus = mode === 'idle' ? ('idle' as const) : ('queued' as const);

      const knownBrokers = Object.keys(brokerSkipMapRef.current);
      const newEntries: FileEntry[] = pdfFiles.map((file) => {
        const parsed = parseMetadataFromFilename(file.name, knownBrokers, brokerAliasMapRef.current);
        const rawBroker = parsed.broker || '';
        const canonicalBroker = normalizeBrokerName(rawBroker) || '';
        if (canonicalBroker) {
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`[useFileManager][${ts}] 🏢 Broker "${canonicalBroker}" detected from filename: ${file.name}${rawBroker !== canonicalBroker ? ` (raw: "${rawBroker}")` : ''}`);
        }
        return {
          id: generateFileId(),
          file,
          url: URL.createObjectURL(file),
          name: file.name,
          status: fileStatus,
          numPages: 0,
          pageRegions: new Map(),
          analysisPages: 0,
          completedPages: 0,
          dateCandidates: parsed.date ? [{ value: parsed.date, source: 'filename' }] : [],
          codeCandidates: parsed.code ? [{ value: parsed.code, source: 'filename' }] : [],
          brokerCandidates: canonicalBroker ? [{ value: canonicalBroker, source: 'filename' }] : [],
          selectedDate: parsed.date || '',
          selectedCode: parsed.code || '',
          selectedBroker: canonicalBroker,
          report: rawBroker,
        };
      });

      setFiles((prev) => [...prev, ...newEntries]);

      // 儲存 PDF binary 到 IndexedDB，完成後立即存檔 session（確保 F5 不遺失）
      Promise.all(
        newEntries.map((entry) => entry.file.arrayBuffer().then((buf) => savePdfBlob(entry.id, buf)))
      ).then(() => {
        // setTimeout(0) 確保 React state 已更新（filesRef.current 已包含新檔案）
        setTimeout(() => {
          if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
          saveSession(activeFileIdRef.current, filesRef.current);
        }, 0);
      });

      // active 模式：立即切換到第一個新檔案
      if (mode === 'active' && newEntries.length > 0) {
        setActiveFileId(newEntries[0].id);
      }

      // 立即為所有新檔案非同步載入頁數（只讀 PDF header，不渲染，輕量）
      // 確保「總頁數」統計從一開始就準確
      for (const entry of newEntries) {
        if (pdfDocCacheRef.current.has(entry.id)) continue; // 已快取的跳過
        pdfjs.getDocument(entry.url).promise.then((doc) => {
          // 確認檔案仍存在
          if (!filesRef.current.some((f) => f.id === entry.id)) {
            doc.destroy();
            return;
          }
          // 更新 numPages
          setFiles((prev) =>
            prev.map((f) => (f.id === entry.id && f.numPages === 0 ? { ...f, numPages: doc.numPages } : f))
          );
          // 存入快取（供後續分析直接使用，避免重複載入）
          if (!pdfDocCacheRef.current.has(entry.id)) {
            pdfDocCacheRef.current.set(entry.id, doc);
            selfLoadedDocIdsRef.current.add(entry.id);
          } else {
            doc.destroy();
          }
        }).catch((e) => {
          console.warn(`[useFileManager] ⚠️ Failed to pre-load page count for ${entry.name}:`, e);
        });
      }

      // idle 模式不啟動佇列處理
      if (mode === 'idle') return;

      // 如果目前沒在處理，啟動佇列
      if (!processingQueueRef.current) {
        processingQueueRef.current = true;
        setTimeout(() => processNextInQueue(), 0);
      }
    },
    [normalizeBrokerName, processNextInQueue]
  );

  // === PDF Document 載入完成（per-file scoped，由 react-pdf 觸發）===
  const handleDocumentLoadForFile = useCallback(
    (fileId: string, pdf: pdfjs.PDFDocumentProxy) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useFileManager][${timestamp}] 📄 PDF loaded (${fileId}): ${pdf.numPages} pages`);

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
      // 重要：無 API 金鑰時不啟動分析
      const currentFile = filesRef.current.find((f) => f.id === fileId);
      if (apiKey && currentFile?.status === 'processing' && analysisFileIdRef.current !== fileId) {
        // 若檔案已有券商名且在 brokerSkipMap 中有設定，優先使用券商特定值
        const effectiveSkipDoc = lookupBrokerSkip(currentFile, brokerSkipMapRef.current) ?? skipLastPages;
        const pagesToAnalyze = Math.max(1, pdf.numPages - effectiveSkipDoc);
        // 收集已完成的頁面（繼續分析時跳過）
        const completedPages = new Set<number>();
        currentFile.pageRegions.forEach((_regions, pageNum) => {
          if (pageNum >= 1 && pageNum <= pagesToAnalyze) {
            completedPages.add(pageNum);
          }
        });
        analyzeAllPages(pagesToAnalyze, prompt, model, tablePrompt, batchSize, fileId, currentFile.url, getNextFileForPool, handlePoolFileComplete, effectiveSkipDoc, completedPages.size > 0 ? completedPages : undefined, apiKey);
      }
    },
    [prompt, model, tablePrompt, batchSize, skipLastPages, apiKey, analyzeAllPages, getNextFileForPool, handlePoolFileComplete]
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
      console.log(`[useFileManager][${ts}] 🛑 Queue stopped by user, queued files marked as idle`);
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
    brokerPagesRestoredRef.current.delete(fileId);
    // 清理 IndexedDB 中的 PDF binary
    deletePdfBlob(fileId);

    // 如果刪的是目前顯示的檔案，切換到另一個
    if (fileId === activeFileIdRef.current) {
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
    }

    // 立即存檔 session（不等 debounce），setTimeout(0) 確保 React state 已更新
    setTimeout(() => {
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      saveSession(activeFileIdRef.current, filesRef.current);
    }, 0);

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useFileManager][${ts}] 🗑️ Removed file: ${file.name}`);
  }, [invalidateSession]);

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
    brokerPagesRestoredRef.current.clear();
    // 清空 IndexedDB + 取消 pending debounce timer（避免舊資料被重新寫入）
    clearAllPersistence();
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[useFileManager][${ts}] 🗑️ Cleared all files`);
  }, [invalidateSession]);

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

  return {
    // Core state
    files, setFiles,
    activeFileId, setActiveFileId,
    activeFile, numPages, pageRegions,

    // Refs
    filesRef, activeFileIdRef, pdfDocRef,
    updateActiveFileRegions,

    // File operations
    handleFilesUpload,
    handleRemoveFile,
    handleClearAll,
    handleDocumentLoadForFile,

    // Analysis（轉發自 useAnalysis）
    isAnalyzing, analysisProgress, error,
    handleStop, handleReanalyze, handleReanalyzePage, handleRegionDoubleClick,
    analyzingPagesMap, queuedPagesMap, cancelQueuedPage,
    analysisFileIdRef,
    handleStopFile, handleReanalyzeFile, triggerQueueProcessing,
    selectFileMetadata, addFileMetadataCandidate, removeFileMetadataCandidate, clearFileMetadataCandidates,

    // Derived
    mountedFileIds,
  };
}
