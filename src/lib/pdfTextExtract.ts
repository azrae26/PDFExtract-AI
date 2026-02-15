/**
 * 功能：從 PDF 頁面的文字層中，根據 bounding box 座標提取文字，並自動校正不完整的 bbox
 * 職責：接收 pdfjs PDFPageProxy + Region[]，利用 getTextContent() 取得文字項，
 *       1. snapBboxToText：水平方向重疊比例校正 + Y 軸任何重疊即補足完整行高
 *       2. resolveOverlappingLines：同一行被多個框覆蓋時，根據行距判斷退縮方向
 *       2.5. enforceMinVerticalGap：擴張後框間上下間距不足時各自退縮，保證最小間距
 *       3. 根據校正後的歸一化座標 (0~1000) 判斷哪些文字落在各個 bbox 內，回傳填入 text 的 Region[]
 *       同一行判定使用 baseline 座標（同一行不同字體大小 baseline 一致，避免 top 座標因字體差異導致誤判同行）
 *       同一行內若偵測到明顯水平間距（表格不同欄），自動插入 TAB 分隔
 *       4. splitIntoColumns：偵測 bbox 內多欄佈局（行內 gap 定位法 + 投影法 → baseline 對齊法驗證），分欄後逐欄提取避免左右文字混合
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
  normY: number;        // top 座標（視覺上方）
  normW: number;
  normH: number;
  normBaseline: number; // baseline 座標 = normY + normH（同一行不同字體大小 baseline 一致）
}

/** 文字行（多個 baseline 相近的 textItem 組成） */
interface TextLine {
  baselineY: number; // 行的代表 baseline 座標（第一個 item 的 normBaseline）
  topY: number;      // 行的最小 normY（視覺上緣）
  bottomY: number;   // 行的最大 normBaseline（視覺下緣）
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

// === 多欄偵測常數 ===
/** 投影法桶寬（歸一化單位，X 軸離散化精度） */
const COLUMN_BUCKET_WIDTH = 2;
/** 每個欄最少行數——至少兩個欄各有此行數以上才認定為多欄佈局（避免把表格誤判為多欄） */
const COLUMN_MIN_LINES = 3;
/**
 * Baseline 對齊法：獨有行比例閾值
 * 分成左右兩組後，計算「只在一邊出現的行」佔總行數的比例
 * > 此值 → 強證據為獨立多欄（左右各自排版，baseline 不對齊）
 */
const COLUMN_EXCLUSIVE_RATIO = 0.3;
/** 投影法探索閾值（放寬）：覆蓋 < 此比例的桶為候選低覆蓋區 */
const COLUMN_PROBE_COVERAGE_RATIO = 0.8;
/** 投影法探索最小帶寬（歸一化單位） */
const COLUMN_PROBE_MIN_WIDTH = 6;
/** 投影法嚴格閾值：覆蓋 < 此比例 → fallback 判定多欄（即使 baseline 對齊） */
const COLUMN_STRICT_COVERAGE_RATIO = 0.5;
/** 投影法嚴格最小帶寬（歸一化單位） */
const COLUMN_STRICT_MIN_WIDTH = 10;

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

/** 把 textItems 按 baseline 座標分行（同一行不同字體大小 baseline 一致，比 top 更準確） */
function groupIntoLines(textItems: NormTextItem[]): TextLine[] {
  const sorted = [...textItems].sort((a, b) => a.normBaseline - b.normBaseline);
  const lines: TextLine[] = [];

  for (const ti of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(ti.normBaseline - last.baselineY) < SAME_LINE_THRESHOLD) {
      // 同一行：更新範圍
      last.topY = Math.min(last.topY, ti.normY);
      last.bottomY = Math.max(last.bottomY, ti.normBaseline);
    } else {
      lines.push({
        baselineY: ti.normBaseline,
        topY: ti.normY,
        bottomY: ti.normBaseline,
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

/** bbox 內的文字命中項（用於排序和多欄偵測） */
interface Hit {
  str: string;
  normX: number;
  normBaseline: number;
  normRight: number;
}

/**
 * 計算 hits 中有多少獨立行（用 SAME_LINE_THRESHOLD 分行）
 */
function countLines(hits: Hit[]): number {
  if (hits.length === 0) return 0;
  const sorted = hits.map(h => h.normBaseline).sort((a, b) => a - b);
  let count = 1;
  let last = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i] - last) >= SAME_LINE_THRESHOLD) {
      count++;
      last = sorted[i];
    }
  }
  return count;
}

/**
 * 在候選分界線處切分 hits，計算 baseline 獨有行比例
 * @returns { leftHits, rightHits, exclusiveRatio, detail } 或 null（行數不足）
 */
function testSeparator(
  hits: Hit[],
  separator: number,
): { leftHits: Hit[]; rightHits: Hit[]; exclusiveRatio: number; detail: string } | null {
  const leftHits: Hit[] = [];
  const rightHits: Hit[] = [];
  for (const hit of hits) {
    const centerX = (hit.normX + hit.normRight) / 2;
    if (centerX <= separator) leftHits.push(hit);
    else rightHits.push(hit);
  }

  if (leftHits.length === 0 || rightHits.length === 0) return null;

  const leftLineCount = countLines(leftHits);
  const rightLineCount = countLines(rightHits);
  if (leftLineCount < COLUMN_MIN_LINES || rightLineCount < COLUMN_MIN_LINES) return null;

  // 合併所有 baseline，分行後看每行是 L_、_R、還是 LR
  const allWithSide = [
    ...leftHits.map(h => ({ baseline: h.normBaseline, side: 'L' as const })),
    ...rightHits.map(h => ({ baseline: h.normBaseline, side: 'R' as const })),
  ];
  allWithSide.sort((a, b) => a.baseline - b.baseline);

  const mergedLines: { hasLeft: boolean; hasRight: boolean }[] = [];
  let curBl = allWithSide[0].baseline;
  let hasL = allWithSide[0].side === 'L';
  let hasR = allWithSide[0].side === 'R';

  for (let i = 1; i < allWithSide.length; i++) {
    if (Math.abs(allWithSide[i].baseline - curBl) < SAME_LINE_THRESHOLD) {
      if (allWithSide[i].side === 'L') hasL = true; else hasR = true;
    } else {
      mergedLines.push({ hasLeft: hasL, hasRight: hasR });
      curBl = allWithSide[i].baseline;
      hasL = allWithSide[i].side === 'L';
      hasR = allWithSide[i].side === 'R';
    }
  }
  mergedLines.push({ hasLeft: hasL, hasRight: hasR });

  const exclusiveCount = mergedLines.filter(l => !l.hasLeft || !l.hasRight).length;
  const exclusiveRatio = exclusiveCount / mergedLines.length;
  const detail =
    `sep=${Math.round(separator)}, excl=${exclusiveCount}/${mergedLines.length}(${(exclusiveRatio * 100).toFixed(0)}%)` +
    `, L=${leftLineCount}行/R=${rightLineCount}行` +
    `, lines=${mergedLines.map(l => l.hasLeft && l.hasRight ? 'LR' : l.hasLeft ? 'L_' : '_R').join(',')}`;

  return { leftHits, rightHits, exclusiveRatio, detail };
}

/**
 * 偵測 bbox 內的多欄佈局並分組
 *
 * 三層候選策略（收集多個候選分界線，逐一用 baseline 對齊法測試）：
 *
 * 候選來源 1 — 行內 gap 定位法（最精準）
 *   對每一行找出最大 X gap 的位置，聚類後取中位數作為候選
 *   不受 gap 寬度影響，只看 gap 位置是否一致
 *
 * 候選來源 2 — 投影法低覆蓋帶中點
 *   X 軸離散化計算覆蓋行數，低覆蓋帶的中點作為候選
 *
 * 驗證 — Baseline 對齊法
 *   在候選分界線切成左右兩組，看每行是否「只在一邊出現」
 *   獨有行比例 > 30% → 確認多欄
 *
 * @returns 按欄分組的 hits 陣列，單欄時回傳 [hits]
 */
function splitIntoColumns(hits: Hit[]): Hit[][] {
  const _ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });

  if (hits.length <= 1) return [hits];

  // === Step 1: 按 baseline 分行 ===
  const sortedHits = [...hits].sort((a, b) => a.normBaseline - b.normBaseline);
  const lines: Hit[][] = [[sortedHits[0]]];
  for (let i = 1; i < sortedHits.length; i++) {
    const lastLine = lines[lines.length - 1];
    if (Math.abs(sortedHits[i].normBaseline - lastLine[0].normBaseline) < SAME_LINE_THRESHOLD) {
      lastLine.push(sortedHits[i]);
    } else {
      lines.push([sortedHits[i]]);
    }
  }

  const totalLines = lines.length;
  if (totalLines < COLUMN_MIN_LINES) return [hits];

  // === Step 2: 收集候選分界線 ===
  const candidates: { separator: number; source: string }[] = [];

  // --- 候選來源 1：行內 gap 定位法 ---
  // 對每行找出最大 X gap（相鄰 hits 之間的間距），收集 gap 中點位置
  const LINE_GAP_MIN = 5; // 最小 gap 閾值（歸一化單位）
  const GAP_CLUSTER_RANGE = 50; // 聚類範圍：gap 位置差距 < 此值歸為同一組
  const gapPositions: number[] = [];

  for (const line of lines) {
    if (line.length < 2) continue;
    const sortedLine = [...line].sort((a, b) => a.normX - b.normX);
    let maxGap = 0;
    let maxGapCenter = 0;
    for (let i = 1; i < sortedLine.length; i++) {
      const gap = sortedLine[i].normX - sortedLine[i - 1].normRight;
      if (gap > maxGap) {
        maxGap = gap;
        maxGapCenter = (sortedLine[i - 1].normRight + sortedLine[i].normX) / 2;
      }
    }
    if (maxGap > LINE_GAP_MIN) {
      gapPositions.push(maxGapCenter);
    }
  }

  // 聚類：排序後找連續的 gap 位置（差距 < GAP_CLUSTER_RANGE 歸為同一組）
  if (gapPositions.length >= 2) {
    gapPositions.sort((a, b) => a - b);
    const clusters: number[][] = [[gapPositions[0]]];
    for (let i = 1; i < gapPositions.length; i++) {
      const lastCluster = clusters[clusters.length - 1];
      if (gapPositions[i] - lastCluster[lastCluster.length - 1] < GAP_CLUSTER_RANGE) {
        lastCluster.push(gapPositions[i]);
      } else {
        clusters.push([gapPositions[i]]);
      }
    }

    // 取最大聚類的中位數，且聚類行數 >= 40% 總行數
    clusters.sort((a, b) => b.length - a.length);
    const bestCluster = clusters[0];
    if (bestCluster.length >= Math.ceil(totalLines * 0.4)) {
      const median = bestCluster[Math.floor(bestCluster.length / 2)];
      candidates.push({ separator: median, source: '行內gap' });
    }

    console.log(
      `[pdfTextExtract][${_ts()}] 🔎 行內 gap 定位: gapPositions=${gapPositions.length}` +
      `, clusters=${clusters.map(c => `[n=${c.length}, median=${Math.round(c[Math.floor(c.length / 2)])}]`).join(', ')}` +
      (candidates.length > 0 ? `, → 候選 sep=${Math.round(candidates[0].separator)}` : `, → 無有效聚類`)
    );
  }

  // --- 候選來源 2：投影法低覆蓋帶 ---
  let globalMinX = Infinity, globalMaxX = -Infinity;
  for (const h of hits) {
    if (h.normX < globalMinX) globalMinX = h.normX;
    if (h.normRight > globalMaxX) globalMaxX = h.normRight;
  }
  const numBuckets = Math.ceil((globalMaxX - globalMinX) / COLUMN_BUCKET_WIDTH) + 1;
  const coverage = new Int32Array(numBuckets);

  for (const line of lines) {
    const lineIntervals = line.map(h => [h.normX, h.normRight] as [number, number]);
    lineIntervals.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [[lineIntervals[0][0], lineIntervals[0][1]]];
    for (let i = 1; i < lineIntervals.length; i++) {
      const last = merged[merged.length - 1];
      if (lineIntervals[i][0] <= last[1]) {
        last[1] = Math.max(last[1], lineIntervals[i][1]);
      } else {
        merged.push([lineIntervals[i][0], lineIntervals[i][1]]);
      }
    }
    for (const [left, right] of merged) {
      const startB = Math.max(0, Math.floor((left - globalMinX) / COLUMN_BUCKET_WIDTH));
      const endB = Math.min(numBuckets - 1, Math.floor((right - globalMinX) / COLUMN_BUCKET_WIDTH));
      for (let b = startB; b <= endB; b++) {
        coverage[b]++;
      }
    }
  }

  const probeThreshold = Math.max(1, Math.ceil(totalLines * COLUMN_PROBE_COVERAGE_RATIO));
  interface LowBand { startX: number; endX: number; minCov: number }
  const lowBands: LowBand[] = [];
  let bandStart = -1;
  let bandMinCov = Infinity;

  for (let b = 0; b < numBuckets; b++) {
    if (coverage[b] < probeThreshold) {
      if (bandStart === -1) { bandStart = b; bandMinCov = coverage[b]; }
      bandMinCov = Math.min(bandMinCov, coverage[b]);
    } else {
      if (bandStart !== -1) {
        const startX = globalMinX + bandStart * COLUMN_BUCKET_WIDTH;
        const endX = globalMinX + b * COLUMN_BUCKET_WIDTH;
        if (endX - startX >= COLUMN_PROBE_MIN_WIDTH) {
          lowBands.push({ startX, endX, minCov: bandMinCov });
        }
        bandStart = -1;
        bandMinCov = Infinity;
      }
    }
  }

  for (const band of lowBands) {
    const bandSep = (band.startX + band.endX) / 2;
    // 避免加入和行內 gap 候選太接近的（重複）
    const isDuplicate = candidates.some(c => Math.abs(c.separator - bandSep) < GAP_CLUSTER_RANGE);
    if (!isDuplicate) {
      candidates.push({ separator: bandSep, source: `投影法(w=${Math.round(band.endX - band.startX)},cov=${band.minCov})` });
    }
  }

  if (candidates.length === 0) {
    console.log(`[pdfTextExtract][${_ts()}] ⏭️ splitIntoColumns: no candidates → single column`);
    return [hits];
  }

  // === Step 3: 對每個候選做 baseline 對齊法測試，選最佳 ===
  let bestResult: ReturnType<typeof testSeparator> = null;
  let bestSource = '';

  for (const cand of candidates) {
    const result = testSeparator(hits, cand.separator);
    if (!result) continue;

    console.log(`[pdfTextExtract][${_ts()}] 🔎 候選[${cand.source}]: ${result.detail}`);

    if (!bestResult || result.exclusiveRatio > bestResult.exclusiveRatio) {
      bestResult = result;
      bestSource = cand.source;
    }
  }

  if (!bestResult) {
    console.log(`[pdfTextExtract][${_ts()}] ⏭️ splitIntoColumns: all candidates failed safety checks → single column`);
    return [hits];
  }

  // === Step 4: 判定是否為多欄 ===
  if (bestResult.exclusiveRatio > COLUMN_EXCLUSIVE_RATIO) {
    console.log(
      `[pdfTextExtract][${_ts()}] 📊 偵測到 2 欄佈局（${bestSource}）：${bestResult.detail}`
    );
    return [bestResult.leftHits, bestResult.rightHits];
  }

  // Fallback：投影法嚴格判斷（baseline 恰好對齊但覆蓋率極低）
  if (lowBands.length > 0) {
    lowBands.sort((a, b) => (b.endX - b.startX) - (a.endX - a.startX));
    const best = lowBands[0];
    const strictThreshold = Math.max(1, Math.ceil(totalLines * COLUMN_STRICT_COVERAGE_RATIO));
    if (best.minCov < strictThreshold && (best.endX - best.startX) >= COLUMN_STRICT_MIN_WIDTH) {
      // 用這個 lowBand 的中點重新分
      const fallbackResult = testSeparator(hits, (best.startX + best.endX) / 2);
      if (fallbackResult) {
        console.log(
          `[pdfTextExtract][${_ts()}] 📊 偵測到 2 欄佈局（投影法 strict fallback）：${fallbackResult.detail}`
        );
        return [fallbackResult.leftHits, fallbackResult.rightHits];
      }
    }
  }

  console.log(
    `[pdfTextExtract][${_ts()}] ⏭️ splitIntoColumns: best exclusiveRatio=${(bestResult.exclusiveRatio * 100).toFixed(0)}%` +
    ` ≤ ${(COLUMN_EXCLUSIVE_RATIO * 100).toFixed(0)}% → single column`
  );
  return [hits]; // 單欄
}

