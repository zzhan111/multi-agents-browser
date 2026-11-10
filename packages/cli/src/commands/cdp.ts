/**
 * cdp 命令 - 发现 / 接管本机已开启 remote debugging 的浏览器
 * 用法：
 *   ma-browser cdp [list]                       发现本机可控 CDP（含是否已被 daemon 接管）
 *   ma-browser cdp attach <port|host:port|url>  接管指定浏览器（不重启、不关闭它）
 *   ma-browser cdp attach --all                 接管全部已发现的浏览器（并行）
 *   ma-browser cdp detach <id>                  停止接管（浏览器继续运行）
 *   --allow-remote                              允许非本机 host
 */

import {
  discoverCdpEndpoints,
  generateId,
  isLoopbackHost,
  parseCdpAddress,
  type BrowserInfo,
  type Request,
  type Response,
} from "@ma-browser/shared";
import { sendCommand } from "../client.js";
import { isDaemonRunning } from "../daemon-manager.js";
import { preferCdpEndpoint } from "../cdp-discovery.js";

export interface CdpOptions {
  json?: boolean;
}

function formatBrowsers(browsers: BrowserInfo[]): string {
  if (browsers.length === 0) {
    return "未发现可控浏览器。用 --remote-debugging-port=9222 --user-data-dir=<目录> 启动 Chrome 后重试。";
  }
  const lines = [`发现 ${browsers.length} 个浏览器：`];
  for (const b of browsers) {
    const state = b.attached
      ? `${b.connected ? "已接管" : "已接管·断开重连中"}${b.default ? "·默认" : ""}`
      : "可接管";
    const kind = b.managed ? "受管" : b.managed === false ? "用户" : "";
    const tabs = b.tabs !== undefined ? ` ${b.tabs} tabs` : "";
    lines.push(`  ${b.id.padEnd(6)} [${state}] ${kind ? `${kind} ` : ""}${b.browser ?? b.chromeVersion ?? ""}${tabs}`);
    if (b.userDataDir) lines.push(`         profile: ${b.userDataDir}`);
    if (b.lastError) lines.push(`         error: ${b.lastError}`);
  }
  return lines.join("\n");
}

async function listLocally(): Promise<Response> {
  const found = await discoverCdpEndpoints({ thorough: true });
  const browsers: BrowserInfo[] = found.map((ep) => ({
    id: ep.id,
    host: ep.host,
    port: ep.port,
    browser: ep.browser,
    managed: ep.managed,
    userDataDir: ep.userDataDir,
    pid: ep.pid,
    tabs: ep.tabs,
    attached: false,
    connected: false,
    default: false,
  }));
  return { id: generateId(), success: true, data: { browsers } };
}

export async function cdpCommand(args: string[], options: CdpOptions = {}): Promise<void> {
  const sub = args[0] ?? "list";
  const allowRemote = process.argv.includes("--allow-remote");
  let response: Response;

  if (sub === "list") {
    // Listing needs no daemon; don't spawn one (and maybe a managed browser) just to look.
    response = (await isDaemonRunning())
      ? await sendCommand({ id: generateId(), action: "cdp_list" })
      : await listLocally();
  } else if (sub === "attach") {
    const all = process.argv.includes("--all");
    const target = args[1];
    if (!all && !target) {
      throw new Error("用法：ma-browser cdp attach <port|host:port|url> | --all [--allow-remote]");
    }
    if (target && !(await isDaemonRunning())) {
      // Cold start: make the requested browser the daemon's default instead of a managed launch.
      const addr = parseCdpAddress(target);
      if (addr && (allowRemote || isLoopbackHost(addr.host))) preferCdpEndpoint(addr);
    }
    const request: Request = { id: generateId(), action: "cdp_attach", ...(all ? { all: true } : { browser: target }), allowRemote };
    response = await sendCommand(request);
  } else if (sub === "detach") {
    if (!args[1]) throw new Error("用法：ma-browser cdp detach <id>");
    response = await sendCommand({ id: generateId(), action: "cdp_detach", browser: args[1] });
  } else {
    throw new Error(`未知的 cdp 子命令: ${sub}（可用：list, attach, detach）`);
  }

  if (options.json) {
    console.log(JSON.stringify(response, null, 2));
    if (!response.success) process.exitCode = 1;
    return;
  }
  if (!response.success) {
    console.error(`错误: ${response.error}`);
    process.exit(1);
  }
  const data = response.data as Record<string, unknown> & { browsers?: BrowserInfo[] };
  if (sub === "attach") {
    const attached = (data.attached as string[] | undefined) ?? [];
    const failed = (data.failed as Array<{ id: string; error: string }> | undefined) ?? [];
    if (data.already) console.log(`浏览器 ${data.browser} 已在接管中`);
    if (attached.length) console.log(`已接管: ${attached.join(", ")}`);
    for (const f of failed) console.error(`接管 ${f.id} 失败: ${f.error}`);
    if (!data.already && !attached.length && !failed.length) console.log("没有新的浏览器需要接管");
  } else if (sub === "detach") {
    console.log(`已停止接管 ${data.detached}（浏览器仍在运行）`);
  }
  console.log(formatBrowsers(data.browsers ?? []));
}
