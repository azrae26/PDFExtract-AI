/**
 * 功能：券商名稱與檔名解析工具
 * 職責：從 PDF 檔名中解析日期（一律輸出西元 YYYY/MM/DD）/股票代號/券商名稱，提供券商忽略頁數預設值與券商映射工具
 * 依賴：無（純函式模組）
 */

/** 預設券商忽略末尾頁數映射（使用者可自行調整） */
export const DEFAULT_BROKER_SKIP_MAP: Record<string, number> = {
  'Daiwa': 6, 'JPM': 4, 'HSBC': 4, 'GS': 4, 'MS': 7, 'Citi': 8,
  '國票': 6, '兆豐': 3, '統一': 4, '永豐': 6, '元大': 4, '中信': 8,
  '元富': 2, '群益': 4, '宏遠': 2, '康和': 2, '富邦': 3, '一銀': 4, '福邦': 4,
  'Nomura': 4, '國泰': 6, '台新': 2, '合庫': 3, '凱基': 3, '凱基(一般報告)': 3, '玉山': 4,
  'MQ': 4, 'BofA': 5, 'CLSA': 3, 'memo': 1, '凱基(法說memo)': 1,
};

/** 預設券商映射群組（第一個值視為 canonical） */
export const DEFAULT_BROKER_ALIAS_GROUPS: string[] = [
  '凱基, 凱基(法說memo), 凱基(一般報告), KGI',
];

/** 將「券商映射群組字串」轉為 alias -> canonical map（key 為小寫） */
export function buildBrokerAliasMap(groups: string[]): Record<string, string> {
  const map: Record<string, string> = {};

  for (const group of groups) {
    const parts = group
      .split(/[，,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;

    const canonical = parts[0];
    for (const part of parts) {
      map[part.toLowerCase()] = canonical;
    }
  }

  return map;
}

/** 檢查日期是否完整（含年月日）；僅年「2024」或缺月日視為不完整 */
export function isCompleteDate(s: string | undefined): boolean {
  if (!s || !s.trim()) return false;
  const t = s.trim();
  if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(t)) return true;
  const digits = t.replace(/\D/g, '');
  return /^\d{8}$/.test(digits);
}

/** AI 回傳 unknow/unknown 時不納入候選、不顯示 */
export function shouldIgnoreBroker(s: string | undefined): boolean {
  if (!s || !s.trim()) return true;
  const lower = s.trim().toLowerCase();
  return lower === 'unknow' || lower === 'unknown';
}

/** 依映射表正規化券商名（找不到時回傳原值） */
export function normalizeBrokerByAlias(
  raw: string | undefined,
  aliasMap: Record<string, string>,
): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return aliasMap[value.toLowerCase()] || value;
}

/** 檢查字串是否像日期（7~8 位純數字，如 1150205 或 20250829） */
function looksLikeDate(s: string): boolean {
  return /^\d{7,8}$/.test(s);
}

