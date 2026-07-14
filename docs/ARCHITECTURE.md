# NanoAgent Architecture

NanoAgent 同时是轻量级通用本地 Agent 产品和轻量多 Agent 编排框架：面向真实文件、命令、检索、知识与外部系统任务，同时保持单进程、本地优先和可直接阅读的运行内核。

## 设计原则

- OpenAI Agents SDK 负责模型循环、Tool、MCP 和 Agent-as-tool 协议。
- 主 Agent 始终拥有会话与最终回答，SubAgent 只处理有边界的独立子任务。
- 会话切换后由 CLI 从持久 Session 重建用户/助手对话视图，工具明细仍只保留在 Session 与 Trace 中。
- JSON/JSONL 负责本地持久化，不引入数据库、消息队列或 ORM。
- `runtime` 负责组装，`core` 保存状态，`extensions` 提供能力，CLI 只负责交互。
- OpenAI 与 DeepSeek 共用同一能力层，避免绑定单一 Provider 的服务端状态。
- 优先扩展 Skill 和 MCP，不持续堆叠内置 Tool。

## 模块边界

```text
CLI
├── index.ts             调度、队列和流消费
├── commands.ts          运行时命令
├── interactive.ts       输入、选择器和状态栏
├── terminal.ts          事件渲染
└── runtime/
    ├── nano-agent.ts    组合根与一轮运行
    ├── components.ts    模型、状态存储和扩展初始化
    ├── session-state.ts Session 摘要与 best-effort 恢复语义
    ├── model.ts         OpenAI / DeepSeek 模型工厂
    ├── instructions.ts  基础指令与模式
    ├── tool-policy.ts   模式、角色与权限工具策略
    ├── tool-ledger.ts   本地副作用执行账本包装
    ├── run-outcome.ts   完成、取消与审批中断判定
    ├── control.ts       Agent 可调用的运行时控制与延迟 Effects
    └── hooks.ts         生命周期事件总线
        ├── core/
        │   ├── context.ts  Token Budget 与动态上下文
        │   ├── state-file.ts 跨实例/进程原子 JSON 状态
        │   ├── execution-ledger.ts Function Tool 副作用账本
        │   ├── guidance.ts 用户级/项目级 NANO.md
        │   ├── session.ts  Agents SDK Session
        │   ├── memory.ts   跨会话记忆
        │   ├── plan.ts     Plan / Goal / Checkpoint
        │   ├── team.ts     Ultra Team task list / dependency / claim
        │   └── trace.ts    JSONL Trace
        ├── extensions/
        │   ├── skills.ts    Agent Skills
        │   ├── mcp.ts       MCP Client 与生命周期
        │   ├── rag.ts       本地混合检索
        │   ├── subagents.ts 单层只读 Agent-as-tool
        │   └── team.ts      多角色有限并发执行器
        └── tools.ts         高频本地原子工具
```

`src/agent.ts` 仅保留兼容导出，业务实现位于 `runtime/nano-agent.ts`。

## 一轮请求

```text
1. CLI 记录用户输入并创建 AbortSignal
2. Session 写入 `running` checkpoint，并修复中断留下的孤立 Tool Call
3. NANO.md、Memory、RAG、Plan、Goal、Team task list、Session 与 ContextArchive 并行读取
4. ContextManager 执行 microcompact、context collapse 和完整轮次 Token Budget 选择
5. 持久指令、ContextArchive、恢复检查点、Skill Catalog、Memory、RAG、Goal 被组装为动态 Instructions
6. Tool policy 根据 General / Plan / Ultra 选择工具、MCP 和受控 SubAgent
7. Runner 流式执行，TerminalRenderer 分级展示事件
8. SDK 追加完整 Session，Runtime 把 checkpoint 落为 completed / interrupted / failed，HookBus 记录生命周期 Trace
9. 当前回答完成后应用模型请求的 Session、输出或退出 Effects
```

## 上下文不变量

历史裁剪同时遵守 `HISTORY_LIMIT` 与上下文窗口预算，并从用户消息边界开始。以下协议单元不能被拆开：

```text
user → function_call → function_call_result → assistant
```

较早历史被提取为紧凑的用户、助手、工具调用和工具结果摘要，只进入本轮 Instructions；完整原始 Session 不会被覆盖，也不会持久化伪用户摘要。上下文策略按顺序为：旧 Tool Result microcompact → 持久 context collapse / `/compact` full compact → 完整轮次 PTL truncation。

Context Window 由当前模型 Profile 提供，而不是按 Provider 使用同一个常量。Profile 同时定义输出预留；模型切换和 Session 恢复会原子更新 Model 与 ContextManager。每轮先扣除输出预留、已知 Function Tool Schema 和协议/MCP 安全余量，再在剩余输入预算内组装 Instructions、历史与当前输入；超长当前输入也必须截断，不能绕过总预算。SDK 返回 usage 时，状态栏优先展示最后一次真实请求的 input tokens，`/context` 另列整轮累计用量；Provider 未返回 usage 时明确保留为未知，不把本地估算冒充实际值。

## Session 恢复与存档

