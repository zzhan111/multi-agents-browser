/**
 * VaultPage — 控制面板 Vault tab（只读双栏）
 *
 * 左栏 (~300px)：vault 选择器 + 健康汇总 + 搜索框 + 列表
 *   - 浏览模式（搜索框为空）：时间分组列表（Today / Yesterday / Earlier，
 *     每行带 vault badge），单 vault 过滤时底部有「加载更早」分页。
 *   - 搜索模式（输入 ≥1 字符，300ms 防抖）：daemon FTS5 全文搜索
 *     （vault_search），命中显示高亮 snippet，可点击直达详情。
 * 右栏：选中条目的详情 —— 有报告则渲染 Markdown（marked + DOMPurify），
 *       否则渲染条目元数据 + 推文全文（URL 自动转链接）。
 *
 * 全部走 daemon /command 只读 action。无 composer。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { daemon } from '../api/daemon.js';
import styles from './VaultPage.module.css';

const PAGE_SIZE = 50;

// ── Markdown 安全渲染（一次性 hook：所有链接新窗口打开 + noreferrer） ──
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer');
    node.setAttribute('target', '_blank');
  }
});

/** marked v18 同步返回 string；防御异步/空值。 */
function renderMarkdown(md) {
  if (!md) return '';
  const raw = marked.parse(md, { async: false });
  return DOMPurify.sanitize(typeof raw === 'string' ? raw : String(raw ?? ''));
}

/** 推文文本里的 URL 转成可点链接。 */
const URL_RE = /(https?:\/\/[^\s]+)/g;
function linkify(text) {
  const parts = [];
  let last = 0;
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <a key={m.index} href={m[0]} target="_blank" rel="noopener noreferrer">{m[0]}</a>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : text;
}

