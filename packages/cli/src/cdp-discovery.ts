import { readFile } from "node:fs/promises";
import {
  MANAGED_PORT_FILE,
  envCdpAddresses,
  inspectCdp,
  resolveCdpEndpoint,
  type CdpAddress,
} from "@ma-browser/shared";

// Browser-launch helpers live in @ma-browser/shared so the daemon can reuse
// them. Re-export findBrowserExecutable to preserve this module's public API.
export { findBrowserExecutable } from "@ma-browser/shared";

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

export async function isManagedBrowserRunning(): Promise<boolean> {
  try {
    const rawPort = await readFile(MANAGED_PORT_FILE, "utf8");
    const port = Number.parseInt(rawPort.trim(), 10);
    if (!Number.isInteger(port) || port <= 0) {
      return false;
    }
    return (await inspectCdp("127.0.0.1", port)) !== null;
  } catch {
    return false;
  }
}

const preferred: CdpAddress[] = [];

/** Make a cold daemon start use `addr` as its default browser (`cdp attach` before the daemon runs). */
export function preferCdpEndpoint(addr: CdpAddress): void {
  preferred.push(addr);
}

/**
 * Pick the CDP endpoint for a cold daemon start. Same policy as the daemon's
 * bring-up loop (see resolveCdpEndpoint): BB_BROWSER_CDP_URL[S] / --port >
 * running managed browser > discovered browser > managed launch.
 */
export async function discoverCdpPort(): Promise<{ host: string; port: number } | null> {
  const explicit: CdpAddress[] = [...preferred, ...envCdpAddresses()];
  const explicitPort = Number.parseInt(getArgValue("--port") ?? "", 10);
  if (Number.isInteger(explicitPort) && explicitPort > 0) {
    explicit.push({ host: "127.0.0.1", port: explicitPort });
  }
  const resolved = await resolveCdpEndpoint({ explicit });
  return resolved ? { host: resolved.host, port: resolved.port } : null;
}
