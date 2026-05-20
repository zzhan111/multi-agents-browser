# bb-browser System Tray Daemon — 详细设计

## 1. 产品定位

将 bb-browser daemon 从「命令行黑盒」演进为 「Windows 系统级 AI 浏览器代理服务」,
提供可见、可控、可自愈的管理体验。

目标用户:
- AI 应用开发者: 日常使用 MCP 工具开发 agent
- 团队共享: 多人复用同一台 Chrome 实例
- CI/CD 场景: 无人值守的服务端 agent
- 普通用户: 使用 AI 桌面工具时需要浏览器能力

---

## 2. 可用性设计

### 2.1 零配置启动 (Zero-Config)

```
用户安装完成
  └─ 自动发现浏览器 (优先级链)
       ├─ HKCU\...\ChromeHTML (注册表)
       ├─ Edge / Brave / 360ChromeX 回退
       └─ 找到: 启动 → 托盘图标变绿
           未找到: 引导下载 Chrome / 指向已有安装
  └─ 自动探测端口
       ├─ daemon 端口: 19824 → 19826 → 19828 → ... (跳奇数防冲突)
       └─ CDP 端口: 连接已有 → 启动新实例 19825 → 19827 → ...
```

### 2.2 状态可见性

托盘图标状态机:

```
🟢 绿色    daemon 运行 + CDP 已连接 + MCP 客户端已连接
🔵 蓝色    daemon 运行 + CDP 已连接 (无 MCP 客户端)
🟡 黄色    daemon 运行 + CDP 重连中
🔴 红色    daemon 运行 + CDP 断开 (超过 30s)
⚫ 灰色    daemon 未运行
```

右键菜单层级:

```
左键点击: 打开控制面板 (Web UI)

右键菜单:
├─ 状态摘要
│   ├─ Chrome: 已连接 (v1.x) · 标签页: 6
│   ├─ MCP: 2 客户端已连接
│   └─ 运行时间: 2h 15m
├─ [分隔线]
├─ 启动 / 停止 / 重启 daemon
├─ 打开日志目录
├─ 故障诊断 (一键导出诊断报告)
├─ [分隔线]
├─ 设置...
│   ├─ 开机自启 ☑
│   ├─ 通知开关 ☑
│   ├─ 端口配置...
│   └─ 浏览器配置...
├─ 关于
└─ 退出 (同时停止 daemon 或仅关闭托盘)
```

### 2.3 控制面板 (Web UI)

运行在 daemon 的一个内部 HTTP 端点 (`/ui`), 托盘左键打开浏览器:

```
┌─────────────────────────────────────────────────┐
│  bb-browser Daemon                    ⚙️ [设置]  │
├─────────────────────────────────────────────────┤
│  Status: ● Connected  |  Uptime: 2h 15m         │
│  Chrome: v130.0  |  6 tabs                      │
│  MCP: 0 clients                                 │
├───────────────────┬─────────────────────────────┤
│  📊 Activity       │  📋 Recent Commands        │
│  ██▆▁▂▃█▅ (30m)   │  12:30 snapshot           │
│  0.2 cmd/s avg     │  12:31 click ref=3         │
│                    │  12:31 fill ref=5 "hello"  │
│                    │  12:32 open url             │
├───────────────────┴─────────────────────────────┤
│  🗂️ Tabs                          📡 Network   │
│  ┌─────────┬──────┬─────┐   Requests: 152       │
│  │ ID      │ URL  │ #   │   Errors:   0         │
│  │ 41b4    │ ...  │ 42  │   Logs:    12         │
│  │ fb18    │ ...  │ 88  │                       │
│  └─────────┴──────┴─────┘                       │
└─────────────────────────────────────────────────┘
```

功能:
- 实时状态面板 (CPU/内存/请求速率)
- 标签页管理 (关闭/刷新/截图预览)
- 网络请求查看 (增量)
- 命令执行历史 (最近 500 条)
- 日志查看器 (实时，支持过滤)

### 2.4 故障自愈矩阵

