import { ensureDaemon, getDaemonStatus, stopDaemon } from "../daemon-manager.js";

export interface DaemonOptions {
  json?: boolean;
}

export async function statusCommand(
  options: DaemonOptions = {}
): Promise<void> {
  const status = await getDaemonStatus();

  if (!status) {
    if (options.json) {
      console.log(JSON.stringify({ running: false }));
    } else {
      console.log("Daemon not running");
      console.log("\n\u{1F4A1} 启动: ma-browser daemon start");
    }
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // Human-readable output
  console.log(`Daemon running: ${status.running ? "yes" : "no"}`);
  console.log(`CDP connected:  ${status.cdpConnected ? "yes" : "no"}`);
  console.log(`Uptime:         ${formatUptime(status.uptime as number)}`);
  console.log(`Global seq:     ${status.currentSeq ?? "N/A"}`);
  const health = status.health as HealthView | undefined;
  for (const line of formatHealth(health)) console.log(line);

  const tabs = status.tabs as Array<{
    shortId: string;
    targetId: string;
    networkRequests: number;
    consoleMessages: number;
    jsErrors: number;
    lastActionSeq: number;
  }> | undefined;

  if (tabs && tabs.length > 0) {
    console.log(`\nTabs (${tabs.length}):`);
    for (const tab of tabs) {
      const active = tab.targetId === status.currentTargetId ? " *" : "";
      console.log(
        `  ${tab.shortId}${active}  net:${tab.networkRequests} console:${tab.consoleMessages} err:${tab.jsErrors} seq:${tab.lastActionSeq}`
      );
    }
  } else {
    console.log("\nNo tabs");
  }

  if (health && health.state !== "ok" && health.hint) {
    console.log(`\n⚠️ ${health.hint}`);
  } else if (status.cdpConnected === false) {
    console.log("\n⚠️ Chrome 未连接。运行 ma-browser daemon stop && ma-browser tab list 重新启动");
  } else {
    console.log("\n\u{1F4A1} 停止: ma-browser daemon stop");
  }
}

export async function startCommand(
  options: DaemonOptions = {}
): Promise<void> {
  await ensureDaemon();
  const status = await getDaemonStatus();
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log("Daemon started");
    if (status) {
      console.log(`CDP connected:  ${status.cdpConnected ? "yes" : "no"}`);
      const tabs = status.tabs as Array<{ shortId: string }> | undefined;
      console.log(`Tabs:           ${tabs?.length ?? 0}`);
    }
  }
}

export async function shutdownCommand(
  options: DaemonOptions = {}
): Promise<void> {
  const ok = await stopDaemon();
  if (options.json) {
    console.log(JSON.stringify({ stopped: ok }));
  } else {
    console.log(ok ? "Daemon stopped" : "Daemon was not running");
  }
}

/** Subset of the daemon's /status `health` block rendered by `status`. */
export interface HealthView {
  state: "ok" | "degraded" | "stalled" | "disconnected";
  reasons?: string[];
  hint?: string;
  lastCommandAt?: number | null;
  lastSuccessAt?: number | null;
  consecutiveTimeouts?: number;
  orphanedCommands?: number;
  eventLoopLagMs?: number;
  lastError?: { action: string; message: string; timeout?: { kind: string } } | null;
  inflight?: Array<{ action: string; ageMs: number; orphaned?: boolean }>;
}

/** Human-readable health lines (empty for daemons that predate `health`). */
export function formatHealth(health: HealthView | undefined, now = Date.now()): string[] {
  if (!health) return [];
  const ago = (t?: number | null) => (t ? `${formatUptime(Math.max(0, Math.floor((now - t) / 1000)))} ago` : "never");
  const lines = [
    `Health:         ${health.state}${health.reasons?.length ? ` (${health.reasons.join("; ")})` : ""}`,
    `Last command:   ${ago(health.lastCommandAt)}; last success: ${ago(health.lastSuccessAt)}`,
  ];
  if (health.consecutiveTimeouts) lines.push(`Timeouts:       ${health.consecutiveTimeouts} consecutive`);
  if (health.lastError) {
    const kind = health.lastError.timeout ? ` [${health.lastError.timeout.kind}]` : "";
    lines.push(`Last error:     ${health.lastError.action}${kind}: ${health.lastError.message.split(". ")[0]}`);
  }
  const stuck = (health.inflight ?? []).filter((c) => c.orphaned || c.ageMs >= 10_000);
  for (const c of stuck) {
    lines.push(`  in flight:    ${c.action} ${Math.round(c.ageMs / 1000)}s${c.orphaned ? " (timed out, still running)" : ""}`);
  }
  return lines;
}

/** Format a duration given in seconds (the daemon reports uptime in seconds). */
function formatUptime(seconds: number): string {
  if (!seconds || seconds <= 0) return "0s";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
