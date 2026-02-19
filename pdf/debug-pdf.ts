/**
 * PDF 文字層 Debug 工具 — 統一診斷腳本
 *
 * 功能：離線檢視 PDF 文字項、行分組、bbox 校正、文字提取的完整流程
 * 用於排查 pdfTextExtractCore 的各種問題（行合併、多欄偵測、bbox 校正等）
 * 依賴：pdfjs-dist（與專案共用同一版本）、pdfTextExtractCore（共用演算法核心，零重複）
 *
 * 子命令：
 *   items   — 顯示所有文字項 + 自適應閾值 + 危險行距 + 行距統計
 *   lines   — 顯示行分組結果（含自適應閾值 + 碎片重組）
 *   extract — 模擬完整提取流程（snap → resolve → enforce → descender → 多欄偵測 → 提取文字）
 *   batch   — 批次掃描目錄下所有 PDF
 *
 * 用法：
 *   npx tsx debug-pdf.ts items <file> [page=1]
 *   npx tsx debug-pdf.ts lines <file> [page=1]
 *   npx tsx debug-pdf.ts extract <file> <page> <x1,y1,x2,y2> [x1,y1,x2,y2 ...]
 *   npx tsx debug-pdf.ts batch [dir=.] [page=1]
 */

// @ts-ignore — legacy build 沒有獨立 TS 宣告
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';

// ============================================================
// 從共用核心 import — 演算法只維護一份
// ============================================================
import {
  type NormTextItem,
  type Hit,
  NORMALIZED_MAX,
  SAME_LINE_THRESHOLD,
  MIN_VERTICAL_GAP,
  snapBboxToText,
  resolveOverlappingLines,
  enforceMinVerticalGap,
  applyDescenderCompensation,
  splitIntoColumns,
  formatColumnText,
} from '../src/lib/pdfTextExtractCore';

type Bbox = [number, number, number, number];

// ============================================================
// CLI 工具
// ============================================================

/**
 * 解析檔案路徑（支援 glob 模式，解決 PowerShell 中文編碼問題）
 * 若路徑含 * 或 ? → 在目錄中搜尋符合的 PDF 檔案
 * 若找到多個符合的檔案 → 選第一個並提示
 */
function resolveFilePath(inputPath: string): string {
  if (existsSync(inputPath)) return inputPath;

  const dir = dirname(inputPath) || '.';
  const pattern = basename(inputPath);
  if (!/[*?]/.test(pattern)) {
    // 非 glob，嘗試模糊匹配（檔名包含指定字串）
    try {
      const files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pdf') && f.includes(pattern));
      if (files.length === 1) return join(dir, files[0]);
      if (files.length > 1) {
        console.log(`  ⚠️ 找到 ${files.length} 個符合的檔案，使用第一個:`);
        files.forEach((f, i) => console.log(`    ${i === 0 ? '→' : ' '} ${f}`));
        return join(dir, files[0]);
      }
    } catch { /* ignore */ }
    return inputPath;
  }

  // glob 模式匹配
  try {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    const files = readdirSync(dir).filter(f => regex.test(f) && f.toLowerCase().endsWith('.pdf'));
    if (files.length === 0) {
      console.error(`  ❌ 無符合 "${pattern}" 的 PDF 檔案 (在 ${resolve(dir)})`);
      process.exit(1);
    }
    if (files.length > 1) {
      console.log(`  ⚠️ 找到 ${files.length} 個符合的檔案，使用第一個:`);
      files.forEach((f, i) => console.log(`    ${i === 0 ? '→' : ' '} ${f}`));
    }
    return join(dir, files[0]);
  } catch {
    return inputPath;
  }
}

/** 載入 PDF 並取得指定頁面的歸一化文字項 */
async function loadPage(filePath: string, pageNum: number) {
  const data = new Uint8Array(readFileSync(filePath));
  const doc = await (getDocument as any)({ data }).promise;
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  const { width: vw, height: vh } = viewport;
  const textContent = await page.getTextContent();

  const items: NormTextItem[] = [];
  for (const item of textContent.items) {
    if (!('transform' in item) || !('str' in item)) continue;
    const ti = item as any;
    if (!ti.str.trim()) continue;
    const tx = ti.transform[4], ty = ti.transform[5];
    const w = ti.width, h = ti.height;
    const normX = (tx / vw) * NORMALIZED_MAX;
    const normY = ((vh - ty - h) / vh) * NORMALIZED_MAX;
    const normW = (w / vw) * NORMALIZED_MAX;
    const normH = (h / vh) * NORMALIZED_MAX;
    items.push({ str: ti.str, normX, normY, normW, normH, normBaseline: normY + normH });
  }

  return { doc, page, vw, vh, items, numPages: doc.numPages as number };
}

