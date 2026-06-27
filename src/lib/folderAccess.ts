/**
 * 功能：File System Access API 的 IO 封裝（純函式，無 React）
 * 職責：選資料夾、查/請求讀取權限、列出資料夾內 PDF、取單檔 File 物件
 * 意圖：遠端網頁無法用「路徑字串」讀本機磁碟（瀏覽器安全邊界），但 File System Access API
 *       讓使用者一次授權一個資料夾後，網頁即可直接讀該夾檔案 bytes —— 遠端 HTTPS 可用、零本機程式。
 * 注意：僅 Chromium 系（Chrome/Edge）支援；Firefox/Safari 無 showDirectoryPicker，呼叫端須先 feature detect。
 */

export type FolderPdf = { name: string; handle: FileSystemFileHandle };

/** 是否支援 File System Access API（Firefox/Safari 為 false） */
export function isFolderAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** 開啟系統選資料夾對話框（含使用者手勢 → 該 session 自動取得讀取權限） */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({ mode: 'read' });
}

/**
 * 確保對 handle 有讀取權限。
 * @param request true=可向使用者請求（需在使用者手勢內呼叫，否則瀏覽器不顯示提示）；false=僅查詢不打擾
 * @returns 'granted' | 'prompt' | 'denied'
 */
export async function ensureReadPermission(
  handle: FileSystemHandle,
  request: boolean,
): Promise<PermissionState> {
  const opts: FileSystemHandlePermissionDescriptor = { mode: 'read' };
  const q = (await handle.queryPermission?.(opts)) ?? 'prompt';
  if (q === 'granted') return 'granted';
  if (request) return (await handle.requestPermission?.(opts)) ?? 'prompt';
  return q;
}

/** 列出資料夾內所有 PDF（依檔名排序，繁中 locale） */
export async function listPdfFiles(dir: FileSystemDirectoryHandle): Promise<FolderPdf[]> {
  const out: FolderPdf[] = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && entry.name.toLowerCase().endsWith('.pdf')) {
      out.push({ name: entry.name, handle: entry as FileSystemFileHandle });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  return out;
}

/** 從 file handle 取得 File 物件（瀏覽器端直接讀 bytes，免上傳伺服器） */
export async function readPdf(handle: FileSystemFileHandle): Promise<File> {
  return handle.getFile();
}
