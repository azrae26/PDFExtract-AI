/**
 * 功能：PDFExtract AI 共用型別定義
 * 職責：定義 API 請求/回應、區域標註、頁面分析（含券商名 report）、多檔案管理、debug 診斷等資料結構
 */

/** 文字提取各 phase 的 debug 診斷資料（每個 Region 一份） */
export interface RegionDebugInfo {
  /** 頁面上的文字項總數 */
  totalTextItems: number;
  /** 各 phase 的 bbox 快照 */
  phases: {
    /** AI 原始 bbox */
    original: [number, number, number, number];
    /** Phase 1: snap 校正後 */
    afterSnap: [number, number, number, number];
    /** Phase 2: resolve 跨框衝突解決後 */
    afterResolve: [number, number, number, number];
    /** Phase 2.5: enforce 最小間距保證後 */
    afterEnforce: [number, number, number, number];
    /** 最終（Phase 2.75 descender 補償後） */
    final: [number, number, number, number];
  };
  /** 落入 bbox 的文字項（Phase 3 extractTextFromBbox 收集的 Hit） */
  hits: { str: string; x: number; y: number; h: number; right: number; baseline: number }[];
  /** 偵測到的欄數 */
  columns: number;
  /** 多欄分界線位置（僅多欄時有值） */
  columnSeparator?: number;
  /** Baseline 對齊法的獨有行比例（僅多欄時有值） */
  columnExclusiveRatio?: number;
  /** 多欄偵測來源（僅多欄時有值） */
  columnSource?: string;
  /** 行數（formatColumnText 分組後） */
  lineCount: number;
  /** 實際使用的分行閾值 */
  lineThreshold: number;
  /** 是否使用了自適應閾值（非預設 15） */
  adaptiveThreshold: boolean;
  /** 各行距（相鄰行 baseline 差） */
  lineGaps: number[];
  /** 偵測到的符號字型（fontName → 真實字型名稱，如 "g_d0_f8" → "Wingdings-Regular"） */
  symbolicFonts?: Record<string, string>;
  /** 行距中位數 */
  medianLineGap: number;
  /** Y-overlap 行合併事件（baseline 超出閾值但 Y 範圍重疊而合併的 items） */
  yOverlapMerges?: { str: string; blDiff: number; overlap: number; toLineIdx: number }[];
  /** 行碎片重組事件（Step 3.5，超連結等 baseline 偏移導致的碎片合併） */
  fragmentMerges?: { fromLine: number; toLine: number; combinedXMin: number; combinedXMax: number }[];
  /** 自適應閾值計算詳情 */
  adaptiveDetail?: {
    /** 計算路徑：stable=穩定聚類、fallback=微聚類中位數、none=未觸發 */
    path: 'stable' | 'fallback' | 'none';
    /** 穩定聚類數（count≥2 的微聚類） */
    stableCount?: number;
    /** 穩定聚類間最小間距 */
    minStableSpacing?: number;
    /** 微聚類數 */
    microClusterCount?: number;
    /** 微聚類間距中位數 */
    medianMicroSpacing?: number;
  };
  /** 各階段校正過程詳情（bbox 如何從 original 變成 final） */
  corrections?: {
    /** Phase 1 snap 校正 */
    snap: {
      /** 各座標變化量 [dx1, dy1, dx2, dy2]（負=往左/上擴展，正=往右/下擴展） */
      delta: [number, number, number, number];
      /** 迭代次數 */
      iterations: number;
      /** 觸發擴展的 text items（每個座標方向的最遠觸發者） */
      triggers: { str: string; x: number; y: number; w: number; h: number; xRatio: number; expanded: string }[];
    };
    /** Phase 2 resolve 跨框衝突 */
    resolve: {
      /** 各座標變化量 [dx1, dy1, dx2, dy2] */
      delta: [number, number, number, number];
    };
    /** Phase 2.5 enforce 最小間距 */
    enforce: {
      /** 各座標變化量 [dx1, dy1, dx2, dy2] */
      delta: [number, number, number, number];
    };
    /** Phase 2.75 descender 補償 */
    descender: {
      /** 各座標變化量 [dx1, dy1, dx2, dy2] */
      delta: [number, number, number, number];
    };
    /** 尺寸變化摘要 */
    size: {
      original: { w: number; h: number };
      final: { w: number; h: number };
      /** 寬度變化量 */
      deltaW: number;
      /** 高度變化量 */
      deltaH: number;
    };
  };
}

/** 單一標註區域 */
export interface Region {
  id: number;
  /** 歸一化座標 [x1, y1, x2, y2]，範圍 0~1000 */
  bbox: [number, number, number, number];
  /** 區域簡短描述 */
  label: string;
  /** 框內的完整文字內容（由前端從 PDF 文字層提取） */
  text: string;
  /** 是否被使用者手動修改/新增（API 回傳時不覆蓋） */
  userModified?: boolean;
  /** AI 原始 bbox（校正前），用於切換比較 */
  originalBbox?: [number, number, number, number];
  /** 文字提取 debug 診斷資料（各 phase bbox 快照 + 提取參數） */
  _debug?: RegionDebugInfo;
}

/** 單頁分析結果 */
export interface PageAnalysis {
  page: number;
  hasAnalysis: boolean;
  /** 券商名（AI 回傳，同一份 PDF 各頁通常相同） */
  report?: string;
  regions: Region[];
}

/** 送往 /api/analyze 的請求格式 */
export interface AnalyzeRequest {
  /** base64 編碼的 JPEG 圖片（不含 data: prefix） */
  image: string;
  /** 使用者的 Prompt */
  prompt: string;
  /** 頁碼 */
  page: number;
}

/** /api/analyze 的回應格式 */
export interface AnalyzeResponse {
  success: boolean;
  data?: PageAnalysis;
  error?: string;
}

/** 多檔案管理：單一檔案條目 */
export interface FileEntry {
  /** 唯一識別碼 */
  id: string;
  /** 原始 File 物件 */
  file: File;
  /** Object URL（用於 react-pdf 顯示） */
  url: string;
  /** 檔名 */
  name: string;
  /** 處理狀態 */
  status: 'idle' | 'queued' | 'processing' | 'done' | 'stopped' | 'error';
  /** 總頁數（PDF 載入後才知道） */
  numPages: number;
  /** 各頁分析結果 */
  pageRegions: Map<number, Region[]>;
  /** 實際要分析的頁數（numPages - effectiveSkip，per-file 追蹤） */
  analysisPages: number;
  /** 已完成分析的頁數（per-file 追蹤，不論是否有 regions） */
  completedPages: number;
  /** 券商名（從 AI 分析結果取得） */
  report?: string;
}

/** Bounding Box 顏色定義 */
export interface BoxColor {
  border: string;
  bg: string;
  hoverBg: string;
  textBg: string;
}
