/**
 * 把 pdfjs worker 複製到 public/，讓 app 以同源 /pdf.worker.min.mjs 載入。
 * 意圖：取代 unpkg CDN（跨來源 1MB + http→https 跳轉是首載 PDF 最大瓶頸）。
 * 於 prebuild/predev 跑，使 worker 永遠與 node_modules 內的 pdfjs 版本一致、不漂移。
 * pdfjs-dist 釘在 react-pdf/node_modules 下（非 hoist），故先從 react-pdf 解析脈絡找。
 */
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let workerPath;
try {
  const reactPdfDir = dirname(require.resolve('react-pdf/package.json'));
  workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs', { paths: [reactPdfDir] });
} catch {
  workerPath = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs');
}

const dest = join(root, 'public', 'pdf.worker.min.mjs');
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(workerPath, dest);
console.log(`[copy-pdf-worker] ${workerPath} -> ${dest}`);
