$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Initialize-TrayInterop {
  Add-Type -TypeDefinition @'
using System;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Runtime.InteropServices;
public static class MaTrayResources {
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);

  // PowerShell delegates cannot run on arbitrary completion threads. These callbacks
  // only release worker resources; they never touch a control or wait on the UI thread.
  public static void StopWorker(PowerShell ps) {
    ps.BeginStop(ar => { try { ps.EndStop(ar); } finally { ps.Dispose(); } }, null);
  }
  public static void ClosePool(RunspacePool pool) {
    pool.BeginClose(ar => { try { pool.EndClose(ar); } finally { pool.Dispose(); } }, null);
  }
}
'@
}

function New-TrayIcon {
  $bitmap = New-Object System.Drawing.Bitmap 32, 32
  $graphics = $font = $wrapper = $null
  $handle = [IntPtr]::Zero
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.FillEllipse([System.Drawing.Brushes]::RoyalBlue, 0, 0, 31, 31)
    $font = New-Object System.Drawing.Font('Arial', 17, [System.Drawing.FontStyle]::Bold)
    $graphics.DrawString('M', $font, [System.Drawing.Brushes]::White, 0, 1)
    $handle = $bitmap.GetHicon()
    $wrapper = [System.Drawing.Icon]::FromHandle($handle)
    return $wrapper.Clone()
  } finally {
    if ($wrapper) { $wrapper.Dispose() }
    if ($handle -ne [IntPtr]::Zero) { [MaTrayResources]::DestroyIcon($handle) | Out-Null }
    if ($font) { $font.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    $bitmap.Dispose()
  }
}

function Show-Balloon([string]$title, [string]$text) {
  $tray.BalloonTipTitle = $title
  $tray.BalloonTipText = if ($text) { $text } else { '未知错误' }
  $tray.ShowBalloonTip(5000)
}

# These functions and the pending map belong exclusively to the WinForms thread.
# Repeated openings/ticks share the outstanding job. Poll only while there is work.
function Request-TrayWork([string]$operation, [string]$target = '', [string]$browser = '') {
  if ($script:closing -or $pending.ContainsKey($operation)) { return }
  $job = @{ Operation = $operation; Target = $target; Browser = $browser; ModeVersion = $script:modeVersion; CdpVersion = $script:cdpVersion }
  $ps = [PowerShell]::Create()
  try {
    $ps.RunspacePool = $pool
    $ps.AddCommand($workerPath).AddParameters(@{ Operation = $operation; Paths = $paths; Target = $target; Browser = $browser }) | Out-Null
    $job.Pipeline = $ps
    $job.Async = $ps.BeginInvoke()
    $pending[$operation] = $job
    $completionTimer.Start()
  } catch {
    $ps.Dispose()
    Complete-TrayWork $job @{ success = $false; error = $_.Exception.Message }
  }
}

function Receive-TrayWork {
  foreach ($operation in @($pending.Keys)) {
    $job = $pending[$operation]
    if (-not $job.Async.IsCompleted) { continue }
    $pending.Remove($operation)
    try {
      $result = $job.Pipeline.EndInvoke($job.Async) | Select-Object -Last 1
      if ($null -eq $result) { throw '后台操作没有返回结果' }
    } catch { $result = @{ success = $false; error = $_.Exception.Message } }
    finally { $job.Pipeline.Dispose() }
    Complete-TrayWork $job $result
  }
  if ($pending.Count -eq 0) { $completionTimer.Stop() }
}

function Reset-BrowserItems {
  if (-not $script:dynamicBrowserItems) { return }
  foreach ($item in @($script:dynamicBrowserItems)) {
    if ($menu -and $menu.Items.Contains($item)) { $menu.Items.Remove($item) }
    $item.Dispose()
  }
  $script:dynamicBrowserItems.Clear()
}

function Add-DynamicMenuItem([string]$text, [bool]$enabled = $true, [bool]$checked = $false, [string]$tooltip = '', $tag = $null, [scriptblock]$onClick = $null) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem($text)
  $item.Enabled = $enabled
  $item.Checked = $checked
  if ($tooltip) { $item.ToolTipText = $tooltip }
  if ($null -ne $tag) { $item.Tag = $tag }
  if ($onClick) { $item.Add_Click($onClick) }
  $insertAt = if ($menu -and $sepMgmt) { $menu.Items.IndexOf($sepMgmt) } else { -1 }
  if ($insertAt -ge 0) { $menu.Items.Insert($insertAt, $item) }
  elseif ($menu) { $menu.Items.Add($item) | Out-Null }
  if ($null -ne $script:dynamicBrowserItems) { $script:dynamicBrowserItems.Add($item) | Out-Null }
}

