/**
 * site 命令 - 管理和运行社区/私有网站适配器
 *
 * 用法：
 *   ma-browser site list                      列出所有可用 site adapter
 *   ma-browser site search <query>            搜索
 *   ma-browser site <name> [args...]          运行（简写）
 *   ma-browser site run <name> [args...]      运行
 *   ma-browser site update                    更新社区 adapter 库
 *
 * 目录：
 *   ~/.bb-browser/sites/       私有 adapter（优先）
 *   ~/.bb-browser/bb-sites/    社区 adapter（ma-browser site update 拉取）
 */

import {
  COMMUNITY_REPO,
  COMMUNITY_SITES_DIR,
  LOCAL_SITES_DIR,
  buildAdapterScript,
  generateId,
  loadAdapters,
  updateCommunityAdapters,
  type Request,
  type Response,
  type SiteAdapter,
} from "@ma-browser/shared";
import { handleJqResponse, sendCommand } from "../client.js";
import { getHistoryDomains } from "../history-sqlite.js";
import { ensureDaemonRunning } from "../daemon-manager.js";

type SiteMeta = SiteAdapter;

export interface SiteOptions {
  json?: boolean;
  tabId?: string | number;
  days?: number;
  jq?: string;
}

interface HistoryDomain {
  domain: string;
  visits: number;
}

interface SiteRecommendation {
  domain: string;
  visits: number;
  adapterCount: number;
  adapters: Array<{
    name: string;
    description: string;
    example: string;
  }>;
}

function exitJsonError(error: string, extra: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ success: false, error, ...extra }, null, 2));
  process.exit(1);
}

/**
 * 根据 URL 检查是否有对应的 site adapter，返回提示文本
 */
export function getSiteHintForDomain(url: string): string | null {
  try {
    const hostname = new URL(url).hostname;
    const sites = getAllSites();
    const matched = sites.filter(s => s.domain && (hostname === s.domain || hostname.endsWith("." + s.domain)));
    if (matched.length === 0) return null;
    const names = matched.map(s => s.name);
    const example = matched[0].example || `ma-browser site ${names[0]}`;
    return `该网站有 ${names.length} 个 site adapter 可直接获取数据，无需手动操作浏览器。试试: ${example}`;
  } catch {
    return null;
  }
}

function getAllSites(): SiteMeta[] {
  return loadAdapters();
}

// ── 子命令 ──────────────────────────────────────────────────────

function siteList(options: SiteOptions): void {
  const sites = getAllSites();

  if (sites.length === 0) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log("未找到任何 site adapter。");
    console.log("  安装社区 adapter: ma-browser site update");
    console.log(`  私有 adapter 目录: ${LOCAL_SITES_DIR}`);
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(sites.map(s => ({
      name: s.name, description: s.description, domain: s.domain,
      args: s.args, source: s.source,
    })), null, 2));
    return;
  }

  const groups = new Map<string, SiteMeta[]>();
  for (const s of sites) {
    const platform = s.name.split("/")[0];
    if (!groups.has(platform)) groups.set(platform, []);
    groups.get(platform)!.push(s);
  }

  for (const [platform, items] of groups) {
    console.log(`\n${platform}/`);
    for (const s of items) {
      const cmd = s.name.split("/").slice(1).join("/");
      const src = s.source === "local" ? " (local)" : "";
      const desc = s.description ? ` - ${s.description}` : "";
      console.log(`  ${cmd.padEnd(20)}${desc}${src}`);
    }
  }
  console.log();
}

function siteSearch(query: string, options: SiteOptions): void {
  const sites = getAllSites();
  const q = query.toLowerCase();
  const matches = sites.filter(s =>
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.domain.toLowerCase().includes(q)
  );

  if (matches.length === 0) {
    if (options.json) {
      console.log("[]");
      return;
    }
    console.log(`未找到匹配 "${query}" 的 adapter。`);
    console.log("  查看所有: ma-browser site list");
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(matches.map(s => ({
      name: s.name, description: s.description, domain: s.domain, source: s.source,
    })), null, 2));
    return;
  }

  for (const s of matches) {
    const src = s.source === "local" ? " (local)" : "";
    console.log(`${s.name.padEnd(24)} ${s.description}${src}`);
  }
}

function siteUpdate(options: SiteOptions = {}): void {
  if (!options.json) console.log(`更新社区 site adapter 库: ${COMMUNITY_REPO}`);
  const result = updateCommunityAdapters();
  if ("error" in result) {
    if (options.json) exitJsonError(result.error, { action: result.action, updateMode: result.updateMode });
    console.error(result.error);
    console.error(`  手动修复: ${result.action}`);
    process.exit(1);
  }
  if (options.json) {
    console.log(JSON.stringify({ success: true, ...result, communityRepo: COMMUNITY_REPO, communityDir: COMMUNITY_SITES_DIR }, null, 2));
    return;
  }
  console.log(`已安装 ${result.siteCount} 个社区 adapter。`);
  console.log("💡 运行 ma-browser site recommend 看看哪些和你的浏览习惯匹配");
}

