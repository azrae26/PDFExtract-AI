/**
 * 功能：匯出研究報告代理端點
 * 職責：接收前端的報告資料，代理轉發到外部 API（https://data.uanalyze.twobitto.com/api/research-reports），
 *       解決瀏覽器直接跨域請求的 CORS 限制
 * 依賴：無
 */

import { NextRequest, NextResponse } from 'next/server';

const EXTERNAL_API = 'https://data.uanalyze.twobitto.com/api/research-reports';

/** POST /api/export-report — 代理轉發到外部研究報告 API */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const body = await request.json();

    const res = await fetch(EXTERNAL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    console.log(`[ExportReportRoute][${timestamp}] ${res.ok ? '✅' : '❌'} status=${res.status} name=${body.name}`);
    return NextResponse.json(data, { status: res.status });
  } catch (err) {
    console.error(`[ExportReportRoute][${timestamp}] ❌ Proxy error:`, err);
    return NextResponse.json(
      { status: 'error', error: { code: 500, message: ['代理轉發失敗，請檢查網路連線'], data: null } },
      { status: 500 }
    );
  }
}
