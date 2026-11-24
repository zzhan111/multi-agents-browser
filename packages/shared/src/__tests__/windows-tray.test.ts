import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 托盘在任意平台锁定脚本契约与 UTF-8 BOM + LF 编码规范（见 learnings.md #21）。
const trayPath = fileURLToPath(new URL("../../../../scripts/windows-tray.ps1", import.meta.url));
const modePath = fileURLToPath(new URL("../../../../scripts/windows-mode.ps1", import.meta.url));
const checkPath = fileURLToPath(new URL("../../../../scripts/check-windows-tray.ps1", import.meta.url));

const tray = readFileSync(trayPath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");

function body(name: string): string {
  const start = tray.search(new RegExp(`\\nfunction ${name}\\b[^\\n]*\\{\\n`));
  assert.ok(start >= 0, `missing function ${name}`);
  const end = tray.indexOf("\n}\n", start);
  return tray.slice(start, end);
}

test("PowerShell scripts preserve UTF-8 BOM and LF line endings", () => {
  for (const p of [trayPath, modePath, checkPath]) {
    const raw = readFileSync(p);
    assert.equal(raw[0], 0xef, `${p} missing UTF-8 BOM byte 0`);
    assert.equal(raw[1], 0xbb, `${p} missing UTF-8 BOM byte 1`);
    assert.equal(raw[2], 0xbf, `${p} missing UTF-8 BOM byte 2`);
    assert.equal(raw.includes(0x0d), false, `${p} must use LF line endings, not CRLF`);
  }
});

test("left click triggers one-click instant pop-up; right click keeps the context menu", () => {
  assert.match(tray, /\$tray\.Add_MouseClick\(\{[\s\S]*?MouseButtons\]::Left\) \{ Show-BrowserWindow \}/);
  assert.match(tray, /\$tray\.ContextMenuStrip = \$menu/);
  for (const item of ["切换浏览器模式", "打开日志目录", "退出托盘（后台继续运行）"]) {
    assert.ok(tray.includes(`'${item}'`), item);
  }
});

test("Show-BrowserWindow pops up immediately without a confirmation dialog and guards re-entrant clicks", () => {
  const fn = body("Show-BrowserWindow");
  assert.equal(fn.includes("MessageBox"), false, "left-click must not block on a confirmation MessageBox");
  assert.match(fn, /if \(\$script:showing\) \{ return \}/, "repeated clicks must not overlap");
  assert.match(fn, /Switch-BrowserMode 'headed' -Focus/);
  assert.ok(fn.includes("Invoke-BrowserFront"));
});

test("mode switches delegate to the live daemon without shutting it down or closing Chrome from the tray", () => {
  assert.equal(tray.includes("/shutdown"), false, "tray mode switch must never shut down the daemon");
  assert.equal(tray.includes("Browser.close"), false, "tray mode switch must not close Chrome directly");
  assert.ok(body("Invoke-DaemonMode").includes("action = 'browser_mode'"));

  const menuFn = body("Update-ModeMenu");
  assert.ok(menuFn.includes("切换为无头浏览器（隐藏窗口）"));
  assert.ok(menuFn.includes("显示窗口"));
  assert.equal(menuFn.includes("将重启浏览器"), false, "menu must not falsely claim every switch restarts Chrome");
});

test("failures surface as balloon tips", () => {
  assert.ok(body("Show-TrayError").includes("ShowBalloonTip"));
  const fn = body("Show-BrowserWindow");
  assert.ok(fn.includes("Show-TrayError '无法显示 ma-browser 窗口'"));
  assert.ok(fn.includes("Show-TrayError 'ma-browser 窗口置前失败'"));
  assert.ok(body("Complete-PendingFront").includes("等待有头浏览器窗口超时"));
});

test("hidden tray mode registers global Ctrl+Alt+Shift+M hotkey and single-instance restore signal", () => {
  assert.ok(tray.includes("'隐藏托盘图标（Ctrl+Alt+Shift+M 恢复）'"));
  assert.ok(tray.includes("RegisterHotKey"));
  assert.ok(tray.includes("UnregisterHotKey"));
  assert.ok(tray.includes("WM_HOTKEY = 0x0312"));
  assert.ok(tray.includes("Local\\ma-browser-tray-restore"));

  const enterFn = body("Enter-HiddenMode");
  assert.ok(enterFn.includes("Ensure-RestoreHotkey"), "must verify hotkey registration before hiding");
  assert.ok(enterFn.includes("$tray.Visible = $false"), "must hide the tray icon");
  assert.ok(enterFn.includes("Show-TrayError '无法进入隐藏模式'"), "must warn and abort if hotkey fails");

  const restoreFn = body("Restore-TrayIcon");
  assert.ok(restoreFn.includes("$tray.Visible = $true"), "must restore the tray icon");
  assert.ok(restoreFn.includes("ma-browser 已恢复常驻"), "must notify when restored from hidden mode");

  assert.match(tray, /finally\s*\{[\s\S]*?\$script:hotkeyWindow\.Dispose\(\)/);
});

test("tray menu supports toggling Windows sign-in autostart", () => {
  assert.ok(tray.includes("'开机自启'"));
  assert.ok(tray.includes("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"));
  assert.ok(body("Test-TrayAutostart").includes("windows-tray\\.ps1"));
  assert.ok(body("Set-TrayAutostart").includes("Set-ItemProperty"));
  assert.ok(body("Set-TrayAutostart").includes("Remove-ItemProperty"));
  assert.ok(body("Toggle-TrayAutostart").includes("Set-TrayAutostart"));
});