/**
 * 把一組 hits 按閱讀順序排序並拼接成文字
 * 排序：先按 baseline（上→下），baseline 相近的按 X（左→右）
 * 同一行內若偵測到明顯水平間距（表格不同欄），自動插入 TAB
 */
function formatColumnText(hits: Hit[]): string {
  if (hits.length === 0) return '';

  // 按閱讀順序排序：先按 baseline（上→下），baseline 相近的按 X（左→右）
  // 使用 baseline 而非 top 座標，因為同一行不同字體大小的文字 baseline 一致
  hits.sort((a, b) => {
    const baselineDiff = a.normBaseline - b.normBaseline;
    if (Math.abs(baselineDiff) < SAME_LINE_THRESHOLD) return a.normX - b.normX;
    return baselineDiff;
  });

  // 拼接文字：同一行的直接拼接，換行用 \n
  // 同一行內，若兩個文字項間距 > 閾值（表格不同欄），插入 TAB
  const COL_GAP_THRESHOLD = 30; // 歸一化單位，約頁面寬度 3%
  let text = '';
  let lastBaseline = -Infinity;
  let lastRight = -Infinity;
  for (const hit of hits) {
    const sameLine = lastBaseline !== -Infinity && Math.abs(hit.normBaseline - lastBaseline) < SAME_LINE_THRESHOLD;
    if (!sameLine && lastBaseline !== -Infinity) {
      text += '\n';
      lastRight = -Infinity;
    } else if (sameLine && lastRight !== -Infinity) {
      const gap = hit.normX - lastRight;
      if (gap > COL_GAP_THRESHOLD) {
        text += '\t';
      }
    }
    text += hit.str;
    lastBaseline = hit.normBaseline;
    lastRight = hit.normRight;
  }

  return text;
}

