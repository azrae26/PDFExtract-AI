/**
 * 功能：四欄可拖動分界線 resize 邏輯
 * 職責：管理三條分界線（fileList / left / right）的拖動 resize 狀態與事件處理
 * 依賴：react
 */

import { useState, useCallback, useRef, useEffect } from 'react';

// === 分界線拖動的最小/最大寬度限制 ===
const MIN_PANEL_WIDTH = 120;
const MAX_PANEL_WIDTH = Infinity;
const DEFAULT_FILE_LIST_WIDTH = 280;
const DEFAULT_LEFT_WIDTH = 398;
// 右側文字面板預設 609px
const DEFAULT_RIGHT_WIDTH = 609;

/** localStorage 讀取配置的輔助函式（與 PDFExtractApp 共用同一個 key） */
function loadPanelConfig(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem('pdfextract-ai-config');
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

export interface PanelResizeResult {
  fileListWidth: number;
  leftWidth: number;
  rightWidth: number;
  setFileListWidth: React.Dispatch<React.SetStateAction<number>>;
  setLeftWidth: React.Dispatch<React.SetStateAction<number>>;
  setRightWidth: React.Dispatch<React.SetStateAction<number>>;
  handleDividerMouseDown: (side: 'fileList' | 'left' | 'right') => (e: React.MouseEvent) => void;
}

export default function usePanelResize(): PanelResizeResult {
  const [fileListWidth, setFileListWidth] = useState(() => {
    const cfg = loadPanelConfig();
    return typeof cfg.fileListWidth === 'number' ? cfg.fileListWidth : DEFAULT_FILE_LIST_WIDTH;
  });
  const [leftWidth, setLeftWidth] = useState(() => {
    const cfg = loadPanelConfig();
    return typeof cfg.leftWidth === 'number' ? cfg.leftWidth : DEFAULT_LEFT_WIDTH;
  });
  const [rightWidth, setRightWidth] = useState(() => {
    const cfg = loadPanelConfig();
    if (typeof cfg.rightWidth === 'number') return cfg.rightWidth;
    return DEFAULT_RIGHT_WIDTH;
  });

  const isDraggingPanel = useRef<'fileList' | 'left' | 'right' | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // === 分界線拖動事件處理 ===
  const handlePanelMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingPanel.current) return;
    const delta = e.clientX - dragStartX.current;

    if (isDraggingPanel.current === 'fileList') {
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartWidth.current + delta));
      setFileListWidth(newWidth);
    } else if (isDraggingPanel.current === 'left') {
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, dragStartWidth.current + delta));
      setLeftWidth(newWidth);
    } else {
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
    (side: 'fileList' | 'left' | 'right') => (e: React.MouseEvent) => {
      e.preventDefault();
      isDraggingPanel.current = side;
      dragStartX.current = e.clientX;
      dragStartWidth.current =
        side === 'fileList' ? fileListWidth :
        side === 'left' ? leftWidth : rightWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handlePanelMouseMove);
      document.addEventListener('mouseup', handlePanelMouseUp);
    },
    [fileListWidth, leftWidth, rightWidth, handlePanelMouseMove, handlePanelMouseUp]
  );

  // 清理：元件卸載時移除事件
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handlePanelMouseMove);
      document.removeEventListener('mouseup', handlePanelMouseUp);
    };
  }, [handlePanelMouseMove, handlePanelMouseUp]);

  return {
    fileListWidth, leftWidth, rightWidth,
    setFileListWidth, setLeftWidth, setRightWidth,
    handleDividerMouseDown,
  };
}