// ============================================================
// 顯示工具
// ============================================================

/** 印出文字項表格 */
function printItems(items: NormTextItem[]) {
  console.log(`\n  [${items.length} text items]`);
  console.log('    bl |   Y |  H |    X ~    R | str');
  console.log('  ' + '-'.repeat(84));
  const sorted = [...items].sort((a, b) => a.normBaseline - b.normBaseline || a.normX - b.normX);
  for (const it of sorted) {
    const right = Math.round(it.normX + it.normW);
    console.log(
      `  ${String(Math.round(it.normBaseline)).padStart(4)} |` +
      `${String(Math.round(it.normY)).padStart(4)} |` +
      `${String(Math.round(it.normH)).padStart(3)} |` +
      `${String(Math.round(it.normX)).padStart(5)} ~${String(right).padStart(5)} |` +
      ` ${it.str.substring(0, 65)}`
    );
  }
}

/** 印出文字項表格（標記 bbox 內的 items） */
function printItemsWithBbox(items: NormTextItem[], bboxes: Bbox[]) {
  const sorted = [...items].sort((a, b) => a.normBaseline - b.normBaseline || a.normX - b.normX);
  console.log('    bl |   Y |  H |    X ~    R | box | str');
  console.log('  ' + '-'.repeat(90));
  for (const it of sorted) {
    const right = Math.round(it.normX + it.normW);
    let boxLabel = '   ';
    for (let bi = 0; bi < bboxes.length; bi++) {
      const [x1, y1, x2, y2] = bboxes[bi];
      if (it.normX < x2 && (it.normX + it.normW) > x1 && it.normY < y2 && it.normBaseline > y1) {
        boxLabel = ` ${String(bi + 1).padStart(1)}★`;
        break;
      }
    }
    console.log(
      `  ${String(Math.round(it.normBaseline)).padStart(4)} |` +
      `${String(Math.round(it.normY)).padStart(4)} |` +
      `${String(Math.round(it.normH)).padStart(3)} |` +
      `${String(Math.round(it.normX)).padStart(5)} ~${String(right).padStart(5)} |` +
      `${boxLabel} |` +
      ` ${it.str.substring(0, 60)}`
    );
  }
}

// ============================================================
// Debug 分析（閾值 + 行分組）
// ============================================================

function computeMicroClusters(items: NormTextItem[]) {
  const baselines = items.map(it => Math.round(it.normBaseline));
  baselines.sort((a, b) => a - b);
  if (baselines.length === 0) return { clusters: [] as { baseline: number; count: number }[], threshold: SAME_LINE_THRESHOLD, source: '預設', stableClusters: [] as { baseline: number; count: number }[] };

  const clusters: { baseline: number; count: number }[] = [{ baseline: baselines[0], count: 1 }];
  for (let i = 1; i < baselines.length; i++) {
    const last = clusters[clusters.length - 1];
    if (baselines[i] - last.baseline < 3) last.count++;
    else clusters.push({ baseline: baselines[i], count: 1 });
  }

  let threshold = SAME_LINE_THRESHOLD;
  let source = '預設';

  const stableClusters = clusters.filter(c => c.count >= 2);
  if (stableClusters.length >= 2) {
    const spacings: number[] = [];
    for (let i = 1; i < stableClusters.length; i++) {
      spacings.push(stableClusters[i].baseline - stableClusters[i - 1].baseline);
    }
    const minSpacing = Math.min(...spacings);
    if (minSpacing > 3 && minSpacing < SAME_LINE_THRESHOLD) {
      threshold = Math.max(3, minSpacing * 0.7);
      source = `穩定行距(min=${minSpacing})`;
    }
  }

  if (threshold === SAME_LINE_THRESHOLD && clusters.length >= 3) {
    const spacings: number[] = [];
    for (let i = 1; i < clusters.length; i++) {
      spacings.push(clusters[i].baseline - clusters[i - 1].baseline);
    }
    spacings.sort((a, b) => a - b);
    const median = spacings[Math.floor(spacings.length / 2)];
    if (median > 3 && median < SAME_LINE_THRESHOLD) {
      threshold = Math.max(3, median * 0.7);
      source = `fallback中位數(med=${median})`;
    }
  }

  return { clusters, threshold, source, stableClusters };
}

