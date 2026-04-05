/**
 * 功能：左側設定面板（per-file 狀態顯示）
 * 職責：識別文字框 Prompt、識別表格/圖表 Prompt、模型選擇、API 金鑰設定（popover）、
 *       券商忽略末尾頁數設定、券商名映射清單設定、活躍檔案的進度顯示（已完成/分析頁數/總頁數/券商名）、per-file 停止/重新分析按鈕
 * 依賴：react (useState, useRef, useEffect)、types.ts (FileEntry)
 *
 * 注意：PDF 上傳功能已移至全頁面拖放（PDFExtractApp），此面板不再處理檔案上傳
 * 注意：isAnalyzing 語意為活躍檔案是否在跑（activeFile.status === 'processing'），非全域分析狀態
 * 注意：日期/股票代號/券商名候選 chip 按鈕帶 id：`meta-chip-{date|code|broker}-{selected|unselected}-{idx}`，供外部自動化識別
 */

'use client';

import { useState, useRef, useEffect } from 'react';
import { FileEntry, MetadataCandidate } from '@/lib/types';

/** Gemini 模型選項（含 OpenRouter 模型） */
export const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: '高性價比，帶思考能力' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: '最新一代，速度與品質平衡' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', desc: '最強推理能力，旗艦模型' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', desc: '進階推理與代理能力，優化版' },
  { id: 'qwen/qwen3.5-9b', label: 'Qwen3.5-9B (OpenRouter)', desc: '多模態，高性價比 ($0.05/M)' },
] as const;

export const DEFAULT_MODEL = 'gemini-3-flash-preview';

