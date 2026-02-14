/**
 * 功能：PDFExtract AI 主應用元件
 * 職責：管理全域狀態（PDF、分析結果、hover 互動）、三欄可拖動分界線佈局，串接上傳→轉圖→送API→畫框→顯示文字的完整流程
 * 依賴：react-pdf (pdfjs)、PdfUploader、PdfViewer、TextPanel、API route /api/analyze
 */

'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { pdfjs } from 'react-pdf';
import PdfUploader, { DEFAULT_MODEL } from './PdfUploader';
import PdfViewer from './PdfViewer';
import TextPanel from './TextPanel';
import { Region } from '@/lib/types';
import { DEFAULT_PROMPT, DEFAULT_TABLE_PROMPT, RENDER_SCALE, JPEG_QUALITY, NORMALIZED_MAX } from '@/lib/constants';
import { extractTextForRegions } from '@/lib/pdfTextExtract';

// === 預設批次並行數量 ===
const DEFAULT_BATCH_SIZE = 5;

// === 分界線拖動的最小/最大寬度限制 ===
const MIN_PANEL_WIDTH = 200;
const MAX_PANEL_WIDTH = Infinity;
const DEFAULT_LEFT_WIDTH = 420;
// 右側文字面板預設佔視窗 30%（在 useEffect 中計算）
const DEFAULT_RIGHT_RATIO = 0.3;

// === localStorage 持久化 key ===
const STORAGE_KEY = 'pdfextract-ai-config';

/** 從 localStorage 讀取已儲存的配置 */
function loadConfig(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

/** 將配置寫入 localStorage */
function saveConfig(patch: Record<string, unknown>) {
  try {
    const existing = loadConfig();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, ...patch }));
  } catch { /* ignore */ }
}

// 設定 PDF.js worker（使用 CDN，避免 bundler 問題）
if (typeof window !== 'undefined') {
  pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
}

