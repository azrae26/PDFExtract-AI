/**
 * 功能：PDF 文字提取的純演算法核心（零外部依賴）
 * 職責：所有 bbox 校正、行分組、多欄偵測、文字拼接的純函式 + 常數 + 型別
 *       不依賴 react-pdf / pdfjs-dist / Region 等外部模組，可同時被：
 *       - pdfTextExtract.ts（前端主程式）
 *       - pdf/debug-pdf.ts（離線 debug 工具）
 *       直接 import，確保演算法只有一份
 * 依賴：無
 * 演算法邏輯順序（主 pipeline）：
 * Phase 1   ：snapBboxToText             — 自動校正 bbox 邊界 + 歸屬判斷（退一半覆蓋量→行距 override）
 *               ├─ checkOwnership        — 退一半覆蓋量 + 行距 override（內部函式）
 *               └─ lineSpacingOwnership  — 行距歸屬判斷（內部函式）
 * Phase 2   ：(resolveOverlappingLines 已移除，功能已整合進 Phase 1)
 * Phase 2.25：resolveXOverlaps           — 解決 snap 後的 X 方向重疊
 * Phase 2.5 ：enforceMinVerticalGap      — 保證框間最小垂直間距
 * Phase 2.75：applyDescenderCompensation — 補償降部
 * Phase 3   ：extractTextFromBbox        — 提取文字
 *               ├─ splitIntoColumns      — 多欄偵測（內部呼叫）
 *               │    ├─ Step 1: 按 baseline 分行
 *               │    ├─ Step 2: 收集候選分界線（行內 gap 定位 + 投影法低覆蓋帶）
 *               │    ├─ Step 3: testSeparator — baseline 對齊法驗證候選
 *               │    └─ Step 4: 判定多欄（exclusiveRatio / 投影法嚴格 fallback）
 *               └─ formatColumnText      — 排序拼接（內部呼叫）
 *                    ├─ Step 1: 按 baseline 排序
 *                    ├─ Step 2: 自適應行分組閾值（微聚類）
 *                    ├─ Step 3: 按自適應閾值聚類分行 + Y 重疊行分組
 *                    ├─ Step 3.5: 行碎片重組（超連結 baseline 偏移修復）
 *                    ├─ Step 4: 計算行距（局部自適應段落間距偵測）
 *                    └─ Step 5: 逐行拼接文字（行間換行/空行 + 行內 TAB/空格/回彈）
 * 注意：resolveOverlappingLines / groupIntoLines 函式仍保留，供 debug-pdf.ts 使用
 */

// ============================================================
// 型別
// ============================================================

/** 歸一化座標的文字項目 */
export interface NormTextItem {
  str: string;
  normX: number;
  normY: number;        // top 座標（視覺上方）
  normW: number;
  normH: number;
  normBaseline: number; // baseline 座標 = normY + normH（同一行不同字體大小 baseline 一致）
}

/** 文字行（多個 baseline 相近的 textItem 組成） */
export interface TextLine {
  baselineY: number; // 行的代表 baseline 座標（第一個 item 的 normBaseline）
  topY: number;      // 行的最小 normY（視覺上緣）
  bottomY: number;   // 行的最大 normBaseline（視覺下緣）
}

/** snapBboxToText 的 debug 資料收集器 */
export interface SnapDebugCollector {
  /** 實際迭代次數 */
  iterations: number;
  /** 觸發擴展的 text items（每個座標方向只記錄最遠觸發者，最多 4 個） */
  triggers: {
    str: string;       // 完整文字內容
    normX: number;     // text item 位置
    normY: number;
    normW: number;
    normH: number;
    xRatio: number;    // 水平重疊比例
    expanded: string;  // 擴展方向，如 "x1←" "y1↑" "x2→" "y2↓"
  }[];
}

/** bbox 內的文字命中項（用於排序和多欄偵測） */
export interface Hit {
  str: string;
  normX: number;
  normBaseline: number;
  normRight: number;
  normY: number;        // top 座標（用於 Y 重疊行分組，處理粗體 baseline 偏移）
}

// ============================================================
// 常數
// ============================================================

// === Bbox 自動校正常數 ===
/** 歸一化座標上限 */
export const NORMALIZED_MAX = 1000;
/** 交集擴展最大迭代次數 */
export const SNAP_MAX_ITERATIONS = 3;
/** 重疊比例閾值：文字項目在框內的比例超過此值才納入擴展（避免吃到相鄰區塊） */
export const SNAP_OVERLAP_RATIO = 0.5;
/** 同一行判定閾值（歸一化單位，Y 差距小於此值視為同一行） */
export const SAME_LINE_THRESHOLD = 15;
/** 框間最小垂直間距（歸一化單位），擴張後上下太近時各自退縮 */
export const MIN_VERTICAL_GAP = 5;
/** 降部補償比例：PDF 文字項 height 通常為 em height，降部約佔 20%（依字型而異） */
export const DESCENDER_RATIO = 0.20;
/** CJK（中文）降部補償比例：中文字無 g/p/q/y 等降部字母，降部量較小 */
export const DESCENDER_RATIO_CJK = 0.10;
/** 上方視覺留白比例：em square 頂部到文字視覺上緣的估計距離（佔 normH 的比例）
 *  snap 擴展 y1 時用 normY + normH × 此值 取代 normY，減少上方留白 */
export const VISUAL_TOP_RATIO = 0.25;
/** CJK（中文）上方視覺留白比例：中文字結構較方正，上方留白較小 */
export const VISUAL_TOP_RATIO_CJK = 0.10;
/** 下方視覺延伸比例：baseline 以下文字延伸到的估計距離（佔 normH 的比例）
 *  snap 擴展 y2 時用 tiBottom + normH × 此值 取代 tiBottom，補足 descender 初始量 */
export const VISUAL_BOTTOM_RATIO = 0.05;
/** Y 重疊行合併最小重疊量（歸一化單位）：防止相鄰行因 baseline ≈ normY 產生浮點微小重疊而誤合併 */
export const Y_OVERLAP_MIN = 2;

// === 多欄偵測常數 ===
/** 投影法桶寬（歸一化單位，X 軸離散化精度） */
export const COLUMN_BUCKET_WIDTH = 2;
/** 每個欄最少行數——搭配欄寬比例、斷行合理性、baseline 對齊等多重保護，設為 1 即安全 */
export const COLUMN_MIN_LINES = 1;
/**
 * Baseline 對齊法：獨有行比例閾值
 * 分成左右兩組後，計算「只在一邊出現的行」佔總行數的比例
 * > 此值 → 強證據為獨立多欄（左右各自排版，baseline 不對齊）
 */
export const COLUMN_EXCLUSIVE_RATIO = 0.3;
/** 投影法探索閾值（放寬）：覆蓋 < 此比例的桶為候選低覆蓋區 */
export const COLUMN_PROBE_COVERAGE_RATIO = 0.8;
/** 投影法探索最小帶寬（歸一化單位） */
export const COLUMN_PROBE_MIN_WIDTH = 6;
/** 投影法嚴格閾值：覆蓋 < 此比例 → fallback 判定多欄（即使 baseline 對齊） */
export const COLUMN_STRICT_COVERAGE_RATIO = 0.5;
/** 投影法嚴格最小帶寬（歸一化單位） */
export const COLUMN_STRICT_MIN_WIDTH = 10;
/** 每個欄的最小寬度佔比——X 跨度 < 整體的此比例 → 不是獨立欄（避免把編號列表縮排誤判為多欄） */
export const COLUMN_MIN_WIDTH_RATIO = 0.10;
/** 行被分界線穿過時，行內 gap 至少要有此寬度才允許切分（歸一化單位） */
export const COLUMN_CUT_GAP_MIN = 5;
/** 不合理切割行佔比上限——超過此比例的行在分界線位置沒有足夠 gap → 拒絕該候選 */
export const COLUMN_BAD_CUT_MAX_RATIO = 0.2;
/** 文字內容比例下限——較少一邊的字元數 / 總字元數 < 此值 → 不是真正的多欄（避免把 bullet list 的 • 誤判為左欄） */
export const COLUMN_MIN_CHAR_RATIO = 0.05;

