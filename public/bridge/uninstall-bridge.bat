@echo off
rem 解除 PDFExtract 本機橋接：移除開機自啟 + 結束橋接程式 + 刪除檔案
chcp 65001 >nul
title PDFExtract 本機橋接 解除安裝
set "TARGET=%LOCALAPPDATA%\PDFExtractBridge"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PDFExtractBridge.lnk"

echo 移除開機自啟捷徑...
if exist "%LNK%" del "%LNK%"

echo 結束橋接程式（佔用 38217 埠的 node）...
rem 只結束聽 38217 的那個 node，不動其他 node 程序
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":38217" ^| findstr "LISTENING"') do taskkill /f /pid %%P >nul 2>&1

echo 刪除檔案...
if exist "%TARGET%" rmdir /s /q "%TARGET%"

echo.
echo 已解除。開機不再自動啟動橋接。
pause
