import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { httpJson, readDaemonJson } from "./daemon-client.js";

export type BrowserModeAction = "status" | "headed" | "headless";

export interface BrowserModeStatus {
  mode: "headed" | "headless" | null;
  connected: boolean;
  trayRunning: boolean;
  changed?: boolean;
}

/** The Windows tray owns mode changes; wait for it to reconnect the browser. */
export async function browserMode(action: BrowserModeAction, sessionId = process.env.BB_SESSION_ID ?? "default"): Promise<BrowserModeStatus> {
  if (process.platform !== "win32") {
    throw new Error("浏览器模式切换需要 Windows 托盘。");
  }
  if (action !== "status") {
    if (process.env.BB_SESSION_SCOPE === "read-only") throw new Error("只读会话不能切换浏览器模式。");
    const info = await readDaemonJson();
    if (!info) throw new Error("无法确认会话权限：后台未运行。");
    const status = await httpJson<{ sessions?: Array<{ id: string; scope?: string }> }>("GET", "/status", info, undefined, 2000);
    if (status.sessions?.some((session) => session.id === sessionId && session.scope === "read-only")) {
      throw new Error("只读会话不能切换浏览器模式。");
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const script = [
    resolve(here, "../scripts/windows-mode.ps1"),
    resolve(here, "../../../scripts/windows-mode.ps1"),
  ].find(existsSync);
  if (!script) throw new Error("找不到 Windows 浏览器模式脚本，请重新安装 ma-browser。");

  try {
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", action],
      { windowsHide: true, timeout: 47_000, encoding: "utf8" },
    );
    return JSON.parse(stdout) as BrowserModeStatus;
  } catch (error) {
    const failure = error as Error & { stderr?: string; killed?: boolean };
    if (failure.killed) throw new Error("等待浏览器模式切换超时，请先查询当前模式。");
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}
