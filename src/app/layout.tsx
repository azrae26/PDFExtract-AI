/**
 * 功能：PDFExtract AI 根佈局
 * 職責：設定全域字型、metadata、body 樣式
 */

import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'PDFExtract AI — PDF 智能文本提取',
  description: '上傳 PDF，透過 Gemini AI 自動辨識並提取分析文本',
  icons: { icon: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#4f46e5',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-TW">
      <head>
        {/* 預載 pdfjs worker（~280KB）：否則要等 PdfViewer 掛載觸發 getDocument 才開始下載（實測 ~1.3s），
            擋住 PDF 首次渲染。提前到與主 chunk 並行下載，getDocument 時 worker 已就緒。
            路徑須對齊 PDFExtractApp 的 workerSrc 與 copy-pdf-worker.mjs 複製的同源檔。 */}
        <link rel="modulepreload" href="/pdf.worker.min.mjs" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