export default function PDFExtractApp() {
  // === 狀態 ===
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [prompt, setPrompt] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.prompt === 'string' ? cfg.prompt : DEFAULT_PROMPT;
  });
  const [tablePrompt, setTablePrompt] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.tablePrompt === 'string' ? cfg.tablePrompt : DEFAULT_TABLE_PROMPT;
  });
  const [model, setModel] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.model === 'string' ? cfg.model : DEFAULT_MODEL;
  });
  const [batchSize, setBatchSize] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.batchSize === 'number' ? cfg.batchSize : DEFAULT_BATCH_SIZE;
  });
  const [pageRegions, setPageRegions] = useState<Map<number, Region[]>>(new Map());
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 0 });
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // === 三欄可拖動分界線 ===
  // 左側：上傳 & Prompt，右側：提取文字（預設 30% 視窗寬度）
  const [leftWidth, setLeftWidth] = useState(() => {
    const cfg = loadConfig();
    return typeof cfg.leftWidth === 'number' ? cfg.leftWidth : DEFAULT_LEFT_WIDTH;
  });
  const [rightWidth, setRightWidth] = useState(() => {
    const cfg = loadConfig();
    if (typeof cfg.rightWidth === 'number') return cfg.rightWidth;
    if (typeof window !== 'undefined') {
      return Math.max(MIN_PANEL_WIDTH, Math.round(window.innerWidth * DEFAULT_RIGHT_RATIO));
    }
    return 400;
  });
  const isDraggingPanel = useRef<'left' | 'right' | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const pdfDocRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  // 用來在分析被中斷時標記
  const abortRef = useRef(false);

  // === 自動儲存配置到 localStorage ===
  useEffect(() => { saveConfig({ prompt }); }, [prompt]);
  useEffect(() => { saveConfig({ tablePrompt }); }, [tablePrompt]);
  useEffect(() => { saveConfig({ model }); }, [model]);
  useEffect(() => { saveConfig({ batchSize }); }, [batchSize]);
  useEffect(() => { saveConfig({ leftWidth }); }, [leftWidth]);
  useEffect(() => { saveConfig({ rightWidth }); }, [rightWidth]);

  // === 分界線拖動事件處理 ===
  const handlePanelMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingPanel.current) return;
    const delta = e.clientX - dragStartX.current;

    if (isDraggingPanel.current === 'left') {
      // 左側分界線：向右拖 = 左面板變大
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartWidth.current + delta));
      setLeftWidth(newWidth);
    } else {
      // 右側分界線：向左拖 = 右面板變大（delta 反向）
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartWidth.current - delta));
      setRightWidth(newWidth);
    }
  }, []);

  const handlePanelMouseUp = useCallback(() => {
    isDraggingPanel.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', handlePanelMouseMove);
    document.removeEventListener('mouseup', handlePanelMouseUp);
  }, [handlePanelMouseMove]);

  const handleDividerMouseDown = useCallback(
    (side: 'left' | 'right') => (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingPanel.current = side;
      dragStartX.current = e.clientX;
      dragStartWidth.current = side === 'left' ? leftWidth : rightWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handlePanelMouseMove);
      document.addEventListener('mouseup', handlePanelMouseUp);
    },
    [leftWidth, rightWidth, handlePanelMouseMove, handlePanelMouseUp]
  );

  // 清理：元件卸載時移除事件
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handlePanelMouseMove);
      document.removeEventListener('mouseup', handlePanelMouseUp);
    };
  }, [handlePanelMouseMove, handlePanelMouseUp]);

  // 清理 object URL
  useEffect(() => {
    return () => {
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  }, [pdfUrl]);

  // === 檔案上傳 ===
  const handleFileUpload = useCallback(
    (file: File) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${timestamp}] 📁 File uploaded: ${file.name}`);

      // 中斷正在進行的分析
      abortRef.current = true;

      // 清理前一個 URL
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);

      setPdfFile(file);
      setPdfUrl(URL.createObjectURL(file));
      setPageRegions(new Map());
      setCurrentPage(1);
      setNumPages(0);
      setError(null);
    },
    [pdfUrl]
  );

  // === 全頁面拖放 PDF ===
  const [isPageDragging, setIsPageDragging] = useState(false);
  const dragCounterRef = useRef(0);

  const handlePageDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setIsPageDragging(true);
    }
  }, []);

  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsPageDragging(false);
    }
  }, []);

  const handlePageDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handlePageDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsPageDragging(false);
      dragCounterRef.current = 0;

      const files = e.dataTransfer.files;
      if (files.length > 0 && files[0].type === 'application/pdf') {
        handleFileUpload(files[0]);
      }
    },
    [handleFileUpload]
  );

  // === 將 PDF 單頁渲染為 JPEG 圖片 ===
  const renderPageToImage = useCallback(async (pageNum: number): Promise<string> => {
    if (!pdfDocRef.current) throw new Error('PDF not loaded');

    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${timestamp}] 🖼️ Rendering page ${pageNum} to image...`);

    const page = await pdfDocRef.current.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d')!;

    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    canvas.remove();

    // 回傳 base64（不含 data:image/jpeg;base64, 前綴）
    const base64 = dataUrl.split(',')[1];
    const sizeKB = Math.round((base64.length * 3) / 4 / 1024);
    const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts2}] 📐 Page ${pageNum} JPEG: ${canvas.width}x${canvas.height}px, ${sizeKB} KB (scale=${RENDER_SCALE}, quality=${JPEG_QUALITY})`);
    return base64;
  }, []);

  // === 分析單頁 ===
  const analyzePage = useCallback(
    async (pageNum: number, promptText: string, modelId: string) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });

      try {
        const imageBase64 = await renderPageToImage(pageNum);

        console.log(`[PDFExtractApp][${timestamp}] 📤 Sending page ${pageNum} to API (model: ${modelId})...`);

        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: imageBase64,
            prompt: promptText,
            page: pageNum,
            model: modelId,
          }),
        });

        const result = await response.json();

        if (!result.success) {
          console.error(`[PDFExtractApp][${timestamp}] ❌ Page ${pageNum} failed:`, result.error);
          return null;
        }

        console.log(
          `[PDFExtractApp][${timestamp}] ✅ Page ${pageNum}: ${result.data.regions.length} regions found`
        );
        return result.data;
      } catch (err) {
        console.error(`[PDFExtractApp][${timestamp}] ❌ Error analyzing page ${pageNum}:`, err);
        return null;
      }
    },
    [renderPageToImage]
  );

  // === 自動分析所有頁面（批次並行，merge 不覆蓋 userModified）===
  const analyzeAllPages = useCallback(
    async (totalPages: number, promptText: string, modelId: string, concurrency: number) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${timestamp}] 🚀 Starting analysis of ${totalPages} pages in batches of ${concurrency} (model: ${modelId})...`);

      abortRef.current = false;
      setIsAnalyzing(true);
      setError(null);
      // 清除非 userModified 的 regions，保留手動修改/新增的
      setPageRegions((prev) => {
        const kept = new Map<number, Region[]>();
        prev.forEach((regions, page) => {
          const userRegions = regions.filter((r) => r.userModified);
          if (userRegions.length > 0) kept.set(page, userRegions);
        });
        return kept;
      });
      setAnalysisProgress({ current: 0, total: totalPages });

      let completed = 0;

      /** 單頁完成後立即處理並顯示 */
      const processPage = async (pageNum: number) => {
        if (abortRef.current) return;

        const result = await analyzePage(pageNum, promptText, modelId);

        if (abortRef.current) return;

        completed++;
        setAnalysisProgress({ current: completed, total: totalPages });

        if (result && result.hasAnalysis && result.regions.length > 0) {
          let regionsWithText = result.regions;
          try {
            const pdfPage = await pdfDocRef.current!.getPage(pageNum);
            regionsWithText = await extractTextForRegions(pdfPage, result.regions);
          } catch (e) {
            console.warn(`[PDFExtractApp] ⚠️ Text extraction failed for page ${pageNum}`, e);
          }

          // Merge：保留 userModified 的 regions，追加 AI 新結果
          setPageRegions((prev) => {
            const updated = new Map(prev);
            const existing = updated.get(pageNum) || [];
            const userRegions = existing.filter((r) => r.userModified);
            const maxExistingId = userRegions.reduce((max, r) => Math.max(max, r.id), 0);
            const aiRegions = regionsWithText.map((r: Region, i: number) => ({
              ...r,
              id: maxExistingId + i + 1,
              userModified: false,
            }));
            updated.set(pageNum, [...userRegions, ...aiRegions]);
            return updated;
          });
        }
      };

      // 用並行池（concurrency 個同時跑），每頁回來就立刻顯示
      for (let batchStart = 1; batchStart <= totalPages; batchStart += concurrency) {
        if (abortRef.current) {
          console.log(`[PDFExtractApp][${timestamp}] ⚠️ Analysis aborted at batch starting page ${batchStart}`);
          break;
        }

        const batchEnd = Math.min(batchStart + concurrency - 1, totalPages);
        const pageNums = Array.from({ length: batchEnd - batchStart + 1 }, (_, i) => batchStart + i);

        // 每頁獨立 promise，回來就立刻 merge 顯示，但整批完成後才發下一批
        await Promise.all(pageNums.map((p) => processPage(p)));
      }

      setIsAnalyzing(false);

      const endTimestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${endTimestamp}] 🏁 Analysis complete.`);
    },
    [analyzePage]
  );

  // === PDF Document 載入完成（由 react-pdf 觸發）===
  const handleDocumentLoad = useCallback(
    (pdf: pdfjs.PDFDocumentProxy) => {
      const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${timestamp}] 📄 PDF loaded: ${pdf.numPages} pages`);

      pdfDocRef.current = pdf;
      setNumPages(pdf.numPages);
      setCurrentPage(1);

      // 自動開始分析
      analyzeAllPages(pdf.numPages, prompt, model, batchSize);
    },
    [prompt, model, batchSize, analyzeAllPages]
  );

  // === 更新單一區域的 bbox（拖動/resize 後）→ 標記 userModified + 自動重新提取文字 ===
  const handleRegionUpdate = useCallback(
    async (page: number, regionId: number, newBbox: [number, number, number, number]) => {
      // 先立即更新 bbox 並標記 userModified（UI 即時反映）
      setPageRegions((prev) => {
        const updated = new Map(prev);
        const regions = updated.get(page);
        if (regions) {
          const updatedRegions = regions.map((r) =>
            r.id === regionId ? { ...r, bbox: newBbox, userModified: true } : r
          );
          updated.set(page, updatedRegions);
        }
        return updated;
      });

      // 非同步重新提取該框的文字
      try {
        if (!pdfDocRef.current) return;
        const pdfPage = await pdfDocRef.current.getPage(page);
        // 只對變動的 region 重新提取
        const tempRegion: Region = { id: regionId, bbox: newBbox, label: '', text: '' };
        const [extracted] = await extractTextForRegions(pdfPage, [tempRegion]);

        setPageRegions((prev) => {
          const updated = new Map(prev);
          const regions = updated.get(page);
          if (regions) {
            const updatedRegions = regions.map((r) =>
              r.id === regionId ? { ...r, text: extracted.text } : r
            );
            updated.set(page, updatedRegions);
          }
          return updated;
        });

        const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
        console.log(`[PDFExtractApp][${ts}] 📝 Re-extracted text for page ${page} region ${regionId}`);
      } catch (e) {
        console.warn(`[PDFExtractApp] ⚠️ Failed to re-extract text for page ${page} region ${regionId}`, e);
      }
    },
    []
  );

  // === 刪除單一 region ===
  const handleRegionRemove = useCallback((page: number, regionId: number) => {
    setPageRegions((prev) => {
      const updated = new Map(prev);
      const regions = updated.get(page);
      if (regions) {
        const filtered = regions.filter((r) => r.id !== regionId);
        if (filtered.length > 0) {
          updated.set(page, filtered);
        } else {
          updated.delete(page);
        }
      }
      return updated;
    });
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${ts}] 🗑️ Removed region ${regionId} from page ${page}`);
  }, []);

  // === 新增 region（使用者在 PDF 上手動畫框）===
  const handleRegionAdd = useCallback(
    async (page: number, bbox: [number, number, number, number]) => {
      // 計算新 id：該頁最大 id + 1
      const newId = (() => {
        const regions = pageRegions.get(page) || [];
        return regions.reduce((max, r) => Math.max(max, r.id), 0) + 1;
      })();

      const newRegion: Region = {
        id: newId,
        bbox,
        label: `手動框 ${newId}`,
        text: '',
        userModified: true,
      };

      // 插入到正確的閱讀順序位置（由上到下、由左到右）
      setPageRegions((prev) => {
        const updated = new Map(prev);
        const existing = updated.get(page) || [];
        const [nx1, ny1] = bbox;
        // 找到第一個 y 比新框大（或 y 相近但 x 比新框大）的位置
        let insertIdx = existing.length;
        for (let i = 0; i < existing.length; i++) {
          const [ex1, ey1] = existing[i].bbox;
          const yDiff = ey1 - ny1;
          if (yDiff > 15 || (Math.abs(yDiff) <= 15 && ex1 > nx1)) {
            insertIdx = i;
            break;
          }
        }
        const newList = [...existing];
        newList.splice(insertIdx, 0, newRegion);
        updated.set(page, newList);
        return updated;
      });

      // 非同步提取文字
      try {
        if (!pdfDocRef.current) return;
        const pdfPage = await pdfDocRef.current.getPage(page);
        const [extracted] = await extractTextForRegions(pdfPage, [newRegion]);
        setPageRegions((prev) => {
          const updated = new Map(prev);
          const regions = updated.get(page);
          if (regions) {
            updated.set(page, regions.map((r) =>
              r.id === newId ? { ...r, text: extracted.text } : r
            ));
          }
          return updated;
        });
      } catch (e) {
        console.warn(`[PDFExtractApp] ⚠️ Text extraction failed for new region on page ${page}`, e);
      }

      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] ➕ Added new region ${newId} on page ${page}`);
    },
    [pageRegions]
  );

  // === 重新排序某頁的 regions ===
  const handleReorderRegions = useCallback((page: number, reorderedRegions: Region[]) => {
    setPageRegions((prev) => {
      const updated = new Map(prev);
      updated.set(page, reorderedRegions);
      return updated;
    });
  }, []);

  // === 點擊文字框 → 滾動 PDF 到對應框 ===
  const handleClickRegion = useCallback((regionKey: string) => {
    // 設成 null 再設回來，確保重複點擊同一框也能觸發 useEffect
    setScrollTarget(null);
    requestAnimationFrame(() => setScrollTarget(regionKey));
  }, []);

  // === 停止分析 ===
  const handleStop = useCallback(() => {
    abortRef.current = true;
    setIsAnalyzing(false);
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    console.log(`[PDFExtractApp][${timestamp}] 🛑 Analysis stopped by user.`);
  }, []);

  // === 重新分析（清除所有框，包含手動修改的）===
  const handleReanalyze = useCallback(() => {
    if (pdfDocRef.current && numPages > 0) {
      setPageRegions(new Map());
      analyzeAllPages(numPages, prompt, model, batchSize);
    }
  }, [numPages, prompt, model, batchSize, analyzeAllPages]);

  // === 重新分析單頁 ===
  const handleReanalyzePage = useCallback(
    async (pageNum: number) => {
      if (!pdfDocRef.current) return;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] 🔄 Re-analyzing page ${pageNum}...`);

      setIsAnalyzing(true);
      setAnalysisProgress({ current: 0, total: 1 });
      setError(null);

      // 清除該頁的非 userModified regions
      setPageRegions((prev) => {
        const updated = new Map(prev);
        const existing = updated.get(pageNum) || [];
        const userRegions = existing.filter((r) => r.userModified);
        if (userRegions.length > 0) {
          updated.set(pageNum, userRegions);
        } else {
          updated.delete(pageNum);
        }
        return updated;
      });

      const result = await analyzePage(pageNum, prompt, model);
      setAnalysisProgress({ current: 1, total: 1 });

      if (result && result.hasAnalysis && result.regions.length > 0) {
        let regionsWithText = result.regions;
        try {
          const pdfPage = await pdfDocRef.current.getPage(pageNum);
          regionsWithText = await extractTextForRegions(pdfPage, result.regions);
        } catch (e) {
          console.warn(`[PDFExtractApp] ⚠️ Text extraction failed for page ${pageNum}`, e);
        }

        setPageRegions((prev) => {
          const updated = new Map(prev);
          const existing = updated.get(pageNum) || [];
          const userRegions = existing.filter((r) => r.userModified);
          const maxExistingId = userRegions.reduce((max, r) => Math.max(max, r.id), 0);
          const aiRegions = regionsWithText.map((r: Region, i: number) => ({
            ...r,
            id: maxExistingId + i + 1,
            userModified: false,
          }));
          updated.set(pageNum, [...userRegions, ...aiRegions]);
          return updated;
        });
      }

      setIsAnalyzing(false);
    },
    [prompt, model, analyzePage]
  );

  // === 雙擊框框 → 截圖該區域 → 送 AI 識別（表格/圖表） ===
  const handleRegionDoubleClick = useCallback(
    async (page: number, regionId: number) => {
      if (!pdfDocRef.current) return;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[PDFExtractApp][${ts}] 🖱️ Double-click on page ${page} region ${regionId}, capturing...`);

      // 找到該 region 的 bbox
      const regions = pageRegions.get(page);
      const region = regions?.find((r) => r.id === regionId);
      if (!region) return;

      setIsAnalyzing(true);
      setAnalysisProgress({ current: 0, total: 1 });
      setError(null);

      try {
        // 用 pdfjs 渲染整頁到 canvas，然後裁切目標區域
        const pdfPage = await pdfDocRef.current.getPage(page);
        const viewport = pdfPage.getViewport({ scale: RENDER_SCALE });

        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = viewport.width;
        fullCanvas.height = viewport.height;
        const ctx = fullCanvas.getContext('2d')!;
        await pdfPage.render({ canvas: fullCanvas, canvasContext: ctx, viewport }).promise;

        // bbox 歸一化座標 → 像素座標
        const [x1, y1, x2, y2] = region.bbox;
        const sx = (x1 / NORMALIZED_MAX) * viewport.width;
        const sy = (y1 / NORMALIZED_MAX) * viewport.height;
        const sw = ((x2 - x1) / NORMALIZED_MAX) * viewport.width;
        const sh = ((y2 - y1) / NORMALIZED_MAX) * viewport.height;

        // 裁切到新 canvas
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = Math.round(sw);
        cropCanvas.height = Math.round(sh);
        const cropCtx = cropCanvas.getContext('2d')!;
        cropCtx.drawImage(fullCanvas, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);

        // 轉 base64 JPEG
        const dataUrl = cropCanvas.toDataURL('image/jpeg', JPEG_QUALITY);
        const base64 = dataUrl.split(',')[1];
        const sizeKB = Math.round((base64.length * 3) / 4 / 1024);

        fullCanvas.remove();
        cropCanvas.remove();

        console.log(`[PDFExtractApp][${ts}] 📐 Cropped region: ${cropCanvas.width}x${cropCanvas.height}px, ${sizeKB} KB`);

        // 標記載入中（先在文字欄顯示「識別中...」）
        setPageRegions((prev) => {
          const updated = new Map(prev);
          const rs = updated.get(page);
          if (rs) {
            updated.set(page, rs.map((r) =>
              r.id === regionId ? { ...r, text: '⏳ AI 識別中...', userModified: true } : r
            ));
          }
          return updated;
        });

        // 送 API
        const response = await fetch('/api/recognize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: base64,
            prompt: tablePrompt,
            model,
            page,
            regionId,
          }),
        });
        const result = await response.json();

        setAnalysisProgress({ current: 1, total: 1 });

        if (result.success && result.text) {
          setPageRegions((prev) => {
            const updated = new Map(prev);
            const rs = updated.get(page);
            if (rs) {
              updated.set(page, rs.map((r) =>
                r.id === regionId ? { ...r, text: result.text, userModified: true } : r
              ));
            }
            return updated;
          });
          const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`[PDFExtractApp][${ts2}] ✅ Region ${regionId} recognized: ${result.text.length} chars`);
        } else {
          setPageRegions((prev) => {
            const updated = new Map(prev);
            const rs = updated.get(page);
            if (rs) {
              updated.set(page, rs.map((r) =>
                r.id === regionId ? { ...r, text: `❌ 識別失敗: ${result.error || '未知錯誤'}` } : r
              ));
            }
            return updated;
          });
        }
      } catch (e) {
        console.error(`[PDFExtractApp][${ts}] ❌ Region double-click error:`, e);
        setPageRegions((prev) => {
          const updated = new Map(prev);
          const rs = updated.get(page);
          if (rs) {
            updated.set(page, rs.map((r) =>
              r.id === regionId ? { ...r, text: `❌ 識別失敗: ${e instanceof Error ? e.message : '未知錯誤'}` } : r
            ));
          }
          return updated;
        });
      } finally {
        setIsAnalyzing(false);
      }
    },
    [pageRegions, tablePrompt, model]
  );

  // === 計算當前頁面之前所有頁面的 region 數量（用於跨頁顏色累計）===
  const getGlobalColorOffset = useCallback(
    (page: number): number => {
      let offset = 0;
      const sortedPages = Array.from(pageRegions.keys()).sort((a, b) => a - b);
      for (const p of sortedPages) {
        if (p >= page) break;
        offset += pageRegions.get(p)?.length ?? 0;
      }
      return offset;
    },
    [pageRegions]
  );

  return (
    <div
      className="flex h-screen bg-gray-50 overflow-hidden relative"
      onDragEnter={handlePageDragEnter}
      onDragLeave={handlePageDragLeave}
      onDragOver={handlePageDragOver}
      onDrop={handlePageDrop}
    >
      {/* 全頁面拖放覆蓋層 */}
      {isPageDragging && (
        <div className="absolute inset-0 z-50 bg-blue-500/10 border-4 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-xl shadow-2xl px-8 py-5 flex items-center gap-3">
            <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <span className="text-lg font-medium text-blue-700">放開以上傳 PDF</span>
          </div>
        </div>
      )}

      {/* 左側面板 — 上傳 & Prompt */}
      <div className="h-full flex-shrink-0" style={{ width: leftWidth }}>
        <PdfUploader
          onFileUpload={handleFileUpload}
          prompt={prompt}
          onPromptChange={setPrompt}
          tablePrompt={tablePrompt}
          onTablePromptChange={setTablePrompt}
          model={model}
          onModelChange={setModel}
          batchSize={batchSize}
          onBatchSizeChange={setBatchSize}
          isAnalyzing={isAnalyzing}
          progress={analysisProgress}
          onReanalyze={handleReanalyze}
          onStop={handleStop}
          hasFile={!!pdfFile}
          error={error}
          fileName={pdfFile?.name ?? null}
        />
      </div>

      {/* 左側分界線 */}
      <div
        onMouseDown={handleDividerMouseDown('left')}
        className="w-1.5 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors flex-shrink-0 relative group"
        title="拖動調整左側面板寬度"
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-1 h-1 rounded-full bg-white" />
          <div className="w-1 h-1 rounded-full bg-white" />
          <div className="w-1 h-1 rounded-full bg-white" />
        </div>
      </div>

      {/* 中間面板 — PDF 顯示 + Bounding Boxes（連續頁面） */}
      <PdfViewer
        pdfUrl={pdfUrl}
        numPages={numPages}
        pageRegions={pageRegions}
        hoveredRegionId={hoveredRegionId}
        onHover={setHoveredRegionId}
        onDocumentLoad={handleDocumentLoad}
        onRegionUpdate={handleRegionUpdate}
        onRegionRemove={handleRegionRemove}
        onRegionAdd={handleRegionAdd}
        getGlobalColorOffset={getGlobalColorOffset}
        scrollToRegionKey={scrollTarget}
        onReanalyzePage={handleReanalyzePage}
        onRegionDoubleClick={handleRegionDoubleClick}
      />

      {/* 右側分界線 */}
      <div
        onMouseDown={handleDividerMouseDown('right')}
        className="w-1.5 cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors flex-shrink-0 relative group"
        title="拖動調整右側面板寬度"
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-1 h-1 rounded-full bg-white" />
          <div className="w-1 h-1 rounded-full bg-white" />
          <div className="w-1 h-1 rounded-full bg-white" />
        </div>
      </div>

      {/* 右側面板 — 提取文字 */}
      <div className="h-full flex-shrink-0" style={{ width: rightWidth }}>
        <TextPanel
          pageRegions={pageRegions}
          hoveredRegionId={hoveredRegionId}
          onHover={setHoveredRegionId}
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          onClickRegion={handleClickRegion}
          onRegionRemove={handleRegionRemove}
          onReorderRegions={handleReorderRegions}
        />
      </div>
    </div>
  );
}
