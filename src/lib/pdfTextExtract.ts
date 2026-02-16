/**
 * 功能：從 PDF 頁面的文字層中，根據 bounding box 座標提取文字，並自動校正不完整的 bbox
 * 職責：接收 pdfjs PDFPageProxy + Region[]，利用 getTextContent() 取得文字項，
 *       呼叫 pdfTextExtractCore 的純函式完成 snap → resolve → enforce → descender → extract 流程
 *       本檔案僅負責 pdfjs 的 IO 層（getTextContent + 座標轉換），所有演算法在 core 中
 * 依賴：pdfjs-dist (PDFPageProxy)、pdfTextExtractCore（純演算法）
 */

import { pdfjs } from 'react-pdf';
import { Region } from './types';
import {
  NormTextItem,
  NORMALIZED_MAX,
  _ts,
  snapBboxToText,
  resolveOverlappingLines,
  enforceMinVerticalGap,
  applyDescenderCompensation,
  extractTextFromBbox,
} from './pdfTextExtractCore';

/** pdfjs TextItem（有 transform 的文字項） */
interface PdfTextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, tx, ty]
  width: number;
  height: number;
}

/**
 * 從 PDF 頁面提取文字並填入各 Region 的 text 欄位
 * 流程：snap（水平+Y半行補足）→ resolve（重疊行解衝突）→ 提取文字
 * @param page - pdfjs PDFPageProxy
 * @param regions - AI 回傳的 Region[]（text 為空）
 * @returns 填入 text 的 Region[]（bbox 可能被校正）
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
  const textItems: NormTextItem[] = [];

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

    textItems.push({ str: ti.str, normX, normY, normW, normH, normBaseline: normY + normH });
  }

  // === Phase 1: Snap — 水平校正 + Y 軸半行補足 ===
  const snappedBboxes: [number, number, number, number][] = regions.map(
    (r) => snapBboxToText(r.bbox, textItems)
  );

  // === Phase 2: Resolve — 跨 region 重疊行解衝突 ===
  resolveOverlappingLines(snappedBboxes, textItems);

  // === Phase 2.5: 保證框間最小垂直間距 ===
  enforceMinVerticalGap(snappedBboxes);

  // === Phase 2.75: 降部補償（在 resolve/enforce 之後，避免汙染前面的座標判斷） ===
  applyDescenderCompensation(snappedBboxes, textItems);

  // === Phase 3: 提取文字 + 組裝結果 ===
  return regions.map((region, i) => {
    const finalBbox = snappedBboxes[i];
    const text = extractTextFromBbox(finalBbox, textItems);

    // Debug log：若 bbox 被校正，印出校正前後的差異
    const [ox1, oy1, ox2, oy2] = region.bbox;
    const xChanged = ox1 !== finalBbox[0] || ox2 !== finalBbox[2];
    const yChanged = oy1 !== finalBbox[1] || oy2 !== finalBbox[3];
    if (xChanged || yChanged) {
      const parts: string[] = [];
      if (xChanged) {
        parts.push(`x1:${Math.round(ox1)}→${Math.round(finalBbox[0])}, x2:${Math.round(ox2)}→${Math.round(finalBbox[2])}`);
      }
      if (yChanged) {
        parts.push(`y1:${Math.round(oy1)}→${Math.round(finalBbox[1])}, y2:${Math.round(oy2)}→${Math.round(finalBbox[3])}`);
      }
      console.log(`[pdfTextExtract][${_ts()}] 🔧 Region "${region.label}" bbox adjusted: ${parts.join(' | ')}`);
    }

    return { ...region, bbox: finalBbox, originalBbox: region.bbox, text };
  });
}
