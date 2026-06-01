# CLAUDE.md

## Trace Export — 已完成改进（2026-05-18）

以下原 roadmap 项已全部实现，记录于此供历史回溯。当前如需新增改进，请在文末"后续待改进项"追加。

### ✅ P1: 导航事件录制

- `trace-inject.ts` 监听 `popstate` 和 `hashchange`，捕获 SPA 内导航
- `cdp-connection.ts` 在 `Page.frameNavigated`（仅主框架）时发出 `navigation` trace 事件
- `tab-state.ts` 的 `addTraceNavigation` 按 URL 去重，避免 CDP redirect 链产生重复
- 导出脚本中渲染为 `page.goto(url)`；与 `activeTab.url` 相同的首条 navigation 会被跳过避免双重 goto

### ✅ P1: 选择器可移植性

ExportDialog 提供三个模式：
- **Auto**：`ref` → `cssSelector` → `xpath`（保留 bb-browser ref 优先级）
- **CSS**：`cssSelector` → `xpath`，便于在标准 Playwright/Selenium 环境运行
- **XPath**：仅用 `xpath`，跨 DOM 变化更稳定

JS/Playwright 在 XPath 模式下使用 `xpath=...` 前缀；Python 切换到 `By.XPATH`。

### ✅ P2: 步骤间等待机制

ExportDialog 新增"智能等待"开关（默认开启）：
- JS / Playwright：在 click/fill/select/check 前插入 `page.waitForSelector(sel)` 或 `locator(sel).waitFor()`
- Python：插入 `wait.until(EC.presence_of_element_located((by, sel)))`

### ✅ P2: 字符串转义

`esc()` 替换为 `q(str)` → 返回 `JSON.stringify(str)`，自动处理换行、制表符、Unicode、引号、反斜杠。生成的字符串字面量从单引号迁移到双引号。

### ✅ P3: Ring Buffer 上限

`TRACE_CAPACITY` 通过 `BB_TRACE_CAPACITY` 环境变量配置（默认 1000，最小 100）。缓冲首次写满时打印一次性 warning 到 daemon stderr：
```
[bb-browser] trace buffer full for tab <shortId> (cap=1000); oldest events will be discarded. Set BB_TRACE_CAPACITY to raise the limit.
```

---

## 后续待改进项

（暂无。在此追加新的 roadmap 条目。）

> 方向/脑暴讨论留存见 [docs/vision-and-roadmap-discussion.md](docs/vision-and-roadmap-discussion.md)（data & capability plane 主张、多 agent 接入、adapter 发现 —— 含未决岔路口，可随时捡回继续）

---

## MVP 2 实施记录（2026-05-28）

### ✅ Phase A — Daemon 新 HTTP 端点

- `packages/daemon/src/command-history.ts` — 200-entry ring buffer，记录每条 MCP 命令
- `packages/daemon/src/http-server.ts` 新增 `GET /api/overview`、`GET /api/commands`、`GET /api/logs`
- `packages/daemon/src/cdp-connection.ts` 新增 `chromeVersion` 字段
- `packages/daemon/src/index.ts` 接入 `CommandHistory` + `installLogInterceptor`

### ✅ Phase B — Tauri 控制面板窗口基础

- `tauri.conf.json` 注册 `control-panel` 窗口（960×680，Acrylic，默认隐藏）
- `commands.rs` `open_control_panel` 真实 show/focus 实现
- `app.rs` Acrylic 覆盖 popup + control-panel 双窗口
- popup `main.js` 按钮接通 `invoke("open_control_panel")`

### ✅ Phase C — React+Vite 控制面板前端 + TraceStudio 迁移

- `src-panel/` 新 Vite+React 项目；`build.outDir=../src, emptyOutDir:false`
- `Dashboard.jsx` — TitleBar + TabBar + 三 Tab 路由
- `api/daemon.js` 复用 web 版 + 新增 `getOverview() / getCommands() / getLogs()`
- `store/useStore.jsx` 扩展 overview / commands / logs state
- 7 个 TraceStudio 组件完整迁移（import 路径修正）

### ✅ Phase D — 三个 Tab 内容

- `TracePage.jsx` — TraceStudio 完整迁移（9 项功能 100% 保留）
- `OverviewPage.jsx` — 5s 轮询；端口/Token 一键复制；最近 50 条命令
- `LogsPage.jsx` — 3s 轮询；级别过滤；关键字高亮搜索；自动滚动

### ✅ Phase E — 开机自启 + 安装器

- `src/autostart.rs` — `winreg` 读写 `HKCU\...\Run`；非 Windows 平台 stub
- `commands.rs` 新增 `get_autostart` / `set_autostart` Tauri 命令
- `app.rs` 菜单 autostart 处理器接通注册表；初始 checkmark 从注册表读取
- `tauri.conf.json` `targets` 增加 `"msi"`；NSIS 改 `installMode: "currentUser"`