// === PUA 字元替換映射 ===
// PDF 常用 Wingdings/Symbol 等自訂字型，文字層存為 Private Use Area (U+E000-U+F8FF) 字元
// 顯示為亂碼，需替換為可正常顯示的標準 Unicode 符號
export const PUA_CHAR_MAP: Record<number, string> = {
  0xF06E: '■',  // Wingdings: 實心方塊（主項目符號）
  0xF0D8: '▷',  // Wingdings: 右箭頭（子項目符號）
  0xF0B7: '●',  // Symbol: 實心圓點
  0xF06C: '●',  // Wingdings: 圓點變體
  0xF0A7: '■',  // Wingdings: 方塊變體
  0xF0A8: '□',  // Wingdings: 空心方塊
  0xF0B2: '◆',  // Wingdings: 實心菱形
  0xF076: '✓',  // Wingdings: 打勾
  0xF0FC: '✓',  // Wingdings: 打勾變體
  0xF0E8: '➤',  // Wingdings: 箭頭
};

// === Wingdings 字型 ASCII → 符號映射 ===
// PDF 中 Wingdings 字型的字元碼是 ASCII 範圍（0x00-0xFF），不在 PUA 範圍內，
// pdfjs 解碼後變成普通字母（如 'n' → ■），sanitizePuaChars 無法處理。
// 需要在知道 fontName 的情況下（pdfTextExtract.ts IO 層），逐字替換。
export const WINGDINGS_CHAR_MAP: Record<string, string> = {
  'l': '●',  // 0x6C: 實心圓點
  'n': '■',  // 0x6E: 實心方塊（常見項目符號）
  'q': '◆',  // 0x71: 實心菱形
  'r': '□',  // 0x72: 空心方塊
  'u': '○',  // 0x75: 空心圓
  'v': '✓',  // 0x76: 打勾
  'x': '✕',  // 0x78: 叉號
  't': '◇',  // 0x74: 空心菱形
  'w': '✗',  // 0x77: 粗叉號
  'à': '🖊', // 0xE0: 筆（近似）
};

/** 偵測 fontName 是否為 Wingdings 系列字型 */
export function isWingdingsFont(fontName: string): boolean {
  return /wingdings|webdings|zapfdingbats/i.test(fontName);
}

/**
 * 替換 Wingdings 字型中非 PUA 的字元
 * 只在確認為 Wingdings 字型時呼叫（由 IO 層 pdfTextExtract.ts 判斷 fontName）
 */
export function sanitizeWingdings(str: string): string {
  return str.replace(/./g, (ch) => WINGDINGS_CHAR_MAP[ch] ?? '■');
}

// === 行內間距常數 ===
/** 行內欄間距閾值（歸一化單位，約頁面寬度 3%） */
export const COL_GAP_THRESHOLD = 30;
/** 行內空格間距閾值（歸一化單位，項次編號後的小間距插入空格） */
export const SPACE_GAP_THRESHOLD = 3;
/** 回彈偵測閾值：gap 低於此值 → 上個 item 在行尾、當前 item 回到行首 */
export const WRAPAROUND_THRESHOLD = -50;

// === 段落間距常數 ===
/** 行距 > 局部基本行距 × 此倍數 → 段落分隔 */
export const PARA_GAP_RATIO = 1.3;
/** 局部窗口：±3 個行距（最多 7 個值取 lower percentile） */
export const PARA_WINDOW = 3;

// ============================================================
// 工具函式
// ============================================================

/** Debug log 用時間戳 */
export const _ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });

/** 偵測字串是否含 CJK 統一漢字（中文），用於選擇 CJK-specific 常數 */
const CJK_REGEX = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
export function hasCJK(str: string): boolean {
  return CJK_REGEX.test(str);
}

/** 將 PUA 字元替換為可顯示的標準符號，未登錄的 PUA 字元以 ● 代替 */
export function sanitizePuaChars(text: string): string {
  // 快速路徑：沒有 PUA 字元就直接回傳
  if (!/[\uE000-\uF8FF]/.test(text)) return text;
  return text.replace(/[\uE000-\uF8FF]/g, (ch) => {
    const code = ch.codePointAt(0)!;
    return PUA_CHAR_MAP[code] ?? '●';
  });
}

// ============================================================
// Phase 1: Snap — bbox 自動校正
// ============================================================

/**
 * 行距歸屬判斷：被爭奪的 textItem 跟上方/下方最近文字的行距，較小的那邊歸屬
 * @param myBbox 當前 bbox 的原始座標
 * @param other 競爭者 bbox 的原始座標
 * @param ti 被爭奪的 textItem
 * @param textItems 頁面上所有的 textItems（用於找上下鄰居）
 * @returns true = 行距判斷屬於當前 bbox，false = 屬於競爭者，null = 無法判斷（fallback 到覆蓋量）
 */
function lineSpacingOwnership(
  myBbox: [number, number, number, number],
  other: [number, number, number, number],
  ti: NormTextItem,
  textItems: NormTextItem[],
): boolean | null {
  const tiBaseline = ti.normBaseline;
  const tiLeft = ti.normX;
  const tiRight = ti.normX + ti.normW;

  // 找上方最近（baseline < tiBaseline）和下方最近（baseline > tiBaseline）的文字，需 X 重疊
  let aboveItem: NormTextItem | null = null;
  let aboveGap = Infinity;
  let belowItem: NormTextItem | null = null;
  let belowGap = Infinity;

  for (const t of textItems) {
    // X 重疊檢查（同一欄的文字才有意義）
    const tRight = t.normX + t.normW;
    if (t.normX >= tiRight || tRight <= tiLeft) continue;

    if (t.normBaseline < tiBaseline) {
      const gap = tiBaseline - t.normBaseline;
      if (gap < aboveGap) {
        aboveGap = gap;
        aboveItem = t;
      }
    } else if (t.normBaseline > tiBaseline) {
      const gap = t.normBaseline - tiBaseline;
      if (gap < belowGap) {
        belowGap = gap;
        belowItem = t;
      }
    }
  }

  if (!aboveItem && !belowItem) return null; // 找不到鄰居

  // 判斷鄰居屬於哪個框（normY 在誰的框內）
  const isInBox = (item: NormTextItem, box: [number, number, number, number]) =>
    item.normY >= box[1] && item.normY < box[3];

  const aboveMine = aboveItem ? isInBox(aboveItem, myBbox) : false;
  const aboveOther = aboveItem ? isInBox(aboveItem, other) : false;
  const belowMine = belowItem ? isInBox(belowItem, myBbox) : false;
  const belowOther = belowItem ? isInBox(belowItem, other) : false;

  if (aboveGap < belowGap) {
    // 跟上方更近 → 屬於上方鄰居的框
    if (aboveMine && !aboveOther) return true;   // 上方是我的 → 我贏
    if (aboveOther && !aboveMine) return false;  // 上方是對方的 → 對方贏
  } else if (belowGap < aboveGap) {
    // 跟下方更近 → 屬於下方鄰居的框
    if (belowMine && !belowOther) return true;
    if (belowOther && !belowMine) return false;
  }
  // 行距相等 or 鄰居歸屬不明確 → 無法判斷
  return null;
}

/**
 * 歸屬判斷：textItem 是否屬於當前 bbox
 * 判斷順序：退一半覆蓋量 → 行距歸屬（覆蓋量輸時 override）→ 覆蓋量 fallback
 * 1. 退一半覆蓋量：與每個 otherBbox 計算重疊中點，用退一半後位置比較覆蓋量
 * 2. 行距歸屬：覆蓋量判為「不是我的」時，檢查上下鄰居行距，行距小的那邊可 override
 * 3. 覆蓋量 fallback：行距無法判斷時（行距相等/鄰居不明），回到覆蓋量結論
 * @param myBbox 當前 bbox 的原始座標
 * @param otherBboxes 其他 region 的原始 bbox
 * @param ti 被判斷的 textItem
 * @param tiBottomForOverlap textItem 底部（含降部補償，用於覆蓋量計算）
 * @param textItems 頁面上所有的 textItems（用於行距歸屬判斷）
 * @returns true = 屬於當前 bbox，false = 屬於其他 bbox
 */
