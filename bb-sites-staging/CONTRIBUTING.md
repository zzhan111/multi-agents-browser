# 贡献适配器 — 合规 Checklist

提交适配器 PR 前,请完成以下 checklist(在 PR 描述中勾选):

## 必填 checklist(作者勾选)

- [ ] 我已阅读目标站点的**服务条款(ToS)**,本适配器不违反其禁止性条款
- [ ] 本适配器**不绕过** robots.txt / 验证码 / IP 限速 / 风控机制
- [ ] 本适配器**不抓取**用户关系链 / 私信 / 其他用户 PII 用于再分发
- [ ] 本适配器输出**不构成**对目标站点核心服务的"实质性替代"
- [ ] 我已在适配器文件头部加 `@disclaimer` 声明
- [ ] 我已在 `@meta` 中标注 `risk`(low/medium/high)与 `readOnly`(true/false)
- [ ] 我理解:适配器由我**独立维护**,ma-browser 不为其行为背书

## 适配器文件要求

每个 `.js` 文件需含:

1. **`@disclaimer` 头部注释**(文件最顶部):

```javascript
/**
 * @disclaimer 本适配器由作者独立维护,ma-browser 不为适配器行为背书。
 *             使用者需遵守 <目标站点> 服务条款,不得用于反爬/转售/商业化替代。
 *             作者已阅读目标站点 ToS 并认为本适配器合规。
 */
```

2. **`@meta` JSON 块**(disclaimer 之后):

```javascript
/* @meta
{
  "name": "platform/command",
  "title": "人类可读功能标题",
  "description": "功能描述",
  "category": "社交",
  "risk": "high",
  "readOnly": true,
  "prerequisites": "需先登录 platform.com",
  "domain": "platform.com",
  "args": { ... },
  "example": "ma-browser site platform/command ..."
}
*/
```

3. **适配器函数**(返回结果或 {error, hint})。

## 风险等级判定

| 等级 | 特征 | 例子 |
|------|------|------|
| 🟢 low | 公开数据、只读、不替代核心服务 | 商品搜索、车次查询、公开评分 |
| 🟡 medium | 需登录、用户自己的数据、含写入 | 订单查询、加购、收藏 |
| 🔴 high | 社交平台、实时数据、关系链、可能实质性替代 | 社交动态、关注列表、热榜聚合 |

高危适配器(`risk: high`)会被面板标红,运行前要求用户二次确认遵守站点 ToS。

## 目录结构

```
<platform>/
  └── <command>.js      # name = "<platform>/<command>"
```

## PR 流程

1. Fork → 新建分支 `add-<platform>-<command>`
2. 放入适配器文件(按平台分目录)
3. 确认文件含 `@disclaimer` + 完整 `@meta`
4. 提交 PR,描述里贴上面 checklist 的勾选结果
5. 等待审核(高危适配器需人工复核)
