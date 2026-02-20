/**
 * 功能：將 PDF 某頁（提取為獨立 PDF）、含框截圖、Debug JSON 儲存到本機磁碟
 * 職責：接收瀏覽器端傳來的 PDF base64 + 含框 JPEG base64 + debug JSON，
 *       用 pdf-lib 提取單頁後寫入 exports/ 資料夾
 * 依賴：Node.js fs（讀寫檔案）、pdf-lib（PDF 單頁提取）
 *
 * POST /api/save-page-export
 * 輸入：{ fileName, page, pdfBase64, jpgWithBoxesBase64, debugJson }
 * 輸出：{ success, savedTo, files }
 * 儲存位置：./exports/{fileBase}/p{page}.pdf | p{page}_boxes.jpg | p{page}_debug.json
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PDFDocument } from 'pdf-lib';

const _ts = () => new Date().toLocaleTimeString('en-US', { hour12: false });

/** 將檔名轉成安全的資料夾名（去副檔名 + 過濾非法字元） */
function sanitizeFileName(fileName: string): string {
  return fileName
    .replace(/\.[^/.]+$/, '')           // 去副檔名
    .replace(/[/\\:*?"<>|]/g, '_');     // 過濾 Windows/Unix 非法字元
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const {
      fileName,
      page,
      pdfBase64,
      jpgWithBoxesBase64,
      debugJson,
    } = body as {
      fileName: string;
      page: number;
      pdfBase64: string;
      jpgWithBoxesBase64: string;
      debugJson: Record<string, unknown>;
    };

    if (!fileName || !page || !pdfBase64 || !jpgWithBoxesBase64) {
      return NextResponse.json({ success: false, error: '缺少必要欄位' }, { status: 400 });
    }

    // 建立儲存目錄：./exports/{fileBase}/
    const exportsBase = path.resolve(process.cwd(), 'exports');
    const fileBase = sanitizeFileName(fileName);
    const saveDir = path.join(exportsBase, fileBase);
    fs.mkdirSync(saveDir, { recursive: true });

    const prefix = `p${page}`;

    // 提取單頁 PDF（0-indexed）
    const srcPdfBytes = Buffer.from(pdfBase64, 'base64');
    const srcDoc = await PDFDocument.load(srcPdfBytes);
    const pageCount = srcDoc.getPageCount();
    const pageIndex = page - 1;
    if (pageIndex < 0 || pageIndex >= pageCount) {
      return NextResponse.json(
        { success: false, error: `頁碼 ${page} 超出範圍（共 ${pageCount} 頁）` },
        { status: 400 }
      );
    }
    const singleDoc = await PDFDocument.create();
    const [copiedPage] = await singleDoc.copyPages(srcDoc, [pageIndex]);
    singleDoc.addPage(copiedPage);
    const singlePdfBytes = await singleDoc.save();

    // 儲存三個檔案
    const pagePdfPath = path.join(saveDir, `${prefix}.pdf`);
    const boxesJpgPath = path.join(saveDir, `${prefix}_boxes.jpg`);
    const debugJsonPath = path.join(saveDir, `${prefix}_debug.json`);

    fs.writeFileSync(pagePdfPath, singlePdfBytes);
    fs.writeFileSync(boxesJpgPath, Buffer.from(jpgWithBoxesBase64, 'base64'));
    fs.writeFileSync(debugJsonPath, JSON.stringify(debugJson, null, 2), 'utf-8');

    console.log(`[save-page-export][${_ts()}] 💾 已儲存第 ${page} 頁 PDF + 截圖：${saveDir}`);

    return NextResponse.json({
      success: true,
      savedTo: saveDir,
      files: {
        page: pagePdfPath,
        withBoxes: boxesJpgPath,
        debug: debugJsonPath,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[save-page-export][${_ts()}] ❌ 儲存失敗:`, msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
