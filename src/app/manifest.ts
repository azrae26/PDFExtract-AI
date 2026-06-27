/**
 * 功能：PWA manifest（Next App Router 特殊檔，產生 /manifest.webmanifest 並自動注入 <link rel="manifest">）
 * 意圖：讓使用者可把本站「安裝」成 App —— 安裝後 File System Access 的資料夾授權可跨 session 永久保留，
 *       連每 session 一次的「允許」都免。非必須：不裝也能用（授權時選「每次造訪都允許」即可）。
 */

import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'PDFExtract AI — PDF 智能文本提取',
    short_name: 'PDFExtract AI',
    description: '上傳 PDF，透過 Gemini AI 自動辨識並提取分析文本',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#4f46e5',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