function printThresholdAnalysis(items: NormTextItem[]) {
  const { clusters, threshold, source, stableClusters } = computeMicroClusters(items);

  console.log(`\n  📏 自適應閾值分析`);
  console.log(`  穩定聚類(≥2 items): ${stableClusters.length} 個`);
  if (stableClusters.length >= 2) {
    const spacings: number[] = [];
    for (let i = 1; i < stableClusters.length; i++) {
      spacings.push(stableClusters[i].baseline - stableClusters[i - 1].baseline);
    }
    console.log(`  穩定間距: [${spacings.join(', ')}], min=${Math.min(...spacings)}`);
  }
  console.log(`  最終閾值: ${threshold.toFixed(1)} (${source})`);

  // 危險行距
  const dangers: { from: number; to: number; gap: number; aStr: string; bStr: string }[] = [];
  for (let i = 1; i < clusters.length; i++) {
    const gap = clusters[i].baseline - clusters[i - 1].baseline;
    if (gap > 3 && gap < threshold) {
      const fromItems = items.filter(it => Math.abs(Math.round(it.normBaseline) - clusters[i - 1].baseline) < 3);
      const toItems = items.filter(it => Math.abs(Math.round(it.normBaseline) - clusters[i].baseline) < 3);
      dangers.push({
        from: clusters[i - 1].baseline, to: clusters[i].baseline, gap,
        aStr: fromItems.map(x => x.str.substring(0, 25)).join('|'),
        bStr: toItems.map(x => x.str.substring(0, 25)).join('|'),
      });
    }
  }

  if (dangers.length > 0) {
    console.log(`\n  ❌ 危險：${dangers.length} 對行距 < threshold 會被合併：`);
    for (const d of dangers) {
      console.log(`    bl ${d.from} → ${d.to} (gap=${d.gap}): "${d.aStr}" + "${d.bStr}"`);
    }
  } else {
    console.log(`  ✅ 無危險合併`);
  }

  // 行距統計
  const lineGaps: number[] = [];
  for (let i = 1; i < clusters.length; i++) {
    lineGaps.push(clusters[i].baseline - clusters[i - 1].baseline);
  }
  lineGaps.sort((a, b) => a - b);
  if (lineGaps.length > 0) {
    console.log(`  行距: min=${lineGaps[0]} med=${lineGaps[Math.floor(lineGaps.length / 2)]} max=${lineGaps[lineGaps.length - 1]}`);
    console.log(`  前5小: [${lineGaps.slice(0, 5).join(', ')}]`);
  }

  return { clusters, threshold };
}

