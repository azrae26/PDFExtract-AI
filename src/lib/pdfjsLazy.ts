/**
 * 功能：延遲載入 pdfjs（react-pdf 內含 pdfjs-dist ~605KB）的單例橋接。
 * 意圖＝把 pdfjs 移出「殼層 critical chunk」：useFileManager / useAnalysis 等在殼層 render 期被
 *       呼叫的 hook 原本靜態 `import { pdfjs } from 'react-pdf'`，使 pdfjs-dist 被打包進殼層 chunk、
 *       拖慢首屏（多花模組解析/初始化 CPU）。改成執行期（getDocument 時）才 `import('react-pdf')`，
 *       pdfjs 與殼層並行載入、且只在真要讀 PDF 時才付出成本。
 * 規則：殼層期模組對 pdfjs 的「值」使用（getDocument）一律走 getPdfjs()；型別一律 `import type`。
 *       PdfViewer 是唯一靜態用 react-pdf 算繪元件（Document/Page）者，已由 PDFExtractApp 以 next/dynamic
 *       拆成獨立 chunk，故 react-pdf/pdfjs 不再進殼層 chunk。
 * 不變量：workerSrc 必須在任何 getDocument / Document 算繪前設好（否則 worker 載入錯亂 → PDF 轉圈不出）。
 *         本函式於回傳 pdfjs 前設定；PdfViewer chunk 載入時亦自設——兩處同一 pdfjs-dist 單例、同一字串，
 *         冪等無衝突（誰先載誰設，值相同）。
 */
import { PDF_WORKER_SRC } from '@/lib/constants';

/** react-pdf 的 pdfjs 命名空間型別（純型別表達式，不產生 runtime import） */
type Pdfjs = typeof import('react-pdf')['pdfjs'];

let _pdfjsPromise: Promise<Pdfjs> | null = null;

/** 取得（必要時動態載入）pdfjs，並確保 workerSrc 已設定。單例：多次呼叫共用同一 import。 */
export function getPdfjs(): Promise<Pdfjs> {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import('react-pdf').then((m) => {
      m.pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
      return m.pdfjs;
    });
  }
  return _pdfjsPromise;
}