| 故障类型 | 检测方式 | 自愈策略 | 通知 |
|---------|---------|---------|------|
| daemon 进程崩溃 | PID 消失 + 心跳超时 5s | 自动重启 (3次/5分钟窗口) | 托盘气泡 |
| CDP Websocket 断开 | ws.on("close") | 指数退避重连 (1s→2s→4s→...→30s max) | 图标变黄 |
| Chrome 进程退出 | CDP 不可达 | 尝试重启 Chrome → 通知用户 | 托盘气泡 |
| 端口被占用 | EADDRINUSE / EACCES | 自动递增端口 (跳过+1 留 CDP) | 气泡 + 更新 config |
| 内存超限 | process.memoryUsage() > 512MB | 优雅重启 (排水 → 重启) | 仅日志 |
| Cmd 队列堆积 | 未处理命令 > 100 | 警告 → 超阈值拒绝 (503) | 图标闪烁 |

自愈状态记录:

```json
// ~/.bb-browser/recovery.json
{
  "lastCrash": "2026-05-20T12:30:00Z",
  "restartCount": 2,
  "restartWindow": "2026-05-20T12:25:00Z/2026-05-20T12:35:00Z",
  "backoffLevel": 2,
  "degradedServices": ["network-capture"]
}
```

### 2.5 Web UI 中的命令记录 — 数据源澄清

控制面板中有两个不同来源的"动作记录"：

| 维度 | MCP Commands | Trace Events |
|------|-------------|--------------|
| **触发者** | AI Agent (通过 MCP 协议) | 人类用户 (鼠标/键盘操作) 或 agent 调用 browser_eval |
| **数据源** | daemon HTTP POST /command | CDP Runtime.consoleAPICalled + DOM 事件注入 |
| **记录内容** | `click ref=3`, `fill ref=5 "hello"`, `open https://...` | `click` (xpath, cssSelector), `fill` (value), `scroll` (direction, pixels) |
| **采集方式** | daemon 端直接记录 (无需注入) | 需注入 trace-inject.ts 到页面 |
| **启动条件** | 始终记录 (只要 daemon 在运行) | 需手动 Start Recording (注入脚本有开销) |
| **典型用途** | 调试 agent 行为、审计、回放 | 录制浏览器操作 → 导出为 Playwright/Selenium 脚本 |

**设计决策**:

```
┌─── Web UI "Activity" 面板 ───────────────────────┐
│                                                    │
│  📊 Live Feed (始终可见)                           │
│  12:30:05  agent → click      ref=3  tab=fb18     │ ← MCP command log
│  12:30:06  agent → fill       ref=5  "search..."  │
│  12:30:08  agent → snapshot   tab=fb18            │
│  12:30:10  agent → open       url=https://...     │
│                                                    │
│  ── 切换到 "Trace" 标签页 ──                        │
│                                                    │
│  🎬 Trace Events (仅录制期间)                      │ ← DOM trace events
│  12:30:05  🖱️ click   button  "Submit"            │
│  12:30:06  ⌨️ fill    input   "search..."         │
│  12:30:08  📜 scroll  down    300px               │
│                                                    │
│  [导出为 Playwright]  [导出为 Python]              │
└────────────────────────────────────────────────────┘
```

**融合而非重叠**: MCP command log 和 trace events 是两个独立的数据管道，在 UI 中以标签页切换呈现。MCP commands 始终记录（零开销），trace events 需手动开启录制（有注入开销但有完整的元素定位信息）。

---

## 3. 多场景设计

### 3.1 场景矩阵

| 场景 | 特点 | 设计要点 |
|------|------|---------|
| **个人开发者** | 单机单用户，自己用 Chrome | 零配置，自动发现，单实例 |
| **团队工作站** | 共享 Chrome 实例，多 MCP 客户端 | 多 token 管理，速率限制，访问日志 |
| **CI/CD Runner** | 无头运行，无人值守 | CLI 管理，健康检查端点，结构化日志 |
| **远程开发** | 通过 SSH/隧道连接 | 可选绑定 0.0.0.0，TLS 支持 |
| **多浏览器并存** | 同时连接多个浏览器 | 多 daemon 实例隔离，端口池管理 |

### 3.2 个人开发者模式 (默认)

```
特性:
- 自动发现 > 自动启动 Chrome > 自动启动 daemon
- 单 auth token，随机生成
- bind 127.0.0.1（仅本地）
- 通知开启 (托盘气泡)
- 开机自启可选择
```

### 3.3 团队工作站模式

多个人共用同一台机器上的 Chrome:

