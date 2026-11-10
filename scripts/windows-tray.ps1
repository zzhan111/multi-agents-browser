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
$modeRequestFile = Join-Path $browserHome 'browser\mode-request.json'
$modeResultFile = Join-Path $browserHome 'browser\mode-result.json'
$logDir = Join-Path $browserHome 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:MA_BROWSER_HEADLESS = if ([Environment]::GetEnvironmentVariable('MA_BROWSER_HEADLESS', 'User') -eq '0') { '0' } else { '1' }
$env:MA_BROWSER_RESTORE_SESSION = '1'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('正在启动')
$statusItem.Enabled = $false
$modeItem = $menu.Items.Add('切换浏览器模式')
$modeItem.Enabled = $false
$modeItem.Add_Click({
  $browser = Get-ManagedBrowser
  if ($browser) {
    $target = if ($browser.CommandLine -match '(?:^|\s)--headless(?:=\S+)?(?:\s|$)') { 'headed' } else { 'headless' }
    Switch-BrowserMode $target | Out-Null
  }
})
$menu.Add_Opening({ Update-ModeMenu })
# Discover / attach browsers that already expose remote debugging (same `cdp` CLI semantics).
$cdpMenu = New-Object System.Windows.Forms.ToolStripMenuItem('发现并接管已有 Chrome')
$cdpMenu.DropDownItems.Add('正在扫描…') | Out-Null
$cdpMenu.Add_DropDownOpening({ Update-CdpMenu })
$menu.Items.Add($cdpMenu) | Out-Null
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

function Show-Balloon([string]$title, [string]$text) {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = if ($text) { $text } else { '未知错误' }
  $tray.ShowBalloonTip(5000)
}

function Invoke-Cli([string[]]$cliArgs) {
  $output = (& $node $cli @cliArgs '--json' 2>$null | Out-String).Trim()
  try { $output | ConvertFrom-Json } catch { [pscustomobject]@{ success = $false; error = "无法解析 CLI 输出：$output" } }
}

function Update-CdpMenu {
  $cdpMenu.DropDownItems.Clear()
  $result = Invoke-Cli @('cdp', 'list')
  if (-not $result.success) {
    $cdpMenu.DropDownItems.Add('发现失败（见通知）').Enabled = $false
    Show-Balloon 'ma-browser 发现浏览器失败' $result.error
    return
  }
  $browsers = @($result.data.browsers)
  if ($browsers.Count -eq 0) {
    $cdpMenu.DropDownItems.Add('未发现：请用 --remote-debugging-port=9222 和独立 --user-data-dir 启动 Chrome').Enabled = $false
    return
  }
  foreach ($b in $browsers) {
    $kind = if ($b.managed) { '受管' } else { '用户' }
    $state = if (-not $b.attached) { '点击接管' } elseif ($b.connected) { if ($b.default) { '已接管·默认' } else { '已接管' } } else { '已接管·重连中' }
    $item = New-Object System.Windows.Forms.ToolStripMenuItem("$($b.id)  $kind $($b.browser)  $($b.tabs) 个标签页  [$state]")
    $item.Checked = [bool]$b.attached
    $item.Tag = [string]$b.id
    if ($b.userDataDir) { $item.ToolTipText = [string]$b.userDataDir }
    if (-not $b.attached) { $item.Add_Click({ param($sender) Invoke-CdpAttach @([string]$sender.Tag) }) }
    $cdpMenu.DropDownItems.Add($item) | Out-Null
  }
  if (@($browsers | Where-Object { -not $_.attached }).Count -gt 1) {
    $cdpMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
    $cdpMenu.DropDownItems.Add('全部接管').Add_Click({ Invoke-CdpAttach @('--all') })
  }
}

function Invoke-CdpAttach([string[]]$target) {
  $result = Invoke-Cli (@('cdp', 'attach') + $target)
  if (-not $result.success) {
    Show-Balloon 'ma-browser 接管失败' $result.error
  } else {
    $failed = @($result.data.failed | Where-Object { $_ } | ForEach-Object { "$($_.id): $($_.error)" })
    $attached = @($result.data.attached)
    if ($failed.Count -gt 0) {
      Show-Balloon 'ma-browser 部分接管失败' ($failed -join "`n")
    } elseif ($attached.Count -gt 0) {
      Show-Balloon 'ma-browser 已接管' ("浏览器 " + ($attached -join ', '))
    } else {
      Show-Balloon 'ma-browser' '浏览器已在接管中'
    }
  }
  Update-Tray
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

function Switch-BrowserMode([string]$target) {
  $timer.Stop()
  $modeItem.Enabled = $false
  $socket = $null
  try {
    if ($target -notin @('headed', 'headless')) { throw '无效的浏览器模式' }
    $browser = Get-ManagedBrowser
    if (-not $browser) { throw '未找到受管浏览器' }
    $current = if ($browser.CommandLine -match '(?:^|\s)--headless(?:=\S+)?(?:\s|$)') { 'headless' } else { 'headed' }
    if ($current -eq $target) { return @{ success = $true; changed = $false } }
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
    $next = if ($target -eq 'headless') { '1' } else { '0' }
    [Environment]::SetEnvironmentVariable('MA_BROWSER_HEADLESS', $next, 'User')
    $env:MA_BROWSER_HEADLESS = $next
    return @{ success = $true; changed = $true }
  } catch {
    $message = $_.Exception.Message
    Show-Balloon 'ma-browser 模式切换失败' $message
    return @{ success = $false; error = $message }
  } finally {
    if ($socket) { $socket.Dispose() }
    $script:lastStart = [DateTime]::MinValue
    Update-Tray
    $timer.Start()
  }
}

function Update-Tray {
  if (Test-Path -LiteralPath $modeRequestFile) {
    try {
      $request = Get-Content -Raw -LiteralPath $modeRequestFile | ConvertFrom-Json
      if ($request.id -notmatch '^[0-9a-f-]{36}$' -or $request.mode -notin @('headed', 'headless')) { throw '无效的切换请求' }
      Remove-Item -LiteralPath $modeRequestFile
      $result = Switch-BrowserMode $request.mode
      @{ id = $request.id; success = $result.success; changed = $result.changed; error = $result.error } | ConvertTo-Json -Compress | Set-Content -LiteralPath $modeResultFile -Encoding UTF8
    } catch {
      Remove-Item -LiteralPath $modeRequestFile -ErrorAction SilentlyContinue
    }
    return
  }
  $info = $null
  $status = $null
  try {
    $info = Get-Content -Raw -LiteralPath $daemonFile | ConvertFrom-Json
    $status = Invoke-RestMethod -Uri "http://$($info.host):$($info.port)/status" -Headers @{ Authorization = "Bearer $($info.token)" } -TimeoutSec 2
  } catch { }

  if ($status.running) {
    $live = @($status.browsers | Where-Object { $_.connected })
    $message = if ($live.Count -gt 1) { "已连接 $($live.Count) 个浏览器（$((@($live | ForEach-Object { $_.id })) -join ', ')）" } elseif ($status.cdpConnected) { '浏览器已连接' } else { '正在连接浏览器' }
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
  # NotifyIcon.Text is capped at 63 characters.
  $tip = "ma-browser - $message"
  $tray.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
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
