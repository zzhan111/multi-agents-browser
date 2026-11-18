$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutex = New-Object System.Threading.Mutex($false, 'Local\ma-browser-tray')
if (-not $mutex.WaitOne(0)) { return }

$root = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $root 'dist\cli.js'
$node = (Get-Command node.exe).Source
$browserHome = if ($env:BB_BROWSER_HOME) { $env:BB_BROWSER_HOME } else { Join-Path $env:USERPROFILE '.bb-browser' }
$browserDir = Join-Path $browserHome 'browser'
$daemonFile = Join-Path $browserHome 'daemon.json'
$modeFile = Join-Path $browserDir 'mode.json'
$logDir = Join-Path $browserHome 'logs'
New-Item -ItemType Directory -Force -Path $browserDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Migrate legacy user env preference once into mode.json; default to headless under the tray.
if (-not (Test-Path -LiteralPath $modeFile)) {
  $legacy = [Environment]::GetEnvironmentVariable('MA_BROWSER_HEADLESS', 'User')
  $initialMode = if ($legacy -eq '0') { 'headed' } else { 'headless' }
  $payload = @{ mode = $initialMode; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($modeFile, $payload, (New-Object System.Text.UTF8Encoding $false))
}
Remove-Item Env:\MA_BROWSER_HEADLESS -ErrorAction SilentlyContinue
$env:MA_BROWSER_DEFAULT_MODE = 'headless'
$env:MA_BROWSER_RESTORE_SESSION = '1'
$env:MA_BROWSER_TRAY_MANAGED = '1'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('正在启动')
$statusItem.Enabled = $false
$modeItem = $menu.Items.Add('切换浏览器模式')
$modeItem.Enabled = $false
$modeItem.Add_Click({
  $current = Invoke-DaemonMode 'status'
  if ($current -and $current.connected -and $current.mode) {
    if ($current.mode -eq 'headless') {
      Show-BrowserWindow
    } else {
      Switch-BrowserMode 'headless' | Out-Null
    }
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

$tray.Add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-BrowserWindow }
})

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MaBrowserWindow {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetPropW(IntPtr hWnd, string lpString);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(uint dwProcessId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero || GetWindowTextLengthW(h) <= 0) return true;
      StringBuilder sb = new StringBuilder(64);
      GetClassNameW(h, sb, sb.Capacity);
      if (sb.ToString() != "Chrome_WidgetWin_1") return true;
      if (GetPropW(h, "MaBrowserStealth") != IntPtr.Zero) return true;
      RECT r;
      if (GetWindowRect(h, out r) && r.Left <= -10000) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Activate(IntPtr hWnd) {
    if (hWnd == IntPtr.Zero) return false;
    ShowWindow(hWnd, IsIconic(hWnd) ? 9 : 5);
    IntPtr fg = GetForegroundWindow();
    if (fg == hWnd) return true;
    uint fgPid;
    uint fgThread = fg != IntPtr.Zero ? GetWindowThreadProcessId(fg, out fgPid) : 0;
    uint curThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != curThread) attached = AttachThreadInput(curThread, fgThread, true);
    try {
      BringWindowToTop(hWnd);
      SetForegroundWindow(hWnd);
    } finally {
      if (attached) AttachThreadInput(curThread, fgThread, false);
    }
    return GetForegroundWindow() == hWnd;
  }
}
'@

$script:showing = $false
$script:frontDeadline = $null
$script:starter = $null
$script:lastStart = [DateTime]::MinValue
$script:cachedMode = $null

