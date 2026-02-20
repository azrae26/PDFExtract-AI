/**
 * 功能：PDF 文字提取演算法回歸測試 runner
 * 職責：讀取 test-cases.json，對每個案例以 pdfjs-dist + pdfTextExtractCore 跑完整提取管線，
 *       比對提取文字與預期結果，輸出 PASS/FAIL 統計
 * 依賴：pdfjs-dist/legacy（PDF 載入）、pdfTextExtractCore（演算法核心，與生產程式碼共用同一份）
 *
 * 注意：本腳本刻意不 import pdfTextExtract.ts（該檔依賴 react-pdf，無法在 Node.js 環境執行），
 *       而是直接呼叫 pdfTextExtractCore 的純函式，複製相同的提取管線（Phase 0~2.75+3）
 *
 * 用法（在 pdfextract-ai/pdf/ 目錄下執行）：
 *   npx tsx run-extraction-tests.ts              # 執行全部案例
 *   npx tsx run-extraction-tests.ts --verbose    # 同時顯示完整提取文字內容
 *   npx tsx run-extraction-tests.ts --filter 5371   # 只跑 id 或 name 含關鍵字的案例
 *   npx tsx run-extraction-tests.ts --update     # 將實際結果寫回 test-cases.json 作為新基準
 */

// @ts-ignore — legacy build 沒有獨立 TS 宣告
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import {
  type NormTextItem,
  type SnapDebugCollector,
  type ExtractDebugCollector,
  NORMALIZED_MAX,
  findContainedBboxes,
  snapBboxToText,
  resolveXOverlaps,
  enforceMinVerticalGap,
  applyDescenderCompensation,
  extractTextFromBbox,
  isWingdingsFont,
  sanitizeWingdings,
} from '../src/lib/pdfTextExtractCore';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CASES_FILE = join(SCRIPT_DIR, 'test-cases.json');

// ──────────────────────────── Types ─────────────────────────────

interface RegionCase {
  regionId: number;
  label: string;
  /** 原始 AI bbox（對應 extractionDebug.phases.original），送入演算法前的輸入 */
  inputBbox: [number, number, number, number];
  /** 預期提取文字，與生產環境一致 */
  expectedText: string;
  /** 已知問題說明（不影響 PASS/FAIL 判定，僅供參考） */
  note?: string;
}

interface TestCase {
  id: string;
  name: string;
  pdfFile: string;
  page: number;
  regions: RegionCase[];
}

interface TestCasesFile {
  version: string;
  description: string;
  cases: TestCase[];
}

interface RegionResult {
  regionId: number;
  label: string;
  pass: boolean;
  actual: string;
  expected: string;
  hitsCount: number;
  note?: string;
}

interface CaseResult {
  id: string;
  name: string;
  pass: boolean;
  regionResults: RegionResult[];
  error?: string;
}

// ──────────────────────────── PDF 輔助 ───────────────────────────

/** 解析 PDF 路徑（支援模糊比對，解決 PowerShell 中文編碼問題） */
function resolvePdfPath(pdfFile: string): string {
  const direct = join(SCRIPT_DIR, pdfFile);
  if (existsSync(direct)) return direct;

  // fallback：掃描目錄，找第一個含有相同前4字元的 PDF
  const keyword = basename(pdfFile, '.pdf').slice(0, 4);
  const files = readdirSync(SCRIPT_DIR);
  const match = files.find(f => f.endsWith('.pdf') && f.includes(keyword));
  if (match) return join(SCRIPT_DIR, match);

  throw new Error(`找不到 PDF 檔案：${pdfFile}`);
}

/** 建立 NormTextItem 陣列（含 Wingdings 字型偵測與替換，與 pdfTextExtract.ts 邏輯相同） */
async function buildTextItems(page: any): Promise<NormTextItem[]> {
  const viewport = page.getViewport({ scale: 1 });
  const { width: vw, height: vh } = viewport;
  const textContent = await page.getTextContent();
  const styles = textContent.styles as Record<string, { fontFamily: string }>;

  // 路徑 1: fontFamily 快速掃描
  const wingdingsFonts = new Set<string>();
  for (const [fontName, style] of Object.entries(styles)) {
    if (style.fontFamily && isWingdingsFont(style.fontFamily)) {
      wingdingsFonts.add(fontName);
    }
  }

  // 路徑 2: getOperatorList → commonObjs（偵測 fontFamily 被抹平的情況）
  if (wingdingsFonts.size === 0) {
    try {
      await page.getOperatorList();
      for (const fontName of Object.keys(styles)) {
        try {
          const fontObj = page.commonObjs.get(fontName);
          if (fontObj?.name && isWingdingsFont(fontObj.name)) {
            wingdingsFonts.add(fontName);
          }
        } catch { /* 個別字型可能未 resolve，跳過 */ }
      }
    } catch { /* getOperatorList 失敗時靜默降級 */ }
  }

  const textItems: NormTextItem[] = [];
  for (const item of textContent.items) {
    if (!('transform' in item) || !('str' in item)) continue;
    const ti = item as any;
    if (!ti.str.trim()) continue;

    let str = ti.str;
    if (ti.fontName && wingdingsFonts.has(ti.fontName)) {
      str = sanitizeWingdings(str);
    }
    if (!str.trim()) continue;

    const tx = ti.transform[4];
    const ty = ti.transform[5];
    const w = ti.width;
    const h = ti.height;

    const normX = (tx / vw) * NORMALIZED_MAX;
    const normY = ((vh - ty - h) / vh) * NORMALIZED_MAX;
    const normW = (w / vw) * NORMALIZED_MAX;
    const normH = (h / vh) * NORMALIZED_MAX;

    textItems.push({ str, normX, normY, normW, normH, normBaseline: normY + normH });
  }

  return textItems;
}

