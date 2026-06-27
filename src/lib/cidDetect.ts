/**
 * 功能：CID passthrough 亂碼偵測（純數值判斷，零資料表）
 * 職責：判斷字串是否落在 Identity-H CID 未映射的 glyph-index 區間（視為亂碼）
 *
 * 為何獨立成檔：此函式是首屏分析路徑（analysisHelpers 亂碼偵測）唯一用到的 CID 工具，
 * 但原本與 kaiuCmap.ts 的 59KB base64 字型表（KAIU_B64）同檔——同 import 會把死碼 base64
 * 一起打進首屏 chunk。拆出後 kaiuCmap.ts 不再被首屏 import，base64 不進 bundle。
 */

/**
 * 判斷字串是否為 CID passthrough 亂碼：
 * 字元碼點大量落在 0x0100~0x1FFF（glyph index 偽裝成字元）時視為亂碼。
 */
export function isCidPassthrough(str: string): boolean {
  if (!str || str.length < 2) return false;
  let inRange = 0;
  for (let i = 0; i < str.length; i++) {
    const cp = str.charCodeAt(i);
    if (cp >= 0x0100 && cp <= 0x1FFF) inRange++;
  }
  return inRange / str.length > 0.4;
}
