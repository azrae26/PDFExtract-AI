/**
 * 功能：最左側檔案列表面板（全域控制中心）
 * 職責：顯示已匯入的所有 PDF 檔案、狀態圖示、點擊切換目前檢視的檔案、刪除檔案、
 *       全域分析控制 toggle 按鈕（暫停分析 / 繼續分析 / 全部重新分析）
 * 依賴：types.ts (FileEntry)
 */

'use client';

import { useEffect, useRef } from 'react';
import { FileEntry } from '@/lib/types';

interface FileListPanelProps {
  files: FileEntry[];
  activeFileId: string | null;
  onSelectFile: (fileId: string) => void;
  onRemoveFile: (fileId: string) => void;
  onClearAll: () => void;
  /** 全域是否正在分析（來自 useAnalysis 的 isAnalyzing） */
  isAnalyzing: boolean;
  /** 全域分析 toggle：暫停 / 繼續 / 全部重新分析 */
  onToggleAnalysis: () => void;
  /** 券商 → 忽略末尾頁數映射 */
  brokerSkipMap: Record<string, number>;
  /** 全域忽略末尾頁數 */
  skipLastPages: number;
}

/** 計算單檔實際要分析的頁數（numPages - effectiveSkip） */
function getPagesToAnalyze(entry: FileEntry, brokerSkipMap: Record<string, number>, skipLastPages: number): number {
  const effectiveSkip = (entry.report && brokerSkipMap[entry.report] !== undefined)
    ? brokerSkipMap[entry.report]
    : skipLastPages;
  return Math.max(1, entry.numPages - effectiveSkip);
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
  isAnalyzing,
  onToggleAnalysis,
  brokerSkipMap,
  skipLastPages,
}: FileListPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);

  // 當 activeFileId 改變時：若項目在 80% 以下則移到 80%、在 15% 以上則移到 15%，其餘不滾動；使用平滑動畫
  useEffect(() => {
    const container = listRef.current;
    const item = activeItemRef.current;
    if (!container || !item) return;
    const containerHeight = container.clientHeight;
    const threshold10 = containerHeight * 0.15;
    const threshold90 = containerHeight * 0.8;
    const itemTopInView = item.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const itemTopInContent = container.scrollTop + itemTopInView;

    let targetScrollTop = container.scrollTop;
    if (itemTopInView > threshold90) {
      targetScrollTop = itemTopInContent - threshold90;
    } else if (itemTopInView < threshold10) {
      targetScrollTop = itemTopInContent - threshold10;
    }

    if (targetScrollTop !== container.scrollTop) {
      container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' });
    }
  }, [activeFileId]);

  // 判斷 toggle 按鈕的三態
  const hasUnfinished = files.some((f) => f.status === 'idle' || f.status === 'stopped');
  const allDone = files.length > 0 && files.every((f) => f.status === 'done');

  // 全域合計統計（僅頁面進度，不包含 region 識別任務；分母扣除忽略頁數）
  const totalCompleted = files.reduce((sum, f) => sum + (f.pageRegions?.size ?? 0), 0);
  const totalToAnalyze = files.reduce((sum, f) => sum + getPagesToAnalyze(f, brokerSkipMap, skipLastPages), 0);
  const totalPages = files.reduce((sum, f) => sum + f.numPages, 0);

  let toggleLabel: string;
  let toggleColor: string;
  if (isAnalyzing) {
    toggleLabel = '暫停分析';
    toggleColor = 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800';
  } else if (hasUnfinished) {
    toggleLabel = '繼續分析';
    toggleColor = 'border border-blue-500 text-blue-600 bg-white hover:bg-blue-50 active:bg-blue-100';
  } else {
    toggleLabel = '全部重新分析';
    toggleColor = 'border border-blue-500 text-blue-600 bg-white hover:bg-blue-50 active:bg-blue-100';
  }
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

      {/* 全域狀態欄 + 分析控制 toggle 按鈕 */}
      {files.length > 0 && (
        <div className="px-3 py-2 border-b border-gray-200 flex-shrink-0 space-y-2">
          {/* 全域合計統計 */}
          <div className="flex gap-1 text-center">
            <div className="rounded-md bg-green-50 py-1.5 px-2 flex-1">
              <div className="text-lg font-extrabold text-green-600">
                {totalCompleted}<span className="mx-0.5">/</span>{totalToAnalyze}
              </div>
              <div className="text-[9px] text-green-600">已完成</div>
            </div>
            <div className="rounded-md bg-blue-50 py-1.5 px-2 flex-1">
              <div className="text-lg font-extrabold text-blue-600">{totalPages}</div>
              <div className="text-[9px] text-blue-500">總頁數</div>
            </div>
          </div>
          {/* toggle 按鈕 */}
          <button
            onClick={onToggleAnalysis}
            className={`w-full py-1.5 px-3 text-[13px] font-medium rounded-lg transition-colors cursor-pointer ${toggleColor}`}
          >
            {toggleLabel}
          </button>
        </div>
      )}

      {/* 檔案列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {files.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-gray-400">
            拖入 PDF 檔案
          </div>
        ) : (
          <ul className="py-1">
            {files.map((entry, idx) => {
              const isActive = entry.id === activeFileId;
              return (
                <li key={entry.id} ref={isActive ? activeItemRef : undefined}>
                  <button
                    onClick={() => onSelectFile(entry.id)}
                    className={`group/item w-full text-left pl-2 pr-1.5 py-2 flex items-center gap-1 transition-colors cursor-pointer text-xs ${
                      isActive
                        ? 'bg-blue-100 border-l-[3px] border-blue-600 text-blue-800'
                        : 'hover:bg-gray-100 text-gray-700 border-l-[3px] border-transparent'
                    }`}
                    title={entry.name}
                  >
                    <StatusIcon status={entry.status} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium leading-tight line-clamp-2 break-all">{entry.name}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">
                        {entry.numPages > 0
                          ? `${entry.pageRegions?.size ?? 0}/${getPagesToAnalyze(entry, brokerSkipMap, skipLastPages)} 頁`
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
                      className="flex-shrink-0 w-4 h-4 -ml-0.5 flex items-center justify-center rounded hover:bg-red-100 text-gray-300 hover:text-red-500 transition-colors cursor-pointer opacity-0 group-hover/item:opacity-100"
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
