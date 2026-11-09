import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 托盘只能在 Windows 交互桌面上实测（见 README 的手工验证步骤）；这里在任意平台锁定脚本契约。
const tray = readFileSync(fileURLToPath(new URL("../../../../scripts/windows-tray.ps1", import.meta.url)), "utf8");

function body(name: string): string {
  const start = tray.search(new RegExp(`\\nfunction ${name}\\b[^\\n]*\\{\\n`));
  assert.ok(start >= 0, `missing function ${name}`);
  const end = tray.indexOf("\n}\n", start);
  return tray.slice(start, end);
}

test("left click on the tray icon opens the show-window flow; right click keeps the menu", () => {
  assert.match(tray, /\$tray\.Add_MouseClick\(\{[\s\S]*?MouseButtons\]::Left\) \{ Show-BrowserWindow \}/);
  assert.match(tray, /\$tray\.ContextMenuStrip = \$menu/);
  for (const item of ["切换浏览器模式", "打开日志目录", "退出托盘（后台继续运行）"]) assert.ok(tray.includes(`'${item}'`), item);
});

test("show-window always confirms before touching the browser and words the prompt by mode", () => {
  const fn = body("Show-BrowserWindow");
  const confirm = fn.indexOf("MessageBox]::Show(");
  assert.ok(confirm > 0);
  assert.ok(fn.indexOf("DialogResult]::Yes) { return }") > confirm, "cancel must return before acting");
  for (const action of ["Invoke-BrowserFront", "Switch-BrowserMode"]) assert.ok(fn.indexOf(action) > confirm, `${action} runs only after confirmation`);
  assert.ok(fn.includes("'显示 ma-browser 窗口？'"));
  assert.ok(fn.includes("当前为无头模式。是否切换为有头并显示窗口？（会重启受管浏览器）"));
  assert.ok(fn.includes("是否将受管浏览器窗口置于前台？"));
  assert.match(fn, /if \(\$script:prompting\) \{ return \}/, "repeated clicks must not stack dialogs");
});

test("headless confirmation reuses the existing mode switch and fronts the new window", () => {
  assert.match(body("Show-BrowserWindow"), /Switch-BrowserMode 'headed'[\s\S]*frontDeadline = \(Get-Date\)\.AddSeconds/);
  assert.ok(body("Complete-PendingFront").includes("Invoke-BrowserFront"));
  assert.ok(body("Update-Tray").includes("Complete-PendingFront"));
});

test("failures surface as balloon tips", () => {
  assert.ok(body("Show-TrayError").includes("ShowBalloonTip"));
  const fn = body("Show-BrowserWindow");
  assert.ok(fn.includes("未找到受管浏览器"));
  assert.ok(fn.includes("Show-TrayError 'ma-browser 窗口置前失败'"));
  assert.ok(body("Complete-PendingFront").includes("等待有头浏览器窗口超时"));
});
