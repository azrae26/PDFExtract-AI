/**
 * 功能：PDFExtract AI 共用常數
 * 職責：定義預設 Prompt、顏色配置等常數
 */

import { BoxColor } from './types';

/** 預設 Prompt — 用戶可在左側面板修改 */
export const DEFAULT_PROMPT = `你是專業文件分析助手。分析圖片（PDF頁面），判斷是否含對主要公司或產業的分析文本，給出座標。

什麼算什麼不算：
- 主題要算，主題的說明要算
- 對主要公司或產業的分析文本才算
- 圖表或表格不算，圖表上下方的簡短說明也不算
- 整段內容都在講ESG，該公司卻不是賣ESG產品的話，不算
- 只有單一行簡短風險因子不算

如果有，請：
- 找出所有包含公司或產業分析文本的區域
- 為每個區域生成長方形框座標，須完整框住該段文本，不遺漏
- 每個區域不重疊
- 告訴我這是哪一家的報告，如不在可選清單寫unknow，可選的券商有：{{Daiwa、JPM、HSBC、GS、MS、Citi、國票、兆豐、統一、永豐、元大、中信、元富、群益、宏遠、康和、富邦、一銀、福邦、Nomura、國泰、台新、合庫、凱基(一般報告)、玉山、MQ、BofA、CLSA、memo、凱基(法說memo)}}

嚴格以下列 JSON 格式回傳，不要包含任何其他文字：
{
  "hasAnalysis": true,
  "report": "券商名",
  "regions": [
    {
      "id": 1,
      "bbox": [y1, x1, y2, x2],
      "label": "區域超簡短描述(5字左右)"
    }
  ]
}

規則：
- bbox 使用歸一化座標（0~1000），(0,0)=左上角，(1000,1000)=右下角，y代表縱軸，x代表橫軸
- 如果沒有分析文本，回傳 {"hasAnalysis": false, "regions": []}
- 只回傳純 JSON`;

/** 預設表格/圖表識別 Prompt — 用於雙擊框截圖送 AI 時使用 */
export const DEFAULT_TABLE_PROMPT = `將這張圖片中的表格或圖表內容，以 Markdown 表格格式輸出。
- 保留原始表格欄位結構
- 數字、文字須忠實呈現，不可遺漏
- 禁用粗體**，可用大標#小標##
- 如果圖片中沒有表格或圖表，直接輸出圖片中的所有文字
- 只回傳 Markdown 內容，不加任何額外說明`;

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
