/**
 * CapabilitiesPage — site adapter 目录
 *
 * 功能：
 *   - 搜索/过滤 adapter（名称、描述、域名）
 *   - 每个 adapter 展示签名、域名、readOnly 标记
 *   - 展开详情：参数表格 + example
 *   - 一键运行：填参数 → 调 site_run → 内联看 JSON 结果
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { useStore } from '../store/useStore.jsx';
import { daemon } from '../api/daemon.js';
import AdapterConsentModal from '../components/AdapterConsentModal.jsx';
import styles from './CapabilitiesPage.module.css';

export default function CapabilitiesPage() {
  const { connected } = useStore();
  const [adapters, setAdapters] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  // Adapter sync (clone/pull) state — drives the consent modal + update button
  const [consentOpen, setConsentOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  // Category filter tab
  const CATEGORIES = ['全部', '社交', '电商', '出行', '影视', '医药', '工具'];
  const [activeCat, setActiveCat] = useState('全部');

  const fetchAdapters = useCallback(async (query) => {
    if (!daemon.isConnected()) return;
    setLoading(true);
    setError(null);
    try {
      const data = await daemon.getSites(query);
      setAdapters(data.adapters ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search on query change
  const handleQ = (val) => {
    setQ(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchAdapters(val), 250);
  };

  // Load on mount / reconnect
  useEffect(() => {
    if (connected) fetchAdapters(q);
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run the community-adapter sync (clone if absent, else pull). Called from
  // either the consent modal (first-time agree) or the "更新适配器" button.
  const runSync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      await daemon.updateAdapters();
      // Refresh the catalog (daemon invalidated its cache on success).
      await fetchAdapters(q);
      setConsentOpen(false);
    } catch (err) {
      setSyncError(err.message ?? String(err));
    } finally {
      setSyncing(false);
    }
  };

  const isEmpty = connected && !error && adapters.length === 0 && !loading && total === 0;

  // Apply category filter (only filters the rendered list; search still hits all)
  const visibleAdapters =
    activeCat === '全部' ? adapters : adapters.filter((a) => a.category === activeCat);

  return (
    <div className={styles.root}>
      {/* ── Search bar ── */}
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="搜索 adapter（名称 / 域名 / 描述）…"
          value={q}
          onChange={(e) => handleQ(e.target.value)}
          spellCheck={false}
        />
        <span className={styles.searchCount}>
          {loading ? '…' : `${visibleAdapters.length} / ${total}`}
        </span>
        <button
          className={styles.updateBtn}
          onClick={runSync}
          disabled={!connected || syncing}
          title="从社区仓库拉取/更新适配器"
        >
          {syncing ? '更新中…' : '更新适配器'}
        </button>
      </div>

      {/* ── Category filter tabs ── */}
      {!isEmpty && (
        <div className={styles.catTabs}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`${styles.catTab} ${activeCat === cat ? styles.catTabActive : ''}`}
              onClick={() => setActiveCat(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* ── Error ── */}
      {error && <p className={styles.errorMsg}>⚠ {error}</p>}
      {syncError && <p className={styles.errorMsg}>⚠ 更新失败:{syncError}</p>}

      {/* ── Empty state: onboarding card (first run, no adapters) ── */}
      {isEmpty && (
        <div className={styles.onboarding}>
          <p className={styles.onboardingTitle}>还没有任何适配器</p>
          <p className={styles.onboardingDesc}>
            社区适配器由各自作者维护,使用需遵守站点 ToS。获取后即可在此查看并运行封装好的站点能力。
          </p>
          <button
            className={styles.fetchBtn}
            onClick={() => setConsentOpen(true)}
            disabled={!connected}
          >
            获取社区适配器
          </button>
        </div>
      )}

      {/* ── Non-empty-but-no-match empty state ── */}
      {!error && adapters.length === 0 && !loading && !isEmpty && (
        <p className={styles.empty}>{connected ? '无匹配 adapter' : '未连接到 daemon'}</p>
      )}

      {/* ── Adapter list ── */}
      <div className={styles.adapterList}>
        {visibleAdapters.map((a) => (
          <AdapterCard key={a.name} adapter={a} />
        ))}
      </div>

      {/* ── Consent modal (first-time adapter fetch) ── */}
      <AdapterConsentModal
        open={consentOpen}
        loading={syncing}
        onAgree={runSync}
        onCancel={() => !syncing && setConsentOpen(false)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdapterCard
// ---------------------------------------------------------------------------

function AdapterCard({ adapter: a }) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [runError, setRunError] = useState(null);
  const [argValues, setArgValues] = useState({});

  const argNames = Object.keys(a.args ?? {});

  const riskLabel = { low: '🟢 低', medium: '🟡 中', high: '🔴 高' }[a.risk] ?? '';
  const isHighRisk = a.risk === 'high';

  const run = async () => {
    // High-risk adapters require an explicit ToS-compliance confirmation.
    if (isHighRisk && !window.confirm(
      `该适配器涉及 ${a.domain},可能属于社交平台/实时数据等高风险场景。\n` +
      `请确认你已阅读并遵守 ${a.domain} 的服务条款(ToS),且不会用于反爬、转售或商业化替代。\n\n继续运行?`
    )) {
      return;
    }
    setRunning(true);
    setResult(null);
    setRunError(null);
    try {
      // Build positional args array in order
      const args = argNames.map((k) => argValues[k] ?? '');
      const resp = await daemon.send('site_run', { name: a.name, args });
      setResult(resp);
    } catch (err) {
      setRunError(err.message ?? String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`${styles.card} ${expanded ? styles.cardExpanded : ''} ${isHighRisk ? styles.cardHighRisk : ''}`}>
      {/* ── Card header ── */}
      <div className={styles.cardHead} onClick={() => setExpanded((v) => !v)}>
        <span className={styles.chevron}>{expanded ? '▾' : '▸'}</span>
        <div className={styles.titles}>
          <span className={styles.adapterTitle}>{a.title || a.name}</span>
          <span className={styles.adapterName}>{a.name}</span>
        </div>
        <span className={styles.adapterDomain}>{a.domain}</span>
        {riskLabel && <span className={`${styles.riskBadge} ${styles[`risk_${a.risk}`]}`}>{riskLabel}</span>}
        {a.readOnly
          ? <span className={`${styles.badge} ${styles.badgeRO}`}>只读</span>
          : <span className={`${styles.badge} ${styles.badgeRW}`}>写入</span>}
        {a.source === 'local' && <span className={`${styles.badge} ${styles.badgeLocal}`}>本地</span>}
      </div>
      <p className={styles.adapterDesc}>{a.description}</p>
      {a.prerequisites && (
        <p className={styles.prereq}>前提:{a.prerequisites}</p>
      )}

      {/* ── Expanded details ── */}
      {expanded && (
        <div className={styles.details}>
          {/* Args table */}
          {argNames.length > 0 && (
            <div className={styles.argsSection}>
              <p className={styles.sectionLabel}>参数</p>
              <div className={styles.argsGrid}>
                {argNames.map((k) => (
                  <div key={k} className={styles.argRow}>
                    <label className={styles.argLabel} title={a.args[k]?.description}>
                      {k}
                      {a.args[k]?.required && <span className={styles.required}>*</span>}
                    </label>
                    <input
                      className={styles.argInput}
                      type="text"
                      placeholder={a.args[k]?.description ?? ''}
                      value={argValues[k] ?? ''}
                      onChange={(e) => setArgValues((v) => ({ ...v, [k]: e.target.value }))}
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Example */}
          {a.example && (
            <div className={styles.exampleRow}>
              <span className={styles.sectionLabel}>示例</span>
              <code className={styles.exampleCode}>{a.example}</code>
            </div>
          )}

          {/* Capabilities */}
          {a.capabilities?.length > 0 && (
            <div className={styles.capsRow}>
              {a.capabilities.map((c) => (
                <span key={c} className={styles.capBadge}>{c}</span>
              ))}
            </div>
          )}

          {/* Run button */}
          <button
            className={`${styles.runBtn} ${running ? styles.runBtnBusy : ''}`}
            onClick={run}
            disabled={running}
          >
            {running ? '运行中…' : '▶ 运行'}
          </button>

          {/* Result */}
          {runError && <p className={styles.runError}>✗ {runError}</p>}
          {result && (
            <pre className={styles.resultPre}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
