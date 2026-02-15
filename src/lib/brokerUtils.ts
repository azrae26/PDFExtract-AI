/**
 * 功能：券商名稱解析工具
 * 職責：從 PDF 檔名中解析券商名稱，提供預設券商忽略末尾頁數映射
 * 依賴：無（純函式模組）
 */

/** 預設券商忽略末尾頁數映射（使用者可自行調整） */
export const DEFAULT_BROKER_SKIP_MAP: Record<string, number> = {
  'Nomura': 4, 'Daiwa': 4, 'JPM': 4, 'HSBC': 4, 'GS': 4, 'MS': 4, 'Citi': 4,
  '凱基': 4, '國票': 4, '兆豐': 4, '統一': 4, '永豐': 4, '元大': 4, '中信': 4,
  '元富': 4, '群益': 4, '宏遠': 4, '康和': 4, '富邦': 4, '一銀': 4, '福邦': 4,
};

/** 券商英文縮寫 / 別名 → brokerSkipMap 中使用的中文名 */
const BROKER_ALIASES: Record<string, string> = {
  'KGI': '凱基',
};

/** 檢查字串是否像日期（7~8 位純數字，如 1150205 或 20250829） */
function looksLikeDate(s: string): boolean {
  return /^\d{7,8}$/.test(s);
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
export function parseBrokerFromFilename(filename: string, knownBrokers: string[]): string | undefined {
  const nameWithoutExt = filename.replace(/\.pdf$/i, '');

  // === 偵測主分隔符並分段（優先 _ → | → -）===
  let segments: string[] = [];
  let separator: '_' | '|' | '-' | null = null;

  const underscoreParts = nameWithoutExt.split('_').map((s) => s.trim()).filter(Boolean);
  if (underscoreParts.length >= 3) {
    segments = underscoreParts;
    separator = '_';
  } else {
    const pipeParts = nameWithoutExt.split('|').map((s) => s.trim()).filter(Boolean);
    if (pipeParts.length >= 3) {
      segments = pipeParts;
      separator = '|';
    } else {
      const dashParts = nameWithoutExt.split('-').map((s) => s.trim()).filter(Boolean);
      if (dashParts.length >= 3) {
        segments = dashParts;
        separator = '-';
      }
    }
  }

  if (segments.length < 3 || !separator) return undefined;

  // === Phase 1：用 knownBrokers + 別名匹配 ===
  // 優先順序：最後一段 → 第一段 → 第二段 → 其餘中間段
  const checkOrder = [
    segments[segments.length - 1],
    segments[0],
    segments[1],
    ...segments.slice(2, -1),
  ];

  for (const seg of checkOrder) {
    // 別名精確匹配（如 KGI → 凱基）
    const alias = BROKER_ALIASES[seg];
    if (alias) return alias;

    // 精確匹配
    if (knownBrokers.includes(seg)) return seg;

    // 包含匹配（如「凱基投顧」包含「凱基」、「元大投顧」包含「元大」）
    for (const broker of knownBrokers) {
      if (seg.includes(broker)) return broker;
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
