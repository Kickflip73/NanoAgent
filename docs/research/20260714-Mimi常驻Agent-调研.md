# Mimi常驻 Agent 调研报告

日期：2026-07-14  
状态：已审核（用户已明确授权直接实施）

## 调研范围

- 目标：将 MimiAgent 从主动打开的 CLI Agent 扩展为长期运行、事件驱动、可主动通知和渐进授权的个人助手。
- 涉及模块：
  - `src/index.ts`
  - `src/runtime/mimi-agent.ts`
  - `src/runtime/components.ts`
  - `src/runtime/tool-policy.ts`
  - `src/core/session.ts`
  - `src/core/execution-ledger.ts`
  - `src/core/state-file.ts`
  - `src/extensions/mcp.ts`

## 核心发现

### 现状分析

MimiAgent 已经具备可无头复用的 Agent 内核：持久 Session、Run Checkpoint、Goal/Plan、Memory、Skills、MCP、RAG、权限工具策略、执行账本和受控 Team。需要新增的不是第二个 Agent 内核，而是位于 Runtime 外围的常驻 Host。

当前完整的单轮生命周期仍位于 `src/index.ts` 的私有 `runTask` 闭包：消费流、提取回答、汇总 usage、提交成功/失败终态并应用 Runtime Effects。Daemon 若直接调用 `MimiAgent.stream()` 会复制这套关键协议。

CLI 的等待队列只是内存 `string[]`；HookBus 是 best-effort 观测总线；ExecutionLedger 的幂等范围只是当前 `runId + callId`。它们都不能直接承担外部事件的可靠投递、跨 Run 去重和主动通知。

### 关键流程

```text
Source Adapter
  -> EventEnvelope
  -> Durable Inbox
  -> Attention / Trust Policy
  -> Session Router
  -> AgentRunService
  -> MimiAgent
  -> Action / Approval / Receipt
  -> Transactional Outbox
  -> Sink Adapter
```

### 现有约束

- 保持单进程、本地优先，不引入外部 MQ 或分布式工作流服务。
- Runtime 仍然负责 Agent 组装；Daemon 作为外围 Host，不将渠道适配逻辑塞进 Agent Loop。
- 首版单 Dispatcher 顺序处理；Agent 内部仍可使用现有受控并发。
- 外部事件内容是不可信数据，不能通过 prompt 为自己提升权限。
- 主动通知必须通过持久 Outbox，不在 Hook 中直接调用慢速网络。

### 风险与问题

- Session 是对话边界，但 Memory 会在同一 dataRoot 跨 Session 共享。工作、私人和公共信息源应通过 Profile/dataRoot 分离。
- 未声明能力的扩展工具在现有 General/Ultra 策略中偏宽松；Daemon 事件 Run 需要 deny-by-default 的动态上限。
- 原生 MCP Tools 不经过本地 Function Tool Ledger；非 owner 事件默认禁止 MCP。
- JSON 原子替换适合 Session 与小型配置，但 inbox/outbox/lease/approval 需要多记录事务。控制面使用嵌入式 SQLite WAL，不需要外部服务。
- 用户期望的“长期在线”不应实现为一个无限 Agent Run，而是长期 Event Loop + 有界单轮 Run + 持久 Wakeup。

## 与任务相关的关键结论

1. 第一个改动应是抽取 `AgentRunService`，让 CLI 和 Daemon 共用完整的 Run 协议。
2. Daemon 控制面使用 SQLite WAL 持久 `events/runs/actions/approvals/outbox/leases/audit/schedules`。
3. 入站 Adapter 和出站 Tool/MCP 分离；第三方渠道后续优先通过 stdio/NDJSON 子进程接入。
4. 首版先接通 CLI/Unix Socket、Timer 和 Local Webhook，再接大象、QQ、微信、新闻与天气。
5. 所有事件从第一天就携带 provenance、trust、dedupeKey、replyRoute 和稳定 eventId。