function Update-ModeMenu {
  Reset-BrowserItems
  $isSwitching = $pending.ContainsKey('Switch') -or $pending.ContainsKey('ToggleAll')
  $browsers = @($script:cachedBrowsers | Where-Object { $_ })
  $controllable = @($browsers | Where-Object { $_.connected -and $_.canToggle })

  if ($showAllItem -and $hideAllItem -and $sepBulk) {
    if ($controllable.Count -ge 2) {
      $visibleCount = @($controllable | Where-Object { $_.mode -eq 'headed' }).Count
      $hiddenCount = @($controllable | Where-Object { $_.mode -eq 'headless' }).Count
      $showAllItem.Visible = $true
      $hideAllItem.Visible = $true
      $sepBulk.Visible = $true
      $showAllItem.Text = "显示全部浏览器 ($($controllable.Count))"
      $hideAllItem.Text = "隐藏全部浏览器 ($($controllable.Count))"
      $showAllItem.Enabled = (-not $isSwitching) -and ($hiddenCount -gt 0)
      $hideAllItem.Enabled = (-not $isSwitching) -and ($visibleCount -gt 0)
    } else {
      $showAllItem.Visible = $false
      $hideAllItem.Visible = $false
      $sepBulk.Visible = $false
    }
  }

  if (-not $menu) { return }

  if ($isSwitching) {
    Add-DynamicMenuItem '正在切换浏览器窗口…' $false $false
    return
  }

  if ($browsers.Count -gt 0) {
    foreach ($b in $browsers) {
      $tipParts = @()
      if ($b.readonlyReason) { $tipParts += [string]$b.readonlyReason }
      if ($b.userDataDir) { $tipParts += [string]$b.userDataDir }
      $tip = $tipParts -join "`n"
      $baseText = "$($b.id) · $($b.label) · $($b.tabs) 页"
      if (-not $b.connected) {
        Add-DynamicMenuItem "◌ $baseText  （重连中…）" $false $false $tip
      } elseif (-not $b.canToggle) {
        Add-DynamicMenuItem "◌ $baseText  （外部窗口 · 仅查看）" $false $false $tip
      } elseif ($b.mode -eq 'headless') {
        $tag = @{ Action = 'headed'; Browser = [string]$b.id }
        Add-DynamicMenuItem "○ $baseText  （点击显示）" $true $false $tip $tag {
          param($sender)
          Switch-BrowserMode $sender.Tag.Action $sender.Tag.Browser
        }
      } else {
        $tag = @{ Action = 'headless'; Browser = [string]$b.id }
        Add-DynamicMenuItem "● $baseText  （点击隐藏）" $true $true $tip $tag {
          param($sender)
          Switch-BrowserMode $sender.Tag.Action $sender.Tag.Browser
        }
      }
    }
    return
  }

  $mode = $script:cachedMode
  if ($mode -and $mode.connected -and $mode.mode -eq 'headless') {
    $hint = if ($mode.backend -eq 'native') { '热切换，保留标签页' } else { '显示窗口' }
    Add-DynamicMenuItem "切换为有头浏览器（$hint）" $true $false '' $null { Switch-BrowserMode 'headed' }
  } elseif ($mode -and $mode.connected -and $mode.mode -eq 'headed') {
    Add-DynamicMenuItem '切换为无头浏览器（隐藏窗口）' $true $true '' $null { Switch-BrowserMode 'headless' }
  } else {
    Add-DynamicMenuItem '切换浏览器窗口（未就绪）' $false $false
  }
}

function Switch-BrowserMode([string]$target, [string]$browser = '') {
  if ($pending.ContainsKey('Switch') -or $pending.ContainsKey('ToggleAll')) { return }
  $script:modeVersion++  # Ignore a menu query issued before this user action.
  Request-TrayWork 'Switch' $target $browser
  Update-ModeMenu
}

function Toggle-AllBrowsers {
  if ($pending.ContainsKey('Switch') -or $pending.ContainsKey('ToggleAll')) { return }
  $script:modeVersion++
  Request-TrayWork 'ToggleAll'
  Update-ModeMenu
}