/** 行分組 for display — 使用自適應閾值 + Y 重疊合併 + 碎片重組 */
function groupItemsIntoDisplayLines(items: NormTextItem[]) {
  const sorted = [...items].sort((a, b) => a.normBaseline - b.normBaseline);
  if (sorted.length === 0) return { lines: [] as NormTextItem[][], threshold: SAME_LINE_THRESHOLD, mergeLog: [] as string[], fragmentLog: [] as string[] };

  // 自適應閾值
  let lineThreshold = SAME_LINE_THRESHOLD;
  if (sorted.length >= 4) {
    const microClusters: { baseline: number; count: number }[] = [{ baseline: sorted[0].normBaseline, count: 1 }];
    for (let i = 1; i < sorted.length; i++) {
      const last = microClusters[microClusters.length - 1];
      if (sorted[i].normBaseline - last.baseline < 3) last.count++;
      else microClusters.push({ baseline: sorted[i].normBaseline, count: 1 });
    }
    const stableClusters = microClusters.filter(c => c.count >= 2);
    if (stableClusters.length >= 2) {
      let minSpacing = Infinity;
      for (let i = 1; i < stableClusters.length; i++) {
        minSpacing = Math.min(minSpacing, stableClusters[i].baseline - stableClusters[i - 1].baseline);
      }
      if (minSpacing > 3 && minSpacing < SAME_LINE_THRESHOLD) {
        lineThreshold = Math.max(3, minSpacing * 0.7);
      }
    }
    if (lineThreshold === SAME_LINE_THRESHOLD && microClusters.length >= 3) {
      const spacings: number[] = [];
      for (let i = 1; i < microClusters.length; i++) {
        spacings.push(microClusters[i].baseline - microClusters[i - 1].baseline);
      }
      spacings.sort((a, b) => a - b);
      const med = spacings[Math.floor(spacings.length / 2)];
      if (med > 3 && med < SAME_LINE_THRESHOLD) {
        lineThreshold = Math.max(3, med * 0.7);
      }
    }
  }

  // 聚類分行 + Y 重疊合併
  const lines: NormTextItem[][] = [[sorted[0]]];
  const coreYRanges: { top: number; bottom: number }[] = [{ top: sorted[0].normY, bottom: sorted[0].normBaseline }];
  const mergeLog: string[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const lastLine = lines[lines.length - 1];
    const coreYRange = coreYRanges[coreYRanges.length - 1];

    if (sorted[i].normBaseline - lastLine[0].normBaseline < lineThreshold) {
      lastLine.push(sorted[i]);
      coreYRange.top = Math.min(coreYRange.top, sorted[i].normY);
      coreYRange.bottom = Math.max(coreYRange.bottom, sorted[i].normBaseline);
    } else {
      const overlapTop = Math.max(coreYRange.top, sorted[i].normY);
      const overlapBottom = Math.min(coreYRange.bottom, sorted[i].normBaseline);
      if (overlapBottom > overlapTop) {
        mergeLog.push(`Y-overlap: "${sorted[i].str.substring(0, 30)}" → 合併到行 ${lines.length}`);
        lastLine.push(sorted[i]);
      } else {
        lines.push([sorted[i]]);
        coreYRanges.push({ top: sorted[i].normY, bottom: sorted[i].normBaseline });
      }
    }
  }

  for (const line of lines) {
    line.sort((a, b) => a.normX - b.normX);
  }

  // 碎片重組
  const fragmentLog: string[] = [];
  if (lines.length >= 3) {
    const getXInfo = (line: NormTextItem[]) => {
      const minX = Math.min(...line.map(h => h.normX));
      const maxX = Math.max(...line.map(h => h.normX + h.normW));
      return { minX, maxX, span: maxX - minX };
    };
    const lineXInfos = lines.map(getXInfo);
    const sortedSpans = lineXInfos.map(li => li.span).sort((a, b) => a - b);
    const refSpan = sortedSpans[Math.floor(sortedSpans.length * 0.75)];

    if (refSpan > 50) {
      const FRAGMENT_RATIO = 0.7;
      const MAX_MERGE_DISTANCE = 3;
      const BASELINE_MERGE_LIMIT = lineThreshold * 2.5;
      const COMPLEMENT_RATIO = 1.2;

      for (let i = 0; i < lines.length; i++) {
        if (lineXInfos[i].span >= refSpan * FRAGMENT_RATIO) continue;
        for (let j = i + 1; j < Math.min(i + MAX_MERGE_DISTANCE + 1, lines.length); j++) {
          if (lineXInfos[j].span >= refSpan * FRAGMENT_RATIO) continue;
          const blDiff = Math.abs(lines[i][0].normBaseline - lines[j][0].normBaseline);
          if (blDiff > BASELINE_MERGE_LIMIT) continue;
          const combinedMinX = Math.min(lineXInfos[i].minX, lineXInfos[j].minX);
          const combinedMaxX = Math.max(lineXInfos[i].maxX, lineXInfos[j].maxX);
          const combinedSpan = combinedMaxX - combinedMinX;
          if (combinedSpan < Math.max(lineXInfos[i].span, lineXInfos[j].span) * COMPLEMENT_RATIO) continue;
          fragmentLog.push(
            `合併行[${i}](X=${Math.round(lineXInfos[i].minX)}-${Math.round(lineXInfos[i].maxX)})` +
            ` + 行[${j}](X=${Math.round(lineXInfos[j].minX)}-${Math.round(lineXInfos[j].maxX)})`
          );
          lines[i].push(...lines[j]);
          lines[i].sort((a, b) => a.normX - b.normX);
          lines.splice(j, 1);
          lineXInfos[i] = { minX: combinedMinX, maxX: combinedMaxX, span: combinedSpan };
          lineXInfos.splice(j, 1);
          j--;
        }
      }
    }
  }

  return { lines, threshold: lineThreshold, mergeLog, fragmentLog };
}

