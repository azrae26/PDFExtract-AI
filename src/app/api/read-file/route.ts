/**
 * API: POST /api/read-file（本機橋接讀檔）
 * 職責：根據本機絕對路徑讀檔回傳 binary，供「貼路徑」匯入。
 * 意圖：遠端站看不到使用者本機磁碟，路徑法唯一解＝由「本機跑著的這個服務」代理讀檔。
 *       遠端站跨來源打 http://localhost:3000/api/read-file，故需開 CORS + Private Network Access(PNA)。
 * 安全：① 僅 .pdf；② Host 守門——只有「以 localhost 被存取」才讀檔（伺服器＝本機才有意義）。
 *       遠端部署的本路由 Host 是公開域名 → 403，避免變成公開的 fs 讀取面。
 *       ③ CORS 僅放行 Railway 站與 localhost，其餘來源瀏覽器於 preflight 即擋下。
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFile, stat } from 'fs/promises';
import path from 'path';

/** 允許的跨來源：遠端 Railway 站 + 任意 localhost；其餘回 null（不給 CORS） */
function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null;
  if (origin === 'https://pdfai.up.railway.app') return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

/** 組 CORS 標頭（含 PNA：Chrome 對 public→localhost 的 preflight 需 Allow-Private-Network） */
function corsHeaders(origin: string | null): Record<string, string> {
  const allow = allowedOrigin(origin);
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-File-Name', // 遠端要讀此自訂標頭取原檔名，須 expose
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** 是否「以 localhost 被存取」（伺服器＝本機才允許讀檔） */
function isLocalHost(req: NextRequest): boolean {
  const host = req.headers.get('host') || '';
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

/** CORS preflight */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get('origin')) });
}

export async function POST(req: NextRequest) {
  const cors = corsHeaders(req.headers.get('origin'));
  try {
    // Host 守門：遠端部署（Host=公開域名）→ 拒絕，避免公開 fs 讀取面
    if (!isLocalHost(req)) {
      return NextResponse.json(
        { error: '此端點僅本機橋接可用（遠端伺服器無法讀你本機磁碟）' },
        { status: 403, headers: cors },
      );
    }

    const { filePath } = await req.json();

    if (!filePath || typeof filePath !== 'string') {
      return NextResponse.json({ error: '缺少 filePath 參數' }, { status: 400, headers: cors });
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
      return NextResponse.json({ error: '僅支援 PDF 檔案' }, { status: 400, headers: cors });
    }

    // 確認檔案存在
    const fileStat = await stat(normalizedPath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      return NextResponse.json({ error: `檔案不存在: ${normalizedPath}` }, { status: 404, headers: cors });
    }

    const buffer = await readFile(normalizedPath);
    const fileName = path.basename(normalizedPath);

    return new NextResponse(buffer, {
      headers: {
        ...cors,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        'X-File-Name': encodeURIComponent(fileName),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '讀取檔案失敗';
    return NextResponse.json({ error: msg }, { status: 500, headers: cors });
  }
}
