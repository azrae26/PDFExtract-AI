/**
 * PDFExtract 本機橋接（獨立 Node http 服務，零依賴）
 * 意圖：遠端站「貼路徑」需本機程式代理讀檔——這支不依賴專案、不需 Next，雙擊安裝後可開機自啟。
 * 端點：POST /api/read-file {filePath} → 回 PDF binary（含 CORS + PNA，供遠端站跨來源呼叫）
 *       GET  /health → ok（供前端探測橋接是否在跑）
 * 安全：僅綁 127.0.0.1（不對外）、僅 .pdf、CORS 僅放行 Railway 站與 localhost。
 * 注意：此檔鏡像 src/app/api/read-file/route.ts 的讀檔/CORS 邏輯（獨立部署故無法共用），改一邊記得同步另一邊。
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const PORT = 38217;
const HOST = '127.0.0.1';

function allowedOrigin(origin) {
  if (!origin) return null;
  if (origin === 'https://pdfai.up.railway.app') return origin;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function corsHeaders(origin) {
  const allow = allowedOrigin(origin);
  if (!allow) return {};
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-File-Name',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const server = createServer(async (req, res) => {
  const cors = corsHeaders(req.headers.origin || null);
  const url = (req.url || '').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (req.method === 'POST' && url === '/api/read-file') {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { filePath } = JSON.parse(body || '{}');

      if (!filePath || typeof filePath !== 'string') {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 filePath 參數' }));
        return;
      }

      let p = filePath.trim();
      if (p.startsWith('file:///')) p = decodeURIComponent(p.slice(8));
      else if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7));
      try { p = decodeURIComponent(p); } catch { /* 路徑含未轉義 % 時保留原樣 */ }

      if (!p.toLowerCase().endsWith('.pdf')) {
        res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '僅支援 PDF 檔案' }));
        return;
      }

      const st = await stat(p).catch(() => null);
      if (!st || !st.isFile()) {
        res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `檔案不存在: ${p}` }));
        return;
      }

      const buf = await readFile(p);
      const name = basename(p);
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        'X-File-Name': encodeURIComponent(name),
      });
      res.end(buf);
      return;
    } catch (e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
      return;
    }
  }

  res.writeHead(404, cors);
  res.end();
});

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} 已被占用——橋接可能已在跑，或換個埠。`);
    process.exit(0); // 已在跑視為成功，避免重複啟動報錯
  }
  console.error('bridge error:', e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`PDFExtract bridge listening on http://${HOST}:${PORT}`);
});
