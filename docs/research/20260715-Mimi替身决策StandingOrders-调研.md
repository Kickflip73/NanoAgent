# Mimi 替身决策 Standing Orders 调研报告

日期：2026-07-15
状态：已审核

## 调研范围

- 目标：让 Mimi 在接收外部事件后，依据所有者长期原则和不同来源的替身规则直接决策，而不只是通用总结或等待逐次指令。
- 涉及文件：
  - `src/daemon/attention.ts`
  - `src/daemon/policy.ts`
  - `src/runtime/instructions.ts`
  - `src/core/guidance.ts`
  - `tests/daemon-attention.test.ts`
  - `tests/daemon-policy.test.ts`
  - `docs/ATTENTION.md`

## 核心发现

### 现状分析

`MIMI.md` 已经提供每轮热读取的持久指令，并同时作用于 CLI 与 Daemon。`assistant.json` 则由 Attention Engine 热重载，保存 owner focus、静默时段、预算、阈值和 run/digest/notify/ignore 规则。事件进入 run 后，当前输入只包含事件正文、source provenance 和通用“直接处理”要求，没有可配置的 daemon-only 替身原则，也不能按 actor 或 conversation 指定不同处理方式。

### 关键流程

Attention Engine 是所有 Daemon Event 进入 `decideEvent` 的唯一确定性入口。它已经持有最新 `assistant.json`，因此可以在决定 `run` 时选择本地 Standing Orders，再将它们作为可信 owner 配置附加到本轮事件输入。后续仍由同一个 Dispatcher、Session、Runtime 工具、执行账本和 Outbox 完成。

### 现有约束

- `MIMI.md` 继续是跨 CLI/Daemon 的全局持久指令，不能再造一个等价副本。
- Standing Orders 只服务常驻事件决策，不改变 Attention 的 run/digest/notify/ignore 顺序，也不创建第二工作流。
- 外部 payload 必须继续明确标记为来源数据，不能因附加本地策略而混成系统提示。
- 直接 owner 命令优先于长期 Standing Orders；长期规则用于补足未明确说明的判断。
- 配置和单轮注入必须有字符、条目与匹配上限，避免无限 prompt 增长。

### 风险与问题

- 全局规则与 source rule 可能重复；需要按配置顺序合并并去重。
- source 不足以表达“老板、家人、某个群”等身份，需要可选 actor/conversation glob。
- 将规则内容返回到 status 会暴露私人偏好；状态只应报告数量和字符数。
- 配置热重载失败必须保留旧配置，现有 `reload` 赋值顺序已经满足这一点。
- Standing Orders 是本地可信配置，但仍不能突破 Runtime 本身的工具和副作用语义。

## 与任务相关的关键结论

在 `assistant.json` 增加一个有界 `decisionPolicy` 即可：`standingOrders` 保存 daemon-only 通用替身原则，`sourcePolicies` 按 source/kind/actor/conversation glob 追加局部规则。Attention 的所有 run 分支统一调用一个小 helper，把匹配规则传给 `decideEvent`；后者用明确分区把“本地 Standing Orders”和“当前事件”组合。总字符上限 20000，避免与 NANO 的单文件预算叠加失控。该方案不增加持久表、工具、Agent、审批或执行路径。
