/**
 * 功能：左側設定面板
 * 職責：識別文字框 Prompt、識別表格/圖表 Prompt、模型選擇、券商忽略末尾頁數設定、分析進度顯示（已完成/分析頁數/總頁數/券商名）、重新分析按鈕
 * 依賴：react (useState)
 *
 * 注意：PDF 上傳功能已移至全頁面拖放（PDFExtractApp），此面板不再處理檔案上傳
 */

'use client';

import { useState, useRef, useEffect } from 'react';

/** Gemini 模型選項 */
export const GEMINI_MODELS = [
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', desc: '快速輕量（2026/3 停用）' },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', desc: '最便宜最快（2026/3 停用）' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: '高性價比，帶思考能力' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: '最新一代，速度與品質平衡' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', desc: '最強推理能力，旗艦模型' },
] as const;

export const DEFAULT_MODEL = 'gemini-3-flash-preview';

interface PdfUploaderProps {
  prompt: string;
  onPromptChange: (prompt: string) => void;
  tablePrompt: string;
  onTablePromptChange: (prompt: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  batchSize: number;
  onBatchSizeChange: (size: number) => void;
  skipLastPages: number;
  onSkipLastPagesChange: (n: number) => void;
  isAnalyzing: boolean;
  progress: { current: number; total: number };
  /** PDF 總頁數 */
  numPages: number;
  onReanalyze: () => void;
  onStop: () => void;
  hasFile: boolean;
  error: string | null;
  fileName: string | null;
  /** 當前檔案的券商名（從 AI 分析結果取得） */
  report: string | null;
  /** 券商 → 忽略末尾頁數映射 */
  brokerSkipMap: Record<string, number>;
  /** 更新券商忽略末尾頁數映射 */
  onBrokerSkipMapChange: (map: Record<string, number>) => void;
}

export default function PdfUploader({
  prompt,
  onPromptChange,
  tablePrompt,
  onTablePromptChange,
  model,
  onModelChange,
  batchSize,
  onBatchSizeChange,
  skipLastPages,
  onSkipLastPagesChange,
  isAnalyzing,
  progress,
  numPages,
  onReanalyze,
  onStop,
  hasFile,
  error,
  fileName,
  report,
  brokerSkipMap,
  onBrokerSkipMapChange,
}: PdfUploaderProps) {
  // 券商 combobox 狀態
  const [brokerInput, setBrokerInput] = useState('');
  const [brokerDropdownOpen, setBrokerDropdownOpen] = useState(false);
  const brokerDropdownRef = useRef<HTMLDivElement>(null);

  const brokerNames = Object.keys(brokerSkipMap);
  const [newBrokerSkip, setNewBrokerSkip] = useState(4);
  // 是否為已存在的券商
  const isExistingBroker = brokerInput.trim() !== '' && brokerSkipMap[brokerInput.trim()] !== undefined;
  // 是否為可新增的新券商（有名字但不存在）
  const isNewBroker = brokerInput.trim() !== '' && !isExistingBroker;
  // 顯示的頁數值：已存在 → map 中的值，新增 → local state
  const displaySkip = isExistingBroker ? brokerSkipMap[brokerInput.trim()] : newBrokerSkip;

  /** 選擇下拉項目 */
  const handleSelectBroker = (name: string) => {
    setBrokerInput(name);
    setBrokerDropdownOpen(false);
  };

  /** 修改頁數（已存在的券商直接更新 map，新券商更新 local state） */
  const handleSkipValueChange = (value: number) => {
    const name = brokerInput.trim();
    if (!name) return;
    if (isExistingBroker) {
      onBrokerSkipMapChange({ ...brokerSkipMap, [name]: value });
    } else {
      setNewBrokerSkip(value);
    }
  };

  /** 新增券商 */
  const handleAddBroker = () => {
    const name = brokerInput.trim();
    if (!name || isExistingBroker) return;
    onBrokerSkipMapChange({ ...brokerSkipMap, [name]: newBrokerSkip });
    setNewBrokerSkip(4);
  };

  /** 刪除目前選中的券商 */
  const handleDeleteBroker = () => {
    const name = brokerInput.trim();
    if (!name || !isExistingBroker) return;
    const next = { ...brokerSkipMap };
    delete next[name];
    onBrokerSkipMapChange(next);
    setBrokerInput('');
  };

  // 當 AI 分析出券商名時，自動選到該券商
  useEffect(() => {
    if (report) {
      setBrokerInput(report);
    }
  }, [report]);

  // 點擊外部關閉下拉
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (brokerDropdownRef.current && !brokerDropdownRef.current.contains(e.target as Node)) {
        setBrokerDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="w-full h-full flex flex-col border-r border-gray-200 bg-white overflow-hidden">
      {/* 標題 */}
      <div className="px-4 h-11 border-b border-gray-200 bg-gray-50 flex items-center flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-700">設定</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {/* 狀態區（最上方）：有檔案時顯示檔名，分析中額外顯示進度統計 */}
        {hasFile && (
          <div className="space-y-2">
            {/* 檔名 */}
            <div className="flex items-center gap-2">
              {isAnalyzing ? (
                <div className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full flex-shrink-0" />
              ) : (
                <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              )}
              <span className={`text-[14px] font-bold truncate min-w-0 ${isAnalyzing ? 'text-blue-600' : 'text-gray-700'}`}>
                {fileName || ''}
              </span>
            </div>
            {/* 進度統計：已完成 / 分析頁數 / 總頁數 / 券商名（始終顯示） */}
            <div className="flex gap-1 text-center">
              <div className="rounded-md bg-green-50 py-1.5 px-2" style={{ flex: '1 1 auto' }}>
                <div className="text-lg font-extrabold text-green-600">{progress.current}</div>
                <div className="text-[9px] text-green-500">已完成</div>
              </div>
              <div className="rounded-md bg-blue-50 py-1.5 px-2" style={{ flex: '1 1 auto' }}>
                <div className="text-lg font-extrabold text-blue-600">{progress.total}</div>
                <div className="text-[9px] text-blue-500">分析頁數</div>
              </div>
              <div className="rounded-md bg-gray-100 py-1.5 px-2" style={{ flex: '1 1 auto' }}>
                <div className="text-lg font-extrabold text-gray-700">{numPages}</div>
                <div className="text-[9px] text-gray-500">總頁數</div>
              </div>
              {report && (
                <div className="rounded-md bg-orange-50 py-1.5 px-2 min-w-0" style={{ flex: '1 1 auto' }}>
                  <div className="text-lg font-extrabold text-orange-600 truncate">{report}</div>
                  <div className="text-[9px] text-orange-500">券商</div>
                </div>
              )}
            </div>
            {/* 進度條（跑完隱藏但佔位） */}
            <div className={`w-full bg-gray-200 rounded-full h-1.5 ${isAnalyzing ? '' : 'invisible'}`}>
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%',
                }}
              />
            </div>
          </div>
        )}

