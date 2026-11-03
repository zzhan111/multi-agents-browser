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
$env:MA_BROWSER_HEADLESS = '1'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add('正在启动')
$statusItem.Enabled = $false
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
