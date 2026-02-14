/**
 * 功能：PDFExtract AI 主頁面
 * 職責：以 dynamic import 載入主應用元件（避免 SSR 問題）
 * 依賴：PDFExtractApp 元件
 */

'use client';

import dynamic from 'next/dynamic';

const PDFExtractApp = dynamic(() => import('@/components/PDFExtractApp'), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="text-center space-y-3">
        <div className="animate-spin w-10 h-10 border-3 border-blue-500 border-t-transparent rounded-full mx-auto" />
        <p className="text-gray-500 text-sm">載入中...</p>
      </div>
    </div>
  ),
});

export default function Home() {
  return <PDFExtractApp />;
}