        {/* 重新分析 / 停止分析 按鈕 */}
        {hasFile && (
          <button
            onClick={isAnalyzing ? onStop : onReanalyze}
            className={`w-full py-2 px-4 mb-[16px] text-[14px] leading-5 font-medium rounded-lg transition-colors cursor-pointer ${
              isAnalyzing
                ? 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800'
                : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800'
            }`}
          >
            {isAnalyzing ? '停止分析' : '重新分析'}
          </button>
        )}

        {/* 錯誤訊息 */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-[14px] leading-5 text-red-700">{error}</p>
          </div>
        )}

        {/* 模型選擇 + 同時分析頁數（同一行） */}
        <div className="flex gap-2 items-end">
          <div className="flex-1 min-w-0">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">模型</label>
            <select
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full px-3 py-2 text-[14px] leading-5 border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent cursor-pointer"
            >
              {GEMINI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="w-20 flex-shrink-0">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block whitespace-nowrap">並行分析頁數</label>
            <input
              type="number"
              min={1}
              max={50}
              value={batchSize}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) onBatchSizeChange(Math.min(v, 50));
              }}
              className="w-full px-2 py-2 text-[14px] leading-5 text-center border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="w-20 flex-shrink-0">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block whitespace-nowrap">忽略末尾頁數</label>
            <input
              type="number"
              min={0}
              max={999}
              value={skipLastPages}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0) onSkipLastPagesChange(v);
              }}
              className="w-full px-2 py-2 text-[14px] leading-5 text-center border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* 券商忽略末尾頁數設定：combobox + 頁數 + 刪除 */}
        <div className="flex gap-1.5 items-end" ref={brokerDropdownRef}>
          {/* 券商名 combobox */}
          <div className="flex-1 min-w-0 relative">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">券商忽略末尾頁數</label>
            <div className="flex">
              <input
                type="text"
                value={brokerInput}
                onChange={(e) => {
                  setBrokerInput(e.target.value);
                  setBrokerDropdownOpen(true);
                }}
                onFocus={() => setBrokerDropdownOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && brokerInput.trim()) {
                    if (isNewBroker) handleAddBroker();
                    setBrokerDropdownOpen(false);
                  }
                }}
                placeholder="輸入或選擇券商"
                className="flex-1 min-w-0 px-2.5 py-2 text-[14px] leading-5 border border-gray-300 rounded-l-lg bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setBrokerDropdownOpen((p) => !p)}
                className="px-1.5 border border-l-0 border-gray-300 rounded-r-lg bg-gray-50 text-gray-500 hover:bg-gray-100 cursor-pointer flex items-center"
              >
                <svg className={`w-3.5 h-3.5 transition-transform ${brokerDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
            </div>
            {/* 下拉清單 */}
            {brokerDropdownOpen && brokerNames.length > 0 && (
              <div className="absolute z-50 left-0 right-0 mt-1 max-h-[36rem] overflow-y-auto bg-white border border-gray-300 rounded-lg shadow-lg">
                {brokerNames.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => handleSelectBroker(name)}
                    className={`w-full text-left px-3 py-1.5 text-[14px] leading-5 hover:bg-blue-50 cursor-pointer flex justify-between items-center ${
                      name === brokerInput ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'
                    }`}
                  >
                    <span className="truncate">{name}</span>
                    <span className="text-gray-400 text-[11px] leading-4 ml-2 flex-shrink-0">跳 {brokerSkipMap[name]} 頁</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {/* 忽略頁數 */}
          <div className="w-14 flex-shrink-0">
            <input
              type="number"
              min={0}
              max={999}
              value={brokerInput.trim() ? displaySkip : ''}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0) handleSkipValueChange(v);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && isNewBroker) handleAddBroker(); }}
              disabled={!brokerInput.trim()}
              placeholder="—"
              className="w-full px-2 py-2 text-[14px] leading-5 text-center border border-gray-300 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-400"
            />
          </div>
          {/* 新增(+) / 刪除(✕) 按鈕 — 依券商是否已存在切換 */}
          {isNewBroker ? (
            <button
              type="button"
              onClick={handleAddBroker}
              className="w-8 h-[38px] flex items-center justify-center text-blue-500 hover:text-blue-700 hover:bg-blue-50 border border-gray-300 rounded-lg transition-colors cursor-pointer flex-shrink-0"
              title="新增此券商設定"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDeleteBroker}
              disabled={!isExistingBroker}
              className="w-8 h-[38px] flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 border border-gray-300 rounded-lg transition-colors cursor-pointer disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed flex-shrink-0"
              title="刪除此券商設定"
            >
              ✕
            </button>
          )}
        </div>

        {/* 識別文字框 Prompt */}
        <div>
          <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">識別文字框 Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            className="w-full h-[28rem] p-3 text-[14px] border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 text-gray-800 leading-relaxed"
            placeholder="輸入分析指令..."
          />
        </div>

        {/* 識別表格/圖表 Prompt（雙擊框時使用） */}
        <div>
          <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">識別表格/圖表 Prompt</label>
          <textarea
            value={tablePrompt}
            onChange={(e) => onTablePromptChange(e.target.value)}
            className="w-full h-[9rem] p-3 text-[14px] border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 text-gray-800 leading-relaxed"
            placeholder="雙擊框框時，截圖該區域送 AI 所用的 Prompt..."
          />
        </div>
      </div>
    </div>
  );
}
