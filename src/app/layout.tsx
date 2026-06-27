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
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {/* 載入效能量測錨點：盡早記錄導航起點（performance.now 以導航為 0），對照 PdfViewer 的「PDF 內容畫出」日誌 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `console.log('[PERF] ⏱️ T0 app 啟動 @ ' + Math.round(performance.now()) + 'ms（導航起點為 0）');`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