function Set-StatusText([string]$message) {
  $statusItem.Text = $message
  $tip = "ma-browser - $message"
  $tray.Text = if ($tip.Length -gt 63) { $tip.Substring(0, 63) } else { $tip }
}

function Set-TrayHealth($result) {
  $status = $result.data
  if ($result.success -and $status.running) {
    $script:healthFailures = 0
    $n = $status.connectedBrowserCount
    if (-not $status.cdpConnected) {
      $script:cachedMode = $null
      if ($n -eq 0) { $script:cachedBrowsers = @() }
      $script:modeVersion++
      Update-ModeMenu
      if ($n -gt 0) { Set-StatusText "已连接 $n 个浏览器（默认浏览器重连中）" } else { Set-StatusText '正在连接浏览器' }
    } elseif ($n -gt 1) { Set-StatusText "已连接 $n 个浏览器" } else { Set-StatusText '浏览器已连接' }
    return
  }
  $script:cachedMode = $null
  $script:cachedBrowsers = @()
  $script:modeVersion++
  Update-ModeMenu
  if (-not $result.retryable) {
    $script:healthFailures = 0
    Set-StatusText $result.error
    return
  }
  $script:healthFailures++
  # Allow a transient timeout. A reused PID must never veto recovery. The CLI owns startup.
  if (-not $result.missing -and $script:healthFailures -lt 2) { Set-StatusText '后台暂未响应'; return }
  Set-StatusText '后台未响应，正在重试'
  $now = [DateTime]::UtcNow
  if (-not $pending.ContainsKey('Start') -and ($now - $script:lastStart).TotalSeconds -ge 15) {
    $script:lastStart = $now
    Request-TrayWork 'Start'
  }
}

function Reset-CdpMenu {
  while ($cdpMenu.DropDownItems.Count -gt 0) { $cdpMenu.DropDownItems[0].Dispose() }
}

function Set-CdpMenu($result) {
  Reset-CdpMenu
  if (-not $result.success) {
    $cdpMenu.DropDownItems.Add('发现失败（见通知）').Enabled = $false
    Show-Balloon 'ma-browser 发现浏览器失败' $result.error
    return
  }
  $browsers = @($result.data.browsers | Where-Object { $_ })
  if ($browsers.Count -eq 0) {
    $cdpMenu.DropDownItems.Add('未发现：请用 --remote-debugging-port=9222 和独立 --user-data-dir 启动 Chrome').Enabled = $false
    return
  }
  $unattached = @($browsers | Where-Object { -not $_.attached })
  $attached = @($browsers | Where-Object { $_.attached })

  foreach ($b in $unattached) {
    $kind = if ($b.managed) { '受管' } else { '用户' }
    $item = New-Object System.Windows.Forms.ToolStripMenuItem("+ 接管 $($b.id)  $kind $($b.browser)  $($b.tabs) 页")
    $item.Tag = [string]$b.id
    if ($b.userDataDir) { $item.ToolTipText = [string]$b.userDataDir }
    $item.Add_Click({ param($sender) Request-CdpAttach ([string]$sender.Tag) })
    $cdpMenu.DropDownItems.Add($item) | Out-Null
  }
  if ($unattached.Count -gt 1) {
    $cdpMenu.DropDownItems.Add("+ 全部接管 ($($unattached.Count))").Add_Click({ Request-CdpAttach '--all' })
  }
  if ($unattached.Count -gt 0 -and $attached.Count -gt 0) {
    $cdpMenu.DropDownItems.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
  }
  foreach ($b in $attached) {
    if ($b.origin -eq 'attached') {
      $cached = $script:cachedBrowsers | Where-Object { $_.id -eq $b.id } | Select-Object -First 1
      $isHidden = $cached -and $cached.mode -eq 'headless' -and $cached.backend -eq 'stealth'
      $label = if ($isHidden) { "− 恢复窗口并停止接管 $($b.id)  ($($b.tabs) 页)" } else { "− 停止接管 $($b.id)  ($($b.tabs) 页)" }
      $item = New-Object System.Windows.Forms.ToolStripMenuItem($label)
      $item.Checked = $true
      $item.Tag = [string]$b.id
      if ($b.userDataDir) { $item.ToolTipText = [string]$b.userDataDir }
      $item.Add_Click({ param($sender) Request-CdpDetach ([string]$sender.Tag) })
      $cdpMenu.DropDownItems.Add($item) | Out-Null
    } else {
      $kind = if ($b.managed) { '受管' } else { '默认' }
      $state = if ($b.connected) { '默认·不可断开' } else { '重连中' }
      $item = New-Object System.Windows.Forms.ToolStripMenuItem("✓ $($b.id)  $kind  $($b.tabs) 页  [$state]")
      $item.Checked = $true
      $item.Enabled = $false
      if ($b.userDataDir) { $item.ToolTipText = [string]$b.userDataDir }
      $cdpMenu.DropDownItems.Add($item) | Out-Null
    }
  }
}

