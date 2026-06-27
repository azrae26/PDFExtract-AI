@echo off
rem ============================================================
rem  PDFExtract — 啟用「貼路徑匯入」（雙擊執行一次即可）
rem  抓取本機橋接小程式 → 設定開機自動啟動 → 立即啟動。
rem  執行這一次後，以後（含重開機）在網站貼 PDF 路徑就能直接匯入。
rem  需求：已安裝 Node.js（https://nodejs.org）。
rem ============================================================
chcp 65001 >nul
title PDFExtract — 啟用貼路徑匯入
setlocal
set "TARGET=%LOCALAPPDATA%\PDFExtractBridge"
set "BASE=https://pdfai.up.railway.app/bridge"

echo ============================================================
echo   PDFExtract — 啟用「貼路徑匯入」
echo ------------------------------------------------------------
echo   這支會在你電腦裝一個小幫手（本機橋接），
echo   讓你在網站「貼上 PDF 路徑」就能直接匯入。
echo.
echo   執行這一次後會設定成開機自動啟動，
echo   以後重開機都自動就緒，不必再執行本檔。
echo ============================================================
echo.

if not exist "%TARGET%" mkdir "%TARGET%"

echo [1/3] 下載橋接小程式...
curl.exe -fsS -o "%TARGET%\pdfextract-bridge.mjs" "%BASE%/pdfextract-bridge.mjs"
if errorlevel 1 ( echo     [失敗] 無法下載，請確認可連到 %BASE% & echo. & pause & exit /b 1 )

curl.exe -fsS -o "%TARGET%\install-bridge.ps1" "%BASE%/install-bridge.ps1"
if errorlevel 1 ( echo     [失敗] 無法下載設定腳本 & echo. & pause & exit /b 1 )

curl.exe -fsS -o "%TARGET%\uninstall-bridge.bat" "%BASE%/uninstall-bridge.bat" 2>nul

echo [2/3] 設定開機自動啟動...
echo [3/3] 啟動橋接...
powershell -NoProfile -ExecutionPolicy Bypass -File "%TARGET%\install-bridge.ps1"

echo.
echo 完成後可關閉本視窗，回網站重貼 PDF 路徑即可匯入。
echo.
pause
endlocal
