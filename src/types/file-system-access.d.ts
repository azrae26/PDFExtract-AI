/**
 * File System Access API 型別補充
 * lib.dom 已提供 showDirectoryPicker / FileSystemDirectoryHandle / FileSystemFileHandle，
 * 但「持久權限」方法 queryPermission / requestPermission 屬 WICG 擴充、未進標準 lib，需手動補。
 * 設為 optional：方便 feature detection，且不與 lib.dom 既有宣告衝突（介面合併）。
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

// 本專案 TS lib 版本未含以下宣告，補上（皆屬標準 File System Access API）。
interface FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>;
}

interface Window {
  showDirectoryPicker(options?: {
    mode?: 'read' | 'readwrite';
    id?: string;
    startIn?: FileSystemHandle | string;
  }): Promise<FileSystemDirectoryHandle>;
}