function Request-CdpAttach([string]$target) {
  if ($pending.ContainsKey('Attach') -or $pending.ContainsKey('Detach')) { return }
  $script:cdpVersion++
  $cdpMenu.Enabled = $false
  Request-TrayWork 'Attach' $target
}

function Request-CdpDetach([string]$target) {
  if ($pending.ContainsKey('Attach') -or $pending.ContainsKey('Detach')) { return }
  $script:cdpVersion++
  $cdpMenu.Enabled = $false
  Request-TrayWork 'Detach' $target
}

function Complete-TrayWork($job, $result) {
  switch ($job.Operation) {
    'Health' { Set-TrayHealth $result }
    'Start' { if (-not $result.success) { Set-StatusText $result.error } }
    'ModeStatus' {
      if ($job.ModeVersion -eq $script:modeVersion) {
        $script:cachedMode = if ($result.success) { $result.data.browserMode }
        $script:cachedBrowsers = if ($result.success -and $result.data.browserModes) { @($result.data.browserModes) } else { @() }
        Update-ModeMenu
      }
    }
    { $_ -in @('Switch', 'ToggleAll') } {
      if ($result.success) {
        $script:cachedMode = $result.data.browserMode
        $script:cachedBrowsers = if ($result.data.browserModes) { @($result.data.browserModes) } else { @() }
      }
      Update-ModeMenu
      $applied = if ($job.Operation -eq 'ToggleAll') { $result.appliedAction } else { $job.Target }
      if (-not $result.success) {
        $title = if ($applied -eq 'headed') { '无法显示 ma-browser 窗口' } else { 'ma-browser 模式切换失败' }
        Show-Balloon $title $result.error
      } elseif ($applied -eq 'headed' -and -not $script:cachedMode.windowFocused) {
        Show-Balloon 'ma-browser 窗口置前' '后台未确认窗口已置前，请稍后再点一次。'
      }
      Request-TrayWork 'Health'
    }
    'Discover' {
      if ($job.CdpVersion -eq $script:cdpVersion) { Set-CdpMenu $result }
      elseif ($cdpMenu.DropDown.Visible -and -not $pending.ContainsKey('Attach') -and -not $pending.ContainsKey('Detach')) { Request-TrayWork 'Discover' }
    }
    'Attach' {
      $cdpMenu.Enabled = $true
      Reset-CdpMenu
      $cdpMenu.DropDownItems.Add('正在扫描…').Enabled = $false
      if (-not $result.success) { Show-Balloon 'ma-browser 接管失败' $result.error } else {
        $failed = @($result.data.failed | Where-Object { $_ } | ForEach-Object { "$($_.id): $($_.error)" })
        if ($failed.Count) { Show-Balloon 'ma-browser 部分接管失败' ($failed -join "`n") }
        elseif ($result.data.attached) { Show-Balloon 'ma-browser 已接管' ("浏览器 " + ($result.data.attached -join ', ')) }
        else { Show-Balloon 'ma-browser' '浏览器已在接管中' }
      }
      Request-TrayWork 'Health'
      Request-TrayWork 'ModeStatus'
    }
    'Detach' {
      $cdpMenu.Enabled = $true
      Reset-CdpMenu
      $cdpMenu.DropDownItems.Add('正在扫描…').Enabled = $false
      if (-not $result.success) { Show-Balloon 'ma-browser 停止接管失败' $result.error }
      else { Show-Balloon 'ma-browser 已停止接管' ("浏览器 $($result.data.detached) 已恢复并断开") }
      Request-TrayWork 'Health'
      Request-TrayWork 'ModeStatus'
    }
    'RestoreExternal' {
      [System.Windows.Forms.Application]::ExitThread()
    }
  }
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\ma-browser-tray')
if (-not $mutex.WaitOne(0)) { $mutex.Dispose(); return }
try {
  Initialize-TrayInterop
  $root = Split-Path -Parent $PSScriptRoot
  $browserHome = if ($env:BB_BROWSER_HOME) { $env:BB_BROWSER_HOME } else { Join-Path $env:USERPROFILE '.bb-browser' }
  $browserDir = Join-Path $browserHome 'browser'
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

  $paths = @{ Node = (Get-Command node.exe).Source; Cli = (Join-Path $root 'dist\cli.js'); DaemonFile = (Join-Path $browserHome 'daemon.json'); LogDir = $logDir }
  $workerPath = Join-Path $PSScriptRoot 'windows-tray-worker.ps1'
  $pool = [RunspaceFactory]::CreateRunspacePool(1, 4)
  $pool.Open()
  $pending = @{}
  $script:closing = $false
  $script:exiting = $false
  $script:lastStart = [DateTime]::MinValue
  $script:healthFailures = $script:modeVersion = $script:cdpVersion = 0
  $script:cachedMode = $null
  $script:cachedBrowsers = @()
  $script:dynamicBrowserItems = New-Object System.Collections.Generic.List[System.Windows.Forms.ToolStripItem]

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $statusItem = $menu.Items.Add('正在启动')
  $statusItem.Enabled = $false
  $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null

  $showAllItem = $menu.Items.Add('显示全部浏览器')
  $showAllItem.Visible = $false
  $showAllItem.Add_Click({ Switch-BrowserMode 'headed' 'all' })
  $hideAllItem = $menu.Items.Add('隐藏全部浏览器')
  $hideAllItem.Visible = $false
  $hideAllItem.Add_Click({ Switch-BrowserMode 'headless' 'all' })
  $sepBulk = New-Object System.Windows.Forms.ToolStripSeparator
  $sepBulk.Visible = $false
  $menu.Items.Add($sepBulk) | Out-Null

  $sepMgmt = New-Object System.Windows.Forms.ToolStripSeparator
  $menu.Items.Add($sepMgmt) | Out-Null
  $menu.Add_Opening({ if (-not $pending.ContainsKey('Switch') -and -not $pending.ContainsKey('ToggleAll')) { Request-TrayWork 'ModeStatus' } })

  $cdpMenu = New-Object System.Windows.Forms.ToolStripMenuItem('管理与接管 Chrome')
  $cdpMenu.DropDownItems.Add('正在扫描…').Enabled = $false
  $cdpMenu.Add_DropDownOpening({ Request-TrayWork 'Discover' })
  $menu.Items.Add($cdpMenu) | Out-Null
  $logItem = $menu.Items.Add('打开日志目录')
  $logItem.Add_Click({ Start-Process explorer.exe -ArgumentList "`"$logDir`"" })
  $exitItem = $menu.Items.Add('退出托盘（后台继续运行）')
  $exitItem.Add_Click({
    if ($script:exiting) { [System.Windows.Forms.Application]::ExitThread(); return }
    $script:exiting = $true
    $exitItem.Enabled = $false
    $exitItem.Text = '正在恢复外部窗口并退出…'
    if (Test-Path -LiteralPath $paths.DaemonFile) { Request-TrayWork 'RestoreExternal' }
    else { [System.Windows.Forms.Application]::ExitThread() }
  })

  $tray = New-Object System.Windows.Forms.NotifyIcon
  $icon = New-TrayIcon
  $tray.Icon = $icon
  $tray.ContextMenuStrip = $menu
  $tray.Text = 'ma-browser'
  $tray.Add_MouseClick({
    param($sender, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Toggle-AllBrowsers }
  })
  $completionTimer = New-Object System.Windows.Forms.Timer
  $completionTimer.Interval = 120
  $completionTimer.Add_Tick({ Receive-TrayWork })
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 5000
  $timer.Add_Tick({ Request-TrayWork 'Health' })
  $tray.Visible = $true
  Request-TrayWork 'Health'
  $timer.Start()
  [System.Windows.Forms.Application]::Run()
} finally {
  $script:closing = $true
  if ($timer) { $timer.Dispose() }
  if ($completionTimer) { $completionTimer.Dispose() }
  if ($tray) { $tray.Visible = $false; $tray.Dispose() }
  if ($icon) { $icon.Dispose() }
  if ($menu) { Reset-BrowserItems; $menu.Dispose() }
  foreach ($job in $pending.Values) { [MaTrayResources]::StopWorker($job.Pipeline) }
  if ($pool) { [MaTrayResources]::ClosePool($pool) }
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
