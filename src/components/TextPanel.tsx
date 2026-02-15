/**
 * 功能：右側文字面板
 * 職責：顯示所有頁面的分析文字，按頁碼+順序排列，支援 hover 高亮互動、複製全文、
 *       刪除單一區域（同步刪除中間欄框）、拖曳調整同頁區域順序
 * 依賴：types.ts、constants.ts
 */

'use client';

import React, { useRef, useEffect, useCallback, useState } from 'react';
import { Region } from '@/lib/types';
import { getBoxColor, EMPTY_BOX_COLOR } from '@/lib/constants';

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
}: TextPanelProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const regionRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // === 複製成功提示 ===
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  // === 雙擊右鍵刪除 ===
  const lastRightClickRef = useRef<{ key: string; time: number }>({ key: '', time: 0 });

  // === 拖曳排序狀態 ===

  const [dragState, setDragState] = useState<{
    page: number;
    dragIndex: number;
    overIndex: number;
  } | null>(null);

  // === 自動滾動：兩條獨立事件路徑，各自設定不同滾動參數 ===
  // 路徑 1：PdfViewer 連動 → useEffect 監聽 hoveredRegionId → 滾到 20~80% 區間
  // 路徑 2：TextPanel 本身 hover → onMouseEnter 直接呼叫 → 只確保可見即可（8px 緩衝）
  // 共用底層 lerp 動畫，skipScrollRef 讓 useEffect 跳過 self hover（onMouseEnter 設 true、onMouseLeave 設 false，不在 useEffect 中改動，Strict Mode 安全）
  const scrollTargetRef = useRef<number | null>(null);
  const scrollRafRef = useRef<number>(0);
  const skipScrollRef = useRef(false);

  // 共用：啟動 lerp 滾動動畫到指定 scrollTop
  const animateScrollTo = useCallback((target: number) => {
    scrollTargetRef.current = target;
    // 若動畫已在跑，不重複啟動（loop 會自動讀取最新 target）
    if (scrollRafRef.current) return;

    const LERP_FACTOR = 0.15;
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
      scrollRafRef.current = requestAnimationFrame(animate);
    };

    scrollRafRef.current = requestAnimationFrame(animate);
  }, []);

  // 路徑 1：PdfViewer 連動 → 滾到 15~85% 區間
  useEffect(() => {
    if (!hoveredRegionId || skipScrollRef.current) {
      if (!hoveredRegionId) scrollTargetRef.current = null;
      return;
    }
    const el = regionRefs.current.get(hoveredRegionId);
    const container = scrollContainerRef.current;
    if (!el || !container) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const containerHeight = containerRect.height;
    const elTopInContainer = elRect.top - containerRect.top;
    const elBottomInContainer = elRect.bottom - containerRect.top;

    const zone20 = containerHeight * 0.15;
    const zone80 = containerHeight * 0.85;

    let scrollDelta = 0;
    if (elTopInContainer < zone20) {
      scrollDelta = elTopInContainer - zone20;
    } else if (elBottomInContainer > zone80) {
      scrollDelta = elBottomInContainer - zone80;
    } else {
      return;
    }

    animateScrollTo(container.scrollTop + scrollDelta);

    return () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = 0;
      }
    };
  }, [hoveredRegionId, animateScrollTo]);

  // 路徑 2：TextPanel 本身 hover → 只確保可見即可
  // 直接設定 scrollTop（不用 lerp 動畫），因為：
  // 1. 元素已幾乎可見（能 hover 到），只差一小段距離
  // 2. 若用 lerp，滾動會改變元素畫面位置 → 觸發 mouseLeave → 動畫被中斷
  const handleSelfHoverScroll = useCallback((regionKey: string) => {
    const el = regionRefs.current.get(regionKey);
    const container = scrollContainerRef.current;
    if (!el || !container) return;

    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const containerHeight = containerRect.height;
    const elTopInContainer = elRect.top - containerRect.top;
    const elBottomInContainer = elRect.bottom - containerRect.top;

    const SCROLL_PADDING = 8;
    let scrollDelta = 0;
    if (elTopInContainer < SCROLL_PADDING) {
      scrollDelta = elTopInContainer - SCROLL_PADDING;
    } else if (elBottomInContainer > containerHeight - SCROLL_PADDING) {
      scrollDelta = elBottomInContainer - (containerHeight - SCROLL_PADDING);
    } else {
      return; // 已完全在可視範圍內
    }

    container.scrollTop += scrollDelta;
  }, []);

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
    <div className="w-full h-full flex flex-col border-l border-gray-200 bg-white overflow-hidden">
      {/* 標題列 */}
      <div className="flex items-center justify-between px-4 h-11 border-b border-gray-200 bg-gray-50 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-700">提取文字</h2>
        {hasContent && (
          <button
            id="copy-all-btn"
            onClick={handleCopyAll}
            className={`flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-md shadow-sm hover:shadow transition-all cursor-pointer ${
              copiedAll
                ? 'bg-green-500 text-white'
                : 'bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-700'
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
                      draggable
                      onDragStart={() => handleDragStart(page, index)}
                      onDragOver={(e) => handleDragOver(page, index, e)}
                      onDragEnd={() => handleDragEnd(page, regions)}
                      className={`relative rounded-lg p-3 transition-all duration-150 cursor-pointer border group ${
                        isHovered ? 'shadow-md scale-[1.01]' : 'shadow-sm'
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
                        if (region.text) {
                          navigator.clipboard.writeText(region.text);
                          setCopiedKey(regionKey);
                          setTimeout(() => setCopiedKey(null), 1200);
                        }
                      }}
                      onMouseEnter={() => { skipScrollRef.current = true; onHover(regionKey); handleSelfHoverScroll(regionKey); }}
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

                      {/* 區域標籤 */}
                      {region.label && (
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ backgroundColor: color.border }}
                          />
                          <span className="text-xs font-medium text-gray-600 truncate">
                            {region.label}
                          </span>
                        </div>
                      )}
                      {/* 文字內容 */}
                      {isEmpty ? (
                        <p className="text-[13px] text-gray-400 leading-relaxed italic">
                          （無文字）
                        </p>
                      ) : region.text?.startsWith('⏳') ? (
                        <p className="text-[13px] text-blue-600 leading-relaxed flex items-center gap-1.5">
                          <span className="inline-block animate-hourglass text-[13px]">⏳</span>
                          {region.text.slice(1).trim()}
                        </p>
                      ) : (
                        <p className="text-[13px] text-gray-800 leading-relaxed break-words">
                          {region.text?.split('\n').map((line, i, arr) => (
                            <React.Fragment key={i}>
                              {line}
                              {i < arr.length - 1 && <br />}
                            </React.Fragment>
                          ))}
                        </p>
                      )}

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
    </div>
  );
}
