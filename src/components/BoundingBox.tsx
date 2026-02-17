/**
 * 功能：可拖動、可調整大小的標註框
 * 職責：在 PDF 頁面上渲染單一 bounding box，支援拖動移動、拖角/拖邊改大小、hover 互動
 * 依賴：react-rnd、types.ts、constants.ts
 */

'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { Rnd } from 'react-rnd';
import { Region } from '@/lib/types';
import { getBoxColor, EMPTY_BOX_COLOR, NORMALIZED_MAX } from '@/lib/constants';

interface BoundingBoxProps {
  region: Region;
  /** 在全域顏色列表中的 index（決定顏色） */
  colorIndex: number;
  /** PDF 頁面顯示寬度（px） */
  displayWidth: number;
  /** PDF 頁面顯示高度（px） */
  displayHeight: number;
  /** 是否處於 hover 狀態 */
  isHovered: boolean;
  /** hover 事件 */
  onHover: () => void;
  onHoverEnd: () => void;
  /** 拖動或 resize 完成後更新 bbox（歸一化座標） */
  onUpdate: (newBbox: [number, number, number, number]) => void;
  /** 刪除此 region */
  onRemove: () => void;
  /** 雙擊此 region（截圖送 AI 識別） */
  onDoubleClick: () => void;
  /** 單擊此 region（觸發右欄滾動） */
  onClick?: () => void;
  /** 是否顯示校正前的 bbox */
  showOriginalBbox?: boolean;
  /** 頁碼（debug 用） */
  pageNumber: number;
}

/** 歸一化座標 → 像素座標 */
function normalizedToPixel(
  bbox: [number, number, number, number],
  displayWidth: number,
  displayHeight: number
) {
  const [x1, y1, x2, y2] = bbox;
  return {
    x: (x1 / NORMALIZED_MAX) * displayWidth,
    y: (y1 / NORMALIZED_MAX) * displayHeight,
    width: ((x2 - x1) / NORMALIZED_MAX) * displayWidth,
    height: ((y2 - y1) / NORMALIZED_MAX) * displayHeight,
  };
}

/** 像素座標 → 歸一化座標 */
function pixelToNormalized(
  x: number,
  y: number,
  width: number,
  height: number,
  displayWidth: number,
  displayHeight: number
): [number, number, number, number] {
  return [
    Math.round((x / displayWidth) * NORMALIZED_MAX),
    Math.round((y / displayHeight) * NORMALIZED_MAX),
    Math.round(((x + width) / displayWidth) * NORMALIZED_MAX),
    Math.round(((y + height) / displayHeight) * NORMALIZED_MAX),
  ];
}

