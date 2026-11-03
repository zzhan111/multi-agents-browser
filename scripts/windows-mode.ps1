param([ValidateSet('status', 'headed', 'headless')][string]$Mode = 'status')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$browserHome = if ($env:BB_BROWSER_HOME) { $env:BB_BROWSER_HOME } else { Join-Path $env:USERPROFILE '.bb-browser' }
$browserDir = Join-Path $browserHome 'browser'
$requestFile = Join-Path $browserDir 'mode-request.json'
$resultFile = Join-Path $browserDir 'mode-result.json'

function Test-Tray {
  try {
    $tray = [System.Threading.Mutex]::OpenExisting('Local\ma-browser-tray')
    $tray.Dispose()
    return $true
  } catch { return $false }
}

function Get-BrowserMode {
  $trayRunning = Test-Tray
  try {
    $info = Get-Content -Raw -LiteralPath (Join-Path $browserHome 'daemon.json') | ConvertFrom-Json
    $status = Invoke-RestMethod -Uri "http://$($info.host):$($info.port)/status" -Headers @{ Authorization = "Bearer $($info.token)" } -TimeoutSec 2
    $port = [int](Get-Content -Raw -LiteralPath (Join-Path $browserDir 'cdp-port'))
    if (-not $status.cdpConnected -or $status.cdpPort -ne $port) { throw 'browser not connected' }
    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
    if (-not $version.'User-Agent') { throw 'browser version unavailable' }
    $mode = if ($version.'User-Agent' -match 'HeadlessChrome') { 'headless' } else { 'headed' }
    return @{ mode = $mode; connected = $true; trayRunning = $trayRunning }
  } catch {
    return @{ mode = $null; connected = $false; trayRunning = $trayRunning }
  }
}

$mutex = $null
$locked = $false
try {
  if ($Mode -eq 'status') {
    Get-BrowserMode | ConvertTo-Json -Compress
    exit 0
  }

  $mutex = New-Object System.Threading.Mutex($false, 'Local\ma-browser-mode-request')
  try { $locked = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw '已有浏览器模式切换请求正在执行，请稍后重试。' }
  $current = Get-BrowserMode
  if (-not $current.trayRunning) { throw 'Windows 托盘未运行，请先启动 ma-browser 托盘。' }
  if (-not $current.connected) { throw '受管浏览器尚未连接，请稍后重试。' }
  if ($current.mode -eq $Mode) {
    @{ mode = $Mode; connected = $true; trayRunning = $true; changed = $false } | ConvertTo-Json -Compress
    exit 0
  }
  if (Test-Path -LiteralPath $requestFile) { throw '已有浏览器模式切换请求等待处理，请稍后重试。' }

  $id = [guid]::NewGuid().ToString()
  New-Item -ItemType Directory -Force -Path $browserDir | Out-Null
  $tempFile = Join-Path $browserDir "mode-request-$id.tmp"
  try {
    [IO.File]::WriteAllText($tempFile, (@{ id = $id; mode = $Mode } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding $false))
    [IO.File]::Move($tempFile, $requestFile)
  } finally { Remove-Item -LiteralPath $tempFile -ErrorAction SilentlyContinue }

  $deadline = [DateTime]::UtcNow.AddSeconds(38)
  $result = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not $result -and (Test-Path -LiteralPath $resultFile)) {
      try {
        $candidate = Get-Content -Raw -LiteralPath $resultFile | ConvertFrom-Json
        if ($candidate.id -eq $id) { $result = $candidate }
      } catch { }
    }
    if ($result) {
      if (-not $result.success) { throw "切换失败：$($result.error)" }
      $state = Get-BrowserMode
      if ($state.connected -and $state.mode -eq $Mode) {
        Remove-Item -LiteralPath $resultFile -ErrorAction SilentlyContinue
        @{ mode = $Mode; connected = $true; trayRunning = $state.trayRunning; changed = [bool]$result.changed } | ConvertTo-Json -Compress
        exit 0
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw '等待切换结果超时；托盘可能仍在处理请求，请先查询当前模式。'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
