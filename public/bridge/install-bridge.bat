@echo off
rem ============================================================
rem  PDFExtract - Enable "paste a path" import  (run once)
rem  Installs a tiny local bridge, sets it to auto-start on boot,
rem  and starts it now. After this one run, pasting a PDF path on
rem  the website just works - even after reboot. No need to rerun.
rem  Requires Node.js (https://nodejs.org).
rem  (ASCII only on purpose: Chinese in .bat breaks cmd parsing.)
rem ============================================================
title PDFExtract - Enable paste-path import
setlocal
set "TARGET=%LOCALAPPDATA%\PDFExtractBridge"
set "BASE=https://pdfai.up.railway.app/bridge"

echo ============================================================
echo   PDFExtract - Enable "paste a path" import
echo ------------------------------------------------------------
echo   Installs a small helper (local bridge) so pasting a PDF
echo   path on the website imports it directly.
echo   Runs once now, then auto-starts on every boot.
echo   Requires Node.js (https://nodejs.org).
echo ============================================================
echo.

if not exist "%TARGET%" mkdir "%TARGET%"

echo [1/3] Downloading bridge...
curl.exe -fsS -o "%TARGET%\pdfextract-bridge.mjs" "%BASE%/pdfextract-bridge.mjs"
if errorlevel 1 ( echo     [FAILED] Could not download from %BASE% & echo. & pause & exit /b 1 )

curl.exe -fsS -o "%TARGET%\install-bridge.ps1" "%BASE%/install-bridge.ps1"
if errorlevel 1 ( echo     [FAILED] Could not download setup script & echo. & pause & exit /b 1 )

curl.exe -fsS -o "%TARGET%\uninstall-bridge.bat" "%BASE%/uninstall-bridge.bat" 2>nul

echo [2/3] Configuring auto-start...
echo [3/3] Starting bridge...
powershell -NoProfile -ExecutionPolicy Bypass -File "%TARGET%\install-bridge.ps1"

echo.
echo Done. You can close this window and paste a PDF path on the site.
echo.
pause
endlocal