// ============================================================
// Debug wrappers — 薄包裝 core 函式，補充前後對比 log
// ============================================================

/** Snap + 前後對比 log */
function snapWithLog(bbox: Bbox, items: NormTextItem[], otherBboxes?: Bbox[]) {
  const original: Bbox = [...bbox];
  const result = snapBboxToText([...bbox], items, undefined, otherBboxes);
  const log: string[] = [];
  const labels = ['x1', 'y1', 'x2', 'y2'];
  for (let i = 0; i < 4; i++) {
    if (Math.round(original[i]) !== Math.round(result[i])) {
      log.push(`${labels[i]}: ${Math.round(original[i])} → ${Math.round(result[i])}`);
    }
  }
  return { bbox: result, log };
}

/** Resolve + 前後對比 log */
function resolveWithLog(bboxes: Bbox[], items: NormTextItem[]): string[] {
  const before = bboxes.map(b => [...b] as Bbox);
  resolveOverlappingLines(bboxes, items);
  const log: string[] = [];
  for (let i = 0; i < bboxes.length; i++) {
    const changes: string[] = [];
    if (Math.round(before[i][1]) !== Math.round(bboxes[i][1]))
      changes.push(`y1: ${Math.round(before[i][1])} → ${Math.round(bboxes[i][1])}`);
    if (Math.round(before[i][3]) !== Math.round(bboxes[i][3]))
      changes.push(`y2: ${Math.round(before[i][3])} → ${Math.round(bboxes[i][3])}`);
    if (changes.length > 0) log.push(`box${i + 1}: ${changes.join(', ')}`);
  }
  return log;
}

/** Enforce + 前後對比 log */
function enforceWithLog(bboxes: Bbox[]): string[] {
  const before = bboxes.map(b => [...b] as Bbox);
  enforceMinVerticalGap(bboxes);
  const log: string[] = [];
  for (let i = 0; i < bboxes.length; i++) {
    const changes: string[] = [];
    if (Math.round(before[i][1]) !== Math.round(bboxes[i][1]))
      changes.push(`y1: ${Math.round(before[i][1])} → ${Math.round(bboxes[i][1])}`);
    if (Math.round(before[i][3]) !== Math.round(bboxes[i][3]))
      changes.push(`y2: ${Math.round(before[i][3])} → ${Math.round(bboxes[i][3])}`);
    if (changes.length > 0) log.push(`box${i + 1}: ${changes.join(', ')}`);
  }
  return log;
}

/** Descender + 前後對比 log */
function descenderWithLog(bboxes: Bbox[], items: NormTextItem[]): string[] {
  const before = bboxes.map(b => [...b] as Bbox);
  applyDescenderCompensation(bboxes, items);
  const log: string[] = [];
  for (let i = 0; i < bboxes.length; i++) {
    if (Math.round(before[i][3]) !== Math.round(bboxes[i][3])) {
      log.push(`box${i + 1}: y2 ${Math.round(before[i][3])} → ${Math.round(bboxes[i][3])}`);
    }
  }
  return log;
}

/** extractTextFromBbox + 回傳 hits/columns 供 debug 顯示 */
function extractWithDebug(bbox: Bbox, items: NormTextItem[]) {
  const [x1, y1, x2, y2] = bbox;
  // 收集 hits（與 core extractTextFromBbox 相同的過濾邏輯）
  const hits: Hit[] = [];
  for (const ti of items) {
    const tiRight = ti.normX + ti.normW;
    if (ti.normX < x2 && tiRight > x1 && ti.normY < y2 && ti.normBaseline > y1) {
      hits.push({ str: ti.str, normX: ti.normX, normBaseline: ti.normBaseline, normRight: tiRight, normY: ti.normY });
    }
  }
  // 使用 core 的多欄偵測和文字提取（console.log 會自動輸出）
  const columns = splitIntoColumns(hits);
  const text = columns.length <= 1
    ? formatColumnText(hits)
    : columns.map(col => formatColumnText(col)).join('\n\n');
  return { text, hits, columns };
}

// ============================================================
// 子命令：items
// ============================================================

