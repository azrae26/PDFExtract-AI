/**
 * 功能：右側文字面板
 * 職責：顯示所有頁面的分析文字，按頁碼+順序排列，支援 hover 高亮互動、複製全文、
 *       刪除單一區域（同步刪除中間欄框）、拖曳調整同頁區域順序、
 *       Markdown 表格自動渲染（可切換回原始 MD）、per-region 字型大小調整、
 *       點擊文字區進入編輯模式（純文字/Raw MD 用 textarea；高度以 useLayoutEffect 對齊內容，避免較 <p> 突增）
 * 依賴：types.ts、constants.ts
 */

'use client';

import React, { useRef, useEffect, useLayoutEffect, useCallback, useState } from 'react';
import { Region } from '@/lib/types';
import { getBoxColor, EMPTY_BOX_COLOR } from '@/lib/constants';

// ── Markdown 表格解析 ──────────────────────────────────────────────────────

type TextSegment = { type: 'text'; content: string };
type TableSegment = { type: 'table'; headers: string[]; rows: string[][] };
type Segment = TextSegment | TableSegment;

const SEPARATOR_RE = /^\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?$/;

function hasMarkdownTable(text: string): boolean {
  const lines = text.split('\n');
  const hasPipe = lines.some((l) => l.includes('|'));
  const hasSep = lines.some((l) => SEPARATOR_RE.test(l.trim()));
  return hasPipe && hasSep;
}

function parseCells(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function parseTextSegments(text: string): Segment[] {
  const lines = text.split('\n');
  const segments: Segment[] = [];
  let i = 0;

  while (i < lines.length) {
    // 嘗試找表格起點：含 | 且下一行是分隔行
    if (
      lines[i].includes('|') &&
      i + 1 < lines.length &&
      SEPARATOR_RE.test(lines[i + 1].trim())
    ) {
      const headers = parseCells(lines[i]);
      i += 2; // 跳過 header 行 + 分隔行
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) {
        rows.push(parseCells(lines[i]));
        i++;
      }
      segments.push({ type: 'table', headers, rows });
    } else {
      // 收集連續的非表格行
      const textLines: string[] = [];
      while (
        i < lines.length &&
        !(
          lines[i].includes('|') &&
          i + 1 < lines.length &&
          SEPARATOR_RE.test(lines[i + 1].trim())
        )
      ) {
        textLines.push(lines[i]);
        i++;
      }
      const content = textLines.join('\n').trim();
      if (content) segments.push({ type: 'text', content });
    }
  }

  return segments;
}

const DEFAULT_FONT_SIZE = 13;
const DEFAULT_TABLE_FONT_SIZE = 11;

