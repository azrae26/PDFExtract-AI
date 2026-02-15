/**
 * 功能：雙擊區域截圖識別 Custom Hook
 * 職責：雙擊 bounding box → 截圖裁切 → 送 AI 識別（表格/圖表），獨立管理識別中狀態
 * 依賴：react、pdfjs、types、analysisHelpers
 *
 * 重要設計：
 * - isRecognizing 與批次分析的 isAnalyzing 分離，由主 hook (useAnalysis) 合併
 * - 使用 analysisHelpers 的純函式（cropRegionToBase64、recognizeRegionWithRetry）
 * - 由呼叫端傳入完整 region 物件 + fileId，不依賴共用 state
 */

import { useState, useCallback } from 'react';
import { pdfjs } from 'react-pdf';
import { Region } from '@/lib/types';
import {
  FileRegionsUpdater,
  cropRegionToBase64,
  recognizeRegionWithRetry,
} from './analysisHelpers';

interface UseRegionRecognizeOptions {
  pdfDocRef: React.MutableRefObject<pdfjs.PDFDocumentProxy | null>;
  /** 直接更新 files 陣列中指定檔案的 pageRegions */
  updateFileRegions: FileRegionsUpdater;
  tablePrompt: string;
  model: string;
}

export default function useRegionRecognize({
  pdfDocRef,
  updateFileRegions,
  tablePrompt,
  model,
}: UseRegionRecognizeOptions) {
  // 獨立的識別中狀態（與批次分析的 isAnalyzing 分離）
  const [isRecognizing, setIsRecognizing] = useState(false);

  // === 雙擊框框 → 截圖該區域 → 送 AI 識別（表格/圖表） ===
  // 由呼叫端傳入完整 region 物件 + fileId，不依賴共用 state
  const handleRegionDoubleClick = useCallback(
    async (page: number, region: Region, targetFileId: string) => {
      const pdfDoc = pdfDocRef.current;
      if (!pdfDoc || !targetFileId) return;
      const regionId = region.id;
      const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
      console.log(`[useRegionRecognize][${ts}] 🖱️ Double-click on page ${page} region ${regionId}, capturing...`);

      setIsRecognizing(true);

      try {
        // 截圖裁切
        const { base64, width, height, sizeKB } = await cropRegionToBase64(pdfDoc, page, region);
        console.log(`[useRegionRecognize][${ts}] 📐 Cropped region: ${width}x${height}px, ${sizeKB} KB`);

        // 標記載入中（先在文字欄顯示「識別中...」）
        updateFileRegions(targetFileId, (prev) => {
          const updated = new Map(prev);
          const rs = updated.get(page);
          if (rs) {
            updated.set(page, rs.map((r) =>
              r.id === regionId ? { ...r, text: '⏳ AI 識別中...', userModified: true } : r
            ));
          }
          return updated;
        });

        // 送 API（含重試）
        const result = await recognizeRegionWithRetry(base64, tablePrompt, model, page, regionId);

        if (result.success && result.text) {
          updateFileRegions(targetFileId, (prev) => {
            const updated = new Map(prev);
            const rs = updated.get(page);
            if (rs) {
              updated.set(page, rs.map((r) =>
                r.id === regionId ? { ...r, text: result.text!, userModified: true } : r
              ));
            }
            return updated;
          });
          const ts2 = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`[useRegionRecognize][${ts2}] ✅ Region ${regionId} recognized: ${result.text.length} chars`);
        } else {
          // 所有重試都失敗
          updateFileRegions(targetFileId, (prev) => {
            const updated = new Map(prev);
            const rs = updated.get(page);
            if (rs) {
              updated.set(page, rs.map((r) =>
                r.id === regionId ? { ...r, text: `❌ 識別失敗: ${result.error}` } : r
              ));
            }
            return updated;
          });
        }
      } catch (e) {
        // document 銷毀的錯誤靜默處理
        if (String(e).includes('sendWithPromise') || (e as { name?: string })?.name === 'RenderingCancelledException') {
          console.log(`[useRegionRecognize][${ts}] ⚠️ Region double-click cancelled (file switched)`);
          return;
        }
        console.error(`[useRegionRecognize][${ts}] ❌ Region double-click error:`, e);
        updateFileRegions(targetFileId, (prev) => {
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
        setIsRecognizing(false);
      }
    },
    [pdfDocRef, tablePrompt, model, updateFileRegions]
  );

  return {
    /** 是否正在進行區域識別 */
    isRecognizing,
    handleRegionDoubleClick,
  };
}
