<div align="center">

# MultiAgentsBrowser

### `ma-browser` — 多 agent 共享的浏览器即 API

**你的浏览器就是 API。不需要密钥，不需要爬虫，不需要模拟。**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · [中文](README.zh-CN.md)

</div>

---

你已经登录了微博、知乎、B站、小红书、Twitter、GitHub、LinkedIn — ma-browser 让 AI Agent **直接用你的登录态**。

```bash
ma-browser site twitter/search "AI agent"       # 搜索推文
ma-browser site zhihu/hot                        # 知乎热榜
ma-browser site arxiv/search "transformer"       # 搜论文
ma-browser site eastmoney/stock "茅台"            # 实时股票行情
ma-browser site boss/search "AI 工程师"           # 搜职位
ma-browser site wikipedia/summary "Python"       # 维基百科摘要
ma-browser site youtube/transcript VIDEO_ID      # YouTube 字幕全文
ma-browser site stackoverflow/search "async"     # 搜 StackOverflow
```

**36 个平台，103 个命令，全部用你真实浏览器的登录态。** [完整列表 →](https://github.com/epiral/bb-sites)

## 核心理念

互联网是为浏览器构建的。AI Agent 一直试图通过 API 访问它 — 但 99% 的网站不提供 API。

ma-browser 翻转了这个逻辑：**不是让网站适配机器，而是让机器使用人的界面。** adapter 在你的浏览器 tab 里跑 `eval`，用你的 Cookie 调 `fetch()`，或者直接调用页面的 webpack 模块。网站以为是你在操作。因为**就是你**。

| | Playwright / Selenium | 爬虫库 | ma-browser |
|---|---|---|---|
| 浏览器 | 无头、隔离环境 | 没有浏览器 | 你的真实 Chrome |
| 登录态 | 没有，要重新登录 | 偷 Cookie | 已经在了 |
| 反爬检测 | 容易被识别 | 猫鼠游戏 | 无法检测 — 它就是用户 |
| 复杂鉴权 | 无法复制 | 需要逆向 | 页面自己处理 |

## 快速开始

### 安装

```bash
npm install -g ma-browser
```

### 使用

```bash
ma-browser site update        # 拉取社区适配器
ma-browser site recommend     # 看看哪些和你的浏览习惯匹配
ma-browser site zhihu/hot     # 开搞
```

### Windows 无头托盘

从源码构建后，在仓库目录运行：

```powershell
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "`"$PWD\scripts\windows-tray.ps1`"")
```

托盘会启动并监视后台进程，新启动的受管浏览器默认以无头模式运行。右键托盘图标可切换有头／无头模式，所选模式会在下次登录时保留。切换会重启受管浏览器并恢复会话，未保存的页面内容可能丢失；需要交互登录时可切换到有头模式。右键菜单也可打开日志或退出托盘（后台继续运行）。托盘之外可设置 `MA_BROWSER_HEADLESS=1` 启动无头浏览器；已在运行的浏览器不会自动重启。

右键 →「发现并接管已有 Chrome」会列出本机所有可调试浏览器（打勾 = 已接管）；点击某一项即可接管，或点「全部接管」。失败时以气泡提示原因。

Agent 可调用 `ma-browser mode status|headed|headless --json` 或 MCP `browser_mode`（`mode` 参数同名）。查询无需切换，切换完成并重新连接后才返回；旧 tab ID 会失效。托盘负责启动 daemon 时，可为 MCP 设置环境变量 `MA_BROWSER_CONNECT_ONLY=1`，避免切换期间抢先启动另一个 daemon。

需要在 Windows 登录后自动启动时，在仓库目录运行：

```powershell
$trayScript = (Resolve-Path .\scripts\windows-tray.ps1).Path
$command = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$trayScript`""
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ma-browser-tray' -Value $command
```

### MCP 接入（Claude Code / Cursor）

```json
{
  "mcpServers": {
    "ma-browser": {
      "command": "npx",
      "args": ["-y", "ma-browser", "--mcp"]
    }
  }
}
```

## 36 个平台，103 个命令

社区驱动，通过 [bb-sites](https://github.com/epiral/bb-sites) 维护。每个命令一个 JS 文件。

| 类别 | 平台 | 命令 |
|------|------|------|
| **搜索引擎** | Google、百度、Bing、DuckDuckGo、搜狗微信 | search |
| **社交媒体** | Twitter/X、Reddit、微博、小红书、即刻、LinkedIn、虎扑 | search、feed、thread、user、notifications、hot |
| **新闻资讯** | BBC、Reuters、36氪、今日头条、东方财富 | headlines、search、newsflash、hot |
| **技术开发** | GitHub、StackOverflow、HackerNews、CSDN、博客园、V2EX、Dev.to、npm、PyPI、arXiv | search、issues、repo、top、thread、package |
| **视频平台** | YouTube、B站 | search、video、transcript、popular、comments、feed |
| **影音娱乐** | 豆瓣、IMDb、Genius、起点中文网 | movie、search、top250 |
| **财经股票** | 雪球、东方财富、Yahoo Finance | stock、hot-stock、feed、watchlist、search |
| **求职招聘** | BOSS直聘、LinkedIn | search、detail、profile |
| **知识百科** | Wikipedia、知乎、Open Library | search、summary、hot、question |
| **消费购物** | 什么值得买 | search |
| **实用工具** | 有道翻译、GSMArena、Product Hunt、携程 | translate、手机参数、热门产品 |

## 10 分钟，CLI 化任何网站

```bash
ma-browser guide    # 完整教程
```

跟你的 AI Agent 说：*「帮我把 XX 网站 CLI 化」*。它会读 guide，用 `network --with-body` 抓包逆向，写 adapter，测试，然后提 PR 到社区仓库。全程自动。

三种 adapter 复杂度：

| 层级 | 认证方式 | 代表 | 耗时 |
|------|----------|------|------|
| **Tier 1** | Cookie（直接 fetch） | Reddit、GitHub、V2EX | ~1 分钟 |
| **Tier 2** | Bearer + CSRF token | Twitter、知乎 | ~3 分钟 |
| **Tier 3** | Webpack 注入 / Pinia store | Twitter 搜索、小红书 | ~10 分钟 |

实测：**20 个 AI Agent 并发运行，每个独立逆向一个网站并产出可用的 adapter。** 将一个新网站纳入 Agent 可访问范围的边际成本趋近于零。

## 对 AI Agent 意味着什么

没有 ma-browser，AI Agent 的世界是：**文件系统 + 终端 + 少数有 API key 的服务。**

有了 ma-browser：**文件系统 + 终端 + 整个互联网。**

一个 Agent 现在可以在一分钟内：

```bash
# 跨平台调研任何话题
ma-browser site arxiv/search "retrieval augmented generation"
ma-browser site twitter/search "RAG"
ma-browser site github search rag-framework
ma-browser site stackoverflow/search "RAG implementation"
ma-browser site zhihu/search "RAG"
ma-browser site 36kr/newsflash
```

六个平台，六个维度，结构化 JSON。比任何人类研究员都快、都广。

## 同时也是完整的浏览器自动化工具

```bash
ma-browser open https://example.com
ma-browser snapshot -i                # 可访问性树
ma-browser click @3                   # 点击元素
ma-browser fill @5 "hello"            # 填写输入框
ma-browser eval "document.title"      # 执行 JS
ma-browser fetch URL --json           # 带登录态的 fetch
ma-browser network requests --with-body --json  # 抓包
ma-browser screenshot                 # 截图
```

所有命令支持 `--json` 输出、`--jq <expr>` 内联过滤、和 `--tab <id>` 多标签页并发操作。

```bash
ma-browser site xueqiu/hot-stock 5 --jq '.items[] | {name, changePercent}'
# {"name":"云天化","changePercent":"2.08%"}
# {"name":"东芯股份","changePercent":"-7.60%"}

ma-browser site info xueqiu/stock   # 查看 adapter 参数、示例、域名
```

## 接管自己的 Chrome，或同时控制多个

ma-browser 控制开启了 remote debugging 端口的浏览器。用端口和独立的 profile 目录启动日常 Chrome（或沙盒 Chrome）——Chrome 136+ 不允许在默认 profile 上开启远程调试：

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-debug"
```

```bash
ma-browser cdp list                    # 本机所有可调试浏览器：ID、版本、profile、tab 数、是否受管/已接管
ma-browser cdp attach 9222             # 接管：不重启、不关闭
ma-browser cdp attach --all            # 接管全部已发现的浏览器，并行使用
ma-browser tab list                    # 每个 tab 标出所属浏览器（@9222）
ma-browser tab list --browser 9222     # 只看该浏览器的 tab
ma-browser open https://x.com --browser 9222   # 在该浏览器新开 tab
ma-browser status                      # 每个浏览器的连接与健康状态
ma-browser cdp detach 9222             # 停止接管（浏览器继续运行）
```

tab ID 在所有浏览器间唯一，`--tab <id>` 总能落到正确的浏览器。不带 `--tab` 时由 `--browser` 选浏览器，否则落到当前 tab 所在浏览器，再否则落到默认浏览器。MCP 对应 `browser_cdp_list` / `browser_cdp_attach` / `browser_cdp_detach`，`browser_open`、`browser_tab_new`、`browser_tab_list`、`site_run` 支持 `browser` 参数。

**冷启动用哪个浏览器**（CLI 与 daemon 同一策略）：`BB_BROWSER_CDP_URL[S]` / `--port` → 正在运行的受管浏览器 → 本机发现的其他可调试浏览器 → 启动受管浏览器。只有本机没有任何可调试浏览器时才会自己启动。扫描只限 loopback：端口 9222、9229、19825–19865（奇数），加上运行中浏览器命令行里的 `--remote-debugging-port` 和 `DevToolsActivePort` 文件。已接管的浏览器断开时，其 tab 返回可读错误，并在后台自动重连。

| 变量 | 作用 |
|---|---|
| `BB_BROWSER_CDP_URLS=http://127.0.0.1:9222,http://127.0.0.1:9333` | 显式端点：第一个可达的作默认，其余在启动时接管 |
| `BB_CDP_DISCOVERY=0` / `all` | 关闭扫描 / 启动时接管全部发现的浏览器（默认 `1`：扫描，接管一个） |
| `BB_CDP_SCAN_PORTS=9300,9400-9410` | 额外扫描的端口 |
| `BB_CDP_ALLOW_REMOTE=1` | 允许 `cdp attach` 非本机主机（或传 `--allow-remote`）。能访问该端口的人都能控制那个浏览器 |

## Daemon 配置

Daemon 默认绑定 `127.0.0.1:19824`，可通过 `--host` 自定义监听地址：

```bash
ma-browser daemon --host 127.0.0.1    # 仅 IPv4（解决 macOS IPv6 问题）
ma-browser daemon --host 0.0.0.0      # 监听所有网卡（用于 Tailscale / ZeroTier 跨机器访问）
```

## 架构

```
AI Agent (Claude Code, Codex, Cursor 等)
       │ CLI 或 MCP (stdio)
       ▼
ma-browser CLI ──HTTP──▶ Daemon ──CDP WebSocket──▶ 你的真实浏览器
                           │
                    ┌──────┴──────┐
                    │ Per-tab     │
                    │ 事件缓存    │
                    │ (network,   │
                    │  console,   │
                    │  errors)    │
                    └─────────────┘
```

## 致谢

MultiAgentsBrowser 由 **epiral** 的 [bb-browser](https://github.com/epiral/bb-browser)（MIT）
演化而来，本仓库完整保留了上游提交历史。社区站点适配器仍位于
[epiral/bb-sites](https://github.com/epiral/bb-sites)。

## 许可证

[MIT](LICENSE)
