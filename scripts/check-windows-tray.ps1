param([ValidateSet('headless', 'headed')][string]$Mode = 'headless')
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
  $_.CommandLine -and $_.CommandLine -match "--remote-debugging-port=$port(\s|$)" -and
  $_.CommandLine -notmatch '(?:^|\s)--type=' -and
  $_.CommandLine.Replace('\', '/').ToLowerInvariant().Contains($profile)
} | Select-Object -First 1
if (-not $browser) { throw 'The managed browser is not running with its expected profile.' }
$headless = $browser.CommandLine -match '(?:^|\s)--headless(?:=\S+)?(?:\s|$)'
if ($headless -ne ($Mode -eq 'headless')) { throw "The managed browser is not in $Mode mode." }
# The tray's "发现并接管已有 Chrome" menu runs `cdp list`; it must see the managed browser as attached.
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'dist\cli.js'
$list = (& (Get-Command node.exe).Source $cli cdp list --json | Out-String) | ConvertFrom-Json
if (-not $list.success) { throw "cdp list failed: $($list.error)" }
$managed = @($list.data.browsers) | Where-Object { $_.port -eq $port }
if (-not $managed -or -not $managed.attached -or -not $managed.managed) { throw 'cdp list does not show the managed browser as attached.' }
$others = @($list.data.browsers | Where-Object { $_.port -ne $port } | ForEach-Object { "$($_.id)$(if ($_.attached) { '*' })" })
Write-Output "Windows tray, daemon and managed $Mode browser are running. Other debuggable browsers (* = attached): $(if ($others) { $others -join ', ' } else { 'none' })"