```
bb-browser daemon start --shared

特性:
- 多 token 管理 (每个团队成员一个，可吊销)
- Token 访问权限分级:
    readonly:  snapshot, get, network 读取
    interact:  以上 + click, fill, type, scroll
    admin:     以上 + open, close tab, trace
- 速率限制: 每 token 10 req/s (防止一个客户端耗尽)
- 访问审计日志:
    [2026-05-20 12:30:15] token:3fa1 user:bob action:click ref=5 tab=fb18
- 并发控制: 同一 ref 不允许并发操作 (command 队列排队)
- 时间片: 每天 08:00-22:00 可访问 (可选)
```

配置示例:

```json
{
  "mode": "shared",
  "tokens": [
    {
      "id": "user-alice",
      "token": "sha256...",
      "level": "admin",
      "rateLimit": 20
    },
    {
      "id": "user-bob", 
      "token": "sha256...",
      "level": "interact",
      "rateLimit": 10
    }
  ],
  "globalRateLimit": 50,
  "accessHours": ["08:00", "22:00"],
  "auditLogPath": "~/.bb-browser/audit.log"
}
```

### 3.4 CI/CD / 无头模式

```
bb-browser daemon start --headless

特性:
- 不创建托盘图标
- 不发送系统通知
- 日志输出到 stdout (JSON 格式，可被 log collector 采集)
- 健康检查端点: GET /health → { "ok": true, "cdpConnected": true }
- 优雅关闭: POST /shutdown 等待 in-flight 命令完成 (最多 30s)
- 指标暴露: Prometheus /metrics 端点:
    bb_daemon_commands_total{status="success"} 1523
    bb_daemon_commands_duration_seconds{quantile="0.5"} 0.12
    bb_daemon_commands_duration_seconds{quantile="0.95"} 0.85
    bb_daemon_cdp_connected 1
    bb_daemon_tabs_count 6
    bb_daemon_memory_bytes 78643200
```

### 3.5 远程开发模式

```
bb-browser daemon start --host 0.0.0.0 --tls

特性:
- bind 0.0.0.0 而非 127.0.0.1
- TLS 支持 (自签名证书自动生成 + 用户可替换)
    ~/.bb-browser/certs/
    ├── cert.pem
    └── key.pem
- IP 白名单 (可选): --allow-ips "10.0.0.0/8,192.168.1.100"
- 强制 auth token (禁止空 token)
- 连接限制: 最多 5 个并发 MCP 客户端
- 警告提示: 启动时明确告知 "Daemon is accessible from network!"
```

### 3.6 多浏览器实例

支持同一个 daemon 管理多个 Chrome 实例:

```
daemon 实例 1: --cdp-port 19825   → Chrome A (日常工作)
daemon 实例 2: --cdp-port 19827   → Chrome B (测试/沙盒)

托盘显示:
  🟢 bb-browser × 2
    ├─ 实例 1 (port 19824) — Chrome A · 6 tabs
    └─ 实例 2 (port 19826) — Chrome B · 3 tabs
```

端口池管理:

```json
{
  "portPool": {
    "daemonRange": [19824, 19924],
    "cdpRange": [19825, 19925],
    "allocated": {
      "daemon": [19824, 19826],
      "cdp": [19825, 19827]
    }
  }
}
```

### 3.7 WSL / 跨系统场景

WSL (Windows Subsystem for Linux) 是重要场景：用户在 WSL 中运行 AI agent (Claude Code, Cursor, etc.)，通过 MCP 操控 Windows 侧的 Chrome。

