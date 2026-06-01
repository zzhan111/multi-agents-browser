# bb-browser / bb-tray 方向讨论记录

> 这是一份**脑暴/方向讨论的留存**，不是已定方案。目的是不让讨论丢失，以后可随时从"未决岔路口"接着展开。
> 起始日期：2026-06-01

---

## 0. 一句话主张

> **bb-browser 正在从"一个 agent 能驱动的浏览器"，进化成"夹在所有 agent 和 web 之间的数据与能力中枢（data & capability plane）"。**

中枢上只活着四类东西：

| 层 | 用户原话 | 当前已有地基 |
|---|---|---|
| **能力层**（怎么拿数据） | ①浏览器即 API ②脚本固化 | site adapters、trace 导出、`browser_network` 抓 API |
| **数据层**（拿到了什么） | ⑤数据本地统一、反孤岛 | command-history（雏形）、trace ring buffer |
| **接入层**（谁能用） | ④本地 + 异地 agent 共用 | 0.0.0.0 bind、WSL host 改写、全局 MCP |
| **操作台**（编排这一切） | ③图形界面创造/存储/调用/更新 | Tauri 控制面板、TraceStudio、Overview/Logs |

### 飞轮（核心洞察）

```
agent 浏览(④)  →  抓到底层 API(①)  →  固化成命名能力(②)
     ↑                                          ↓
结果不回 agent，沉淀到本地(⑤)  ←  在操作台里管理/版本化(③)
     ↓
下一个 agent 不用重新浏览，直接调 API + 读缓存数据
```

越多 agent 用，能力和数据越厚，重复浏览越少 → **单个本地节点产生网络效应**。这是区别于"又一个 MCP 浏览器工具"的护城河。

---

## 1. bb-sites 与"①浏览器即 API"的关系（已澄清）

**结论：bb-sites 正是 ①② 已经落地的部分，但停在"晋升 MCP 工具"的前一层。**

### bb-sites 现状

- `~/.bb-browser/bb-sites/`（社区）+ `~/.bb-browser/sites/`（私有，优先级更高）
- 36 平台 / 103 命令，每个一个 JS 文件，带 `/* @meta */`（name / description / domain / args / capabilities / readOnly）
- 复用真实浏览器登录态，返回结构化 JSON
- 开发流程本身就是"浏览器即 API"：`network` 逆向 → `eval` 验证 → 写 adapter
- 证据：`packages/cli/src/commands/site.ts`、`skills/bb-browser/references/{site-system,adapter-development}.md`

### 距离"晋升 MCP 工具"的三个差距

1. **103 个命令在 MCP 侧塌缩成 1 个泛型工具** `site_run(name, args, namedArgs)`（`packages/mcp/src/index.ts:650`）。agent 看不到 `twitter_search(query)`，得先 `site_search` 再拼字符串 key 调用 —— 发现成本和拼参成本都压在 agent 身上。
2. **捕获是纯手工**：跑 `network` → 肉眼看 → 手写 JS → 存盘。没有"一键冻结网络请求成 adapter"的机制。
3. **签名没进协议**：`@meta.args` 是文本描述，MCP 暴露的是无类型 `string[]`，也没有响应 schema。

### "①" 的精确再定义

> bb-sites 是底座（库）。"①API 捕获→晋升 MCP 工具" = 在它之上补两个 delta：
> - **(a) 自动冻结**：`browser_network` 抓到的请求一键变 adapter（URL/headers/鉴权/参数 + 推断响应 schema）
> - **(b) 每个 adapter 自动注册成带类型签名的独立 MCP 工具**

---

## 2. 用户当前聚焦的两条线

### 线 A：发现 / 调用做得更好（双受众）

**关键洞察：一份元数据，两个渲染。** `@meta` 已存在每个 adapter 里，缺的是 daemon 侧的**目录端点**（现有 `/api/overview` `/api/commands` `/api/logs`，**没有 `/api/sites`**）。补上后 agent 端（MCP）和人/UI 端（Tauri）消费同一份目录。

