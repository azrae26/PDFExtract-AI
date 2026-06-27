@echo off
rem ============================================================
rem  PDFExtract 本機橋接啟動器（雙擊即可，手動啟動用）
rem  意圖：遠端站「貼路徑」需本機跑著服務代理讀檔，這支讓你一鍵開。
rem  用法：雙擊本檔 → 視窗保持開著 → 到遠端站貼 PDF 路徑即可匯入。
rem        關閉此視窗 = 停止橋接。
rem  想開機自動啟動、免每次手動開 → 改用 install-bridge.bat（設定一次即可）。
rem ============================================================
chcp 65001 >nul
title PDFExtract 本機橋接 (localhost:38217)
cd /d "%~dp0"

echo ============================================
echo   PDFExtract 本機橋接啟動中 (localhost:38217)
echo   視窗請勿關閉 —— 關閉即停止橋接
echo   之後在遠端站貼上 PDF 路徑即可匯入
echo ============================================
echo.

node "%~dp0public\bridge\pdfextract-bridge.mjs"

echo.
echo [橋接已停止] 按任意鍵關閉視窗...
pause >nul