```
┌─────────────────────────────────────────────────────────┐
│  Windows                                                 │
│  ┌──────────────────────────────────────────────┐        │
│  │  Chrome (360ChromeX)     Daemon               │        │
│  │  CDP: 127.0.0.1:19825    HTTP: 0.0.0.0:19826 │        │
│  └──────────────────────────────────────────────┘        │
│                          ▲                               │
│                          │                               │
│  ┌───────────────────────┴──────────────────────────┐    │
│  │  Windows IP: 192.168.1.x  (物理网卡)             │    │
│  │  WSL Host:  172.x.x.x     (WSL 虚拟网络)         │    │
│  │  WSL Host:  hostname.local (mDNS, Win11 22H2+)  │    │
│  └──────────────────────────────────────────────────┘    │
│                          │                               │
├──────────────────────────┼───────────────────────────────┤
│  WSL2 (Linux VM)         │                               │
│                          ▼                               │
│  ┌──────────────────────────────────────────────┐        │
│  │  AI Agent (Claude Code / CLI)                 │        │
│  │  MCP client → http://172.x.x.x:19826         │        │
│  │  或: http://$(hostname).local:19826          │        │
│  └──────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

**网络路径**:

| WSL 版本 | Windows → WSL | WSL → Windows | 推荐方案 |
|---------|---------------|---------------|---------|
| **WSL2** | 各自独立 IP (NAT) | `$(ip route show default \| awk '{print $3}')` 或 `hostname.local` | `hostname.local` (Win11) 或自动探测 Windows IP |
| **WSL1** | 共享 localhost | `localhost` 直接可达 | `127.0.0.1` 直接工作 |

**设计方案**:

```
方案 A: mDNS 自动发现 (Win11 22H2+)

  WSL agent 中:  daemonHost = "$(hostname).local"
  原理: Windows 默认开启 mDNS 响应，WSL2 可解析 hostname.local → Windows IP

方案 B: WSL 侧自动探测

  bb-browser 提供 wsl-probe 脚本, WSL 内运行:
    $ bb-browser wsl-probe
    Detected Windows host: 172.25.16.1
    Daemon endpoint: http://172.25.16.1:19826
    Config written to ~/.bb-browser/wsl.json

  wsl-probe 实现:
    1. 读 /etc/resolv.conf → nameserver IP (即 Windows 在 WSL 虚拟网卡上的地址)
    2. 对此 IP 做端口扫描 (19824-19830) 找 daemon
    3. 验证 GET /ping → 获取 token
    4. 写入 WSL 侧配置

方案 C: 托盘自动广播

  daemon 检测到 WSL 存在时 (读 /proc/sys/fs/binfmt_misc/WSLInterop 或检查 WSL_DISTRO_NAME):
    - 自动 bind 0.0.0.0 (而非仅 127.0.0.1)
    - 显示 Windows 内网 IP 和 WSL 虚拟 IP 供复制
    - CLI 启动时打印:
      🔗 WSL detected!
         From WSL:  http://172.25.16.1:19826
         Token:     0d50a5e30930a9f71eb531e6dade5e32
```

**推荐实现路径**: Phase 1 默认 bind 0.0.0.0 + 启动时打印 WSL 可达地址，Phase 2 实现 `wsl-probe` 自动配置工具。

**安全注意**: WSL2 场景下 daemon 必须 bind 0.0.0.0。这会暴露端口到局域网（如果 Windows 防火墙允许）。因此需强制：
- Token 不为空
- 默认添加 Windows 防火墙入站规则阻止 19824-19830
- 仅允许本地子网 (WSL 虚拟网卡网段 `172.16.0.0/12` + 内网 `192.168.0.0/16`)

---

## 4. 安全性设计

### 4.1 威胁模型

```
威胁 1: 本地恶意进程 → 通过 HTTP 操控浏览器
威胁 2: 网络邻居 → 扫描到绑定 0.0.0.0 的端口
威胁 3: XSS/注入 → 通过 browser_eval 执行恶意 JS
威胁 4: Token 泄露 → token 被截图/日志/版本控制泄露
威胁 5: 权限滥用 → 用户安装的 agent 插件超出预期行为
```

### 4.2 防护层次

```
Layer 1: 网络隔离
  ├─ 默认 127.0.0.1 (仅本地)
  ├─ --host 0.0.0.0 时强制 token + 显示警告
  └─ Windows Firewall 规则: 自动添加拦截入站 19824

Layer 2: 认证令牌
  ├─ Bearer token (随机 32-char hex)
  ├─ Token 存储在 daemon.json (perms 0600)
  ├─ Token 有效期: 可配置 (默认无限，CI 模式可设 24h)
  ├─ Token 轮换: POST /token/rotate → 旧 token 有 5min 优雅期
  └─ Token 吊销: POST /token/revoke (多 token 模式)

Layer 3: 命令权限
  ├─ browser_eval: 默认禁用，需显式 --allow-eval
  ├─ browser_open: URL 白名单 (可选)
  │     ~/.bb-browser/url-whitelist.json
  │     ["https://*.github.com", "http://localhost:*"]
  ├─ file:// 和 chrome:// 协议: 默认拦截
  └─ 敏感路径: 禁止访问 ~/.ssh, ~/.aws, ~/.bb-browser

