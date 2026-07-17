# Mimi Connector Action Bridge 实施计划

日期：2026-07-15  
状态：已完成  
关联调研：[[20260715-Mimi-Connector-Action-Bridge-调研.md]]

## 任务目标

把 Connector 升级为轻量双向事务总线，让任何来源事件都可以调用具体 Connector 的 action，同时保持凭证隔离、执行去重、幂等约定和失败不自动重放。

## 方案概述

Connector 配置新增 action 能力声明。Daemon 对 Agent 只提供一个 `connector_action` 副作用工具，将请求以 NDJSON `action` 发给子进程，并匹配 `action_result`。ConnectorManager 同时提供能力查询给 RPC/CLI。所有来源都沿用开放 Runtime 权限，不增加 Mandate 或逐次审批。

## UI 变动检测

涉及 UI 变动：否  
变动类型：无  
涉及文件：无  
预览状态：不适用

## 详细步骤

### 1. 扩展 Connector 配置和协议

**涉及文件：** `src/daemon/connectors.ts`

**修改说明：** 增加 action 声明、独立超时、在线状态和能力列表；实现 request/result 关联和断线全部拒绝。

### 2. 接入 Agent 开放执行链

**涉及文件：** `src/daemon/connector-action-tool.ts` `src/daemon/dispatcher.ts` `src/daemon/policy.ts` `src/runtime/tool-policy.ts`

**修改说明：** 注册 `connector_action`；移除默认事件链中按 trust 分级、Approval 和 Mandate 权限门槛，所有来源直接使用完整 Runtime 能力。

### 3. 增加运维可见性

**涉及文件：** `src/daemon/service.ts` `src/daemon/cli.ts`

**修改说明：** 增加 `connectors.list` RPC 和 `daemon connectors` CLI，显示配置能力与实时在线状态，不显示凭证。

### 4. 落地首个事务 Connector

**涉及文件：** `examples/connectors/daxiang-connector.mjs` `mimi.connectors.example.json`

**修改说明：** 让大象 Connector 支持 `send_message`，共享现有发送逻辑，并把 action id 向上游传递为幂等键的协议约定。

### 5. 验证和文档

**涉及文件：** `tests/daemon-connectors.test.ts` `tests/daemon-policy.test.ts` `tests/daemon-cli.test.ts` `docs/CONNECTORS.md` `docs/ATTENTION.md` `docs/ARCHITECTURE.md`

**修改说明：** 覆盖成功执行、未声明能力、断线失败不重放、开放权限、能力查询和 CLI，最后运行完整 CI 与真子进程 smoke。

## 权衡与考量

- 使用通用工具避免每装一个 Connector 都动核心工具注册代码。
- 能力由 owner 配置声明，它是稳定的适配器契约和模型工具说明，不是审批模型。
- 失败不自动重放，优先避免重复副作用；上游支持时用 action id 实现幂等。
- 本阶段不引入通用 DAG/workflow DSL，多步事务仍由 Agent 通过多次受审计工具调用组合。

## Todo List

- [x] 扩展 Connector action 协议与 Manager API
- [x] 实现 `connector_action` 工具和开放执行链
- [x] 实现 Connector RPC/CLI 可见性
- [x] 扩展大象和 QQ 示例 Connector
- [x] 补充测试和协议文档
- [x] 运行 typecheck、覆盖率、build 和 package smoke
