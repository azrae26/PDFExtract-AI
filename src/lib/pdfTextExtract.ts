/**
 * 功能：從 PDF 頁面的文字層中，根據 bounding box 座標提取文字
 * 職責：接收 pdfjs PDFPageProxy + Region[]，利用 getTextContent() 取得文字項，
 *       根據歸一化座標 (0~1000) 判斷哪些文字落在各個 bbox 內，回傳填入 text 的 Region[]
 *       同一行內若偵測到明顯水平間距（表格不同欄），自動插入 TAB 分隔
 * 依賴：pdfjs-dist (PDFPageProxy)
 */

import { pdfjs } from 'react-pdf';
import { Region } from './types';
import { NORMALIZED_MAX } from './constants';

/** pdfjs TextItem（有 transform 的文字項） */
interface PdfTextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, tx, ty]
  width: number;
  height: number;
}

/**
 * 從 PDF 頁面提取文字並填入各 Region 的 text 欄位
 * @param page - pdfjs PDFPageProxy
 * @param regions - AI 回傳的 Region[]（text 為空）
 * @returns 填入 text 的 Region[]
 */
export async function extractTextForRegions(
  page: pdfjs.PDFPageProxy,
  regions: Region[]
): Promise<Region[]> {
  if (regions.length === 0) return regions;

  const viewport = page.getViewport({ scale: 1 });
  const { width: vw, height: vh } = viewport;

  const textContent = await page.getTextContent();

  // 將每個文字項轉換為歸一化座標
  const textItems: { str: string; normX: number; normY: number; normW: number; normH: number }[] = [];

  for (const item of textContent.items) {
    // 過濾掉沒有 transform 的項目（如 TextMarkedContent）
    if (!('transform' in item) || !('str' in item)) continue;
    const ti = item as unknown as PdfTextItem;
    if (!ti.str.trim()) continue; // 跳過空白

    const tx = ti.transform[4]; // x 座標（PDF 座標系，左下原點）
    const ty = ti.transform[5]; // y 座標（PDF 座標系，左下原點）
    const w = ti.width;
    const h = ti.height;

    // PDF 座標系（左下原點）→ 歸一化座標（左上原點，0~1000）
    const normX = (tx / vw) * NORMALIZED_MAX;
    const normY = ((vh - ty - h) / vh) * NORMALIZED_MAX; // 翻轉 Y 軸，ty+h 是文字頂部
    const normW = (w / vw) * NORMALIZED_MAX;
    const normH = (h / vh) * NORMALIZED_MAX;

    textItems.push({ str: ti.str, normX, normY, normW, normH });
  }

  // 對每個 region，找出落在 bbox 內的文字
  return regions.map((region) => {
    const [x1, y1, x2, y2] = region.bbox;

    // 收集與 bbox 有交集的文字項（含右邊緣座標，用於計算欄間距）
    const hits: { str: string; normX: number; normY: number; normRight: number }[] = [];

    for (const ti of textItems) {
      const tiRight = ti.normX + ti.normW;
      const tiBottom = ti.normY + ti.normH;

      // 判斷文字區域與 bbox 是否有交集
      const overlapX = ti.normX < x2 && tiRight > x1;
      const overlapY = ti.normY < y2 && tiBottom > y1;

      if (overlapX && overlapY) {
        hits.push({ str: ti.str, normX: ti.normX, normY: ti.normY, normRight: tiRight });
      }
    }

    // 按閱讀順序排序：先按 Y（上→下），Y 相近的按 X（左→右）
    hits.sort((a, b) => {
      const yDiff = a.normY - b.normY;
      // Y 差距小於一行高度（約 15 歸一化單位）視為同一行
      if (Math.abs(yDiff) < 15) return a.normX - b.normX;
      return yDiff;
    });

    // 拼接文字：同一行的直接拼接，換行用 \n
    // 同一行內，若兩個文字項間距 > 閾值（表格不同欄），插入 TAB
    const COL_GAP_THRESHOLD = 30; // 歸一化單位，約頁面寬度 3%
    let text = '';
    let lastY = -Infinity;
    let lastRight = -Infinity; // 前一個文字項的右邊緣
    for (const hit of hits) {
      const sameLine = lastY !== -Infinity && Math.abs(hit.normY - lastY) < 15;
      if (!sameLine && lastY !== -Infinity) {
        text += '\n';
        lastRight = -Infinity;
      } else if (sameLine && lastRight !== -Infinity) {
        // 同一行：判斷間距是否為不同欄
        const gap = hit.normX - lastRight;
        if (gap > COL_GAP_THRESHOLD) {
          text += '\t';
        }
      }
      text += hit.str;
      lastY = hit.normY;
      lastRight = hit.normRight;
    }

    return { ...region, text };
  });
}
