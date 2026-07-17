# Mimi 替身决策 Standing Orders 实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi替身决策StandingOrders-调研.md]]

## 任务目标

让 Mimi 能依据 owner 管理的长期替身原则，以及来源、事件类型、发送者和会话专属规则，直接处理 Daemon Event，并保持配置热重载、外部内容隔离和轻量架构。

## 方案概述

扩展现有 `assistant.json` schema，增加默认空的 `decisionPolicy.standingOrders` 与 `decisionPolicy.sourcePolicies`。Attention Engine 对所有 run 决策统一收集匹配规则，`decideEvent` 把它们作为本地可信配置附加到当前事件输入。MIMI.md 不变：它仍是 CLI/Daemon 共用全局指令；Standing Orders 只表达常驻事件的替身处理策略。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：用户要求跳过

## 详细步骤

### 1. 扩展有界配置模型

**涉及文件：** `src/daemon/attention.ts`

**修改说明：**

增加全局 orders 和最多 100 条 source policy；每条 policy 支持 source、kinds、actor、conversation glob 和最多 10 条 instruction。单条 instruction 最多 1000 字符，整个 decisionPolicy 最多 20000 字符。旧配置缺少字段时自动使用空策略。

**代码片段：**

```typescript
decisionPolicy: z.object({
  standingOrders: z.array(instructionSchema).max(50).default([]),
  sourcePolicies: z.array(sourcePolicySchema).max(100).default([]),
}).default({ standingOrders: [], sourcePolicies: [] })
```

### 2. 统一匹配与事件输入注入

**涉及文件：** `src/daemon/attention.ts`、`src/daemon/policy.ts`

**修改说明：**

所有 `run` 分支统一走 `runDecision`；按配置顺序合并全局和所有匹配 source policies，并去重。`decideEvent` 用 JSON 分区注入 Standing Orders，明确直接 owner 命令优先，外部事件正文仍处于“不可信来源数据”分区。

### 3. 状态与热重载测试

**涉及文件：** `tests/daemon-attention.test.ts`、`tests/daemon-policy.test.ts`

**修改说明：**

验证旧配置默认值、source/kind/actor/conversation 匹配、多规则合并去重、不匹配隔离、owner 指令优先提示、外部 Prompt Injection 边界、热重载、状态只暴露计数，以及 20000 字符上限。

### 4. 同步产品文档

**涉及文件：** `README.md`、`SECURITY.md`、`docs/ARCHITECTURE.md`、`docs/ATTENTION.md`、`CHANGELOG.md`

**修改说明：**

补充配置示例、NANO 与 Standing Orders 分工、匹配顺序、隐私边界和替身决策语义。

### 5. 完整验证与记录

**涉及文件：** `docs/plans/20260714-Mimi常驻Agent-计划.md`、`docs/sessions/20260715-Mimi替身决策StandingOrders-记录.md`

**修改说明：**

运行聚焦测试、类型检查、完整 CI 和 diff 检查，更新总计划阶段与 RPI 记录。

## 权衡与考量

- 不修改 MIMI.md loader，避免出现两个全局指令源；Standing Orders 明确限定为 daemon event policy。
- 不把指令塞进 Attention rule，因为处理时机与处理方式应相互独立，多条局部策略可以同时匹配。
- 不在 status 返回原文，只暴露条数和字符数。
- 不增加数据库或规则执行器；模型仍是唯一做语义决策的 Agent。

## Todo List

- [x] 扩展 decisionPolicy schema 与总量上限
- [x] 实现匹配、去重和统一 run 输入注入
- [x] 覆盖默认值、热重载、匹配和隔离测试
- [x] 更新注意力、架构、安全和产品文档
- [x] 运行聚焦验证和完整 CI
- [x] 生成开发记录并更新总计划