function checkOwnership(
  myBbox: [number, number, number, number],
  otherBboxes: [number, number, number, number][] | undefined,
  ti: NormTextItem,
  tiBottomForOverlap: number,
  textItems: NormTextItem[],
): boolean {
  if (!otherBboxes) return true;

  for (const other of otherBboxes) {
    // X 重疊檢查：左右不同欄的框不影響歸屬判斷（避免並排框互相搶文字）
    const xOverlap = Math.min(myBbox[2], other[2]) - Math.max(myBbox[0], other[0]);
    if (xOverlap <= 0) continue;

    // 計算當前 bbox 和此 otherBbox 的 Y 方向重疊
    const pairOverlapTop = Math.max(myBbox[1], other[1]);
    const pairOverlapBottom = Math.min(myBbox[3], other[3]);

    let myEffY1 = myBbox[1], myEffY2 = myBbox[3];
    let otherEffY1 = other[1], otherEffY2 = other[3];

    if (pairOverlapBottom > pairOverlapTop) {
      // 有重疊：各退一半到中點
      const mid = (pairOverlapTop + pairOverlapBottom) / 2;
      if (myBbox[1] <= other[1]) {
        myEffY2 = Math.min(myEffY2, mid);
        otherEffY1 = Math.max(otherEffY1, mid);
      } else {
        myEffY1 = Math.max(myEffY1, mid);
        otherEffY2 = Math.min(otherEffY2, mid);
      }
    }

    // 用退一半後的位置計算覆蓋量
    const myCoverage = Math.max(0, Math.min(tiBottomForOverlap, myEffY2) - Math.max(ti.normY, myEffY1));
    const otherCoverage = Math.max(0, Math.min(tiBottomForOverlap, otherEffY2) - Math.max(ti.normY, otherEffY1));

    if (otherCoverage > myCoverage) {
      // 覆蓋量判為「不是我的」→ 用行距歸屬 override
      const lsResult = lineSpacingOwnership(myBbox, other, ti, textItems);
      if (lsResult === true) continue;  // 行距說是我的 → override，繼續檢查下一個 other
      // lsResult === false 或 null → 維持覆蓋量結論
      return false;
    }
    // myCoverage >= otherCoverage → 是我的，繼續檢查下一個 other
  }

  return true;
}

/**
 * 自動校正 bbox 邊界
 * - 水平方向：重疊比例 >= 50% 才擴展（避免吃到相鄰區塊）
 * - 垂直方向：只要框碰到該行就補足到完整行高（任何重疊即擴展）
 * - 歸屬判斷（同時控制擴展和退縮）：
 *   1. 退一半覆蓋量：與每個 otherBbox 計算重疊中點，用退一半後位置比較覆蓋量
 *   2. 行距歸屬 override：覆蓋量判為「不是我的」時，檢查上下鄰居行距，行距小的那邊可 override
 *   3. 覆蓋量 fallback：行距無法判斷時回到覆蓋量結論
 * - 降部補償不在此處加入 — 由外層在 enforce 之後獨立處理，避免汙染後續校正階段的座標
 * @param snapDebug 可選 debug 收集器 — 傳入時會記錄迭代次數和觸發擴展的 text items
 * @param otherBboxes 可選 — 其他 region 的原始 bbox（用於歸屬判斷，避免吃到鄰框文字）
 */
export function snapBboxToText(
  bbox: [number, number, number, number],
  textItems: NormTextItem[],
  snapDebug?: SnapDebugCollector,
  otherBboxes?: [number, number, number, number][],
): [number, number, number, number] {
  let [x1, y1, x2, y2] = bbox;

  // Debug: 追蹤每個座標方向最遠的觸發者
  let x1Trigger: SnapDebugCollector['triggers'][0] | null = null;
  let y1Trigger: SnapDebugCollector['triggers'][0] | null = null;
  let x2Trigger: SnapDebugCollector['triggers'][0] | null = null;
  let y2Trigger: SnapDebugCollector['triggers'][0] | null = null;

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
      // 交集判定時，文字項底部額外加上降部補償：
      // PDF 的 textItem height = em height（只到 baseline），不含 g/p/q/y 等字母的降部。
      // 當框的 y1 碰到降部區域（baseline 和視覺底部之間）時，座標上無交集但視覺上有重疊，
      // 擴展 tiBottom 讓「碰到降部」也觸發自動擴張。
      const tiIsCJK = hasCJK(ti.str);
      const tiBottomForOverlap = tiBottom + ti.normH * (tiIsCJK ? DESCENDER_RATIO_CJK : DESCENDER_RATIO);
      const overlapLeft = Math.max(ti.normX, x1);
      const overlapRight = Math.min(tiRight, x2);
      const overlapWidth = overlapRight - overlapLeft;
      const overlapTop = Math.max(ti.normY, y1);
      const overlapBottom = Math.min(tiBottomForOverlap, y2);
      const overlapHeight = overlapBottom - overlapTop;

      if (overlapWidth <= 0 || overlapHeight <= 0) continue; // 無交集

      // 水平方向：重疊比例 >= 50% 才擴展
      const xRatio = ti.normW > 0 ? overlapWidth / ti.normW : 0;
      if (xRatio >= SNAP_OVERLAP_RATIO) {
        if (ti.normX < x1) {
          x1 = ti.normX; changed = true;
          if (snapDebug) {
            x1Trigger = { str: ti.str, normX: ti.normX, normY: ti.normY, normW: ti.normW, normH: ti.normH, xRatio: Math.round(xRatio * 100) / 100, expanded: 'x1←' };
          }
        }
        if (tiRight > x2) {
          x2 = tiRight; changed = true;
          if (snapDebug) {
            x2Trigger = { str: ti.str, normX: ti.normX, normY: ti.normY, normW: ti.normW, normH: ti.normH, xRatio: Math.round(xRatio * 100) / 100, expanded: 'x2→' };
          }
        }
      }

      // 垂直方向：只要框碰到該行就補足到視覺文字邊界（任何重疊即擴展）
      // 用 VISUAL_TOP_RATIO / VISUAL_BOTTOM_RATIO 估算實際文字邊界，
      // 避免框擴展到 em square 完整範圍導致上方留白過多
      // 歸屬判斷：覆蓋量 → 行距歸屬 override → 覆蓋量 fallback
      if (overlapHeight > 0) {
        // 歸屬判斷：退一半覆蓋量 + 行距歸屬
        const isMyText = checkOwnership(bbox, otherBboxes, ti, tiBottomForOverlap, textItems);

        if (isMyText) {
          const visualTop = ti.normY + ti.normH * (tiIsCJK ? VISUAL_TOP_RATIO_CJK : VISUAL_TOP_RATIO);
          const visualBottom = tiBottom + ti.normH * VISUAL_BOTTOM_RATIO;
          if (visualTop < y1) {
            y1 = visualTop; changed = true;
            if (snapDebug) {
              y1Trigger = { str: ti.str, normX: ti.normX, normY: ti.normY, normW: ti.normW, normH: ti.normH, xRatio: Math.round(xRatio * 100) / 100, expanded: 'y1↑' };
            }
          }
          if (visualBottom > y2) {
            y2 = visualBottom; changed = true;
            if (snapDebug) {
              y2Trigger = { str: ti.str, normX: ti.normX, normY: ti.normY, normW: ti.normW, normH: ti.normH, xRatio: Math.round(xRatio * 100) / 100, expanded: 'y2↓' };
            }
          }
        }
      }
    }
  }

  // === 退縮：框邊界超出文字範圍時收縮到「屬於自己的」文字的視覺邊界 ===
  // AI 給的框可能比文字範圍大，snap 只擴展不退縮，需要額外收縮到最近文字邊界
  // 佔比歸屬同時控制退縮：不屬於自己的 textItem 不納入邊界計算，確保框不覆蓋鄰框的文字
  let minVisualTop = y2;     // 初始為框底（找最小值）
  let maxVisualBottom = y1;  // 初始為框頂（找最大值）
  let hasTrimHits = false;

  for (const ti of textItems) {
    const tiRight = ti.normX + ti.normW;
    const tiBottom = ti.normY + ti.normH;
    const tiIsCJK = hasCJK(ti.str);
    const tiBottomForOverlap = tiBottom + ti.normH * (tiIsCJK ? DESCENDER_RATIO_CJK : DESCENDER_RATIO);

    // 交集判定（和擴展邏輯一致）
    const overlapLeft = Math.max(ti.normX, x1);
    const overlapRight = Math.min(tiRight, x2);
    const overlapWidth = overlapRight - overlapLeft;
    const overlapTop = Math.max(ti.normY, y1);
    const overlapBottom = Math.min(tiBottomForOverlap, y2);
    const overlapHeight = overlapBottom - overlapTop;

    if (overlapWidth <= 0 || overlapHeight <= 0) continue;

    // 水平重疊比例門檻（和擴展一致）
    const xRatio = ti.normW > 0 ? overlapWidth / ti.normW : 0;
    if (xRatio < SNAP_OVERLAP_RATIO) continue;

    // 歸屬判斷：只有屬於自己的 textItem 才納入退縮邊界計算
    if (!checkOwnership(bbox, otherBboxes, ti, tiBottomForOverlap, textItems)) continue;

    const visualTop = ti.normY + ti.normH * (tiIsCJK ? VISUAL_TOP_RATIO_CJK : VISUAL_TOP_RATIO);
    const visualBottom = tiBottom + ti.normH * VISUAL_BOTTOM_RATIO;

    minVisualTop = Math.min(minVisualTop, visualTop);
    maxVisualBottom = Math.max(maxVisualBottom, visualBottom);
    hasTrimHits = true;
  }

  if (hasTrimHits) {
    if (y1 < minVisualTop) y1 = minVisualTop;
    if (y2 > maxVisualBottom) y2 = maxVisualBottom;
  }

  // 寫入 debug 收集器
  if (snapDebug) {
    snapDebug.iterations = iterations;
    const triggers: SnapDebugCollector['triggers'] = [];
    if (x1Trigger) triggers.push(x1Trigger);
    if (y1Trigger) triggers.push(y1Trigger);
    if (x2Trigger) triggers.push(x2Trigger);
    if (y2Trigger) triggers.push(y2Trigger);
    snapDebug.triggers = triggers;
  }

  return [x1, y1, x2, y2];
}