function segmentsToMarkdown(segments: Segment[]): string {
  return segments.map((seg) => {
    if (seg.type === 'text') return seg.content;
    const header = '| ' + seg.headers.join(' | ') + ' |';
    const sep    = '| ' + seg.headers.map(() => '---').join(' | ') + ' |';
    const rows   = seg.rows.map((r) => '| ' + r.join(' | ') + ' |');
    return [header, sep, ...rows].join('\n');
  }).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────

interface TextPanelProps {
  pageRegions: Map<number, Region[]>;
  hoveredRegionId: string | null;
  onHover: (regionId: string | null) => void;
  currentPage: number;
  onPageChange: (page: number) => void;
  /** 點擊文字框時觸發，帶 regionKey 讓 PdfViewer 滾動到對應位置 */
  onClickRegion: (regionKey: string) => void;
  /** 刪除 region（同步刪中間欄的框） */
  onRegionRemove: (page: number, regionId: number) => void;
  /** 重新排序某頁的 regions */
  onReorderRegions: (page: number, reorderedRegions: Region[]) => void;
  /** 使用者手動編輯 region 文字後寫回 */
  onRegionTextChange: (page: number, regionId: number, newText: string) => void;
  /** 從 PdfViewer 點擊 BoundingBox 時滾動到對應文字框（regionKey 格式 "page-regionId"） */
  scrollToRegionKey?: string | null;
  /** 匯出當前報告到 API */
  onExportReport?: () => void;
  /** 匯出狀態 */
  exportState?: 'idle' | 'loading' | 'success' | 'error';
  /** 匯出錯誤訊息 */
  exportError?: string;
}

export default function TextPanel({
  pageRegions,
  hoveredRegionId,
  onHover,
  currentPage,
  onPageChange,
  onClickRegion,
  onRegionRemove,
  onReorderRegions,
  onRegionTextChange,
  scrollToRegionKey,
  onExportReport,
  exportState = 'idle',
  exportError = '',
}: TextPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const regionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // === 複製成功提示 ===
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  // === Markdown 表格切換（per-region：在 set 中 = 顯示原始 MD）===
  const [rawMarkdownRegions, setRawMarkdownRegions] = useState<Set<string>>(new Set());

  // === per-region 字型大小（未設定時 fallback DEFAULT_FONT_SIZE）===
  const [fontSizes, setFontSizes] = useState<Map<string, number>>(new Map());

  // === 文字編輯狀態 ===
  const [editingRegionKey, setEditingRegionKey] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editingTableData, setEditingTableData] = useState<{
    regionKey: string;
    segments: Segment[];
  } | null>(null);

  // === 表格 contentEditable 編輯：cell DOM refs + Escape guard + 自動 focus ===
  const editCellRefs = useRef<Map<string, HTMLElement>>(new Map());
  const tableEscapeRef = useRef(false);
  const pendingFocusCellRef = useRef<string | null>(null);

  // === 雙擊右鍵刪除 ===
  const lastRightClickRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });

  // === 單擊/雙擊消歧義：延遲進入編輯模式，讓雙擊可以複製而非進入編輯 ===
  const textClickTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const textEditTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 純文字編輯：textarea 預設 min-height / scrollHeight 常高於對應 <p>，同步為內容高度避免卡片跳高
  useLayoutEffect(() => {
    const el = textEditTextareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [editingRegionKey, editText]);

  // === 拖曳排序狀態 ===

  const [dragState, setDragState] = useState<{
    page: number;
    dragIndex: number;
    overIndex: number;
  } | null>(null);

  // === 自動滾動：PdfViewer 點擊/hover BoundingBox → 右欄滾動到對應文字框 ===
  // useEffect 監聯 scrollToRegionKey / hoveredRegionId → lerp 動畫滾到 15~85% 區間（但不讓另一端超出畫面）
  // skipScrollRef 標記滑鼠在 TextPanel 上（onMouseEnter 設 true、onMouseLeave 設 false），避免 hover 迴圈
  const scrollTargetRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number>(0);
  const skipScrollRef = useRef(false);

  // 共用：啟動 lerp 滾動動畫到指定 scrollTop
  const animateScrollTo = useCallback((target: number) => {
    scrollTargetRef.current = target;
    // 若動畫已在跑，不重複啟動（loop 會自動讀取最新 target）
    if (scrollRafRef.current) return;

    const LERP_FACTOR = 0.07;
    const THRESHOLD = 0.5;

    const animate = () => {
      const t = scrollTargetRef.current;
      if (t === null || !scrollContainerRef.current) {
        scrollRafRef.current = 0;
        return;
      }
      const current = scrollContainerRef.current.scrollTop;
      const diff = t - current;

      if (Math.abs(diff) < THRESHOLD) {
        scrollContainerRef.current.scrollTop = t;
        scrollRafRef.current = 0;
        scrollTargetRef.current = null;
        return;
      }

      scrollContainerRef.current.scrollTop = current + diff * LERP_FACTOR;
      // 邊界檢測：scrollTop 被瀏覽器 clamp 後沒變化 = 已到邊界，終止動畫
      if (scrollContainerRef.current.scrollTop === current) {
        scrollRafRef.current = 0;
        scrollTargetRef.current = null;
        return;
      }
      scrollRafRef.current = requestAnimationFrame(animate);
    };

    scrollRafRef.current = requestAnimationFrame(animate);
  }, []);

  // 用戶手動滾輪時取消正在進行的動畫，避免動畫覆蓋用戶操作
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const handleWheel = () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = 0;
        scrollTargetRef.current = null;
      }
    };
    container.addEventListener('wheel', handleWheel, { passive: true });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // 共用：計算並啟動滾動到指定 regionKey（拉到 15~85% 區間，但不讓元素另一端超出畫面）
  const scrollToRegion = useCallback((regionKey: string) => {
    const el = regionRefs.current.get(regionKey);
    const container = scrollContainerRef.current;
    if (!el || !container) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const containerHeight = containerRect.height;
    const elTopInContainer = elRect.top - containerRect.top;
    const elBottomInContainer = elRect.bottom - containerRect.top;

    const zone15 = containerHeight * 0.15;
    const zone85 = containerHeight * 0.85;

    let scrollDelta = 0;
    if (elBottomInContainer > zone85) {
      // 文字框在下方 → 底部拉到 85%
      scrollDelta = elBottomInContainer - zone85;
      // 但如果頂部會超過畫面上方，最多只能頂到上方邊界
      const newTop = elTopInContainer - scrollDelta;
      if (newTop < 0) {
        scrollDelta = Math.max(0, elTopInContainer);
      }
    } else if (elTopInContainer < zone15) {
      // 文字框在上方 → 頂部拉到 15%
      scrollDelta = elTopInContainer - zone15;
      // 但如果底部會超過畫面下方，最多只能頂到下方邊界
      const newBottom = elBottomInContainer - scrollDelta;
      if (newBottom > containerHeight) {
        scrollDelta = Math.min(0, elBottomInContainer - containerHeight);
      }
    } else {
      return; // 已在 15~85% 區間內
    }

    if (Math.abs(scrollDelta) > 0.5) {
      animateScrollTo(container.scrollTop + scrollDelta);
    }
  }, [animateScrollTo]);

  // 路徑 1：PdfViewer 點擊 BoundingBox → 右欄滾到對應文字框
  useEffect(() => {
    if (!scrollToRegionKey) {
      scrollTargetRef.current = null;
      return;
    }
    scrollToRegion(scrollToRegionKey);

    return () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = 0;
      }
    };
  }, [scrollToRegionKey, scrollToRegion]);

  // 路徑 2（已移除）：Hover PdfViewer BoundingBox 不再自動滾動右欄，僅點擊才觸發滾動


  // 複製全部文字到剪貼簿
  const handleCopyAll = useCallback(() => {
    const lines: string[] = [];
    const sortedPages = Array.from(pageRegions.entries()).sort(([a], [b]) => a - b);

    for (const [, regions] of sortedPages) {
      for (const region of regions) {
        if (region.text) {
          lines.push(region.text);
          lines.push('');
        }
      }
    }

    const fullText = lines.join('\n').trim();
    navigator.clipboard.writeText(fullText).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 1500);
    });
  }, [pageRegions]);

  // === 文字編輯 handlers ===

  const enterTextEdit = useCallback((regionKey: string, text: string) => {
    onClickRegion(regionKey);
    setEditingRegionKey(regionKey);
    setEditText(text);
    setEditingTableData(null);
  }, [onClickRegion]);

  const enterTableEditMode = useCallback((regionKey: string, segments: Segment[], focusCellKey?: string) => {
    onClickRegion(regionKey);
    editCellRefs.current.clear();
    tableEscapeRef.current = false;
    pendingFocusCellRef.current = focusCellKey ?? null;
    const copy: Segment[] = segments.map((seg) =>
      seg.type === 'text'
        ? { type: 'text' as const, content: seg.content }
        : { type: 'table' as const, headers: [...seg.headers], rows: seg.rows.map((r) => [...r]) }
    );
    setEditingTableData({ regionKey, segments: copy });
    setEditingRegionKey(regionKey);
    setEditText('');
  }, [onClickRegion]);

  // re-render 後自動 focus 使用者點擊的那個 cell
  useEffect(() => {
    if (!editingTableData || !pendingFocusCellRef.current) return;
    const key = pendingFocusCellRef.current;
    pendingFocusCellRef.current = null;
    const el = editCellRefs.current.get(key);
    if (!el) return;
    el.focus();
    // 游標移到內容末尾
    const range = document.createRange();
    const sel = window.getSelection();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editingTableData]);

  const saveTextEdit = useCallback((page: number, regionId: number) => {
    onRegionTextChange(page, regionId, editText);
    setEditingRegionKey(null);
    setEditText('');
  }, [editText, onRegionTextChange]);

  // 從 DOM refs 讀取所有 cell 最新值，重建 markdown 後存檔
  const saveTableEditFromRefs = useCallback((page: number, regionId: number, initialSegments: Segment[]) => {
    const newSegments = initialSegments.map((seg, si) => {
      if (seg.type === 'text') {
        const el = editCellRefs.current.get(`${si}-text`);
        return { type: 'text' as const, content: el?.textContent ?? seg.content };
      }
      const newHeaders = seg.headers.map((h, hi) => {
        const el = editCellRefs.current.get(`${si}-h-${hi}`);
        return el?.textContent ?? h;
      });
      const newRows = seg.rows.map((row, ri) =>
        row.map((cell, ci) => {
          const el = editCellRefs.current.get(`${si}-r-${ri}-${ci}`);
          return el?.textContent ?? cell;
        })
      );
      return { type: 'table' as const, headers: newHeaders, rows: newRows };
    });
    onRegionTextChange(page, regionId, segmentsToMarkdown(newSegments));
    editCellRefs.current.clear();
    setEditingTableData(null);
    setEditingRegionKey(null);
  }, [onRegionTextChange]);

  // === 拖曳排序 handlers ===
  const handleDragStart = useCallback((page: number, index: number) => {
    setDragState({ page, dragIndex: index, overIndex: index });
  }, []);

  const handleDragOver = useCallback((page: number, index: number, e: React.DragEvent) => {
    e.preventDefault();
    if (dragState && dragState.page === page) {
      setDragState((prev) => prev ? { ...prev, overIndex: index } : null);
    }
  }, [dragState]);

  const handleDragEnd = useCallback((page: number, regions: Region[]) => {
    if (!dragState || dragState.page !== page) {
      setDragState(null);
      return;
    }
    const { dragIndex, overIndex } = dragState;
    if (dragIndex !== overIndex) {
      const reordered = [...regions];
      const [moved] = reordered.splice(dragIndex, 1);
      reordered.splice(overIndex, 0, moved);
      onReorderRegions(page, reordered);
    }
    setDragState(null);
  }, [dragState, onReorderRegions]);

  const sortedPages = Array.from(pageRegions.entries()).sort(([a], [b]) => a - b);
  const hasContent = sortedPages.some(([, regions]) => regions.length > 0);

  // 全域 region index（跨頁累計，用來配色）
  let globalIndex = 0;

  return (
    <div className="relative w-full h-full flex flex-col border-l border-gray-200 bg-white">
      {/* 標題列 */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-700">提取文字</h2>
        {hasContent && (
          <div className="flex items-center gap-1.5">
            {/* 匯出單篇按鈕（複製全部的左邊） */}
            {onExportReport && (
              <button
                onClick={onExportReport}
                disabled={exportState === 'loading'}
                title={exportState === 'error' ? exportError : '匯出此報告到研究報告 API'}
                className={`flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md shadow-sm hover:shadow transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-70 ${
                  exportState === 'success'
                    ? 'bg-green-500 text-white'
                    : exportState === 'error'
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : exportState === 'loading'
                    ? 'bg-gray-400 text-white'
                    : 'bg-indigo-500 text-white hover:bg-indigo-600 active:bg-indigo-700'
                }`}
              >
                {exportState === 'success' && (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    已匯出
                  </>
                )}
                {exportState === 'error' && <>✗ 失敗</>}
                {exportState === 'loading' && <>匯出中...</>}
                {exportState === 'idle' && (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    匯出
                  </>
                )}
              </button>
            )}

            {/* 複製全部按鈕 */}
            <button
              id="copy-all-btn"
              onClick={handleCopyAll}
              className={`flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md shadow-sm hover:shadow transition-all cursor-pointer ${
                copiedAll
                  ? 'bg-green-500 text-white'
                  : 'bg-indigo-500 text-white hover:bg-indigo-600 active:bg-indigo-700'
              }`}
            >
              {copiedAll ? (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                  已複製!
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                  </svg>
                  複製全部
                </>
              )}
            </button>
          </div>
        )}
      </div>

      {/* 文字內容區 */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {!hasContent ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
            <svg className="w-12 h-12 mb-3 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p>尚無提取結果</p>
            <p className="text-xs text-gray-300 mt-1">上傳 PDF 後自動分析</p>
          </div>
        ) : (
          sortedPages.map(([page, regions]) => {
            if (regions.length === 0) return null;

            return (
              <div key={page} className="space-y-2">
                {/* 頁碼標題 */}
                <button
                  onClick={() => onPageChange(page)}
                  className={`text-xs font-medium px-2 py-1 rounded cursor-pointer transition-colors ${
                    currentPage === page
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  第 {page} 頁
                </button>

                {/* 該頁的各個區域（支援拖曳排序） */}
                {regions.map((region, index) => {
                  const regionKey = `${page}-${region.id}`;
                  const isEmpty = !region.text?.trim();
                  const color = isEmpty ? EMPTY_BOX_COLOR : getBoxColor(globalIndex);
                  const isHovered = hoveredRegionId === regionKey;
                  const isDragging = dragState?.page === page && dragState.dragIndex === index;
                  const isDropTarget = dragState?.page === page && dragState.overIndex === index && dragState.dragIndex !== index;
                  globalIndex++;

                  return (
                    <div
                      key={regionKey}
                      ref={(el) => {
                        if (el) regionRefs.current.set(regionKey, el);
                        else regionRefs.current.delete(regionKey);
                      }}
                      draggable={editingRegionKey !== regionKey}
                      onDragStart={() => handleDragStart(page, index)}
                      onDragOver={(e) => handleDragOver(page, index, e)}
                      onDragEnd={() => handleDragEnd(page, regions)}
                      className={`relative rounded-lg p-3 transition-all duration-150 cursor-pointer border group animate-region-in ${
                        isHovered ? 'shadow-md' : 'shadow-sm'
                      } ${isDragging ? 'opacity-40' : ''} ${isDropTarget ? 'ring-2 ring-blue-400' : ''}`}
                      style={{
                        backgroundColor: isHovered ? color.hoverBg : color.textBg,
                        borderColor: isHovered ? color.border : 'transparent',
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const now = Date.now();
                        const last = lastRightClickRef.current;
                        if (last.key === regionKey && now - last.time < 400) {
                          onRegionRemove(page, region.id);
                          lastRightClickRef.current = { key: '', time: 0 };
                        } else {
                          lastRightClickRef.current = { key: regionKey, time: now };
                        }
                      }}
                      onClick={() => onClickRegion(regionKey)}
                      onDoubleClick={() => {
                        if (editingRegionKey === regionKey) return;
                        // 取消文字區域的單擊計時器（若有的話）
                        const timer = textClickTimerRef.current.get(regionKey);
                        if (timer) { clearTimeout(timer); textClickTimerRef.current.delete(regionKey); }
                        if (region.text) {
                          navigator.clipboard.writeText(region.text);
                          setCopiedKey(regionKey);
                          setTimeout(() => setCopiedKey(null), 1200);
                        }
                      }}
                      onMouseEnter={() => { skipScrollRef.current = true; onHover(regionKey); }}
                      onMouseLeave={() => { skipScrollRef.current = false; onHover(null); }}
                    >
                      {/* X 刪除按鈕 — 右上角 */}
                      <button
                        className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold opacity-0 group-hover:opacity-80 hover:!opacity-100 transition-opacity cursor-pointer z-10"
                        style={{ backgroundColor: color.border }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRegionRemove(page, region.id);
                        }}
                        title="移除此區域"
                      >
                        ✕
                      </button>

                      {/* 拖曳手柄 — 左側 */}
                      <div className="absolute left-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-40 transition-opacity cursor-grab text-gray-400 text-[10px] leading-none select-none">
                        ⠿
                      </div>

                      {/* 區域標籤列（含字型大小 +/- 及表格切換按鈕） */}
                      {(() => {
                        const hasTable = !isEmpty && !!region.text && hasMarkdownTable(region.text);
                        const isRawMd = rawMarkdownRegions.has(regionKey);
                        const curFontSize = fontSizes.get(regionKey) ?? (hasTable && !isRawMd ? DEFAULT_TABLE_FONT_SIZE : DEFAULT_FONT_SIZE);

                        const adjustFont = (delta: number, e: React.MouseEvent) => {
                          e.stopPropagation();
                          setFontSizes((prev) => {
                            const next = new Map(prev);
                            next.set(regionKey, Math.min(24, Math.max(8, curFontSize + delta)));
                            return next;
                          });
                        };

                        const toggleMd = (e: React.MouseEvent) => {
                          e.stopPropagation();
                          setRawMarkdownRegions((prev) => {
                            const next = new Set(prev);
                            if (next.has(regionKey)) next.delete(regionKey);
                            else next.add(regionKey);
                            return next;
                          });
                        };

                        return (
                          <div className="flex items-center gap-1.5 mb-1.5 min-h-[18px]">
                            {/* 標籤圓點 + 文字 */}
                            {region.label && (
                              <>
                                <span
                                  className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                  style={{ backgroundColor: color.border }}
                                />
                                <span className="text-xs font-medium text-gray-600 truncate flex-1">
                                  {region.label}
                                </span>
                              </>
                            )}
                            {!region.label && <span className="flex-1" />}

                            {/* 字型大小 − size + */}
                            <div
                              className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                              onDoubleClick={(e) => e.stopPropagation()}
                            >
                              <button
                                className="w-4 h-4 rounded flex items-center justify-center text-gray-400 hover:bg-gray-200 text-[11px] leading-none cursor-pointer"
                                onClick={(e) => adjustFont(-0.5, e)}
                                title="縮小文字"
                              >−</button>
                              <span className="text-[11px] text-gray-400 w-9 text-center select-none">
                                {curFontSize % 1 === 0 ? curFontSize : curFontSize.toFixed(1)}px
                              </span>
                              <button
                                className="w-4 h-4 rounded flex items-center justify-center text-gray-400 hover:bg-gray-200 text-[11px] leading-none cursor-pointer"
                                onClick={(e) => adjustFont(0.5, e)}
                                title="放大文字"
                              >+</button>
                            </div>

                            {/* MD ↔ 表格切換按鈕（僅有表格時顯示） */}
                            {hasTable && (
                              <button
                                className="flex-shrink-0 text-[11px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-100 leading-none cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={toggleMd}
                                onDoubleClick={(e) => e.stopPropagation()}
                                title={isRawMd ? '切換到表格視圖' : '切換到原始 Markdown'}
                              >
                                {isRawMd ? '表格' : 'MD'}
                              </button>
                            )}
                          </div>
                        );
                      })()}

                      {/* 文字內容 */}
                      {(() => {
                        const userSize = fontSizes.get(regionKey);
                        const curFontSize = userSize ?? DEFAULT_FONT_SIZE;
                        const curTableFontSize = userSize ?? DEFAULT_TABLE_FONT_SIZE;
                        const hasTable = !isEmpty && !!region.text && hasMarkdownTable(region.text);
                        const isRawMd = rawMarkdownRegions.has(regionKey);
                        const isEditing = editingRegionKey === regionKey;

                        if (isEmpty && !isEditing) {
                          return (
                            <p
                              className="text-gray-400 leading-relaxed italic cursor-text"
                              style={{ fontSize: curFontSize }}
                              onClick={(e) => { e.stopPropagation(); enterTextEdit(regionKey, ''); }}
                            >
                              （無文字）
                            </p>
                          );
                        }
                        if (region.text?.startsWith('⏳')) {
                          return (
                            <p className="text-blue-600 leading-relaxed flex items-center gap-1.5" style={{ fontSize: curFontSize }}>
                              <span className="inline-block animate-hourglass" style={{ fontSize: curFontSize }}>⏳</span>
                              {region.text.slice(1).trim()}
                            </p>
                          );
                        }

                        // 表格視圖模式
                        if (hasTable && !isRawMd) {
                          // 表格編輯中 — contentEditable 直接放在 <th>/<td>，保留原本 layout
                          if (isEditing && editingTableData?.regionKey === regionKey) {
                            const initSegs = editingTableData.segments;
                            const escapeEdit = () => {
                              tableEscapeRef.current = true;
                              editCellRefs.current.clear();
                              setEditingTableData(null);
                              setEditingRegionKey(null);
                            };
                            const cellKeyDown = (e: React.KeyboardEvent) => {
                              if (e.key === 'Escape') { e.preventDefault(); escapeEdit(); }
                              e.stopPropagation();
                            };
                            return (
                              <div
                                onBlur={(e) => {
                                  if (tableEscapeRef.current) { tableEscapeRef.current = false; return; }
                                  if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                                    saveTableEditFromRefs(page, region.id, initSegs);
                                  }
                                }}
                                className="space-y-2 rounded-md bg-white"
                                style={{ boxShadow: '0 0 0 1px #60a5fa, 0 0 0 2.5px #bfdbfe' }}
                              >
                                {initSegs.map((seg, si) => {
                                  if (seg.type === 'text') {
                                    return (
                                      <div
                                        key={si}
                                        ref={(el) => {
                                          if (el && !editCellRefs.current.has(`${si}-text`)) {
                                            el.textContent = seg.content;
                                            editCellRefs.current.set(`${si}-text`, el);
                                          }
                                        }}
                                        contentEditable
                                        suppressContentEditableWarning
                                        className="w-full text-gray-800 leading-relaxed focus:outline-none whitespace-pre-wrap"
                                        style={{ fontSize: curFontSize }}
                                        onClick={(e) => e.stopPropagation()}
                                        onKeyDown={cellKeyDown}
                                      />
                                    );
                                  }
                                  // type === 'table' — contentEditable cells，與正常視圖同樣 layout
                                  return (
                                    <div key={si} className={`bg-white rounded border border-blue-200 ${seg.headers.length > 7 ? 'overflow-x-auto' : 'overflow-x-auto [&::-webkit-scrollbar]:hidden'}`} style={seg.headers.length > 7 ? undefined : { scrollbarWidth: 'none' }}>
                                      <table className="border-collapse w-full" style={{ fontSize: curTableFontSize }}>
                                        {seg.headers.length > 0 && (
                                          <thead>
                                            <tr className="bg-blue-50/60">
                                              {seg.headers.map((h, hi) => (
                                                <th
                                                  key={hi}
                                                  ref={(el) => {
                                                    if (el && !editCellRefs.current.has(`${si}-h-${hi}`)) {
                                                      el.textContent = h;
                                                      editCellRefs.current.set(`${si}-h-${hi}`, el);
                                                    }
                                                  }}
                                                  contentEditable
                                                  suppressContentEditableWarning
                                                  className="border-b border-r border-blue-200 px-2 py-1 text-left font-medium text-gray-600 whitespace-nowrap bg-blue-50/60 focus:outline-none focus:bg-white focus:ring-1 focus:ring-inset focus:ring-blue-300 min-w-[40px]"
                                                  onClick={(e) => e.stopPropagation()}
                                                  onKeyDown={cellKeyDown}
                                                />
                                              ))}
                                            </tr>
                                          </thead>
                                        )}
                                        <tbody>
                                          {seg.rows.map((row, ri) => (
                                            <tr key={ri} className={ri % 2 === 1 ? 'bg-gray-100/70' : 'bg-white'}>
                                              {row.map((cell, ci) => (
                                                <td
                                                  key={ci}
                                                  ref={(el) => {
                                                    if (el && !editCellRefs.current.has(`${si}-r-${ri}-${ci}`)) {
                                                      el.textContent = cell;
                                                      editCellRefs.current.set(`${si}-r-${ri}-${ci}`, el);
                                                    }
                                                  }}
                                                  contentEditable
                                                  suppressContentEditableWarning
                                                  className="border-b border-r border-blue-200 px-2 py-1 text-gray-800 align-top focus:outline-none focus:bg-blue-50/40 focus:ring-1 focus:ring-inset focus:ring-blue-300 min-w-[40px]"
                                                  onClick={(e) => e.stopPropagation()}
                                                  onKeyDown={cellKeyDown}
                                                />
                                              ))}
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          }

                          // 表格正常渲染 — 點擊進入編輯
                          const segments = parseTextSegments(region.text ?? '');
                          return (
                            <div className="space-y-2">
                              {segments.map((seg, si) => {
                                if (seg.type === 'text') {
                                  return (
                                    <p
                                      key={si}
                                      className="text-gray-800 leading-relaxed break-words cursor-text"
                                      style={{ fontSize: curFontSize }}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (e.detail >= 2) return;
                                        const cellKey = `${regionKey}-${si}-text`;
                                        const existing = textClickTimerRef.current.get(cellKey);
                                        if (existing) clearTimeout(existing);
                                        const timer = setTimeout(() => {
                                          textClickTimerRef.current.delete(cellKey);
                                          enterTableEditMode(regionKey, segments, `${si}-text`);
                                        }, 200);
                                        textClickTimerRef.current.set(cellKey, timer);
                                      }}
                                    >
                                      {seg.content.split('\n').map((line, li, arr) => (
                                        <React.Fragment key={li}>
                                          {line}
                                          {li < arr.length - 1 && <br />}
                                        </React.Fragment>
                                      ))}
                                    </p>
                                  );
                                }
                                // type === 'table'
                                return (
                                  <div key={si} className={`bg-white rounded border border-gray-200 ${seg.headers.length > 7 ? 'overflow-x-auto' : 'overflow-x-auto [&::-webkit-scrollbar]:hidden'}`} style={seg.headers.length > 7 ? undefined : { scrollbarWidth: 'none' }}>
                                    <table className="border-collapse w-full" style={{ fontSize: curTableFontSize }}>
                                      {seg.headers.length > 0 && (
                                        <thead>
                                          <tr className="bg-gray-100">
                                            {seg.headers.map((h, hi) => (
                                              <th
                                                key={hi}
                                                className="border-b border-r border-gray-200 px-2 py-1 text-left font-medium text-gray-600 whitespace-nowrap bg-gray-50 cursor-text min-w-[40px]"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  if (e.detail >= 2) return;
                                                  const cellKey = `${regionKey}-${si}-h-${hi}`;
                                                  const existing = textClickTimerRef.current.get(cellKey);
                                                  if (existing) clearTimeout(existing);
                                                  const timer = setTimeout(() => {
                                                    textClickTimerRef.current.delete(cellKey);
                                                    enterTableEditMode(regionKey, segments, `${si}-h-${hi}`);
                                                  }, 200);
                                                  textClickTimerRef.current.set(cellKey, timer);
                                                }}
                                              >
                                                {h}
                                              </th>
                                            ))}
                                          </tr>
                                        </thead>
                                      )}
                                      <tbody>
                                        {seg.rows.map((row, ri) => (
                                          <tr key={ri} className={ri % 2 === 1 ? 'bg-gray-100/70' : 'bg-white'}>
                                            {row.map((cell, ci) => (
                                              <td
                                                key={ci}
                                                className="border-b border-r border-gray-200 px-2 py-1 text-gray-800 align-top cursor-text min-w-[40px]"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (e.detail >= 2) return;
                                  // 立即觸發 PDF 滾動，不等雙擊確認
                                  onClickRegion(regionKey);
                                  const cellKey = `${regionKey}-${si}-r-${ri}-${ci}`;
                                  const existing = textClickTimerRef.current.get(cellKey);
                                  if (existing) clearTimeout(existing);
                                  const timer = setTimeout(() => {
                                    textClickTimerRef.current.delete(cellKey);
                                    enterTableEditMode(regionKey, segments, `${si}-r-${ri}-${ci}`);
                                  }, 200);
                                  textClickTimerRef.current.set(cellKey, timer);
                                }}
                                              >
                                                {cell}
                                              </td>
                                            ))}
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        }

                        // 純文字或原始 MD 模式 — 編輯中（不另包一層 div，避免額外盒模型；rows=1 + line-height 對齊 leading-relaxed）
                        if (isEditing) {
                          return (
                            <textarea
                              ref={textEditTextareaRef}
                              rows={1}
                              autoFocus
                              className="w-full min-h-0 resize-none border-0 bg-white rounded-sm p-0 m-0 text-gray-800 leading-relaxed break-words focus:outline-none box-border block overflow-hidden"
                              style={{
                                fontSize: curFontSize,
                                lineHeight: 1.625,
                                boxShadow: '0 0 0 1px #93c5fd, 0 0 0 2.5px #bfdbfe',
                              }}
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onBlur={() => saveTextEdit(page, region.id)}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') { e.preventDefault(); setEditingRegionKey(null); setEditText(''); }
                                e.stopPropagation();
                              }}
                            />
                          );
                        }

                        // 純文字或原始 MD 模式 — 正常顯示
                        return (
                          <p
                            className="text-gray-800 leading-relaxed break-words cursor-text"
                            style={{ fontSize: curFontSize }}
                            onClick={(e) => {
                              e.stopPropagation();
                              // 雙擊的第二下 click（e.detail >= 2）由 onDoubleClick 處理，這裡略過
                              if (e.detail >= 2) return;
                              // 立即觸發 PDF 滾動，不等雙擊確認
                              onClickRegion(regionKey);
                              // 延遲進入編輯，讓雙擊有機會取消
                              const existing = textClickTimerRef.current.get(regionKey);
                              if (existing) clearTimeout(existing);
                              const timer = setTimeout(() => {
                                textClickTimerRef.current.delete(regionKey);
                                enterTextEdit(regionKey, region.text ?? '');
                              }, 200);
                              textClickTimerRef.current.set(regionKey, timer);
                            }}
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              // 取消待執行的單擊計時器，改為複製
                              const timer = textClickTimerRef.current.get(regionKey);
                              if (timer) { clearTimeout(timer); textClickTimerRef.current.delete(regionKey); }
                              if (region.text) {
                                navigator.clipboard.writeText(region.text);
                                setCopiedKey(regionKey);
                                setTimeout(() => setCopiedKey(null), 1200);
                              }
                            }}
                          >
                            {region.text?.split('\n').map((line, i, arr) => (
                              <React.Fragment key={i}>
                                {line}
                                {i < arr.length - 1 && <br />}
                              </React.Fragment>
                            ))}
                          </p>
                        );
                      })()}

                      {/* 複製成功提示（淡入淡出） */}
                      <div
                        className={`absolute inset-0 flex items-center justify-center bg-green-100/70 rounded-lg pointer-events-none transition-opacity duration-300 ${
                          copiedKey === regionKey ? 'opacity-100' : 'opacity-0'
                        }`}
                      >
                        <span className="text-sm font-semibold text-green-600 flex items-center gap-1">
                          ✓ 已複製
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {/* 左下角操作說明（小圈 hover 顯示） */}
      <div className="absolute bottom-2 left-[-2px] z-30 group">
        <div className="w-[29px] h-[29px] rounded-full bg-indigo-500 hover:bg-indigo-600 text-white flex items-center justify-center text-base font-bold cursor-help shadow-md">
          ?
        </div>
        <div className="absolute left-0 bottom-full mb-1 hidden group-hover:block w-max max-w-[200px] p-2 rounded bg-gray-800/95 text-white text-xs leading-relaxed shadow-lg">
          <div className="font-semibold mb-1.5">操作說明</div>
          <div>雙擊 卡片：複製文字</div>
          <div>右鍵 雙擊：刪除區域</div>
          <div>單擊 文字：進入編輯</div>
          <div>拖曳 卡片標題：調整排序</div>
        </div>
      </div>
    </div>
  );
}