async function cmdItems(filePath: string, pageNum: number) {
  const fileName = filePath.split(/[/\\]/).pop();
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  📄 ${fileName}  (page ${pageNum})`);
  console.log(`${'='.repeat(90)}`);

  const { doc, vw, vh, items, numPages } = await loadPage(filePath, pageNum);
  console.log(`  Pages: ${numPages}, Size: ${vw.toFixed(0)}×${vh.toFixed(0)}, Items: ${items.length}`);

  printItems(items);
  printThresholdAnalysis(items);

  await doc.destroy();
}

// ============================================================
// 子命令：lines
// ============================================================

async function cmdLines(filePath: string, pageNum: number) {
  const fileName = filePath.split(/[/\\]/).pop();
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  📄 ${fileName}  (page ${pageNum})`);
  console.log(`${'='.repeat(90)}`);

  const { doc, vw, vh, items } = await loadPage(filePath, pageNum);
  console.log(`  Size: ${vw.toFixed(0)}×${vh.toFixed(0)}, Items: ${items.length}`);

  const { lines, threshold, mergeLog, fragmentLog } = groupItemsIntoDisplayLines(items);

  console.log(`\n  📏 lineThreshold = ${threshold.toFixed(1)}`);
  console.log(`  共 ${lines.length} 行\n`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const baselines = line.map(h => Math.round(h.normBaseline));
    const minBl = Math.min(...baselines);
    const maxBl = Math.max(...baselines);
    const blRange = minBl === maxBl ? `bl=${minBl}` : `bl=${minBl}-${maxBl}`;
    const minX = Math.min(...line.map(h => Math.round(h.normX)));
    const maxX = Math.max(...line.map(h => Math.round(h.normX + h.normW)));
    const lineText = line.map(h => h.str).join('');
    const gap = i > 0
      ? `  gap=${(line[0].normBaseline - lines[i - 1][0].normBaseline).toFixed(1)}`
      : '';

    console.log(
      `  行${String(i + 1).padStart(3)} | ${blRange.padEnd(12)} | X=[${String(minX).padStart(4)}-${String(maxX).padStart(4)}] |` +
      ` ${String(line.length).padStart(2)} items |${gap}`
    );
    console.log(`        └ ${lineText.substring(0, 100)}`);
  }

  if (mergeLog.length > 0) {
    console.log(`\n  🔀 Y-overlap 合併記錄：`);
    for (const m of mergeLog) console.log(`    ${m}`);
  }

  if (fragmentLog.length > 0) {
    console.log(`\n  🔗 碎片重組記錄：`);
    for (const f of fragmentLog) console.log(`    ${f}`);
  }

  // 行距統計
  if (lines.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      gaps.push(lines[i][0].normBaseline - lines[i - 1][0].normBaseline);
    }
    gaps.sort((a, b) => a - b);
    console.log(`\n  行距統計: min=${gaps[0].toFixed(1)} med=${gaps[Math.floor(gaps.length / 2)].toFixed(1)} max=${gaps[gaps.length - 1].toFixed(1)}`);
  }

  await doc.destroy();
}

// ============================================================
// 子命令：extract
// ============================================================

function parseBbox(str: string): Bbox | null {
  const parts = str.split(',').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return null;
  return parts as unknown as Bbox;
}

