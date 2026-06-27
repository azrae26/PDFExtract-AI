/**
 * API: POST /api/read-file
 * 職責：根據本機絕對路徑讀取檔案並回傳 binary
 * 用途：前端貼上檔案路徑後，透過此 API 取得檔案內容轉為 File 物件
 * 安全：僅限 .pdf 副檔名，僅限 localhost 環境使用
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    // 防護：本路由用 fs 讀伺服器絕對路徑，公開暴露＝資訊洩漏面。
    // 設計上「路徑法」僅 localhost 有意義（伺服器＝本機），遠端伺服器看不到使用者本機磁碟、本就無用途，
    // 故 production（Railway 等部署）一律拒絕，只在本機 dev 放行。
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: '遠端不支援路徑讀檔，請改用複製檔案貼上或拖入' }, { status: 403 });
    }

    const { filePath } = await req.json();

    if (!filePath || typeof filePath !== 'string') {
      return NextResponse.json({ error: '缺少 filePath 參數' }, { status: 400 });
    }

    // 正規化路徑（處理 file:// URI、URL encoding）
    let normalizedPath = filePath.trim();
    if (normalizedPath.startsWith('file:///')) {
      normalizedPath = decodeURIComponent(normalizedPath.slice(8)); // 去掉 file:///
    } else if (normalizedPath.startsWith('file://')) {
      normalizedPath = decodeURIComponent(normalizedPath.slice(7));
    }
    // 處理 URL encoding（如 %20）
    normalizedPath = decodeURIComponent(normalizedPath);

    // 僅允許 .pdf
    if (!normalizedPath.toLowerCase().endsWith('.pdf')) {
      return NextResponse.json({ error: '僅支援 PDF 檔案' }, { status: 400 });
    }

    // 確認檔案存在
    const fileStat = await stat(normalizedPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return NextResponse.json({ error: `檔案不存在: ${normalizedPath}` }, { status: 404 });
    }

    const buffer = await readFile(normalizedPath);
    const fileName = path.basename(normalizedPath);

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'X-File-Name': encodeURIComponent(fileName),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '讀取檔案失敗';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
