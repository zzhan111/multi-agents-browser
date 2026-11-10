---
name: ma-browser
description: 强大的信息获取与浏览器自动化工具。通过浏览器 + 用户登录态，获取公域和私域信息。可访问任意网页、内部系统、登录后页面，执行表单填写、信息提取、页面操作。支持 Windows 托盘有头/无头浏览器模式查询与切换、site 系统、带登录态的 fetch、网络请求拦截与操作录制。
allowed-tools: Bash(ma-browser:*)
---

# ma-browser - 信息获取与浏览器自动化

## 核心价值

通过浏览器 + 用户登录态，可以获取：
- 公域信息：任意公开网页、搜索结果、新闻资讯
- 私域信息：内部系统、企业应用、登录后页面、个人账户数据

还可以代替用户执行浏览器操作：表单填写、按钮点击、数据提取、截图保存、批量操作。

运行在用户真实浏览器中，复用已登录的账号，不触发反爬检测。

## 浏览器模式（Windows 托盘）

```bash
ma-browser mode status --json    # 查询当前模式和托盘连接
ma-browser mode headed --json    # 切到有头，供用户交互登录
ma-browser mode headless --json  # 切回无头
```

MCP 使用 `browser_mode`，参数 `mode` 为 `status`、`headed` 或 `headless`（默认 `status`）。切换会重启所有 Agent 共享的浏览器，旧 tab ID 失效，未保存的页面内容可能丢失；切换后重新查询 tab。只读会话仅可查询。 托盘管理 daemon 时，MCP 环境设置 `MA_BROWSER_CONNECT_ONLY=1`，避免切换期间重复启动 daemon。

## 快速开始

```bash
ma-browser open <url>        # 打开页面（新 tab）
ma-browser snapshot -i       # 获取可交互元素
ma-browser click @5          # 点击元素
ma-browser fill @3 "text"    # 填写输入框
ma-browser close             # 完成后关闭 tab
```

## Site 系统 — 把任何网站变成命令行 API

site 系统是 ma-browser 的核心特性，通过 adapter 将网站功能 CLI 化，覆盖 36+ 平台。

```bash
# 常用命令
ma-browser site list                          # 列出所有 adapter
ma-browser site search <query>                # 搜索 adapter
ma-browser site <name> [args...]              # 运行 adapter
ma-browser site update                        # 更新社区 adapter 库

# 使用示例
ma-browser site twitter/search "Claude Code"  # 搜索推文
ma-browser site zhihu/hot                     # 知乎热榜
ma-browser site github/repo owner/repo        # 仓库信息
ma-browser site youtube/transcript <video_id> # 获取字幕
ma-browser site reddit/thread <url>           # 帖子详情
ma-browser site eastmoney/stock "茅台"         # 股票查询
ma-browser site weibo/hot                     # 微博热搜
ma-browser site arxiv/search "transformer"    # 论文搜索
```

adapter 自动处理 tab 管理（查找匹配域名的 tab 或新建），自动检测登录错误并提示。

详细用法和 36 平台完整列表：参见 [references/site-system.md](references/site-system.md)
创建自定义 adapter：参见 [references/adapter-development.md](references/adapter-development.md)

## fetch — 带登录态的 curl

在浏览器上下文中执行 fetch，自动携带 Cookie 和登录态。

```bash
ma-browser fetch <url>                                    # GET 请求
ma-browser fetch <url> --method POST --body '{"k":"v"}'   # POST 请求
ma-browser fetch <url> --headers '{"Auth":"Bearer xxx"}'  # 自定义请求头
ma-browser fetch <url> --output data.json                 # 保存到文件
ma-browser fetch /api/me.json                             # 相对路径（用当前 tab 的 origin）
```

自动域名路由：绝对路径自动查找匹配 tab 或新建；相对路径使用当前 tab。

详细用法：参见 [references/fetch-and-network.md](references/fetch-and-network.md)

## Tab 管理规范

操作完成后必须关闭自己打开的 tab。

```bash
# 单 tab 场景
ma-browser open https://example.com    # 打开新 tab
ma-browser snapshot -i
ma-browser click @5
ma-browser close                        # 完成后关闭

# 多 tab 场景：用 --json 返回的短 ID（如 a1f3）定位，不要用 index
ma-browser open https://site-a.com --json   # data.tab: a1f3
ma-browser open https://site-b.com --json   # data.tab: 9c2e
# ... 操作 ...
ma-browser tab close --id a1f3
ma-browser tab close --id 9c2e

# 指定 tab 操作
ma-browser open https://example.com --tab current  # 在当前 tab 打开（不新建）
ma-browser open https://example.com --tab 123      # 在指定 tabId 打开
```

## 核心工作流

1. `open` 打开页面
2. `snapshot -i` 查看可操作元素（返回 @ref）
3. 用 `@ref` 执行操作（click, fill, etc.）
4. 页面变化后重新 `snapshot -i`
5. 任务完成后 `close` 关闭 tab

## 命令速查

### 导航