Layer 4: 审计日志
  ├─ 每条命令记录: 时间戳, token-id, 命令名, 参数摘要, 结果
  ├─ 异常检测: 同一 token 5 分钟内 > 100 条 browser_eval → 报警
  └─ 日志轮转: 7 天保留, 压缩归档
```

### 4.3 Token 生命周期

```
创建 ──→ 使用 ──→ 轮换 ──→ 吊销
         │                │
         └─ 过期 ────────→ 吊销
         │
         └─ 异常检测 ──→ 临时冻结 (15min) ──→ 自动解冻 或 吊销
```

### 4.4 browser_eval 沙箱

`browser_eval` 是最危险的命令 — 可在用户浏览器中执行任意 JS。防护:

```
Level 0 (off):     禁止 browser_eval (CI/共享模式的默认)
Level 1 (limited): 仅允许在允许列表中的域名执行 eval
                   执行结果限制 10KB 输出
                   超时 5 秒自动终止
Level 2 (audit):   允许但记录完整脚本内容和结果
                   超过 1KB 的结果截断
Level 3 (full):    无限制 (仅个人开发者，--allow-eval)
```

### 4.5 配置文件安全

```
~/.bb-browser/
├── daemon.json          (0600) — token, 密钥信息
├── config.json          (0644) — 用户配置
├── audit.log            (0600) — 审计日志
└── browser/
    └── cdp-port         (0644) — 仅端口号

规则:
- 任何包含 token 的文件必须 0600
- 进程启动时检查关键文件权限 → 过宽则自动修复 + 告警
- 诊断报告导出时自动脱敏 token
```

---

## 5. 稳定性设计

### 5.1 架构分层

```
┌──────────────────────────────────────────┐
│            Tray UI Process               │  ← 托盘进程 (独立，不崩影响 daemon)
│  - 托盘图标 / 菜单                       │
│  - 通知管理                              │
│  - 自动更新检查                          │
├──────────────────────────────────────────┤
│            Watchdog Process              │  ← 看门狗 (独立)
│  - 监控 daemon 心跳                      │
│  - 自愈决策 (重启/告警/降级)             │
│  - 内存/CPU 监控                         │
├──────────────────────────────────────────┤
│            Daemon Process                │  ← 核心 (可被 watch dog 重启)
│  - HTTP server                           │
│  - CDP connection                        │
│  - Command router                        │
│  - Tab / Network / Console state mgr     │
├──────────────────────────────────────────┤
│            Chrome Process                │  ← 第三方 (非托管)
│  - 用户浏览器                            │
│  - CDP debug server                      │
└──────────────────────────────────────────┘
```

**进程隔离原则**: 托盘崩溃不影响 daemon, daemon 崩溃不影响 Chrome。

### 5.2 守护本尊 (Watchdog)

```typescript
// watchdog.ts — 独立进程
class Watchdog {
  private restartCount = 0;
  private maxRestarts = 5;        // 5 分钟窗口内最多重启 5 次
  private windowMs = 5 * 60_000;
  private healthCheckMs = 5_000;  // 每 5 秒发一次心跳