/** 判斷是否為 OpenRouter 模型（model ID 含 "/" 即為 OpenRouter 格式） */
export function isOpenRouterModel(modelId: string): boolean {
  return modelId.includes('/');
}

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
  /** Gemini API 金鑰 */
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  /** OpenRouter API 金鑰（用於 OpenRouter 模型如 Qwen） */
  openRouterApiKey: string;
  onOpenRouterApiKeyChange: (key: string) => void;
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
  /** 日期候選值 */
  dateCandidates: MetadataCandidate[];
  /** 股票代號候選值 */
  codeCandidates: MetadataCandidate[];
  /** 券商候選值 */
  brokerCandidates: MetadataCandidate[];
  /** 已確認日期 */
  selectedDate: string;
  /** 已確認股票代號 */
  selectedCode: string;
  /** 已確認券商 */
  selectedBroker: string;
  /** 點擊候選值後確認該值 */
  onSelectMetadata: (field: 'date' | 'code' | 'broker', value: string) => void;
  /** 手動新增候選值 */
  onAddMetadataCandidate: (field: 'date' | 'code' | 'broker', value: string) => void;
  /** 刪除單一候選值 */
  onRemoveMetadataCandidate: (field: 'date' | 'code' | 'broker', value: string) => void;
  /** 一次清空欄位所有候選值 */
  onClearMetadataCandidates: (field: 'date' | 'code' | 'broker') => void;
  /** 券商 → 忽略末尾頁數映射 */
  brokerSkipMap: Record<string, number>;
  /** 更新券商忽略末尾頁數映射 */
  onBrokerSkipMapChange: (map: Record<string, number>) => void;
  /** 券商映射群組（每筆為逗號分隔清單，第一個值視為 canonical） */
  brokerAliasGroups: string[];
  /** 更新券商映射群組 */
  onBrokerAliasGroupsChange: (groups: string[]) => void;
  /** 活躍檔案的狀態（用於按鈕判斷：processing/queued→停止分析，其餘→重新分析） */
  activeFileStatus?: FileEntry['status'];
  /** 上傳當前設定到伺服器 */
  onUploadSettings: () => void;
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
  apiKey,
  onApiKeyChange,
  openRouterApiKey,
  onOpenRouterApiKeyChange,
  isAnalyzing,
  progress,
  numPages,
  onReanalyze,
  onStop,
  hasFile,
  error,
  fileName,
  report,
  dateCandidates,
  codeCandidates,
  brokerCandidates,
  selectedDate,
  selectedCode,
  selectedBroker,
  onSelectMetadata,
  onAddMetadataCandidate,
  onRemoveMetadataCandidate,
  onClearMetadataCandidates,
  brokerSkipMap,
  onBrokerSkipMapChange,
  brokerAliasGroups,
  onBrokerAliasGroupsChange,
  activeFileStatus,
  onUploadSettings,
}: PdfUploaderProps) {
  // API 金鑰 popover 狀態
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(apiKey);
  const apiKeyBtnRef = useRef<HTMLButtonElement>(null);
  const apiKeyPopoverElRef = useRef<HTMLDivElement>(null);
  // popover fixed 定位座標（避免被父層 overflow 截斷）
  const [apiKeyPos, setApiKeyPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // OpenRouter API 金鑰 popover 狀態
  const [orKeyOpen, setOrKeyOpen] = useState(false);
  const [orKeyInput, setOrKeyInput] = useState(openRouterApiKey);
  const orKeyBtnRef = useRef<HTMLButtonElement>(null);
  const orKeyPopoverElRef = useRef<HTMLDivElement>(null);
  const [orKeyPos, setOrKeyPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  // 券商 combobox 狀態
  const [brokerInput, setBrokerInput] = useState('');
  const [brokerDropdownOpen, setBrokerDropdownOpen] = useState(false);
  const brokerDropdownRef = useRef<HTMLDivElement>(null);
  // 券商映射 combobox 狀態
  const [aliasGroupInput, setAliasGroupInput] = useState('');
  const [aliasDropdownOpen, setAliasDropdownOpen] = useState(false);
  const aliasDropdownRef = useRef<HTMLDivElement>(null);

  const brokerNames = Object.keys(brokerSkipMap);
  const [newBrokerSkip, setNewBrokerSkip] = useState(4);
  const [dateInput, setDateInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [metaBrokerInput, setMetaBrokerInput] = useState('');
  // 是否為已存在的券商
  const isExistingBroker = brokerInput.trim() !== '' && brokerSkipMap[brokerInput.trim()] !== undefined;
  // 是否為可新增的新券商（有名字但不存在）
  const isNewBroker = brokerInput.trim() !== '' && !isExistingBroker;
  // 顯示的頁數值：已存在 → map 中的值，新增 → local state
  const displaySkip = isExistingBroker ? brokerSkipMap[brokerInput.trim()] : newBrokerSkip;
  const normalizedAliasInput = aliasGroupInput.trim();
  const isExistingAliasGroup = normalizedAliasInput !== '' && brokerAliasGroups.includes(normalizedAliasInput);
  const isNewAliasGroup = normalizedAliasInput !== '' && !isExistingAliasGroup;

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

  /** 選擇券商映射群組 */
  const handleSelectAliasGroup = (group: string) => {
    setAliasGroupInput(group);
    setAliasDropdownOpen(false);
  };

  /** 新增券商映射群組 */
  const handleAddAliasGroup = () => {
    const value = aliasGroupInput.trim();
    if (!value || isExistingAliasGroup) return;
    onBrokerAliasGroupsChange([...brokerAliasGroups, value]);
  };

  /** 刪除目前選中的券商映射群組 */
  const handleDeleteAliasGroup = () => {
    const value = aliasGroupInput.trim();
    if (!value || !isExistingAliasGroup) return;
    onBrokerAliasGroupsChange(brokerAliasGroups.filter((g) => g !== value));
    setAliasGroupInput('');
  };

  // 當 AI 分析出券商名時，自動選到該券商
  useEffect(() => {
    if (report) {
      setBrokerInput(report);
    }
  }, [report]);

  // 同步外部 apiKey / openRouterApiKey 變化到 local input
  useEffect(() => { setApiKeyInput(apiKey); }, [apiKey]);
  useEffect(() => { setOrKeyInput(openRouterApiKey); }, [openRouterApiKey]);

  // 點擊外部關閉下拉 / API 金鑰 popover
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (brokerDropdownRef.current && !brokerDropdownRef.current.contains(e.target as Node)) {
        setBrokerDropdownOpen(false);
      }
      if (aliasDropdownRef.current && !aliasDropdownRef.current.contains(e.target as Node)) {
        setAliasDropdownOpen(false);
      }
      // API 金鑰 popover：點擊按鈕或 popover 以外的區域才關閉
      const target = e.target as Node;
      const inBtn = apiKeyBtnRef.current?.contains(target);
      const inPopover = apiKeyPopoverElRef.current?.contains(target);
      if (!inBtn && !inPopover) {
        setApiKeyOpen(false);
      }
      // OpenRouter 金鑰 popover
      const inOrBtn = orKeyBtnRef.current?.contains(target);
      const inOrPopover = orKeyPopoverElRef.current?.contains(target);
      if (!inOrBtn && !inOrPopover) {
        setOrKeyOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const normalizeValue = (value: string) => value.trim();

  const handleMetaInputSubmit = (
    field: 'date' | 'code' | 'broker',
    inputValue: string,
    setInput: (value: string) => void,
  ) => {
    const value = normalizeValue(inputValue);
    if (!value) return;
    onAddMetadataCandidate(field, value);
    setInput('');
  };

  const renderMetaField = (
    field: 'date' | 'code' | 'broker',
    label: string,
    candidates: MetadataCandidate[],
    selected: string,
    inputValue: string,
    setInput: (value: string) => void,
  ) => {
    const selectedNorm = normalizeValue(selected).toLowerCase();
    const hasAny = candidates.length > 0 || normalizeValue(inputValue) !== '';

    const contentLen = candidates.reduce((sum, c) => sum + c.value.length, 0) + label.length;
    const grow = Math.max(1, contentLen);
    const chipsTotalW = candidates.reduce((sum, c) => sum + c.value.length * 6 + 20, 0);
    const minW = Math.max(52, chipsTotalW + 24);

    const inputId = `meta-input-${field}`;

    return (
      <div style={{ flex: `${grow} 1 auto`, minWidth: `${minW}px` }}>
        <span className="text-[11px] leading-4 font-medium text-gray-500 mb-1 block">{label}</span>
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div
          className="flex items-center gap-1 border border-gray-300 rounded-lg bg-white px-2 py-1.5 min-h-[34px] cursor-text focus-within:ring-1 focus-within:ring-inset focus-within:ring-indigo-500"
          onClick={() => document.getElementById(inputId)?.focus()}
        >
          <div className="flex flex-wrap items-center gap-0 flex-1 min-w-0 min-h-[24px]">
            <div className="flex flex-wrap items-center gap-1 pr-1">
              {candidates.map((candidate, idx) => {
                const candidateNorm = normalizeValue(candidate.value).toLowerCase();
                const isSelected = !!candidateNorm && candidateNorm === selectedNorm;
                const sourceStyles = candidate.source === 'filename'
                  ? { unselected: 'bg-indigo-50 border-indigo-500 hover:bg-indigo-100 text-indigo-700', selected: 'bg-indigo-500 text-white border border-indigo-500' }
                  : candidate.source === 'ai'
                    ? { unselected: 'bg-[#1EAE98]/10 border-[#1EAE98] hover:bg-[#1EAE98]/20 text-[#0D7A6B]', selected: 'bg-[#1EAE98] text-white border border-[#1EAE98]' }
                    : { unselected: 'bg-[#ed4242]/10 border-[#ed4242] hover:bg-[#ed4242]/20 text-[#b82e2e]', selected: 'bg-[#ed4242] text-white border border-[#ed4242]' };
                return (
                  <button
                    key={`${candidate.value}-${candidate.source}-${idx}`}
                    id={`meta-chip-${field}-${isSelected ? 'selected' : 'unselected'}-${idx}`}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onSelectMetadata(field, candidate.value); }}
                    className={`inline-flex items-center px-1.5 py-[2px] text-[12px] rounded-md transition-colors cursor-pointer whitespace-nowrap flex-shrink-0 ${
                      isSelected
                        ? sourceStyles.selected
                        : `border ${sourceStyles.unselected}`
                    }`}
                  >
                    <span>{candidate.value}</span>
                  </button>
                );
              })}
            </div>
            <input
              id={inputId}
              type="text"
              aria-label={label}
              value={inputValue}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleMetaInputSubmit(field, inputValue, setInput);
                }
              }}
              placeholder=""
              className="w-4 flex-shrink-0 text-[12px] leading-5 bg-transparent outline-none border-none p-0 focus:ring-0 focus:outline-none"
              style={{ width: inputValue ? `${Math.max(12, inputValue.length * 8 + 4)}px` : '12px' }}
            />
          </div>
          {hasAny && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setInput('');
                onClearMetadataCandidates(field);
              }}
              className="flex-shrink-0 text-gray-400 hover:text-red-500 text-[12px] leading-none px-0.5 cursor-pointer"
              title="清空此欄全部值"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-full h-full flex flex-col border-r border-gray-200 bg-white overflow-hidden">
      {/* 標題 */}
      <div className="px-4 h-11 border-b border-gray-200 bg-gray-50 flex items-center flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-700">設定</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
        {/* 狀態區（最上方）：有檔案時顯示檔名，分析中額外顯示進度統計 */}
        {hasFile && (
          <div className="space-y-2">
            {/* 檔名（多行換行，長檔名完整顯示） */}
            <div className="flex items-start gap-2">
              {isAnalyzing ? (
                <div className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full flex-shrink-0 mt-0.5" />
              ) : (
                <svg className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              )}
              <span className={`text-[14px] font-bold break-words min-w-0 flex-1 ${isAnalyzing ? 'text-blue-600' : 'text-gray-700'}`}>
                {fileName || ''}
              </span>
            </div>
            {/* 進度統計：已完成頁數/總頁數 / 券商名（始終顯示） */}
            <div className="flex gap-1 text-center">
              <div className="rounded-md bg-green-50 py-1.5 px-2" style={{ flex: '1 1 auto' }}>
                <div className="text-lg font-extrabold text-green-600">
                  {progress.current}<span className="mx-0.5">/</span>{progress.total}
                </div>
                <div className="text-[9px] text-green-600">已完成</div>
              </div>
              <div className="rounded-md bg-blue-50 py-1.5 px-2" style={{ flex: '1 1 auto' }}>
                <div className="text-lg font-extrabold text-blue-600">{numPages}</div>
                <div className="text-[9px] text-blue-500">總頁數</div>
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

        {/* 停止分析 / 重新分析 按鈕（per-file：processing/queued→停止，其餘→重新分析） */}
        {hasFile && (() => {
          const isFileRunning = activeFileStatus === 'processing' || activeFileStatus === 'queued';
          return (
            <button
              onClick={isFileRunning ? onStop : onReanalyze}
              className={`w-full py-2 px-4 mb-[16px] text-[14px] leading-5 font-medium rounded-lg transition-colors cursor-pointer ${
                isFileRunning
                  ? 'bg-red-600 text-white hover:bg-red-700 active:bg-red-800'
                  : 'border border-blue-500 text-blue-600 bg-white hover:bg-blue-50 active:bg-blue-100'
              }`}
            >
              {isFileRunning ? '停止分析' : '重新分析'}
            </button>
          );
        })()}

        {hasFile && (
          <div className="flex flex-wrap gap-1.5 items-start mb-2">
            {renderMetaField('date', '日期', dateCandidates, selectedDate, dateInput, setDateInput)}
            {renderMetaField('code', '股票代號', codeCandidates, selectedCode, codeInput, setCodeInput)}
            {renderMetaField('broker', '券商名', brokerCandidates, selectedBroker, metaBrokerInput, setMetaBrokerInput)}
          </div>
        )}

        {/* 錯誤訊息 */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-[14px] leading-5 text-red-700">{error}</p>
          </div>
        )}

        {/* 模型選擇 + 金鑰 + 同時分析頁數（同一行） */}
        <div className="flex gap-1.5 items-end" ref={aliasDropdownRef}>
          <div className="flex-1 min-w-0 relative">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">券商名映射</label>
            <div className={`flex rounded-lg ring-1 ring-transparent transition-shadow ${aliasDropdownOpen ? 'ring-indigo-500' : ''} focus-within:ring-indigo-500`}>
              <input
                type="text"
                value={aliasGroupInput}
                onChange={(e) => {
                  setAliasGroupInput(e.target.value);
                  setAliasDropdownOpen(true);
                }}
                onFocus={() => setAliasDropdownOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && aliasGroupInput.trim()) {
                    if (isNewAliasGroup) handleAddAliasGroup();
                    setAliasDropdownOpen(false);
                  }
                }}
                placeholder="輸入映射清單（例：凱基, 凱基(法說memo), KGI）"
                className="flex-1 min-w-0 px-2.5 py-1.5 text-[13px] leading-5 border border-gray-300 rounded-l-lg bg-white text-gray-800 focus:outline-none focus:ring-0 focus:border-transparent"
              />
              <button
                type="button"
                onClick={() => setAliasDropdownOpen((p) => !p)}
                className="px-1.5 border border-l-0 border-gray-300 rounded-r-lg bg-gray-50 text-gray-500 hover:bg-gray-100 cursor-pointer flex items-center"
              >
                <svg className={`w-3.5 h-3.5 transition-transform ${aliasDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>
            </div>
            {aliasDropdownOpen && brokerAliasGroups.length > 0 && (
              <div className="absolute z-50 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-gray-300 rounded-lg shadow-lg">
                {brokerAliasGroups.map((group) => (
                  <button
                    key={group}
                    type="button"
                    onClick={() => handleSelectAliasGroup(group)}
                    className={`w-full text-left px-3 py-1.5 text-[13px] leading-5 hover:bg-indigo-50 cursor-pointer ${
                      group === aliasGroupInput ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-700'
                    }`}
                    title={group}
                  >
                    <span className="block truncate">{group}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {isNewAliasGroup ? (
            <button
              type="button"
              onClick={handleAddAliasGroup}
              className="w-8 h-[34px] flex items-center justify-center text-blue-500 hover:text-blue-700 hover:bg-blue-50 border border-gray-300 rounded-lg transition-colors cursor-pointer flex-shrink-0"
              title="新增此映射清單"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDeleteAliasGroup}
              disabled={!isExistingAliasGroup}
              className="w-8 h-[34px] flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 border border-gray-300 rounded-lg transition-colors cursor-pointer disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed flex-shrink-0"
              title="刪除此映射清單"
            >
              ✕
            </button>
          )}
        </div>

        {/* 模型選擇 + 金鑰 + 同時分析頁數（同一行） */}
        <div className="flex gap-2 items-end">
          <div className="flex-1 min-w-0">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">模型</label>
            <div className="relative">
              <select
                value={model}
                onChange={(e) => onModelChange(e.target.value)}
                className="w-full appearance-none pl-2.5 pr-7 py-1.5 text-[13px] leading-5 border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent cursor-pointer"
              >
                {GEMINI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
              <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </div>
          </div>
          {/* Gemini API 金鑰按鈕（僅非 OpenRouter 模型顯示） */}
          {!isOpenRouterModel(model) && (
            <div className="flex-shrink-0">
              <button
                ref={apiKeyBtnRef}
                type="button"
                onClick={() => {
                  if (!apiKeyOpen && apiKeyBtnRef.current) {
                    const rect = apiKeyBtnRef.current.getBoundingClientRect();
                    setApiKeyPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setApiKeyOpen((p) => !p);
                }}
                className={`w-[34px] h-[34px] flex items-center justify-center border rounded-lg transition-colors cursor-pointer ${
                  apiKey
                    ? 'border-green-300 bg-green-50 text-green-600 hover:bg-green-100'
                    : 'border-red-300 bg-red-50 text-red-500 hover:bg-red-100'
                }`}
                title={apiKey ? 'Gemini API 金鑰已設定' : '請設定 Gemini API 金鑰'}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ transform: 'scaleX(-1)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                </svg>
              </button>
            </div>
          )}
          {/* OpenRouter API 金鑰按鈕（僅 OpenRouter 模型顯示） */}
          {isOpenRouterModel(model) && (
            <div className="flex-shrink-0">
              <button
                ref={orKeyBtnRef}
                type="button"
                onClick={() => {
                  if (!orKeyOpen && orKeyBtnRef.current) {
                    const rect = orKeyBtnRef.current.getBoundingClientRect();
                    setOrKeyPos({ top: rect.bottom + 4, left: rect.left });
                  }
                  setOrKeyOpen((p) => !p);
                }}
                className={`w-[34px] h-[34px] flex items-center justify-center border rounded-lg transition-colors cursor-pointer ${
                  openRouterApiKey
                    ? 'border-green-300 bg-green-50 text-green-600 hover:bg-green-100'
                    : 'border-red-300 bg-red-50 text-red-500 hover:bg-red-100'
                }`}
                title={openRouterApiKey ? 'OpenRouter API 金鑰已設定' : '請設定 OpenRouter API 金鑰'}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ transform: 'scaleX(-1)' }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* API 金鑰未設定提示（依目前選擇的模型顯示對應提示） */}
        {isOpenRouterModel(model) ? (
          !openRouterApiKey && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-[13px] leading-5 text-amber-700">
                請先點擊上方 🔑 按鈕設定 OpenRouter API Key
              </p>
            </div>
          )
        ) : (
          !apiKey && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-center gap-2">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <p className="text-[13px] leading-5 text-amber-700">
                請先點擊下方 <span className="font-medium">🔑 金鑰按鈕</span> 設定 Gemini API Key
              </p>
            </div>
          )
        )}

        {/* 並行分析數 + 忽略末尾頁數 */}
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block whitespace-nowrap">並行分析數</label>
            <input
              type="number"
              min={1}
              max={50}
              value={batchSize}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) onBatchSizeChange(Math.min(v, 50));
              }}
              className="w-full px-2.5 py-1.5 text-[13px] leading-5 border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
          <div className="flex-1">
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
              className="w-full px-2.5 py-1.5 text-[13px] leading-5 border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* 券商忽略末尾頁數設定：combobox + 頁數 + 刪除 */}
        <div className="flex gap-1.5 items-end" ref={brokerDropdownRef}>
          {/* 券商名 combobox */}
          <div className="flex-1 min-w-0 relative">
            <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">券商忽略末尾頁數</label>
            <div
              className={`flex rounded-lg ring-1 ring-transparent transition-shadow ${
                brokerDropdownOpen ? 'ring-indigo-500' : ''
              } focus-within:ring-indigo-500`}
            >
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
                className="flex-1 min-w-0 px-2.5 py-1.5 text-[13px] leading-5 border border-gray-300 rounded-l-lg bg-white text-gray-800 focus:outline-none focus:ring-0 focus:border-transparent"
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
              className="w-full px-2.5 py-1.5 text-[13px] leading-5 border border-gray-300 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent disabled:bg-gray-100 disabled:text-gray-400"
            />
          </div>
          {/* 新增(+) / 刪除(✕) 按鈕 — 依券商是否已存在切換 */}
          {isNewBroker ? (
            <button
              type="button"
              onClick={handleAddBroker}
              className="w-8 h-[34px] flex items-center justify-center text-blue-500 hover:text-blue-700 hover:bg-blue-50 border border-gray-300 rounded-lg transition-colors cursor-pointer flex-shrink-0"
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
              className="w-8 h-[34px] flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 border border-gray-300 rounded-lg transition-colors cursor-pointer disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed flex-shrink-0"
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
            className="w-full h-[330px] p-2.5 py-2 text-[13px] border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent bg-gray-50 text-gray-800 leading-relaxed"
            placeholder="輸入分析指令..."
          />
        </div>

        {/* 識別表格/圖表 Prompt（雙擊框時使用） */}
        <div>
          <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">識別表格/圖表 Prompt</label>
          <textarea
            value={tablePrompt}
            onChange={(e) => onTablePromptChange(e.target.value)}
            className="w-full h-[9rem] p-2.5 py-2 text-[13px] border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent bg-gray-50 text-gray-800 leading-relaxed"
            placeholder="雙擊框框時，截圖該區域送 AI 所用的 Prompt..."
          />
        </div>

        {/* 上傳設定到伺服器 */}
        <button
          type="button"
          onClick={onUploadSettings}
          className="w-full py-2 text-[13px] font-medium text-white bg-indigo-500 rounded-lg hover:bg-indigo-600 cursor-pointer transition-colors"
        >
          上傳設定到伺服器
        </button>
      </div>

      {/* Gemini API 金鑰 popover（fixed 定位，避免被父層 overflow 截斷） */}
      {apiKeyOpen && (
        <div
          className="fixed z-[9999] w-72 bg-white border border-gray-300 rounded-lg shadow-lg p-3"
          style={{ top: apiKeyPos.top, left: apiKeyPos.left }}
          ref={apiKeyPopoverElRef}
        >
          <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">Gemini API 金鑰</label>
          <div className="flex gap-1.5">
            <input
              type="password"
              autoComplete="one-time-code"
              data-form-type="other"
              data-1p-ignore
              data-lpignore="true"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onApiKeyChange(apiKeyInput.trim());
                  setApiKeyOpen(false);
                }
              }}
              placeholder="輸入 Gemini API Key"
              className="flex-1 min-w-0 px-2.5 py-1.5 text-[13px] border border-gray-300 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent"
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                onApiKeyChange(apiKeyInput.trim());
                setApiKeyOpen(false);
              }}
              className="px-2.5 py-1.5 text-[13px] font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 cursor-pointer flex-shrink-0"
            >
              儲存
            </button>
          </div>
          {apiKey && (
            <button
              type="button"
              onClick={() => {
                onApiKeyChange('');
                setApiKeyInput('');
                setApiKeyOpen(false);
              }}
              className="mt-2 text-[11px] text-red-500 hover:text-red-700 cursor-pointer"
            >
              清除金鑰
            </button>
          )}
        </div>
      )}

      {/* OpenRouter API 金鑰 popover（fixed 定位，避免被父層 overflow 截斷） */}
      {orKeyOpen && (
        <div
          className="fixed z-[9999] w-80 bg-white border border-gray-300 rounded-lg shadow-lg p-3"
          style={{ top: orKeyPos.top, left: orKeyPos.left }}
          ref={orKeyPopoverElRef}
        >
          <label className="text-[11px] leading-4 font-medium text-gray-500 mb-1.5 block">OpenRouter API 金鑰</label>
          <p className="text-[11px] text-gray-400 mb-1.5">
            至 <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-indigo-500 underline">openrouter.ai/keys</a> 建立金鑰（格式：sk-or-v1-...）
          </p>
          <div className="flex gap-1.5">
            <input
              type="password"
              autoComplete="one-time-code"
              data-form-type="other"
              data-1p-ignore
              data-lpignore="true"
              value={orKeyInput}
              onChange={(e) => setOrKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onOpenRouterApiKeyChange(orKeyInput.trim());
                  setOrKeyOpen(false);
                }
              }}
              placeholder="sk-or-v1-..."
              className="flex-1 min-w-0 px-2.5 py-1.5 text-[13px] border border-gray-300 rounded-lg bg-white text-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-transparent"
              autoFocus
            />
            <button
              type="button"
              onClick={() => {
                onOpenRouterApiKeyChange(orKeyInput.trim());
                setOrKeyOpen(false);
              }}
              className="px-2.5 py-1.5 text-[13px] font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 cursor-pointer flex-shrink-0"
            >
              儲存
            </button>
          </div>
          {openRouterApiKey && (
            <button
              type="button"
              onClick={() => {
                onOpenRouterApiKeyChange('');
                setOrKeyInput('');
                setOrKeyOpen(false);
              }}
              className="mt-2 text-[11px] text-red-500 hover:text-red-700 cursor-pointer"
            >
              清除金鑰
            </button>
          )}
        </div>
      )}
    </div>
  );
}
