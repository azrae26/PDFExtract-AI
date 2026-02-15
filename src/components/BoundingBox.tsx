/**
 * 功能：可拖動、可調整大小的標註框
 * 職責：在 PDF 頁面上渲染單一 bounding box，支援拖動移動、拖角/拖邊改大小、hover 互動
 * 依賴：react-rnd、types.ts、constants.ts
 */

'use client';

import { useRef } from 'react';
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
}: BoundingBoxProps) {
  const isEmpty = !region.text?.trim();
  const color = isEmpty ? EMPTY_BOX_COLOR : getBoxColor(colorIndex);
  const { x, y, width, height } = normalizedToPixel(region.bbox, displayWidth, displayHeight);

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
      style={{ zIndex: isHovered ? 20 : 10 }}
      enableResizing={{
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
        className="w-full h-full transition-all duration-150 cursor-move group"
        style={{
          border: `2px solid ${color.border}`,
          backgroundColor: isHovered ? color.hoverBg : color.bg,
          borderRadius: '2px',
          boxShadow: isHovered ? `0 0 0 1px ${color.border}, 0 2px 8px rgba(0,0,0,0.15)` : 'none',
        }}
        onMouseEnter={onHover}
        onMouseLeave={onHoverEnd}
        onContextMenu={handleContextMenu}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onDoubleClick();
        }}
      >
        {/* X 刪除按鈕 — 右上角 */}
        <button
          className="absolute -top-2.5 -right-2.5 w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold opacity-0 hover:opacity-100 group-hover:opacity-80 transition-opacity cursor-pointer z-30"
          style={{ backgroundColor: color.border }}
          onMouseDown={(e) => {
            e.stopPropagation(); // 防止觸發 Rnd 的拖動
            onRemove();
          }}
          title="移除此框"
        >
          ✕
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
