@echo off
rem Uninstall PDFExtract local bridge: remove auto-start, stop bridge, delete files.
rem (ASCII only on purpose: Chinese in .bat breaks cmd parsing.)
title PDFExtract bridge - uninstall
set "TARGET=%LOCALAPPDATA%\PDFExtractBridge"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PDFExtractBridge.lnk"

echo Removing auto-start shortcut...
if exist "%LNK%" del "%LNK%"

echo Stopping bridge (node listening on 38217)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":38217" ^| findstr "LISTENING"') do taskkill /f /pid %%P >nul 2>&1

echo Deleting files...
if exist "%TARGET%" rmdir /s /q "%TARGET%"

echo.
echo Done. The bridge will no longer auto-start.
pause