/** 去除副檔名並將常見分隔符轉空白 */
function normalizeFilenameForTokens(filename: string): string {
  return filename
    .replace(/\.pdf$/i, '')
    .replace(/[|_()\[\]{}]/g, ' ')
    .replace(/[，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 候選 token 切割（保留英數與中文片段） */
function getFilenameTokens(filename: string): string[] {
  const normalized = normalizeFilenameForTokens(filename);
  return normalized
    .split(/[\s\-]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const ROC_OFFSET = 1911;

/** 將日期轉為西元展示格式（8 碼 -> YYYY/MM/DD，7 碼民國 -> 西元，6 碼 YYMMDD -> 20YY/MM/DD） */
function formatDateToken(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (/^\d{8}$/.test(digits)) {
    return `${digits.slice(0, 4)}/${digits.slice(4, 6)}/${digits.slice(6, 8)}`;
  }
  if (/^\d{7}$/.test(digits)) {
    const rocY = parseInt(digits.slice(0, 3), 10);
    const adY = String(rocY + ROC_OFFSET);
    return `${adY}/${digits.slice(3, 5)}/${digits.slice(5, 7)}`;
  }
  if (/^\d{6}$/.test(digits)) {
    const yy = parseInt(digits.slice(0, 2), 10);
    const adY = yy >= 0 && yy <= 99 ? String(2000 + yy) : String(1900 + yy);
    return `${adY}/${digits.slice(2, 4)}/${digits.slice(4, 6)}`;
  }
  return raw.trim();
}

function toPaddedDate(year: string, month: string, day: string): string {
  return `${year}/${month.padStart(2, '0')}/${day.padStart(2, '0')}`;
}

/** 民國年（3 碼字串）轉西元後與月日組合成 YYYY/MM/DD */
function rocToAdPaddedDate(rocYear: string, month: string, day: string): string {
  const adYear = String(parseInt(rocYear, 10) + ROC_OFFSET);
  return toPaddedDate(adYear, month, day);
}

/** 從檔名擷取日期（支援 YYYYMMDD / YYYMMDD / YYYY-MM-DD / YYY-M-D / 中文年月日） */
export function parseDateFromFilename(filename: string): string | undefined {
  const nameWithoutExt = filename.replace(/\.pdf$/i, '');

  // 使用「非數字邊界」而非 \b：可正確匹配底線分隔（如 _1150209_）
  const compactDate = nameWithoutExt.match(/(?<!\d)(20\d{2}[01]\d[0-3]\d)(?!\d)/);
  if (compactDate) {
    return formatDateToken(compactDate[1]);
  }
  // 9 碼容錯（多打一位，如 202511128 → 2025/11/12）
  const compactDate9 = nameWithoutExt.match(/(?<!\d)(20\d{2}[01]\d[0-3]\d)\d(?!\d)/);
  if (compactDate9) {
    return formatDateToken(compactDate9[1]);
  }

  const rocDate = nameWithoutExt.match(/(?<!\d)(\d{3}[01]\d[0-3]\d)(?!\d)/);
  if (rocDate) {
    return formatDateToken(rocDate[1]);
  }

  // 6 碼 YYMMDD（如 CTBC250901 → 2025/09/01）
  const yyMmd = nameWithoutExt.match(/(?<!\d)([0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01]))(?!\d)/);
  if (yyMmd) {
    return formatDateToken(yyMmd[1]);
  }

  // 8 碼 MMDDYYYY（如 08212025 → 2025/08/21）
  const mmDdYyyy = nameWithoutExt.match(/(?<!\d)((?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])(?:19|20)\d{2})(?!\d)/);
  if (mmDdYyyy) {
    const d = mmDdYyyy[1];
    return `${d.slice(4, 8)}/${d.slice(0, 2)}/${d.slice(2, 4)}`;
  }

  // 西元分隔格式（允許月份/日期不補 0）
  const separatedDate = nameWithoutExt.match(/(?<!\d)(20\d{2})[\/\-.]([01]?\d)[\/\-.]([0-3]?\d)(?!\d)/);
  if (separatedDate) {
    return toPaddedDate(separatedDate[1], separatedDate[2], separatedDate[3]);
  }

  // 民國分隔格式（允許月份/日期不補 0）→ 轉西元輸出
  const rocSeparatedDate = nameWithoutExt.match(/(?<!\d)(\d{3})[\/\-.]([01]?\d)[\/\-.]([0-3]?\d)(?!\d)/);
  if (rocSeparatedDate) {
    return rocToAdPaddedDate(rocSeparatedDate[1], rocSeparatedDate[2], rocSeparatedDate[3]);
  }

  // 中文年月日（西元）
  const zhDate = nameWithoutExt.match(/(?<!\d)(20\d{2})年([01]?\d)月([0-3]?\d)日?(?!\d)/);
  if (zhDate) {
    return toPaddedDate(zhDate[1], zhDate[2], zhDate[3]);
  }

  // 中文年月日（民國）→ 轉西元輸出
  const zhRocDate = nameWithoutExt.match(/(?<!\d)(\d{3})年([01]?\d)月([0-3]?\d)日?(?!\d)/);
  if (zhRocDate) {
    return rocToAdPaddedDate(zhRocDate[1], zhRocDate[2], zhRocDate[3]);
  }

  return undefined;
}

/** 從 parsedDate（如 2025/05/29）擷取西元年份，供代號解析排除「年份」候選 */
function yearFromParsedDate(parsed: string | undefined): number | undefined {
  if (!parsed) return undefined;
  const m = parsed.match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** 從檔名擷取股票代號（4 碼台股 / AAPL / TSLA / MSFTUS 類型） */
export function parseCodeFromFilename(
  filename: string,
  aliasMap: Record<string, string> = {},
  parsedDate?: string,
): string | undefined {
  const tokens = getFilenameTokens(filename);
  const dateYear = yearFromParsedDate(parsedDate);
  const isLikelyYear = (val: string): boolean =>
    dateYear != null && /^(19|20)\d{2}$/.test(val) && Math.abs(parseInt(val, 10) - dateYear) <= 5;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^\d{4}$/.test(token)) {
      if (tokens[i + 1]?.startsWith('年')) continue;
      if (isLikelyYear(token)) continue;
      return token;
    }
    const fourDigit = token.match(/^(\d{4})/);
    if (!fourDigit) continue;
    if (/^\d{6,8}/.test(token) || /^\d{4}年/.test(token) || tokens[i + 1]?.startsWith('年')) continue;
    if (isLikelyYear(fourDigit[1])) continue;
    return fourDigit[1];
  }

  for (const token of tokens) {
    const cleaned = token.toUpperCase();
    if (/^[A-Z]{2,8}$/.test(cleaned)) {
      if (aliasMap[cleaned.toLowerCase()]) continue;
      if (cleaned === 'PDF' || cleaned === 'KY') continue;
      return cleaned;
    }
  }

  return undefined;
}

/**
 * 從檔名解析券商名稱，支援多種格式：
 *   `_` 分隔：2454聯發科_1150205_台新.pdf / 20250318_KGI_資安產業.pdf
 *   `-` 分隔：統一-3217-優群-20250815.pdf / 合庫投顧-3363-上詮-20250526.pdf
 *   `|` 分隔：2313 華通 | 20260123 | 直邦.pdf
 *
 * 解析策略：
 *   Phase 1 — 用 knownBrokers + 別名在各段中精確/包含匹配（最可靠）
 *   Phase 2 — 位置啟發式 fallback（`-` 分隔取第一段，其餘取最後一段，須非日期/純數字/過長）
 */
export function parseBrokerFromFilename(
  filename: string,
  knownBrokers: string[],
  aliasMap: Record<string, string> = {},
): string | undefined {
  const nameWithoutExt = filename.replace(/\.pdf$/i, '');

  // === 偵測主分隔符並分段（優先 _ → | → -）===
  let segments: string[] = [];
  let separator: '_' | '|' | '-' | null = null;

  const underscoreParts = nameWithoutExt.split('_').map((s) => s.trim()).filter(Boolean);
  if (underscoreParts.length >= 2) {
    segments = underscoreParts;
    separator = '_';
  } else {
    const pipeParts = nameWithoutExt.split(/[|｜]/).map((s) => s.trim()).filter(Boolean);
    if (pipeParts.length >= 2) {
      segments = pipeParts;
      separator = '|';
    } else {
      const dashParts = nameWithoutExt.split('-').map((s) => s.trim()).filter(Boolean);
      if (dashParts.length >= 2) {
        segments = dashParts;
        separator = '-';
      }
    }
  }

  // === 年報格式偵測：\d{4}_\d{4}_..._\d{8}_\d{6}（年份_代號_識別碼_日期_時間）===
  // 例：2024_6728_20250521F04_20260219_193139.pdf → 券商名「年報」
  if (
    separator === '_' &&
    segments.length >= 5 &&
    /^\d{4}$/.test(segments[0]) &&
    /^\d{4}$/.test(segments[1]) &&
    /^\d{8}$/.test(segments[segments.length - 2]) &&
    /^\d{6}$/.test(segments[segments.length - 1])
  ) {
    return '年報';
  }

  // === Phase 0：檔名開頭為「券商名+日期」無分隔符（如 台新投顧20250403 對等關稅...）===
  if (segments.length < 2 || !separator) {
    const prefixToCanonical: { prefix: string; canonical: string }[] = [
      ...knownBrokers.map((b) => ({ prefix: b, canonical: b })),
      ...Object.keys(aliasMap).map((k) => ({ prefix: k, canonical: aliasMap[k] })),
    ];
    prefixToCanonical.sort((a, b) => b.prefix.length - a.prefix.length);
    for (const { prefix, canonical } of prefixToCanonical) {
      if (!prefix || !canonical) continue;
      const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d{6,8})`);
      if (re.test(nameWithoutExt)) return canonical;
    }
    return undefined;
  }

  // === Phase 1：用 knownBrokers + 別名匹配 ===
  // 優先順序：最後一段 → 第一段 → 第二段 → 其餘中間段
  const checkOrder = [
    segments[segments.length - 1],
    segments[0],
    segments[1],
    ...segments.slice(2, -1),
  ];

  for (const seg of checkOrder) {
    // 別名精確匹配（由 brokerAliasGroups 轉出的 aliasMap）
    const alias = aliasMap[seg.toLowerCase()];
    if (alias) return alias;

    // 券商+日期連寫（如 CTBC250901、CTBC+251112 → CTBC）
    const brokerDateMatch = seg.match(/^([A-Za-z]{2,8})(?:\+?)(\d{6,8})$/);
    if (brokerDateMatch) {
      const prefix = brokerDateMatch[1].toUpperCase();
      const aliasFromPrefix = aliasMap[prefix.toLowerCase()]
        ?? aliasMap[brokerDateMatch[1].toLowerCase()];
      if (aliasFromPrefix) return aliasFromPrefix;
      if (knownBrokers.includes(prefix)) return prefix;
    }

    // 精確匹配
    if (knownBrokers.includes(seg)) return seg;

    // 包含匹配：seg 包含 broker（如「凱基投顧」含「凱基」）或 broker 包含 seg（如「凱基」匹配「凱基(一般報告)」）
    for (const broker of knownBrokers) {
      if (seg.includes(broker)) return broker;
      if (broker.includes(seg)) return seg;
    }
  }

  // === Phase 2：位置啟發式 fallback ===
  if (separator === '-') {
    // `-` 分隔格式：券商通常在第一段（如「統一-3217-優群-20250815.pdf」）
    const first = segments[0].replace(/投顧$/, '').trim();
    if (first && !looksLikeDate(first) && !/^\d+$/.test(first) && first.length <= 10) {
      return first;
    }
  } else {
    // `_` 或 `|` 分隔格式：券商通常在最後一段
    const last = segments[segments.length - 1];
    if (last && !looksLikeDate(last) && !/^\d+$/.test(last) && last.length <= 10) {
      return last;
    }
  }

  return undefined;
}

/** 從檔名一次解析日期、股票代號、券商名 */
export function parseMetadataFromFilename(
  filename: string,
  knownBrokers: string[],
  aliasMap: Record<string, string> = {},
): { date?: string; code?: string; broker?: string } {
  const date = parseDateFromFilename(filename);
  const code = parseCodeFromFilename(filename, aliasMap, date);
  const broker = parseBrokerFromFilename(filename, knownBrokers, aliasMap);
  return { date, code, broker };
}