  async monitor(daemonPid: number) {
    // 1. Heartbeat 检测
    setInterval(async () => {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/status`);
        if (!resp.ok) throw new Error("unhealthy");
      } catch {
        await this.handleDaemonDown();
      }
    }, this.healthCheckMs);

    // 2. 进程存活检测
    setInterval(() => {
      if (!isProcessAlive(daemonPid)) {
        this.handleDaemonDown();
      }
    }, 1000);
  }

  private async handleDaemonDown() {
    // 限流: 窗口内超过 maxRestarts 次 → 放弃重启，通知用户
    if (this.exceededRestartLimit()) {
      notify("bb-browser daemon 反复崩溃，已暂停自动重启，请检查日志");
      return;
    }
    // 排水: 等待 Chrome in-flight 操作完成
    await this.drain();
    // 重启
    this.restartCount++;
    this.spawnDaemon();
    notify(`daemon 已自动重启 (第 ${this.restartCount} 次)`);
  }
}
```

### 5.3 优雅关闭 (Graceful Shutdown)

```
阶段 1: 停止接收新命令
  └─ POST /shutdown 立即返回 503 给新请求

阶段 2: 等待 in-flight 命令完成
  └─ 超时策略: 每条命令 < 30s
      多 tab 并发: 等待所有完成或过期
      总超时: 30s (可配置)

阶段 3: 断开 CDP
  └─ ws.close(1000, "daemon shutting down")

阶段 4: 保存状态
  └─ 序列化未完成的 trace
  └─ 清理临时文件

阶段 5: 退出进程
  └─ process.exit(0)
```

### 5.4 退化策略 (Graceful Degradation)

当部分组件故障时，保持核心功能可用:

```
优先级 (从高到低):

P0 (必须存活):
  HTTP server        — 无此则完全不可用
  CDP connection     — 无此则所有浏览器操作不可用
  故障行为: 503 响应，托盘变红

P1 (重要，可短暂降级):
  Network capture    — 超出 buffer 时暂停，恢复后继续
  Console capture    — 同上
  Trace recording    — buffer 满时 drop 最旧事件
    
P2 (非关键，可关闭):
  Web UI             — 内部错误不影响 MCP 协议
  系统通知           — 失败不影响功能
  指标导出           — 跳过不健康周期
```

### 5.5 内存管理

```
Ring Buffer 配置 (已实现):
  BB_TRACE_CAPACITY = 1000 (默认) / 最小 100

新增:
  BB_NETWORK_BUFFER  = 500  (每 tab 网络请求 buffer)
  BB_CONSOLE_BUFFER  = 200  (每 tab 控制台消息 buffer)
  BB_ERROR_BUFFER    = 50   (每 tab JS 错误 buffer)

内存保护:
  - process.memoryUsage() 每 30 秒检查一次
  - > 256MB → 警告日志
  - > 512MB → 清理最旧 buffer 数据 + 通知
  - > 1GB   → 强制重启 (排水 → 重启)
  
Buffer 清理策略:
  - 优先清理 network (最大)
  - 其次 console
  - 保留 errors (诊断关键)
  - 通知 MCP 客户端: "buffers trimmed" 事件
```

### 5.6 错误分类与处理

```typescript
enum ErrorSeverity {
  FATAL,    // 进程退出 (端口绑定失败, OOM)
  CRITICAL, // CDP 断开, 长时间不可用
  WARNING,  // 单个命令失败, buffer 满
  INFO,     // 可恢复的错误 (重试成功)
}

class ErrorHandler {
  handle(error: Error, context: CommandContext) {
    const severity = this.classify(error);
    
    switch (severity) {
      case FATAL:
        this.log.fatal(error);
        this.watchdog.notifyFatal();
        process.exit(1);
        
      case CRITICAL:
        this.log.error(error);
        this.metrics.increment("daemon.errors.critical");
        break;
        
      case WARNING:
        this.log.warn(error, context);
        return { status: "error", code: this.toHttpCode(error) };
        
      case INFO:
        this.log.info(error);
        break;
    }
  }
}
```

### 5.7 日志系统

```
日志输出:
  ~/.bb-browser/logs/
  ├── daemon.log          — daemon 主日志 (JSON 格式)
  ├── daemon.log.1        — 轮转归档
  ├── daemon.log.2
  ├── tray.log            — 托盘进程日志
  ├── audit.log           — 审计日志 (共享模式)
  └── diagnostics/        — 诊断报告 (按时间戳)

格式 (daemon.log):
  {"ts":"2026-05-20T12:30:00.123Z","level":"INFO","msg":"CDP connected","tabs":6,"pid":1234}

策略:
  - 单文件 10MB → 轮转 → 保留 5 个历史文件
  - 保留 7 天 (超过自动删除)
  - CI 模式: 输出到 stdout (JSON Lines)
```

---

## 6. 实现路线图

### Phase 1: 最小可行托盘 (MVP — 2 周)

```
目标: 替代命令行启动，提供基本可见性

P0 项:
  [x] 托盘图标 + 状态颜色
  [x] 启动/停止 daemon
  [x] 端口冲突自动回退 (fix #217)
  [x] daemon 崩溃自动重启 (watchdog)
  [x] daemon stderr 捕获 + 日志文件
  [ ] 安装器 (NSIS / MSI)
```

### Phase 2: 管理能力 + TraceStudio 融合 (2 周)

```
  [ ] Dashboard 框架 (标签页路由: Overview | Tabs | Trace | Network | Logs)
  [ ] Overview 页面 (状态面板 + MCP 命令记录)
  [ ] Trace 页面 (迁移现有 TraceStudio 组件)
  [ ] Network 页面 (实时网络请求查看)
  [ ] Logs 页面 (daemon 日志查看器)
  [ ] Daemon serve /ui 端点
  [ ] 故障诊断一键导出
  [ ] 通知系统
  [ ] 开机自启
  [ ] 配置持久化 UI
```

### Phase 3: 多场景 + 安全 (2 周)

```
  [ ] 团队共享模式 (多 token, 速率限制)
  [ ] 审计日志
  [ ] URL 白名单
  [ ] browser_eval 分级控制
  [ ] CI/无头模式
  [ ] 远程开发 (TLS, IP 白名单)
```

### Phase 4: 稳定性增强 (2 周)

```
  [ ] 优雅关闭
  [ ] 退化策略
  [ ] 内存保护
  [ ] Prometheus 指标
  [ ] 压测 + 性能调优
```

---

## 7. TraceStudio 与 Web UI 融合计划

### 7.1 现状

已有两套 Web 资源：

| 维度 | TraceStudio SPA (packages/web/) | 新设计控制面板 |
|------|-----|------|
| **定位** | 录制浏览器操作 → 导出自动化脚本 | 实时监控 daemon + 管理 daemon |
| **入口** | `vite dev` / 独立静态页面 | daemon 内嵌 `/ui` 端点 |
| **框架** | React + Vite | 未定 |
| **核心功能** | 连接 daemon → 选 tab → 录制 → 查看事件 → 导出代码 | 状态面板 + 命令历史 + 标签管理 + 网络/日志查看 |
| **与 daemon 通信** | HTTP REST (同新设计) | HTTP REST |
| **部署方式** | vite build → dist 静态文件 | daemon serve 静态文件 |

### 7.2 目标架构

**融合为一个统一 Dashboard**，daemon 内嵌 serve，单一入口涵盖所有功能：

```
┌─────────────────────────────────────────────────────────┐
│  bb-browser Dashboard              🟢 Connected   ⚙️     │
├─────────────────────────────────────────────────────────┤
│  📊 Overview  │  🗂️ Tabs  │  🎬 Trace  │  📡 Network  │  📋 Logs  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [当前标签页内容 = Overview]                             │
│                                                         │
│  ┌──────────────────┬──────────────────────────────────┐│
│  │  Status           │  Recent MCP Commands             ││
│  │  Uptime: 2h 15m  │  12:30 snapshot                 ││
│  │  Chrome: v130     │  12:31 click ref=3              ││
│  │  Tabs: 6          │  12:31 fill ref=5 "hello"       ││
│  ├──────────────────┼──────────────────────────────────┤│
│  │  CPU/Mem Gauge    │  Token: 0d50... ⧉              ││
│  │  2% · 78MB        │  Port: 19826                    ││
│  └──────────────────┴──────────────────────────────────┘│
│                                                         │
└─────────────────────────────────────────────────────────┘

切换到 Trace 标签页:

┌─────────────────────────────────────────────────────────┐
│  bb-browser Dashboard              🟢 Connected   ⚙️     │
├─────────────────────────────────────────────────────────┤
│  📊 Overview  │  🗂️ Tabs  │  🎬 Trace*  │  📡 Network  │  📋 Logs  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [Target Tab: fb18 (github.com) ▼]                      │
│  [● Start Recording]  [Export ▼]                        │
│  Selector mode: Auto | CSS | XPath         Smart Wait ☑ │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │  #1  🖱️ click   button  "Submit"           00:01   ││
│  │  #2  ⌨️ fill    input   "search..."        00:05   ││
│  │  #3  📜 scroll  down    300px              00:08   ││
│  │  #4  🔗 navi    url     /results           00:10   ││
│  └─────────────────────────────────────────────────────┘│
│                                                         │
│  📈 Recording... 4 events  │  Last: navigation          │
│                                                         │
│  Export: [JavaScript] [Playwright] [Python (Selenium)]  │
└─────────────────────────────────────────────────────────┘
```

### 7.3 融合策略

**保留所有现有 TraceStudio 功能，嵌入新 Dashboard 的标签页中：**

| 现有组件 | 融合方式 |
|---------|---------|
| `App.jsx` | 重写为 Dashboard 根组件，添加标签页路由 |
| `TraceStudio.jsx` | → `pages/TracePage.jsx` (作为 Trace 标签页内容) |
| `ConnectionPanel.jsx` | → 移到顶部全局状态栏 |
| `TabPanel.jsx` | → 在 Overview 和 Trace 两个标签页中复用 |
| `TraceControls.jsx` | 保留在 TracePage 中 |
| `TraceTimeline.jsx` | 保留在 TracePage 中 |
| `TraceEventDetail.jsx` | 保留 (弹窗，与标签页无关) |
| `RealtimeMonitor.jsx` | 保留在 TracePage 中 |
| `ExportDialog.jsx` | 保留在 TracePage 中 |
| `useStore.jsx` | 扩展：新增 overview / audit / log 相关 state |
| `api/daemon.js` | 扩展：新增 `getOverview()`, `getLogs()`, `getAudit()` 方法 |

### 7.4 Daemon 端变更

Daemon 需新增几个端点 (服务 `/ui` 页面 + 提供数据)：

```
新增 HTTP 端点:

GET /ui                → 返回静态 Dashboard HTML (内嵌所有 JS/CSS)
GET /ui/assets/*       → 静态资源 (JS bundle, CSS)

GET /api/overview      → { uptime, cpu, memory, chromeVersion, tabCount, activeMCPClients }
GET /api/commands?limit=100  → 最近 N 条 MCP 命令记录
GET /api/logs?level=warn&limit=50  → 日志查询
GET /api/audit?since=2026-05-20  → 审计日志 (共享模式)
```

`/ui` 页面在 daemon 启动时自动 serve，无需用户额外配置。静态文件打包在 daemon 分发中（或通过单独的 npm 包）。

### 7.5 技术方案对比

| 方案 | 优点 | 缺点 | 推荐 |
|------|------|------|------|
| **A: 保留 React SPA** | 现有代码复用，高质量 UI 组件 | 需 vite build → daemon 内嵌静态文件 | ✅ |
| **B: 纯 HTML 服务端渲染** | 零 JS 框架，快 | 交互体验差，不适合 Trace 时间线等复杂 UI | ❌ |
| **C: HTMX + 轻量 JS** | 小而轻 | Trace 录制交互逻辑复杂，不适用 | ❌ |

**推荐方案 A**。现有 TraceStudio 已经是一套成熟的 React 应用，将其重构为多标签页 Dashboard 是最快路径。

### 7.6 融合实现步骤 (Phase 2 内)

```
Week 1:
  [ ] App.jsx 重写：标签页路由 (Overview | Tabs | Trace | Network | Logs)
  [ ] Overview 页面：daemon 状态 + MCP 命令记录
  [ ] ConnectionPanel 提升到全局 header (所有标签页可见)
  [ ] TabPanel 改为全局侧边栏 (可折叠)

Week 2:
  [ ] Network 页面：实时网络请求查看
  [ ] Logs 页面：daemon 日志查看器
  [ ] Daemon 端新增 /api/overview, /api/commands, /api/logs
  [ ] vite build → daemon 启动时 serve /ui 端点
  [ ] 托管打开入口: 托盘左键 → 浏览器打开 http://127.0.0.1:PORT/ui
```

### 7.7 不丢失的现有功能

TraceStudio 现有功能 100% 保留：

- ✅ 连接 daemon → 提升到全局 header
- ✅ 选择 tab → 全局侧边栏
- ✅ Start/Stop 录制 → 保留在 TracePage
- ✅ 实时事件查看 → 保留在 TracePage
- ✅ 事件详情弹窗 → 保留
- ✅ 导出 (JS/Playwright/Python) → 保留在 TracePage
- ✅ 选择器模式 (Auto/CSS/XPath) → 保留
- ✅ 智能等待开关 → 保留
- ✅ 实时状态监控 → 保留在 TracePage

---

## 8. 技术选型

| 组件 | 方案 | 理由 |
|------|------|------|
| 托盘 UI | Electron (systray) 或 tauri | 跨平台潜力，Web UI 复用 |
| Web UI | 内置静态页面 (daemon serve) | 零依赖，随 daemon 启动 |
| 安装器 | NSIS | 轻量，Windows 原生 |
| 守护/看门狗 | Node.js child_process | 同语言，无额外依赖 |
| 指标收集 | 手动实现 (prom-client) | 轻量 |
| TLS | Node.js 内置 https | 零外部依赖 |
