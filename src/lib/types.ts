/**
 * 功能：PDFExtract AI 共用型別定義
 * 職責：定義 API 請求/回應、區域標註、頁面分析等資料結構
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

/** Bounding Box 顏色定義 */
export interface BoxColor {
  border: string;
  bg: string;
  hoverBg: string;
  textBg: string;
}