- **给 agent**：别把 103 个都注册成原生工具（context 会爆，选工具准确率下降）。
  - 旁证：当前 Claude 环境就把 bb-browser 工具 **deferred + ToolSearch** 延迟加载。
  - 正确形态 = **search-first / 按需加载**：把 `site_search`/`site_recommend` 做强（语义 + 按当前 tab 域名/历史排序）；agent 锁定平台后再动态注册 `twitter/*` 为真工具，用完回收。
- **给人（UI）**：面板加 **Capabilities Tab** —— 可搜索目录（按平台分组、签名/示例/readOnly/本地 vs 社区/健康状态/最近使用），把 `@meta.args` 渲染成表单 → 一键跑 → 内联看 JSON（adapter 版 Postman/Swagger UI）。顺便是 ③ 操作台入口。

### 线 B：多 agent 调用（用户重心）

**重新框定**：网络可达性已解决。真正硬问题是 **"N 个 agent 共享同一个有状态的物理浏览器，怎么不互相踩。"** 共享登录态是核心价值，但 tab 状态会被争抢。

五个维度：

| 维度 | 现状 | 缺口 |
|---|---|---|
| **身份** | 匿名 / 单 token | 没 per-agent 身份 → 无法归因/限流/路由 tab |
| **隔离/并发** | 共用 active tab | 竞态。需 tab 租约 / per-agent 命名空间 / session 抽象 |
| **调度** | 串行? | 单物理资源。需队列 + per-agent 并发上限 + 公平性 |
| **权限/信任** | 远程能跑 `eval`? | **安全命门**：远程 `eval` = 带登录态浏览器里跑任意代码。需 scope：只读 vs 全权 |
| **审计** | command-history 有雏形 | 缺 agent 归因 + UI 实时"谁在干什么" |

**生命周期串联：**

```
agent 连上 → 标识身份 → 拿到「被允许看到」的 scoped catalog
           → 调用时租 tab、进队列、被审计 → UI 实时显示谁在用哪个 tab、跑了什么
```

**A 与 B 的交汇点**：scoped catalog —— 只读 agent 连 `readOnly:false` 的 adapter 都发现不到。`@meta.readOnly` 是天然的权限杠杆。

---

## 3. 未决岔路口（下次从这里接着聊）

### 多 agent（用户重心，需先钉一个子问题深挖到可动手）

- [ ] **tab 模型**：共享 active tab（简单、爱撞）/ per-agent 租约（隔离、但回收 & 跨 tab 登录流程?）/ session 抽象（一个 agent = 一组 tab）
- [ ] **信任模型**：连上的 agent 全可信（自家内网）/ scope + token + 审计（有半可信/远程 agent）
- [ ] **远程 `eval` 策略**：放开 / 禁止 / per-agent 授权 —— 直接决定安全姿态

**下一步建议**：在以下三个子问题里先选一个深挖到"具体数据结构 / 接口 / 改哪些现有模块"：
1. tab 隔离/并发（偏架构，最硬核）
2. 权限 scope + 远程 eval 安全（偏安全，是开放远程 agent 的前提）
3. 身份 + 审计 UI（偏可观测，最快见效）

### 发现（线 A）

- [ ] 是否新增 daemon `/api/sites` 目录端点（同时服务 agent 与 UI）
- [ ] agent 端：做强 `site_search`/`site_recommend` vs 动态注册真工具，二选一或都做
- [ ] UI 端：面板 Capabilities Tab 的优先级

### 更远（暂未展开，先记下）

- ⑤数据统一层 / 反孤岛的形态：通用事件日志 + 语义检索 vs per-capability typed schema vs 混合
- 新鲜度契约（读缓存还是重新浏览）
- 能力自愈（站点变了自动标红 + 建议重录）
- 常驻浏览 / feed 化

---

## 附：本次讨论涉及的关键文件

- `packages/mcp/src/index.ts:650` — `site_run` 泛型派发器
- `packages/cli/src/commands/site.ts` — adapter 目录/解析/运行逻辑
- `packages/daemon/src/http-server.ts` — 现有 `/api/*` 端点（缺 `/api/sites`）
- `packages/daemon/src/command-history.ts` — 审计雏形
- `skills/bb-browser/references/{site-system,adapter-development}.md` — adapter 体系文档
