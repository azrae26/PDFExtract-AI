/**
 * 功能：從 PDF 頁面的文字層中，根據 bounding box 座標提取文字，並自動校正不完整的 bbox
 * 職責：接收 pdfjs PDFPageProxy + Region[]，利用 getTextContent() 取得文字項，
 *       1. snapBboxToText：水平方向重疊比例校正 + Y 軸任何重疊即補足完整行高
 *       2. resolveOverlappingLines：同一行被多個框覆蓋時，根據行距判斷退縮方向
 *       2.5. enforceMinVerticalGap：擴張後框間上下間距不足時各自退縮，保證最小間距
 *       3. 根據校正後的歸一化座標 (0~1000) 判斷哪些文字落在各個 bbox 內，回傳填入 text 的 Region[]
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

/** 歸一化座標的文字項目 */
interface NormTextItem {
  str: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

/** 文字行（多個 Y 座標相近的 textItem 組成） */
interface TextLine {
  y: number;         // 行的代表 Y 座標（第一個 item 的 normY）
  topY: number;      // 行的最小 Y
  bottomY: number;   // 行的最大底部（normY + normH）
}

// === Bbox 自動校正常數 ===
/** 交集擴展最大迭代次數 */
const SNAP_MAX_ITERATIONS = 3;
/** 重疊比例閾值：文字項目在框內的比例超過此值才納入擴展（避免吃到相鄰區塊） */
const SNAP_OVERLAP_RATIO = 0.5;
/** 同一行判定閾值（歸一化單位，Y 差距小於此值視為同一行） */
const SAME_LINE_THRESHOLD = 15;
/** 框間最小垂直間距（歸一化單位），擴張後上下太近時各自退縮 */
const MIN_VERTICAL_GAP = 5;
/** 降部補償比例：PDF 文字項 height 通常為 em height，降部約佔 15%（依字型而異） */
const DESCENDER_RATIO = 0.15;

/**
 * 自動校正 bbox 邊界
 * - 水平方向：重疊比例 >= 50% 才擴展（避免吃到相鄰區塊）
 * - 垂直方向：只要框碰到該行就補足到完整行高（任何重疊即擴展）
 */
function snapBboxToText(
  bbox: [number, number, number, number],
  textItems: NormTextItem[],
): [number, number, number, number] {
  let [x1, y1, x2, y2] = bbox;
  // 追蹤決定 y2 底部邊緣的文字項高度（用於計算降部補償）
  let bottomEdgeH = 0;

  // 迭代擴展 — 只納入重疊比例 >= 50% 的文字項目
  let changed = true;
  let iterations = 0;
  while (changed && iterations < SNAP_MAX_ITERATIONS) {
    changed = false;
    iterations++;
    for (const ti of textItems) {
      const tiRight = ti.normX + ti.normW;
      const tiBottom = ti.normY + ti.normH;

      // 計算 X、Y 方向的重疊
      const overlapLeft = Math.max(ti.normX, x1);
      const overlapRight = Math.min(tiRight, x2);
      const overlapWidth = overlapRight - overlapLeft;
      const overlapTop = Math.max(ti.normY, y1);
      const overlapBottom = Math.min(tiBottom, y2);
      const overlapHeight = overlapBottom - overlapTop;

      if (overlapWidth <= 0 || overlapHeight <= 0) continue; // 無交集

      // 水平方向：重疊比例 >= 50% 才擴展
      const xRatio = ti.normW > 0 ? overlapWidth / ti.normW : 0;
      if (xRatio >= SNAP_OVERLAP_RATIO) {
        if (ti.normX < x1) { x1 = ti.normX; changed = true; }
        if (tiRight > x2) { x2 = tiRight; changed = true; }
      }

      // 垂直方向：只要框碰到該行就補足到完整行高（任何重疊即擴展）
      if (overlapHeight > 0) {
        if (ti.normY < y1) { y1 = ti.normY; changed = true; }
        if (tiBottom > y2) { y2 = tiBottom; bottomEdgeH = ti.normH; changed = true; }
      }
    }
  }

  // 底部降部補償：根據決定 y2 的文字項高度動態計算（而非固定值）
  // 框間衝突由後續的 resolveOverlappingLines / enforceMinVerticalGap 處理
  if (bottomEdgeH > 0) {
    y2 = Math.min(NORMALIZED_MAX, y2 + bottomEdgeH * DESCENDER_RATIO);
  }

  return [x1, y1, x2, y2];
}

/** 把 textItems 按 Y 座標分行 */
function groupIntoLines(textItems: NormTextItem[]): TextLine[] {
  const sorted = [...textItems].sort((a, b) => a.normY - b.normY);
  const lines: TextLine[] = [];

  for (const ti of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(ti.normY - last.y) < SAME_LINE_THRESHOLD) {
      // 同一行：更新範圍
      last.topY = Math.min(last.topY, ti.normY);
      last.bottomY = Math.max(last.bottomY, ti.normY + ti.normH);
    } else {
      lines.push({
        y: ti.normY,
        topY: ti.normY,
        bottomY: ti.normY + ti.normH,
      });
    }
  }