// ============================================================
// 行分組
// ============================================================

/**
 * 把 textItems 按 baseline 座標分行（同一行不同字體大小 baseline 一致，比 top 更準確）
 * @param bboxes 可選 — 若提供，只處理與至少一個 bbox 有 X 重疊的文字項，
 *               過濾掉不在任何 bbox 水平範圍內的右欄/側邊文字，
 *               避免跨欄文字被合併成同一行而汙染 resolve 的行距判斷
 */
export function groupIntoLines(textItems: NormTextItem[], bboxes?: [number, number, number, number][]): TextLine[] {
  // 過濾：只保留與至少一個 bbox 有 X 重疊的文字項
  const items = bboxes
    ? textItems.filter(ti => {
        const tiRight = ti.normX + ti.normW;
        return bboxes.some(([bx1, , bx2]) => ti.normX < bx2 && tiRight > bx1);
      })
    : textItems;

  const sorted = [...items].sort((a, b) => a.normBaseline - b.normBaseline);
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

// ============================================================
// Phase 2: Resolve — 跨 region 重疊行解衝突
// ============================================================

/**
 * 跨 region 解衝突：同一行被多個框覆蓋時，根據行距判斷退縮方向
 * - 下方行距 < 上方行距 → 此行屬於下方段落 → 上方框的 y2 退縮
 * - 上方行距 < 下方行距 → 此行屬於上方段落 → 下方框的 y1 退縮
 * - 行距相等 → 不動
 * 直接修改 bboxes 陣列（in-place）
 */
export function resolveOverlappingLines(
  bboxes: [number, number, number, number][],
  textItems: NormTextItem[],
): void {
  if (bboxes.length < 2) return;

  const lines = groupIntoLines(textItems, bboxes);

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

    // X 重疊檢查：左右不同欄的框不需要解衝突（避免並排框互相退縮）
    const xOverlap = Math.min(bboxes[upperIdx][2], bboxes[lowerIdx][2]) - Math.max(bboxes[upperIdx][0], bboxes[lowerIdx][0]);
    if (xOverlap <= 0) continue;

    if (gapBelow < gapAbove) {
      // 下方行距小 → 此行屬於下方段落 → 上方框退縮 y2
      bboxes[upperIdx][3] = Math.min(bboxes[upperIdx][3], line.topY);
    } else {
      // 上方行距小 → 此行屬於上方段落 → 下方框退縮 y1
      bboxes[lowerIdx][1] = Math.max(bboxes[lowerIdx][1], line.bottomY);
    }
  }
}

// ============================================================
// Phase 2.25: ResolveXOverlaps — 左右歸屬判斷
// ============================================================

/** baseline 子集比例閾值：較少那邊的 baselines 有此比例以上在較多那邊找到配對 → 可能同區塊 → 需 X 佔比判斷 */
export const X_SUBSET_RATIO = 0.8;

/**
 * 左右歸屬判斷：snap 後兩框若有 X 重疊，用 baseline 對齊 + X 佔比決定歸屬，消除 X 重疊
 * - Step 1: 收集左/右框非重疊區域的 baselines
 * - Step 2: 計算較少那邊的 baseline 子集比例（有多少在較多那邊找到配對）
 * - Step 3: subsetRatio < X_SUBSET_RATIO → 不同區塊 → 看誰在重疊區文字多 → 少的退
 *           subsetRatio >= X_SUBSET_RATIO → 可能同區塊 → X 重疊各退一半 → 比佔比 → 少的退
 * - Step 4: 退縮結果消除 X 重疊，避免後續 enforce 誤判
 * 直接修改 bboxes 陣列（in-place）
 * @returns 每個 bbox 的 resolveX debug 資訊（delta、是否觸發、子集比例、配對對象）
 */
/** resolveXOverlaps 每個 bbox 的 debug 資訊 */
export interface ResolveXDebugEntry {
  delta: [number, number, number, number];
  triggered?: boolean;
  subsetRatio?: number;
  pairedWith?: number;
}

export function resolveXOverlaps(
  bboxes: [number, number, number, number][],
  textItems: NormTextItem[],
): ResolveXDebugEntry[] {
  const debugResults: ResolveXDebugEntry[] = bboxes.map(() => ({
    delta: [0, 0, 0, 0] as [number, number, number, number],
  }));

  if (bboxes.length < 2) return debugResults;

  for (let i = 0; i < bboxes.length; i++) {
    for (let j = i + 1; j < bboxes.length; j++) {
      // X 方向無重疊則跳過
      const xOverlapLeft = Math.max(bboxes[i][0], bboxes[j][0]);
      const xOverlapRight = Math.min(bboxes[i][2], bboxes[j][2]);
      if (xOverlapRight <= xOverlapLeft) continue;

      // 決定左框 / 右框（x1 較小的是左框）
      const leftIdx = bboxes[i][0] <= bboxes[j][0] ? i : j;
      const rightIdx = leftIdx === i ? j : i;

      // Y 方向無重疊也跳過（完全上下不重疊的框即使 X 碰到也不影響）
      const yOverlapTop = Math.max(bboxes[leftIdx][1], bboxes[rightIdx][1]);
      const yOverlapBottom = Math.min(bboxes[leftIdx][3], bboxes[rightIdx][3]);
      if (yOverlapBottom <= yOverlapTop) continue;

      // --- Step 1: 收集左/右框非重疊區域的 baselines ---
      const leftBaselines = new Set<number>();
      const rightBaselines = new Set<number>();

      for (const ti of textItems) {
        const tiCenterX = ti.normX + ti.normW / 2;
        const tiBaseline = ti.normBaseline;

        // 只看 Y 範圍與兩框都重疊的文字（避免上下方無關文字干擾）
        if (tiBaseline < yOverlapTop || ti.normY > yOverlapBottom) continue;

        if (tiCenterX < xOverlapLeft) {
          // 文字中心在左框的非重疊區
          if (tiCenterX > bboxes[leftIdx][0] && tiCenterX < bboxes[leftIdx][2]) {
            leftBaselines.add(Math.round(tiBaseline));
          }
        } else if (tiCenterX > xOverlapRight) {
          // 文字中心在右框的非重疊區
          if (tiCenterX > bboxes[rightIdx][0] && tiCenterX < bboxes[rightIdx][2]) {
            rightBaselines.add(Math.round(tiBaseline));
          }
        }
      }

      // --- Step 2: 計算 baseline 子集比例 ---
      // 用較少那邊當分母，看它的 baselines 是否都在較多那邊找得到
      const leftArr = Array.from(leftBaselines);
      const rightArr = Array.from(rightBaselines);
      const smallArr = leftArr.length <= rightArr.length ? leftArr : rightArr;
      const largeArr = leftArr.length <= rightArr.length ? rightArr : leftArr;

      let matchCount = 0;
      if (smallArr.length > 0) {
        for (const bl of smallArr) {
          if (largeArr.some(other => Math.abs(bl - other) < SAME_LINE_THRESHOLD)) {
            matchCount++;
          }
        }
      }
      const subsetRatio = smallArr.length > 0 ? matchCount / smallArr.length : 1;

      // --- Step 3: 判定歸屬 + 退縮 ---
      let leftCoverage = 0;
      let rightCoverage = 0;

      if (subsetRatio >= X_SUBSET_RATIO) {
        // 可能同區塊 → X 重疊各退一半 → 比佔比
        const midX = (xOverlapLeft + xOverlapRight) / 2;

        for (const ti of textItems) {
          const tiRight = ti.normX + ti.normW;
          // 文字必須在重疊區內
          if (tiRight <= xOverlapLeft || ti.normX >= xOverlapRight) continue;
          // 也要在 Y 重疊範圍內
          if (ti.normBaseline < yOverlapTop || ti.normY > yOverlapBottom) continue;

          const tiCenterX = ti.normX + ti.normW / 2;
          if (tiCenterX < midX) {
            leftCoverage += Math.min(tiRight, midX) - Math.max(ti.normX, xOverlapLeft);
          } else {
            rightCoverage += Math.min(tiRight, xOverlapRight) - Math.max(ti.normX, midX);
          }
        }
      } else {
        // 不同區塊 → 直接統計重疊區的文字覆蓋量
        for (const ti of textItems) {
          const tiRight = ti.normX + ti.normW;
          if (tiRight <= xOverlapLeft || ti.normX >= xOverlapRight) continue;
          if (ti.normBaseline < yOverlapTop || ti.normY > yOverlapBottom) continue;

          const tiCenterX = ti.normX + ti.normW / 2;
          const overlapAmount = Math.min(tiRight, xOverlapRight) - Math.max(ti.normX, xOverlapLeft);
          if (tiCenterX < (xOverlapLeft + xOverlapRight) / 2) {
            leftCoverage += overlapAmount;
          } else {
            rightCoverage += overlapAmount;
          }
        }
      }

      // --- Step 4: 退縮 —— 覆蓋量少的一方退讓，消除 X 重疊 ---
      const beforeLeft = [...bboxes[leftIdx]] as [number, number, number, number];
      const beforeRight = [...bboxes[rightIdx]] as [number, number, number, number];

      if (leftCoverage >= rightCoverage) {
        // 左框覆蓋更多 → 右框退讓（右框 x1 推到左框 x2）
        bboxes[rightIdx][0] = bboxes[leftIdx][2];
      } else {
        // 右框覆蓋更多 → 左框退讓（左框 x2 推到右框 x1）
        bboxes[leftIdx][2] = bboxes[rightIdx][0];
      }

      // 記錄 debug
      debugResults[leftIdx] = {
        delta: [
          bboxes[leftIdx][0] - beforeLeft[0],
          bboxes[leftIdx][1] - beforeLeft[1],
          bboxes[leftIdx][2] - beforeLeft[2],
          bboxes[leftIdx][3] - beforeLeft[3],
        ],
        triggered: true,
        subsetRatio: Math.round(subsetRatio * 100) / 100,
        pairedWith: rightIdx,
      };
      debugResults[rightIdx] = {
        delta: [
          bboxes[rightIdx][0] - beforeRight[0],
          bboxes[rightIdx][1] - beforeRight[1],
          bboxes[rightIdx][2] - beforeRight[2],
          bboxes[rightIdx][3] - beforeRight[3],
        ],
        triggered: true,
        subsetRatio: Math.round(subsetRatio * 100) / 100,
        pairedWith: leftIdx,
      };
    }
  }

  return debugResults;
}

