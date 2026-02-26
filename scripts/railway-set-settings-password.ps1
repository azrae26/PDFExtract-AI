# 功能：透過 Railway CLI 設定 SETTINGS_PASSWORD 環境變數
# 職責：協助部署時一鍵設定上傳密碼
# 依賴：需先安裝 Railway CLI (npm i -g @railway/cli) 並登入 (railway login)
#
# 用法：.\railway-set-settings-password.ps1 -Password "你的密碼"
# 或直接執行後輸入密碼

param(
    [Parameter(Mandatory=$false)]
    [string]$Password
)

if (-not $Password) {
    $secure = Read-Host "請輸入 SETTINGS_PASSWORD 密碼" -AsSecureString
    $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

if ([string]::IsNullOrWhiteSpace($Password)) {
    Write-Error "密碼不可為空"
    exit 1
}

Write-Host "[railway-set][$(Get-Date -Format 'HH:mm:ss')] 正在設定 SETTINGS_PASSWORD..."
# 需先 railway link 綁定專案，或 cd 到專案目錄
railway variable set "SETTINGS_PASSWORD=$Password"

if ($LASTEXITCODE -eq 0) {
    Write-Host "[railway-set][$(Get-Date -Format 'HH:mm:ss')] SETTINGS_PASSWORD 已設定，請等待 Railway 重新部署"
} else {
    Write-Host "[railway-set][$(Get-Date -Format 'HH:mm:ss')] 若未登入，請先執行: railway login"
    exit 1
}