  return lines;
}

/**
 * 跨 region 解衝突：同一行被多個框覆蓋時，根據行距判斷退縮方向
 * - 下方行距 < 上方行距 → 此行屬於下方段落 → 上方框的 y2 退縮
 * - 上方行距 < 下方行距 → 此行屬於上方段落 → 下方框的 y1 退縮
 * - 行距相等 → 不動
 * 直接修改 bboxes 陣列（in-place）
 */
function resolveOverlappingLines(
  bboxes: [number, number, number, number][],
  textItems: NormTextItem[],
): void {
  if (bboxes.length < 2) return;

  const lines = groupIntoLines(textItems);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // 找出 Y 範圍覆蓋此行的所有 bbox indices
    const coveringIndices: number[] = [];
    for (let bi = 0; bi < bboxes.length; bi++) {
      const [, by1, , by2] = bboxes[bi];
      if (line.topY < by2 && line.bottomY > by1) {
        coveringIndices.push(bi);
      }
    }

    if (coveringIndices.length < 2) continue;

    // 計算上方行距和下方行距
    const prevLine = li > 0 ? lines[li - 1] : null;
    const nextLine = li < lines.length - 1 ? lines[li + 1] : null;
    const gapAbove = prevLine ? line.topY - prevLine.bottomY : Infinity;
    const gapBelow = nextLine ? nextLine.topY - line.bottomY : Infinity;

    if (gapAbove === gapBelow) continue; // 行距相等不動

    // 按框的 y1 排序，找出上方框和下方框
    coveringIndices.sort((a, b) => bboxes[a][1] - bboxes[b][1]);
    const upperIdx = coveringIndices[0];
    const lowerIdx = coveringIndices[coveringIndices.length - 1];

    if (gapBelow < gapAbove) {
      // 下方行距小 → 此行屬於下方段落 → 上方框退縮 y2
      bboxes[upperIdx][3] = Math.min(bboxes[upperIdx][3], line.topY);
    } else {
      // 上方行距小 → 此行屬於上方段落 → 下方框退縮 y1
      bboxes[lowerIdx][1] = Math.max(bboxes[lowerIdx][1], line.bottomY);
    }
  }
}

/**
 * 擴張後框間最小垂直間距保證：
 * 對所有 X 方向有重疊的框對，若上下間距 < MIN_VERTICAL_GAP，各自退縮一半使間距達標
 * 直接修改 bboxes 陣列（in-place）
 */
function enforceMinVerticalGap(
  bboxes: [number, number, number, number][],
): void {
  if (bboxes.length < 2) return;

  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      // X 方向無重疊則跳過（左右不同欄的框不需要退縮）
      const xOverlap = Math.min(bboxes[i][2], bboxes[j][2]) - Math.max(bboxes[i][0], bboxes[j][0]);
      if (xOverlap <= 0) continue;

      // 判斷哪個在上、哪個在下
      const upperIdx = bboxes[i][1] <= bboxes[j][1] ? i : j;
      const lowerIdx = upperIdx === i ? j : i;

      const gap = bboxes[lowerIdx][1] - bboxes[upperIdx][3];
      if (gap >= MIN_VERTICAL_GAP) continue;

      const deficit = MIN_VERTICAL_GAP - gap;
      const half = deficit / 2;

      // 各自退縮一半
      bboxes[upperIdx][3] -= half;
      bboxes[lowerIdx][1] += half;
    }
  }
}

