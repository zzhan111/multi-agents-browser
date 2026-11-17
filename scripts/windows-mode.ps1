param(
  [ValidateSet('status', 'headed', 'headless')][string]$Mode = 'status',
  [switch]$Focus
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$browserHome = if ($env:BB_BROWSER_HOME) { $env:BB_BROWSER_HOME } else { Join-Path $env:USERPROFILE '.bb-browser' }
$daemonFile = Join-Path $browserHome 'daemon.json'

function Test-Tray {
  try {
    $tray = [System.Threading.Mutex]::OpenExisting('Local\ma-browser-tray')
    $tray.Dispose()
    return $true
  } catch { return $false }
}

try {
  $trayRunning = Test-Tray
  if (-not (Test-Path -LiteralPath $daemonFile)) {
    if ($Mode -eq 'status') {
      @{ mode = $null; connected = $false; trayRunning = $trayRunning } | ConvertTo-Json -Compress
      exit 0
    }
    throw '后台未运行，请先启动 ma-browser 或等待托盘启动后台。'
  }

  $info = Get-Content -Raw -LiteralPath $daemonFile | ConvertFrom-Json
  $headers = @{ Authorization = "Bearer $($info.token)"; 'Content-Type' = 'application/json' }
  if ($env:BB_SESSION_ID) { $headers['X-BB-Session'] = $env:BB_SESSION_ID }
  if ($env:BB_SESSION_SCOPE) { $headers['X-BB-Session-Scope'] = $env:BB_SESSION_SCOPE }

  $bodyObj = @{ id = [guid]::NewGuid().ToString(); action = 'browser_mode'; modeAction = $Mode }
  if ($Focus) { $bodyObj.focus = $true }
  $body = $bodyObj | ConvertTo-Json -Compress
  $timeoutSec = if ($Mode -eq 'status') { 5 } else { 45 }

  try {
    $resp = Invoke-RestMethod -Uri "http://$($info.host):$($info.port)/command" -Method Post -Headers $headers -Body $body -TimeoutSec $timeoutSec
  } catch {
    if ($Mode -eq 'status') {
      @{ mode = $null; connected = $false; trayRunning = $trayRunning } | ConvertTo-Json -Compress
      exit 0
    }
    throw
  }

  if (-not $resp.success -or -not $resp.data.browserMode) {
    throw $(if ($resp.error) { [string]$resp.error } else { '浏览器模式操作失败。' })
  }

  $resp.data.browserMode | ConvertTo-Json -Compress
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
