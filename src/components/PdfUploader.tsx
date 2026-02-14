/**
 * 功能：左側設定面板
 * 職責：識別文字框 Prompt、識別表格/圖表 Prompt、模型選擇、分析進度顯示、重新分析按鈕
 * 依賴：無外部套件
 *
 * 注意：PDF 上傳功能已移至全頁面拖放（PDFExtractApp），此面板不再處理檔案上傳
 */

'use client';

/** Gemini 模型選項 */
export const GEMINI_MODELS = [
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', desc: '快速輕量（2026/3 停用）' },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite', desc: '最便宜最快（2026/3 停用）' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: '高性價比，帶思考能力' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', desc: '最新一代，速度與品質平衡' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro', desc: '最強推理能力，旗艦模型' },
] as const;

export const DEFAULT_MODEL = 'gemini-3-pro-preview';

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
  onReanalyze: () => void;
  onStop: () => void;
  hasFile: boolean;
  error: string | null;
  fileName: string | null;
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
  onReanalyze,
  onStop,
  hasFile,
  error,
  fileName,
}: PdfUploaderProps) {
  return (
    <div className="w-full h-full flex flex-col border-r border-gray-200 bg-white overflow-hidden">
      {/* 標題 */}
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-700">設定</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 模型選擇 + 同時分析頁數（同一行） */}
        <div className="flex gap-2 items-end">
          <div className="flex-1 min-w-0">
            <label className="text-xs font-medium text-gray-500 mb-1.5 block">模型</label>
            <select
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent cursor-pointer"
            >
              {GEMINI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
          <div className="w-20 flex-shrink-0">
            <label className="text-xs font-medium text-gray-500 mb-1.5 block whitespace-nowrap">並行分析頁數</label>
            <input
              type="number"
              min={1}
              max={50}
              value={batchSize}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) onBatchSizeChange(Math.min(v, 50));
              }}
              className="w-full px-2 py-2 text-sm text-center border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div className="w-20 flex-shrink-0">
            <label className="text-xs font-medium text-gray-500 mb-1.5 block whitespace-nowrap">忽略末尾頁數</label>
            <input
              type="number"
              min={0}
              max={999}
              value={skipLastPages}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 0) onSkipLastPagesChange(v);
              }}
              className="w-full px-2 py-2 text-sm text-center border border-gray-300 rounded-lg bg-gray-50 text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* 識別文字框 Prompt */}
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1.5 block">識別文字框 Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => onPromptChange(e.target.value)}
            className="w-full h-[32rem] p-3 text-sm border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 text-gray-800 leading-relaxed"
            placeholder="輸入分析指令..."
          />
        </div>

        {/* 識別表格/圖表 Prompt（雙擊框時使用） */}
        <div>
          <label className="text-xs font-medium text-gray-500 mb-1.5 block">識別表格/圖表 Prompt</label>
          <textarea
            value={tablePrompt}
            onChange={(e) => onTablePromptChange(e.target.value)}
            className="w-full h-[9rem] p-3 text-sm border border-gray-300 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-gray-50 text-gray-800 leading-relaxed"
            placeholder="雙擊框框時，截圖該區域送 AI 所用的 Prompt..."
          />
        </div>

        {/* 重新分析按鈕（分析中也保持顯示但禁用） */}
        {hasFile && (
          <button
            onClick={onReanalyze}
            disabled={isAnalyzing}
            className={`w-full py-2 px-4 text-sm font-medium rounded-lg transition-colors ${
              isAnalyzing
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 cursor-pointer'
            }`}
          >
            {isAnalyzing ? '分析中...' : '重新分析'}
          </button>
        )}

        {/* 分析進度（在按鈕下方） */}
        {isAnalyzing && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <div className="animate-spin w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full flex-shrink-0" />
              <span className="text-sm text-blue-600 truncate min-w-0">
                {fileName || ''}
              </span>
              <span className="text-sm text-blue-600 flex-shrink-0 whitespace-nowrap">
                {progress.current}/{progress.total} 頁
              </span>
              <button
                onClick={onStop}
                className="flex-shrink-0 px-2.5 py-0.5 text-xs font-medium bg-red-50 text-red-600 border border-red-200 rounded hover:bg-red-100 active:bg-red-200 transition-colors cursor-pointer"
              >
                停止
              </button>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-1.5">
              <div
                className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%',
                }}
              />
            </div>
          </div>
        )}

        {/* 錯誤訊息 */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
