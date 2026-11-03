# Site 系统 — 把任何网站变成命令行 API

## 核心概念

Site 系统通过 adapter（适配器）将网站功能 CLI 化。每个 adapter 是一个 JS 文件，在用户真实浏览器中执行，复用登录态，返回结构化 JSON。

<!-- 证据来源：packages/cli/src/commands/site.ts -->

## 命令速查

```bash
# 列出所有可用 adapter（按平台分组）
ma-browser site list

# 搜索 adapter（模糊匹配名称、描述、域名）
ma-browser site search <query>

# 运行 adapter（简写，推荐）
ma-browser site <name> [args...]

# 运行 adapter（完整写法）
ma-browser site run <name> [args...]

# 更新社区 adapter 库（从 github.com/epiral/bb-sites 拉取）
ma-browser site update

# 查看 adapter 开发指南
ma-browser guide
```

## 参数传递

支持两种格式混合使用：

```bash
# 位置参数（按 adapter 定义的参数顺序）
ma-browser site reddit/thread https://www.reddit.com/r/LocalLLaMA/comments/...

# 命名参数（--flag value 格式）
ma-browser site github/pr-create epiral/bb-sites --title "feat: ..." --head "user:branch"

# 混合使用
ma-browser site twitter/search "AI agent" --count 20
```

<!-- 证据来源：site.ts:290-314 参数解析逻辑 -->

## Adapter 目录与优先级

```
~/.bb-browser/
├── sites/              # 私有 adapter（优先级高，覆盖同名社区 adapter）
│   └── platform/
│       └── command.js
└── bb-sites/           # 社区 adapter（通过 ma-browser site update 拉取）
    └── platform/
        └── command.js
```

私有 adapter 优先于社区同名 adapter。

<!-- 证据来源：site.ts:24-26 目录常量，site.ts:148-157 getAllSites() 合并逻辑 -->

## 自动 Tab 管理

运行 adapter 时，系统自动处理 tab：

1. 如果指定了 `--tab <tabId>`，直接使用该 tab
2. 否则，根据 adapter 的 `domain` 字段查找已打开的匹配 tab
3. 如果没有匹配的 tab，自动打开新 tab 并等待 3 秒加载

域名匹配规则：精确匹配或子域名匹配（如 `x.com` 匹配 `api.x.com`）。

<!-- 证据来源：site.ts:162-169 matchTabOrigin()，site.ts:342-368 tab 查找逻辑 -->

## 错误处理与登录提示

adapter 返回 `{error: "...", hint: "..."}` 时，系统自动检测登录相关错误（匹配 `401|403|unauthorized|forbidden|not.?logged|login.?required|sign.?in|auth`），并提示用户先在浏览器中登录。

```bash
# 错误示例
[error] site twitter/search: HTTP 401
  Hint: Please log in to https://twitter.com in your browser first, then retry.
```

<!-- 证据来源：site.ts:406-427 错误处理逻辑 -->

## 36 平台完整列表

<!-- 证据来源：README.md "36 platforms, 103 commands"，具体 adapter 数量以 ma-browser site list 实际输出为准 -->

### 搜索引擎

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Google | `site google/search "query"` | 搜索 |
| Baidu | `site baidu/search "query"` | 百度搜索 |
| Bing | `site bing/search "query"` | 必应搜索 |
| DuckDuckGo | `site duckduckgo/search "query"` | DuckDuckGo 搜索 |
| Sogou WeChat | `site sogou/wechat "query"` | 搜狗微信文章搜索 |

### 社交媒体

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Twitter/X | `site twitter/search "query"` | 搜索推文 |
| Twitter/X | `site twitter/user <handle>` | 用户信息 |
| Reddit | `site reddit/thread <url>` | 帖子详情 |
| Reddit | `site reddit/search "query"` | 搜索 |
| Weibo | `site weibo/search "query"` | 微博搜索 |
| Weibo | `site weibo/hot` | 微博热搜 |
| Xiaohongshu | `site xiaohongshu/search "query"` | 小红书搜索 |
| Jike | `site jike/feed` | 即刻动态 |
| LinkedIn | `site linkedin/search "query"` | 搜索 |
| LinkedIn | `site linkedin/profile <url>` | 个人资料 |
| Hupu | `site hupu/hot` | 虎扑热帖 |

### 新闻资讯

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| BBC | `site bbc/headlines` | BBC 头条 |
| Reuters | `site reuters/search "query"` | 路透社搜索 |
| 36kr | `site 36kr/newsflash` | 36氪快讯 |
| Toutiao | `site toutiao/hot` | 今日头条热榜 |
| Eastmoney | `site eastmoney/news "query"` | 东方财富新闻 |

### 技术开发

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| GitHub | `site github/repo <owner/repo>` | 仓库信息 |
| GitHub | `site github/issues <owner/repo>` | Issue 列表 |
| GitHub | `site github/pr-create <repo> --title "..."` | 创建 PR |
| StackOverflow | `site stackoverflow/search "query"` | 搜索 |
| HackerNews | `site hackernews/top` | 热门帖子 |
| CSDN | `site csdn/search "query"` | CSDN 搜索 |
| cnblogs | `site cnblogs/search "query"` | 博客园搜索 |
| V2EX | `site v2ex/hot` | V2EX 热帖 |
| Dev.to | `site devto/search "query"` | Dev.to 搜索 |
| npm | `site npm/package <name>` | npm 包信息 |
| PyPI | `site pypi/package <name>` | PyPI 包信息 |
| arXiv | `site arxiv/search "query"` | 论文搜索 |

