<div align="center">

# MultiAgentsBrowser

### `ma-browser` — your browser as the API, shared safely by many AI agents

**Your browser is the API. No keys. No bots. No scrapers.**

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[English](README.md) · [中文](README.zh-CN.md)

</div>

---

You're already logged into Twitter, Reddit, YouTube, Zhihu, Bilibili, LinkedIn, GitHub — ma-browser lets AI agents **use that directly**.

```bash
ma-browser site twitter/search "AI agent"       # search tweets
ma-browser site zhihu/hot                        # trending on Zhihu
ma-browser site arxiv/search "transformer"       # search papers
ma-browser site eastmoney/stock "茅台"            # real-time stock quote
ma-browser site boss/search "AI engineer"        # search jobs
ma-browser site wikipedia/summary "Python"       # Wikipedia summary
ma-browser site youtube/transcript VIDEO_ID      # full transcript
ma-browser site stackoverflow/search "async"     # search SO questions
```

**103 commands across 36 platforms.** All using your real browser's login state. [Full list →](https://github.com/epiral/bb-sites)

## The idea

The internet was built for browsers. AI agents have been trying to access it through APIs — but 99% of websites don't offer one.

ma-browser flips this: **instead of forcing websites to provide machine interfaces, let machines use the human interface directly.** The adapter runs `eval` inside your browser tab, calls `fetch()` with your cookies, or invokes the page's own webpack modules. The website thinks it's you. Because it **is** you.

| | Playwright / Selenium | Scraping libs | ma-browser |
|---|---|---|---|
| Browser | Headless, isolated | No browser | Your real Chrome |
| Login state | None, must re-login | Cookie extraction | Already there |
| Anti-bot | Detected easily | Cat-and-mouse | Invisible — it IS the user |
| Complex auth | Can't replicate | Reverse engineer | Page handles it itself |

## Quick Start

### Install

```bash
npm install -g ma-browser
```

### Use

```bash
ma-browser site update        # pull community adapters
ma-browser site recommend     # see which adapters match your browsing habits
ma-browser site zhihu/hot     # go
```

### OpenClaw (no extension needed)

If you use [OpenClaw](https://openclaw.ai), ma-browser runs directly through OpenClaw's built-in browser — no Chrome extension or daemon required:

```bash
ma-browser site reddit/hot --openclaw
ma-browser site xueqiu/hot-stock 5 --openclaw --jq '.items[] | {name, changePercent}'
```

Skill on ClawHub: [ma-browser-openclaw](https://clawhub.ai/yan5xu/ma-browser)

### MCP (Claude Code / Cursor)

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

## 36 platforms, 103 commands

Community-driven via [bb-sites](https://github.com/epiral/bb-sites). One JS file per command.

| Category | Platforms | Commands |
|----------|-----------|----------|
| **Search** | Google, Baidu, Bing, DuckDuckGo, Sogou WeChat | search |
| **Social** | Twitter/X, Reddit, Weibo, Xiaohongshu, Jike, LinkedIn, Hupu | search, feed, thread, user, notifications, hot |
| **News** | BBC, Reuters, 36kr, Toutiao, Eastmoney | headlines, search, newsflash, hot |
| **Dev** | GitHub, StackOverflow, HackerNews, CSDN, cnblogs, V2EX, Dev.to, npm, PyPI, arXiv | search, issues, repo, top, thread, package |
| **Video** | YouTube, Bilibili | search, video, transcript, popular, comments, feed |
| **Entertainment** | Douban, IMDb, Genius, Qidian | movie, search, top250 |
| **Finance** | Xueqiu, Eastmoney, Yahoo Finance | stock, hot stocks, feed, watchlist, search |
| **Jobs** | BOSS Zhipin, LinkedIn | search, detail, profile |
| **Knowledge** | Wikipedia, Zhihu, Open Library | search, summary, hot, question |
| **Shopping** | SMZDM | search deals |
| **Tools** | Youdao, GSMArena, Product Hunt, Ctrip | translate, phone specs, trending products |

## 10 minutes to add any website

```bash
ma-browser guide    # full tutorial
```

Tell your AI agent: *"turn XX website into a CLI"*. It reads the guide, reverse-engineers the API with `network --with-body`, writes the adapter, tests it, and submits a PR. All autonomously.

Three tiers of adapter complexity:

| Tier | Auth method | Example | Time |
|------|-------------|---------|------|
| **1** | Cookie (fetch directly) | Reddit, GitHub, V2EX | ~1 min |
| **2** | Bearer + CSRF token | Twitter, Zhihu | ~3 min |
| **3** | Webpack injection / Pinia store | Twitter search, Xiaohongshu | ~10 min |

We tested this: **20 AI agents ran in parallel, each independently reverse-engineered a website and produced a working adapter.** The marginal cost of adding a new website to the agent-accessible internet is approaching zero.

## What this means for AI agents

Without ma-browser, an AI agent's world is: **files + terminal + a few APIs with keys.**

With ma-browser: **files + terminal + the entire internet.**

An agent can now, in under a minute:

```bash
# Cross-platform research on any topic
ma-browser site arxiv/search "retrieval augmented generation"
ma-browser site twitter/search "RAG"
ma-browser site github search rag-framework
ma-browser site stackoverflow/search "RAG implementation"
ma-browser site zhihu/search "RAG"
ma-browser site 36kr/newsflash
```

Six platforms, six dimensions, structured JSON. Faster and broader than any human researcher.

## Also a full browser automation tool

```bash
ma-browser open https://example.com
ma-browser snapshot -i                # accessibility tree
ma-browser click @3                   # click element
ma-browser fill @5 "hello"            # fill input
ma-browser eval "document.title"      # run JS
ma-browser fetch URL --json           # authenticated fetch
ma-browser network requests --with-body --json  # capture traffic
ma-browser screenshot                 # take screenshot
```

All commands support `--json` output, `--jq <expr>` for inline filtering, and `--tab <id>` for concurrent multi-tab operations.

```bash
ma-browser site xueqiu/hot-stock 5 --jq '.items[] | {name, changePercent}'
# {"name":"云天化","changePercent":"2.08%"}
# {"name":"东芯股份","changePercent":"-7.60%"}

ma-browser site info xueqiu/stock   # view adapter args, example, domain
```

## Daemon configuration

The daemon binds to `127.0.0.1:19824` by default. You can customize the host with `--host`:

```bash
ma-browser daemon --host 127.0.0.1    # IPv4 only (fix macOS IPv6 issues)
ma-browser daemon --host 0.0.0.0      # listen on all interfaces (for Tailscale / ZeroTier remote access)
```

## Architecture

```
AI Agent (Claude Code, Codex, Cursor, etc.)
       │ CLI or MCP (stdio)
       ▼
ma-browser CLI ──HTTP──▶ Daemon ──CDP WebSocket──▶ Your Real Browser
                           │
                    ┌──────┴──────┐
                    │ Per-tab     │
                    │ event cache │
                    │ (network,   │
                    │  console,   │
                    │  errors)    │
                    └─────────────┘
```

## Credits

MultiAgentsBrowser evolved from [bb-browser](https://github.com/epiral/bb-browser)
by **epiral** (MIT). The full upstream commit history is preserved in this
repository. Community site adapters still live at
[epiral/bb-sites](https://github.com/epiral/bb-sites).

## License

[MIT](LICENSE)