function findSiteByName(name: string): SiteMeta | undefined {
  return getAllSites().find((site) => site.name === name);
}

function siteInfo(name: string, options: SiteOptions): void {
  const site = findSiteByName(name);

  if (!site) {
    if (options.json) {
      exitJsonError(`adapter "${name}" not found`, { action: "ma-browser site list" });
    }
    console.error(`[error] site info: adapter "${name}" not found.`);
    console.error("  Try: ma-browser site list");
    process.exit(1);
  }

  const meta = {
    name: site.name,
    description: site.description,
    domain: site.domain,
    args: site.args,
    example: site.example,
    readOnly: site.readOnly,
  };

  if (options.json) {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }

  console.log(`${site.name} — ${site.description}`);
  console.log();
  console.log("参数：");

  const argEntries = Object.entries(site.args);
  if (argEntries.length === 0) {
    console.log("  （无）");
  } else {
    for (const [argName, argDef] of argEntries) {
      const requiredText = argDef.required ? "必填" : "可选";
      const description = argDef.description || "";
      console.log(`  ${argName} (${requiredText})    ${description}`.trimEnd());
    }
  }

  console.log();
  console.log("示例：");
  console.log(`  ${site.example || `ma-browser site ${site.name}`}`);
  console.log();
  console.log(`域名：${site.domain || "（未声明）"}`);
  console.log(`只读：${site.readOnly ? "是" : "否"}`);
}

async function siteRecommend(options: SiteOptions): Promise<void> {
  const days = options.days ?? 30;
  const historyDomains: HistoryDomain[] = getHistoryDomains(days);
  const sites = getAllSites();
  const sitesByDomain = new Map<string, SiteMeta[]>();

  for (const site of sites) {
    if (!site.domain) continue;
    const domain = site.domain.toLowerCase();
    const existing = sitesByDomain.get(domain) || [];
    existing.push(site);
    sitesByDomain.set(domain, existing);
  }

  const available: SiteRecommendation[] = [];
  const notAvailable: HistoryDomain[] = [];

  for (const item of historyDomains) {
    const adapters = sitesByDomain.get(item.domain.toLowerCase());
    if (adapters && adapters.length > 0) {
      const sortedAdapters = [...adapters].sort((a, b) => a.name.localeCompare(b.name));
      available.push({
        domain: item.domain,
        visits: item.visits,
        adapterCount: sortedAdapters.length,
        adapters: sortedAdapters.map((site) => ({
          name: site.name,
          description: site.description,
          example: site.example || `ma-browser site ${site.name}`,
        })),
      });
    } else if (item.visits >= 5 && item.domain && !item.domain.includes('localhost') && item.domain.includes('.')) {
      notAvailable.push(item);
    }
  }

  const jsonData = {
    days,
    available,
    not_available: notAvailable,
  };

  if (options.jq) {
    handleJqResponse({ id: generateId(), success: true, data: jsonData as any });
  }

  if (options.json) {
    console.log(JSON.stringify(jsonData, null, 2));
    return;
  }

  console.log(`基于你最近 ${days} 天的浏览记录：`);
  console.log();

  console.log("🎯 你常用这些网站，可以直接用：");
  console.log();
  if (available.length === 0) {
    console.log("  （暂无匹配的 adapter）");
  } else {
    for (const item of available) {
      console.log(`  ${item.domain.padEnd(20)} ${item.visits} 次访问    ${item.adapterCount} 个命令`);
      console.log(`    试试: ${item.adapters[0]?.example || `ma-browser site ${item.adapters[0]?.name || ""}`}`);
      console.log();
    }
  }

  console.log("📋 你常用但还没有 adapter：");
  console.log();
  if (notAvailable.length === 0) {
    console.log("  （暂无）");
  } else {
    for (const item of notAvailable) {
      console.log(`  ${item.domain.padEnd(20)} ${item.visits} 次访问`);
    }
  }

  console.log();
  console.log('💡 跟你的 AI Agent 说 "把 notion.so CLI 化"，它就能自动完成。');
  console.log();
  console.log(`所有分析纯本地完成。用 --days 7 只看最近一周。`);
}

