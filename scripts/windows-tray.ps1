$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutex = New-Object System.Threading.Mutex($false, 'Local\ma-browser-tray')
if (-not $mutex.WaitOne(0)) { return }

$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'dist\cli.js'
$node = (Get-Command node.exe).Source
$browserHome = if ($env:BB_BROWSER_HOME) { $env:BB_BROWSER_HOME } else { Join-Path $env:USERPROFILE '.bb-browser' }
$daemonFile = Join-Path $browserHome 'daemon.json'
$logDir = Join-Path $browserHome 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:MA_BROWSER_HEADLESS = if ([Environment]::GetEnvironmentVariable('MA_BROWSER_HEADLESS', 'User') -eq '0') { '0' } else { '1' }
$env:MA_BROWSER_RESTORE_SESSION = '1'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('正在启动')
$statusItem.Enabled = $false
$modeItem = $menu.Items.Add('切换浏览器模式')
$modeItem.Enabled = $false
$modeItem.Add_Click({ Switch-BrowserMode })
$menu.Add_Opening({ Update-ModeMenu })
$logItem = $menu.Items.Add('打开日志目录')
$logItem.Add_Click({ Start-Process explorer.exe -ArgumentList "`"$logDir`"" })
$exitItem = $menu.Items.Add('退出托盘（后台继续运行）')
$exitItem.Add_Click({ [System.Windows.Forms.Application]::ExitThread() })

$tray = New-Object System.Windows.Forms.NotifyIcon
$bitmap = New-Object System.Drawing.Bitmap 32, 32
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.FillEllipse([System.Drawing.Brushes]::RoyalBlue, 0, 0, 31, 31)
$font = New-Object System.Drawing.Font('Arial', 17, [System.Drawing.FontStyle]::Bold)
$graphics.DrawString('M', $font, [System.Drawing.Brushes]::White, 0, 1)
$font.Dispose()
$graphics.Dispose()
$tray.Icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$bitmap.Dispose()
$tray.ContextMenuStrip = $menu
$tray.Text = 'ma-browser'
$tray.Visible = $true

$script:starter = $null
$script:lastStart = [DateTime]::MinValue

function Get-ManagedBrowser {
  try {
    $port = [int](Get-Content -Raw -LiteralPath (Join-Path $browserHome 'browser\cdp-port'))
    $profile = [regex]::Escape((Join-Path $browserHome 'browser\profile'))
    Get-CimInstance Win32_Process | Where-Object {
      $_.Name -in @('chrome.exe', 'msedge.exe', 'brave.exe') -and $_.CommandLine -and
      $_.CommandLine -match "--remote-debugging-port=$port(\s|$)" -and
      $_.CommandLine -match "--user-data-dir=(?:`"$profile`"|$profile)(\s|$)" -and
      $_.CommandLine -notmatch '(?:^|\s)--type='
    } | Select-Object -First 1
  } catch { $null }
}

function Update-ModeMenu {
  $browser = Get-ManagedBrowser
  $modeItem.Enabled = [bool]$browser
  if ($browser) {
    $mode = if ($browser.CommandLine -match '(?:^|\s)--headless(?:=\S+)?(?:\s|$)') { '有头' } else { '无头' }
    $modeItem.Text = "切换为${mode}浏览器（将重启浏览器）"
  } else {
    $modeItem.Text = '切换浏览器模式（受管浏览器未就绪）'
  }
}