Session JSON 同时保存三类互不替代的数据：完整 SDK transcript、最近 `RunCheckpoint`、`ContextArchive`。原始 transcript 是审计存档；ContextArchive 只是模型有效视图；RunCheckpoint 只保存恢复所需的输入、阶段、最后工具事件和结果/错误摘要。

```text
running
├── 正常完成 → completed
├── Esc       → interrupted
├── 异常      → failed
└── 进程退出  → 下次打开时转换为 interrupted
```

Session 是完整运行状态边界。启动指定 Session、从历史列表切换和新建对话都经过同一条激活路径，同步恢复 transcript、mode、model、输出等级、Plan、Goal、Team、ContextArchive、checkpoint、输入历史与 `/retry` 状态。每轮执行捕获不可变作用域并生成 runId/owner；checkpoint、Trace、事件和延迟动作始终写回启动该轮的 Session，所有进展与终态更新都以 runId 做 CAS。其他 Session 的消息和局部运行状态不会进入当前模型上下文；唯一允许跨 Session 注入的对话信息是带 `confirmedAt` 的长期记忆。`/resume` 将未完成 checkpoint 与 Goal/Plan/Team 合并为新一轮输入，并要求先核对当前工作区；这是 best-effort 任务续跑，不是任意 SDK 指令点的精确恢复。没有未完成状态时拒绝空恢复。

`AtomicJsonStore` 是 Memory、Plan、Team、RAG、ExecutionLedger 和 Session 的统一状态层：按绝对路径共享进程内队列，使用跨进程锁在锁内重读，写入 PID+UUID 临时文件后原子 rename，并通过 Zod 校验和损坏文件隔离处理异常。Session 与执行账本选择失败关闭；可重建的共享索引/偏好状态可以隔离损坏文件后从空状态继续。

本地 Function Tool 的副作用以 `sessionId + runId + toolName + callId` 记入执行账本。相同成功调用返回已保存结果；`started` 或 `failed` 状态不会自动重试，以免重复写文件、命令或外部请求。这是 at-most-once 防护，不覆盖 Agents SDK 原生 MCP/Hosted Tools，也不宣称跨任意崩溃边界的 exactly-once。

## NANO.md 持久指令

`GuidanceLoader` 在每轮开始时读取 `~/.nano-agent/NANO.md` 和 `<workspace>/NANO.md`。项目文件是团队共享的具体约定，优先于用户文件中的全局个人偏好。两者作为动态 Instructions 进入同一 Token Budget，单文件最多注入 20000 字符；不存在或为空时不占上下文。SubAgent 继承相同内容，但不能借此突破自身只读工具与职责边界。

## Plan 与 Goal

Plan 表示当前任务的步骤视图，Goal 表示跨多轮、跨重启的生命周期：

```text
Goal
├── objective
├── status: active | paused | completed | failed
├── checkpoint
├── nextAction
└── PlanStep[]
```

两者按 Session 保存在同一个 `plans.json`。旧版本的纯 Plan 数组会在读取时自动迁移。`/resume` 只根据持久状态生成下一轮输入，不启动后台守护进程，因此长任务仍然可观察、可中断。

## 三种运行模式

模式是运行时能力契约，而不是只有提示词差异：

| 模式 | 目标 | 写文件 / Shell | SubAgent | Team |
|---|---|---:|---|---:|
| General | 最短可靠路径完成大多数任务 | ✓ | researcher、reviewer | — |
| Plan | 调查、讨论并形成获批方案 | — | researcher、architect、reviewer，全部只读 | — |
| Ultra Team | 大型代码、可并行或长程任务 | ✓ | 单个只读委派 + Team workers | ✓ |

`toolsForMode` 在创建主 Agent 时过滤 Function Tools。Plan 不连接 MCP Server Tools，只保留显式的只读 MCP Resource wrappers，因此提示词失效也无法调用内置写文件、Shell 或未知 MCP 动作。Plan 中的 `switch_mode` 只改变下一轮模式；当前 Runner 的工具集合不会中途扩大。

Ultra 仍是一个主 Runner 和单一 Session。主 Agent 是 lead，负责目标、拆分、波次调度、整合和最终回答；worker 不共享对话历史，也不递归委派。

## Agent Skills

SkillLoader 实现开放 Agent Skills 格式的最小完整客户端流程：

1. 扫描 `skills/*/SKILL.md`。
2. 用 YAML Parser 和 Schema 校验 `name`、`description`。
3. 只把名称、描述和绝对位置放入初始上下文。
4. 模型调用 `use_skill` 激活完整说明。
5. 模型调用 `read_skill_resource` 按需读取 Skill 根目录内资源。

资源读取拒绝绝对路径和目录逃逸，单个文本资源限制为 256KB。无效 Skill 进入 diagnostics，不影响其他 Skill；`/skills reload` 可热重载。

## MCP

MCPManager 复用 Agents SDK 的 `MCPServerStdio` 与 `MCPServerStreamableHttp`，不实现自有 JSON-RPC Client。配置兼容 `servers` 和 `mcpServers`，支持：

