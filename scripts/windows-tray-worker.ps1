param(
  [ValidateSet('Health', 'ModeStatus', 'Switch', 'ToggleAll', 'Discover', 'Attach', 'Detach', 'RestoreExternal', 'Start')][string]$Operation,
  [hashtable]$Paths,
  [string]$Target,
  [string]$Browser
)
# Runs in a background runspace. Only return data; WinForms belongs to the tray thread.
$ErrorActionPreference = 'Stop'
try {
  if ($Operation -eq 'Start') {
    $starter = Start-Process -FilePath $Paths.Node -ArgumentList @("`"$($Paths.Cli)`"", 'daemon', 'start') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $Paths.LogDir 'tray-start.out.log') -RedirectStandardError (Join-Path $Paths.LogDir 'tray-start.err.log')
    try {
      # Keep this job in flight for the lifetime of *our* starter. Closing the tray leaves it running.
      while (-not $starter.WaitForExit(250)) { }
      if ($starter.ExitCode -ne 0) { throw '启动失败，请检查 Node.js 和日志' }
    } finally { $starter.Dispose() }
    return @{ success = $true }
  }
  if ($Operation -in @('Discover', 'Attach', 'Detach')) {
    $cliArgs = switch ($Operation) {
      'Discover' { @('cdp', 'list') }
      'Attach' { @('cdp', 'attach', $Target) }
      'Detach' { @('cdp', 'detach', $Target) }
    }
    $output = (& $Paths.Node $Paths.Cli @cliArgs '--json' 2>$null | Out-String).Trim()
    return ($output | ConvertFrom-Json)
  }

  $info = Get-Content -Raw -LiteralPath $Paths.DaemonFile | ConvertFrom-Json
  $url = "http://$($info.host):$($info.port)"
  $headers = @{ Authorization = "Bearer $($info.token)" }
  if ($Operation -eq 'Health') {
    $status = Invoke-RestMethod -Method Get -Uri "$url/api/tray-status" -Headers $headers -TimeoutSec 2
    if ($status.running -isnot [bool] -or $status.cdpConnected -isnot [bool] -or $null -eq $status.connectedBrowserCount) {
      return @{ success = $false; error = '后台返回的托盘状态无效' }
    }
    return @{ success = $true; data = $status; retryable = -not $status.running }
  }

  if ($Operation -eq 'RestoreExternal') {
    $statusCmd = @{ id = [guid]::NewGuid().ToString(); action = 'browser_mode'; modeAction = 'status' }
    $statusResp = Invoke-RestMethod -Method Post -Uri "$url/command" -Headers $headers -ContentType 'application/json' -Body ($statusCmd | ConvertTo-Json -Compress) -TimeoutSec 2
    $modes = @()
    if ($statusResp.success -and $statusResp.data -and $statusResp.data.browserModes) {
      $modes = @($statusResp.data.browserModes | Where-Object { $_ })
    }
    $externalHidden = @($modes | Where-Object { -not $_.managed -and $_.connected -and $_.canStealth -and $_.mode -eq 'headless' })
    foreach ($b in $externalHidden) {
      $restoreCmd = @{ id = [guid]::NewGuid().ToString(); action = 'browser_mode'; modeAction = 'headed'; browser = [string]$b.id; focus = $false }
      try {
        Invoke-RestMethod -Method Post -Uri "$url/command" -Headers $headers -ContentType 'application/json' -Body ($restoreCmd | ConvertTo-Json -Compress) -TimeoutSec 3 | Out-Null
      } catch { }
    }
    return @{ success = $true; restoredCount = $externalHidden.Count }
  }

  if ($Operation -eq 'ToggleAll') {
    $statusCmd = @{ id = [guid]::NewGuid().ToString(); action = 'browser_mode'; modeAction = 'status' }
    $statusResp = Invoke-RestMethod -Method Post -Uri "$url/command" -Headers $headers -ContentType 'application/json' -Body ($statusCmd | ConvertTo-Json -Compress) -TimeoutSec 3
    $modes = @()
    if ($statusResp.success -and $statusResp.data -and $statusResp.data.browserModes) {
      $modes = @($statusResp.data.browserModes | Where-Object { $_ })
    }
    $controllable = @($modes | Where-Object { $_.connected -and $_.canToggle })
    $action = $null
    $targetBrowser = $null
    if ($controllable.Count -gt 0) {
      $anyVisible = @($controllable | Where-Object { $_.mode -eq 'headed' }).Count -gt 0
      $action = if ($anyVisible) { 'headless' } else { 'headed' }
      $targetBrowser = 'all'
    } elseif ($statusResp.success -and $statusResp.data -and $statusResp.data.browserMode -and $statusResp.data.browserMode.connected -and $statusResp.data.browserMode.mode) {
      $action = if ($statusResp.data.browserMode.mode -eq 'headless') { 'headed' } else { 'headless' }
    } else {
      return @{ success = $false; error = '没有可切换窗口显隐的已连接浏览器' }
    }
    $cmd = @{ id = [guid]::NewGuid().ToString(); action = 'browser_mode'; modeAction = $action }
    if ($targetBrowser) { $cmd.browser = $targetBrowser }
    if ($action -eq 'headed') { $cmd.focus = $true }
    $res = Invoke-RestMethod -Method Post -Uri "$url/command" -Headers $headers -ContentType 'application/json' -Body ($cmd | ConvertTo-Json -Compress) -TimeoutSec 40
    return @{ success = $res.success; data = $res.data; error = $res.error; appliedAction = $action }
  }

  $action = if ($Operation -eq 'ModeStatus') { 'status' } else { $Target }
  $command = @{ id = [guid]::NewGuid().ToString(); action = 'browser_mode'; modeAction = $action }
  if ($Browser) { $command.browser = $Browser }
  if ($action -eq 'headed') { $command.focus = $true }
  $timeout = if ($action -eq 'status') { 3 } else { 40 }
  return (Invoke-RestMethod -Method Post -Uri "$url/command" -Headers $headers -ContentType 'application/json' -Body ($command | ConvertTo-Json -Compress) -TimeoutSec $timeout)
} catch {
  $failure = $_.Exception
  $code = [int]$failure.Response.StatusCode
  $message = switch ($code) {
    401 { '后台认证失败，请检查发现文件' }
    403 { '后台拒绝访问，请检查权限' }
    404 { '后台不支持此接口，请更新后台' }
    default { $failure.Message }
  }
  # A responding HTTP service (e.g. an older daemon) must not trigger a competing start.
  return @{ success = $false; error = $message; retryable = ($code -eq 0); missing = ($_.Exception -is [System.Management.Automation.ItemNotFoundException]) }
}