/** FTS5 snippet 高亮：`[命中词]` → <mark>。 */
function highlightSnippet(snippet) {
  return snippet.split(/(\[[^\]]+\])/g).map((part, i) =>
    part.startsWith('[') && part.endsWith(']') && part.length > 2 ? (
      <mark key={i} className={styles.hitMark}>{part.slice(1, -1)}</mark>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** 行唯一键：vault + tweetId。 */
function keyFor(item) {
  return `${item.vault}:${item.tweetId}`;
}

/** vite dev 环境兜底：Blob 下载（Tauri 下走原生 save dialog）。 */
function downloadViaBlob(text, filename) {
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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
  const [entries, setEntries] = useState([]); // 浏览模式条目（新→旧）
  const [selected, setSelected] = useState(null); // 左侧选中行
  const [detail, setDetail] = useState(null); // {kind:'report'|'entry', data}
  const [filter, setFilter] = useState('');
  const [vaultFilter, setVaultFilter] = useState(''); // '' = all
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reportMissing, setReportMissing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [hasReport, setHasReport] = useState(false);
  // ── 搜索模式状态 ──
  const [mode, setMode] = useState('browse'); // 'browse' | 'search'
  const [searchHits, setSearchHits] = useState([]);
  const [searchState, setSearchState] = useState('idle'); // idle|typing|searching|done|error
  const [searchError, setSearchError] = useState(null);
  // ── 键盘导航焦点 + 导出反馈 ──
  const [focusKey, setFocusKey] = useState(null);
  const [exportMsg, setExportMsg] = useState(null);
  const debounceRef = useRef(null);
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const searchRef = useRef(null);
  const listPaneRef = useRef(null);

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
        okNames.map((name) => daemon.send('vault_recent', { vaultName: name, limit: PAGE_SIZE, hasReport: hasReport || undefined })),
      );
      const merged = batches
        .flatMap((b) => b?.data?.vaultEntries ?? [])
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      setEntries(merged);
      setHasMore(selectedVault ? merged.length === PAGE_SIZE : false);
      if (selectedVault && merged.length < PAGE_SIZE) setHasMore(false);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoading(false);
    }
  };

  // ── 服务端 FTS5 搜索 ──
  const runSearch = useCallback(async (q) => {
    setSearchState('searching');
    setSearchError(null);
    try {
      const resp = await daemon.send('vault_search', {
        query: q,
        vaultName: vaultFilter || undefined,
        limit: 30,
      });
      setSearchHits(resp?.data?.vaultHits ?? []);
      setSearchState('done');
    } catch (err) {
      setSearchError(err.message ?? String(err));
      setSearchState('error');
    }
  }, [vaultFilter]);

  // filter 输入：非空 → 搜索模式（防抖），空 → 回浏览模式
  const onFilterChange = (e) => {
    const q = e.target.value;
    setFilter(q);
    clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setMode('browse');
      setSearchHits([]);
      setSearchState('idle');
      return;
    }
    setMode('search');
    setSearchState('typing');
    debounceRef.current = setTimeout(() => runSearch(q.trim()), 300);
  };

  useEffect(() => {
    load(vaultFilter);
    // 切换 vault 时若搜索框非空，用新范围重搜
    const q = filterRef.current.trim();
    setMode(q ? 'search' : 'browse');
    if (q) runSearch(q);
    return () => clearTimeout(debounceRef.current);
  }, [vaultFilter, hasReport]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 搜索命中 → 拉完整 entry → 选中 ──
  const openHit = useCallback(async (hit) => {
    try {
      const r = await daemon.send('vault_get_entry', { vaultName: hit.vault, tweetId: hit.tweetId });
      const entry = r?.data?.vaultEntry;
      setSelected(entry ?? { ...hit, text: hit.snippet, likes: 0, retweets: 0, url: '' });
    } catch {
      setSelected({ ...hit, text: hit.snippet, likes: 0, retweets: 0, url: '' });
    }
  }, []);

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

  // ── 加载更早（仅单 vault 浏览模式；vaultSince 为 >= 语义，按 tweetId 去重） ──
  const loadMore = async () => {
    if (!vaultFilter || entries.length === 0 || loadingMore) return;
    const oldest = entries[entries.length - 1];
    setLoadingMore(true);
    try {
      const resp = await daemon.send('vault_recent', {
              vaultName: vaultFilter,
              vaultBefore: oldest.createdAt,
              limit: PAGE_SIZE,
              hasReport: hasReport || undefined,
            });
      const next = resp?.data?.vaultEntries ?? [];
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => `${e.vault}:${e.tweetId}`));
        const added = next.filter((e) => !seen.has(`${e.vault}:${e.tweetId}`));
        return [...prev, ...added];
      });
      setHasMore(next.length === PAGE_SIZE);
    } catch (err) {
      setError(err.message ?? String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  // ── 健康汇总 ──
  const healthyCount = vaults.filter((v) => v.ok).length;
  const brokenVaults = vaults.filter((v) => !v.ok);

  const groups = useMemo(() => {
    const g = {};
    for (const e of entries) {
      const label = groupLabel(e.createdAt, now);
      (g[label] ??= []).push(e);
    }
    return g;
  }, [entries, now]);

  const openInBrowser = async () => {
    if (!selected?.url) return;
    await daemon.send('open', { url: selected.url });
  };

  // ── 报告导出：复制 Markdown / 下载 .md ──
  const copyMarkdown = async (md) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (invoke) {
      try { await invoke('copy_text', { text: md }); setExportMsg('已复制 Markdown'); return; } catch {}
    }
    try { await navigator.clipboard.writeText(md); setExportMsg('已复制 Markdown'); }
    catch { setExportMsg('复制失败'); }
  };

  const saveMarkdown = async (md, tweetId) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) { downloadViaBlob(md, `report-${tweetId}.md`); setExportMsg('已开始下载'); return; }
    try {
      const path = await invoke('save_text_file', { text: md, filename: `report-${tweetId}.md` });
      setExportMsg(path ? '已保存' : '已取消');
    } catch (e) {
      setExportMsg('保存失败: ' + (e?.message ?? String(e)));
    }
  };

  // 导出反馈自动消失
  useEffect(() => {
    if (!exportMsg) return;
    const t = setTimeout(() => setExportMsg(null), 2500);
    return () => clearTimeout(t);
  }, [exportMsg]);

  // ── 键盘导航：↑/↓ 移动焦点、Enter 打开、/ 聚焦搜索 ──
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
      const items = mode === 'browse' ? entries : searchHits;
      if (items.length === 0) return;
      let idx = items.findIndex((i) => keyFor(i) === focusKey);
      if (idx === -1) idx = 0;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusKey(keyFor(items[Math.min(idx + 1, items.length - 1)]));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusKey(keyFor(items[Math.max(idx - 1, 0)]));
      } else {
        e.preventDefault();
        const item = items[idx];
        if (mode === 'browse') setSelected(item);
        else openHit(item);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, entries, searchHits, focusKey, openHit]);

  // 焦点变化 → 滚动到可见
  useEffect(() => {
    if (!focusKey) return;
    const el = listPaneRef.current?.querySelector(`[data-focus-key="${focusKey}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusKey]);

  // ── 实时刷新：浏览模式 10s 轮询 + 可见性/焦点即时补拉 ──
  useEffect(() => {
    if (mode !== 'browse') return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState === 'hidden' || !vaults.length) return;
      try {
        const okNames = (vaultFilter ? [vaultFilter] : vaults.filter((v) => v.ok).map((v) => v.name))
          .slice(0, 5);
        const batches = await Promise.all(
          okNames.map((name) => daemon.send('vault_recent', { vaultName: name, limit: PAGE_SIZE, hasReport: hasReport || undefined })),
        );
        const fresh = batches.flatMap((b) => b?.data?.vaultEntries ?? []);
        if (cancelled || fresh.length === 0) return;
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => keyFor(e)));
          const merged = prev.slice();
          let changed = false;
          for (const e of fresh) {
            const k = keyFor(e);
            if (!seen.has(k)) { seen.add(k); merged.push(e); changed = true; }
          }
          if (!changed) return prev;
          merged.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
          return merged;
        });
      } catch {
        /* transient poll error — ignore */
      }
    };
    const id = setInterval(tick, 10000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [mode, vaultFilter, vaults, hasReport]);

  const searching = mode === 'search' && (searchState === 'typing' || searchState === 'searching');

  return (
    <div className={styles.root}>
      {/* ── 左栏 ── */}
      <aside className={styles.listPane} ref={listPaneRef}>
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
          <button
            className={`${styles.reportToggle} ${hasReport ? styles.reportToggleActive : ''}`}
            onClick={() => setHasReport((v) => !v)}
            title="只看有报告文件的条目"
          >
            📄 只看有报告
          </button>
          {vaults.length > 0 && (
            <div
              className={brokenVaults.length ? styles.healthBad : styles.healthOk}
              title={brokenVaults.length
                ? brokenVaults.map((v) => `${v.name}: ${v.problem ?? '未知问题'}`).join('\n')
                : undefined}
            >
              {brokenVaults.length === 0
                ? `✓ ${vaults.length} 个 vault 正常`
                : `⚠ ${healthyCount} 正常 · ${brokenVaults.length} 异常（悬停查看）`}
            </div>
          )}
          <input
            className={styles.search}
            type="search"
            ref={searchRef}
            placeholder={mode === 'search' ? '搜索全文…' : '搜索全文（FTS5）…'}
            value={filter}
            onChange={onFilterChange}
            disabled={!loading && entries.length === 0 && searchState === 'idle'}
          />
        </div>

        {error && <p className={styles.error}>⚠ {error}</p>}
        {loading && <p className={styles.empty}>加载中…</p>}

        {/* 浏览模式 */}
        {mode === 'browse' && !loading && !error && entries.length === 0 && (
          <div className={styles.empty}>
            <p>该 vault 还没有索引条目。</p>
            <p className={styles.hint}>
              💡 注册研究目录：<code>ma-browser vault register &lt;vault.yaml 路径&gt;</code>
            </p>
          </div>
        )}

        {mode === 'browse' && !loading && Object.entries(groups).map(([label, items]) => (
          <section key={label} className={styles.group}>
            <h3 className={styles.groupTitle}>{label} <span className={styles.groupCount}>{items.length}</span></h3>
            <ul className={styles.list}>
              {items.map((e) => {
                const key = `${e.vault}:${e.tweetId}`;
                const active = selected?.tweetId === e.tweetId && selected?.vault === e.vault;
                return (
                  <li key={key}>
                    <button
                      data-focus-key={key}
                      className={`${styles.row} ${active ? styles.rowActive : ''} ${focusKey === key ? styles.rowFocused : ''}`}
                      onClick={() => { setFocusKey(key); setSelected(e); }}
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

        {mode === 'browse' && !loading && entries.length > 0 && vaultFilter && hasMore && (
          <button className={styles.loadMore} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中…' : '加载更早'}
          </button>
        )}

        {/* 搜索模式 */}
        {mode === 'search' && (
          <div className={styles.searchPane}>
            {searching && <p className={styles.empty}>搜索中…</p>}
            {searchState === 'error' && <p className={styles.error}>⚠ {searchError}</p>}
            {searchState === 'done' && searchHits.length === 0 && (
              <p className={styles.empty}>没有匹配的报告/条目。</p>
            )}
            {searchState === 'done' && searchHits.length > 0 && (
              <>
                <p className={styles.searchInfo}>{searchHits.length} 条命中</p>
                <ul className={styles.list}>
                  {searchHits.map((hit) => {
                    const key = `${hit.vault}:${hit.tweetId}`;
                    const active = selected?.tweetId === hit.tweetId && selected?.vault === hit.vault;
                    return (
                      <li key={key}>
                        <button
                          data-focus-key={key}
                          className={`${styles.row} ${active ? styles.rowActive : ''} ${focusKey === key ? styles.rowFocused : ''}`}
                          onClick={() => { setFocusKey(key); openHit(hit); }}
                        >
                          <span className={styles.rowTop}>
                            <span className={styles.vaultBadge}>{hit.vault}</span>
                            <span className={styles.rowTime}>{(hit.reportTs ?? '').slice(0, 10)}</span>
                          </span>
                          <span className={styles.rowText}>{highlightSnippet(hit.snippet)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        )}
      </aside>

      {/* ── 右栏 ── */}
      <main className={styles.detailPane}>
        {!selected && <p className={styles.empty}>← 从左侧选择一个条目查看详情</p>}
        {selected && !detail && <p className={styles.empty}>加载详情…</p>}
        {detail?.kind === 'entry' && (
          <article className={styles.entry}>
            <header>
              <span className={styles.vaultBadge}>{detail.data.vault}</span>
              <h2>
                <a
                  className={styles.authorLink}
                  href={`https://x.com/${detail.data.author}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @{detail.data.author}
                </a>{' '}
                <span className={styles.time}>{detail.data.createdAt}</span>
              </h2>
            </header>
            <p className={styles.entryText}>{linkify(detail.data.text)}</p>
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
              <>
                <div className={styles.metaRow}>
                  <span className={styles.metaBadge}>📄 报告</span>
                  <span className={styles.metaBadge}>🕒 {detail.data.reportTs}</span>
                  {detail.data.frontmatter.tweetIds?.length > 0 && (
                    <span className={styles.metaBadge}>🐦 {detail.data.frontmatter.tweetIds.join(', ')}</span>
                  )}
                  {detail.data.frontmatter.candidateCount != null && (
                    <span className={styles.metaBadge}>候选 {detail.data.frontmatter.candidateCount}</span>
                  )}
                  {detail.data.frontmatter.subagentCount != null && (
                    <span className={styles.metaBadge}>子代理 {detail.data.frontmatter.subagentCount}</span>
                  )}
                </div>
                {detail.data.frontmatter.tags?.length > 0 && (
                  <div className={styles.tags}>
                    {detail.data.frontmatter.tags.map((t) => (
                      <span key={t} className={styles.tag}>#{t}</span>
                    ))}
                  </div>
                )}
              </>
            )}
            <div
              className={styles.markdown}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.data.bodyMd) }}
            />
            <div className={styles.actions}>
              <button className={styles.btn} onClick={() => copyMarkdown(detail.data.bodyMd)}>复制 Markdown</button>
              <button className={styles.btn} onClick={() => saveMarkdown(detail.data.bodyMd, detail.data.tweetId)}>下载 .md</button>
              {exportMsg && <span className={styles.exportMsg}>{exportMsg}</span>}
            </div>
          </article>
        )}
      </main>
    </div>
  );
}