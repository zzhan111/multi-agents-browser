/**
 * vault 命令 - 管理 cron 驱动的研究库（research vault）
 *
 * 用法：
 *   ma-browser vault list                        列出已注册 vault (vault list: name, entries, reports)
 *   ma-browser vault register <vault.yaml路径>    注册一个研究目录
 *   ma-browser vault recent <name> [--limit N] [--since ISO]  最近条目
 *   ma-browser vault search <query> [--vault <name>] [--limit N]  全文搜索
 *
 * 数据流（M1 只读脊柱）：
 *   vault.yaml ──register──► ~/.bb-browser/vault-registry.json
 *   archive/*.jsonl + reports/*.md ──indexer──► ~/.bb-browser/vault-state/<name>/index.sqlite (FTS5)
 *
 * 创建 vault.yaml 的模板见 docs/vault.md（或 DESIGN 文档）。
 */

import { generateId, type Request, type Response } from "@ma-browser/shared";
import { sendCommand } from "../client.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

export interface VaultOptions {
  json?: boolean;
  limit?: number;
  since?: string;
  vault?: string;
}

function send(request: Request): Promise<Response> {
  return sendCommand(request);
}

export async function vaultCommand(args: string[], options: VaultOptions = {}): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h") {
    console.log(`ma-browser vault - cron 驱动研究库的读取面 (vault read surface: list, recent, search)

用法:
  ma-browser vault list                                列出已注册 vault
  ma-browser vault register <path/to/vault.yaml>       注册研究目录并建立索引
  ma-browser vault recent <name> [--limit N] [--since ISO]   最近条目（新→旧）
  ma-browser vault search <query> [--vault <name>] [--limit N]  FTS5 全文搜索

选项:
  --json            机器可读输出（Agent 友好）
  --limit N         返回条数（recent 默认 50，search 默认 20）
  --since ISO       时间窗口起点（vault recent）
  --vault <name>    限定单个 vault（search 默认搜全部）

示例:
  ma-browser vault register C:/Users/zhang/research/x/vault.yaml
  ma-browser vault list
  ma-browser vault recent x --limit 5
  ma-browser vault search "EverMemOS" --vault x
  ma-browser vault search "长期记忆" --json`);
    return;
  }

  await ensureDaemonRunning();

  switch (sub) {
    case "list":
      return vaultList(options);
    case "register":
    case "add": {
      const path = args[1];
      if (!path) {
        console.error("[error] vault register: <vault.yaml 路径> 必填。");
        console.error("  Usage: ma-browser vault register <path/to/vault.yaml>");
        process.exitCode = 1;
        return;
      }
      return vaultRegister(path, options);
    }
    case "recent": {
      const name = args[1];
      if (!name) {
        console.error("[error] vault recent: <vault 名称> 必填（vault list 查看）。");
        process.exitCode = 1;
        return;
      }
      return vaultRecent(name, options);
    }
    case "search": {
      const query = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!query) {
        console.error("[error] vault search: <query> 必填。");
        console.error('  Usage: ma-browser vault search "关键词"');
        process.exitCode = 1;
        return;
      }
      return vaultSearch(query, options);
    }
    default:
      console.error(`[error] 未知子命令 '${sub}'。运行 ma-browser vault --help 查看用法。`);
      process.exitCode = 1;
  }
}

async function vaultList(options: VaultOptions): Promise<void> {
  const res = await send({ id: generateId(), action: "vault_list" });
  if (!res.success) {
    console.error(`[error] ${res.error}`);
    process.exitCode = 1;
    return;
  }
  const vaults = res.data?.vaults ?? [];
  if (options.json) {
    console.log(JSON.stringify(vaults, null, 2));
    return;
  }
  if (vaults.length === 0) {
    console.log("尚未注册任何 vault。两步开始：");
    console.log("  1. 在研究目录根创建 vault.yaml（模板: docs/vault.md）");
    console.log("  2. ma-browser vault register <path/to/vault.yaml>");
    return;
  }
  for (const v of vaults) {
    if (!v.ok) {
      console.log(`${v.name}  ✗ ${v.problem}`);
      console.log(`    ${v.manifestPath}`);
      continue;
    }
    console.log(`${v.name}  ${v.displayName}`);
    console.log(
      `    ${v.entryCount ?? 0} 条目 · ${v.reportCount ?? 0} 报告 · ${v.manifestPath}`,
    );
  }
  console.log("\n💡 ma-browser vault recent <name> 查看最新条目；vault search <query> 全文搜索");
}

async function vaultRegister(path: string, options: VaultOptions): Promise<void> {
  const res = await send({ id: generateId(), action: "vault_register", vaultPath: path });
  if (!res.success) {
    console.error(`[error] ${res.error}`);
    console.error(`  hint: 检查 ${path} 存在且为合法 vault.yaml`);
    process.exitCode = 1;
    return;
  }
  const row = res.data?.vaults?.[0];
  if (options.json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }
  console.log(`已注册 '${row?.name}'（${row?.displayName}）`);
  console.log(`  已索引 ${row?.entryCount ?? 0} 条目 · ${row?.reportCount ?? 0} 报告`);
  console.log("\n💡 ma-browser vault recent " + row?.name + " --limit 5 查看最新内容");
}

async function vaultRecent(name: string, options: VaultOptions): Promise<void> {
  const res = await send({
    id: generateId(),
    action: "vault_recent",
    vaultName: name,
    limit: options.limit ?? 50,
    vaultSince: options.since,
  });
  if (!res.success) {
    console.error(`[error] ${res.error}`);
    process.exitCode = 1;
    return;
  }
  const entries = res.data?.vaultEntries ?? [];
  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log(`vault '${name}' 暂无条目。`);
    return;
  }
  for (const e of entries) {
    const ts = e.createdAt.slice(0, 16).replace("T", " ");
    const text = e.text.length > 60 ? e.text.slice(0, 60) + "…" : e.text;
    console.log(`${ts}  @${e.author.padEnd(16)} ${text}`);
    console.log(`    ${e.url}  ❤ ${e.likes} · ⇆ ${e.retweets}${e.reportId ? " · 有报告" : ""}`);
  }
  console.log(`\n${entries.length} 条 · 💡 ma-browser vault search "关键词" --vault ${name} 全文搜索`);
}

async function vaultSearch(query: string, options: VaultOptions): Promise<void> {
  const res = await send({
    id: generateId(),
    action: "vault_search",
    query,
    vaultName: options.vault,
    limit: options.limit ?? 20,
  });
  if (!res.success) {
    console.error(`[error] ${res.error}`);
    process.exitCode = 1;
    return;
  }
  const hits = res.data?.vaultHits ?? [];
  if (options.json) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }
  if (hits.length === 0) {
    console.log(`没有匹配 "${query}" 的条目。`);
    console.log('  hint: FTS5 语法可用 — 试试 vault search "mem0 OR letta"');
    return;
  }
  for (const h of hits) {
    console.log(`[${h.vault}] @${h.tweetId}  (bm25 ${h.score.toFixed(2)})`);
    console.log(`  ${h.snippet}`);
  }
  console.log(`\n${hits.length} 命中 · 💡 ma-browser vault recent <name> 按时间浏览`);
}