// ============================================================
// Phase 2.5: Enforce — 框間最小垂直間距
// ============================================================

/**
 * 擴張後框間最小垂直間距保證：
 * 對所有 X 方向有重疊的框對，若上下間距 < MIN_VERTICAL_GAP，各自退縮一半使間距達標
 * 直接修改 bboxes 陣列（in-place）
 */
export function enforceMinVerticalGap(
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

// ============================================================
// Phase 2.75: Descender — 降部補償
// ============================================================

/**
 * 降部補償（Phase 2.75）：在 resolve/enforce 之後為每個框的 y2 加上降部空間
 * - 根據框底邊附近的文字項高度動態計算
 * - 受限於下方鄰近框的 y1，不會入侵鄰框領地
 * - 在 snap/resolve/enforce 之後才執行，避免汙染前面階段的座標判斷
 */
export function applyDescenderCompensation(
  bboxes: [number, number, number, number][],
  textItems: NormTextItem[],
): void {
  for (let i = 0; i < bboxes.length; i++) {
    const [bx1, , bx2, by2] = bboxes[i];

    // 找出框底邊附近（baseline 在 y2 附近）的文字項，取最大高度
    let bottomEdgeH = 0;
    let bottomEdgeHasCJK = false;
    for (const ti of textItems) {
      const tiRight = ti.normX + ti.normW;
      const tiBaseline = ti.normY + ti.normH;
      // 文字項需在框的 X 範圍內，且 baseline 接近 y2（差距 < 同行閾值）
      if (ti.normX < bx2 && tiRight > bx1 && Math.abs(tiBaseline - by2) < SAME_LINE_THRESHOLD) {
        bottomEdgeH = Math.max(bottomEdgeH, ti.normH);
        if (hasCJK(ti.str)) bottomEdgeHasCJK = true;
      }
    }

    if (bottomEdgeH <= 0) continue;

    const descenderAmount = bottomEdgeH * (bottomEdgeHasCJK ? DESCENDER_RATIO_CJK : DESCENDER_RATIO);

    // 找出 X 有重疊的下方最近框的 y1，降部不超過該邊界
    let nextY1 = NORMALIZED_MAX;
    for (let j = 0; j < bboxes.length; j++) {
      if (j === i) continue;
      // X 方向有重疊才算鄰近
      const xOverlap = Math.min(bboxes[i][2], bboxes[j][2]) - Math.max(bboxes[i][0], bboxes[j][0]);
      if (xOverlap <= 0) continue;
      // 只看下方框
      if (bboxes[j][1] > by2) {
        nextY1 = Math.min(nextY1, bboxes[j][1]);
      }
    }

    // 降部補償不超過到下方框的距離（保留 MIN_VERTICAL_GAP）
    const maxY2 = nextY1 - MIN_VERTICAL_GAP;
    bboxes[i][3] = Math.min(maxY2, by2 + descenderAmount);
  }
}

// ============================================================
// 多欄偵測
// ============================================================

/**
 * 計算 hits 中有多少獨立行（用 SAME_LINE_THRESHOLD 分行）
 */
export function countLines(hits: Hit[]): number {
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
export function testSeparator(
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

  // 欄寬比例檢查：每個欄的 X 跨度至少佔整體的 COLUMN_MIN_WIDTH_RATIO
  // 避免把編號列表的縮排 gap（"1." "2." vs 正文）誤判為多欄
  const allMinX = Math.min(...hits.map(h => h.normX));
  const allMaxX = Math.max(...hits.map(h => h.normRight));
  const totalSpan = allMaxX - allMinX;
  if (totalSpan > 0) {
    const leftSpan = Math.max(...leftHits.map(h => h.normRight)) - Math.min(...leftHits.map(h => h.normX));
    const rightSpan = Math.max(...rightHits.map(h => h.normRight)) - Math.min(...rightHits.map(h => h.normX));
    const minRatio = Math.min(leftSpan, rightSpan) / totalSpan;
    if (minRatio < COLUMN_MIN_WIDTH_RATIO) return null; // 某一邊太窄，不是獨立欄
  }

  // 文字內容比例檢查：避免把 bullet list（•）的標記符號誤判為左欄
  // bullet / 編號等標記字元少、文字量極少，真正的多欄兩邊都有實質文字內容
  const leftChars = leftHits.reduce((sum, h) => sum + h.str.length, 0);
  const rightChars = rightHits.reduce((sum, h) => sum + h.str.length, 0);
  const totalChars = leftChars + rightChars;
  if (totalChars > 0 && Math.min(leftChars, rightChars) / totalChars < COLUMN_MIN_CHAR_RATIO) return null;

  // 斷行合理性檢查：分界線穿過的行，行內在分界位置必須有足夠的 gap
  // 避免把一行連續文字硬切成兩半
  const sortedByBl = [...hits].sort((a, b) => a.normBaseline - b.normBaseline);
  const lineGroups: Hit[][] = [[sortedByBl[0]]];
  for (let i = 1; i < sortedByBl.length; i++) {
    const lastGrp = lineGroups[lineGroups.length - 1];
    if (Math.abs(sortedByBl[i].normBaseline - lastGrp[0].normBaseline) < SAME_LINE_THRESHOLD) {
      lastGrp.push(sortedByBl[i]);
    } else {
      lineGroups.push([sortedByBl[i]]);
    }
  }

  let cutLines = 0;    // 分界線穿過的行數
  let badCutLines = 0;  // 被不合理切割的行數

  for (const line of lineGroups) {
    const lineMinX = Math.min(...line.map(h => h.normX));
    const lineMaxX = Math.max(...line.map(h => h.normRight));
    if (separator <= lineMinX || separator >= lineMaxX) continue; // 不穿過此行
    cutLines++;

    // 檢查 separator 位置是否有足夠的 gap
    const sortedLine = [...line].sort((a, b) => a.normX - b.normX);
    let hasGap = false;
    for (let j = 1; j < sortedLine.length; j++) {
      const gapLeft = sortedLine[j - 1].normRight;
      const gapRight = sortedLine[j].normX;
      if (gapLeft <= separator && gapRight >= separator && (gapRight - gapLeft) > COLUMN_CUT_GAP_MIN) {
        hasGap = true;
        break;
      }
    }
    if (!hasGap) badCutLines++;
  }

  if (cutLines > 0 && badCutLines / cutLines > COLUMN_BAD_CUT_MAX_RATIO) return null;

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
export function splitIntoColumns(hits: Hit[], debug?: ExtractDebugCollector): Hit[][] {
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
  // 對每行找出最大 X gap，用 gap 右邊緣（右邊文字的 normX）聚類
  // 右邊區塊的左邊緣通常固定，所以用右邊緣聚類比用 gap 中點更穩定
  const LINE_GAP_MIN = 5; // 最小 gap 閾值（歸一化單位）
  const GAP_CLUSTER_RANGE = 50; // 聚類範圍：gap 右邊緣差距 < 此值歸為同一組

  interface GapInfo { gapLeft: number; gapRight: number } // gapLeft=左邊文字右緣, gapRight=右邊文字左緣
  const gapInfos: GapInfo[] = [];

  for (const line of lines) {
    if (line.length < 2) continue;
    const sortedLine = [...line].sort((a, b) => a.normX - b.normX);
    let maxGap = 0;
    let maxGapInfo: GapInfo | null = null;
    for (let i = 1; i < sortedLine.length; i++) {
      const gap = sortedLine[i].normX - sortedLine[i - 1].normRight;
      if (gap > maxGap) {
        maxGap = gap;
        maxGapInfo = { gapLeft: sortedLine[i - 1].normRight, gapRight: sortedLine[i].normX };
      }
    }
    if (maxGap > LINE_GAP_MIN && maxGapInfo) {
      gapInfos.push(maxGapInfo);
    }
  }

  // 用 gapRight 聚類（右邊區塊的左邊緣通常固定，比 gap 中點更穩定）
  if (gapInfos.length >= 2) {
    gapInfos.sort((a, b) => a.gapRight - b.gapRight);
    const clusters: GapInfo[][] = [[gapInfos[0]]];
    for (let i = 1; i < gapInfos.length; i++) {
      const lastCluster = clusters[clusters.length - 1];
      if (gapInfos[i].gapRight - lastCluster[lastCluster.length - 1].gapRight < GAP_CLUSTER_RANGE) {
        lastCluster.push(gapInfos[i]);
      } else {
        clusters.push([gapInfos[i]]);
      }
    }

    // 取最大聚類，行數 >= 30% 總行數 → 分界線取 gap 中點的中位數
    clusters.sort((a, b) => b.length - a.length);
    const bestCluster = clusters[0];
    if (bestCluster.length >= Math.ceil(totalLines * 0.3)) {
      const gapCenters = bestCluster.map(g => (g.gapLeft + g.gapRight) / 2).sort((a, b) => a - b);
      const median = gapCenters[Math.floor(gapCenters.length / 2)];
      candidates.push({ separator: median, source: '行內gap' });
    }

    console.log(
      `[pdfTextExtract][${_ts()}] 🔎 行內 gap 定位: gaps=${gapInfos.length}` +
      `, clusters=${clusters.map(c => {
        const rights = c.map(g => g.gapRight);
        return `[n=${c.length}, R=${Math.round(Math.min(...rights))}-${Math.round(Math.max(...rights))}]`;
      }).join(', ')}` +
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
  // LowBand: minCovCenterX = 覆蓋最低桶群的中心 X（比帶中點更精準，避免分界線落在文字中間）
  interface LowBand { startX: number; endX: number; minCov: number; minCovCenterX: number }
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
          // 找覆蓋最低桶群的中心位置
          let minCovSum = 0, minCovCount = 0;
          for (let mb = bandStart; mb < b; mb++) {
            if (coverage[mb] === bandMinCov) {
              minCovSum += globalMinX + (mb + 0.5) * COLUMN_BUCKET_WIDTH;
              minCovCount++;
            }
          }
          const minCovCenterX = minCovCount > 0 ? minCovSum / minCovCount : (startX + endX) / 2;
          lowBands.push({ startX, endX, minCov: bandMinCov, minCovCenterX });
        }
        bandStart = -1;
        bandMinCov = Infinity;
      }
    }
  }

  for (const band of lowBands) {
    // 分界線設在覆蓋最低的位置，而非帶的中點
    const bandSep = band.minCovCenterX;
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
    if (debug) {
      debug.columnSource = bestSource;
      debug.columnExclusiveRatio = Math.round(bestResult.exclusiveRatio * 100) / 100;
    }
    return [bestResult.leftHits, bestResult.rightHits];
  }

  // Fallback：投影法嚴格判斷（baseline 恰好對齊但覆蓋率極低）
  if (lowBands.length > 0) {
    lowBands.sort((a, b) => (b.endX - b.startX) - (a.endX - a.startX));
    const best = lowBands[0];
    const strictThreshold = Math.max(1, Math.ceil(totalLines * COLUMN_STRICT_COVERAGE_RATIO));
    if (best.minCov < strictThreshold && (best.endX - best.startX) >= COLUMN_STRICT_MIN_WIDTH) {
      // 用這個 lowBand 覆蓋最低桶的位置重新分
      const fallbackResult = testSeparator(hits, best.minCovCenterX);
      if (fallbackResult) {
        console.log(
          `[pdfTextExtract][${_ts()}] 📊 偵測到 2 欄佈局（投影法 strict fallback）：${fallbackResult.detail}`
        );
        if (debug) {
          debug.columnSource = '投影法 strict fallback';
          debug.columnExclusiveRatio = Math.round(fallbackResult.exclusiveRatio * 100) / 100;
        }
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

// ============================================================
// Phase 3: 文字提取
// ============================================================

/**
 * extractTextFromBbox 的 debug 資料收集器
 * 由呼叫端（pdfTextExtract.ts）建立並傳入，extract 完成後包含所有中間參數
 */
export interface ExtractDebugCollector {
  /** 落入 bbox 的 Hit 列表 */
  hits: { str: string; x: number; y: number; h: number; right: number; baseline: number }[];
  /** 偵測到的欄數 */
  columns: number;
  /** 多欄分界線位置 */
  columnSeparator?: number;
  /** 獨有行比例 */
  columnExclusiveRatio?: number;
  /** 多欄偵測來源 */
  columnSource?: string;
  /** 行數 */
  lineCount: number;
  /** 實際分行閾值 */
  lineThreshold: number;
  /** 是否自適應 */
  adaptiveThreshold: boolean;
  /** 各行距 */
  lineGaps: number[];
  /** 行距中位數 */
  medianLineGap: number;
  /** Y-overlap 行合併事件 */
  yOverlapMerges?: { str: string; blDiff: number; overlap: number; toLineIdx: number }[];
  /** 行碎片重組事件 */
  fragmentMerges?: { fromLine: number; toLine: number; combinedXMin: number; combinedXMax: number }[];
  /** 自適應閾值計算詳情 */
  adaptiveDetail?: {
    path: 'stable' | 'fallback' | 'none';
    stableCount?: number;
    minStableSpacing?: number;
    microClusterCount?: number;
    medianMicroSpacing?: number;
  };
}

/**
 * 把一組 hits 按閱讀順序排序並拼接成文字
 * 排序：先按 baseline 分行（聚類），再行內按 X（左→右）
 * ⚠️ 不能直接用帶 threshold 的 comparator sort（不可傳遞性問題）：
 *    超連結等異字型的 baseline 微偏，使相鄰行 items 被混為同行後按 X 排序導致交錯
 * 同一行內若偵測到明顯水平間距（表格不同欄），自動插入 TAB
 * 行距突然變大時（段落間距 > 正常行距 × 1.4）自動插入空行
 * @param debug 可選 debug 收集器 — 傳入時會寫入行分組相關資訊
 */
export function formatColumnText(hits: Hit[], debug?: ExtractDebugCollector): string {
  if (hits.length === 0) return '';

  // === Step 1: 按 baseline 排序 ===
  const sorted = [...hits].sort((a, b) => a.normBaseline - b.normBaseline);

  // === Step 2: 自適應行分組閾值 ===
  // 固定閾值（SAME_LINE_THRESHOLD=15）在行距緊湊的 PDF 中可能 >= 實際行距，
  // 導致相鄰行被合併後按 X 排序 → 文字交錯。
  // 解法：先用微聚類（閾值=3）找出穩定行（≥2 items），計算真正的行距，
  //       再用行距 × 0.7 作為分行閾值。超連結等 baseline 偏移的單 item 被過濾掉，不影響行距估算。
  let lineThreshold = SAME_LINE_THRESHOLD;
  let _adaptivePath: 'stable' | 'fallback' | 'none' = 'none';
  let _stableCount = 0;
  let _minStableSpacing: number | undefined;
  let _microClusterCount = 0;
  let _medianMicroSpacing: number | undefined;

  if (sorted.length >= 4) {
    const MICRO_THRESHOLD = 3; // 微聚類閾值：baseline 差 < 3 → 肯定同行
    const microClusters: { baseline: number; count: number }[] =
      [{ baseline: sorted[0].normBaseline, count: 1 }];
    for (let i = 1; i < sorted.length; i++) {
      const last = microClusters[microClusters.length - 1];
      if (sorted[i].normBaseline - last.baseline < MICRO_THRESHOLD) {
        last.count++;
      } else {
        microClusters.push({ baseline: sorted[i].normBaseline, count: 1 });
      }
    }
    _microClusterCount = microClusters.length;

    // 穩定行 = count >= 2 的微聚類（超連結等異字型通常只有 1 個 item）
    const stableClusters = microClusters.filter(c => c.count >= 2);
    _stableCount = stableClusters.length;
    if (stableClusters.length >= 2) {
      let minSpacing = Infinity;
      for (let i = 1; i < stableClusters.length; i++) {
        minSpacing = Math.min(minSpacing, stableClusters[i].baseline - stableClusters[i - 1].baseline);
      }
      _minStableSpacing = Math.round(minSpacing * 10) / 10;
      if (minSpacing > 3 && minSpacing < SAME_LINE_THRESHOLD) {
        lineThreshold = Math.max(3, minSpacing * 0.7);
        _adaptivePath = 'stable';
        console.log(
          `[pdfTextExtract][${_ts()}] 🎯 自適應行閾值: 穩定行=${stableClusters.length}` +
          `, 最小行距=${minSpacing.toFixed(1)}, 閾值=${lineThreshold.toFixed(1)}` +
          ` (原=${SAME_LINE_THRESHOLD})`
        );
      }
    }
    // Fallback：穩定聚類沒有產生有效閾值時（間距太大或穩定聚類不足），
    // 用所有微聚類間距的中位數估算行距
    if (lineThreshold === SAME_LINE_THRESHOLD && microClusters.length >= 3) {
      const spacings: number[] = [];
      for (let i = 1; i < microClusters.length; i++) {
        spacings.push(microClusters[i].baseline - microClusters[i - 1].baseline);
      }
      spacings.sort((a, b) => a - b);
      const medianSpacing = spacings[Math.floor(spacings.length / 2)];
      _medianMicroSpacing = Math.round(medianSpacing * 10) / 10;
      if (medianSpacing > 3 && medianSpacing < SAME_LINE_THRESHOLD) {
        lineThreshold = Math.max(3, medianSpacing * 0.7);
        _adaptivePath = 'fallback';
        console.log(
          `[pdfTextExtract][${_ts()}] 🎯 自適應行閾值(fallback): 微聚類=${microClusters.length}` +
          `, 中位數行距=${medianSpacing.toFixed(1)}, 閾值=${lineThreshold.toFixed(1)}` +
          ` (原=${SAME_LINE_THRESHOLD})`
        );
      }
    }
  }

  // === Step 3: 按自適應閾值聚類分行 ===
  // 用「排序→順序聚類」代替直接帶 threshold 的 sort，避免不可傳遞性：
  // 超連結 (report) 等異字型的 baseline 微偏 → 直接 sort 時相鄰行 items 混合 → 行交錯
  // 輔以 Y 重疊檢查：粗體/不同字型的 baseline 偏移超出閾值時，
  // 若 item 的 [normY, normBaseline] 與當前行 coreYRange 有重疊 → 仍視為同行
  const lines: Hit[][] = [[sorted[0]]];
  // coreYRange：僅由 baseline 近接合併的 items 定義（Y-overlap 合併不更新）
  // → 避免連鎖擴張（A 拉進 B，B 的 Y 範圍又拉進下一行 C）
  const coreYRanges: { top: number; bottom: number }[] = [
    { top: sorted[0].normY, bottom: sorted[0].normBaseline }
  ];

  for (let i = 1; i < sorted.length; i++) {
    const lastLine = lines[lines.length - 1];
    const coreYRange = coreYRanges[coreYRanges.length - 1];

    if (sorted[i].normBaseline - lastLine[0].normBaseline < lineThreshold) {
      // 同行（baseline 近接）
      lastLine.push(sorted[i]);
      coreYRange.top = Math.min(coreYRange.top, sorted[i].normY);
      coreYRange.bottom = Math.max(coreYRange.bottom, sorted[i].normBaseline);
    } else {
      // baseline 超出閾值 → 檢查 Y 範圍是否與當前行 core 重疊
      const overlapTop = Math.max(coreYRange.top, sorted[i].normY);
      const overlapBottom = Math.min(coreYRange.bottom, sorted[i].normBaseline);

      if (overlapBottom - overlapTop >= Y_OVERLAP_MIN) {
        // Y 重疊（至少 Y_OVERLAP_MIN 單位）→ 同一視覺行（粗體 + 正文等 baseline 偏移情境），不更新 coreYRange
        const blDiff = sorted[i].normBaseline - lastLine[0].normBaseline;
        const overlapAmount = overlapBottom - overlapTop;
        console.log(
          `[pdfTextExtract][${_ts()}] 🔀 Y-overlap 行合併: blDiff=` +
          `${blDiff.toFixed(1)}` +
          ` > threshold=${lineThreshold.toFixed(1)}, Y overlap=${overlapAmount.toFixed(1)}` +
          ` → "${sorted[i].str.substring(0, 30)}"`
        );
        if (debug) {
          if (!debug.yOverlapMerges) debug.yOverlapMerges = [];
          debug.yOverlapMerges.push({
            str: sorted[i].str.substring(0, 50),
            blDiff: Math.round(blDiff * 10) / 10,
            overlap: Math.round(overlapAmount * 10) / 10,
            toLineIdx: lines.length - 1,
          });
        }
        lastLine.push(sorted[i]);
      } else {
        // 不同行
        lines.push([sorted[i]]);
        coreYRanges.push({ top: sorted[i].normY, bottom: sorted[i].normBaseline });
      }
    }
  }

  // 每行內按 X 排序（左→右）
  for (const line of lines) {
    line.sort((a, b) => a.normX - b.normX);
  }

  // === Step 3.5: 行碎片重組（超連結 baseline 偏移修復） ===
  // 超連結/不同字型的 text item 可能有偏移的 baseline，導致同一視覺行被拆成碎片
  // 分散到不同行聚類中（如 "2028 (report) and..." 被拆成 "2028 (" 和 "report) and..."）
  // 偵測 X 跨度不足的碎片行，與 X 互補的近鄰碎片合併
  if (lines.length >= 3) {
    const getLineXInfo = (line: Hit[]) => {
      const minX = Math.min(...line.map(h => h.normX));
      const maxX = Math.max(...line.map(h => h.normRight));
      return { minX, maxX, span: maxX - minX };
    };

    const lineXInfos = lines.map(getLineXInfo);

    // 參考行寬：取所有行跨度的 75th percentile（排除碎片和短行的影響）
    const sortedSpans = lineXInfos.map(li => li.span).sort((a, b) => a - b);
    const refSpan = sortedSpans[Math.floor(sortedSpans.length * 0.75)];

    if (refSpan > 50) {
      const FRAGMENT_RATIO = 0.7;     // X 跨度 < 參考的 70% → 疑似碎片
      const MAX_MERGE_DISTANCE = 3;   // 最多跨幾行搜尋配對碎片
      const BASELINE_MERGE_LIMIT = lineThreshold * 2.5; // 碎片合併的 baseline 容差
      const COMPLEMENT_RATIO = 1.2;   // 合併後 X 跨度至少比各自最大的大 20%

      for (let i = 0; i < lines.length; i++) {
        if (lineXInfos[i].span >= refSpan * FRAGMENT_RATIO) continue; // 不是碎片

        for (let j = i + 1; j < Math.min(i + MAX_MERGE_DISTANCE + 1, lines.length); j++) {
          if (lineXInfos[j].span >= refSpan * FRAGMENT_RATIO) continue; // 不是碎片

          // Baseline 距離檢查
          const blDiff = Math.abs(lines[i][0].normBaseline - lines[j][0].normBaseline);
          if (blDiff > BASELINE_MERGE_LIMIT) continue;

          // X 互補性檢查：合併後跨度應明顯大於各自跨度
          const combinedMinX = Math.min(lineXInfos[i].minX, lineXInfos[j].minX);
          const combinedMaxX = Math.max(lineXInfos[i].maxX, lineXInfos[j].maxX);
          const combinedSpan = combinedMaxX - combinedMinX;
          if (combinedSpan < Math.max(lineXInfos[i].span, lineXInfos[j].span) * COMPLEMENT_RATIO) continue;

          // 合併 j 到 i
          console.log(
            `[pdfTextExtract][${_ts()}] 🔗 行碎片重組: 合併行[${i}](X=${Math.round(lineXInfos[i].minX)}-${Math.round(lineXInfos[i].maxX)})` +
            ` + 行[${j}](X=${Math.round(lineXInfos[j].minX)}-${Math.round(lineXInfos[j].maxX)})` +
            ` → X=${Math.round(combinedMinX)}-${Math.round(combinedMaxX)}`
          );
          if (debug) {
            if (!debug.fragmentMerges) debug.fragmentMerges = [];
            debug.fragmentMerges.push({
              fromLine: j,
              toLine: i,
              combinedXMin: Math.round(combinedMinX),
              combinedXMax: Math.round(combinedMaxX),
            });
          }

          lines[i].push(...lines[j]);
          lines[i].sort((a, b) => a.normX - b.normX);
          lines.splice(j, 1);
          lineXInfos[i] = { minX: combinedMinX, maxX: combinedMaxX, span: combinedSpan };
          lineXInfos.splice(j, 1);
          j--; // 繼續搜尋同一 i 的更多配對碎片
        }
      }
    }
  }

  // === Step 4: 計算行距（段落間距偵測 — 局部自適應） ===
  // 用局部窗口 lower 30th percentile（±PARA_WINDOW 行距）取代全域中位數，
  // 抓出區域內的「基本行距」（續行間距），讓 bullet 間距 / 段落間距能正確突出
  const lineGaps: number[] = []; // 保留原始順序，供局部窗口使用
  let medianLineGap = 0;

  for (let i = 1; i < lines.length; i++) {
    lineGaps.push(lines[i][0].normBaseline - lines[i - 1][0].normBaseline);
  }

  if (lineGaps.length >= 2) {
    const sortedGaps = [...lineGaps].sort((a, b) => a - b);
    medianLineGap = sortedGaps[Math.floor(sortedGaps.length / 2)];

    console.log(
      `[pdfTextExtract][${_ts()}] 📏 行距分析: 行數=${lines.length}, 全域中位數=${medianLineGap.toFixed(1)}` +
      `, 全域閾值=${(medianLineGap * PARA_GAP_RATIO).toFixed(1)}` +
      `, 模式=${lineGaps.length >= 5 ? '局部自適應(LQ30)' : '全域中位數'}` +
      `, 各行距=[${lineGaps.map(g => g.toFixed(1)).join(',')}]`
    );
  }

  // === 寫入 debug 收集器 ===
  if (debug) {
    debug.lineCount = lines.length;
    debug.lineThreshold = lineThreshold;
    debug.adaptiveThreshold = lineThreshold !== SAME_LINE_THRESHOLD;
    debug.lineGaps = lineGaps.map(g => Math.round(g * 10) / 10);
    debug.medianLineGap = Math.round(medianLineGap * 10) / 10;
    debug.adaptiveDetail = {
      path: _adaptivePath,
      stableCount: _stableCount || undefined,
      minStableSpacing: _minStableSpacing,
      microClusterCount: _microClusterCount || undefined,
      medianMicroSpacing: _medianMicroSpacing,
    };
  }

  // === Step 5: 逐行拼接文字 ===
  // 行間：行距 > 局部基本行距 × PARA_GAP_RATIO → 空行（段落分隔），否則換行
  // 行內：間距 > COL_GAP_THRESHOLD → TAB，> SPACE_GAP_THRESHOLD → 空格
  //        gap < WRAPAROUND_THRESHOLD → 回彈偵測（不同行被誤歸同行的安全網）→ 換行
  let text = '';

  for (let li = 0; li < lines.length; li++) {
    // 行間分隔
    if (li > 0) {
      const gapIdx = li - 1;
      const lineGap = lineGaps[gapIdx];

      // 局部自適應段落偵測：取 ±PARA_WINDOW 範圍內的 lower 30th percentile 作為「基本行距」參考。
      // 用 lower percentile 而非 median：在 bullet list 區域，bullet 間距和續行間距混合，
      // median 會被 bullet 間距拉高，導致 bullet 間距不突出；
      // lower percentile 抓到續行的小間距（基本行距），讓 bullet 間距能正確突出為段落分隔
      let paraRef = medianLineGap; // 預設用全域中位數
      if (lineGaps.length >= 5) {
        const wStart = Math.max(0, gapIdx - PARA_WINDOW);
        const wEnd = Math.min(lineGaps.length - 1, gapIdx + PARA_WINDOW);
        const windowGaps = lineGaps.slice(wStart, wEnd + 1).sort((a, b) => a - b);
        paraRef = windowGaps[Math.floor(windowGaps.length * 0.3)];
      }

      if (paraRef > 0 && lineGap > paraRef * PARA_GAP_RATIO) {
        text += '\n\n'; // 段落分隔
      } else {
        text += '\n';
      }
    }

    // 行內拼接
    const line = lines[li];
    for (let hi = 0; hi < line.length; hi++) {
      if (hi > 0) {
        const gap = line[hi].normX - line[hi - 1].normRight;
        if (gap > COL_GAP_THRESHOLD) {
          text += '\t';
        } else if (gap > SPACE_GAP_THRESHOLD) {
          text += ' ';
        } else if (gap < WRAPAROUND_THRESHOLD) {
          // 回彈偵測：前一個 item 在行尾（normRight 很大），當前 item 回到行首（normX 很小）
          // 表示不同視覺行被誤歸為同一行（行距 < lineThreshold 時發生）
          // 插入換行作為安全網
          text += '\n';
        }
      }
      text += line[hi].str;
    }
  }

  return sanitizePuaChars(text);
}

/**
 * 從指定 bbox 中提取文字（收集交集文字項 + 多欄偵測 + 按閱讀順序拼接）
 * 若偵測到多欄佈局，先提取左欄全部文字、再提取右欄，避免左右混合
 * @param debug 可選 debug 收集器 — 傳入時會寫入 hits、多欄偵測、行分組等中間資料
 */
export function extractTextFromBbox(
  bbox: [number, number, number, number],
  textItems: NormTextItem[],
  debug?: ExtractDebugCollector,
): string {
  const [x1, y1, x2, y2] = bbox;

  // 收集與 bbox 有交集的文字項（含右邊緣座標與 baseline，用於排序和欄間距計算）
  const hits: Hit[] = [];

  for (const ti of textItems) {
    const tiRight = ti.normX + ti.normW;
    if (ti.normX < x2 && tiRight > x1 && ti.normY < y2 && ti.normBaseline > y1) {
      hits.push({ str: ti.str, normX: ti.normX, normBaseline: ti.normBaseline, normRight: tiRight, normY: ti.normY });
    }
  }

  // Debug: 印出 bbox 範圍和 hits 的 X 分布摘要
  if (hits.length > 0) {
    const hMinX = Math.min(...hits.map(h => h.normX));
    const hMaxX = Math.max(...hits.map(h => h.normRight));
    console.log(
      `[pdfTextExtract][${_ts()}] 🔍 extractTextFromBbox: bbox=[${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)}]` +
      `, hits=${hits.length}, X range=[${Math.round(hMinX)}-${Math.round(hMaxX)}]`
    );
  }

  // 寫入 debug 收集器：hits 資料
  if (debug) {
    debug.hits = hits.map(h => ({
      str: h.str,
      x: Math.round(h.normX),
      y: Math.round(h.normY),
      h: Math.round(h.normBaseline - h.normY),
      right: Math.round(h.normRight),
      baseline: Math.round(h.normBaseline),
    }));
  }

  // 偵測多欄佈局
  const columns = splitIntoColumns(hits, debug);

  // 寫入 debug 收集器：多欄偵測結果
  if (debug) {
    debug.columns = columns.length;
    // 多欄時記錄分界線（取左欄右邊緣和右欄左邊緣的中點）
    if (columns.length > 1 && !debug.columnSeparator) {
      const leftMaxX = Math.max(...columns[0].map(h => h.normRight));
      const rightMinX = Math.min(...columns[1].map(h => h.normX));
      debug.columnSeparator = Math.round((leftMaxX + rightMinX) / 2);
    }
  }

  if (columns.length <= 1) {
    // 單欄：直接排序拼接
    return formatColumnText(hits, debug);
  }

  // 多欄：每欄獨立提取，欄間空一行分隔（debug 只寫入第一欄的行分組資訊）
  return columns.map((col, ci) => formatColumnText(col, ci === 0 ? debug : undefined)).join('\n\n');
}
