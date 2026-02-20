/**
 * extract-first-page.ts — 從 PDF 複製出只含第一頁的新檔
 *
 * 用法：npx tsx extract-first-page.ts <input.pdf|pattern> [output.pdf]
 * 若未指定 output，預設為 <檔名>_page1.pdf
 * 支援 pattern（如 *5371*）解決 PowerShell 中文編碼問題
 */

import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve, basename, dirname } from 'path';

function resolveInputPath(pattern: string): string {
  const cwd = process.cwd();
  const withExt = pattern.endsWith('.pdf') ? pattern : pattern + '.pdf';
  const resolved = resolve(cwd, withExt);
  const dir = dirname(resolved);
  const base = basename(resolved);
  if (base.includes('*')) {
    const files = readdirSync(dir);
    const match = files.find((f) => {
      const regex = new RegExp('^' + base.replace(/\*/g, '.*') + '$');
      return regex.test(f) && f.endsWith('.pdf');
    });
    if (!match) throw new Error(`找不到符合 ${pattern} 的 PDF`);
    return join(dir, match);
  }
  return resolved;
}

async function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('用法: npx tsx extract-first-page.ts <input.pdf|pattern> [output.pdf]');
    process.exit(1);
  }

  const resolved = resolveInputPath(inputArg);
  const srcDoc = await PDFDocument.load(readFileSync(resolved));
  const pageCount = srcDoc.getPageCount();
  if (pageCount === 0) {
    console.error('PDF 無任何頁面');
    process.exit(1);
  }

  const newDoc = await PDFDocument.create();
  const [firstPage] = await newDoc.copyPages(srcDoc, [0]);
  newDoc.addPage(firstPage);

  const outputPath = process.argv[3]
    ? resolve(process.cwd(), process.argv[3])
    : join(dirname(resolved), basename(resolved, '.pdf') + '_page1.pdf');

  const pdfBytes = await newDoc.save();
  writeFileSync(outputPath, pdfBytes);
  console.log(`已建立：${outputPath}（共 1 頁，原檔 ${pageCount} 頁）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
