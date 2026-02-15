/**
 * 功能：最左側檔案列表面板
 * 職責：顯示已匯入的所有 PDF 檔案、狀態圖示、點擊切換目前檢視的檔案、刪除檔案
 * 依賴：types.ts (FileEntry)
 */

'use client';

import { FileEntry } from '@/lib/types';

interface FileListPanelProps {
  files: FileEntry[];
  activeFileId: string | null;
  onSelectFile: (fileId: string) => void;
  onRemoveFile: (fileId: string) => void;
  onClearAll: () => void;
}

/** 狀態圖示 */
function StatusIcon({ status }: { status: FileEntry['status'] }) {
  switch (status) {
    case 'queued':
      return (
        <span className="flex-shrink-0 w-4 h-4 rounded-full border-2 border-gray-300" title="等待中" />
      );
    case 'processing':
      return (
        <span className="flex-shrink-0 w-4 h-4" title="處理中">
          <span className="block w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </span>
      );
    case 'done':
      return (
        <span className="flex-shrink-0" title="完成">
          <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </span>
      );
    case 'stopped':
      return (
        <span className="flex-shrink-0" title="中斷">
          <svg className="w-4 h-4 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </span>
      );
    case 'idle':
      return (
        <span className="flex-shrink-0 w-4 h-4 rounded-full border-2 border-dashed border-gray-300" title="還沒跑" />
      );
    case 'error':
      return (
        <span className="flex-shrink-0" title="錯誤">
          <svg className="w-4 h-4 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
      );
  }
}

export default function FileListPanel({
  files,
  activeFileId,
  onSelectFile,
  onRemoveFile,
  onClearAll,
}: FileListPanelProps) {
  return (
    <div className="h-full flex flex-col bg-gray-50 border-r border-gray-200 overflow-hidden">
      {/* 標題 + 清空按鈕 */}
      <div className="px-4 h-11 border-b border-gray-200 bg-gray-50 flex items-center justify-between flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-500">
          檔案列表
          {files.length > 0 && (
            <span className="ml-1.5 text-gray-400 font-normal">({files.length})</span>
          )}
        </h2>
        {files.length > 0 && (
          <button
            onClick={onClearAll}
            className="px-1.5 py-0.5 text-[13px] rounded text-red-400 hover:text-white hover:bg-red-500 transition-colors cursor-pointer"
            title="清空所有檔案"
          >
            清空
          </button>
        )}
      </div>

      {/* 檔案列表 */}
      <div className="flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-gray-400">
            拖入 PDF 檔案
          </div>
        ) : (
          <ul className="py-1">
            {files.map((entry, idx) => {
              const isActive = entry.id === activeFileId;
              return (
                <li key={entry.id}>
                  <button
                    onClick={() => onSelectFile(entry.id)}
                    className={`group/item w-full text-left px-3 py-2 flex items-center gap-2 transition-colors cursor-pointer text-xs ${
                      isActive
                        ? 'bg-blue-50 border-l-2 border-blue-500 text-blue-700'
                        : 'hover:bg-gray-100 text-gray-700 border-l-2 border-transparent'
                    }`}
                    title={entry.name}
                  >
                    <StatusIcon status={entry.status} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium leading-tight line-clamp-2 break-all">{entry.name}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {entry.numPages > 0
                          ? `${entry.completedPages}/${entry.analysisPages}/${entry.numPages} 頁`
                          : entry.status === 'processing' ? '分析中...'
                          : entry.status === 'queued' ? '等待中'
                          : entry.status === 'stopped' ? '已中斷'
                          : entry.status === 'idle' ? '還沒跑'
                          : entry.status === 'error' ? '失敗'
                          : ''
                        }
                      </p>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveFile(entry.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.stopPropagation();
                          onRemoveFile(entry.id);
                        }
                      }}
                      className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-red-100 text-gray-300 hover:text-red-500 transition-colors cursor-pointer opacity-0 group-hover/item:opacity-100"
                      title="移除檔案"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
