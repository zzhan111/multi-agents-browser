param([ValidateSet('headless', 'headed')][string]$Mode = 'headless', [switch]$ExpectForeground, [ValidateRange(0, 120)][int]$DelaySeconds = 0)
$ErrorActionPreference = 'Stop'
# -DelaySeconds lets you start the check, then left-click the tray before state is sampled.
Start-Sleep -Seconds $DelaySeconds
$trayPath = (Resolve-Path (Join-Path $PSScriptRoot 'windows-tray.ps1')).Path.Replace('\', '/').ToLowerInvariant()
$tray = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($trayPath)
}
if (-not $tray) { throw 'Windows tray is not running.' }

$browserHome = if ($env:BB_BROWSER_HOME) { $env:BB_BROWSER_HOME } else { Join-Path $env:USERPROFILE '.bb-browser' }
$info = Get-Content -Raw -LiteralPath (Join-Path $browserHome 'daemon.json') | ConvertFrom-Json
$status = Invoke-RestMethod -Uri "http://$($info.host):$($info.port)/status" -Headers @{ Authorization = "Bearer $($info.token)" } -TimeoutSec 2
if (-not $status.running -or -not $status.cdpConnected) { throw 'Daemon or browser is not connected.' }

$port = [int](Get-Content -Raw -LiteralPath (Join-Path $browserHome 'browser\cdp-port')).Trim()
$profile = (Join-Path $browserHome 'browser\profile').Replace('\', '/').ToLowerInvariant()
$browser = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -match "--remote-debugging-port=$port(\s|$)" -and
  $_.CommandLine -notmatch '(?:^|\s)--type=' -and
  $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($profile)
} | Select-Object -First 1
if (-not $browser) { throw 'The managed browser is not running with its expected profile.' }

$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\cli.js'
$nodeExe = (Get-Command node.exe).Source
$modeRes = (& $nodeExe $cli mode status --json | Out-String) | ConvertFrom-Json
if (-not $modeRes.connected -or $modeRes.mode -ne $Mode) {
  throw "Expected mode '$Mode', but ma-browser mode status reported '$($modeRes.mode)' (connected=$($modeRes.connected))."
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MaBrowserForeground {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int maxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetPropW(IntPtr hWnd, string lpString);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  public static int CountOnScreenWindows(uint pid) {
    int count = 0;
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
      count++;
      return true;
    }, IntPtr.Zero);
    return count;
  }
}
'@

$onScreenCount = [MaBrowserForeground]::CountOnScreenWindows([uint32]$browser.ProcessId)
if ($Mode -eq 'headless' -and $onScreenCount -gt 0) {
  throw "Managed browser is in headless mode but still has $onScreenCount visible on-screen window(s)."
}
if ($Mode -eq 'headed' -and $onScreenCount -le 0) {
  throw 'Managed browser is in headed mode but has no visible on-screen window.'
}

if ($ExpectForeground) {
  if ($Mode -ne 'headed') { throw '-ExpectForeground requires -Mode headed.' }
  $foregroundPid = [uint32]0
  [MaBrowserForeground]::GetWindowThreadProcessId([MaBrowserForeground]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
  if ($foregroundPid -ne $browser.ProcessId) { throw "The managed browser window is not in the foreground (foreground pid $foregroundPid)." }
  Write-Output 'The managed browser window is in the foreground.'
}
# The tray's "发现并接管已有 Chrome" menu runs `cdp list`; it must see the managed browser as attached.
$list = (& $nodeExe $cli cdp list --json | Out-String) | ConvertFrom-Json
if (-not $list.success) { throw "cdp list failed: $($list.error)" }
$managed = @($list.data.browsers) | Where-Object { $_.port -eq $port }
if (-not $managed -or -not $managed.attached -or -not $managed.managed) { throw 'cdp list does not show the managed browser as attached.' }
$others = @($list.data.browsers | Where-Object { $_.port -ne $port } | ForEach-Object { "$($_.id)$(if ($_.attached) { '*' })" })
Write-Output "Windows tray, daemon and managed $Mode browser ($($modeRes.backend)) are running. Other debuggable browsers (* = attached): $(if ($others) { $others -join ', ' } else { 'none' })"
