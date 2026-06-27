# PDFExtract 本機橋接安裝器（由 install-bridge.bat 以 Bypass 呼叫）
# 做三件事：① 寫隱藏啟動器 vbs ② 在 Startup 建捷徑（開機自啟）③ 立即啟動
# 解除：執行 uninstall-bridge.bat（刪 Startup 捷徑 + LOCALAPPDATA\PDFExtractBridge + 結束橋接）
$ErrorActionPreference = 'Stop'

$target = Join-Path $env:LOCALAPPDATA 'PDFExtractBridge'
$mjs = Join-Path $target 'pdfextract-bridge.mjs'

if (-not (Test-Path $mjs)) {
  Write-Host "找不到橋接程式 $mjs（下載可能失敗）" -ForegroundColor Red
  exit 1
}

# 需要 Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "找不到 Node.js。請先安裝：https://nodejs.org 後再執行本檔。" -ForegroundColor Red
  exit 1
}

# ① 隱藏啟動器 vbs：讓 node 視窗完全不彈出（Run 第二參數 0 = 隱藏）
#    以陣列逐行組字串，避免 here-string 終止符歧義；"" 為 VBScript 內的字面雙引號
$vbs = Join-Path $target 'run-bridge.vbs'
$vbsLines = @(
  'Set sh = CreateObject("WScript.Shell")'
  ('sh.CurrentDirectory = "{0}"' -f $target)
  ('sh.Run "node ""{0}""", 0, False' -f $mjs)
)
Set-Content -Path $vbs -Value $vbsLines -Encoding Default

# ② 開機自啟：Startup 資料夾建捷徑指向 vbs（用 wscript 隱藏執行）
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'PDFExtractBridge.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $target
$sc.WindowStyle = 7
$sc.Description = 'PDFExtract 本機橋接'
$sc.Save()

# ③ 立即啟動（若尚未在跑）
$alive = $false
try {
  Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:38217/health' -TimeoutSec 1 | Out-Null
  $alive = $true
} catch {
  $alive = $false
}
if (-not $alive) {
  Start-Process wscript.exe -ArgumentList ('"' + $vbs + '"')
  Start-Sleep -Milliseconds 800
}

Write-Host ''
Write-Host '已完成！橋接已設定開機自動啟動，且已啟動 (localhost:38217)。' -ForegroundColor Green
Write-Host '回到網站重貼 PDF 路徑即可匯入；以後重開機都會自己啟動。'
Write-Host ''
Write-Host '解除安裝：執行 uninstall-bridge.bat，或手動刪除：'
Write-Host "  捷徑 $lnk"
Write-Host "  資料夾 $target"
