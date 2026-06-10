# Snapshot + Refs 工作流

ma-browser 使用紧凑的元素引用（ref），大幅减少 AI Agent 的上下文消耗。

## 工作原理

### 传统方式的问题

```
完整 DOM/HTML 发送给 AI → AI 解析 → 生成 CSS 选择器 → 执行操作
每次交互 ~3000-5000 tokens
```

### ma-browser 的方案

```
紧凑快照 → 分配 @ref → 直接用 ref 操作
每次交互 ~200-400 tokens
```

## Snapshot 命令

```bash
# 完整快照（显示页面结构）
ma-browser snapshot

# 只显示可交互元素（推荐）
ma-browser snapshot -i

# JSON 格式输出
ma-browser snapshot -i --json
```

## 快照输出格式

```
页面: Example Site - 首页
URL: https://example.com

@1 [header]
  @2 [nav]
    @3 [a] "首页"
    @4 [a] "产品"
    @5 [a] "关于"
  @6 [button] "登录"

@7 [main]
  @8 [h1] "欢迎"
  @9 [form]
    @10 [input type="email"] placeholder="邮箱"
    @11 [input type="password"] placeholder="密码"
    @12 [button type="submit"] "登录"

@13 [footer]
  @14 [a] "隐私政策"
```

## 使用 Ref

有了 ref 后直接操作：

```bash
# 点击登录按钮
ma-browser click @6

# 填写邮箱
ma-browser fill @10 "user@example.com"

# 填写密码
ma-browser fill @11 "password123"

# 提交表单
ma-browser click @12
```

## Ref 生命周期

**重要**：页面变化后 ref 会失效！

```bash
# 获取初始快照
ma-browser snapshot -i
# @1 [button] "下一页"

# 点击触发页面变化
ma-browser click @1

# 必须重新获取快照！
ma-browser snapshot -i
# @1 [h1] "第二页"  ← 现在是不同的元素
```

### Ref 失效的场景

1. **页面导航**：点击链接、表单提交后跳转
2. **动态加载**：AJAX 加载新内容
3. **DOM 变化**：JavaScript 修改页面结构
4. **弹窗/下拉**：打开模态框、展开菜单

## 最佳实践

### 1. 操作前先 Snapshot

```bash
# 正确
ma-browser open https://example.com
ma-browser snapshot -i          # 先获取 ref
ma-browser click @1             # 再使用

# 错误
ma-browser open https://example.com
ma-browser click @1             # ref 不存在！
```

### 2. 导航后重新 Snapshot

```bash
ma-browser click @5             # 导航到新页面
ma-browser snapshot -i          # 获取新页面的 ref
ma-browser click @1             # 使用新的 ref
```

### 3. 动态变化后重新 Snapshot

```bash
ma-browser click @1             # 打开下拉菜单
ma-browser snapshot -i          # 获取菜单项的 ref
ma-browser click @7             # 选择菜单项
```

### 4. 等待加载完成

```bash
ma-browser click @3             # 触发 AJAX 加载
ma-browser wait 1000            # 等待加载
ma-browser snapshot -i          # 获取新内容的 ref
```

## Ref 格式说明

```
@1 [tag type="value"] "文本内容" placeholder="提示"
│   │   │             │          │
│   │   │             │          └─ 其他属性
│   │   │             └─ 可见文本
│   │   └─ 关键属性
│   └─ HTML 标签
└─ 唯一 ref ID
```

### 常见模式

```
@1 [button] "提交"                    # 按钮
@2 [input type="email"]               # 邮箱输入框
@3 [input type="password"]            # 密码输入框
@4 [a href="/page"] "链接文字"         # 链接
@5 [select]                           # 下拉框
@6 [textarea] placeholder="请输入"     # 文本域
@7 [checkbox] checked                 # 已勾选的复选框
@8 [radio] selected                   # 已选中的单选框
```

## 常见问题

### "Ref not found" 错误

页面已变化，ref 失效了：

```bash
# 重新获取快照
ma-browser snapshot -i
```

### 元素不在快照中

可能需要滚动或等待：

```bash
# 滚动到底部
ma-browser scroll down
ma-browser snapshot -i

# 或等待动态内容
ma-browser wait 2000
ma-browser snapshot -i
```

### 快照太长

使用 `-i` 只显示可交互元素：

```bash
# 完整快照可能很长
ma-browser snapshot

# 只显示可交互元素（推荐）
ma-browser snapshot -i
```

### 需要操作不可交互元素

使用 `eval` 直接执行 JavaScript：

```bash
ma-browser eval "document.querySelector('.hidden-element').click()"
```

## 调试技巧

```bash
# 查看完整页面结构
ma-browser snapshot

# 只看可交互元素
ma-browser snapshot -i

# JSON 格式便于解析
ma-browser snapshot -i --json

# 获取特定元素的文本
ma-browser get text @5
```