/**
 * 從指定 bbox 中提取文字（收集交集文字項 + 多欄偵測 + 按閱讀順序拼接）
 * 若偵測到多欄佈局，先提取左欄全部文字、再提取右欄，避免左右混合
 */
function extractTextFromBbox(
  bbox: [number, number, number, number],
  textItems: NormTextItem[],
): string {
  const [x1, y1, x2, y2] = bbox;

  // 收集與 bbox 有交集的文字項（含右邊緣座標與 baseline，用於排序和欄間距計算）
  const hits: Hit[] = [];

  for (const ti of textItems) {
    const tiRight = ti.normX + ti.normW;
    if (ti.normX < x2 && tiRight > x1 && ti.normY < y2 && ti.normBaseline > y1) {
      hits.push({ str: ti.str, normX: ti.normX, normBaseline: ti.normBaseline, normRight: tiRight });
    }
  }

  // Debug: 印出 bbox 範圍和 hits 的 X 分布摘要
  if (hits.length > 0) {
    const hMinX = Math.min(...hits.map(h => h.normX));
    const hMaxX = Math.max(...hits.map(h => h.normRight));
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(
      `[pdfTextExtract][${ts}] 🔍 extractTextFromBbox: bbox=[${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)}]` +
      `, hits=${hits.length}, X range=[${Math.round(hMinX)}-${Math.round(hMaxX)}]`
    );
  }

  // 偵測多欄佈局
  const columns = splitIntoColumns(hits);

  if (columns.length <= 1) {
    // 單欄：直接排序拼接
    return formatColumnText(hits);
  }

  // 多欄：每欄獨立提取，欄間空一行分隔
  return columns.map(col => formatColumnText(col)).join('\n\n');
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
