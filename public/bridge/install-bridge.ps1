# PDFExtract local bridge installer (called by install-bridge.bat via -ExecutionPolicy Bypass)
# Does three things: 1) write a hidden launcher .vbs  2) add a Startup shortcut (auto-start)  3) start now.
# Uninstall: run uninstall-bridge.bat (removes shortcut + folder + running bridge).
# ASCII only on purpose so it parses correctly under any system codepage.
$ErrorActionPreference = 'Stop'

$target = Join-Path $env:LOCALAPPDATA 'PDFExtractBridge'
$mjs = Join-Path $target 'pdfextract-bridge.mjs'

if (-not (Test-Path $mjs)) {
  Write-Host "Bridge program not found at $mjs (download may have failed)." -ForegroundColor Red
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js not found. Install it from https://nodejs.org then run this again." -ForegroundColor Red
  exit 1
}

# 1) Hidden launcher .vbs so the node window never pops up (Run arg 0 = hidden).
#    Build line-by-line to avoid here-string terminator issues; "" = a literal quote in VBScript.
$vbs = Join-Path $target 'run-bridge.vbs'
$vbsLines = @(
  'Set sh = CreateObject("WScript.Shell")'
  ('sh.CurrentDirectory = "{0}"' -f $target)
  ('sh.Run "node ""{0}""", 0, False' -f $mjs)
)
Set-Content -Path $vbs -Value $vbsLines -Encoding Default

# 2) Auto-start: a shortcut in the Startup folder that runs the .vbs via wscript.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PDFExtractBridge.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $target
$sc.WindowStyle = 7
$sc.Description = 'PDFExtract local bridge'
$sc.Save()

# 3) Start now if not already running.
$alive = $false
try {
  Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:38217/health' -TimeoutSec 1 | Out-Null
  $alive = $true
} catch {
  $alive = $false
}
if (-not $alive) {
  Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')
  Start-Sleep -Milliseconds 800
}

Write-Host ''
Write-Host 'Done! Bridge set to auto-start on boot, and started now (127.0.0.1:38217).' -ForegroundColor Green
Write-Host 'Go back to the website and paste a PDF path to import.'
Write-Host ''
Write-Host 'To uninstall: run uninstall-bridge.bat, or delete manually:'
Write-Host "  shortcut: $lnk"
Write-Host "  folder:   $target"
