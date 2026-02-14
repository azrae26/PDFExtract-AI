/**
 * 功能：PDFExtract AI 共用常數
 * 職責：定義預設 Prompt、顏色配置等常數
 */

import { BoxColor } from './types';

/** 預設 Prompt — 用戶可在左側面板修改 */
export const DEFAULT_PROMPT = `你是一個專業的文件分析助手。請分析這張圖片（PDF頁面），判斷是否包含對主要公司的分析文本。

如果有，請：
1. 找出所有包含公司分析文本的區域
2. 為每個區域生成長方形框座標，須完整框住該段文本

請嚴格以下列 JSON 格式回傳，不要包含任何其他文字：
{
  "hasAnalysis": true,
  "regions": [
    {
      "id": 1,
      "bbox": [y1, x1, y2, x2],
      "label": "區域簡短描述"
    }
  ]
}

規則：
- bbox 使用歸一化座標（0~1000），(0,0)=左上角，(1000,1000)=右下角
- 框須精準貼合文字邊界，不要留太多空白
- 如果沒有分析文本，回傳 {"hasAnalysis": false, "regions": []}
- 只回傳純 JSON，不要回傳框內文字`;

/** 預設表格/圖表識別 Prompt — 用於雙擊框截圖送 AI 時使用 */
export const DEFAULT_TABLE_PROMPT = `請將這張圖片中的表格或圖表內容，轉換為 Markdown 表格格式輸出。

規則：
- 保留原始表格的欄位結構
- 數字、文字須忠實呈現，不可遺漏
- 如果圖片中沒有表格或圖表，請直接輸出圖片中的所有文字
- 只回傳 Markdown 內容，不要加任何額外說明`;

/** Bounding Box 顏色配色表 — 按 index 循環使用 */
export const BOX_COLORS: BoxColor[] = [
  { border: '#3B82F6', bg: 'rgba(59, 130, 246, 0.12)', hoverBg: 'rgba(59, 130, 246, 0.28)', textBg: 'rgba(59, 130, 246, 0.08)' },
  { border: '#10B981', bg: 'rgba(16, 185, 129, 0.12)', hoverBg: 'rgba(16, 185, 129, 0.28)', textBg: 'rgba(16, 185, 129, 0.08)' },
  { border: '#F59E0B', bg: 'rgba(245, 158, 11, 0.12)', hoverBg: 'rgba(245, 158, 11, 0.28)', textBg: 'rgba(245, 158, 11, 0.08)' },
  { border: '#EF4444', bg: 'rgba(239, 68, 68, 0.12)', hoverBg: 'rgba(239, 68, 68, 0.28)', textBg: 'rgba(239, 68, 68, 0.08)' },
  { border: '#8B5CF6', bg: 'rgba(139, 92, 246, 0.12)', hoverBg: 'rgba(139, 92, 246, 0.28)', textBg: 'rgba(139, 92, 246, 0.08)' },
  { border: '#EC4899', bg: 'rgba(236, 72, 153, 0.12)', hoverBg: 'rgba(236, 72, 153, 0.28)', textBg: 'rgba(236, 72, 153, 0.08)' },
  { border: '#14B8A6', bg: 'rgba(20, 184, 166, 0.12)', hoverBg: 'rgba(20, 184, 166, 0.28)', textBg: 'rgba(20, 184, 166, 0.08)' },
  { border: '#F97316', bg: 'rgba(249, 115, 22, 0.12)', hoverBg: 'rgba(249, 115, 22, 0.28)', textBg: 'rgba(249, 115, 22, 0.08)' },
];

/** 取得顏色（按 index 循環） */
export function getBoxColor(index: number): BoxColor {
  return BOX_COLORS[index % BOX_COLORS.length];
}

/** 歸一化座標上限 */
export const NORMALIZED_MAX = 1000;

/** 轉圖片的 scale（2x 以獲得較好解析度） */
export const RENDER_SCALE = 2;

/** JPEG 壓縮品質 */
export const JPEG_QUALITY = 0.85;
