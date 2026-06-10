/**
 * BindingsPage — 持久绑定视图
 *
 * 展示所有跨重启存活的 tab 绑定。支持：
 * - 对照实时 tab 列表判断绑定是否"活跃"或"待恢复"
 * - 点击 agent 名称 inline 重命名（PATCH /api/agents/:id）
 * - 一键复制 X-BB-Agent 配置片段
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import styles from './BindingsPage.module.css';

const POLL_INTERVAL = 5000;

export default function BindingsPage() {
  const { connected } = useStore();
  const [bindings, setBindings]         = useState([]);
  const [agents, setAgents]             = useState([]);   // AgentRecord[]
  const [liveBbTabIds, setLiveBbTabIds] = useState(new Set());
  const [leaseMap, setLeaseMap]         = useState({});   // bbTabId → leaseMode
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [error, setError]               = useState(null);

  const refresh = useCallback(async () => {
    if (!daemon.isConnected()) return;
    try {
      const [bindingsRes, statusRes, agentsRes] = await Promise.all([
        daemon.getBindings(),
        daemon.getStatus(),
        daemon.getAgents(),
      ]);
      setBindings(bindingsRes.bindings ?? []);
      setAgents(agentsRes.agents ?? []);
      const tabs = statusRes.tabs ?? [];
      setLiveBbTabIds(new Set(tabs.map((t) => t.bbTabId).filter(Boolean)));
      setLeaseMap(Object.fromEntries(
        tabs.filter((t) => t.bbTabId && t.leaseMode).map((t) => [t.bbTabId, t.leaseMode])
      ));
      setLastRefreshed(new Date());
      setError(null);
    } catch (err) {
      setError(err.message ?? String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(t);
  }, [refresh, connected]);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // Build agentId → label map for display
  const labelMap = Object.fromEntries(agents.map((a) => [a.agentId, a.label]));

  const handleRename = useCallback(async (agentId, label) => {
    await daemon.renameAgent(agentId, label);
    await refresh();
  }, [refresh]);

  const handleRelease = useCallback(async (bbTabId) => {
    await daemon.releaseBinding(bbTabId);
    await refresh();
  }, [refresh]);

  const activeCount = bindings.filter((b) => liveBbTabIds.has(b.bbTabId)).length;
  const ghostCount  = bindings.length - activeCount;

  return (
    <div className={styles.root}>
      {/* ── Header ── */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>持久绑定</h2>
          <span className={styles.cardCount}>
            {bindings.length} 条
            {activeCount > 0 && <span className={styles.activePill}>{activeCount} 活跃</span>}
            {ghostCount  > 0 && <span className={styles.ghostPill}>{ghostCount} 待恢复</span>}
          </span>
          {lastRefreshed && (
            <span className={styles.ts} title="最近刷新时间">
              {lastRefreshed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          {error && (
            <span className={styles.ts} style={{ color: '#f85149' }} title={error}>⚠ 刷新失败</span>
          )}
        </div>

        {!connected ? (
          <p className={styles.empty}>未连接到 daemon</p>
        ) : bindings.length === 0 ? (
          <p className={styles.empty}>暂无持久绑定 — agent 调用 browser_tab_claim 时传入 intent 参数即可创建</p>
        ) : (
          <div className={styles.bindingList}>
            {bindings.map((b) => (
              <BindingCard
                key={b.bbTabId}
                binding={b}
                live={liveBbTabIds.has(b.bbTabId)}
                leaseMode={leaseMap[b.bbTabId]}
                agentLabel={labelMap[b.agentId]}
                onRename={handleRename}
                onRelease={handleRelease}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Legend ── */}
      {bindings.length > 0 && (
        <section className={styles.card}>
          <p className={styles.legend}>
            <span className={styles.dotActive} /> 活跃：tab 当前存活 &nbsp;·&nbsp;
            <span className={styles.dotGhost} /> 待恢复：调用 browser_resume 获取 anchorUrl 续做 &nbsp;·&nbsp;
            点击 agent 名称可重命名 &nbsp;·&nbsp; 点击 <code>⧉</code> 复制接入配置
          </p>
        </section>
      )}
    </div>
  );
}

// ── Binding card ─────────────────────────────────────────────────────────────

function BindingCard({ binding, live, leaseMode, agentLabel, onRename, onRelease }) {
  const { agentId, bbTabId, anchorUrl, intent, progress, claimedAt, updatedAt } = binding;
  const displayName = agentLabel || shortId(agentId);
  const isExclusive = live && leaseMode === 'exclusive';

  return (
    <div className={`${styles.bindingCard} ${live ? styles.bindingLive : styles.bindingGhost}`}>
      {/* Status + Agent name (inline-editable) */}
      <div className={styles.bindingHeader}>
        <span className={live ? styles.dotActive : styles.dotGhost} title={live ? '活跃' : '待恢复'} />
        <AgentNameEditor
          agentId={agentId}
          displayName={displayName}
          onRename={onRename}
        />
        <span className={styles.statusLabel}>{live ? '活跃' : '待恢复'}</span>
        {isExclusive && <span className={styles.exclusiveBadge} title="该 tab 被独占">独占</span>}
        <CopyConfigButton agentId={agentId} />
        <ReleaseButton bbTabId={bbTabId} live={live} onRelease={onRelease} />
        <span className={styles.timePair}>
          <span title={`认领: ${new Date(claimedAt).toLocaleString('zh-CN')}`}>
            {formatAge(claimedAt)}
          </span>
          {updatedAt !== claimedAt && (
            <span title={`更新: ${new Date(updatedAt).toLocaleString('zh-CN')}`}>
              · 更新 {formatAge(updatedAt)}
            </span>
          )}
        </span>
      </div>

      {/* URL */}
      <div className={styles.bindingRow}>
        <span className={styles.fieldLabel}>URL</span>
        <a
          className={styles.url}
          href={anchorUrl}
          target="_blank"
          rel="noreferrer"
          title={anchorUrl}
        >
          {truncate(anchorUrl, 60)}
        </a>
      </div>

      {/* Intent */}
      {intent && (
        <div className={styles.bindingRow}>
          <span className={styles.fieldLabel}>任务</span>
          <span className={styles.intentText}>{intent}</span>
        </div>
      )}

      {/* Progress */}
      {progress && (
        <div className={styles.bindingRow}>
          <span className={styles.fieldLabel}>进度</span>
          <span className={styles.progressText}>{progress}</span>
        </div>
      )}
    </div>
  );
}

// ── Inline agent name editor ──────────────────────────────────────────────────

function AgentNameEditor({ agentId, displayName, onRename }) {
  const [editing, setEditing]   = useState(false);
  const [value, setValue]       = useState('');
  const [saving, setSaving]     = useState(false);
  const [saveErr, setSaveErr]   = useState(null);
  const inputRef = useRef(null);

  const startEdit = () => {
    setValue(displayName);
    setSaveErr(null);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const cancel = () => { setEditing(false); setSaveErr(null); };

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === displayName) { cancel(); return; }
    setSaving(true);
    try {
      await onRename(agentId, trimmed);
      setEditing(false);
      setSaveErr(null);
    } catch (e) {
      setSaveErr(e.message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  if (editing) {
    return (
      <span className={styles.nameEditor}>
        <input
          ref={inputRef}
          className={styles.nameInput}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onKeyDown={onKeyDown}
          disabled={saving}
          maxLength={80}
        />
        {saveErr && <span className={styles.nameErr}>{saveErr}</span>}
      </span>
    );
  }

  return (
    <span
      className={styles.agentId}
      title={`${agentId}\n点击重命名`}
      onClick={startEdit}
      style={{ cursor: 'text' }}
    >
      {displayName}
    </span>
  );
}

// ── Copy config button ────────────────────────────────────────────────────────

function CopyConfigButton({ agentId }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const snippet = `X-BB-Agent: ${agentId}`;
    try {
      await navigator.clipboard.writeText(snippet);
    } catch {
      // fallback for non-secure contexts
      const el = document.createElement('textarea');
      el.value = snippet;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      className={styles.copyBtn}
      onClick={copy}
      title={`复制接入配置\nX-BB-Agent: ${agentId}`}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

// ── Release button ───────────────────────────────────────────────────────────

function ReleaseButton({ bbTabId, live, onRelease }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy]             = useState(false);
  const label = live ? '释放' : '删除';
  const confirmText = live ? '确认释放？' : '确认删除？';

  if (confirming) {
    return (
      <span className={styles.releaseConfirm}>
        {confirmText}
        <button
          className={styles.releaseYes}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await onRelease(bbTabId); } finally { setBusy(false); setConfirming(false); }
          }}
        >
          {busy ? '…' : '是'}
        </button>
        <button className={styles.releaseNo} onClick={() => setConfirming(false)}>否</button>
      </span>
    );
  }

  return (
    <button
      className={styles.releaseBtn}
      onClick={() => setConfirming(true)}
      title={live ? '由操作者强制释放该 tab 的独占租约' : '删除此条过期 binding 记录'}
    >
      {label}
    </button>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortId(id) {
  if (!id) return '匿名';
  return id.length > 20 ? id.slice(0, 8) + '…' : id;
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function formatAge(ts) {
  if (!ts) return '';
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 5)     return 'just now';
  if (delta < 60)    return `${delta}s 前`;
  if (delta < 3600)  return `${Math.floor(delta / 60)}m 前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h 前`;
  return `${Math.floor(delta / 86400)}d 前`;
}
