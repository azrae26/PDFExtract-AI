/**
 * 功能：從 PDF 頁面的文字層中，根據 bounding box 座標提取文字，並自動校正不完整的 bbox
 * 職責：接收 pdfjs PDFPageProxy + Region[]，利用 getTextContent() 取得文字項，
 *       呼叫 pdfTextExtractCore 的純函式完成 snap → resolve → enforce → descender → extract 流程，
 *       並在各 phase 間快照 bbox 供 debug 診斷
 *       本檔案僅負責 pdfjs 的 IO 層（getTextContent + 座標轉換），所有演算法在 core 中
 * 依賴：pdfjs-dist (PDFPageProxy)、pdfTextExtractCore（純演算法）、types.ts（RegionDebugInfo）
 */

import { pdfjs } from 'react-pdf';
import { Region, RegionDebugInfo } from './types';
import {
  NormTextItem,
  NORMALIZED_MAX,
  _ts,
  snapBboxToText,
  resolveOverlappingLines,
  enforceMinVerticalGap,
  applyDescenderCompensation,
  extractTextFromBbox,
  ExtractDebugCollector,
  isWingdingsFont,
  sanitizeWingdings,
} from './pdfTextExtractCore';

/** pdfjs TextItem（有 transform 的文字項） */
interface PdfTextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, tx, ty]
  width: number;
  height: number;
  fontName?: string;
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

  // === 符號字型偵測（Wingdings/Webdings/ZapfDingbats 等） ===
  // 問題：pdfjs 將這些字型的字元碼映射為普通 ASCII（如 ■ → 'n'），
  //        但 textContent.styles 的 fontFamily 常被抹平為 "sans-serif"，無法直接偵測。
  // 解法：先嘗試 fontFamily 快速路徑；若失敗，呼叫 getOperatorList() 觸發字型物件載入，
  //        再從 commonObjs.get(fontName).name 取得真實字型名稱（如 "XRJBSJ+Wingdings-Regular"）。
  const styles = textContent.styles as Record<string, { fontFamily: string }>;
  const wingdingsFonts = new Set<string>();

  // 路徑 1: fontFamily 快速掃描（某些 PDF 的 fontFamily 可直接偵測）
  for (const [fontName, style] of Object.entries(styles)) {
    if (style.fontFamily && isWingdingsFont(style.fontFamily)) {
      wingdingsFonts.add(fontName);
    }
  }

  // 路徑 2: 若 fontFamily 偵測不到，透過 getOperatorList → commonObjs 取得真實字型名稱
  if (wingdingsFonts.size === 0) {
    try {
      await page.getOperatorList(); // 觸發字型物件 resolve（副作用）
      for (const fontName of Object.keys(styles)) {
        try {
          const fontObj = (page as any).commonObjs.get(fontName);
          if (fontObj?.name && isWingdingsFont(fontObj.name)) {
            wingdingsFonts.add(fontName);
          }
        } catch {
          // 個別字型可能尚未 resolve，安全跳過
        }
      }
    } catch {
      // getOperatorList 失敗時靜默降級（不影響文字提取）
    }
  }

  if (wingdingsFonts.size > 0) {
    // 印出偵測來源，方便 debug
    const details = [...wingdingsFonts].map(fn => {
      try {
        const fontObj = (page as any).commonObjs.get(fn);
        return `${fn}→${fontObj?.name || styles[fn]?.fontFamily || '?'}`;
      } catch {
        return `${fn}→${styles[fn]?.fontFamily || '?'}`;
      }
    }).join(', ');
    console.log(`[pdfTextExtract][${_ts()}] 🔤 偵測到符號字型: ${details}`);
  }

  // 將每個文字項轉換為歸一化座標
  const textItems: NormTextItem[] = [];

  for (const item of textContent.items) {
    // 過濾掉沒有 transform 的項目（如 TextMarkedContent）
    if (!('transform' in item) || !('str' in item)) continue;
    const ti = item as unknown as PdfTextItem;
    if (!ti.str.trim()) continue; // 跳過空白

    // Wingdings 字型替換：字型的 fontFamily 含 Wingdings/Webdings/ZapfDingbats 時，
    // 字元碼為普通 ASCII（不在 PUA 範圍），需在此處提前替換
    let str = ti.str;
    if (ti.fontName && wingdingsFonts.has(ti.fontName)) {
      str = sanitizeWingdings(str);
    }
    if (!str.trim()) continue; // 替換後可能變空白

    const tx = ti.transform[4]; // x 座標（PDF 座標系，左下原點）
    const ty = ti.transform[5]; // y 座標（PDF 座標系，左下原點）
    const w = ti.width;
    const h = ti.height;

    // PDF 座標系（左下原點）→ 歸一化座標（左上原點，0~1000）
    const normX = (tx / vw) * NORMALIZED_MAX;
    const normY = ((vh - ty - h) / vh) * NORMALIZED_MAX; // 翻轉 Y 軸，ty+h 是文字頂部
    const normW = (w / vw) * NORMALIZED_MAX;
    const normH = (h / vh) * NORMALIZED_MAX;

    textItems.push({ str, normX, normY, normW, normH, normBaseline: normY + normH });
  }

  // === Phase 1: Snap — 水平校正 + Y 軸半行補足 ===
  const snappedBboxes: [number, number, number, number][] = regions.map(
    (r) => snapBboxToText(r.bbox, textItems)
  );
  // Debug 快照：snap 後
  const afterSnap: [number, number, number, number][] = snappedBboxes.map(
    b => [...b] as [number, number, number, number]
  );

  // === Phase 2: Resolve — 跨 region 重疊行解衝突 ===
  resolveOverlappingLines(snappedBboxes, textItems);
  // Debug 快照：resolve 後
  const afterResolve: [number, number, number, number][] = snappedBboxes.map(
    b => [...b] as [number, number, number, number]
  );

  // === Phase 2.5: 保證框間最小垂直間距 ===
  enforceMinVerticalGap(snappedBboxes);
  // Debug 快照：enforce 後
  const afterEnforce: [number, number, number, number][] = snappedBboxes.map(
    b => [...b] as [number, number, number, number]
  );

  // === Phase 2.75: 降部補償（在 resolve/enforce 之後，避免汙染前面的座標判斷） ===
  applyDescenderCompensation(snappedBboxes, textItems);

  // === Phase 3: 提取文字 + 組裝結果（含 debug 收集） ===
  return regions.map((region, i) => {
    const finalBbox = snappedBboxes[i];

    // 建立 debug 收集器，交給 extractTextFromBbox 填寫 hits/columns/lines 資訊
    const debugCollector: ExtractDebugCollector = {
      hits: [],
      columns: 1,
      lineCount: 0,
      lineThreshold: 0,
      adaptiveThreshold: false,
      lineGaps: [],
      medianLineGap: 0,
    };
    const text = extractTextFromBbox(finalBbox, textItems, debugCollector);

    // 組裝完整 debug 資訊
    const rnd = (b: [number, number, number, number]): [number, number, number, number] =>
      [Math.round(b[0]), Math.round(b[1]), Math.round(b[2]), Math.round(b[3])];

    const _debug: RegionDebugInfo = {
      totalTextItems: textItems.length,
      phases: {
        original: rnd(region.bbox),
        afterSnap: rnd(afterSnap[i]),
        afterResolve: rnd(afterResolve[i]),
        afterEnforce: rnd(afterEnforce[i]),
        final: rnd(finalBbox),
      },
      hits: debugCollector.hits,
      columns: debugCollector.columns,
      columnSeparator: debugCollector.columnSeparator,
      columnExclusiveRatio: debugCollector.columnExclusiveRatio,
      columnSource: debugCollector.columnSource,
      lineCount: debugCollector.lineCount,
      lineThreshold: debugCollector.lineThreshold,
      adaptiveThreshold: debugCollector.adaptiveThreshold,
      lineGaps: debugCollector.lineGaps,
      medianLineGap: debugCollector.medianLineGap,
    };

    // 符號字型偵測結果（fontName → 真實字型名稱）
    if (wingdingsFonts.size > 0) {
      const map: Record<string, string> = {};
      for (const fn of wingdingsFonts) {
        try {
          const fontObj = (page as any).commonObjs.get(fn);
          map[fn] = fontObj?.name || styles[fn]?.fontFamily || '?';
        } catch {
          map[fn] = styles[fn]?.fontFamily || '?';
        }
      }
      _debug.symbolicFonts = map;
    }

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

    return { ...region, bbox: finalBbox, originalBbox: region.bbox, text, _debug };
  });
}
