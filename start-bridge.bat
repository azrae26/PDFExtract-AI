@echo off
rem ============================================================
rem  PDFExtract local bridge launcher (double-click to start)
rem  Lets the remote site import local PDFs when you paste a path.
rem  Keep this window OPEN = bridge running. Close it = stop.
rem  For auto-start on boot instead, run install-bridge.bat once.
rem  (ASCII only on purpose: Chinese in .bat breaks cmd parsing.)
rem ============================================================
title PDFExtract Bridge (127.0.0.1:38217)
cd /d "%~dp0"

echo ============================================
echo   PDFExtract local bridge starting...
echo   Listening on http://127.0.0.1:38217
echo   Keep this window OPEN (closing it = stop).
echo   Then paste a PDF path on the website.
echo ============================================
echo.

node "%~dp0public\bridge\pdfextract-bridge.mjs"

echo.
echo [Bridge stopped] Press any key to close...
pause >nul
