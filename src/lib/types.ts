/**
 * 功能：PDFExtract AI 共用型別定義
 * 職責：定義 API 請求/回應、區域標註、頁面分析（含券商名 report）、多檔案管理等資料結構
 */

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
