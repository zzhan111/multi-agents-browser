param([ValidateSet('headless', 'headed')][string]$Mode = 'headless', [switch]$ExpectForeground, [ValidateRange(0, 120)][int]$DelaySeconds = 0)
$ErrorActionPreference = 'Stop'
# -DelaySeconds lets you start the check, then left-click the tray and confirm before state is sampled.
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

$port = [int](Get-Content -Raw -LiteralPath (Join-Path $browserHome 'browser\cdp-port'))
$profile = (Join-Path $browserHome 'browser\profile').Replace('\', '/').ToLowerInvariant()
$browser = Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -match "--remote-debugging-port=$port(\s|$)" -and
  $_.CommandLine -notmatch '(?:^|\s)--type=' -and
  $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($profile)
} | Select-Object -First 1
if (-not $browser) { throw 'The managed browser is not running with its expected profile.' }
$headless = $browser.CommandLine -match '(?:^|\s)--headless(?:=\S+)?(?:\s|$)'
if ($headless -ne ($Mode -eq 'headless')) { throw "The managed browser is not in $Mode mode." }
if ($ExpectForeground) {
  if ($Mode -ne 'headed') { throw '-ExpectForeground requires -Mode headed.' }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MaBrowserForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
  $foregroundPid = [uint32]0
  [MaBrowserForeground]::GetWindowThreadProcessId([MaBrowserForeground]::GetForegroundWindow(), [ref]$foregroundPid) | Out-Null
  if ($foregroundPid -ne $browser.ProcessId) { throw "The managed browser window is not in the foreground (foreground pid $foregroundPid)." }
  Write-Output 'The managed browser window is in the foreground.'
}
# The tray's "发现并接管已有 Chrome" menu runs `cdp list`; it must see the managed browser as attached.
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\cli.js'
$list = (& (Get-Command node.exe).Source $cli cdp list --json | Out-String) | ConvertFrom-Json
if (-not $list.success) { throw "cdp list failed: $($list.error)" }
$managed = @($list.data.browsers) | Where-Object { $_.port -eq $port }
if (-not $managed -or -not $managed.attached -or -not $managed.managed) { throw 'cdp list does not show the managed browser as attached.' }
$others = @($list.data.browsers | Where-Object { $_.port -ne $port } | ForEach-Object { "$($_.id)$(if ($_.attached) { '*' })" })
Write-Output "Windows tray, daemon and managed $Mode browser are running. Other debuggable browsers (* = attached): $(if ($others) { $others -join ', ' } else { 'none' })"