export default function BoundingBox({
  region,
  colorIndex,
  displayWidth,
  displayHeight,
  isHovered,
  onHover,
  onHoverEnd,
  onUpdate,
  onRemove,
  onDoubleClick,
  onClick,
  showOriginalBbox,
  pageNumber,
}: BoundingBoxProps) {
  const isEmpty = !region.text?.trim();
  const color = isEmpty ? EMPTY_BOX_COLOR : getBoxColor(colorIndex);
  // 校正前模式：有 originalBbox 時使用原始座標，否則用當前 bbox
  const useOriginal = showOriginalBbox && region.originalBbox;
  const activeBbox = useOriginal ? region.originalBbox! : region.bbox;
  const { x, y, width, height } = normalizedToPixel(activeBbox, displayWidth, displayHeight);

  // === Hover 延遲：防止滑鼠從框移向按鈕時 z-index 瞬間下降導致按鈕被鄰框遮蓋 ===
  const unhoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleMouseEnter = useCallback(() => {
    if (unhoverTimerRef.current) {
      clearTimeout(unhoverTimerRef.current);
      unhoverTimerRef.current = null;
    }
    onHover();
  }, [onHover]);
  const handleMouseLeave = useCallback(() => {
    unhoverTimerRef.current = setTimeout(() => {
      onHoverEnd();
      unhoverTimerRef.current = null;
    }, 200);
  }, [onHoverEnd]);
  // cleanup on unmount
  useEffect(() => {
    return () => {
      if (unhoverTimerRef.current) clearTimeout(unhoverTimerRef.current);
    };
  }, []);

  // Debug 複製狀態
  const [debugCopied, setDebugCopied] = useState(false);
  const handleCopyDebug = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const [x1, y1, x2, y2] = region.bbox;
    const pixel = normalizedToPixel(region.bbox, displayWidth, displayHeight);
    const debugInfo: Record<string, unknown> = {
      page: pageNumber,
      regionId: region.id,
      label: region.label,
      bbox: region.bbox,
      bboxSize: { w: x2 - x1, h: y2 - y1 },
      pixelBbox: {
        x: Math.round(pixel.x),
        y: Math.round(pixel.y),
        w: Math.round(pixel.width),
        h: Math.round(pixel.height),
      },
      displaySize: { w: displayWidth, h: Math.round(displayHeight) },
    };
    if (region.userModified) {
      debugInfo.userModified = true;
    }
    // 提取流程的完整 debug 資料（各 phase bbox 快照 + hits + 多欄 + 行分組）
    if (region._debug) {
      debugInfo.extractionDebug = region._debug;
    }
    debugInfo.text = region.text || '';
    navigator.clipboard.writeText(JSON.stringify(debugInfo, null, 2)).then(() => {
      setDebugCopied(true);
      setTimeout(() => setDebugCopied(false), 1500);
    });
  }, [region, displayWidth, displayHeight, pageNumber]);

  // === 按鈕定位：一律往右外移；高度足夠時靠上緣，太小時以中線為中心對稱分佈 ===
  const btnPairHeight = 44; // 20px button + 4px gap + 20px button
  const groupTop = height >= btnPairHeight ? 0 : height / 2 - btnPairHeight / 2;
  const xBtnStyle: React.CSSProperties = { top: groupTop, right: -25 };
  const copyBtnStyle: React.CSSProperties = { top: groupTop + 24, right: -25 };

  // 雙擊右鍵刪除
  const lastRightClickRef = useRef(0);
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastRightClickRef.current < 400) {
      onRemove();
      lastRightClickRef.current = 0;
    } else {
      lastRightClickRef.current = now;
    }
  };

  return (
    <Rnd
      position={{ x, y }}
      size={{ width, height }}
      bounds="parent"
      minWidth={15}
      minHeight={15}
      onDragStop={(_e, d) => {
        const newBbox = pixelToNormalized(d.x, d.y, width, height, displayWidth, displayHeight);
        onUpdate(newBbox);
      }}
      onResizeStop={(_e, _direction, ref, _delta, position) => {
        const newWidth = parseFloat(ref.style.width);
        const newHeight = parseFloat(ref.style.height);
        const newBbox = pixelToNormalized(
          position.x,
          position.y,
          newWidth,
          newHeight,
          displayWidth,
          displayHeight
        );
        onUpdate(newBbox);
      }}
      disableDragging={!!useOriginal}
      style={{ zIndex: isHovered ? 50 : 10 }}
      enableResizing={useOriginal ? false : {
        top: true,
        right: true,
        bottom: true,
        left: true,
        topRight: true,
        topLeft: true,
        bottomRight: true,
        bottomLeft: true,
      }}
    >
      <div
        className={`w-full h-full transition-all duration-150 group ${useOriginal ? 'cursor-default' : 'cursor-move'}`}
        style={{
          border: `2px ${useOriginal ? 'dashed' : 'solid'} ${color.border}`,
          backgroundColor: isHovered ? color.hoverBg : color.bg,
          borderRadius: '2px',
          boxShadow: isHovered ? `0 0 0 1px ${color.border}, 0 2px 8px rgba(0,0,0,0.15)` : 'none',
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleClick();
        }}
      >
        {/* 按鈕 hover 延伸區：透明區塊從框右邊緣延伸到按鈕，消除 hover 間隙 */}
        <div
          className="absolute opacity-0 group-hover:opacity-100 transition-opacity z-30"
          style={{ top: groupTop - 2, right: -28, width: 30, height: btnPairHeight + 4 }}
          onMouseEnter={handleMouseEnter}
        />

        {/* X 刪除按鈕 */}
        <button
          className="absolute w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold opacity-0 hover:opacity-100 group-hover:opacity-80 transition-opacity cursor-pointer z-30"
          style={{ ...xBtnStyle, backgroundColor: color.border }}
          onMouseEnter={handleMouseEnter}
          onMouseDown={(e) => {
            e.stopPropagation(); // 防止觸發 Rnd 的拖動
            onRemove();
          }}
          title="移除此框"
        >
          ✕
        </button>

        {/* Debug 複製按鈕 — X 按鈕下方 */}
        <button
          className="absolute w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold opacity-0 hover:opacity-100 group-hover:opacity-60 transition-opacity cursor-pointer z-30"
          style={{ ...copyBtnStyle, backgroundColor: debugCopied ? '#22c55e' : '#6b7280' }}
          onMouseEnter={handleMouseEnter}
          onMouseDown={(e) => {
            e.stopPropagation();
            handleCopyDebug(e);
          }}
          title="複製 debug 參數到剪貼簿"
        >
          {debugCopied ? '✓' : '⎘'}
        </button>

        {/* 四角 resize 手柄提示 */}
        <div
          className="absolute -top-1 -left-1 w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: color.border }}
        />
        <div
          className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: color.border }}
        />
        <div
          className="absolute -bottom-1 -left-1 w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: color.border }}
        />
        <div
          className="absolute -bottom-1 -right-1 w-2.5 h-2.5 rounded-full"
          style={{ backgroundColor: color.border }}
        />
      </div>
    </Rnd>
  );
}