async function cmdExtract(filePath: string, pageNum: number, bboxStrs: string[]) {
  const fileName = filePath.split(/[/\\]/).pop();
  console.log(`\n${'='.repeat(90)}`);
  console.log(`  📄 ${fileName}  (page ${pageNum})`);
  console.log(`${'='.repeat(90)}`);

  const inputBboxes = bboxStrs.map(parseBbox);
  if (inputBboxes.some(b => b === null)) {
    console.error('  ❌ bbox 格式錯誤，請用 x1,y1,x2,y2');
    return;
  }
  const bboxes = inputBboxes as Bbox[];

  const { doc, vw, vh, items } = await loadPage(filePath, pageNum);
  console.log(`  Size: ${vw.toFixed(0)}×${vh.toFixed(0)}, Items: ${items.length}`);

  console.log(`\n  輸入 ${bboxes.length} 個 bbox:`);
  bboxes.forEach((b, i) => console.log(`    box${i + 1}: [${b.map(v => Math.round(v)).join(', ')}]`));

  // Phase 1: Snap
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Phase 1: Snap (水平校正 + Y 軸半行補足)`);
  console.log(`${'─'.repeat(50)}`);

  const originalBboxes = bboxes.map(b => [...b] as Bbox);
  const snapped: Bbox[] = bboxes.map((b, i) => {
    const others = originalBboxes.filter((_, j) => j !== i);
    const { bbox: result, log } = snapWithLog(b, items, others.length > 0 ? others : undefined);
    const changed = log.length > 0;
    console.log(`  box${i + 1}: [${b.map(v => Math.round(v)).join(',')}] → [${result.map(v => Math.round(v)).join(',')}]${changed ? '' : ' (不變)'}`);
    if (log.length > 0) {
      for (const l of log) console.log(`    ${l}`);
    }
    return result;
  });

  // Phase 2: Resolve
  if (snapped.length >= 2) {
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Phase 2: Resolve (重疊行解衝突)`);
    console.log(`${'─'.repeat(50)}`);
    const resolveLog = resolveWithLog(snapped, items);
    if (resolveLog.length > 0) {
      for (const l of resolveLog) console.log(`  ${l}`);
    } else {
      console.log('  (無衝突)');
    }

    // Phase 2.5: Enforce
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Phase 2.5: Enforce Min Vertical Gap (間距 ≥ ${MIN_VERTICAL_GAP})`);
    console.log(`${'─'.repeat(50)}`);
    const enforceLog = enforceWithLog(snapped);
    if (enforceLog.length > 0) {
      for (const l of enforceLog) console.log(`  ${l}`);
    } else {
      console.log('  (間距充足)');
    }
  }

  // Phase 2.75: Descender
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Phase 2.75: Descender Compensation (降部補償)`);
  console.log(`${'─'.repeat(50)}`);
  const descLog = descenderWithLog(snapped, items);
  if (descLog.length > 0) {
    for (const l of descLog) console.log(`  ${l}`);
  } else {
    console.log('  (無降部補償)');
  }

  // 最終 bbox
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  最終 bbox:`);
  console.log(`${'─'.repeat(50)}`);
  snapped.forEach((b, i) => {
    const orig = bboxes[i];
    const changed = orig.some((v, j) => Math.round(v) !== Math.round(b[j]));
    console.log(`  box${i + 1}: [${orig.map(v => Math.round(v)).join(',')}] → [${b.map(v => Math.round(v)).join(',')}]${changed ? ' ⚡' : ' (不變)'}`);
  });

  // 顯示 bbox 內的 items
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  bbox 內文字項:`);
  console.log(`${'─'.repeat(50)}`);
  printItemsWithBbox(items, snapped);

  // Phase 3: 提取文字（使用 core 函式，console.log 會自動印出多欄偵測等 debug 資訊）
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Phase 3: 提取文字`);
  console.log(`${'─'.repeat(50)}`);

  for (let i = 0; i < snapped.length; i++) {
    const { text, hits, columns } = extractWithDebug(snapped[i], items);
    console.log(`\n  ── box${i + 1} [${snapped[i].map(v => Math.round(v)).join(',')}] ──`);
    console.log(`  命中 ${hits.length} 個 items`);
    console.log(`  欄數: ${columns.length}`);

    console.log(`\n  ┌──── 提取結果 ────`);
    const textLines = text.split('\n');
    for (const tl of textLines) {
      console.log(`  │ ${tl}`);
    }
    console.log(`  └────────────────`);
  }

  await doc.destroy();
}

// ============================================================
// 子命令：batch
// ============================================================

async function cmdBatch(dir: string, pageNum: number) {
  const pdfDir = resolve(dir);
  let files: string[];
  try {
    files = readdirSync(pdfDir).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
  } catch {
    console.error(`❌ 無法讀取目錄: ${pdfDir}`);
    return;
  }

  console.log(`\n  掃描 ${files.length} 個 PDF (${pdfDir}, page ${pageNum})\n`);

  for (const f of files) {
    try {
      const filePath = join(pdfDir, f);
      const { doc, items, numPages } = await loadPage(filePath, pageNum);
      const { threshold } = computeMicroClusters(items);

      // 快速統計
      const baselines = items.map(it => Math.round(it.normBaseline));
      baselines.sort((a, b) => a - b);
      const clusters: { baseline: number; count: number }[] = [{ baseline: baselines[0] || 0, count: 1 }];
      for (let i = 1; i < baselines.length; i++) {
        const last = clusters[clusters.length - 1];
        if (baselines[i] - last.baseline < 3) last.count++;
        else clusters.push({ baseline: baselines[i], count: 1 });
      }

      let dangerCount = 0;
      for (let i = 1; i < clusters.length; i++) {
        const gap = clusters[i].baseline - clusters[i - 1].baseline;
        if (gap > 3 && gap < threshold) dangerCount++;
      }

      const lineGaps: number[] = [];
      for (let i = 1; i < clusters.length; i++) {
        lineGaps.push(clusters[i].baseline - clusters[i - 1].baseline);
      }
      lineGaps.sort((a, b) => a - b);

      const status = dangerCount > 0 ? '❌' : '✅';
      const gapInfo = lineGaps.length > 0
        ? `gaps=[${lineGaps[0]},${lineGaps[Math.floor(lineGaps.length / 2)]},${lineGaps[lineGaps.length - 1]}]`
        : 'gaps=N/A';

      console.log(
        `  ${status} ${f.padEnd(50)} | ${String(numPages).padStart(3)}p | ` +
        `${String(items.length).padStart(4)} items | thr=${threshold.toFixed(1).padStart(5)} | ` +
        `${gapInfo} | danger=${dangerCount}`
      );

      await doc.destroy();
    } catch (e: any) {
      console.log(`  ❌ ${f.padEnd(50)} | Error: ${e.message}`);
    }
  }
}

// ============================================================
// 主程式
// ============================================================

function printUsage() {
  console.log(`