```bash
ma-browser open <url>                # 打开 URL（新 tab）
ma-browser open <url> --tab current  # 在当前 tab 打开
ma-browser back                      # 后退
ma-browser forward                   # 前进
ma-browser refresh                   # 刷新
ma-browser close                     # 关闭当前 tab
```

### 快照

```bash
ma-browser snapshot             # 完整页面结构
ma-browser snapshot -i          # 只显示可交互元素（推荐）
ma-browser snapshot -c          # 移除空结构节点
ma-browser snapshot -d 3        # 限制树深度为 3 层
ma-browser snapshot -s ".main"  # 限定 CSS 选择器范围
ma-browser snapshot --json      # JSON 格式输出
# 选项可组合：ma-browser snapshot -i -c -d 5
```

### 元素交互

```bash
ma-browser click @5             # 点击
ma-browser hover @5             # 悬停
ma-browser fill @3 "text"       # 清空并填写
ma-browser type @3 "text"       # 追加输入（不清空）
ma-browser check @7             # 勾选复选框
ma-browser uncheck @7           # 取消勾选
ma-browser select @4 "option"   # 下拉选择
ma-browser press Enter          # 按键
ma-browser press Control+a      # 组合键
ma-browser scroll down          # 向下滚动（默认 300px）
ma-browser scroll up 500        # 向上滚动 500px
```

### 获取信息

```bash
ma-browser get text @5          # 获取元素文本
ma-browser get url              # 获取当前 URL
ma-browser get title            # 获取页面标题
```

### Tab 管理

```bash
ma-browser tab                  # 列出所有 tab
ma-browser tab new [url]        # 新建 tab
ma-browser tab 2                # 切换到第 2 个 tab（按 index）
ma-browser tab select --id 123  # 切换到指定 tabId 的 tab
ma-browser tab close            # 关闭当前 tab
ma-browser tab close 3          # 关闭第 3 个 tab（按 index）
ma-browser tab close --id 123   # 关闭指定 tabId 的 tab
ma-browser tab claim --id 123 --intent "核对订单"  # 独占 tab（其他 agent 操作会被拒绝）
ma-browser tab release --id 123                  # 释放独占
```

### 截图

```bash
ma-browser screenshot           # 截图（自动保存）
ma-browser screenshot path.png  # 截图到指定路径
```

### 等待

```bash
ma-browser wait 2000            # 等待 2 秒
ma-browser wait @5              # 等待元素出现
```

### JavaScript

```bash
ma-browser eval "document.title"              # 执行 JS
ma-browser eval "window.scrollTo(0, 1000)"    # 滚动到指定位置
```

### Frame 切换

```bash
ma-browser frame "#iframe-id"   # 切换到 iframe
ma-browser frame main           # 返回主 frame
```

### 对话框处理

```bash
ma-browser dialog accept        # 确认对话框
ma-browser dialog dismiss       # 取消对话框
ma-browser dialog accept "text" # 确认并输入（prompt）
```

### 网络与调试

```bash
ma-browser network requests                        # 查看网络请求
ma-browser network requests "api" --with-body       # 过滤 + 完整请求/响应体
ma-browser network route "*analytics*" --abort      # 拦截并阻止请求
ma-browser network route "*/api/user" --body '{}'   # 拦截并 mock 响应
ma-browser network unroute                          # 移除所有拦截规则
ma-browser network clear                            # 清空请求记录
ma-browser console                                  # 查看控制台消息
ma-browser console --clear                          # 清空控制台
ma-browser errors                                   # 查看 JS 错误
ma-browser errors --clear                           # 清空错误记录
ma-browser trace start                              # 开始录制用户操作
ma-browser trace stop                               # 停止录制，输出事件列表
ma-browser trace status                             # 查看录制状态
```

详细的 network 高级用法：参见 [references/fetch-and-network.md](references/fetch-and-network.md)

### 多浏览器（接管已有 Chrome）

```bash
ma-browser cdp list --json          # 本机可调试浏览器：id/browser/userDataDir/tabs/managed/attached/default
ma-browser cdp attach 9222          # 接管用户已用 --remote-debugging-port=9222 启动的 Chrome（复用其登录态）
ma-browser cdp attach --all         # 全部接管，并行使用
ma-browser tab list --browser 9222  # tab 列表带 browser 字段；--browser 过滤
ma-browser open <url> --browser 9222 --json   # 在指定浏览器新开 tab，记下 data.tab
ma-browser cdp detach 9222          # 停止接管，不关闭浏览器
```

- tab ID 跨浏览器唯一：拿到 tab 后一律用 `--tab`，不用再带 `--browser`。
- 需要用户本人的登录态时先 `cdp list`；没有可接管的浏览器，就请用户用 `--remote-debugging-port=9222 --user-data-dir=<目录>` 启动 Chrome，不要自己杀掉或重启用户的浏览器。
- 报错 `Nothing is listening` / `not a Chrome DevTools endpoint` / `Refusing non-loopback` 时按提示换端口；非本机需用户明确同意后加 `--allow-remote`。