// ──────────────────────────── 提取管線 ──────────────────────────

/**
 * 對一組 bbox 執行完整提取管線（複製 pdfTextExtract.ts 的 Phase 0 ~ Phase 3）
 * 傳入 inputBboxes（原始 AI bbox），回傳每個 bbox 的提取文字與 hits 數
 */
async function runExtractionPipeline(
  textItems: NormTextItem[],
  inputBboxes: [number, number, number, number][]
): Promise<{ text: string; hitsCount: number }[]> {
  // 追蹤哪些 index 被 Phase 0 移除，最後結果要映射回去
  const outputTexts: { text: string; hitsCount: number }[] = inputBboxes.map(() => ({ text: '', hitsCount: 0 }));

  let activeIndices = inputBboxes.map((_, i) => i);
  let bboxes: [number, number, number, number][] = inputBboxes.map(b => [...b] as [number, number, number, number]);

  // Phase 0: 去除被包含的框（面積交集 ≥ 95%）
  if (bboxes.length >= 2) {
    const containedIndices = findContainedBboxes(bboxes);
    if (containedIndices.size > 0) {
      bboxes = bboxes.filter((_, i) => !containedIndices.has(i));
      activeIndices = activeIndices.filter((_, i) => !containedIndices.has(i));
    }
  }

  if (bboxes.length === 0) return outputTexts;

  // Phase 1: Snap（水平 + Y 半行補足 + 退一半歸屬）
  const originalBboxes = bboxes.map(b => [...b] as [number, number, number, number]);
  const snappedBboxes: [number, number, number, number][] = bboxes.map((bbox, i) => {
    const otherBboxes = originalBboxes.filter((_, j) => j !== i);
    const collector: SnapDebugCollector = { iterations: 0, triggers: [] };
    return snapBboxToText(bbox, textItems, collector, otherBboxes);
  });

  // Phase 2.25: resolveXOverlaps（左右歸屬解決）
  resolveXOverlaps(snappedBboxes, textItems);

  // Phase 2.5: enforceMinVerticalGap（保證框間最小垂直間距）
  enforceMinVerticalGap(snappedBboxes);

  // Phase 2.75: applyDescenderCompensation（降部補償）
  applyDescenderCompensation(snappedBboxes, textItems);

  // Phase 3: 提取文字
  snappedBboxes.forEach((finalBbox, idx) => {
    const collector: ExtractDebugCollector = {
      hits: [], columns: 1, lineCount: 0, lineThreshold: 0,
      adaptiveThreshold: false, lineGaps: [], medianLineGap: 0,
    };
    const text = extractTextFromBbox(finalBbox, textItems, collector);
    const origIdx = activeIndices[idx];
    outputTexts[origIdx] = { text, hitsCount: collector.hits.length };
  });

  return outputTexts;
}

// ──────────────────────────── 比對 ──────────────────────────────

function normalize(text: string): string {
  return text.trim();
}

/** 找出第一個不同字元的位置，顯示前後上下文 */
function buildDiff(actual: string, expected: string): string {
  const a = normalize(actual);
  const e = normalize(expected);
  if (a === e) return '';

  const len = Math.max(a.length, e.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== e[i]) {
      const ctx = 20;
      const start = Math.max(0, i - ctx);
      const endA = Math.min(a.length, i + ctx);
      const endE = Math.min(e.length, i + ctx);
      return [
        `     第 ${i + 1} 個字元不同`,
        `     實際: ...${JSON.stringify(a.slice(start, endA))}...`,
        `     預期: ...${JSON.stringify(e.slice(start, endE))}...`,
      ].join('\n');
    }
  }
  return `     長度不同（實際 ${a.length}，預期 ${e.length}）`;
}

// ──────────────────────────── 執行 ──────────────────────────────

