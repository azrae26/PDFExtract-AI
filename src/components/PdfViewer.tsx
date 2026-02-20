/**
 * 功能：中間 PDF 顯示面板（連續頁面模式）
 * 職責：將所有 PDF 頁面依序往下排列顯示、每頁疊加可互動的 bounding boxes、每頁右側顯示分析/排隊/重跑按鈕、
 *       右上角保存按鈕（截圖 + Debug JSON 匯出）
 * 依賴：react-pdf、BoundingBox 組件、types.ts、/api/save-page-export（後端存檔）
 */

'use client';

import { useState, useRef, useCallback, useEffect, useMemo, MouseEvent as ReactMouseEvent } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import BoundingBox from './BoundingBox';
import { Region } from '@/lib/types';
import { NORMALIZED_MAX, BOX_COLORS } from '@/lib/constants';

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
  /** 單擊框框 → 觸發右欄滾動到對應文字 */
  onBboxClick?: (regionKey: string) => void;
  /** 正在分析中的頁碼集合（按鈕顯示旋轉動畫） */
  analyzingPages: Set<number>;
  /** 排隊等待分析的頁碼集合（按鈕顯示 X 取消） */
  queuedPages: Set<number>;
  /** 取消佇列中的單頁 */
  onCancelQueuedPage: (page: number) => void;
  /** 刪除某頁的所有框 */
  onRemoveAllRegions: (page: number) => void;
  /** 是否顯示校正前的 bbox */
  showOriginalBbox: boolean;
  /** 切換校正前/校正後 bbox 顯示 */
  onToggleOriginalBbox: () => void;
  /** 目前顯示的 PDF 檔名（用於匯出時命名） */
  fileName?: string;
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
  showOriginalBbox,
  onToggleOriginalBbox,
  onBboxClick,
  fileName,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pageWidth, setPageWidth] = useState(600);

  // 追蹤最新 hoveredRegionId，供 BoundingBox 延遲 onHoverEnd 判斷「目前 hover 的是否還是自己」
  const hoveredRegionIdRef = useRef(hoveredRegionId);
  hoveredRegionIdRef.current = hoveredRegionId;

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
          // 先檢查是否有實際變更，避免 new Set 產生新引用觸發不必要的 re-render
          let hasChange = false;
          for (const entry of entries) {
            const pageNum = Number((entry.target as HTMLElement).dataset.pagenum);
            if (entry.isIntersecting ? !prev.has(pageNum) : prev.has(pageNum)) {
              hasChange = true;
              break;
            }
          }
          if (!hasChange) return prev; // 內容沒變，返回原引用 → React 跳過 re-render
          const next = new Set(prev);
          const added: number[] = [], removed: number[] = [];
          for (const entry of entries) {
            const pageNum = Number((entry.target as HTMLElement).dataset.pagenum);
            if (entry.isIntersecting) { if (!prev.has(pageNum)) added.push(pageNum); next.add(pageNum); }
            else { if (prev.has(pageNum)) removed.push(pageNum); next.delete(pageNum); }
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

  // 當 scrollToRegionKey 變化時，lerp 動畫滾動到對應頁面（置中）
  const viewerScrollRafRef = useRef<number>(0);
  const viewerScrollTargetRef = useRef<number | null>(null);

  useEffect(() => {
    if (!scrollToRegionKey) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const pageNum = parseInt(scrollToRegionKey.split('-')[0], 10);
    if (isNaN(pageNum)) return;
    const pageEl = pageElRefs.current.get(pageNum);
    if (!pageEl) return;

    // 計算目標 scrollTop：讓頁面置中
    const pageTop = pageEl.offsetTop;
    const pageHeight = pageEl.offsetHeight;
    const target = pageTop + pageHeight / 2 - scrollEl.clientHeight / 2;
    viewerScrollTargetRef.current = target;

    if (viewerScrollRafRef.current) return; // 動畫已在跑，更新 target 即可

    const LERP_FACTOR = 0.15;
    const THRESHOLD = 0.5;

    const animate = () => {
      const t = viewerScrollTargetRef.current;
      if (t === null || !scrollRef.current) {
        viewerScrollRafRef.current = 0;
        return;
      }
      const current = scrollRef.current.scrollTop;
      const diff = t - current;
      if (Math.abs(diff) < THRESHOLD) {
        scrollRef.current.scrollTop = t;
        viewerScrollRafRef.current = 0;
        viewerScrollTargetRef.current = null;
        return;
      }

      scrollRef.current.scrollTop = current + diff * LERP_FACTOR;
      // 邊界檢測：已到頂/底，終止動畫
      if (scrollRef.current.scrollTop === current) {
        viewerScrollRafRef.current = 0;
        viewerScrollTargetRef.current = null;
        return;
      }
      viewerScrollRafRef.current = requestAnimationFrame(animate);
    };

    viewerScrollRafRef.current = requestAnimationFrame(animate);

    return () => {
      if (viewerScrollRafRef.current) {
        cancelAnimationFrame(viewerScrollRafRef.current);
        viewerScrollRafRef.current = 0;
      }
    };
  }, [scrollToRegionKey]);

  // 用戶手動滾輪時取消正在進行的動畫
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const handleWheel = () => {
      if (viewerScrollRafRef.current) {
        cancelAnimationFrame(viewerScrollRafRef.current);
        viewerScrollRafRef.current = 0;
        viewerScrollTargetRef.current = null;
      }
    };
    scrollEl.addEventListener('wheel', handleWheel, { passive: true });
    return () => scrollEl.removeEventListener('wheel', handleWheel);
  }, []);

  // 追蹤滑鼠目前指向哪一頁（ref 供快捷鍵讀取 + state 供 hover 視覺效果）
  const hoveredPageRef = useRef<number | null>(null);
  const [hoveredPage, setHoveredPage] = useState<number | null>(null);

  const setHoveredPageNum = useCallback((pageNum: number | null) => {
    hoveredPageRef.current = pageNum;
    setHoveredPage(pageNum);
  }, []);

  // Ctrl / Alt 連按兩下偵測（document 層級，不需焦點）
  const lastCtrlRef = useRef(0);
  const lastAltRef = useRef(0);
  const DOUBLE_TAP_MS = 400;

  const onReanalyzePageRef = useRef(onReanalyzePage);
  onReanalyzePageRef.current = onReanalyzePage;
  const onRemoveAllRegionsRef = useRef(onRemoveAllRegions);
  onRemoveAllRegionsRef.current = onRemoveAllRegions;
  const pageRegionsRef = useRef(pageRegions);
  pageRegionsRef.current = pageRegions;
  const pdfUrlRef = useRef(pdfUrl);
  pdfUrlRef.current = pdfUrl;
  const pageWidthRef = useRef(pageWidth);
  pageWidthRef.current = pageWidth;

  // === 保存頁面相關 state & refs ===
  const [savingPages, setSavingPages] = useState(new Set<number>());
  const [savedPages, setSavedPages] = useState(new Set<number>());
  /** 防止同頁重複觸發（ref 不觸發 re-render，供 callback 讀取） */
  const savingInProgressRef = useRef(new Set<number>());
  const pageDimsRef = useRef(pageDims);
  pageDimsRef.current = pageDims;
  const getGlobalColorOffsetRef = useRef(getGlobalColorOffset);
  getGlobalColorOffsetRef.current = getGlobalColorOffset;
  const showOriginalBboxRef = useRef(showOriginalBbox);
  showOriginalBboxRef.current = showOriginalBbox;
  const fileNameRef = useRef(fileName);
  fileNameRef.current = fileName;

  // 全域快捷鍵（不需焦點，滑鼠指到 PDF 頁面即可）
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (hoveredPageRef.current === null) return;

      if (e.key === 'Control') {
        const now = Date.now();
        if (now - lastCtrlRef.current < DOUBLE_TAP_MS) {
          onReanalyzePageRef.current(hoveredPageRef.current);
          lastCtrlRef.current = 0;
        } else {
          lastCtrlRef.current = now;
        }
        return;
      }

      if (e.key === 'Alt') {
        e.preventDefault();
        const now = Date.now();
        if (now - lastAltRef.current < DOUBLE_TAP_MS) {
          const page = hoveredPageRef.current;
          const regions = pageRegionsRef.current.get(page);
          if (regions && regions.length > 0) {
            onRemoveAllRegionsRef.current(page);
          }
          lastAltRef.current = 0;
        } else {
          lastAltRef.current = now;
        }
        return;
      }

      // Space / S / W：捲動一頁（不需焦點）；輸入狀態時不監聽
      const el = e.target as HTMLElement;
      const tag = el?.tagName?.toUpperCase();
      const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el?.isContentEditable ?? false);
      if (isInput) return;

      let delta = 0;
      if (e.key === ' ') {
        delta = e.shiftKey ? -1 : 1;
      } else if (e.key === 's' || e.key === 'S' || e.key === 'w' || e.key === 'W') {
        delta = -1;
      } else {
        return;
      }

      const scrollEl = scrollRef.current;
      if (!scrollEl || !pdfUrlRef.current) return;
      e.preventDefault();

      const scrollTop = scrollEl.scrollTop;
      const viewportCenter = scrollTop + scrollEl.clientHeight / 2;
      let pageHeight = 0;
      const sortedPages = Array.from(pageElRefs.current.keys()).sort((a, b) => a - b);
      for (const pageNum of sortedPages) {
        const pageEl = pageElRefs.current.get(pageNum);
        if (!pageEl) continue;
        const pageTop = pageEl.offsetTop;
        const ph = pageEl.offsetHeight;
        if (viewportCenter >= pageTop && viewportCenter < pageTop + ph) {
          pageHeight = ph;
          break;
        }
      }
      if (pageHeight === 0 && sortedPages.length > 0) {
        const firstEl = pageElRefs.current.get(sortedPages[0]);
        pageHeight = firstEl?.offsetHeight ?? pageWidthRef.current * DEFAULT_RATIO;
      }
      if (pageHeight <= 0) return;

      const scrollDelta = delta * pageHeight;
      const target = Math.max(0, Math.min(scrollEl.scrollHeight - scrollEl.clientHeight, scrollTop + scrollDelta));
      scrollEl.scrollTop = target;
    };

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // === 保存頁面（截圖 + Debug JSON）===
  const handleSavePage = useCallback(async (pageNum: number) => {
    if (savingInProgressRef.current.has(pageNum)) return;

    const pageEl = pageElRefs.current.get(pageNum);
    if (!pageEl) return;

    const pdfCanvas = pageEl.querySelector('canvas') as HTMLCanvasElement | null;
    if (!pdfCanvas) {
      alert(`第 ${pageNum} 頁尚未渲染，請先滾動到該頁再儲存`);
      return;
    }

    const dim = pageDimsRef.current.get(pageNum);
    if (!dim || dim.width === 0) return;

    // 開始保存
    savingInProgressRef.current.add(pageNum);
    setSavingPages((prev) => { const s = new Set(prev); s.add(pageNum); return s; });

    try {
      // 1. 取得 PDF 原始資料（供後端提取單頁 PDF 檔）
      const pdfUrl = pdfUrlRef.current;
      if (!pdfUrl) throw new Error('PDF URL 不存在');
      const pdfBlob = await fetch(pdfUrl).then((r) => {
        if (!r.ok) throw new Error(`PDF 讀取失敗 (${r.status})`);
        return r.blob();
      });
      const pdfBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.includes(',') ? result.split(',')[1] : result);
        };
        reader.onerror = () => reject(new Error('PDF 讀取失敗'));
        reader.readAsDataURL(pdfBlob);
      });

      // 2. 含框截圖：在離屏 canvas 上疊加彩色 bbox
      const offscreen = document.createElement('canvas');
      offscreen.width = pdfCanvas.width;
      offscreen.height = pdfCanvas.height;
      const ctx = offscreen.getContext('2d');
      if (!ctx) throw new Error('無法建立 canvas context');

      ctx.drawImage(pdfCanvas, 0, 0);

      const scaleX = pdfCanvas.width / dim.width;
      const scaleY = pdfCanvas.height / dim.height;
      const regions = pageRegionsRef.current.get(pageNum) ?? [];
      const colorOffset = getGlobalColorOffsetRef.current(pageNum);
      const useOriginal = showOriginalBboxRef.current;

      regions.forEach((region, idx) => {
        const color = BOX_COLORS[(colorOffset + idx) % BOX_COLORS.length]; // 與畫面顯示顏色一致
        const bboxToUse = (useOriginal && region.originalBbox) ? region.originalBbox : region.bbox;
        const [x1, y1, x2, y2] = bboxToUse;
        if (x1 >= x2 || y1 >= y2) return; // 跳過無效 bbox（如 resolveX bug）

        const px = (x1 / NORMALIZED_MAX) * dim.width * scaleX;
        const py = (y1 / NORMALIZED_MAX) * dim.height * scaleY;
        const pw = ((x2 - x1) / NORMALIZED_MAX) * dim.width * scaleX;
        const ph = ((y2 - y1) / NORMALIZED_MAX) * dim.height * scaleY;

        // 半透明填充
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = color.border;
        ctx.fillRect(px, py, pw, ph);

        // 邊框
        ctx.globalAlpha = 1.0;
        ctx.strokeStyle = color.border;
        ctx.lineWidth = 2.5 * ((scaleX + scaleY) / 2);
        ctx.strokeRect(px, py, pw, ph);

        // 標籤（region 索引 + label）
        const label = region.label ? `${idx + 1}. ${region.label}` : `${idx + 1}`;
        const fontSize = Math.max(11, 13 * scaleX);
        ctx.font = `bold ${fontSize}px sans-serif`;
        const labelY = py - 4 * scaleY;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(px, labelY - fontSize, tw + 6 * scaleX, fontSize + 4 * scaleY);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, px + 3 * scaleX, labelY - 1 * scaleY);
      });

      const boxesJpgData = offscreen.toDataURL('image/jpeg', 0.92);

      // 3. Debug JSON（與 debug-pdf.ts 輸出格式一致，可直接貼入 test-cases.json）
      const ts = new Date().toISOString();
      const debugInfo = {
        capturedAt: ts,
        fileName: fileNameRef.current ?? 'unknown',
        page: pageNum,
        totalRegions: regions.length,
        regions: regions.map((r, idx) => {
          const bboxForPixel = r.bbox; // 永遠用最終 bbox 計算 pixel 座標
          return {
            page: pageNum,
            regionId: r.id,
            label: r.label,
            bbox: r.bbox,
            bboxSize: {
              w: r.bbox[2] - r.bbox[0],
              h: r.bbox[3] - r.bbox[1],
            },
            pixelBbox: {
              x: Math.round((bboxForPixel[0] / NORMALIZED_MAX) * dim.width),
              y: Math.round((bboxForPixel[1] / NORMALIZED_MAX) * dim.height),
              w: Math.round(((bboxForPixel[2] - bboxForPixel[0]) / NORMALIZED_MAX) * dim.width),
              h: Math.round(((bboxForPixel[3] - bboxForPixel[1]) / NORMALIZED_MAX) * dim.height),
            },
            displaySize: { w: dim.width, h: dim.height },
            ...(r.userModified ? { userModified: true } : {}),
            hitsCount: r._debug?.hits?.length ?? 0,
            hitsDetail: (r._debug?.hits ?? []).map((h, i) => ({ i, str: h.str })),
            extractionDebug: r._debug ?? null,
            text: r.text,
          };
        }),
      };

      // 4. POST 到 API 存檔
      const res = await fetch('/api/save-page-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: fileNameRef.current ?? 'unknown',
          page: pageNum,
          pdfBase64,
          jpgWithBoxesBase64: boxesJpgData.replace(/^data:image\/jpeg;base64,/, ''),
          debugJson: debugInfo,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (!result.success) throw new Error(result.error || '儲存失敗');

      const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PdfViewer][${ts2}] 💾 第 ${pageNum} 頁已儲存 → ${result.savedTo}`);

      // 短暫顯示成功狀態
      setSavedPages((prev) => { const s = new Set(prev); s.add(pageNum); return s; });
      setTimeout(() => {
        setSavedPages((prev) => { const s = new Set(prev); s.delete(pageNum); return s; });
      }, 2500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.error(`[PdfViewer][${ts}] ❌ 儲存失敗:`, msg);
      alert(`第 ${pageNum} 頁儲存失敗：${msg}`);
    } finally {
      savingInProgressRef.current.delete(pageNum);
      setSavingPages((prev) => { const s = new Set(prev); s.delete(pageNum); return s; });
    }
  }, []); // 所有外部依賴均透過 ref 讀取，無需列入 deps

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
      {/* PDF 連續顯示區域（tabIndex 使空格鍵可觸發自訂捲動） */}
      <div
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label="PDF 預覽"
        className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col items-center pt-3 px-6 pb-6 gap-4 w-full outline-none"
        style={{ overflowAnchor: 'none' }}
      >
        {pdfUrl ? (
          <Document
            file={pdfUrl}
            className="flex flex-col items-center"
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

              const isPageHovered = hoveredPage === pageNum;

              return (
                <div
                  key={pageNum}
                  data-pagenum={pageNum}
                  ref={(el) => setPageRef(pageNum, el)}
                  className={`relative inline-block shadow-lg mb-2 overflow-visible transition-shadow duration-150 ${isPageHovered ? 'ring-3 ring-blue-400/70' : ''}`}
                  style={{ contain: 'layout style', minHeight: placeholderHeight }}
                  onMouseEnter={() => setHoveredPageNum(pageNum)}
                  onMouseLeave={() => { if (hoveredPageRef.current === pageNum) setHoveredPageNum(null); }}
                >
                  {/* 頁碼標籤 */}
                  <div className="absolute -top-0 left-0 bg-gray-700/70 text-white text-xs px-2 py-0.5 rounded-br z-10">
                    {pageNum} / {numPages}
                  </div>

                  {/* 保存按鈕（右上角）— 儲存截圖 + Debug JSON */}
                  <button
                    onClick={() => handleSavePage(pageNum)}
                    disabled={savingPages.has(pageNum)}
                    className={`absolute top-0 right-0 flex items-center gap-1 px-1.5 py-0.5 rounded-bl z-10 text-xs font-medium transition-all duration-200 select-none ${
                      savingPages.has(pageNum)
                        ? 'bg-blue-500/80 text-white cursor-wait'
                        : savedPages.has(pageNum)
                          ? 'bg-green-600/80 text-white'
                          : 'bg-gray-700/70 text-white hover:bg-indigo-600/80 cursor-pointer'
                    }`}
                    title="儲存此頁（PDF截圖 / 含框截圖 / Debug JSON）"
                  >
                    {savingPages.has(pageNum) ? (
                      <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                    ) : savedPages.has(pageNum) ? (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    )}
                    <span>{savedPages.has(pageNum) ? '已儲存' : '儲存'}</span>
                  </button>

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
                      /* 正常狀態：可點擊重跑，顏色反映頁面狀態 */
                      (() => {
                        const hasEntry = pageRegions.has(pageNum);
                        const pageRegs = regions; // 已在上方取得
                        const hasAiRegions = hasEntry && (pageRegs.length === 0 || pageRegs.some((r) => !r.userModified));
                        const hasOnlyUserRegions = hasEntry && pageRegs.length > 0 && pageRegs.every((r) => r.userModified);
                        // 綠=AI已跑完, 橘=僅手動畫框, 白=未跑過
                        const statusColor = hasAiRegions
                          ? 'bg-green-200 text-green-700 border-green-400 hover:bg-green-500 hover:text-white hover:border-green-500'
                          : hasOnlyUserRegions
                            ? 'bg-amber-200 text-amber-700 border-amber-400 hover:bg-amber-500 hover:text-white hover:border-amber-500'
                            : 'bg-white text-gray-500 border-gray-200 hover:bg-blue-500 hover:text-white hover:border-blue-500';
                        const statusTitle = hasAiRegions
                          ? `第 ${pageNum} 頁（AI 已完成）- 點擊重跑`
                          : hasOnlyUserRegions
                            ? `第 ${pageNum} 頁（手動畫框）- 點擊重跑`
                            : `重新分析第 ${pageNum} 頁`;
                        return (
                      <button
                        onClick={() => onReanalyzePage(pageNum)}
                        className={`w-9 h-9 rounded-full shadow-md border flex items-center justify-center hover:shadow-lg active:scale-90 transition-all duration-150 cursor-pointer ${statusColor}`}
                        title={statusTitle}
                      >
                        <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                      </button>
                        );
                      })()
                    )}

                    {/* 切換校正前/校正後 bbox */}
                    {regions.length > 0 && (
                      <button
                        onClick={onToggleOriginalBbox}
                        className={`w-9 h-9 rounded-full shadow-md border flex items-center justify-center active:scale-90 transition-all duration-150 cursor-pointer ${
                          showOriginalBbox
                            ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600 hover:border-amber-600'
                            : 'bg-white text-gray-500 border-gray-200 hover:bg-amber-500 hover:text-white hover:border-amber-500 hover:shadow-lg'
                        }`}
                        title={showOriginalBbox ? '目前顯示：校正前 bbox（點擊切回校正後）' : '切換顯示校正前 bbox'}
                      >
                        <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
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
                            onHover={() => { onHover(regionKey); onBboxClick?.(regionKey); }}
                            onHoverEnd={() => { if (hoveredRegionIdRef.current === regionKey) onHover(null); }}
                            onUpdate={(newBbox) => onRegionUpdate(pageNum, region.id, newBbox)}
                            onRemove={() => onRegionRemove(pageNum, region.id)}
                            onDoubleClick={() => onRegionDoubleClick(pageNum, region.id)}
                            showOriginalBbox={showOriginalBbox}
                            pageNumber={pageNum}
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
        <div className="absolute top-0 left-0 right-0 flex justify-center py-1 bg-gray-800/90 text-white text-base font-bold z-30 pointer-events-none">
          ↑ 上方還有 {aboveCount} 個框
        </div>
      )}

      {/* 下方框數提示 — absolute 覆蓋避免佈局抖動 */}
      {belowCount > 0 && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-center py-1 bg-gray-800/90 text-white text-base font-bold z-30 pointer-events-none overflow-hidden">
          ↓ 下方還有 {belowCount} 個框
        </div>
      )}

      {/* 左下角快捷鍵說明（小圈 hover 顯示） */}
      <div className="absolute bottom-2 left-2 z-30 group">
        <div className="w-[31px] h-[31px] rounded-full bg-indigo-500 hover:bg-indigo-600 text-white flex items-center justify-center text-base font-bold cursor-help shadow-md">
          ?
        </div>
        <div className="absolute left-0 bottom-full mb-1 hidden group-hover:block w-max max-w-[200px] p-2 rounded bg-gray-800/95 text-white text-xs leading-relaxed shadow-lg">
          <div className="font-semibold mb-1.5">快捷鍵（滑鼠指到某頁）</div>
          <div>Space：下一頁</div>
          <div>S 或 W：上一頁</div>
          <div>Ctrl×2：重跑該頁</div>
          <div>Alt×2：刪除該頁框</div>
          <div className="mt-1.5 pt-1.5 border-t border-gray-600">E：上一個檔案</div>
          <div>D：下一個檔案</div>
        </div>
      </div>
    </div>
  );
}

