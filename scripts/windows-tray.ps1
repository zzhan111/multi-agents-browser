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

$tray.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-BrowserWindow }
})

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaBrowserWindow {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && GetWindowTextLength(h) > 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Activate(IntPtr hWnd) {
    ShowWindow(hWnd, IsIconic(hWnd) ? 9 : 5);
    return SetForegroundWindow(hWnd);
  }
}
'@

$script:prompting = $false
$script:frontDeadline = $null

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

function Get-BrowserModeName($browser) {
  if ($browser.CommandLine -match '(?:^|\s)--headless(?:=\S+)?(?:\s|$)') { 'headless' } else { 'headed' }
}

function Show-TrayError([string]$title, [string]$message) {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = $message
  $tray.ShowBalloonTip(5000)
}

# 置前受管浏览器窗口；成功返回 $true，窗口尚未出现返回 $false，置前被系统拒绝时抛错。
function Invoke-BrowserFront($browser) {
  $hwnd = [MaBrowserWindow]::Find([uint32]$browser.ProcessId)
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  if (-not [MaBrowserWindow]::Activate($hwnd) -and [MaBrowserWindow]::GetForegroundWindow() -ne $hwnd) { throw '系统拒绝将浏览器窗口置前' }
  return $true
}

function Show-BrowserWindow {
  if ($script:prompting) { return }
  $script:prompting = $true
  $owner = $null
  try {
    $browser = Get-ManagedBrowser
    if (-not $browser) { Show-TrayError '无法显示 ma-browser 窗口' '未找到受管浏览器，请等待后台启动后重试。'; return }
    $mode = Get-BrowserModeName $browser
    $text = if ($mode -eq 'headless') { '当前为无头模式。是否切换为有头并显示窗口？（会重启受管浏览器）' } else { '是否将受管浏览器窗口置于前台？' }
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'Manual'; Location = New-Object System.Drawing.Point(-32000, -32000) }
    $owner.Show()
    $owner.Activate()
    $answer = [System.Windows.Forms.MessageBox]::Show($owner, $text, '显示 ma-browser 窗口？', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
    if ($mode -eq 'headed') {
      try {
        if (-not (Invoke-BrowserFront $browser)) { throw '未找到受管浏览器窗口' }
      } catch { Show-TrayError 'ma-browser 窗口置前失败' $_.Exception.Message }
      return
    }
    $result = Switch-BrowserMode 'headed'
    if ($result.success) { $script:frontDeadline = (Get-Date).AddSeconds(45) }
  } finally {
    if ($owner) { $owner.Dispose() }
    $script:prompting = $false
  }
}

# headless→headed 切换后，等新浏览器窗口出现再置前（由定时器轮询）。
function Complete-PendingFront {
  if (-not $script:frontDeadline) { return }
  try {
    $browser = Get-ManagedBrowser
    if ($browser -and (Get-BrowserModeName $browser) -eq 'headed' -and (Invoke-BrowserFront $browser)) { $script:frontDeadline = $null; return }
    if ((Get-Date) -gt $script:frontDeadline) { throw '等待有头浏览器窗口超时' }
  } catch {
    $script:frontDeadline = $null
    Show-TrayError 'ma-browser 窗口置前失败' $_.Exception.Message
  }
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
    $tray.BalloonTipTitle = 'ma-browser 模式切换失败'
    $tray.BalloonTipText = $message
    $tray.ShowBalloonTip(5000)
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
  Complete-PendingFront
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
