# PDFExtract AI — PDF 智能文本提取

上傳 PDF 檔案，透過 Gemini AI 自動辨識頁面中的分析文本區域，在 PDF 上畫出可拖動、可調整大小的 bounding boxes，並將提取的文字整理顯示。

## 功能特色

- **拖拉上傳**：將 PDF 拖入右側上傳區，自動開始分析
- **PDF 預覽**：中間面板即時顯示 PDF，支援多頁翻頁
- **AI 標註**：透過 Gemini 2.0 Flash API 辨識分析文本區域，回傳座標與文字
- **可互動框**：bounding boxes 可拖動移動、拖角/拖邊改大小
- **文字提取**：左側面板按頁碼+順序整理所有提取文字，支援一鍵複製
- **Hover 互動**：左側文字與中間框互相連動高亮
- **自訂 Prompt**：右側可編輯 Prompt，修改後按「重新分析」即可重跑

## 技術棧

| 項目 | 技術 |
|------|------|
| 框架 | Next.js 16 (App Router, Turbopack) |
| PDF 顯示 | react-pdf (pdfjs-dist) |
| 可互動框 | react-rnd |
| AI 分析 | Gemini 2.0 Flash (@google/generative-ai) |
| 樣式 | Tailwind CSS 4 |
| 語言 | TypeScript |

## 專案結構

```
src/
  app/
    page.tsx                  — 主頁面（dynamic import，避免 SSR）
    layout.tsx                — 根佈局
    globals.css               — 全域樣式
    api/analyze/route.ts      — Gemini API 端點（Server Side）
  components/
    PDFExtractApp.tsx         — 主應用元件（全域狀態管理、四欄佈局、全域分析 toggle）
    FileListPanel.tsx         — 最左面板：檔案列表、全域分析控制（暫停/繼續/全部重新分析）
    PdfUploader.tsx           — 左面板：設定（per-file 狀態顯示）、Prompt 編輯、per-file 停止/重新分析
    PdfViewer.tsx             — 中間面板：PDF 顯示 + bounding boxes
    BoundingBox.tsx           — 可拖動/可 resize 的標註框
    TextPanel.tsx             — 右側面板：提取文字 + hover 互動
  lib/
    types.ts                  — TypeScript 型別定義
    constants.ts              — 預設 Prompt、顏色配置等常數
    pdfTextExtractCore.ts     — PDF 文字提取純演算法核心（零依賴，前端+debug共用）
```

## 快速開始

### 1. 安裝依賴

```bash
cd pdfextract-ai
npm install
```

### 2. 設定環境變數

編輯 `.env.local`，填入你的 Gemini API Key：

```
GEMINI_API_KEY=你的_GEMINI_API_KEY
```

### 3. 啟動開發伺服器

```bash
npm run dev
```

開啟 http://localhost:3000 即可使用。

## 使用流程

1. （可選）在右側修改 Prompt
2. 將 PDF 檔案拖入右側上傳區
3. 系統自動：顯示 PDF → 逐頁轉圖片 → 送 Gemini API 分析
4. 分析完成後，中間 PDF 上出現彩色標註框，左側顯示提取文字
5. 可拖動/調整框的大小
6. Hover 左側文字可高亮中間對應的框，反之亦然
7. 點擊「複製全部」可複製所有提取文字

## 座標系統

- Gemini API 回傳歸一化座標（0~1000）
- `(0, 0)` = 圖片左上角，`(1000, 1000)` = 圖片右下角
- 系統自動將歸一化座標轉換為 PDF 顯示的像素座標

## Debug 工具

`pdf/debug-pdf.ts` 提供離線 PDF 文字層診斷，用於排查文字提取問題。
直接 import `pdfTextExtractCore.ts` 的共用演算法，確保 debug 和主程式邏輯一致，零重複：

```bash
cd pdfextract-ai/pdf

# 顯示所有文字項 + 自適應閾值分析 + 危險行距
npx tsx debug-pdf.ts items <file> [page]

# 顯示行分組結果（自適應閾值 + Y重疊合併 + 碎片重組）
npx tsx debug-pdf.ts lines <file> [page]

# 模擬完整提取流程：snap → resolve → enforce → descender → 多欄偵測 → 文字
npx tsx debug-pdf.ts extract <file> <page> <x1,y1,x2,y2> [x1,y1,x2,y2 ...]

# 批次掃描目錄下所有 PDF
npx tsx debug-pdf.ts batch [dir] [page]
```

檔名支援 glob 模式（如 `5274*`），解決 PowerShell 中文編碼問題。

## 注意事項

- API Key 不要提交到版本控制（`.env.local` 已在 `.gitignore` 中）
- 大型 PDF（超過 20 頁）分析時間較長，請耐心等待
- PDF 轉圖片使用 2x scale + JPEG 85% 品質，平衡解析度與傳輸量
