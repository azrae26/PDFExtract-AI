/**
 * 功能：中間 PDF 顯示面板（連續頁面模式）
 * 職責：將所有 PDF 頁面依序往下排列顯示、每頁疊加可互動的 bounding boxes、每頁右側顯示分析/排隊/重跑按鈕
 * 依賴：react-pdf、BoundingBox 組件、types.ts
 */

'use client';

import { useState, useRef, useCallback, useEffect, useMemo, MouseEvent as ReactMouseEvent } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import BoundingBox from './BoundingBox';
import { Region } from '@/lib/types';
import { NORMALIZED_MAX } from '@/lib/constants';

// PDF.js worker 由 PDFExtractApp 統一設定，這裡不重複

/** 預設寬高比（A4）— 頁面尚未載入時用於佔位 */
const DEFAULT_RATIO = 1.414;

interface PdfViewerProps {
  pdfUrl: string | null;
  numPages: number;
  /** 所有頁面的 regions */
  pageRegions: Map<number, Region[]>;
  hoveredRegionId: string | null;
  onHover: (regionId: string | null) => void;
  onDocumentLoad: (pdf: pdfjs.PDFDocumentProxy) => void;
  onRegionUpdate: (page: number, regionId: number, newBbox: [number, number, number, number]) => void;
  /** 刪除 region */
  onRegionRemove: (page: number, regionId: number) => void;
  /** 新增 region（使用者在空白處畫框） */
  onRegionAdd: (page: number, bbox: [number, number, number, number]) => void;
  /** 計算某頁之前所有頁面 region 數量（配色偏移量） */
  getGlobalColorOffset: (page: number) => number;
  /** 要滾動到的 regionKey（格式 "page-regionId"），變化時觸發 scrollIntoView */
  scrollToRegionKey: string | null;
  /** 重新分析單頁 */
  onReanalyzePage: (page: number) => void;
  /** 雙擊框框 → 截圖送 AI 識別 */
  onRegionDoubleClick: (page: number, regionId: number) => void;
  /** 正在分析中的頁碼集合（按鈕顯示旋轉動畫） */
  analyzingPages: Set<number>;
  /** 排隊等待分析的頁碼集合（按鈕顯示 X 取消） */
  queuedPages: Set<number>;
  /** 取消佇列中的單頁 */
  onCancelQueuedPage: (page: number) => void;
  /** 刪除某頁的所有框 */
  onRemoveAllRegions: (page: number) => void;
}

