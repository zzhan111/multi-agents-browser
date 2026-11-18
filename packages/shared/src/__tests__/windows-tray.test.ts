import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const trayPath = fileURLToPath(new URL("../../../../scripts/windows-tray.ps1", import.meta.url));
const workerPath = fileURLToPath(new URL("../../../../scripts/windows-tray-worker.ps1", import.meta.url));
const modePath = fileURLToPath(new URL("../../../../scripts/windows-mode.ps1", import.meta.url));
const checkPath = fileURLToPath(new URL("../../../../scripts/check-windows-tray.ps1", import.meta.url));
const packagePath = fileURLToPath(new URL("../../../../package.json", import.meta.url));
const tray = readFileSync(trayPath, "utf8").replace(/^\uFEFF/, "");
const worker = readFileSync(workerPath, "utf8").replace(/^\uFEFF/, "");
const windows = process.platform === "win32";
const psLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

function powershell(source: string): void {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${source}`, "utf16le").toString("base64");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    timeout: 20000,
    windowsHide: true,
    stdio: "pipe",
  });
}

const loadFunctions = `
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psLiteral(trayPath)}, [ref]$null, [ref]$parseErrors)
if ($parseErrors) { throw ($parseErrors | Out-String) }
foreach ($fn in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  . ([scriptblock]::Create($fn.Extent.Text))
}
`;

test("tray scripts keep UTF-8 BOM and LF and ship their worker", () => {
  for (const path of [trayPath, workerPath, modePath, checkPath]) {
    const raw = readFileSync(path);
    assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], path);
    assert.equal(raw.includes(0x0d), false, path);
  }
  assert.ok(JSON.parse(readFileSync(packagePath, "utf8")).files.includes("scripts/windows-tray-worker.ps1"));
});

test("tray delegates multi-browser focus/toggle, coalesces work, restores external windows, and polls authenticated summary", () => {
  assert.match(tray, /MouseButtons\]::Left\) \{ Toggle-AllBrowsers \}/);
  assert.match(tray, /function Toggle-AllBrowsers \{[\s\S]*?Request-TrayWork 'ToggleAll'/);
  assert.match(tray, /function Switch-BrowserMode\(\[string\]\$target, \[string\]\$browser = ''\)/);
  assert.match(tray, /Request-TrayWork 'RestoreExternal'/);
  assert.match(tray, /Request-TrayWork 'Detach'/);
  assert.match(tray, /\$pending\.ContainsKey\(\$operation\)/);
  assert.match(tray, /Add_Opening\(\{[^\n]*Request-TrayWork 'ModeStatus'/);
  assert.match(tray, /Add_Tick\(\{ Request-TrayWork 'Health' \}\)/);
  assert.match(worker, /Method Get -Uri "\$url\/api\/tray-status" -Headers \$headers/);
  assert.match(worker, /Authorization = "Bearer \$\(\$info\.token\)"/);
  assert.match(worker, /\$command\.focus = \$true/);
  assert.match(worker, /\$cmd\.browser = \$targetBrowser/);
  assert.match(worker, /\$Operation -eq 'RestoreExternal'/);
  assert.doesNotMatch(tray + worker, /Get-Process|Get-CimInstance|browser-pid|SetForegroundWindow|\/shutdown|Browser\.close/);
  assert.doesNotMatch(worker, /\$url\/status/);
  assert.match(tray, /DestroyIcon\(\$handle\)/);
  assert.match(tray, /\$icon\.Dispose\(\)/);
});

test("worker uses authenticated summary, classifies failures, toggles all controllable browsers, and restores external windows", { skip: !windows }, () => {
  powershell(`