- stdio：`command`、`args`、`cwd`、`env`
- Streamable HTTP：`type: http`、`url`、`headers`
- `${ENV_NAME}` 环境变量替换
- 并行连接、单 Server 失败隔离、工具计数、状态与 reload
- MCP Resources 的列出和读取

只有成功连接的 Server 会交给主 Agent；当前只读 SubAgent 不继承 MCP。远程认证保持在环境变量中，不应写入 `mcp.json`。

## SubAgent

SubAgent 使用 Agents SDK `Agent.asTool()`，而不是 Handoff：

- `delegate_research`：只读文件、知识库和网络，最多 16 turns；不继承 MCP，避免外部写工具绕过边界。
- `delegate_review`：只读文件和知识库，最多 12 turns。
- `delegate_architecture`：只读分析边界、取舍和验证方案，仅在 Plan 与 Ultra 提供。
- 子 Agent 不包含委派工具，最大深度固定为 1。
- 主 Agent 继续控制会话、Goal、写操作和最终回答。

这提供了上下文隔离与专业化，又不需要 Agent 图、外部队列或调度服务。

## Ultra Team 编排

`TeamTaskStore` 按 Session 保存到 `teams.json`。每个任务只有五种角色之一，并包含 `dependencies`、`paths`、状态、owner 和结果摘要。写入使用进程内串行队列与临时文件 rename；`claim` 会在同一次原子 mutation 中检查 pending 状态和已完成依赖，避免同一任务被重复领取。

```text
lead: set_team_tasks
  → TeamTaskStore 校验唯一 ID、依赖存在且无环
  → ready() 计算当前可执行波次
  → run_team 校验 1～4 个任务与 builder 路径边界
  → 最多 4 个独立 Runner 并行
  → completed / failed 结果分别持久化，failed 可显式 retry
  → lead 检查结果并调度下一波或修复
```

角色工具按最小职责静态选择：explorer/architect 只读检索，builder 只能写入该 task 声明的 `paths`，tester/reviewer 保持只读，所有 worker 默认都没有 Shell。`claimMany` 在一次锁内 mutation 中验证并领取整波任务，重叠波次不会留下孤儿 running task；claimId 和租约阻止迟到 worker 覆盖新领取。单个 worker 失败不会丢失其他结果，Esc 的 AbortSignal 会传入所有嵌套 Runner。

## Runtime Control

`runtime/control.ts` 把 CLI 中有实际运行时语义的操作暴露为 Function Tools。查询、模型切换和模式切换直接复用 `NanoAgent` 方法；Session 切换/清空、MCP reload、输出等级和退出先进入内存队列，等 SDK 完成当前 Session 写入与 `run_end` Hook 后再应用，并把 Effect 交给 CLI 刷新界面。这样 Agent 能代替用户操作，又不会在 Tool Call 尚未闭合时替换持久化目标或关闭当前 MCP 连接。

主 Agent 的内置本地工具有三档权限：默认 `workspace` 只允许文件工具在工作区内读写并隐藏 Shell/写型 HTTP，`read-only` 再移除写工具，`trusted` 才开放绝对路径、Shell 与写型 HTTP。路径边界同时做词法与 realpath 检查，拒绝符号链接逃逸。MCP 是用户显式配置的外部能力，其权限不由本地工具档位代替。

## Memory 与 RAG

Memory 保存少量跨会话偏好、事实、决策和待办，包含来源 Session、确认时间、重要度和更新时间。`remember` 的写入能力绑定本轮原始用户输入；没有明确确认时存储层拒绝写入。RAG 面向本地中小型 Markdown/Text 知识库：固定切片、按内容摘要与模型复用 Embedding、每次读取最新原子状态、向量与词法混合排序。并发提交串行原子替换整份索引，不使用跨调用的易过期内存缓存；默认权限同时校验词法路径与 realpath，拒绝工作区外索引。取消信号贯穿扫描、读取、Embedding 和提交。

文件、搜索和目录工具会拒绝 `.nano-agent` 运行数据与用户级配置目录，包括符号链接解析后的路径。macOS 上 Shell 工具运行在 Seatbelt profile 中，对这些目录同时禁止读写，防止命令绕过 Session API 直接读取其他 transcript、Plan、Team 或 Trace。

## Hooks 与 Trace

HookBus 当前暴露 `run_start`、`run_end`、`run_error`、`subagent_event` 和 `team_worker_event`。默认订阅器写入本地 JSONL Trace。它是普通进程内事件总线，可用于后续统计、Guardrail 或自定义可观测性，不承担工作流编排。

## 扩展决策

- 新增高频原子动作：Tool。
- 新增可复用任务工作流：Agent Skill。
- 接入外部系统、私有数据或远程能力：MCP。
- 需要隔离上下文的独立研究/审查：单层 SubAgent。
- 需要有限并行的大型任务：Ultra Team task list + worker wave。
- 需要跨重启继续：Goal + Checkpoint。

不要在运行内核加入消息网关、分布式队列、通用工作流 DSL、任意深度 Agent 树或企业向量数据库；这些应作为外围集成存在。
