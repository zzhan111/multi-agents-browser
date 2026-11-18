import { clientCommandTimeoutMs } from "./command-timeouts.js";
import { DaemonTimeoutError, httpJson, readDaemonJson } from "./daemon-client.js";
import { generateId, type BrowserModeInfo, type BrowserWindowModeInfo, type Request, type Response } from "./protocol.js";
import { windowsStealth } from "./windows-stealth.js";

export type BrowserModeAction = "status" | "headed" | "headless";

export type BrowserModeStatus = BrowserModeInfo;

export interface BrowserModeOptions {
  /** Bring the browser window to the foreground when switching to or already in `headed` mode. */
  focus?: boolean;
  /** Force Chromium `--headless=new` hot-swap instead of Windows zero-restart stealth mode. */
  nativeHeadless?: boolean;
  /** Target a specific browser ID or "all". */
  browser?: string;
}

async function detectTrayRunning(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const res = await windowsStealth.status(0);
    return res.trayRunning;
  } catch {
    return false;
  } finally {
    // Close the helper in short-lived CLI callers so stdio listeners never hold the event loop open.
    windowsStealth.close();
  }
}

/**
 * Query or switch the managed browser between `headed` and `headless` modes
 * through the live daemon (zero-restart stealth window mode on Windows, or
 * hot-swap with logical tab rebinding as a fallback).
 */
export interface BrowserModeDetail {
  browserMode: BrowserModeStatus;
  browserModes?: BrowserWindowModeInfo[];
}

export async function browserModeDetail(
  action: BrowserModeAction,
  sessionId = process.env.BB_SESSION_ID ?? "default",
  options?: BrowserModeOptions,
): Promise<BrowserModeDetail> {
  if (action !== "status" && process.env.BB_SESSION_SCOPE === "read-only") {
    throw new Error("只读会话不能切换浏览器模式。");
  }

  const info = await readDaemonJson();
  if (!info) {
    if (action === "status") {
      return { browserMode: { mode: null, connected: false, trayRunning: await detectTrayRunning() } };
    }
    throw new Error("后台未运行，请先启动 ma-browser 或等待托盘启动后台。");
  }

  const request: Request = {
    id: generateId(),
    action: "browser_mode",
    modeAction: action,
    ...(options?.focus !== undefined ? { focus: options.focus } : {}),
    ...(options?.nativeHeadless !== undefined ? { nativeHeadless: options.nativeHeadless } : {}),
    ...(options?.browser !== undefined ? { browser: options.browser } : {}),
  };

  try {
    const resp = await httpJson<Response>(
      "POST",
      "/command",
      info,
      request,
      action === "status" ? 5_000 : clientCommandTimeoutMs(request),
      {
        resolveStatuses: [400, 403, 409, 503, 504],
        headers: { "X-BB-Session": sessionId },
      },
    );
    if (!resp.success || !resp.data?.browserMode) {
      throw new Error(resp.error || "浏览器模式切换失败。");
    }
    return {
      browserMode: resp.data.browserMode,
      ...(resp.data.browserModes ? { browserModes: resp.data.browserModes } : {}),
    };
  } catch (error) {
    if (action === "status" && !(error instanceof DaemonTimeoutError)) {
      const msg = error instanceof Error ? error.message : "";
      if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(msg)) {
        return { browserMode: { mode: null, connected: false, trayRunning: await detectTrayRunning() } };
      }
    }
    if (error instanceof DaemonTimeoutError) {
      throw new Error("等待浏览器模式切换超时，请先查询当前模式。");
    }
    throw error;
  }
}

export async function browserMode(
  action: BrowserModeAction,
  sessionId = process.env.BB_SESSION_ID ?? "default",
  options?: BrowserModeOptions,
): Promise<BrowserModeStatus> {
  return (await browserModeDetail(action, sessionId, options)).browserMode;
}