$state = @{ scenario = 'ok'; requests = (New-Object System.Collections.Generic.List[object]) }
$requests = $state.requests
function Get-Content { param([switch]$Raw, $LiteralPath) '{"host":"fixture.invalid","port":12345,"token":"fixture"}' }
function Invoke-RestMethod {
  param($Method, $Uri, $Headers, $TimeoutSec, $Body, $ContentType)
  $requests.Add(@{ method = $Method; uri = $Uri; headers = $Headers; body = $Body }) | Out-Null
  if ($state.scenario -eq 'timeout') { throw 'fixture timeout' }
  if ($state.scenario -eq '404') {
    $e = New-Object System.Exception('fixture old daemon')
    $e | Add-Member -NotePropertyName Response -NotePropertyValue ([pscustomobject]@{ StatusCode = 404 })
    throw $e
  }
  if ($Method -eq 'Get') { return @{ running = $true; cdpConnected = $true; connectedBrowserCount = 3 } }
  $parsed = if ($Body) { $Body | ConvertFrom-Json } else { $null }
  if ($parsed -and $parsed.modeAction -eq 'status') {
    if ($state.scenario -eq 'restore') {
      return @{
        success = $true
        data = @{
          browserModes = @(
            @{ id = '19825'; managed = $true; connected = $true; canStealth = $true; canToggle = $true; mode = 'headless' },
            @{ id = '9222'; managed = $false; connected = $true; canStealth = $true; canToggle = $true; mode = 'headless' }
          )
        }
      }
    }
    return @{
      success = $true
      data = @{
        browserMode = @{ mode = 'headless'; connected = $true }
        browserModes = @(
          @{ id = '19825'; managed = $true; connected = $true; canStealth = $true; canToggle = $true; mode = 'headless' },
          @{ id = '9222'; managed = $false; connected = $true; canStealth = $true; canToggle = $true; mode = 'headed' },
          @{ id = '9333'; managed = $false; connected = $true; canStealth = $false; canToggle = $false; mode = 'headed' }
        )
      }
    }
  }
  return @{ success = $true; data = @{ browserMode = @{ mode = $parsed.modeAction; connected = $true; windowFocused = $false } } }
}
$paths = @{ DaemonFile = 'fixture' }
$r = & ${psLiteral(workerPath)} -Operation Health -Paths $paths
if (-not $r.success -or $r.data.connectedBrowserCount -ne 3) { throw 'health result' }
if ($requests.Count -ne 1 -or $requests[0].uri -ne 'http://fixture.invalid:12345/api/tray-status' -or $requests[0].headers.Authorization -ne 'Bearer fixture') { throw 'health request' }

$r = & ${psLiteral(workerPath)} -Operation Switch -Target headed -Browser 9222 -Paths $paths
$body = $requests[$requests.Count - 1].body | ConvertFrom-Json
if (-not $body.focus -or $body.modeAction -ne 'headed' -or $body.browser -ne '9222' -or $r.data.browserMode.windowFocused) { throw 'focus response' }

$r = & ${psLiteral(workerPath)} -Operation ToggleAll -Paths $paths
$toggleBody = $requests[$requests.Count - 1].body | ConvertFrom-Json
if (-not $r.success -or $r.appliedAction -ne 'headless' -or $toggleBody.modeAction -ne 'headless' -or $toggleBody.browser -ne 'all') { throw 'toggleAll should hide when any controllable browser is visible' }

$state.scenario = 'restore'
$r = & ${psLiteral(workerPath)} -Operation RestoreExternal -Paths $paths
$restoreBody = $requests[$requests.Count - 1].body | ConvertFrom-Json
if (-not $r.success -or $r.restoredCount -ne 1 -or $restoreBody.browser -ne '9222' -or $restoreBody.modeAction -ne 'headed' -or $restoreBody.focus) { throw 'restoreExternal must only unhide external stealth browsers without stealing focus' }

$state.scenario = 'timeout'
$r = & ${psLiteral(workerPath)} -Operation Health -Paths $paths
if ($r.success -or -not $r.retryable) { throw 'timeout classification' }
$state.scenario = '404'
$r = & ${psLiteral(workerPath)} -Operation Health -Paths $paths
if ($r.success -or $r.retryable -or $r.error -notmatch '不支持') { throw 'old daemon classification' }
`);
});

test("delayed substitute jobs keep the UI thread responsive, coalesce, discard stale results, and render multi-browser menu", { skip: !windows }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ma-tray-fixture-"));
  try {
    const fakeWorker = join(dir, "fake-worker.ps1");
    writeFileSync(
      fakeWorker,
      `param($Operation, $Paths, $Target, $Browser)
Start-Sleep -Milliseconds 900
@{
  success = $true
  data = @{
    browserMode = @{ connected = $true; mode = 'headless'; backend = 'stealth' }
    browserModes = @(
      @{ id = '19825'; label = '受管'; tabs = 2; connected = $true; canToggle = $true; mode = 'headless' },
      @{ id = '9222'; label = 'Chrome-7890'; tabs = 1; connected = $true; canToggle = $true; mode = 'headed' },
      @{ id = '9333'; label = 'User Data'; tabs = 3; connected = $true; canToggle = $false; mode = 'headed'; readonlyReason = '共用目录' }
    )
  }
}
`,
    );
    powershell(`${loadFunctions}