export default function PdfViewer({
  pdfUrl,
  numPages,
  pageRegions,
  hoveredRegionId,
  onHover,
  onDocumentLoad,
  onRegionUpdate,
  onRegionRemove,
  onRegionAdd,
  getGlobalColorOffset,
  scrollToRegionKey,
  onReanalyzePage,
  onRegionDoubleClick,
  analyzingPages,
  queuedPages,
  onCancelQueuedPage,
  onRemoveAllRegions,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageWidth, setPageWidth] = useState(600);

  // 每頁容器的 ref（用於 scrollIntoView）
  const pageElRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // 滾動容器 ref
  const scrollRef = useRef<HTMLDivElement>(null);

  // 每頁右側按鈕群的 ref（用於 scroll 時動態 clamp 位置）
  const btnGroupRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // 上方/下方還有幾個框的計數
  const [aboveCount, setAboveCount] = useState(0);
  const [belowCount, setBelowCount] = useState(0);

  // === 頁面可見性追蹤（懶載入用） ===
  const [visiblePages, setVisiblePages] = useState<Set<number>>(new Set());
  const observerRef = useRef<IntersectionObserver | null>(null);

  // 建立 IntersectionObserver（rootMargin 上下各預載 800px）
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const pageNum = Number((entry.target as HTMLElement).dataset.pagenum);
            if (entry.isIntersecting) next.add(pageNum);
            else next.delete(pageNum);
          }
          return next;
        });
      },
      { root: scrollRef.current, rootMargin: '800px 0px' }
    );

    return () => {
      observerRef.current?.disconnect();
    };
  }, [pdfUrl]); // pdfUrl 變化時重建

  // ref callback 供每頁 wrapper 使用，同時註冊到 observer + pageElRefs
  const setPageRef = useCallback((pageNum: number, el: HTMLDivElement | null) => {
    if (el) {
      pageElRefs.current.set(pageNum, el);
      observerRef.current?.observe(el);
    } else {
      const old = pageElRefs.current.get(pageNum);
      if (old) observerRef.current?.unobserve(old);
      pageElRefs.current.delete(pageNum);
    }
  }, []);

  // === 空白處拖曳畫新框 ===
  const drawingRef = useRef<{ pageNum: number; startX: number; startY: number } | null>(null);
  const [drawingRect, setDrawingRect] = useState<{ pageNum: number; x: number; y: number; w: number; h: number } | null>(null);

  const handleOverlayMouseDown = useCallback((pageNum: number, dim: { width: number; height: number }, e: ReactMouseEvent) => {
    // 只在直接點擊覆蓋層時觸發（不是點在 BoundingBox 上）
    if (e.target !== e.currentTarget) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    drawingRef.current = { pageNum, startX: x, startY: y };
    setDrawingRect({ pageNum, x, y, w: 0, h: 0 });

    const handleMouseMove = (me: MouseEvent) => {
      if (!drawingRef.current) return;
      const curX = me.clientX - rect.left;
      const curY = me.clientY - rect.top;
      const sx = drawingRef.current.startX;
      const sy = drawingRef.current.startY;
      setDrawingRect({
        pageNum: drawingRef.current.pageNum,
        x: Math.min(sx, curX),
        y: Math.min(sy, curY),
        w: Math.abs(curX - sx),
        h: Math.abs(curY - sy),
      });
    };

    const handleMouseUp = (me: MouseEvent) => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (!drawingRef.current) return;

      const curX = me.clientX - rect.left;
      const curY = me.clientY - rect.top;
      const sx = drawingRef.current.startX;
      const sy = drawingRef.current.startY;
      const finalX = Math.min(sx, curX);
      const finalY = Math.min(sy, curY);
      const finalW = Math.abs(curX - sx);
      const finalH = Math.abs(curY - sy);

      // 只要有拖動就建立新框（寬高 > 0）
      if (finalW > 0 && finalH > 0) {
        const bbox: [number, number, number, number] = [
          Math.round((finalX / dim.width) * NORMALIZED_MAX),
          Math.round((finalY / dim.height) * NORMALIZED_MAX),
          Math.round(((finalX + finalW) / dim.width) * NORMALIZED_MAX),
          Math.round(((finalY + finalH) / dim.height) * NORMALIZED_MAX),
        ];
        onRegionAdd(drawingRef.current.pageNum, bbox);
      }

      drawingRef.current = null;
      setDrawingRect(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [onRegionAdd]);

  // 每頁的 pageDim（寬高）
  const [pageDims, setPageDims] = useState<Map<number, { width: number; height: number }>>(new Map());

  // 根據容器寬度動態調整 PDF 顯示寬度（使用 ResizeObserver 監聽容器尺寸變化）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const updateWidth = () => {
      const availableWidth = el.clientWidth - 48;
      setPageWidth(Math.max(availableWidth, 100));
    };

    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    updateWidth();

    return () => observer.disconnect();
  }, []);

  // 記錄各頁寬高比（通常各頁一致，但以防萬一）
  const pageRatiosRef = useRef<Map<number, number>>(new Map());

  // 某頁 PDF 載入完成 — 記錄寬高比並計算顯示尺寸
  const handlePageLoad = useCallback(
    (pageNum: number, page: pdfjs.PDFPageProxy) => {
      const viewport = page.getViewport({ scale: 1 });
      const ratio = viewport.height / viewport.width;
      pageRatiosRef.current.set(pageNum, ratio);
      const displayHeight = pageWidth * ratio;
      setPageDims((prev) => {
        const updated = new Map(prev);
        updated.set(pageNum, { width: pageWidth, height: displayHeight });
        return updated;
      });
    },
    [pageWidth]
  );

  // Page 載入失敗 — 靜默處理 destroyed document 的 race condition（sendWithPromise null error）
  const handlePageError = useCallback((error: Error) => {
    // 忽略 document 已被 destroy 導致的 getPage 錯誤（race condition，非真正的問題）
    if (error?.message?.includes('sendWithPromise') || error?.message?.includes('transport destroyed')) {
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.warn(`[PdfViewer][${ts}] ⚠️ Page load skipped (document destroyed, race condition):`, error.message);
      return;
    }
    console.error('[PdfViewer] Page load error:', error);
  }, []);

  // 當 scrollToRegionKey 變化時，滾動到對應頁面讓框框在畫面內
  useEffect(() => {
    if (!scrollToRegionKey) return;
    const pageNum = parseInt(scrollToRegionKey.split('-')[0], 10);
    if (isNaN(pageNum)) return;
    const pageEl = pageElRefs.current.get(pageNum);
    if (pageEl) {
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [scrollToRegionKey]);

  // 計算可視區域上方/下方的 region 數量
  const updateAboveBelowCounts = useCallback(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;

    const scrollTop = scrollEl.scrollTop;
    const scrollBottom = scrollTop + scrollEl.clientHeight;
    let above = 0;
    let below = 0;

    pageRegions.forEach((regions, pageNum) => {
      const pageEl = pageElRefs.current.get(pageNum);
      if (!pageEl || regions.length === 0) return;
      // pageEl 相對於 scrollEl 的位置
      const pageTop = pageEl.offsetTop;
      const pageBottom = pageTop + pageEl.offsetHeight;

      if (pageBottom < scrollTop) {
        // 整頁在上方
        above += regions.length;
      } else if (pageTop > scrollBottom) {
        // 整頁在下方
        below += regions.length;
      } else {
        // 頁面部分可見 — 用 pageDim 逐框判斷
        const dim = pageDims.get(pageNum);
        if (!dim) return;
        for (const r of regions) {
          const [, y1, , y2] = r.bbox;
          const boxTopPx = pageTop + (y1 / 1000) * dim.height;
          const boxBottomPx = pageTop + (y2 / 1000) * dim.height;
          if (boxBottomPx < scrollTop) above++;
          else if (boxTopPx > scrollBottom) below++;
        }
      }
    });

    setAboveCount(above);
    setBelowCount(below);
  }, [pageRegions, pageDims]);

  // 監聽滾動事件更新計數（throttle 100ms 避免過度觸發）
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    let ticking = false;
    const handler = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        updateAboveBelowCounts();
        // 動態 clamp 每頁右側按鈕到視口內（距上/下邊緣 100px）
        const st = scrollEl.scrollTop, vh = scrollEl.clientHeight;
        btnGroupRefs.current.forEach((btnEl, pn) => {
          const pe = pageElRefs.current.get(pn);
          if (!pe) return;
          const pt = pe.offsetTop, ph = pe.offsetHeight, bh = btnEl.offsetHeight;
          const def = pt + ph * 0.25;
          const clamped = Math.max(pt, Math.min(
            Math.max(st + 100, Math.min(def, st + vh - 100 - bh)),
            pt + ph - bh
          ));
          btnEl.style.top = `${clamped - pt}px`;
        });
        ticking = false;
      });
    };
    scrollEl.addEventListener('scroll', handler, { passive: true });
    // 初始計算
    updateAboveBelowCounts();
    handler(); // 按鈕初始位置
    return () => scrollEl.removeEventListener('scroll', handler);
  }, [updateAboveBelowCounts]);

  // pageRegions 變化時也重新計算
  useEffect(() => { updateAboveBelowCounts(); }, [pageRegions, updateAboveBelowCounts]);

  // 當 pageWidth 變化時，同步更新所有已知頁面的 pageDim
  useEffect(() => {
    const ratios = pageRatiosRef.current;
    if (ratios.size === 0) return;
    setPageDims(() => {
      const updated = new Map<number, { width: number; height: number }>();
      ratios.forEach((ratio, pageNum) => {
        updated.set(pageNum, { width: pageWidth, height: pageWidth * ratio });
      });
      return updated;
    });
  }, [pageWidth]);

  return (
    <div
      ref={containerRef}
      className="h-full relative flex flex-col items-center bg-gray-100 overflow-hidden"
    >
      {/* PDF 連續顯示區域 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col items-center pt-3 px-6 pb-6 gap-4 w-full">
        {pdfUrl ? (
          <Document
            file={pdfUrl}
            onLoadSuccess={(pdf) => onDocumentLoad(pdf as unknown as pdfjs.PDFDocumentProxy)}
            loading={
              <div className="flex items-center justify-center w-[600px] h-[800px] bg-white">
                <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
              </div>
            }
          >
            {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => {
              const regions = pageRegions.get(pageNum) || [];
              const dim = pageDims.get(pageNum);
              const colorOffset = getGlobalColorOffset(pageNum);
              const isVisible = visiblePages.has(pageNum);
              // 佔位高度：已知 ratio 就用它，否則用預設 A4 比例
              const ratio = pageRatiosRef.current.get(pageNum) ?? DEFAULT_RATIO;
              const placeholderHeight = pageWidth * ratio;

              return (
                <div
                  key={pageNum}
                  data-pagenum={pageNum}
                  ref={(el) => setPageRef(pageNum, el)}
                  className="relative inline-block shadow-lg mb-2 overflow-visible"
                  style={{ contain: 'layout style', minHeight: placeholderHeight }}
                >
                  {/* 頁碼標籤 */}
                  <div className="absolute -top-0 left-0 bg-gray-700/70 text-white text-xs px-2 py-0.5 rounded-br z-10">
                    {pageNum} / {numPages}
                  </div>

                  {/* 右側按鈕群 — JS 動態 clamp 到視口內（預設 25%） */}
                  <div
                    ref={(el) => { if (el) btnGroupRefs.current.set(pageNum, el); else btnGroupRefs.current.delete(pageNum); }}
                    className="absolute top-[25%] -right-[18px] flex flex-col gap-2 z-20"
                  >
                    {/* 重跑按鈕 */}
                    {analyzingPages.has(pageNum) ? (
                      /* 分析中：旋轉動畫 */
                      <div
                        className="w-9 h-9 rounded-full bg-blue-500 text-white shadow-lg border border-blue-500 flex items-center justify-center"
                        title={`第 ${pageNum} 頁分析中...`}
                      >
                        <svg className="w-4.5 h-4.5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      </div>
                    ) : queuedPages.has(pageNum) ? (
                      /* 排隊中：顯示 X 可取消 */
                      <button
                        onClick={() => onCancelQueuedPage(pageNum)}
                        className="w-9 h-9 rounded-full bg-amber-100 text-amber-600 shadow-md border border-amber-300 flex items-center justify-center hover:bg-red-500 hover:text-white hover:border-red-500 hover:shadow-lg active:scale-90 transition-all duration-150 cursor-pointer"
                        title={`第 ${pageNum} 頁排隊中，點擊取消`}
                      >
                        <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    ) : (
                      /* 正常狀態：可點擊重跑 */
                      <button
                        onClick={() => onReanalyzePage(pageNum)}
                        className="w-9 h-9 rounded-full bg-white text-gray-500 shadow-md border border-gray-200 flex items-center justify-center hover:bg-blue-500 hover:text-white hover:border-blue-500 hover:shadow-lg active:scale-90 transition-all duration-150 cursor-pointer"
                        title={`重新分析第 ${pageNum} 頁`}
                      >
                        <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                    )}

                    {/* 刪除該頁所有框 */}
                    {regions.length > 0 && (
                      <button
                        onClick={() => onRemoveAllRegions(pageNum)}
                        className="w-9 h-9 rounded-full bg-white text-gray-400 shadow-md border border-gray-200 flex items-center justify-center hover:bg-red-500 hover:text-white hover:border-red-500 hover:shadow-lg active:scale-90 transition-all duration-150 cursor-pointer"
                        title={`刪除第 ${pageNum} 頁的所有框 (${regions.length} 個)`}
                      >
                        <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* 只渲染可見頁面的 PDF canvas，遠處的頁面用佔位 div 節省記憶體 */}
                  {isVisible ? (
                    <Page
                      pageNumber={pageNum}
                      width={pageWidth}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      onLoadSuccess={(page) => handlePageLoad(pageNum, page)}
                      onLoadError={handlePageError}
                      loading={
                        <div
                          className="flex items-center justify-center bg-white"
                          style={{ width: pageWidth, height: placeholderHeight }}
                        >
                          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
                        </div>
                      }
                    />
                  ) : (
                    <div
                      className="bg-gray-200"
                      style={{ width: pageWidth, height: placeholderHeight }}
                    />
                  )}

                  {/* Bounding Boxes 覆蓋層（也是畫新框的拖曳目標） */}
                  {isVisible && dim && dim.width > 0 && (
                    <div
                      className="absolute top-0 left-0"
                      style={{ width: dim.width, height: dim.height, cursor: 'crosshair' }}
                      onMouseDown={(e) => handleOverlayMouseDown(pageNum, dim, e)}
                    >
                      {regions.map((region, index) => {
                        const regionKey = `${pageNum}-${region.id}`;
                        return (
                          <BoundingBox
                            key={regionKey}
                            region={region}
                            colorIndex={colorOffset + index}
                            displayWidth={dim.width}
                            displayHeight={dim.height}
                            isHovered={hoveredRegionId === regionKey}
                            onHover={() => onHover(regionKey)}
                            onHoverEnd={() => onHover(null)}
                            onUpdate={(newBbox) => onRegionUpdate(pageNum, region.id, newBbox)}
                            onRemove={() => onRegionRemove(pageNum, region.id)}
                            onDoubleClick={() => onRegionDoubleClick(pageNum, region.id)}
                          />
                        );
                      })}

                      {/* 正在畫的新框預覽 */}
                      {drawingRect && drawingRect.pageNum === pageNum && drawingRect.w > 0 && drawingRect.h > 0 && (
                        <div
                          className="absolute border-2 border-dashed border-blue-500 bg-blue-500/10 pointer-events-none"
                          style={{
                            left: drawingRect.x,
                            top: drawingRect.y,
                            width: drawingRect.w,
                            height: drawingRect.h,
                          }}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Document>
        ) : (
          /* 尚未上傳 PDF 的空狀態 */
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
            <svg className="w-20 h-20 mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
              />
            </svg>
            <p className="text-lg">PDF 預覽區域</p>
            <p className="text-sm text-gray-300 mt-1">請在左側上傳 PDF 檔案</p>
          </div>
        )}
      </div>

      {/* 上方框數提示 — absolute 覆蓋避免佈局抖動 */}
      {aboveCount > 0 && (
        <div className="absolute top-0 left-0 right-0 flex justify-center py-1 bg-gray-800/90 text-white text-sm font-bold z-30 pointer-events-none">
          ↑ 上方還有 {aboveCount} 個框
        </div>
      )}

      {/* 下方框數提示 — absolute 覆蓋避免佈局抖動 */}
      {belowCount > 0 && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-center py-1 bg-gray-800/90 text-white text-sm font-bold z-30 pointer-events-none overflow-hidden">
          ↓ 下方還有 {belowCount} 個框
        </div>
      )}
    </div>
  );
}
