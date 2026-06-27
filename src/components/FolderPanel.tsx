/**
 * 功能：本機資料夾匯入面板（最左欄頂部）
 * 職責：連結一個本機資料夾 → 列出其中 PDF → 點檔即匯入並分析。
 * 意圖：遠端網頁也能低摩擦匯入本機檔——一次連結授權，之後開站點一下檔名就匯入（見 useFolderImport）。
 * 依賴：useFolderImport（狀態/權限/清單）
 * 注意：Firefox/Safari 不支援 File System Access API → 整個面板不渲染（回 null），改用拖放/貼上。
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import useFolderImport from '@/hooks/useFolderImport';
import type { FolderPdf } from '@/lib/folderAccess';

// 虛擬化常數：資料夾可能含上萬個 PDF（同步夾長期累積），全量渲染會產生 ~1s 主線程長任務
// 餓死同時進行的 IndexedDB session 還原 → 拖慢整體載入。故只渲可視列。
const ROW_H = 28;        // 單列高（px），須與下方 button 的 height 一致
const VIEWPORT_H = 224;  // 清單可視高（px）= 原 max-h-56
const OVERSCAN = 6;      // 視窗上下各多渲幾列，捲動時不見白邊

interface FolderPanelProps {
  /** 匯入單檔：mode 由呼叫端依是否有金鑰決定（active=開啟並分析、idle=僅加入） */
  onImport: (file: File, mode: 'active' | 'background' | 'idle') => void;
  /** 是否已設金鑰：無金鑰時點檔只加入列表（idle），不啟動分析 */
  hasKey: boolean;
}

export default function FolderPanel({ onImport, hasKey }: FolderPanelProps) {
  const f = useFolderImport();
  if (!f.supported) return null; // 非 Chromium：不顯示，改用拖放/貼上

  const connected = f.folderName !== null;
  const granted = f.permission === 'granted';

  const handlePick = async (fh: FileSystemFileHandle) => {
    const file = await f.openPdf(fh);
    if (file) onImport(file, hasKey ? 'active' : 'idle');
  };

  return (
    <div className="flex flex-col border-b border-gray-200 bg-white flex-shrink-0">
      {/* 標題列 + 連結狀態操作 */}
      <div className="px-3 h-9 flex items-center justify-between gap-1 border-b border-gray-100">
        <div className="flex items-center gap-1.5 min-w-0">
          <svg className="w-4 h-4 text-indigo-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
          </svg>
          <span className="text-sm font-semibold text-gray-500 truncate">
            {connected ? f.folderName : '本機資料夾'}
          </span>
        </div>
        {connected && (
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {granted && (
              <button
                onClick={f.refresh}
                disabled={f.loading}
                className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors cursor-pointer disabled:opacity-40"
                title="重新整理清單"
              >
                <svg className={`w-3.5 h-3.5 ${f.loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
              </button>
            )}
            <button
              onClick={f.forget}
              className="w-6 h-6 flex items-center justify-center rounded text-gray-300 hover:text-red-500 hover:bg-red-50 transition-colors cursor-pointer"
              title="取消連結此資料夾"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* 內容區 */}
      {!connected ? (
        // 尚未連結：一鍵連結 + 一行說明
        <div className="px-3 py-3">
          <button
            onClick={f.connect}
            className="w-full py-1.5 px-3 text-[13px] font-medium rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 active:bg-indigo-700 transition-colors cursor-pointer"
          >
            連結本機資料夾
          </button>
          <p className="mt-1.5 text-[11px] leading-snug text-gray-400">
            選一個放 PDF 的資料夾並授權，之後點檔名即可匯入。
          </p>
        </div>
      ) : !granted ? (
        // 已連結但權限未授予（重開瀏覽器後常見）：一鍵授權
        <div className="px-3 py-3">
          <button
            onClick={f.grant}
            className="w-full py-1.5 px-3 text-[13px] font-medium rounded-lg border border-indigo-500 text-indigo-600 bg-white hover:bg-indigo-50 transition-colors cursor-pointer"
          >
            授權讀取此資料夾
          </button>
          <p className="mt-1.5 text-[11px] leading-snug text-gray-400">
            提示框選「每次造訪都允許」，下次起免再授權。
          </p>
        </div>
      ) : (
        // 已授權：搜尋 + 虛擬化列出 PDF，點擊匯入
        <FolderFileList pdfs={f.pdfs} loading={f.loading} onPick={handlePick} />
      )}

      {f.error && (
        <p className="px-3 py-1.5 text-[11px] text-red-500 border-t border-gray-100">{f.error}</p>
      )}
    </div>
  );
}

/**
 * 資料夾 PDF 清單：搜尋框 + 虛擬化捲動。
 * 意圖：同步夾可能含上萬個 PDF，全量渲染（每筆 button+svg）會炸出 ~1s 主線程長任務，
 *       連帶餓死同時跑的 IndexedDB session 還原 → PDF/內文全卡到 5–7s。改只渲可視列即解。
 * gotcha：button 用絕對定位（top=index*ROW_H），其 height 必須等於 ROW_H，否則捲動位移錯位。
 */
function FolderFileList({
  pdfs,
  loading,
  onPick,
}: {
  pdfs: FolderPdf[];
  loading: boolean;
  onPick: (handle: FileSystemFileHandle) => void;
}) {
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pdfs;
    return pdfs.filter((p) => p.name.toLowerCase().includes(q));
  }, [pdfs, query]);

  // 篩選改變 → 捲回頂端（否則 scrollTop 可能超出新清單高度，視窗算出空白）
  useEffect(() => {
    setScrollTop(0);
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
  }, [query]);

  const total = filtered.length;
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const endIdx = Math.min(total, Math.ceil((scrollTop + VIEWPORT_H) / ROW_H) + OVERSCAN);
  const visible = filtered.slice(startIdx, endIdx);

  return (
    <div className="flex flex-col">
      {/* 搜尋框：上萬筆用滾的找不到，打字即篩 */}
      <div className="px-2 pt-1.5 pb-1">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`搜尋 ${pdfs.length} 個 PDF…`}
          className="w-full px-2 py-1 text-xs rounded border border-gray-200 focus:border-indigo-400 focus:outline-none"
        />
      </div>
      {/* 虛擬化捲動容器：僅渲可視列 */}
      <div
        ref={scrollerRef}
        onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
        className="overflow-y-auto"
        style={{ height: VIEWPORT_H }}
      >
        {total === 0 ? (
          <p className="px-3 py-3 text-[11px] text-center text-gray-400">
            {loading ? '讀取中…' : query ? '無符合的 PDF' : '此資料夾沒有 PDF'}
          </p>
        ) : (
          <div style={{ height: total * ROW_H, position: 'relative' }}>
            {visible.map((p, i) => {
              const idx = startIdx + i;
              return (
                <button
                  key={idx}
                  onClick={() => onPick(p.handle)}
                  title={`匯入 ${p.name}`}
                  className="group/fp absolute left-0 right-0 text-left px-3 flex items-center gap-1.5 text-xs text-gray-700 hover:bg-indigo-50 transition-colors cursor-pointer"
                  style={{ top: idx * ROW_H, height: ROW_H }}
                >
                  <svg className="w-3.5 h-3.5 text-red-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  <span className="truncate flex-1 min-w-0">{p.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