## 全局选项

```bash
--json               # 以 JSON 格式输出（所有命令通用）
--tab <tabId>        # 指定操作的标签页 ID（几乎所有命令通用）
--browser <id>       # 无 --tab 时把命令/新 tab 路由到该浏览器（cdp list 的 id）
--mcp                # 启动 MCP server（用于 Claude Code / Cursor 等 AI 工具）
```

## Ref 使用说明

snapshot 返回的 `@ref` 是元素的临时标识：

```
@1 [button] "提交"
@2 [input type="text"] placeholder="请输入姓名"
@3 [a] "查看详情"
```

注意：
- 页面导航后 ref 失效，需重新 snapshot
- 动态内容加载后需重新 snapshot
- ref 格式：`@1`, `@2`, `@3`...

详细说明：参见 [references/snapshot-refs.md](references/snapshot-refs.md)

## 多 Agent 共用浏览器

多个 agent 共用同一个 daemon 和 Chrome（同一份登录态）。每个 agent 设置自己的会话 ID，
daemon 就会分别记住各自的"当前 tab"、权限和独占，互不干扰：

```bash
export BB_SESSION_ID=agent-research      # 每个 agent 一个固定值；不设则共用 default 会话
export BB_SESSION_LABEL=research         # 可选：显示名，同名 label 跨重启映射到同一 agentId
export BB_SESSION_SCOPE=no-eval          # 可选：read-only / no-eval，只能收紧不能放宽

ma-browser open https://example.com --json          # 记下 data.tab
ma-browser tab claim --id <tab> --intent "填表"      # 长任务先独占，防止别的 agent 误操作
# ... snapshot / click / fill ...
ma-browser tab release --id <tab>
ma-browser tab close --id <tab>
```

- 独占的 tab 被其他会话操作时返回 `exclusively held by another session`，换一个 tab 即可，不要重试抢占。
- 会话闲置 24 小时（`BB_SESSION_IDLE_HOURS`）后自动失效，并释放它的独占。
- 不同会话仍共享 Cookie：账号隔离需要另一个 profile/daemon。

## 并发操作

```bash
# 并发打开多个页面（各自独立 tab）
ma-browser open https://site-a.com &
ma-browser open https://site-b.com &
ma-browser open https://site-c.com &
wait
# 每个返回独立的 tabId，互不干扰
```

## 信息提取 vs 页面操作

根据目的选择不同的方法：

### 提取页面内容（用 eval）

当需要提取文章、正文等长文本时，用 `eval` 直接获取：

```bash
# 微信公众号文章
ma-browser eval "document.querySelector('#js_content').innerText"

# 知乎回答
ma-browser eval "document.querySelector('.RichContent-inner').innerText"

# 通用：获取页面主体文本
ma-browser eval "document.body.innerText.substring(0, 5000)"

# 获取所有链接
ma-browser eval "[...document.querySelectorAll('a')].map(a => a.href).join('\n')"
```

有些网站 DOM 嵌套很深，snapshot 输出冗长，`eval` 直接提取文本更高效。

### 操作页面元素（用 snapshot -i）

当需要点击、填写、选择时，用 `snapshot -i` 获取可交互元素：

```bash
ma-browser snapshot -i
# @1 [button] "登录"
# @2 [input] placeholder="用户名"
# @3 [input type="password"]

ma-browser fill @2 "username"
ma-browser fill @3 "password"
ma-browser click @1
```

`-i` 只显示可交互元素，过滤掉大量无关内容。

## MCP 集成

ma-browser 提供 MCP server，可与 Claude Code / Cursor 等 AI 工具集成：

```bash
# 启动 MCP server
ma-browser --mcp
```

配置示例（Claude Code / Cursor）：
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

## 常见任务示例

### 表单填写

```bash
ma-browser open https://example.com/form
ma-browser snapshot -i
ma-browser fill @1 "张三"
ma-browser fill @2 "zhangsan@example.com"
ma-browser click @3
ma-browser wait 2000
ma-browser close
```

### 信息提取

```bash
ma-browser open https://example.com/dashboard
ma-browser snapshot -i
ma-browser get text @5
ma-browser screenshot report.png
ma-browser close
```

### 批量操作

```bash
for url in "url1" "url2" "url3"; do
  ma-browser open "$url"
  ma-browser snapshot -i --json
  ma-browser close
done
```

## 深入文档

| 文档 | 说明 |
|------|------|
| [references/site-system.md](references/site-system.md) | Site 系统完整指南：35 平台列表、命令用法、自动 tab 管理 |
| [references/adapter-development.md](references/adapter-development.md) | Adapter 开发指南：API 逆向、三层复杂度、元数据格式 |
| [references/fetch-and-network.md](references/fetch-and-network.md) | Fetch 与 Network 高级功能：带登录态请求、请求拦截与 mock |
| [references/snapshot-refs.md](references/snapshot-refs.md) | Ref 生命周期、最佳实践、常见问题 |
