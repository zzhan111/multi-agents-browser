$ErrorActionPreference = 'Stop'
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
  $_.CommandLine -and $_.CommandLine -match '--headless(=new)?(\s|$)' -and
  $_.CommandLine -match "--remote-debugging-port=$port(\s|$)" -and
  $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($profile)
}
if (-not $browser) { throw 'The managed browser is not running headlessly with its expected profile.' }
Write-Output 'Windows tray, daemon and managed headless browser are running.'
