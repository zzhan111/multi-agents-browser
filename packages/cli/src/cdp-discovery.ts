import { readFile } from "node:fs/promises";
import { MANAGED_PORT_FILE, launchManagedBrowser } from "@ma-browser/shared";

// Browser-launch helpers live in @ma-browser/shared so the daemon can reuse
// them. Re-export findBrowserExecutable to preserve this module's public API.
export { findBrowserExecutable } from "@ma-browser/shared";

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function canConnect(host: string, port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    const response = await fetch(`http://${host}:${port}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

export async function isManagedBrowserRunning(): Promise<boolean> {
  try {
    const rawPort = await readFile(MANAGED_PORT_FILE, "utf8");
    const port = Number.parseInt(rawPort.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      return false;
    }
    return await canConnect("127.0.0.1", port);
  } catch {
    return false;
  }
}

export async function discoverCdpPort(): Promise<{ host: string; port: number } | null> {
  // 优先级1: 环境变量 BB_BROWSER_CDP_URL（最快，零延迟）
  const envUrl = process.env.BB_BROWSER_CDP_URL;
  if (envUrl) {
    try {
      const url = new URL(envUrl);
      const port = Number(url.port);
      if (Number.isInteger(port) && port > 0 && await canConnect(url.hostname, port)) {
        return { host: url.hostname, port };
      }
    } catch {}
  }

  // 优先级2: 命令行 --port
  const explicitPort = Number.parseInt(getArgValue("--port") ?? "", 10);
  if (Number.isInteger(explicitPort) && explicitPort > 0 && await canConnect("127.0.0.1", explicitPort)) {
    return { host: "127.0.0.1", port: explicitPort };
  }

  try {
    const rawPort = await readFile(MANAGED_PORT_FILE, "utf8");
    const managedPort = Number.parseInt(rawPort.trim(), 10);
    if (Number.isInteger(managedPort) && managedPort > 0 && await canConnect("127.0.0.1", managedPort)) {
      return { host: "127.0.0.1", port: managedPort };
    }
  } catch {
  }

  // 优先级3: 自动启动浏览器
  const launched = await launchManagedBrowser();
  if (launched) {
    return launched;
  }

  return null;
}