function Get-ManagedBrowserPid {
  try {
    $pidFile = Join-Path $browserDir 'browser-pid'
    if (Test-Path -LiteralPath $pidFile) {
      $rawPid = [int](Get-Content -Raw -LiteralPath $pidFile).Trim()
      if ($rawPid -gt 0 -and (Get-Process -Id $rawPid -ErrorAction SilentlyContinue)) {
        return [uint32]$rawPid
      }
    }
    $port = [int](Get-Content -Raw -LiteralPath (Join-Path $browserDir 'cdp-port')).Trim()
    $profile = (Join-Path $browserDir 'profile').Replace('\', '/').ToLowerInvariant()
    $proc = Get-CimInstance Win32_Process -Filter "CommandLine like '%--remote-debugging-port=$port%'" | Where-Object {
      $_.CommandLine -and $_.CommandLine -notmatch '(?:^|\s)--type=' -and
      $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($profile)
    } | Select-Object -First 1
    if ($proc) { return [uint32]$proc.ProcessId }
    return [uint32]0
  } catch { return [uint32]0 }
}

function Show-Balloon([string]$title, [string]$text) {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = if ($text) { $text } else { '未知错误' }
  $tray.ShowBalloonTip(5000)
}

function Show-TrayError([string]$title, [string]$message) {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = if ($message) { $message } else { '未知错误' }
  $tray.ShowBalloonTip(5000)
}

function Invoke-DaemonMode([string]$action, [bool]$focus = $false) {
  try {
    $info = Get-Content -Raw -LiteralPath $daemonFile | ConvertFrom-Json
    if ($focus -and $info.pid) {
      [MaBrowserWindow]::AllowSetForegroundWindow([uint32]$info.pid) | Out-Null
    }
    $headers = @{ Authorization = "Bearer $($info.token)"; 'Content-Type' = 'application/json' }
    $bodyObj = @{ id = [guid]::NewGuid().ToString(); action = 'browser_mode'; modeAction = $action }
    if ($focus) { $bodyObj.focus = $true }
    $body = $bodyObj | ConvertTo-Json -Compress
    $timeoutSec = if ($action -eq 'status') { 3 } else { 40 }
    $resp = Invoke-RestMethod -Uri "http://$($info.host):$($info.port)/command" -Method Post -Headers $headers -Body $body -TimeoutSec $timeoutSec
    if (-not $resp.success) {
      return [pscustomobject]@{ success = $false; error = [string]$resp.error }
    }
    return [pscustomobject]@{
      success = $true
      mode = $resp.data.browserMode.mode
      backend = $resp.data.browserMode.backend
      connected = [bool]$resp.data.browserMode.connected
      changed = [bool]$resp.data.browserMode.changed
      restarted = [bool]$resp.data.browserMode.restarted
      windowFocused = [bool]$resp.data.browserMode.windowFocused
    }
  } catch {
    return [pscustomobject]@{ success = $false; error = $_.Exception.Message }
  }
}

# 置前受管浏览器窗口；成功返回 $true，窗口尚未出现返回 $false，置前被系统拒绝时抛错。
function Invoke-BrowserFront {
  $bpid = Get-ManagedBrowserPid
  if ($bpid -eq 0) { return $false }
  [MaBrowserWindow]::AllowSetForegroundWindow($bpid) | Out-Null
  $hwnd = [MaBrowserWindow]::Find($bpid)
  if ($hwnd -eq [IntPtr]::Zero) { return $false }
  if (-not [MaBrowserWindow]::Activate($hwnd) -and [MaBrowserWindow]::GetForegroundWindow() -ne $hwnd) {
    throw '系统拒绝将浏览器窗口置前'
  }
  return $true
}

# 左键一键秒弹出：无确认框，直接确保受管浏览器切换为有头模式并置前窗口。
function Show-BrowserWindow {
  if ($script:showing) { return }
  $script:showing = $true
  try {
    $res = Switch-BrowserMode 'headed' -Focus -SilentBalloon
    if (-not $res.success) {
      $errMsg = if ($res.error) { $res.error } else { '未找到受管浏览器，请等待后台连接后重试。' }
      Show-TrayError '无法显示 ma-browser 窗口' $errMsg
      return
    }
    try {
      if (Invoke-BrowserFront) {
        $script:frontDeadline = $null
        return
      }
      if ($res.restarted) {
        $script:frontDeadline = (Get-Date).AddSeconds(20)
        return
      }
      throw '未找到受管浏览器窗口'
    } catch {
      Show-TrayError 'ma-browser 窗口置前失败' $_.Exception.Message
    }
  } finally {
    $script:showing = $false
  }
}

# 若首次从原生 --headless=new 热切换到有头模式，等待新窗口创建完成后自动置前。
function Complete-PendingFront {
  if (-not $script:frontDeadline) { return }
  try {
    if (Invoke-BrowserFront) { $script:frontDeadline = $null; return }
    if ((Get-Date) -gt $script:frontDeadline) { throw '等待有头浏览器窗口超时' }
  } catch {
    $script:frontDeadline = $null
    Show-TrayError 'ma-browser 窗口置前失败' $_.Exception.Message
  }
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
  $modeState = Invoke-DaemonMode 'status'
  if ($modeState.success -and $modeState.connected -and $modeState.mode) {
    $modeItem.Enabled = $true
    $script:cachedMode = $modeState.mode
    if ($modeState.mode -eq 'headless') {
      $hint = if ($modeState.backend -eq 'native') { '热切换，保留标签页' } else { '显示窗口' }
      $modeItem.Text = "切换为有头浏览器（$hint）"
    } else {
      $modeItem.Text = '切换为无头浏览器（隐藏窗口）'
    }
  } else {
    $modeItem.Enabled = $false
    $modeItem.Text = '切换浏览器模式（受管浏览器未就绪）'
  }
}

function Switch-BrowserMode([string]$target, [switch]$Focus, [switch]$SilentBalloon) {
  $modeItem.Enabled = $false
  try {
    if ($target -notin @('headed', 'headless')) { throw '无效的浏览器模式' }
    $res = Invoke-DaemonMode $target ([bool]$Focus)
    if (-not $res.success) {
      throw $(if ($res.error) { $res.error } else { '受管浏览器尚未连接，请稍后重试。' })
    }
    $script:cachedMode = $res.mode
    return $res
  } catch {
    $message = $_.Exception.Message
    if (-not $SilentBalloon) {
      Show-Balloon 'ma-browser 模式切换失败' $message
    }
    return [pscustomobject]@{ success = $false; error = $message }
  } finally {
    Update-Tray
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
    $live = @($status.browsers | Where-Object { $_.connected })
    if ($status.cdpConnected) {
      $modeInfo = Invoke-DaemonMode 'status'
      $modeSuffix = if ($modeInfo.success -and $modeInfo.mode -eq 'headless') { '（无头模式）' } elseif ($modeInfo.success -and $modeInfo.mode -eq 'headed') { '（有头模式）' } else { '' }
      $message = if ($live.Count -gt 1) {
        "已连接 $($live.Count) 个浏览器$modeSuffix"
      } else {
        "浏览器已连接$modeSuffix"
      }
    } else {
      $message = '正在连接浏览器'
    }
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
