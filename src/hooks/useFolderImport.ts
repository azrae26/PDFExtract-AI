/**
 * 功能：本機資料夾匯入的狀態管理 hook
 * 職責：還原已連結的資料夾 handle、管理讀取權限狀態、列出 PDF、提供連結/授權/重整/取消/取檔操作
 * 意圖：一次連結資料夾後，handle 存 IndexedDB；之後開站只要權限仍在就自動列出 → 點檔即匯入。
 *       權限若已 granted（裝成 PWA 或選過「每次造訪都允許」）則 mount 自動列出、零點擊；
 *       否則停在 'prompt'，由使用者按「授權」（需手勢）再列出 —— 每 session 至多一次。
 * 依賴：folderAccess（IO）、persistence（handle 持久化）
 */

import { useState, useEffect, useCallback } from 'react';
import {
  isFolderAccessSupported,
  pickDirectory,
  ensureReadPermission,
  listPdfFiles,
  readPdf,
  type FolderPdf,
} from '@/lib/folderAccess';
import { saveDirHandle, loadDirHandle, clearDirHandle } from '@/lib/persistence';

export type FolderPermission = 'granted' | 'prompt' | 'denied';

export interface UseFolderImport {
  supported: boolean;
  folderName: string | null;
  permission: FolderPermission;
  pdfs: FolderPdf[];
  loading: boolean;
  error: string | null;
  connect: () => Promise<void>;
  grant: () => Promise<void>;
  refresh: () => Promise<void>;
  forget: () => Promise<void>;
  openPdf: (handle: FileSystemFileHandle) => Promise<File | null>;
}

export default function useFolderImport(): UseFolderImport {
  const supported = isFolderAccessSupported();
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [permission, setPermission] = useState<FolderPermission>('prompt');
  const [pdfs, setPdfs] = useState<FolderPdf[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async (dir: FileSystemDirectoryHandle) => {
    console.log(`[PERF] 📂 loadList 觸發 @ ${Math.round(performance.now())}ms`);
    setLoading(true);
    setError(null);
    try {
      setPdfs(await listPdfFiles(dir));
      console.log(`[PERF] 📂 loadList setPdfs 完成 @ ${Math.round(performance.now())}ms`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取資料夾失敗');
    } finally {
      setLoading(false);
    }
  }, []);

  // mount：還原已存的資料夾 handle；權限已 granted 才自動列出（不打擾、不請求）
  // 延後列舉：資料夾可能上萬檔，列舉(iterate+排序)+渲染會與「活躍 PDF session 還原」搶主線程。
  // 故等主線程閒置(requestIdleCallback)再列，確保 PDF 先還原渲染；timeout 保險不會永不執行。
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let cancelDefer = () => {};
    (async () => {
      const stored = await loadDirHandle();
      if (!stored || cancelled) return;
      setHandle(stored);
      const perm = await ensureReadPermission(stored, false);
      if (cancelled) return;
      setPermission(perm as FolderPermission);
      console.log(`[PERF] 📂 資料夾權限=${perm} @ ${Math.round(performance.now())}ms`);
      if (perm === 'granted') {
        setLoading(true); // 立即顯示「讀取中」，避免延後期間閃現「沒有 PDF」
        const run = () => {
          console.log(`[PERF] 📂 idle 觸發列舉 @ ${Math.round(performance.now())}ms`);
          if (!cancelled) loadList(stored);
        };
        if (typeof window.requestIdleCallback === 'function') {
          const id = window.requestIdleCallback(run, { timeout: 3000 });
          cancelDefer = () => window.cancelIdleCallback(id);
        } else {
          const id = window.setTimeout(run, 1200);
          cancelDefer = () => window.clearTimeout(id);
        }
      }
    })();
    return () => { cancelled = true; cancelDefer(); };
  }, [supported, loadList]);

  const connect = useCallback(async () => {
    if (!supported) return;
    try {
      const dir = await pickDirectory(); // 含使用者手勢，自動取得權限
      setHandle(dir);
      setPermission('granted');
      await saveDirHandle(dir);
      await loadList(dir);
    } catch (e) {
      if ((e as DOMException)?.name === 'AbortError') return; // 使用者取消，靜默
      setError(e instanceof Error ? e.message : '選擇資料夾失敗');
    }
  }, [supported, loadList]);

  const grant = useCallback(async () => {
    if (!handle) return;
    const perm = await ensureReadPermission(handle, true); // 須在使用者手勢內
    setPermission(perm as FolderPermission);
    if (perm === 'granted') await loadList(handle);
  }, [handle, loadList]);

  const refresh = useCallback(async () => {
    if (handle && permission === 'granted') await loadList(handle);
  }, [handle, permission, loadList]);

  const forget = useCallback(async () => {
    await clearDirHandle();
    setHandle(null);
    setPdfs([]);
    setPermission('prompt');
    setError(null);
  }, []);

  const openPdf = useCallback(async (fh: FileSystemFileHandle): Promise<File | null> => {
    try {
      return await readPdf(fh);
    } catch (e) {
      setError(e instanceof Error ? e.message : '讀取檔案失敗');
      return null;
    }
  }, []);

  return {
    supported,
    folderName: handle?.name ?? null,
    permission,
    pdfs,
    loading,
    error,
    connect,
    grant,
    refresh,
    forget,
    openPdf,
  };
}
