/**
 * VaultPage — 控制面板 Vault tab（只读双栏，DESIGN v5 minimal §M2）
 *
 * 左栏 (~280px)：vault 选择器（默认 All vaults）+ 搜索过滤 + 时间分组列表
 *               （Today / Yesterday / Earlier，每行带 vault badge）
 * 右栏：选中条目的详情 —— 有报告则渲染报告 Markdown，否则渲染条目元数据 +
 *        推文全文。
 *
 * 无 composer（deep-dive 已删除）；全部走 daemon /command 只读 action。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { daemon } from '../api/daemon.js';
import styles from './VaultPage.module.css';

const PAGE_SIZE = 50;

/** 时间分组：Today / Yesterday / Earlier（本地时区语义足够）。 */
function groupLabel(iso, now) {
  const d = new Date(iso);
  const startOfDay = (x) => {
    const c = new Date(x);
    c.setHours(0, 0, 0, 0);
    return c;
  };
  const today0 = startOfDay(now);
  const yesterday0 = new Date(today0.getTime() - 86400000);
  if (d >= today0) return '今天 Today';
  if (d >= yesterday0) return '昨天 Yesterday';
  return '更早 Earlier';
}

export default function VaultPage() {
  const [vaults, setVaults] = useState([]); // vault_list 行
  const [entries, setEntries] = useState([]); // 当前选区条目（新→旧）
  const [selected, setSelected] = useState(null); // 左侧选中行
  const [detail, setDetail] = useState(null); // {kind:'report'|'entry', data}
  const [filter, setFilter] = useState('');
  const [vaultFilter, setVaultFilter] = useState(''); // '' = all
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reportMissing, setReportMissing] = useState(false);
  const fetchedFor = useRef('');

  const now = useMemo(() => new Date(), []);

  // ── 初次加载：vault 列表 + 各 vault recent（合并展示） ──
  const load = async (selectedVault) => {
    setLoading(true);
    setError(null);
    try {
      const listResp = await daemon.send('vault_list');
      const rows = listResp?.data?.vaults ?? [];
      setVaults(rows);

      const okNames = (selectedVault ? [selectedVault] : rows.filter((r) => r.ok).map((r) => r.name))
        .slice(0, 5); // 防御：超过 5 个 vault 时只取前 5，避免请求风暴
      const batches = await Promise.all(
        okNames.map((name) => daemon.send('vault_recent', { vaultName: name, limit: PAGE_SIZE })),
      );
      const merged = batches
        .flatMap((b) => b?.data?.vaultEntries ?? [])
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setEntries(merged);
      setFetchedFor(merged.map((e) => e.tweetId).join(','));
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(vaultFilter);
  }, [vaultFilter]);

  // ── 选中行 → 详情（报告优先，无报告回退条目） ──
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    setReportMissing(false);
    setDetail(null);
    const tryReport = async () => {
      try {
        const r = await daemon.send('vault_get_report', {
          vaultName: selected.vault,
          tweetId: selected.tweetId,
        });
        if (r.success && r.data?.vaultReport) {
          setDetail({ kind: 'report', data: r.data.vaultReport });
          return;
        }
        setReportMissing(true);
        setDetail({ kind: 'entry', data: selected });
      } catch {
        setReportMissing(true);
        setDetail({ kind: 'entry', data: selected });
      }
    };
    tryReport();
  }, [selected]);

  // ── Rust toast 深链事件：vault:new-entry → 自动选中该条目 ──
  useEffect(() => {
    const listener = window.__TAURI__?.event?.listen;
    if (!listener) return;
    let unlisten;
    listener('vault:new-entry', (event) => {
      const p = event?.payload ?? {};
      setVaultFilter(p.vault ?? '');
      const target = { vault: p.vault, tweetId: p.tweetId, author: p.author, text: p.text, url: p.url, createdAt: p.createdAt };
      setEntries((prev) => [target, ...prev.filter((e) => e.tweetId !== p.tweetId)]);
      setSelected(target);
    }).then((u) => { unlisten = u; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) =>
      e.text.toLowerCase().includes(q) ||
      e.author.toLowerCase().includes(q) ||
      e.tweetId.includes(q),
    );
  }, [entries, filter]);

  const groups = useMemo(() => {
    const g = {};
    for (const e of filtered) {
      const label = groupLabel(e.createdAt, now);
      (g[label] ??= []).push(e);
    }
    return g;
  }, [filtered, now]);

  const openInBrowser = async () => {
    if (!selected?.url) return;
    await daemon.send('open', { url: selected.url });
  };

  return (
    <div className={styles.root}>
      {/* ── 左栏 ── */}
      <aside className={styles.listPane}>
        <div className={styles.controls}>
          <select
            className={styles.select}
            value={vaultFilter}
            onChange={(e) => setVaultFilter(e.target.value)}
            title="vault 过滤器"
          >
            <option value="">全部 vaults</option>
            {vaults.filter((v) => v.ok).map((v) => (
              <option key={v.name} value={v.name}>{v.displayName} ({v.name})</option>
            ))}
          </select>
          <input
            className={styles.search}
            type="search"
            placeholder="过滤条目…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={!loading && entries.length === 0}
          />
        </div>

        {error && <p className={styles.error}>⚠ {error}</p>}
        {loading && <p className={styles.empty}>加载中…</p>}
        {!loading && !error && entries.length === 0 && (
          <div className={styles.empty}>
            <p>该 vault 还没有索引条目。</p>
            <p className={styles.hint}>
              💡 注册研究目录：<code>ma-browser vault register &lt;vault.yaml 路径&gt;</code>
            </p>
          </div>
        )}

        {Object.entries(groups).map(([label, items]) => (
          <section key={label} className={styles.group}>
            <h3 className={styles.groupTitle}>{label} <span className={styles.groupCount}>{items.length}</span></h3>
            <ul className={styles.list}>
              {items.map((e) => {
                const key = `${e.vault}:${e.tweetId}`;
                const active = selected?.tweetId === e.tweetId && selected?.vault === e.vault;
                return (
                  <li key={key}>
                    <button
                      className={`${styles.row} ${active ? styles.rowActive : ''}`}
                      onClick={() => setSelected(e)}
                    >
                      <span className={styles.rowTop}>
                        <span className={styles.vaultBadge}>{e.vault}</span>
                        <span className={styles.rowTime}>{e.createdAt.slice(11, 16)}</span>
                      </span>
                      <span className={styles.rowAuthor}>@{e.author}</span>
                      <span className={styles.rowText}>{e.text}</span>
                      {e.reportId && <span className={styles.rowReport}>📄 有报告</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </aside>

      {/* ── 右栏 ── */}
      <main className={styles.detailPane}>
        {!selected && <p className={styles.empty}>← 从左侧选择一个条目查看详情</p>}
        {selected && !detail && <p className={styles.empty}>加载详情…</p>}
        {detail?.kind === 'entry' && (
          <article className={styles.entry}>
            <header>
              <span className={styles.vaultBadge}>{detail.data.vault}</span>
              <h2>@{detail.data.author} <span className={styles.time}>{detail.data.createdAt}</span></h2>
            </header>
            <p className={styles.entryText}>{detail.data.text}</p>
            <p className={styles.meta}>
              ❤ {detail.data.likes} · ⇆ {detail.data.retweets}{' '}
              {reportMissing && <span className={styles.missing}>· 无对应报告（搜索可按全文命中）</span>}
            </p>
            <div className={styles.actions}>
              {detail.data.url && (
                <a className={styles.link} href={detail.data.url} target="_blank" rel="noreferrer">打开推文 ↗</a>
              )}
              <button className={styles.btn} onClick={openInBrowser}>在 ma-browser 浏览器打开</button>
            </div>
          </article>
        )}
        {detail?.kind === 'report' && (
          <article className={styles.entry}>
            <header>
              <span className={styles.vaultBadge}>{detail.data.vault}</span>
              <h2>{detail.data.reportTs} <span className={styles.time}>报告</span></h2>
            </header>
            {detail.data.frontmatter && (
              <p className={styles.meta}>
                tweet: {detail.data.frontmatter.tweetIds.join(', ')}
                {detail.data.frontmatter.candidateCount != null && ` · 候选 ${detail.data.frontmatter.candidateCount}`}
                {detail.data.frontmatter.subagentCount != null && ` · 子代理 ${detail.data.frontmatter.subagentCount}`}
              </p>
            )}
            <pre className={styles.markdown}>{detail.data.bodyMd}</pre>
          </article>
        )}
      </main>
    </div>
  );
}