/**
 * 從指定 bbox 中提取文字（收集交集文字項 + 按閱讀順序拼接）
 */
function extractTextFromBbox(
  bbox: [number, number, number, number],
  textItems: NormTextItem[],
): string {
  const [x1, y1, x2, y2] = bbox;

  // 收集與 bbox 有交集的文字項（含右邊緣座標，用於計算欄間距）
  const hits: { str: string; normX: number; normY: number; normRight: number }[] = [];

  for (const ti of textItems) {
    const tiRight = ti.normX + ti.normW;
    const tiBottom = ti.normY + ti.normH;
    if (ti.normX < x2 && tiRight > x1 && ti.normY < y2 && tiBottom > y1) {
      hits.push({ str: ti.str, normX: ti.normX, normY: ti.normY, normRight: tiRight });
    }
  }

  // 按閱讀順序排序：先按 Y（上→下），Y 相近的按 X（左→右）
  hits.sort((a, b) => {
    const yDiff = a.normY - b.normY;
    if (Math.abs(yDiff) < SAME_LINE_THRESHOLD) return a.normX - b.normX;
    return yDiff;
  });

  // 拼接文字：同一行的直接拼接，換行用 \n
  // 同一行內，若兩個文字項間距 > 閾值（表格不同欄），插入 TAB
  const COL_GAP_THRESHOLD = 30; // 歸一化單位，約頁面寬度 3%
  let text = '';
  let lastY = -Infinity;
  let lastRight = -Infinity;
  for (const hit of hits) {
    const sameLine = lastY !== -Infinity && Math.abs(hit.normY - lastY) < SAME_LINE_THRESHOLD;
    if (!sameLine && lastY !== -Infinity) {
      text += '\n';
      lastRight = -Infinity;
    } else if (sameLine && lastRight !== -Infinity) {
      const gap = hit.normX - lastRight;
      if (gap > COL_GAP_THRESHOLD) {
        text += '\t';
      }
    }
    text += hit.str;
    lastY = hit.normY;
    lastRight = hit.normRight;
  }

  return text;
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

    textItems.push({ str: ti.str, normX, normY, normW, normH });
  }

  // === Phase 1: Snap — 水平校正 + Y 軸半行補足 ===
  const snappedBboxes: [number, number, number, number][] = regions.map(
    (r) => snapBboxToText(r.bbox, textItems)
  );

  // === Phase 2: Resolve — 跨 region 重疊行解衝突 ===
  resolveOverlappingLines(snappedBboxes, textItems);

  // === Phase 2.5: 保證框間最小垂直間距 ===
  enforceMinVerticalGap(snappedBboxes);

  // === Phase 3: 提取文字 + 組裝結果 ===
  return regions.map((region, i) => {
    const finalBbox = snappedBboxes[i];
    const text = extractTextFromBbox(finalBbox, textItems);

    // Debug log：若 bbox 被校正，印出校正前後的差異
    const [ox1, oy1, ox2, oy2] = region.bbox;
    const xChanged = ox1 !== finalBbox[0] || ox2 !== finalBbox[2];
    const yChanged = oy1 !== finalBbox[1] || oy2 !== finalBbox[3];
    if (xChanged || yChanged) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      const parts: string[] = [];
      if (xChanged) {
        parts.push(`x1:${Math.round(ox1)}→${Math.round(finalBbox[0])}, x2:${Math.round(ox2)}→${Math.round(finalBbox[2])}`);
      }
      if (yChanged) {
        parts.push(`y1:${Math.round(oy1)}→${Math.round(finalBbox[1])}, y2:${Math.round(oy2)}→${Math.round(finalBbox[3])}`);
      }
      console.log(`[pdfTextExtract][${ts}] 🔧 Region "${region.label}" bbox adjusted: ${parts.join(' | ')}`);
    }

    return { ...region, bbox: finalBbox, text };
  });
}