Add-Type -AssemblyName System.Windows.Forms
Initialize-TrayInterop
$pool = [RunspaceFactory]::CreateRunspacePool(1, 4); $pool.Open()
$workerPath = ${psLiteral(fakeWorker)}; $paths = @{}; $pending = @{}
$script:closing = $false; $script:modeVersion = 0; $script:cdpVersion = 0
$script:cachedMode = $null; $script:cachedBrowsers = @()
$script:dynamicBrowserItems = New-Object System.Collections.Generic.List[System.Windows.Forms.ToolStripItem]
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$showAllItem = $menu.Items.Add('显示全部浏览器')
$hideAllItem = $menu.Items.Add('隐藏全部浏览器')
$sepBulk = New-Object System.Windows.Forms.ToolStripSeparator
$menu.Items.Add($sepBulk) | Out-Null
$sepMgmt = New-Object System.Windows.Forms.ToolStripSeparator
$menu.Items.Add($sepMgmt) | Out-Null
$completionTimer = [pscustomobject]@{}
$completionTimer | Add-Member ScriptMethod Start { }
$completionTimer | Add-Member ScriptMethod Stop { }
$clock = [Diagnostics.Stopwatch]::StartNew()
Request-TrayWork 'ModeStatus'
Request-TrayWork 'ModeStatus'
if ($clock.ElapsedMilliseconds -gt 700 -or $pending.Count -ne 1) { throw 'UI blocked or duplicate work started' }
$script:modeVersion++
while (-not $pending.ModeStatus.Async.IsCompleted) { Start-Sleep -Milliseconds 20 }
Receive-TrayWork
if ($script:cachedMode -or $script:cachedBrowsers.Count -ne 0) { throw 'stale mode overwrote current state' }
Request-TrayWork 'ModeStatus'
while (-not $pending.ModeStatus.Async.IsCompleted) { Start-Sleep -Milliseconds 20 }
Receive-TrayWork
if ($script:cachedMode.mode -ne 'headless' -or $script:dynamicBrowserItems.Count -ne 3) { throw 'fresh mode not applied on UI thread' }
if (-not $showAllItem.Available -or -not $showAllItem.Enabled -or -not $hideAllItem.Enabled) { throw 'bulk toggle items not updated' }
if (-not $script:dynamicBrowserItems[0].Enabled -or $script:dynamicBrowserItems[2].Enabled) { throw 'controllable vs readonly browser item state wrong' }
Request-TrayWork 'ModeStatus'
$watch = [Diagnostics.Stopwatch]::StartNew()
foreach ($job in $pending.Values) { [MaTrayResources]::StopWorker($job.Pipeline) }
[MaTrayResources]::ClosePool($pool)
$menu.Dispose()
if ($watch.ElapsedMilliseconds -gt 700) { throw 'exit blocked by background work' }
`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("health failure recovery ignores stale PID and never starts on 404", { skip: !windows }, () => {
  powershell(`${loadFunctions}
Add-Type -AssemblyName System.Windows.Forms
$pending = @{}; $script:closing = $false; $script:cachedMode = $null; $script:cachedBrowsers = @()
$script:modeVersion = 0; $script:healthFailures = 0; $script:lastStart = [DateTime]::MinValue
$script:dynamicBrowserItems = New-Object System.Collections.Generic.List[System.Windows.Forms.ToolStripItem]
$statusItem = [pscustomobject]@{ Text = '' }; $tray = [pscustomobject]@{ Text = '' }
$script:starts = 0
function Request-TrayWork([string]$operation, [string]$target) { if ($operation -eq 'Start') { $script:starts++ } }
Set-TrayHealth @{ success = $false; retryable = $false; error = '后台不支持此接口，请更新后台' }
if ($script:starts -ne 0 -or $statusItem.Text -notmatch '不支持') { throw '404 must not start another daemon' }
Set-TrayHealth @{ success = $false; retryable = $true; error = 'timeout' }
if ($script:starts -ne 0) { throw 'transient failure started daemon' }
Set-TrayHealth @{ success = $false; retryable = $true; error = 'timeout' }
if ($script:starts -ne 1) { throw 'sustained failure did not trigger recovery' }
Set-TrayHealth @{ success = $true; data = @{ running = $true; cdpConnected = $false; connectedBrowserCount = 2 } }
if ($script:healthFailures -ne 0 -or $statusItem.Text -notmatch '2') { throw 'health recovery or connected count' }
`);
});