PDF 文字層 Debug 工具（共用 pdfTextExtractCore 演算法，零重複）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

用法：
  npx tsx debug-pdf.ts items <file> [page=1]
    顯示所有文字項 + 自適應閾值分析 + 危險行距 + 統計

  npx tsx debug-pdf.ts lines <file> [page=1]
    顯示行分組結果（自適應閾值 + Y重疊合併 + 碎片重組）

  npx tsx debug-pdf.ts extract <file> <page> <x1,y1,x2,y2> [x1,y1,x2,y2 ...]
    模擬完整提取流程：snap → resolve → enforce → descender → 多欄偵測 → 文字

  npx tsx debug-pdf.ts batch [dir=.] [page=1]
    批次掃描目錄下所有 PDF，快速檢視閾值和危險行距

範例：
  npx tsx debug-pdf.ts items ./sample.pdf
  npx tsx debug-pdf.ts items ./sample.pdf 3
  npx tsx debug-pdf.ts lines ./sample.pdf 2
  npx tsx debug-pdf.ts extract ./sample.pdf 1 50,100,950,500
  npx tsx debug-pdf.ts extract ./sample.pdf 1 50,100,480,900 520,100,950,900
  npx tsx debug-pdf.ts batch
  npx tsx debug-pdf.ts batch . 2
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const cmd = args[0];

  switch (cmd) {
    case 'items': {
      if (!args[1]) { console.error('❌ 請指定 PDF 檔案路徑'); printUsage(); process.exit(1); }
      const file = resolveFilePath(args[1]);
      const page = parseInt(args[2] || '1', 10);
      await cmdItems(file, page);
      break;
    }
    case 'lines': {
      if (!args[1]) { console.error('❌ 請指定 PDF 檔案路徑'); printUsage(); process.exit(1); }
      const file = resolveFilePath(args[1]);
      const page = parseInt(args[2] || '1', 10);
      await cmdLines(file, page);
      break;
    }
    case 'extract': {
      const file = args[1] ? resolveFilePath(args[1]) : null;
      const page = parseInt(args[2] || '1', 10);
      const bboxStrs = args.slice(3);
      if (!file || bboxStrs.length === 0) {
        console.error('❌ 請指定 PDF 檔案路徑和至少一個 bbox');
        printUsage();
        process.exit(1);
      }
      await cmdExtract(file, page, bboxStrs);
      break;
    }
    case 'batch': {
      const dir = args[1] || '.';
      const page = parseInt(args[2] || '1', 10);
      await cmdBatch(dir, page);
      break;
    }
    default:
      console.error(`❌ 未知子命令: ${cmd}`);
      printUsage();
      process.exit(1);
  }
}

main().catch(console.error);