function Switch-BrowserMode {
  $timer.Stop()
  $modeItem.Enabled = $false
  $socket = $null
  try {
    $browser = Get-ManagedBrowser
    if (-not $browser) { throw '未找到受管浏览器' }
    $info = Get-Content -Raw -LiteralPath $daemonFile | ConvertFrom-Json
    $headers = @{ Authorization = "Bearer $($info.token)" }
    $baseUrl = "http://$($info.host):$($info.port)"
    $status = Invoke-RestMethod -Uri "$baseUrl/status" -Headers $headers -TimeoutSec 2
    $port = [int](Get-Content -Raw -LiteralPath (Join-Path $browserHome 'browser\cdp-port'))
    if (-not $status.cdpConnected -or $status.cdpPort -ne $port) { throw '后台未连接受管浏览器' }

    $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2
    $uri = [Uri]$version.webSocketDebuggerUrl
    if ($uri.Scheme -ne 'ws' -or -not $uri.IsLoopback -or $uri.Port -ne $port) { throw '浏览器调试地址无效' }
    $socket = New-Object System.Net.WebSockets.ClientWebSocket
    $cancel = [System.Threading.CancellationToken]::None
    if (-not $socket.ConnectAsync($uri, $cancel).Wait(3000)) { throw '无法连接受管浏览器' }

    Invoke-RestMethod -Uri "$baseUrl/shutdown" -Method Post -Headers $headers -TimeoutSec 3 | Out-Null
    for ($i = 0; $i -lt 50 -and (Get-Process -Id $info.pid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
    if (Get-Process -Id $info.pid -ErrorAction SilentlyContinue) { throw '后台进程未退出' }

    $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"id":1,"method":"Browser.close"}')
    $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
    if (-not $socket.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel).Wait(3000)) { throw '无法关闭受管浏览器' }
    for ($i = 0; $i -lt 100 -and (Get-Process -Id $browser.ProcessId -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
    if (Get-Process -Id $browser.ProcessId -ErrorAction SilentlyContinue) { throw '浏览器未退出，请检查页面对话框' }

    Remove-Item -LiteralPath (Join-Path $browserHome 'browser\browser-pid') -ErrorAction SilentlyContinue
    $next = if ($browser.CommandLine -match '(?:^|\s)--headless(?:=\S+)?(?:\s|$)') { '0' } else { '1' }
    [Environment]::SetEnvironmentVariable('MA_BROWSER_HEADLESS', $next, 'User')
    $env:MA_BROWSER_HEADLESS = $next
  } catch {
    $tray.BalloonTipTitle = 'ma-browser 模式切换失败'
    $tray.BalloonTipText = $_.Exception.Message
    $tray.ShowBalloonTip(5000)
  } finally {
    if ($socket) { $socket.Dispose() }
    $script:lastStart = [DateTime]::MinValue
    Update-Tray
    $timer.Start()
  }
}

function Update-Tray {
  $info = $null
  $status = $null
  try {
    $info = Get-Content -Raw -LiteralPath $daemonFile | ConvertFrom-Json
    $status = Invoke-RestMethod -Uri "http://$($info.host):$($info.port)/status" -Headers @{ Authorization = "Bearer $($info.token)" } -TimeoutSec 2
  } catch { }

  if ($status.running) {
    $message = if ($status.cdpConnected) { '浏览器已连接' } else { '正在连接浏览器' }
  } else {
    $alive = $info -and (Get-Process -Id $info.pid -ErrorAction SilentlyContinue)
    $message = if ($alive) { '等待后台进程响应' } else { '后台未运行，正在重试' }
    if (-not $alive -and (-not $script:starter -or $script:starter.HasExited) -and ((Get-Date) - $script:lastStart).TotalSeconds -ge 15) {
      $script:lastStart = Get-Date
      try {
        $script:starter = Start-Process -FilePath $node -ArgumentList @("`"$cli`"", 'daemon', 'start') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'tray-start.out.log') -RedirectStandardError (Join-Path $logDir 'tray-start.err.log')
      } catch {
        $message = '启动失败，请检查 Node.js 和日志'
      }
    }
  }
  $statusItem.Text = $message
  $tray.Text = "ma-browser - $message"
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({ Update-Tray })
Update-Tray
$timer.Start()
try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $timer.Stop()
  $tray.Visible = $false
  $tray.Dispose()
  $timer.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