async function runCase(tc: TestCase): Promise<CaseResult> {
  try {
    const pdfPath = resolvePdfPath(tc.pdfFile);
    const pdfData = new Uint8Array(readFileSync(pdfPath));
    const doc = await (getDocument as any)({ data: pdfData }).promise;
    const page = await doc.getPage(tc.page);

    const textItems = await buildTextItems(page);

    const inputBboxes = tc.regions.map(r => r.inputBbox as [number, number, number, number]);
    const extracted = await runExtractionPipeline(textItems, inputBboxes);

    const regionResults: RegionResult[] = tc.regions.map((r, i) => {
      const actual = normalize(extracted[i]?.text ?? '');
      const expected = normalize(r.expectedText);
      return {
        regionId: r.regionId,
        label: r.label,
        pass: actual === expected,
        actual,
        expected,
        hitsCount: extracted[i]?.hitsCount ?? 0,
        note: r.note,
      };
    });

    return {
      id: tc.id,
      name: tc.name,
      pass: regionResults.every(r => r.pass),
      regionResults,
    };
  } catch (e) {
    return { id: tc.id, name: tc.name, pass: false, regionResults: [], error: String(e) };
  }
}

// ──────────────────────────── Main ──────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const updateMode = args.includes('--update');
  const filterIdx = args.findIndex(a => a === '--filter');
  const filterKey = filterIdx >= 0 ? args[filterIdx + 1] : null;

  const fixture = JSON.parse(readFileSync(CASES_FILE, 'utf-8')) as TestCasesFile;
  let cases = fixture.cases;
  if (filterKey) {
    cases = cases.filter(c => c.id.includes(filterKey) || c.name.includes(filterKey));
    if (cases.length === 0) {
      console.log(`⚠️ 找不到包含「${filterKey}」的案例`);
      return;
    }
    console.log(`篩選：只跑含「${filterKey}」的 ${cases.length} 個案例\n`);
  }

  const LINE = '─'.repeat(62);
  console.log(`\n🧪 PDF 文字提取演算法回歸測試   (${cases.length} 個案例)\n${LINE}`);

  let totalRegionPass = 0;
  let totalRegionFail = 0;
  let totalCaseFail = 0;
  const updatedCases: TestCase[] = [];

  for (let ci = 0; ci < cases.length; ci++) {
    const tc = cases[ci];
    const result = await runCase(tc);

    const caseIcon = result.pass ? '✅' : '❌';
    console.log(`\n${caseIcon} [${ci + 1}/${cases.length}] ${result.id} — ${result.name}`);
    console.log(`   PDF: ${tc.pdfFile}  第 ${tc.page} 頁`);

    if (result.error) {
      console.log(`   💥 執行錯誤：${result.error}`);
      totalCaseFail++;
      updatedCases.push(tc);
      continue;
    }

    // 若 --update：把實際結果填回 regions
    if (updateMode) {
      const updatedRegions = tc.regions.map((r, i) => ({
        ...r,
        expectedText: result.regionResults[i]?.actual ?? r.expectedText,
      }));
      updatedCases.push({ ...tc, regions: updatedRegions });
    } else {
      updatedCases.push(tc);
    }

    for (const rr of result.regionResults) {
      const rIcon = rr.pass ? '  ✅' : '  ❌';
      const hitsInfo = `${rr.hitsCount} hits`;
      console.log(`${rIcon} r${rr.regionId} 「${rr.label}」  ${hitsInfo}`);

      if (rr.note) {
        console.log(`     📝 ${rr.note}`);
      }

      if (!rr.pass) {
        console.log(buildDiff(rr.actual, rr.expected));
        if (verbose || true) {
          // 失敗時一定顯示完整內容方便 debug
          if (rr.actual) {
            console.log(`     ── 實際文字 ──`);
            rr.actual.split('\n').forEach(l => console.log(`     │ ${l}`));
          } else {
            console.log(`     ── 實際文字：(空) ──`);
          }
        }
        totalRegionFail++;
      } else {
        if (verbose && rr.actual) {
          console.log(`     ── 提取文字 ──`);
          rr.actual.split('\n').forEach(l => console.log(`     │ ${l}`));
        }
        totalRegionPass++;
      }
    }

    if (!result.pass) totalCaseFail++;
  }

  // 摘要
  const totalRegion = totalRegionPass + totalRegionFail;
  console.log(`\n${LINE}`);
  if (totalRegionFail === 0) {
    console.log(`✅ 全部通過  ${totalRegionPass}/${totalRegion} 個 region`);
  } else {
    console.log(`❌ ${totalRegionFail} 個 region 失敗  (共 ${totalRegion} 個)`);
    console.log(`   案例失敗：${totalCaseFail}/${cases.length}`);
  }

  // --update：回寫 JSON
  if (updateMode) {
    const updated: TestCasesFile = { ...fixture, cases: updatedCases };
    writeFileSync(CASES_FILE, JSON.stringify(updated, null, 2), 'utf-8');
    console.log(`\n📝 已將實際結果更新至 test-cases.json（作為新基準）`);
  }

  console.log('');
  if (totalRegionFail > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