async function siteRun(
  name: string,
  args: string[],
  options: SiteOptions
): Promise<void> {
  const sites = getAllSites();
  const site = sites.find(s => s.name === name);

  if (!site) {
    const fuzzy = sites.filter(s => s.name.includes(name));
    if (options.json) {
      exitJsonError(`site "${name}" not found`, {
        suggestions: fuzzy.slice(0, 5).map(s => s.name),
        action: fuzzy.length > 0 ? undefined : "ma-browser site update",
      });
    }
    console.error(`[error] site: "${name}" not found.`);
    if (fuzzy.length > 0) {
      console.error("  Did you mean:");
      for (const s of fuzzy.slice(0, 5)) {
        console.error(`    ma-browser site ${s.name}`);
      }
    } else {
      console.error("  Try: ma-browser site list");
      console.error("  Or:  ma-browser site update");
    }
    process.exit(1);
  }

  const prepared = buildAdapterScript(site, args);
  if ("error" in prepared) {
    const usage = Object.entries(site.args).map(([a, def]) => def.required ? `<${a}>` : `[${a}]`).join(" ");
    if (options.json) {
      exitJsonError(`missing required argument "${prepared.missing}"`, {
        usage: `ma-browser site ${name} ${usage}`,
        example: site.example,
      });
    }
    console.error(`[error] site ${name}: missing required argument "${prepared.missing}".`);
    console.error(`  Usage: ma-browser site ${name} ${usage}`);
    if (site.example) console.error(`  Example: ${site.example}`);
    process.exit(1);
  }

  await ensureDaemonRunning();
  const request: Request = { id: generateId(), action: "site_run", name, args, tabId: options.tabId };
  const response: Response = await sendCommand(request);

  if (!response.success) {
    const error = response.error || "site run failed";
    const isAuthError = /401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth/i.test(error);
    const hint = site.domain
      ? `Open https://${site.domain} in the ma-browser Chrome and make sure you are logged in, then retry.`
      : undefined;
    const action = isAuthError && site.domain ? `ma-browser open https://${site.domain}` : undefined;
    if (options.json) {
      console.log(JSON.stringify({ id: request.id, success: false, error, hint, action }));
    } else {
      console.error(`[error] site ${name}: ${error}`);
      if (hint) console.error(`  Hint: ${hint}`);
    }
    process.exit(1);
  }

  const parsed = response.data ?? null;
  if (options.jq) {
    const { applyJq } = await import("../jq.js");
    // Tolerate ".data." prefix — Agent may copy from --json envelope structure
    const expr = options.jq.replace(/^\.data\./, '.');
    for (const r of applyJq(parsed, expr)) {
      console.log(typeof r === "string" ? r : JSON.stringify(r));
    }
  } else if (options.json) {
    console.log(JSON.stringify({ id: request.id, success: true, data: parsed }));
  } else if (parsed === null) {
    console.log("(no output)");
  } else {
    console.log(JSON.stringify(parsed, null, 2));
  }
}

// ── 入口 ────────────────────────────────────────────────────────

export async function siteCommand(
  args: string[],
  options: SiteOptions = {}
): Promise<void> {
  const subCommand = args[0];

  if (!subCommand || subCommand === "--help" || subCommand === "-h") {
    console.log(`ma-browser site - 网站 CLI 化（管理和运行 site adapter）

用法:
  ma-browser site list                      列出所有可用 adapter
  ma-browser site info <name>               查看 adapter 元信息
  ma-browser site recommend                 基于历史记录推荐 adapter
  ma-browser site search <query>            搜索 adapter
  ma-browser site <name> [args...]          运行 adapter（简写）
  ma-browser site run <name> [args...]      运行 adapter
  ma-browser site update                    更新社区 adapter 库 (git clone/pull)

目录:
  ${LOCAL_SITES_DIR}      私有 adapter（优先）
  ${COMMUNITY_SITES_DIR}   社区 adapter

示例:
  ma-browser site update
  ma-browser site list
  ma-browser site reddit/thread https://www.reddit.com/r/LocalLLaMA/comments/...
  ma-browser site twitter/user yan5xu
  ma-browser site search reddit

创建新 adapter: ma-browser guide
报告问题: gh issue create --repo epiral/bb-sites --title "[adapter-name] 描述"
贡献社区: https://github.com/epiral/bb-sites`);
    return;
  }

  switch (subCommand) {
    case "list":   siteList(options); break;
    case "search":
      if (!args[1]) {
        console.error("[error] site search: <query> is required.");
        console.error("  Usage: ma-browser site search <query>");
        process.exit(1);
      }
      siteSearch(args[1], options);
      break;
    case "info":
      if (!args[1]) {
        console.error("[error] site info: <name> is required.");
        console.error("  Usage: ma-browser site info <name>");
        process.exit(1);
      }
      siteInfo(args[1], options);
      break;
    case "recommend":
      await siteRecommend(options);
      break;
    case "update":  siteUpdate(options); break;
    case "run":
      if (!args[1]) {
        console.error("[error] site run: <name> is required.");
        console.error("  Usage: ma-browser site run <name> [args...]");
        console.error("  Try: ma-browser site list");
        process.exit(1);
      }
      await siteRun(args[1], args.slice(2), options);
      break;
    default:
      if (subCommand.includes("/")) {
        await siteRun(subCommand, args.slice(1), options);
      } else {
        console.error(`[error] site: unknown subcommand "${subCommand}".`);
        console.error("  Available: list, info, recommend, search, run, update");
        console.error("  Try: ma-browser site --help");
        process.exit(1);
      }
      break;
  }
}