### 视频平台

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| YouTube | `site youtube/search "query"` | 搜索视频 |
| YouTube | `site youtube/transcript <video_id>` | 获取字幕 |
| Bilibili | `site bilibili/search "query"` | B站搜索 |
| Bilibili | `site bilibili/popular` | B站热门 |

### 影音娱乐

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Douban | `site douban/movie <name>` | 豆瓣电影 |
| Douban | `site douban/top250` | 豆瓣 Top250 |
| IMDb | `site imdb/search "query"` | IMDb 搜索 |
| Genius | `site genius/search "query"` | 歌词搜索 |
| Qidian | `site qidian/search "query"` | 起点小说搜索 |

### 财经股票

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Eastmoney | `site eastmoney/stock "茅台"` | 股票查询 |
| Yahoo Finance | `site yahoo-finance/stock <ticker>` | 股票行情 |

### 求职招聘

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| BOSS Zhipin | `site boss/search "query"` | BOSS 直聘搜索 |
| BOSS Zhipin | `site boss/detail <url>` | 职位详情 |

### 知识百科

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Wikipedia | `site wikipedia/search "query"` | 维基百科搜索 |
| Wikipedia | `site wikipedia/summary "topic"` | 摘要 |
| Zhihu | `site zhihu/hot` | 知乎热榜 |
| Zhihu | `site zhihu/question <id>` | 问题详情 |
| Open Library | `site openlibrary/search "query"` | 图书搜索 |

### 消费购物

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| SMZDM | `site smzdm/search "query"` | 什么值得买搜索 |

### 实用工具

| 平台 | 命令示例 | 说明 |
|------|---------|------|
| Youdao | `site youdao/translate "text"` | 有道翻译 |
| GSMArena | `site gsmarena/search "phone"` | 手机参数 |
| Product Hunt | `site producthunt/trending` | 热门产品 |
| Ctrip | `site ctrip/search "destination"` | 携程搜索 |

## 常用场景示例

### 信息检索

```bash
# 搜索技术话题
ma-browser site twitter/search "Claude Code"
ma-browser site reddit/search "local LLM"
ma-browser site hackernews/top

# 查看热榜
ma-browser site zhihu/hot
ma-browser site weibo/hot
ma-browser site v2ex/hot

# 查询股票
ma-browser site eastmoney/stock "茅台"
```

### 开发辅助

```bash
# GitHub 操作
ma-browser site github/repo anthropics/claude-code
ma-browser site github/issues owner/repo

# 查包信息
ma-browser site npm/package ma-browser
ma-browser site pypi/package requests

# 搜索技术问题
ma-browser site stackoverflow/search "async await error handling"
```

### 内容获取

```bash
# 获取 YouTube 字幕
ma-browser site youtube/transcript dQw4w9WgXcQ

# 获取 Reddit 帖子完整内容
ma-browser site reddit/thread https://www.reddit.com/r/LocalLLaMA/comments/...

# 论文搜索
ma-browser site arxiv/search "transformer attention mechanism"
```

## 与 --json 配合

所有 site 命令都支持 `--json` 输出结构化数据：

```bash
ma-browser site zhihu/hot --json
ma-browser site twitter/search "AI" --json
```

## 新闻站包生成（零 token）

```bash
ma-browser site generate ifanr https://www.ifanr.com   # 生成 ifanr/latest + ifanr/article
ma-browser site heal ifanr                             # 站点搬家/改版后重新生成
ma-browser site generate members https://news.example.com --browser   # 需登录的站点
```

- 默认由 CLI 进程直接请求站点，不带任何登录态。
- `--browser`：探测请求改在浏览器里**完全同源**（协议+主机+端口）的标签页中发出（已打开的优先，否则临时打开、等待就绪，结束后只关闭这些临时页），复用用户已有登录态。先在浏览器里登录，再运行。
- `site run` 运行生成包时只选与 `_package.json` 的 base 完全同源的标签页（同主机不同端口/协议的页不会被误用），没有就在 base 新开；显式 `--tab` 与独占租约照旧生效。
- 自动修复：生成包在 `site run` 中失败时，daemon 用浏览器登录态（同样的同源标签页探测）重新探测/生成一次并重试一次；同包并发失败共用一次修复，60s 冷却。
- 失败行为：浏览器不可达、单请求超过 15s、临时页 15s 内未到达目标 origin 都直接报错；登录失效（401 等）使检查不通过——都不写包、不覆盖原包、不报成功。
- Node 回退：仅当页内 fetch 网络错误（典型为站点搬家时跨 origin 重定向被 CORS 拦截）才改用 CLI/daemon 进程直接请求，用于发现新地址；该请求不带登录态，需登录的内容在这一步会检查失败。
- cookie 只留在浏览器中，生成的包和 `_package.json` 只记录 base / feedUrl，不含凭据；生成的 adapter 运行时同样走浏览器登录态。
- 只能读取当前账户有权访问的内容，不绕过付费墙或验证。

## 更多信息

- 创建自定义 adapter：参见 [adapter-development.md](adapter-development.md)
- 社区 adapter 仓库：https://github.com/epiral/bb-sites
