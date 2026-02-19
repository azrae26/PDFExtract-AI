/**
 * 功能：伺服器端設定同步 API
 * 職責：GET 讀取 / POST 寫入共享設定檔（settings.json），供多人共用同一套設定
 * 依賴：Node.js fs（讀寫 JSON 檔案）、環境變數 SETTINGS_PASSWORD + SETTINGS_DIR
 *
 * POST 需要密碼驗證（SETTINGS_PASSWORD 環境變數），GET 不需要驗證。
 * 設定檔案路徑：SETTINGS_DIR/settings.json（預設 ./data/settings.json）
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

/** 允許同步的設定欄位白名單（排除 apiKey） */
const ALLOWED_KEYS = [
  'prompt', 'tablePrompt', 'model', 'batchSize', 'skipLastPages',
  'brokerSkipMap', 'brokerAliasGroups', 'fileListWidth', 'leftWidth', 'rightWidth',
] as const;

/** 取得設定檔案完整路徑 */
function getSettingsPath(): string {
  const dir = process.env.SETTINGS_DIR || './data';
  return path.resolve(dir, 'settings.json');
}

/** GET /api/settings — 讀取伺服器端設定 */
export async function GET(): Promise<NextResponse> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const filePath = getSettingsPath();

    if (!fs.existsSync(filePath)) {
      console.log(`[SettingsRoute][${timestamp}] No settings file found at ${filePath}`);
      return NextResponse.json({ success: true, data: null });
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    console.log(`[SettingsRoute][${timestamp}] ✅ Settings loaded from ${filePath}`);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error(`[SettingsRoute][${timestamp}] ❌ Failed to read settings:`, err);
    return NextResponse.json(
      { success: false, error: '讀取設定失敗' },
      { status: 500 }
    );
  }
}

/** POST /api/settings — 寫入伺服器端設定（需密碼驗證，開發模式免密碼） */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

  try {
    const body = await request.json();
    const { password, settings } = body;

    // 開發模式跳過密碼驗證（next dev 自動設定 NODE_ENV=development）
    const isDev = process.env.NODE_ENV === 'development';
    if (!isDev) {
      const serverPassword = process.env.SETTINGS_PASSWORD;

      // 環境變數未設定 → 功能未啟用
      if (!serverPassword) {
        console.warn(`[SettingsRoute][${timestamp}] ⚠️ SETTINGS_PASSWORD not configured`);
        return NextResponse.json(
          { success: false, error: '伺服器未設定 SETTINGS_PASSWORD，上傳功能未啟用' },
          { status: 503 }
        );
      }

      // 密碼驗證
      if (!password || password !== serverPassword) {
        console.warn(`[SettingsRoute][${timestamp}] ❌ Invalid password attempt`);
        return NextResponse.json(
          { success: false, error: '密碼錯誤' },
          { status: 401 }
        );
      }
    }

    // 驗證 settings 是物件
    if (!settings || typeof settings !== 'object') {
      return NextResponse.json(
        { success: false, error: '設定格式不正確' },
        { status: 400 }
      );
    }

    // 只保留白名單內的欄位（防止注入 apiKey 等敏感資料）
    const sanitized: Record<string, unknown> = {};
    for (const key of ALLOWED_KEYS) {
      if (key in settings) {
        sanitized[key] = settings[key];
      }
    }

    // 確保目錄存在
    const filePath = getSettingsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 寫入檔案
    fs.writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf-8');
    console.log(`[SettingsRoute][${timestamp}] ✅ Settings saved to ${filePath}`);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error(`[SettingsRoute][${timestamp}] ❌ Failed to save settings:`, err);
    return NextResponse.json(
      { success: false, error: '儲存設定失敗' },
      { status: 500 }
    );
  }
}
