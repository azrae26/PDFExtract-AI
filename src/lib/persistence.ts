/**
 * 功能：IndexedDB 狀態持久化封裝
 * 職責：將 files[]（含 PDF binary）和 activeFileId 存入 IndexedDB，支援頁面 refresh 後完整恢復
 * 依賴：types.ts（Region, FileEntry 型別）
 *
 * 資料架構：
 * - Database: pdfextract-ai-db (version 1)
 * - Object Store "session": key='state' → { activeFileId, files: SerializedFileEntry[] }
 * - Object Store "pdf-files": key=fileId → ArrayBuffer (PDF binary)
 */

import { Region, FileEntry } from '@/lib/types';

// === 常數 ===
const DB_NAME = 'pdfextract-ai-db';
const DB_VERSION = 2; // v2：新增 handles store（存 File System Access 資料夾 handle）
const STORE_SESSION = 'session';
const STORE_PDF_FILES = 'pdf-files';
const STORE_HANDLES = 'handles'; // 本機資料夾 handle（持久設定，非 session；clearAll 不清）
const KEY_DIR_HANDLE = 'dir';

// === 序列化格式（僅內部使用）===

/** Region 序列化時剔除 _debug（太大，refresh 後不需要） */
type SerializedRegion = Omit<Region, '_debug'>;

/** FileEntry 序列化格式（不含 File 物件和 blob URL） */
interface SerializedFileEntry {
  id: string;
  name: string;
  status: 'idle' | 'done' | 'stopped' | 'error';
  numPages: number;
  pageRegions: [number, SerializedRegion[]][];
  analysisPages: number;
  completedPages: number;
  dateCandidates?: FileEntry['dateCandidates'];
  codeCandidates?: FileEntry['codeCandidates'];
  brokerCandidates?: FileEntry['brokerCandidates'];
  selectedDate?: string;
  selectedCode?: string;
  selectedBroker?: string;
  report?: string;
}

/** 完整 session 存檔格式 */
interface SessionData {
  activeFileId: string | null;
  files: SerializedFileEntry[];
}

/** loadSession 回傳格式 */
export interface RestoredSession {
  activeFileId: string | null;
  files: FileEntry[];
}

// === IndexedDB 操作 ===

/** 開啟/建立 IndexedDB 資料庫 */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION);
      }
      if (!db.objectStoreNames.contains(STORE_PDF_FILES)) {
        db.createObjectStore(STORE_PDF_FILES);
      }
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** 正規化 status：processing/queued → stopped */
function normalizeStatus(status: FileEntry['status']): SerializedFileEntry['status'] {
  if (status === 'processing' || status === 'queued') return 'stopped';
  return status;
}

/** 序列化單一 Region（剔除 _debug、清除暫態文字） */
function serializeRegion(region: Region): SerializedRegion {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _debug, ...rest } = region;
  // 清除識別中/識別失敗的暫態文字（F5 後不應殘留）
  if (rest.text && (rest.text.startsWith('⏳') || rest.text.startsWith('❌'))) {
    return { ...rest, text: '' };
  }
  return rest;
}

/** 序列化 files 陣列 */
function serializeFiles(files: FileEntry[]): SerializedFileEntry[] {
  return files.map((f) => ({
    id: f.id,
    name: f.name,
    status: normalizeStatus(f.status),
    numPages: f.numPages,
    pageRegions: Array.from(f.pageRegions.entries()).map(
      ([pageNum, regions]) => [pageNum, regions.map(serializeRegion)] as [number, SerializedRegion[]]
    ),
    analysisPages: f.analysisPages,
    completedPages: f.completedPages,
    dateCandidates: f.dateCandidates ?? [],
    codeCandidates: f.codeCandidates ?? [],
    brokerCandidates: f.brokerCandidates ?? [],
    selectedDate: f.selectedDate ?? '',
    selectedCode: f.selectedCode ?? '',
    selectedBroker: f.selectedBroker ?? '',
    report: f.report,
  }));
}

/**
 * 儲存 session（activeFileId + files metadata/regions）到 IndexedDB
 * 注意：不含 PDF binary（由 savePdfBlob 獨立處理）
 */
