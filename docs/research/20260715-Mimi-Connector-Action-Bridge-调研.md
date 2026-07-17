# Mimi Connector Action Bridge 调研报告

日期：2026-07-15  
状态：已审核

## 调研范围

- 目标：让常驻 Mimi 不仅能接收 Connector 事件和回复原会话，还能主动执行 IM、日历、邮件等外部事务。
- 涉及文件：
  - `src/daemon/connectors.ts`
  - `src/daemon/dispatcher.ts`
  - `src/daemon/policy.ts`
  - `src/runtime/tool-policy.ts`
  - `src/daemon/service.ts`
  - `src/daemon/cli.ts`
  - `examples/connectors/daxiang-connector.mjs`

## 核心发现

### 现状分析

Connector 已是隔离进程，通过 stdin/stdout NDJSON 通信，拥有环境变量白名单、超时、指数退避重启、事件入队和可靠 Outbox 回复。它只理解 `event`、`deliver` 和 `delivery_ack`，尚不能承载主动事务。

用户明确要求默认开放所有权限等级，不要复杂的权限审批模型。因此 Standing Mandate/Approval 不应接入 Action Bridge 主路径；`trust` 仅作 provenance、Attention 和审计标签。语义执行台账仍需复用，因为它解决的是崩溃重放，而不是审批。

### 关键流程

1. Connector 配置声明它允许的 action 名称和描述，此声明由 owner 管理。
2. Agent 调用通用 `connector_action(connector, action, target, payloadJson)` 工具。
3. 所有来源均可调用该工具；Daemon 只校验 owner 配置的 Connector/action 能力目录，不做逐次审批。
4. Daemon 向指定子进程发送 `action`，Connector 返回 `action_result`。凭证不进入 Agent 进程。
5. 超时、断线或重启时请求失败关闭，不自动重放；Connector 应把 action id 作为上游幂等键。

### 现有约束

- 保持单进程 Daemon + 多隔离 Connector 子进程，不引入消息队列、工作流引擎或微服务。
- Connector 配置文件权限为 `0600`，只继承最小环境变量。
- 所有副作用工具都必须进入统一 Tool Policy 和语义执行台账。
- 单行协议上限 1 MiB；Agent 工具 payload 使用有上限的 JSON 字符串，避免不可控的递归 schema。

### 风险与问题

- 远程已执行但回执丢失是典型的不确定结果；自动重试会造成重复发送、重复建会或重复付费。
- `target` 必须是独立的主要事务对象，便于模型理解、日志排查和后续 Connector 实现幂等。
- 子进程不应自主扩大能力；Daemon 只使用 owner 配置的 action 目录，不接受运行时自报能力。这是接口契约，不是权限审批层。

## 与任务相关的关键结论

采用“一个通用工具 + 配置能力目录 + Connector 进程隔离 + 默认开放 Runtime”是当前最轻量的可扩展路径。协议做一次尝试并且在结果不确定时不自动重放；业务 Connector 可用 action id 获得端到端幂等性。
