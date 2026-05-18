# CLAUDE.md

## Trace Export — 待改进项

### P1: 导航事件录制

录制开始时使用 `activeTab.url` 作为 `page.goto()` 的 URL，但不感知页面内的 frameset/frame 内导航。

**改进方案**：trace-inject.ts 中监听 `popstate` / `hashchange`，daemon 通过 `Page.frameNavigated` CDP 事件记录导航，生成的脚本中插入 `page.goto()` 或 `page.frame().goto()`。

### P1: 选择器可移植性

当前导出的选择器优先级：`ref` > `cssSelector` > `xpath`。其中 `ref` 是 bb-browser 自定义属性（`data-highlight-index`），导出的脚本无法脱离 bb-browser 环境运行。

**改进方案**：
- 提供"选择器模式"选项：bb-browser / CSS / XPath
- 默认使用 CSS 选择器（已通过 cssSelector fallback 部分实现）
- 可选 XPath 模式用于更稳定的定位

### P2: 步骤间等待机制

导出的脚本中无 `waitForTimeout` 或 `waitForSelector`，异步渲染的页面 replay 会失败。

**改进方案**：
- 在 click 之前插入 `page.waitForSelector(selector)` 
- 或提供"智能等待"选项：检测页面空闲后继续

### P2: 字符串转义不完整

当前只转义了单引号和反斜杠，未处理换行符、`\n`、Unicode 等。

**改进方案**：使用 JSON.stringify 生成字符串值，自动处理所有特殊字符。

### P3: Ring Buffer 上限

daemon 的 TraceRingBuffer 容量为 1000 事件，长录制会静默丢失旧数据。

**改进方案**：可配置容量，或在接近上限时提示用户。