export async function saveSession(activeFileId: string | null, files: FileEntry[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_SESSION, 'readwrite');
    const store = tx.objectStore(STORE_SESSION);

    const data: SessionData = {
      activeFileId,
      files: serializeFiles(files),
    };
    store.put(data, 'state');

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to save session:`, e);
  }
}

/**
 * 從 IndexedDB 載入 session，重建 File 物件與 blob URL
 * 若某個 fileId 的 PDF binary 找不到，跳過該檔案
 */
export async function loadSession(): Promise<RestoredSession | null> {
  try {
    const db = await openDB();

    // 讀取 session metadata
    const sessionData = await new Promise<SessionData | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_SESSION, 'readonly');
      const store = tx.objectStore(STORE_SESSION);
      const req = store.get('state');
      req.onsuccess = () => resolve(req.result as SessionData | undefined);
      req.onerror = () => reject(req.error);
    });

    if (!sessionData || !sessionData.files || sessionData.files.length === 0) {
      db.close();
      return null;
    }

    // 讀取所有 PDF binary
    const pdfBuffers = new Map<string, ArrayBuffer>();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_PDF_FILES, 'readonly');
      const store = tx.objectStore(STORE_PDF_FILES);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          pdfBuffers.set(cursor.key as string, cursor.value as ArrayBuffer);
          cursor.continue();
        } else {
          resolve();
        }
      };
      req.onerror = () => reject(req.error);
    });

    db.close();

    // 重建 FileEntry[]
    const restoredFiles: FileEntry[] = [];
    for (const sf of sessionData.files) {
      const buffer = pdfBuffers.get(sf.id);
      if (!buffer) {
        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.warn(`[persistence][${ts}] ⚠️ PDF binary not found for file "${sf.name}" (${sf.id}), skipping`);
        continue;
      }

      // 重建 File 物件和 blob URL
      const file = new File([buffer], sf.name, { type: 'application/pdf' });
      const url = URL.createObjectURL(file);

      // 重建 pageRegions Map
      const pageRegions = new Map<number, Region[]>(
        sf.pageRegions.map(([pageNum, regions]) => [pageNum, regions as Region[]])
      );

      restoredFiles.push({
        id: sf.id,
        file,
        url,
        name: sf.name,
        status: sf.status,
        numPages: sf.numPages,
        pageRegions,
        analysisPages: sf.analysisPages,
        completedPages: sf.completedPages,
        dateCandidates: sf.dateCandidates ?? [],
        codeCandidates: sf.codeCandidates ?? [],
        brokerCandidates: sf.brokerCandidates ?? [],
        selectedDate: sf.selectedDate ?? '',
        selectedCode: sf.selectedCode ?? '',
        selectedBroker: sf.selectedBroker ?? '',
        report: sf.report,
      });
    }

    if (restoredFiles.length === 0) return null;

    // 確保 activeFileId 指向一個實際存在的檔案
    let activeFileId = sessionData.activeFileId;
    if (activeFileId && !restoredFiles.some((f) => f.id === activeFileId)) {
      activeFileId = restoredFiles[0].id;
    }

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[persistence][${ts}] ✅ Restored ${restoredFiles.length} file(s) from IndexedDB`);

    return { activeFileId, files: restoredFiles };
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to load session:`, e);
    return null;
  }
}

/** 儲存 PDF binary 到 IndexedDB */
export async function savePdfBlob(fileId: string, arrayBuffer: ArrayBuffer): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PDF_FILES, 'readwrite');
    const store = tx.objectStore(STORE_PDF_FILES);
    store.put(arrayBuffer, fileId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to save PDF blob for ${fileId}:`, e);
  }
}

/** 刪除單一 PDF binary */
export async function deletePdfBlob(fileId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_PDF_FILES, 'readwrite');
    const store = tx.objectStore(STORE_PDF_FILES);
    store.delete(fileId);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to delete PDF blob for ${fileId}:`, e);
  }
}

/** 清空所有 IndexedDB 資料（session + PDF binary） */
export async function clearAll(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_SESSION, STORE_PDF_FILES], 'readwrite');
    tx.objectStore(STORE_SESSION).clear();
    tx.objectStore(STORE_PDF_FILES).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[persistence][${ts}] 🗑️ Cleared all IndexedDB data`);
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to clear IndexedDB:`, e);
  }
}

// === 本機資料夾 handle 持久化（File System Access API）===
// FileSystemDirectoryHandle 可被 structured clone，直接存 IndexedDB；重開後取回需再查/請求權限。
// 刻意獨立於 session（clearAll 不清）：資料夾連結是使用者持久設定，清空檔案不應斷開連結。

/** 儲存資料夾 handle */
export async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).put(handle, KEY_DIR_HANDLE);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to save dir handle:`, e);
  }
}

/** 取回資料夾 handle（無則回 null） */
export async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB();
    const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readonly');
      const req = tx.objectStore(STORE_HANDLES).get(KEY_DIR_HANDLE);
      req.onsuccess = () => resolve(req.result as FileSystemDirectoryHandle | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle ?? null;
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to load dir handle:`, e);
    return null;
  }
}

/** 清除資料夾 handle（取消連結） */
export async function clearDirHandle(): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).delete(KEY_DIR_HANDLE);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.warn(`[persistence][${ts}] ⚠️ Failed to clear dir handle:`, e);
  }
}
