/**
 * OverviewPage — 控制面板 Overview tab
 *
 * 展示：
 *   - daemon 状态（端口 / Token / 运行时长 / Chrome 版本 / Tab 数）
 *   - 最近 50 条 MCP 命令历史（来自 GET /api/commands）
 */

import { useEffect, useCallback, useState } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import styles from './OverviewPage.module.css';

const POLL_INTERVAL = 5000;

export default function OverviewPage() {
  const { connected, overview, commands, setOverview, setCommands } = useStore();
  const [copying, setCopying] = useState(null);

  const refresh = useCallback(async () => {
    if (!daemon.isConnected()) return;
    try {
      const [ov, cmds] = await Promise.all([
        daemon.getOverview(),
        daemon.getCommands(50),
      ]);
      setOverview(ov);
      setCommands(cmds.commands ?? []);
    } catch (err) {
      console.error('[OverviewPage] refresh error:', err);
    }
  }, [setOverview, setCommands]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [refresh, connected]);

  const copy = async (text, key) => {
    try {
      // In Tauri WebView, prefer Tauri clipboard API if available.
      if (window.__TAURI__?.core) {
        await window.__TAURI__.core.invoke('copy_text', { text });
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopying(key);
      setTimeout(() => setCopying(null), 1200);
    } catch {}
  };

  return (
    <div className={styles.root}>
      {/* ── Daemon status card ── */}
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Daemon 状态</h2>
        {!overview ? (
          <p className={styles.empty}>{connected ? '加载中…' : '未连接到 daemon'}</p>
        ) : (
          <div className={styles.infoGrid}>
            <InfoRow label="daemon 端口" value={overview.daemonPort ? String(overview.daemonPort) : '—'} copyKey="daemonPort" copying={copying} onCopy={copy} />
            <InfoRow label="CDP 端口"    value={overview.cdpPort    ? String(overview.cdpPort)    : '—'} copyKey="cdpPort"    copying={copying} onCopy={copy} />
            <InfoRow label="运行时长"    value={formatUptime(overview.uptime)} />
            <InfoRow label="Chrome"      value={overview.chromeVersion ? `v${overview.chromeVersion}` : '未知'} />
            <InfoRow label="标签页数"    value={overview.tabCount != null ? String(overview.tabCount) : '—'} />
            <InfoRow label="CDP 连接"    value={overview.cdpConnected ? '✅ 已连接' : '❌ 未连接'} />
          </div>
        )}
      </section>

      {/* ── Commands history ── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>最近 MCP 命令</h2>
          <span className={styles.cardCount}>{commands.length} 条</span>
        </div>
        {commands.length === 0 ? (
          <p className={styles.empty}>暂无命令记录</p>
        ) : (
          <div className={styles.cmdList}>
            {commands.map((cmd, i) => (
              <div key={i} className={styles.cmdRow}>
                <span className={`${styles.cmdStatus} ${styles['status_' + cmd.status]}`}>
                  {statusIcon(cmd.status)}
                </span>
                <span className={styles.cmdTool}>{cmd.tool}</span>
                {cmd.argsSummary && (
                  <span className={styles.cmdArgs}>{cmd.argsSummary}</span>
                )}
                <span className={styles.cmdTime}>{formatAge(cmd.ts)}</span>
                {cmd.durationMs > 0 && (
                  <span className={styles.cmdDuration}>{cmd.durationMs}ms</span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function InfoRow({ label, value, copyKey, copying, onCopy }) {
  return (
    <div className={styles.infoRow}>
      <span className={styles.infoLabel}>{label}</span>
      <span className={styles.infoValue}>{value}</span>
      {copyKey && onCopy && (
        <button
          className={`${styles.copyBtn} ${copying === copyKey ? styles.copied : ''}`}
          onClick={() => onCopy(value, copyKey)}
        >
          {copying === copyKey ? '已复制' : '复制'}
        </button>
      )}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUptime(seconds) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatAge(ts) {
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 5) return 'just now';
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  return `${Math.floor(delta / 3600)}h`;
}

function statusIcon(status) {
  if (status === 'ok') return '✓';
  if (status === 'error') return '✗';
  return '…';
}
