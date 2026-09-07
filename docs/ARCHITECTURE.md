# MimiAgent Architecture

MimiAgent 是 7×24 小时在线、本地优先的全能个人 Agent，同时提供有边界的轻量多 Agent 编排能力：面向真实文件、命令、检索、知识与外部系统事务，同时保持运行内核小而可直接阅读。

## 设计原则

- OpenAI Agents SDK 负责模型循环、Tool、MCP 和 Agent-as-tool 协议。
- 每个 Session actor 中的主 Agent 始终拥有该会话与最终回答，SubAgent 只处理有边界的独立子任务。
- `mimi`、Daemon、IM、语音和其他入口共用一个常驻内核与 `MimiHost`；CLI 是本地 Unix Socket 客户端，不拥有第二份控制面或 transcript。
- Kernel 是全局控制面，不是全局工作区。工作区选择只接受可信 Host 的结构化绝对目录：当前 CLI Event 携带的启动目录优先，其次是 Session 已绑定目录，最后是 Runtime 默认目录。Dispatcher 不解析 owner 自由文本中的项目名、路径、新建或继续意图，不搜索候选仓库，也不自动创建兜底目录；不存在或不是目录的结构化目标失败关闭。Session actor 随后用选定目录重建完整运行时。
- 同一 Session 严格 FIFO，不同 Session actor 可在有界全局并发内同时运行；Session actor 是隔离执行单元，不承诺一对一映射为操作系统进程。
- 无需立即返回的长任务先持久化，再由独立操作系统子进程执行；完成结果仍回到同一 Event / Run / Outbox 可靠链路。
- 常驻内核空闲时只做确定性的监听、租约、计划和投递维护；没有可执行事件时不调用模型。
- JSON/JSONL 保存 Agent 语义状态；SQLite WAL 只承担常驻模式所需的可靠事件控制面，不引入 ORM 或外部消息队列。
- `runtime` 负责组装与执行，`core` 保存 Agent 状态，`extensions` 提供能力，`daemon` 负责事件可靠性，CLI 只负责交互。
- OpenAI 与 DeepSeek 共用同一能力层，避免绑定单一 Provider 的服务端状态。
- 优先扩展 Skill 和 MCP，不持续堆叠内置 Tool。

## 模块边界

```text
src/
├── index.ts             交互入口与 MimiAgent 命令路由
├── daemon/chat-client.ts 默认 CLI 到唯一 MimiAgent Kernel 的轻量客户端
├── commands.ts          运行时命令
├── interactive.ts       输入、选择器和状态栏
├── terminal.ts          事件渲染
├── runtime/
│   ├── bootstrap.ts     CLI / Daemon 共用 Provider 启动
│   ├── run-service.ts   统一 stream 消费与 Provider failover
│   ├── mimi-agent.ts    MimiAgent 薄组合根、当前 Run ownership 与公开 facade
│   ├── pipeline/        RunScope、状态/能力/上下文/工具/请求与唯一提交管线
│   ├── runtime-control-coordinator.ts 运行查询、模型控制与受约束 Host probe
│   ├── mimi-host.ts     键控 Session actor、每 Session FIFO 与全局并发槽
│   └── components.ts    模型、状态存储和扩展初始化
├── core/                    Session、Context、Memory、Plan、Team 与 Trace
├── extensions/              Skills、MCP、Memory adapters、SubAgent 与 Team executor
└── tools.ts                 高频本地原子工具（分段读取、检索、摘要校验 Patch、变更检查等）

src/daemon/
├── store.ts             SQLite WAL 事务 facade、Task/Event/Digest 与 schema 迁移
├── *-store.ts           Outbox/Schedule/Run/Memory observation/Activity 表级不变量
├── policy.ts            事件 provenance、Session 路由与模型输入
├── dispatcher.ts        有界并发 claim / renew / execute / retry / deliver 循环
├── task-tools.ts        后台任务持久委派、查询与取消工具
├── task-supervisor.ts   后台任务 OS 子进程监督器
├── task-worker-entry.ts 单任务子进程入口
├── worker-protocol.ts   内核与任务子进程 IPC 协议
├── ipc.ts               0600 Unix Socket + 0600 control bearer NDJSON RPC
├── service.ts           前台、detached、信号与资源生命周期
└── notifier.ts          system / local 通知与渠道注册
```

个人账号消息在该边界内只增加两个轻量模块：`core/personal-message.ts` 定义
三渠道共享的有界 payload/context/result schema（`daemon/personal-message.ts`
只作 Daemon 边界转出）；`runtime/personal-message-hub.ts`
在当前 Run 内签发和消费绑定目标的 HMAC context token。Hub 不拥有数据库、不运行
Connector、不保存正文；Connector cursor 仍由隔离进程维护，Event、Task 和副作用
回执继续由现有 Store 与 ExecutionLedger 持有。

可选 `extensions/computer` 以 Cua Driver 为隐藏 Backend，只向主 Agent 暴露 app-centric 的 `computer_observe` 与 `computer_act`。Host 按 Run 自动管理精确窗口、最新 Observation、动作/截图预算和 Driver Session；模型不接触 PID、window id、Observation id、投递模式或 Driver 状态。AX 优先，新窗口经有界 settle 仍无语义状态时才回退窗口截图；普通 UI 动作在同一 Tool 结果中直接返回 fresh state。GUI 写动作继续经过统一 Security、ExecutionLedger 与跨进程动作锁。Darwin 的 Workstation、后台 Task 和非 Owner 来源 `run_shell` 进入进程沙箱，拒绝 Apple Events、LaunchServices、Accessibility 和正式控制端口；认证本机 Full Owner 的直接 Conversation Run 使用当前 OS 用户的原生 Host Shell，因此可以管理 `launchd` 等宿主服务。Terminal 可作为只读 Computer 观察目标但禁止动作和输入注入；Codex、IDE 等控制面应用不能成为 Computer 目标；`full-owner` 可自动发现已安装的 Cua Driver，Safe/Workstation 不会因此扩大权限。

`src/agent.ts` 导出 `MimiAgent`；实现位于 `runtime/mimi-agent.ts`。

产品身份、公开入口和运行时标识统一为 MimiAgent：`Mimi*` 类型、`mimi.db` / `mimi.sock` / 日志文件、`com.mimiagent.daemon` label、临时目录 `mimi-agent-file-locks`、`*_mimi_*` Tool ID、`mimiagent-bridge` plugin ID 与 `mimi.*.example.json` 文件名均由同一个 MimiHost 使用。旧版本数据只在 `core/mimi-legacy.ts` 的单向迁移边界识别；Daemon 确认旧进程停稳后，目录和内部文件才原子改名，避免状态丢失或双实例。

## 三层并发运行时

MimiAgent 是一个整体，而不是三个互不相干的产品。三层共享 Session、Memory、Goal/Plan/Checkpoint、能力策略和可靠事件语义，只在职责与执行隔离方式上不同：

```text
CLI / IM / Voice / Schedule / Connector events
                     │
                     ▼
┌──────────────────────────────────────────────────────────────┐
│ 1. Kernel：唯一常驻控制面                                    │
│ SQLite Event/Run/Outbox · Attention · Schedule · Connector   │
│ broker · Task supervisor · IPC · lease/retry/dedup           │
└───────────────────┬───────────────────────────┬──────────────┘
                    │ conversation lane         │ task lane
                    ▼                           ▼
┌─────────────────────────────────┐   ┌────────────────────────┐
│ 2. Conversation：Session actors │   │ 3. Task：OS workers    │
│ session A: FIFO ──────────────── │   │ task A: isolated PID  │
│ session B: FIFO ──────────────── │   │ task B: isolated PID  │
│ A 与 B 可并行                    │   │ 每任务独立 Session     │
└─────────────────────────────────┘   └───────────┬────────────┘
                                                  │
                                                  ▼
                                      Event outcome + Outbox
                                      主动通知原会话或渠道
```

1. **Kernel 层**只有一个长期存活的状态所有者。它接收和持久化事件，执行 Attention 的确定性分类，维护租约、重试、Schedule、Outbox、Connector 生命周期与 Connector action broker，并监督任务子进程。Connector readiness 由确定性 Supervisor 定时调用渠道声明的只读健康动作维护；连续失败只重启对应 Connector 子进程，不启动模型、不并发业务动作，也不重放任何外部写事务。没有待处理事件、计划到期或投递工作时，不启动 Agent Run，也不为了“思考”而周期调用模型。
2. **Conversation 层**按 Session 创建隔离的 actor runtime。每个 actor 拥有自己的可变 `MimiAgent` 与 `AgentRunService`，因此一个会话的模型、模式、checkpoint 和流式运行不会污染另一个会话。同一 Session 的 Run 和 mutation 始终 FIFO；不同 Session 在 `MIMI_SESSION_MAX_CONCURRENCY` 限制内并行。工作区是 Session Run 的不可变执行范围；解析结果变化时，actor 会在 FIFO 安全点关闭旧的工作区运行时，并用新目录重建文件工具、Shell、Project Guidance、Skill、MCP、Memory 路由与 Team。actor 是进程内的逻辑执行单元，不等于一个 PID；多个 CLI 窗口只有选择不同 Session 时才并行，指向同一 Session 时会按顺序执行以保护 transcript。
3. **Task 层**处理无需在当前对话等待的长程、大型、多阶段或持续型工作。主 MimiAgent 调用 `delegate_background_task` 后，先把带来源 Session、父事件、深度、已解析 `workspaceRoot`、`workspaceAccess: read | write` 和独立 Task Session 的 Event 持久化到 `task` lane，再立即把 `taskId` 返回当前对话。`TaskProcessSupervisor` 为 ready task fork 独立 Node.js 子进程，并用持久化的工作区重建 worker 配置，不能回退到 Kernel 启动目录。子进程通过租约领取精确 Event 并运行一个 Task Lead；暂停、继续、取消、阻塞等待输入、崩溃恢复和重试继续服从 Event/ExecutionLedger 语义。`read` Task 可并行读取、分析并更新自己的 Plan/Goal/checkpoint，但确定性禁用 Shell、文件写、任意写网络、Connector 事务、后台再委派和 Team；声明 `shell.execute` 的委派即使描述为“不修改文件”也会在入队时提升到受监督的 `write` 独占 lane；`write` Task 保留其来源授权档位并由 Supervisor 做工作区互斥，需要拆分时只使用当前 Task 内的只读 SubAgent 或 Ultra Team，不再建立持久 Task 子树。终态或输入请求由子进程写入 Event/Run，并通过 Kernel 的 Outbox/Notifier 主动送回来源渠道。Connector 凭据与渠道子进程仍由 Kernel 的 broker 单一持有，任务进程不复制渠道控制面；broker 请求只携带该 worker 的独立随机 `workerToken`，显式不读取控制面 bearer，也不能调用 status、submit、shutdown 或其他 owner RPC。

`MIMI_SESSION_MAX_CONCURRENCY` 控制对话 Session actor 池，默认 `4`，可配置范围为 `1～16`。Task supervisor 复用这个值作为期望 worker 数，但为保护本机资源再硬限制为最多 `8` 个（默认仍为 `4`）。两者是独立的本机有界执行池，不是共享配额、分布式调度或无限制进程树。

## 一轮请求

```text
1. CLI 通过 Unix Socket 把 owner 输入持久化为 Daemon Event；其他渠道也进入同一个 Inbox
2. Conversation Dispatcher 按 Session 路由到对应 actor；同 Session 排队，不同 Session 可并行
3. Session 写入 `running` checkpoint，并修复中断留下的孤立 Tool Call
4. MIMI Soul、owner Preferences、Project Guidance、相关 Memory Cards、Plan、Goal、Team task list 与 canonical Session 并行读取
5. ContextManager 为本次模型调用派生 Context View，并执行工作快照、语义压缩和完整轮次 Token Budget 选择
6. Soul、Runtime/Host 核心规则、owner Preferences、当前 Runtime Context、active Skill、Project Guidance、恢复检查点、Skill Catalog、Memory Cards 与 Goal 被分层组装为动态 Instructions
7. Tool policy 根据 General / Plan / Ultra 建立完整授权面，模型首轮只收到核心工具和能力发现/调用入口
8. 简短工作由当前 actor 流式完成；无需立即结果的长任务调用 `delegate_background_task`，持久化后由 task worker 子进程继续
9. SDK 追加各自 Session，Runtime 把 checkpoint 落为 completed / interrupted / failed，HookBus 记录生命周期 Trace
10. Conversation 结果直接返回等待中的客户端；后台任务终态进入 Outbox，由 Kernel 主动通知来源会话或渠道
```

## 上下文不变量

历史裁剪同时遵守 `MIMI_HISTORY_LIMIT`（兼容旧 `HISTORY_LIMIT`）与上下文窗口预算，并从用户消息边界开始。以下协议单元不能被拆开：

```text
user → function_call → function_call_result → assistant
```

完整 transcript 是 canonical Session；模型输入只是每次调用前由 SDK `callModelInputFilter` 重新计算的派生 Context View，过滤结果绝不写回 Session。输入占可用预算达到 70% 时，Host 通过同一 Provider 的无工具 summarizer seam 准备结构化工作快照，固定包含目标、进度、已完成、决策、约束、未决问题、证据、关键事实和稳定 Artifact 引用，并以独立 Session 状态持久化而不伪装成对话；该准备阶段非阻断，不再按句子长度或事实条数中断普通日志/代码历史。快照记录已覆盖 item 数与 canonical 前缀摘要，达到 80% 时才替换该已验证前缀；生成失败时复用仍能通过前缀摘要校验的旧快照，或在请求仍可装入时安全保留未压缩视图，最近三个用户回合始终逐字保留。只有最终视图确实无法装入时才失败关闭，禁止用字符头尾裁剪或关键词句子抽取冒充语义摘要。当前用户回合内的工具结果只要单项和整次请求仍可装入预算，就在后续模型调用中持续完整保留；不能因“已经消费过一次”提前丢弃互补证据。较早回合、单项首次即过大或整次请求确实超预算时，才替换为有界语义事实与 `context-artifact:*` 引用。模型只能通过 `read_context_artifact` 在同一 Session 和活动 Run 内只读回取经摘要哈希校验的 canonical 结果；旧 Run 的引用归属不可改写，新 Run 只能获得记录原始 runId 的显式 alias，跨 Session/Run 或摘要伪造失败。call/result 骨架始终配对；连协议骨架也超预算时明确终止，不退化为孤立输入，也不根据摘要重放 uncertain 副作用。

Context Window 由当前模型 Profile 提供，而不是按 Provider 使用同一个常量。Profile 同时定义输出预留；模型切换和 Session 恢复会原子更新 Model 与 ContextManager。每轮先分别扣除输出预留、已知 Function Tool Schema 和协议/MCP 安全余量，再在剩余输入预算内组装 Instructions、历史与当前输入；超长当前输入也不能绕过总预算。每次模型请求产生只供 Host、Trace 和 TUI 使用的 Context Manifest，按稳定 section ID 保存本地估算、压缩动作、request/run 标识和 estimator ID，不复制 prompt 正文，也不进入模型输入。协议 reserve 只显示预留，绝不计入已用输入；`/context` 分别展示 Raw Session、模型视图及占比、Last Request Actual、Run cumulative、静态工具/能力开销和压缩次数。Provider 未返回 usage 时明确显示 `est`，不会把本地估算冒充实际值。Conversation 不按累计输入量或固定模型调用次数中断；每次请求仍必须独立装入当前模型的 Context Window。只有操作员显式配置 `MIMI_MAX_TURNS` 时才按该轮数暂停，并保留完整协议单元和执行账本，不删除或重放动作。

能力披露与授权是两层独立边界。每个 Run 先把经过 Mode、Task、readiness、route owner、Policy 和 ExecutionLedger 包装的 builtin、Browser、Computer、Memory、Goal、Skill、MCP 与 Connector Tool 放入唯一 `HostCapabilityRegistry`。初始模型工具面只保留日常高频的时间、文件/Shell、Web、Browser、Computer、上下文 Artifact、基础 Memory、task_history、speech 和 model_control 工具，以及唯一的 `inspect_capabilities`/`invoke_capability` deferred gateway；Session、Goal/Plan、后台任务控制、低频 Memory、Skill、MCP 和 Connector 动作按需发现后调用。这里没有关键词快捷路由：每条自然语言请求仍先进入同一个主模型，由模型决定直接回答、调用高频工具或发现延迟能力。旧 `inspect_runtime_capabilities`、`invoke_runtime_capability` 和 `inspect_mimi_capabilities` 只允许用于历史 transcript 或内部兼容诊断，不进入新 Run 工具面。隐藏 schema 不会增加或撤销权限。每轮 Effective Capability Snapshot 从同一 Registry 生成，`tools` 严格等于 SDK `getAllTools()` 的实际首轮名称，并按 builtin、MCP、Browser、Computer、Memory、Goal、Skill、Connector 记录隐藏索引；每组只披露总数及至多 12 个稳定名称，不复制 description 或 schema，超出时显式 `truncated`。模型按 source/name/query 查询后才取得 deferred schema 并调用；完全相同的发现按 Run 和 Connector semantic revision 缓存，readiness 或目录变化立即使 Connector 发现失效。Connector 查询直接调用 Manager 的有界结构化 catalog API，不经过 Tool 调 Tool。`name` 保持精确匹配；`query` 对规范化后的名称与描述做有界多关键词匹配，零结果只代表当前查询未命中，并返回有重叠的名称建议而不自动授权。统一入口只代理 Registry 中的精确原始 Tool；未知、未授权、未发现或 revision 后未重新发现的 action 失败关闭。Skill availability、运行 instructions 与 status 都读取同一 Snapshot/Registry 投影。Connector 首轮只提供 id、availability、能力组和可用 action 数量，禁用 action 不暴露描述；目录缺少某 action 不能推导其他 Host 能力不存在。整个选择过程使用结构化事实和显式查询，不读取 owner 文本做关键词工具路由，也不保存第二份 capability 状态。

`inspect_capabilities.name` 只精确匹配 deferred Tool，Connector action 使用
`inspect_capabilities.capability` 精确匹配稳定 ID；历史
`source=connector + name=<capability>` 输入仅作无副作用兼容解析。Browser direct
tools 只在 Browser Connector 的 `open_session` 与 `close_session` 同时实时 ready
时进入 Registry，disabled、offline、stale 或生命周期不完整时不向模型
暴露一组必然失败的 `browser_*` schema。

Context Artifact 的 ref 继续绑定原 Session/Run，旧 ref 不能直接读取。若同一
canonical 工具结果已为当前 Run 生成显式 alias，读取旧 ref 仅返回结构化
`context_artifact_stale` 与 `replacementRef`，由模型使用新 ref 最多重试一次；
伪造、跨 Session、无当前 alias 或摘要校验失败都返回不可重试拒绝，不暴露
canonical 内容，也不触发原工具动作重放。

## 分层模型路由

模型选择与厂商协议分离。Conversation、Background、Schedule、SubAgent、TeamTask
和 Media WorkUnit 只提交结构化 `scenario`、`complexity`、硬能力要求与可选
`ModelTarget(providerId, modelId)`；`WorkUnitModelResolver` 按显式 WorkUnit、
Team、Session、场景和全局默认的顺序选择，绝不读取自由文本做关键词路由。
`ModelGateway` 再通过独立的 OpenAI Responses、OpenAI-compatible、Anthropic
Messages 或 Google Generate Content adapter 创建显式 client。运行期没有全局
OpenAI client。

`RunModelBinding` 在 Run 开始时冻结 target、Runtime kind、reasoning、scenario、
selection reason、routeVersion、contextWindow、maxTurns 与 maxOutputTokens。注册
上下文和场景预算共同生成本轮 ContextManager 与 Provider 请求预算；非法或超过已知
contextWindow 的预算失败关闭。Session 切换模型只影响下一 Run；第一次
`run_team` 会在领取 worker 前用同一 route snapshot 原子冻结全部 TeamTask 的精确
target，各 worker 随后只使用自己的 binding；SubAgent 每次委派时重新解析并创建
自己的 Agent。图片理解要求 `imageInput`，生图/改图要求 `imageOutput`，纯图片模型
只进入 Media Runtime，未知或不满足的硬能力失败关闭。fallback 仍只能发生在 stream、
Tool 或其他副作用开始前，started/uncertain 不重放。

Owner 私有 `models.json` 只保存 Provider 定义、精确模型注册、三项硬能力、可选
contextWindow/协议推理能力和路由，
credential 只通过每个 Provider 的 `apiKeyEnv` 引用。文件使用严格 schema、共享锁和
原子替换；不存在时从旧环境配置合成 legacy target，因此旧部署无需迁移即可启动。
`mimi provider add/set/list/test` 是 registry 管理入口；已有 Provider 可用精确
`providerId/modelId` 简写追加模型并继承连接定义。已注册 target 的默认切换或 registry
内容更新都不重启 Daemon。每个缓存 Session actor 在下一 Run/FIFO mutation 安全点比较
并重载完整配置，而不只依赖 `routeVersion`；已经开始的 Run/Team 仍保持旧 binding。
`reload_mcp` 不参与模型配置刷新。
Session 保存精确 target 并兼容旧 `provider/model`；后台 worker IPC 只携带已选
Provider、模型注册与该 Provider 的 credential。Conversation、SubAgent 与 Team
worker 都写入 `model_binding_event`；usage/receipt 记录 target、scenario、
selection reason 和 routeVersion；没有价格表时 cost 明确为 `unknown`。
工具面、历史归一化、RunScope、状态和 Trace 全部取本轮 target 的真实 transport，
不得再由 legacy 启动 Provider 推断。Anthropic/Google adapter 保留原生图片 block；
纯生图通过 `generate_image` 创建 Media WorkUnit，不伪装成 Agent tool loop。
Daemon 根据持久 Task kind 结构化指定 `conversation.default`、`background.default`、
`scheduled.default` 或 `memory-maintenance.default`，不能因为 Run 带有 cause 就把
Conversation 降成 background。OpenAI-compatible Doctor 使用认证 `/models` 列表
端点检查连通性，不把缺少可选 model-detail endpoint 误报为模型不可用。

## Session 恢复与存档

Session JSON 同时保存三类互不替代的数据：完整 SDK transcript、最近 `RunCheckpoint`、`ContextArchive`。原始 transcript 是审计存档；ContextArchive 只是模型有效视图；RunCheckpoint 保存恢复所需的输入、阶段、最后工具事件、最近 12 次工具的脱敏有界摘录和最多 100 个工具报告的产物路径。工具结果通过既有原子存储逐步写入并校验 Session/runId；续跑继承进度，普通新任务不把旧进度当作自己完成的操作。普通后续输入也会获得上一轮未完成事实，由模型判断关联，不自动激活旧 Goal/Plan。

```text
running
├── 正常完成 → completed
├── Esc       → interrupted
├── 异常      → failed
└── 进程退出  → 下次打开时转换为 interrupted
```

Session 是完整运行状态边界。启动指定 Session、从历史列表切换和新建对话都经过同一条激活路径，同步恢复 transcript、mode、model、输出等级、Plan、Goal、Team、ContextArchive 与 checkpoint。CLI 的 `/retry` 最近输入缓存仅属于当前终端进程，不伪装成持久 Session 状态。每轮执行捕获不可变作用域并生成 runId/owner；checkpoint、Trace、事件和延迟动作始终写回启动该轮的 Session，所有进展与终态更新都以 runId 做 CAS。其他 Session 的消息和局部运行状态不会自动进入当前模型上下文；跨 Session 自动注入的对话信息仅限带新 `recordedAt` 或兼容旧 `confirmedAt` 标记的长期记忆。`/resume` 将未完成 checkpoint 与 Goal/Plan/Team 合并为新一轮输入，并要求先核对当前工作区；这是 best-effort 任务续跑，不是任意 SDK 指令点的精确恢复。没有未完成状态时拒绝空恢复。

Esc 中断会原子保留 checkpoint 中的 owner 输入，并把已经流向 owner 的回答文本保存为明确标注“任务未完成”的 assistant 快照；SDK 尚未落盘输入时也由 checkpoint 补齐。因此切换 Session 后再返回仍能看到中断前的对话上下文。Function Call、Function Result 与未展示的 completion-gate 候选仍从本轮 transcript 回滚，避免保留不完整协议单元、泄露临时敏感值或暗示不确定副作用可以重放。

跨会话成果通过 owner 主动调用 `task_history` 查询现有 Task 表，不自动拼接其他 Session 的 transcript。统一列表包含 conversation/background/scheduled 等类型，按 profile 隔离并支持分页；详情返回业务 outcome、实际结果和 Finalization 的可选结构化产物引用。查询空结果必须带查询范围，任务 completed 不等于交付物验收通过，历史路径需要现场核对。非 owner 来源不开放这个入口；既有会话上下文隔离不因查询入口而取消。

工具成功与失败以结构化结果判定：非零进程退出、显式失败和 uncertain 不能因为 Promise resolved 而算作成功。Run 终态、Checkpoint 进度和 Finalization manifest 使用同一语义；执行账本仍负责至多一次保护，不因失败分类改变而重放已派发动作。

Speech 在已有输出目录以原子 JSON 持久化音频 ID 和生成状态；相同文本/选项/渲染器只认领一次，ready 可跨运行复用，超时保留原 ID/路径和 uncertain。播放已有音频接受已登记 ID 或受现有路径边界约束的音频文件，不隐式合成。受管命令清理自身进程组；独立后台服务不被假定为已停止，文件存在也不自动证明完整合成。生成记录损坏或格式不兼容时不丢弃记录重新提交。

`AtomicJsonStore` 是 Plan、Team、ExecutionLedger 和 Session 的统一 JSON 状态层：按绝对路径共享进程内队列，使用跨进程锁在锁内重读，写入 PID+UUID 临时文件后原子 rename，并通过 Zod 校验和损坏文件隔离处理异常。MemoryHub 的语义正文使用原子 Markdown 页面，派生索引与控制账本使用 SQLite WAL；控制表损坏时写入失败关闭，不能从空状态继续。

状态版本高于当前二进制支持上限时属于部署版本回退，不属于物理损坏。Store 必须保留原文件、
不得创建 `.corrupt-*` 备份或 blocking marker，并以明确的版本不兼容错误停止启动。当前
`ExecutionLedger` 只允许 v1 单向迁移到 v2；Runtime 在连接 MCP 或开放任何执行器前完成
原子迁移，不能把迁移拖到下一次副作用写入；v2 原样读取，未来版本由旧二进制失败关闭。
`npm run build` 在编译后把完整 Git commit、dirty 标志和 package version 写入发布包内的
`dist/build-identity.json`；无 Git metadata 的源码归档失败关闭为 `unknown + dirty`，仍可供
开发使用，但不能建立 release/soak T0。运行时 identity 同时绑定该 provenance 与全部同扩展
运行文件的内容摘要，文件 mtime 或重新安装不会改变 identity，stale/损坏 manifest 也不会
回退借用宿主仓库的 Git 状态。安装或重启后的 Daemon build identity 必须与当前 CLI 产物
逐字一致，禁止旧全局包继续处理已经由新版本写入的账本。Doctor 只读报告 installed、running
和可选 workspace HEAD/dirty；漂移会使诊断不 ready，但不会自动重启后台或修改工作树。

本地 Function Tool 的副作用以 `sessionId + runId + toolName + logicalCallId` 记入执行账本。Daemon 的 logicalCallId 由规范化参数和同参数调用序号组成：同一 attempt 内的合法重复调用分别执行，跨 attempt 的对应序号才回放；`started` 或 `failed` 状态不会自动重试。原生 MCP transport 也使用同一 executionKey；Hosted Tools 仍不在本地账本控制内。

模型可调用的 Shell 默认只获得 PATH、HOME、locale、终端和临时目录等显式白名单环境；Provider、数据库、遥测、Connector 和 Mimi 控制面变量都不进入 Shell。Host 在继承 PATH 前显式加入当前 Node 可执行目录、`~/.local/bin` 和 `~/.bun/bin`，使 launchd 的最小环境也能运行已安装的本机 CLI 及其解释器，而不依赖交互式 shell 配置。Safe、Workstation 与 Full Owner 只在进程启动配置边界解析一次，生成不可变 `RuntimeAccess`；RunScope 不保存、切换或恢复安全档位，Session 偏好也不能扩大该启动能力集合。已认证本机 Owner 在直接 CLI 或认证 localhost Runtime HTTP 命令中粘贴的 credential/authorization/private key 例外地进入 Kernel 内存态临时 broker：持久 user input 只保留指纹引用，原值最多等待十五分钟，只可由匹配 Event + Session + owner provenance 的首次 Conversation Run 取出。只有启动时具备临时敏感模型访问能力的 Owner Conversation Run 才可向当前配置 Provider（含已配置兼容备选路由）披露原值，并作为 `MIMI_EPHEMERAL_SECRET_n` 只注入主 Agent 的 Shell。Safe/Workstation、外部事件、后台 Task、其他 Session、SubAgent/Team、MCP、Connector 和普通环境不能取得或继承该 lease。

临时能力不依赖自然语言或命令字符串分类。所有工具调用先按当前 Run 的精确值集合检查参数；命中时不 dispatch、不进入 ExecutionLedger，而是向模型返回 `retryable` 工具拒绝，让同一 Run 改用 `MIMI_EPHEMERAL_SECRET_n` 环境变量继续。Shell 输出再次精确脱敏。默认禁止把原值写入文件；只有 Owner 本轮明确要求为指定本机 Provider 或集成持久配置 credential 时，主 Agent Shell 才可通过环境变量写入 owner-private 配置目标并保持 `0600`，不得写入工作区、源码、文档或调试产物。敏感 Run 使用只代理当前 FileSession 的净化 Session port，模型生成的 assistant/function_call/function_result item 在写入前精确脱敏；工具结果和异常在返回模型与进入账本前脱敏，Runtime Event/Trace 同样净化。为了覆盖跨 chunk 泄漏，敏感 Run 不转发模型文本 delta，只在完成后交付脱敏答案。Run 完成、取消、Provider 最终失败、首次领取、超时或 Daemon 重启后能力消失；失败任务终止而不携带原值自动重试。Shell 的正常退出、超时和取消都会回收完整 POSIX 进程组，文本后台语法检查只是早期提示。HTTP Tool 只允许公网 HTTP(S)，在初始 URL、实际 socket DNS lookup 和每次重定向处拒绝 loopback、私网、link-local、metadata、multicast、IPv4-mapped IPv6 与混合解析；禁止 HTTPS 降级，跨源只跟随无正文的 GET/HEAD 并仅保留安全读取头。

Session 模型偏好同时记录 provider；切换 Provider 或读取没有 provider 标记的旧偏好时回退当前 Provider 默认模型，不把一个 Provider 的模型名发送给另一个端点。

## MimiAgent 常驻事件循环

常驻模式不是一条无限运行的模型请求，而是一个长期在线、每次唤醒都有界的事件循环：

```text
Connector / CLI / Schedule
  → append immutable Event（source + externalId 幂等）
  → EventRouter + Attention 写 route receipt
      ├─ digest → 摘要池 → Briefing Event + Task
      ├─ observe_only / rejected → 不创建工作
      └─ task_created → 0..N durable Tasks
  → Task scheduler claim + lease
      ├─ session_actor → MimiHost（同 Session FIFO，跨 Session 并行）
      ├─ isolated_worker → TaskProcessSupervisor fork OS worker
      └─ codex → detached runner 启动独立 Codex CLI，直接回写终态与产物
  → Run 记录一次 attempt
  → Task 终态 + task.* lifecycle Event + Outbox 同事务提交
  → Kernel Notifier deliver；失败独立退避重试
```

`MimiHost` 是 Session actor registry，而不是全局单工 lane。每个 actor 是其可变 Agent 的唯一所有者，Session 选择、模型/模式变更、清理和 Run 在该 Session 的 FIFO lane 内执行；Host 的 semaphore 只限制同时活跃的不同 Session 数。只读 `sessionSnapshot(id)` 直接读取指定 FileSession，不切换当前 Session。Dispatcher 可同时持有多个不同 Session 的 Task lease，但不会并发写同一个 transcript；isolated worker 只领取 supervisor 指定的 Task。`codex` Task 不创建 Mimi Run/Plan：Supervisor 只启动 detached runner，runner 启动 Codex CLI 后与 Kernel 生命周期解耦，自行续租，并把 runner PID、Codex PID、thread、JSONL 输出和 summary 文件写入 Task；Codex 退出后提交 Task 终态；新委派任务在同一事务中路由 `task.completed`，唤醒原 Conversation 的 Mimi 核查结果，再由核查任务的 Outbox 汇报。旧任务或明确静默完成保留直接结算。Mimi 不干预 Codex 内部执行、不自动切换执行器，Codex 启动或运行失败也作为该 Task 的真实终态失败；为避免不确定副作用被重放，Codex Task 默认只允许一次 Attempt。Agent Run 期间查询 ready Task：达到 Attention `urgentPriority` 的高优先级候选可在没有 Tool 在途时 abort 当前模型思考；Tool 在途时等待结果落账。Task 的过期租约会回到待处理状态并依靠执行账本恢复；Outbox 的过期 `sending` 租约代表远端结果不确定，会直接进入 dead letter。明确可重试的普通失败才指数退避并在达到上限后 dead-letter。

Supervisor 在 fork 和 claim 之前从实际 worker entry 检查必需运行依赖。依赖缺失时 Task 保持
queued 且不消耗 attempt，诊断日志按分钟限频；不能把安装或工作树损坏变成数秒内耗尽
3/5 次机会的 dead-letter 风暴。结构化 `taskWorkerRuntime` 同时进入 status、Doctor、
health 和脱敏 diagnostics，缺失依赖是 unhealthy 风险而不是空闲假象；恢复依赖后
同一个持久 Task 可由正常 pump 继续领取。

SDK Session 完成早于 SQLite Event/Outbox 事务时，执行账本会保留 `sessionId + executionKey` 的完成回执。回执同时保存由成功控制工具恢复并严格校验的 RuntimeAction；模型/模式/输出/Session 切换、清空、MCP 重载和退出效果通过独立 action ledger 至多执行一次。`clear_session` 会保留当前 execution root 及子账本，直到 Event 事务确认后统一清理，因此崩溃恢复不会把清空动作重放到后来数据。若进程在任一边界崩溃，重试读取回执、修复 checkpoint、复用原答案和 RuntimeEffect，不再次调用模型；SQLite 提交成功后才清理回执。该机制与 Tool at-most-once ledger 一起缩小跨存储崩溃窗口，但不把两种存储宣称为分布式 exactly-once 事务。

CLI 启动快照只携带有界的最近对话和当前 Plan，避免 7×24 Session 最终撞上本地 IPC 帧上限；`/history` 通过带 revision 的分块 RPC 重组权威数据，读取期间发生变化会失败关闭并提示重试。Memory 列表只返回有界摘要与 ref，完整页面必须显式 `memory_read`。Event、Run、Outbox 和 Schedule 的列表 RPC 只读取不含大正文的有界摘要，`daemon show` 再按 ID 读取单项详情；IPC 分别限制 1MiB 请求与 8MiB 响应，服务端在写出前失败关闭。Plan 更新作为同一 Event 的 live stream 事件送到输入区，完成结果中的 RuntimeEffect 则更新远程 CLI 的 Session、输出状态和退出行为，不建立客户端状态真相。

同一 Dispatcher 内还有一个局部 Agent idle watchdog。每次 Run 从最新 Attention 配置读取 `execution.runIdleTimeoutMs`；只有可投影的非空模型文本/推理、Agent/Tool 状态和 Runtime Event 才刷新 timer，Provider 空 chunk、keepalive 与元数据事件不算进展；Tool 在途时暂停，最后一个 Tool 输出后恢复。无进展超时只 abort 当前 Run，继续复用 Event retry、execution ledger 和最终失败升级，不建立 watchdog 服务或硬总时长。Daemon stop 请求若遇到在途 Tool 会等待其输出落账，再中止模型、撤销本次 claim attempt、立即重排队并把 Host Run 标为 interrupted，正常升级或重启不会切断外部事务或消耗失败次数。

Dead letter 不是静默终态。Event 达到最大尝试次数时，状态更新、Host Run 失败、audit 和一个绑定原 Event 的 system Outbox 在同一事务提交；它绕过模型直接使用本机 Notifier。非 system Outbox 的普通可重试失败按退避耗尽后进入 dead letter；超时、进程中断、ACK 丢失或 Connector 显式 `uncertain:true` 则首个 attempt 直接 dead-letter，避免结果不确定的消息自动重放。sending 租约默认 180 秒，覆盖内置 Connector 最大 120 秒投递超时；崩溃恢复遇到真正过期的 sending 也原子 dead-letter，而不是重置 pending。投递最多使用四个有界 lane，lane key 是精确 `(channel,target)`：同一会话保持 FIFO，一个失联 QQ 群不会阻塞其他 QQ 私聊或其他渠道会话。两种 dead letter 都在状态事务内插入 system fallback；若 fallback 本身也失败，只记录 system dead letter，不再生成下一层通知。载荷只含有界 ID/source/channel/attempts/error 摘要，不复制 Event payload、消息正文、投递内容或 target。owner 可通过窄 RPC/CLI 把 dead letter 原 ID 重排队或标记为 archived，四种变化都以状态 CAS 和 audit 原子提交；后台从不自动重放。owner 显式 Outbox 重投保持 at-least-once 语义，控制面明确提示远端确认丢失时可能重复。这里没有告警服务、失败 Agent、审批流或第二张升级表。

Schema v7 在 v6 历史保留索引之上增加旧 Event 执行字段；v8 增加运行控制；v9 增加 Schedule authority。Schema v12 一次性完成 Event / Task 分层：旧库在单个 `BEGIN IMMEDIATE` transaction 内转换为不可变 `events`、`event_route_receipts`、唯一 `tasks` 队列、仅引用 `task_id` 的 `runs` 与 `outbox`，校验失败即整体回滚；不存在 `events_v2`、`task_attempts`、双写或 legacy adapter。Schema v16 让 `Task.executor` 成为唯一领取键：Conversation 归 `session_actor`，Briefing 固定为 `isolated_worker + read`，后台任务由 `isolated_worker|codex` 领取；type 只表达业务类别。入队统一校验 type/executor/workspace 组合，旧 queued Briefing 原地迁移，无法解释的历史组合只写 audit。迁移同时结束重复 Connector-health Digest 投影但保留原 Event，并在事务内校验 integrity/FK；打开 v15 前会复制 SQLite/WAL/SHM，v17 进一步增加 Schedule 的有界 context 与 Run 时间索引，升级前备份，fresh DB 创建到 v17；旧版不能直接打开升级后的库。运行中 Task 的 cancel/pause 先持久化控制意图，再尽力通过 IPC 提醒 worker；worker 在 Tool 安全边界和续租时消费它。若 Kernel 或 worker 先崩溃，claim/lease recovery 会把 cancel 收敛为 `cancelled`、把 pause 收敛为 `paused`，且 cancel 始终覆盖 pause。Dispatcher 低频调用 `pruneHistory(cutoff)`；Store 先清理已解决 Outbox/Digest，再按 Task→Run 和 Event 引用关系执行保留清理，所有活跃 Task、dead letter、未解决 Outbox/Digest、Schedule authority 与当前 Connector health state 均受显式保护。事务后只做轻量 optimize/passive checkpoint，不自动 VACUUM。

MimiAgent Event 获得一个只读运行自省 Host Tool 与四个 Schedule Host Tool。`inspect_mimi_activity` 直接从 Store 生成有界快照，包括 counts、积压、dead letter、Digest/Schedule 数量及近期 Event/Run/Outbox/Audit 元数据，不返回其他事务正文、答案、投递内容或 target。Schedule Tools 用于创建一次性 follow-up、周期 routine、查询和取消计划；新计划保留发起事件的 origin Session、profile、trust provenance、reply route 和不可变 Conversation authority root。到期 occurrence 总是进入独立 `mimi-task-*` Session 与 Task lane，由 OS worker 执行，不占用来源 Conversation actor；Task 每次从 durable root 与当前 source policy 重新计算权限。owner/system 的本机 CLI 计划使用可审计的合成 root；外部来源缺根、根被删除或 provenance 不匹配时失败关闭且不发出新 Task。撤销外部 work policy 后，一次性 follow-up 只能受限收尾，interval/watch 只获得绑定当前 authentic occurrence 的 `complete_current_mimi_schedule` 以停止轮询，伪造 occurrence 不获得该工具。非 command Event 额外获得 `finish_mimi_silently`：它只修改当前 attempt 的内存 DeliveryControl，成功提交时把 suppression reason 放入 Event result 并省略 Outbox；直接 command 没有该工具，失败/重试也不继承状态。所有能力继续位于同一个事务语境，不引入 RPC 回环或工作流引擎；创建/取消工具进入事件级语义账本，重试不会重复建立计划，静默控制不是外部副作用且不进入 ledger。

最终工具集取 `mode capability ∩ Owner runtime profile ∩ event policy`。本机认证 Owner 默认使用 `full-owner/trusted`，直接使用当前 OS 用户权限，并授权当前 Run 将 Owner 本轮临时敏感值发送给配置模型 Provider；不再把 Session preference 作为授权层，旧 Session 保存的 Safe/Workstation 值会被忽略，避免切换对话时意外降权。`safe/read-only` 与 `workstation/workspace` 只作为启动级或显式临时收紧：前者只读，后者允许工作区写入和显式 Connector 事务，两者都不开放 Shell、Computer Use、受信工作区 MCP 或临时敏感值的模型披露。交互式 `/security` 使用权威 profile catalog 打开与 `/sessions` 一致的 TUI 选择器，支持 `↑` / `↓`、`Enter` 和 `Esc`；显式参数仍可直接选择。切换作用于当前运行实例并从下一轮生效，重启后恢复环境配置。RunScope 在开始时冻结 profile 和 permissionMode，运行中不能切换，避免同一轮授权漂移。已认证本机 owner 的自由文本 Conversation 不按自然语言关键词或正则表达式选择工具流程，而是在当前模式、运行权限和来源策略允许的范围内获得统一工具面；模型结合完整 Session 上下文选择是否以及如何调用工具。`/status`、`/sessions` 等显式斜杠命令由 `CommandHandler` 作为结构化控制协议直接处理，不依赖语义猜测。Skills 仍由独立的 Catalog/激活协议渐进披露，这只控制 Skill 指令加载，不裁剪 owner 的基础工具面。已配置的 Connector Host Tools 继续经过 profile/mode/event policy；受信工作区 MCP 只允许 Full Owner 显式配置。外部事件默认禁用 Session/Memory、本地文件、Shell、MCP、未知工具和外部写事务。命中 owner source policy 后使用固定 `reply | work` 档位，旧配置默认 `reply`，多个匹配取最高档：`reply` 只有时间、计算、当前 Session 有界活动与投递控制，不能调用 Shell、文件写、任意写网络、Connector action、后台委派或 Team；`work` 才获得原静态工作 allowlist，但仍不能读写 Runtime/Attention/People/Standing Order/Connector 配置、写 Memory、管理任意既有后台任务或调用未知 MCP。Task 的 `workspaceAccess=read` 再与来源权限相交，形成固定只读研究/checkpoint 工具集。

这条“自由文本不参与 Host 路由”同样适用于工作区、Project Guidance、Session 控制、Completion Contract、Memory provenance、个人消息和完成判定：工作区/续跑/确认正文来自可信结构化字段，Session 工具由统一能力面与 ExecutionLedger 约束，Completion kind 与证据由显式 Contract schema 和实际 Tool receipt 约束，`remember.provenance` 明确区分 owner-explicit 与 autonomous，`messageMode` 来自 owner source policy。Host 不再扫描 owner 输入或模型答案中的业务词汇来猜任务类型、风险、下一流程或是否完成。路径、ID、协议命令、schema、机器错误码和敏感字段脱敏仍允许确定性语法校验；这些不改变 owner 意图或工具面。

Computer Use 不随 `work` 隐式授予。source policy 还必须显式声明 `computerAccess: observe|background|foreground|admin`，可用 `computerApps` 形成 bundle ID allowlist；多个匹配 policy 的应用列表取交集。所有后台 Task、SubAgent、Team worker、`workspace/read-only` 部署和未授权 Event 固定没有电脑操作能力。

Attention Engine 是同步、确定性的 Host 层分类器，不是第二个模型。它从 `assistant.json` 读取 owner 关注点、默认 reply route、时区、静默时段、运行预算、阈值和有序规则。Settings Host Tools 以完整快照更新这些标量设置；Rule Host Tools 按稳定 ID 列举、完整 upsert、删除规则，并通过 `beforeId` 保持“第一条匹配生效”的显式顺序，二者复用同一原子配置变更且不触碰其他配置域。来源自带 route 时保持原会话回复；缺失时使用最近 owner Connector 或 `owner.replyRoute`，但 `local-cli` 与 Webhook 明确不回落，避免把 CLI 返回值重复发往旧渠道。Routine、Briefing 和后续 Schedule 复用同一路由，可覆盖 channel/target；status 只暴露 channel。这里没有 fan-out、路由规则表或通知工作流。低价值事件原子转为 `digested` 并写入 `digest_items`；到达简报时点或 Agent 调用 `request_mimi_briefing` 后只创建一个普通 `external` Event，继续复用同一 Dispatcher、受限 event policy、Session 和 Outbox，摘要内容不会因聚合而洗成 system 指令。摘要只有在简报 Event 成功终结后才归档，dead-letter 或 archived 简报关联项会在下次创建时释放，从而避免丢失；Host Tool 不返回摘要正文。

同一个 `assistant.json` 还保存 daemon-only Standing Orders。owner/system Run 总能使用匹配的可信策略；外部 Run 只有命中一条 source policy 时才获得替身授权，并同时注入去重后的全局/局部 order。`access` 是 Host 校验的固定档位而非提示词，缺省为 `reply`，多匹配取最高的 `work`。原始事件正文保持原样作为 user input，继续被单独标为不可信数据，不会与契约、人物上下文或剧本拼成一段伪用户指令；它不能扩大本机策略的目标、收件人或副作用范围。`MIMI.md` Soul、direct-owner `PREFERENCES.md` 与层级化 `AGENTS.md` / `CLAUDE.md` Project Guidance 继续复用同一 Runtime context builder，因此没有第二套 instructions loader 或策略 Agent。

`assistant.json people` 在 Attention Host 内做 owner-managed canonical identity resolution。每个 person 只包含稳定 ID、显示名、有界 `source + actor` glob aliases 和可信 context；按配置顺序采用首个匹配项，不做模型推断、联系人同步或身份图。Host Tools 可列举、完整 upsert 和删除人物，并复用 Routine/Standing Order 的原子配置变更。显式 Event sessionKey 优先且必须通过核心 Session schema；否则匹配人物从 ID 派生稳定安全的 `mimi-person-*`，不兼容字符或超长 ID 使用稳定摘要。默认受限事件仍可使用该路由键，但看不到既有 Session；owner/system 或命中 source policy 的替身 Run 才携带 canonical person、注入人物 context，只有 `work` 档位开放有界 MemoryHub 读取。status 只暴露 person/alias 数量。

同一配置中的 Daily Routines 负责本地时区日常节奏。新配置默认为空，只有 owner 显式创建后才运行。AttentionEngine 只检查 `time + optional weekdays`，为每个 occurrence 写入终态 owner Conversation authority root，再生成绑定该 root 的 `attention:routine` Task Event；`source + routine:<id>:<local-date>:<time>` 复用 Event 唯一键实现每日幂等，进程内按日期 checkpoint 避免高频重复写库。例程和启用后的定时 Briefing 都只有计划时刻后的 15 分钟补发窗口，过期 occurrence 不追赶。每个 occurrence 使用独立 Task Session/OS worker，原 Routine Session 只作为 `originSessionKey`，因此固定巡检不会阻塞同源对话；配置删除、禁用或 revision 变化仍会在执行前使旧 occurrence 失效。Daemon Host Tools 可列举、upsert 和删除 Routine；写入串行读取最新文件、复用完整 schema 校验并以 `0600` 临时文件 atomic rename，随后更新同一内存 Engine。owner 可让自定义例程先调用运行自省工具核对积压与失败，再检查外部工作生活来源；有关键结果就汇报，确实无变化时显式静默完成。它不新增 cron parser、调度表或执行路径，prompt 最终仍由同一个 Dispatcher 和 MimiAgent 处理。

来源 `trust` 只作为 provenance 标签，授权由本机 event policy 决定；它绝不因消息自称 owner/trusted 而扩大部署权限。owner/system 在部署权限内工作；其他 provenance 默认受限，只有 Host 用 source/kind/actor/conversation 命中本机 owner source policy 时才获得固定 `reply | work` 档位。后台 Task 不把 provenance 改写成 owner，而是从被保留且确认为 conversation root 的来源 Event 与当前 source policy 重新计算授权；policy 被删除、root/parent 缺失或引用 Task 而非 conversation root 时失败关闭，即使 Task 自带 owner provenance 也不能绕过。外部正文始终只作为数据并记录 provenance。

Connector Action Bridge 把外部凭证保留在 Kernel 监督的隔离 Connector 子进程中。一个 Daemon 数据根只有一个 Connector Manager/broker；Conversation actor 与后台 Task worker 都不能各自拉起同一渠道或复制凭证。每个 action 声明稳定 `capability`、`effect` 和 `modelVisible`；只有模型可见的 Connector 业务 action 进入 Snapshot 的 routedItems，内部探活、目标绑定发送和协议动作仍留在 Host，Host 自身授权的高层业务工具只以无 schema 名称进入 hiddenTools 索引。Manager 在 dispatch 前完成权限、唯一路线、就绪度、幂等与结果分级。旧 `claimedComputerApps` 只保留读取兼容，不再形成整应用授权边界；Computer 保留控制面保护和精确目标校验。超时或子进程退出时不自动重放。

Browser 与 Computer 是渐进目录的两个一等例外：高频通用操作直接向主 Agent 投影
严格 Function Tools，模型不先查询 Connector、Skill 或 Backend schema。Browser 的
`BrowserRunManager` 按 Run 持有单一逻辑会话生命周期，OpenCLI/Chrome ref 只在
Host/Connector 之间流转；标准网页 observation 使用 DOM，最终序列化结果不超过
16 KiB。Connector 将每个逻辑标签映射到独立后台 OpenCLI session，向模型只暴露稳定
page ID，避免 backend 的默认标签切换丢失原页；关闭标签会原子更新 active page 并返回
恢复后的 URL。uncertain open 禁止继续页面动作，close 只投递一次；Dispatcher 在发布完成
前清理，失败进入不可重试 dead letter。Computer 只投影两个聚合工具，`ComputerManager` 绑定不可变 authority、
最新精确窗口 observation、动作预算和 session；degraded 且没有 AX/截图证据的
observation 不可授权写动作。两条路径都保留 ExecutionLedger 的 at-most-once 语义，
uncertain close 或 action 不能被模型、Daemon 或替代路线静默重放。

`personal-*` Connector 的 `send_message/send_to_owner` 是 Host 内部 action：
`modelVisible:false` 让通用 Connector 目录和执行工具都无法触达。Owner 自发消息只
通过统一渐进能力索引披露 `send_owner_message(channel,text)`；模型精确查询后取得
schema，Host 绑定账号与 owner 自会话。Dispatcher
仍只能从当前个人消息 Event、精确 Source Policy 和实时
readiness 生成临时 `PersonalMessageScope`，其中 callback 已绑定 Connector 或当前
Session Actor 的 QQ ComputerManager、账号与稳定会话；Runtime 只把两个窄工具加入当前主 Agent，不传给 SubAgent、Team worker
或独立后台 Task。token 绑定 Run、Event、渠道、账号、会话、最新消息指纹和五分钟
过期时间，并在外部写开始前 fencing 为已消费。QQ route 只接受 Source Policy 明确
授权的 `com.tencent.qq` 后台窗口，观察、草稿写入、Return 和动作后回读都复用
ComputerManager 的新鲜 Observation、应用 allowlist、前台保护和全局动作串行化；
发送后无法同时确认新增同文气泡与空输入框时结果为 uncertain，禁止换路重试。

Daemon 的本地副作用账本使用稳定的 `eventId` 作为 execution scope，并以工具名和规范参数生成语义 call ID。模型重试时即使 SDK call ID 改变，相同动作也只重放已保存结果。账本只在 Event 成功提交后清理；retry、抢占和 dead letter 都保留它，因此 dead letter 原 ID 显式恢复时仍不会再次执行已经成功落账的相同动作。若进程在外部动作后、事件提交前崩溃，租约恢复后的重试也不会重复该动作。

Unix Socket 位于 `MIMI_DAEMON_DATA_DIR`（可回退旧目录）且权限为 `0600`，提供 status、chat snapshot/history/invoke、activity、submit、events、tasks、runs、outbox、dead-letter retry/archive、attention、connectors、schedules 和 shutdown。仅靠同用户可连接的 Socket 不作为 owner 认证：bootstrap 在同目录原子创建并校验一个 `0600` 随机 control bearer，普通 `mimiRpc`/CLI 自动读取并随请求发送，Kernel 对除两条专用 worker broker 方法外的全部 RPC（包括 ping/status/submit/shutdown）做固定长度摘要的 constant-time 比较。token 不进入 SQLite、环境、status、Doctor、日志或错误文本；运行中新 daemon 的 token 文件缺失、权限错误、内容错误或值不匹配都 fail closed。Task worker broker 只验证 Supervisor 分配的独立 `workerToken`，其客户端显式不读取 control bearer。旧 daemon 会忽略新请求附带的 `auth` 字段；尚未初始化 token 的只读探测也仍可使用旧协议，因此新 CLI 能读取 status 并完成安全升级。协议版本提升确保已运行旧实例不会被误当成当前控制面；同协议 status 还必须携带由包版本、完整 commit、dirty 标志和运行文件内容摘要导出的 build identity，缺失或不一致都按待升级处理。status 同时携带活跃 Session Event、task worker PID/heartbeat、在途 Tool 及 Host/管理 mutation 数；Chat 修改、Attention reload 和 Connector 热重载共用一个关闭门，普通 shutdown 只有在 Event、task worker、Outbox 和管理事务都空闲时才原子停止接收新事务。显式 `daemon restart --force` 也不能越过在途 Tool、独立 worker、Host mutation 或 Outbox sending；它只 abort 尚无 Tool 的模型 Run，由既有 claim/requeue 语义安全重排，未知旧版状态失败关闭，且不重放 uncertain 副作用。持久化的 queued/blocked/dead-letter/Digest backlog 不属于活动关闭边界。CLI 从任意目录采用现有后台的绑定工作区，并按该工作区重新解析默认数据、Skill 与 MCP 路径；本地显式 workspace 只决定没有后台时新 Host 的启动位置。长期开启的 CLI 在 Host 被替换后重新采用新实例报告的工作区；普通 RPC 在连接尚未建立而收到 `ENOENT/ECONNREFUSED` 时恢复后台并安全重试一次。空闲旧版会先经 shutdown 安全退出再由当前入口重启，活动 Event、task、Outbox 或 mutation 和未来版本都不会被强制终止。当前实例已经拥有 launchd job 时继续由同一 KeepAlive job 托管；入口或配置需要升级时由 owner 显式运行 `mimi daemon install` 原子更新。交互式与单次 CLI 都走该入口；命令通过共享 `CommandHandler` 和远程 adapter 作用于同一个 Host。FileSession 是唯一 transcript 真相；`chat.snapshot` 只返回指定 Session 的有界展示项、偏好、Plan 与恢复点，`chat.history` 按修订号分块传送完整权威 items，两者都不切换当前 Session。SQLite Event/Run 只做可靠控制面和 Activity，不再拼装第二份聊天记录。Doctor 额外聚合 SQLite/WAL/SHM、Memory 和 Daemon 日志的容量阈值；安全重启在旧进程退出后轮转超限日志并保留固定五代。`daemon diagnostics` 使用显式白名单生成 `0600` JSON：Connector 只保留 readiness 计数，health 只保留风险代码和 backlog，文件只保留大小与时间，绝不序列化 Event/Outbox/Session/Run/Memory 正文、target、凭证、Connector 参数或本机路径。

Daemon 启动前经过一个幂等 bootstrap，而不是额外安装服务：首次运行从发布包 Connector catalog 物化绝对 Node/脚本路径，创建 `0700` 数据目录、原子且稳定的 `0600` control bearer、`0600` 配置和 SQLite 数据库。Darwin 本机 Connector 默认启用，凭证型外部来源保持待配置；QQ UI 自动化不属于默认集合。升级现有配置时补缺失的默认 enabled 本机 Connector，并通过单独版本门只补一次大象/QQ 两个 disabled 个人消息槽位；微信相关 Connector 和桥会作为 retired 项原子删除，迁移完成后也不会被后续启动恢复。其他模板中默认关闭的外部通道仍不补入。对同 ID、canonical packaged script 路径/文件身份一致，或脚本同名且 2MB 内内容摘要一致，并且未关闭 `syncTemplateActions` 的现有 Connector 合并缺失 action；内容副本仍保留 owner 配置的执行路径。`macos-system` 也只有满足该身份校验时才迁移精确旧 provenance。其他 owner 的 enabled、执行路径、环境、来源、超时和已有描述均保持不变，且无变更时不写文件。Detached 与 launchd 启动复用同一个非敏感环境构造器，保持 workspace、状态目录、Skills、MCP、permission 和运行限制一致；Daemon status 返回实际 permission，CLI 会和本地解析值一起核对。LaunchAgent plist 以其 Daemon data root 标记所有权：普通 `mimi`/`daemon start` 只复用属于当前数据根的 plist，否则启动 detached，不自动安装、迁移或重写全局 job。`mimi daemon install` 是唯一安装/升级入口；它要求持久 Provider Key，通过跨进程锁和原子替换更新 plist，并在发现另一 data root 的实例时明确拒绝覆盖。协议过期或 permission 不一致的同工作区后台只有在 Event、Outbox 和 Host mutation 全部空闲时才会被替换。首次解析的 env 文件路径会固化为绝对路径，API Key 等秘密仍只来自进程环境或该受保护 env 文件。Doctor 只对当前实例拥有的 plist 检查持久 Key 和 launchd 状态，并复用同一 schema 做只读静态检查和短时认证 Unix Socket status；它不拉起 Connector、不探测私人数据库、不会输出 control bearer，也不触发系统权限。

恢复备份是独立于数据库迁移备份的用户运维边界。在线备份使用 SQLite Backup API，不直接复制活动 WAL；其余原子 JSON、Session、Memory Wiki、Trace 与配置按显式 allowlist 复制，control bearer、Socket、日志和临时 Computer 产物排除。完成标记 `manifest.json` 最后写入，逐文件记录大小和 SHA-256，并要求备份数据库通过 `integrity_check`。校验拒绝缺失、多余、篡改或符号链接文件。恢复仅对离线且不存在的数据根开放，先在同一父目录 staging、复验数据库，再以目录 rename 提交；不覆盖已有状态、不带回旧 IPC 身份，适用于空白环境恢复演练。

渠道通过独立 NDJSON 子进程接入。Host 只传递 allowlist 环境变量，负责子进程退避重启；带 `replyTarget` 的结果走 Connector Outbox 并等待 delivery ACK，主动事务走 Action Bridge。没有专用 Bridge 或必须先经过官方服务端回调的来源可使用只绑定 `127.0.0.1` 的 Bearer Webhook；Webhook 固定产生 external provenance，限制 1MB 和每分钟 60 次，并接受有界 `reply:{connector,target}` 转换为现有 Connector route。`notify:false` 表示显式无回传，不继承 owner route。入口不把渠道 SDK 或凭证耦合进 Agent Runtime。

Connector 配置换代复用同一个 Manager 对象和显式 Unix Socket RPC。新文件在触碰旧进程前完整解析；Manager 先确认没有 pending delivery/action，再 drain、停止并精确注销旧 notification sink，最后安装启动新 Map。每条 delivery/action 带绝对截止时间；外层超时会关闭 stdin、终止并按配置重启整个 Connector，UI Connector 同时负责终止自己的在途系统子进程，避免调用方已收到超时而动作仍晚到。Dispatcher 每个 Event 动态构造 action tool，execute 闭包也始终查询同一 Manager，因此无需重建 Agent、Dispatcher 或 Daemon。这里刻意没有文件 watcher、配置版本表或双进程交接协议。

Connector 自愈复用普通 Event 语义，不建立第二套健康数据库或监控循环。Host 在现有 `attention_state` 中持久化每个 Connector 的当前 `ready|unavailable|stale|unknown` 与有界原因；heartbeat 只刷新该确定性状态。初始观测和未变化 heartbeat 不创建 Event、Task 或模型 Run，只有从既有状态退化、退化原因变化及恢复才原子写入一个高优先级 `system:connector-health` Event。轮询 Connector 可在 status 声明 `freshForMs`，Host 记录本机接收时间并安排一次精确过期检查；stale 不再计入 ready，并进入共享 Daemon health 风险。正常 Daemon stop 不报告离线，健康 Event 继续受 Attention 静默时段、规则和预算约束。完整故障写本机 stderr，进入 Agent 上下文的错误摘要不包含命令参数或原始路径。

无回调能力的信息源复用同一 Connector 协议做有界轮询。内置 Radar 示例只包含 RSS/Atom 和 Open-Meteo 两个明确 driver，不引入通用爬虫 DSL；新闻产生 ambient Event，天气阈值产生 alert Event，跨重启去重仍由中心 Store 完成。

文件活动雷达沿用相同的无状态轮询边界，但只扫描配置目录的元数据。它不读取正文、不跟随符号链接、不保存 cursor，也不重复实现移动/删除等 Runtime 已有文件工具；`watchId + path + mtime + size` 形成稳定事件身份，扫描深度、条目数、回看窗口和单轮事件数全部有界。这样 Downloads、共享落盘目录或外部自动化输出可以主动唤醒 MimiAgent，而不把平台文件监听器塞进 Daemon。

本地容量基准直接复用生产 `MimiStore`、`FileSession` 和
`SqliteMemoryCatalog`，在一次性临时根中测量 Event→Task 入库、lease claim、
Session round 写入/枚举、Memory 重建/lexical recall 和磁盘增长。参数与环境写入
版本化 JSON，默认清理临时状态且绝不读取真实用户数据；它是版本间回归证据，不是
跨机器绝对 SLO，也不替代并发公平性、真实 Provider 或安全评测。

OpenAI/DeepSeek 的确定性 Provider contract 使用 checked-in JSON fixture 固定
API Key 名、默认模型、transport、context profile、图片能力和跨 Provider message
ID 清洗。离线 contract test 还从同一内置 Tool 工厂验证名称唯一与 HTTP schema
可移植性；除 fixture 明示的 transport/能力差异外，两类 Provider 共享 Runtime、
权限、Session 和完成语义。真实模型 canary 保持 opt-in，以 Safe 档位、隔离数据根
和固定计算 Tool 任务分别检查两个 Provider；它不能替代离线回归边界，也不进入
无凭证 CI。详见 [PROVIDER_CANARY.md](PROVIDER_CANARY.md)。

权限与 Prompt Injection eval 把恶意正文作为不可信 case payload，使用真实
`decideEvent` 生成 provenance/source-policy RunPolicy，再与安全档位和统一
ToolDescriptor 目录相交。矩阵固定 external/public、reply/work 与 Safe/Full Owner
组合的精确 allowlist 和 forbidden tools，确保正文自称 system/owner、要求修改
控制面或调用未知 MCP 都不能扩大 Host 授权。该确定性边界不依赖模型是否“听话”。

npm 包只承诺 `mimi-agent` 与 `mimi-agent/orchestration` 两个公共入口。运行时导出
和 TypeScript 类型由 `evals/public-api-contract.json` 固定，源代码测试负责类型
可导入性，打包 smoke test 负责 tarball 的精确运行时导出；`dist/` 与 `src/` 下的
深层模块仍是内部实现。详见 [PUBLIC_API.md](PUBLIC_API.md)。

产品 Skill、实验 Skill、个人知识和用户项目的归属由
`skills/manifest.json` 与 package allowlist 共同约束。CI 要求每个 Skill 都有明确
分类，只允许 product Skill 和精确的 `knowledge/mimi-agent.md` 进入 tarball；
实验资产在迁往独立 incubator 前保持 source-only，用户项目与个人知识归属外部
工作区。详见 [REPOSITORY_BOUNDARIES.md](REPOSITORY_BOUNDARIES.md)。

macOS System 适配让电脑自身成为普通事件源。Node 内置 API提供内存、负载、非 loopback 网络接口和 `statfs` 容量，固定 argv 的 `pmset -g batt` 提供电池状态；没有平台监控框架、进程枚举或额外状态库。首轮网络只建立基线，后续只在 online 边沿输出；电池和磁盘只在阈值 band 边沿输出，并由带本地日期的 external ID 继续交给中心 Store 去重。按需快照也走同一个 Connector Action Bridge。

macOS Life 适配通过同一 JXA 边界完成 Calendar/Reminders 生命周期。查询和创建之外，update/delete 按系统稳定 UID/ID 跨可选 calendar/list 查找，不按标题猜测；字段、日期和长度在 Connector 内验证。Calendar recurrence 的最终修改/删除语义留给系统应用，所有写入继续由 Action Bridge 记录为不确定结果不重放的外部事务，没有额外日程数据库或 CRUD 框架。

macOS 邮件适配也保持在独立 Connector：JXA 只调用 Apple Mail 已配置账号，不把 IMAP/SMTP、Keychain 凭证或 Mail 对象引入 Runtime。未读轮询产生无 reply route 的 ambient Event，发信/回信是显式 Connector action，所以普通 Agent 结果不会意外外发。收件箱搜索复用系统统一 inbox 并做有界 sender/subject 与状态筛选；邮箱目录以 account + 名称数组表达，旗标、移动和删除按稳定 message ID 作为显式事务执行，不引入历史邮箱镜像、搜索索引、规则引擎或本地化归档猜测。附件仍沿用同一 Action Bridge：轮询只携带数量，按稳定 attachment ID 显式列举/保存，二进制不进 NDJSON；Node 边界验证绝对路径、普通文件与大小，并用同目录 `0600` 临时文件完成 no-clobber 或 atomic overwrite。发送、草稿和回复直接复用 Mail rich-text attachment，不新增 MIME、缓存或文件服务。

macOS Messages 适配采用两个窄边界：`node:sqlite` 只读打开 `~/Library/Messages/chat.db` 感知来信、查询历史和按 message/attachment 关系读取附件元数据，JXA 只负责经 Messages.app 发送 text/file。Connector 启动时验证核心表，附件 action 按需检测系统版本可选列，不尝试写库或解析不稳定的 attributed body。附件轮询只携带数量，显式保存复用同目录 `0600` 临时副本和原子 no-clobber/overwrite；发件文件走官方 `send(file)`，不新增附件缓存、MIME 或上传层。入站消息保留 chat GUID 作为 reply route，可直接复用可靠 Outbox 回复原会话。

macOS Contacts 适配是无轮询的 action-only Connector。它按需通过 Contacts.app JXA 返回稳定 contact ID、候选邮箱和电话，供 Mail/Messages Connector 继续执行跨渠道事务；创建和更新也在同一系统边界内显式保存。Runtime 不维护联系人镜像、搜索索引或额外身份图谱，重名消歧仍由主 Agent 基于候选和当前上下文完成。

macOS Notes 适配同样保持 action-only。Notes.app JXA 负责账号、文件夹、稳定 note ID、纯文本/HTML 正文和附件元数据；Runtime 不读取私有数据库、不建立 Notes 镜像，也不默认轮询，从而避免 Agent 写入后触发自身。纯文本写入在 Connector 内转义为 HTML，密码保护正文不尝试解锁，修改动作继续服从 Action Bridge 的不确定结果不重放语义。

macOS Shortcuts 适配把系统 `shortcuts` CLI 作为通用能力总线，但不解析 Shortcut 内部步骤，也不引入工作流 DSL。目录查询和运行均使用 argv；内联输入通过短生命周期 `0600` 临时文件桥接，文件输入/输出使用明确绝对路径，stdout、超时和输入大小有硬上限。Shortcut 的网络、应用和智能家居副作用仍由 macOS 管理，Connector 断线或超时后不会自动重放。

macOS Desktop 适配补齐没有专用 API 的即时桌面操作。System Events/JXA 只承担前台应用、窗口、剪贴板、菜单和键盘的窄动作，`/usr/bin/open` 只接受参数数组形式的 URL 或绝对路径；复杂多步骤流程仍交给 Shortcuts。可选剪贴板轮询只有进程内 hash：首次读取静默建立基线，外部变化产生 ambient Event，Connector 自身写入同步更新基线，避免形成自触发循环。它不引入 UI 工作流、截图模型或额外持久状态。

Browser Connector 是唯一网页语义执行面，只支持 Chrome，并通过 OpenCLI daemon 与 Browser Bridge 扩展复用当前 profile 和登录态。Connector 为 Mimi 创建隔离的 `mimi-*` owned/bound session；DOM/AX snapshot、locator、正文、iframe、网络 shape 和结构化页面动作均使用有界 argv 调用。读取回执可携带 `observationId` 作为关联证据，但它不参与写动作授权或新鲜度门禁；写后仍重新观察。超时、输出溢出或进程中断视为不确定且不自动重放。Safari/JXA、任意 JavaScript 和 Shell/CDP 浏览器控制不再属于产品能力。

macOS Screen 适配补齐非 DOM 视觉文字入口。Node Connector 只编排系统 `screencapture` 和一份窄职责 Swift Vision helper；截图 target、图片大小、OCR 字符/行数、子进程输出和超时全部有界。`read_screen` 的临时图片在所有终态清理，显式 `capture_screen` 才持久保存文件；没有持续录屏、屏幕轮询、图片数据库、云端 OCR 或视觉 Agent。

macOS Voice 适配是 action + event 双向 Connector。Swift helper 只负责 Speech/AVFoundation 分段识别，Node 负责唤醒短语、去重、listener 生命周期和系统 `say`；命令仍进入普通 Event/Attention/Session/Runtime 路径。环境语音不通过 wake prefix 就被丢弃，麦克风 buffer 不落盘，朗读期间 listener 暂停，因此没有第二个语音对话服务、自触发回路或长期音频存储。

## Soul、Preferences、Project Guidance 与 MemoryHub

`SoulLoader` 在 direct-owner Run 由可信 Host 每轮读取用户级 `~/.mimi-agent/MIMI.md`（缺失时使用包内模板），承载身份、人格、价值观和表达风格；该读取不依赖普通本地文件工具授权，且只返回这一份受控文件。`PreferenceStore` 同样热读取 `~/.mimi-agent/PREFERENCES.md`，承载 owner 明确要求 Mimi 跨直接对话默认遵循的稳定行为；当前 owner 指令优先，external/system Run 与 SubAgent/Team 不注入这份私有规则。`list_mimi_preferences`、`add_mimi_preference`、`remove_mimi_preference` 只在 direct-owner 工具面出现，写入有跨进程锁、单条/总量上限、`0600` 权限和同目录原子替换。Host 不扫描 owner 自由文本决定写入；模型依据语义显式调用工具。

ContextManager 把 `soul → base-instructions → behavior-preferences → runtime-context → active-skills` 作为不可静默截断的 required sections：先让模型进入 Mimi 身份，再解释核心运行准则、owner 行为默认值、本轮动态边界和任务流程；之后才按预算装配 Session state、Project Guidance、Goal/Plan/Team、recovery、archive 和 Memory Cards。完整 Skill catalog 不再每轮注入；active Skill 正文仍完整加载，其余 Skill 通过能力索引按需发现。普通新请求只加载相关 Memory 和保障运行归属所需的轻状态，不预载 Plan、Team 与整套 Personal Context；主动任务和续跑/恢复才装配对应宽上下文。存在 Soul 或 Preferences 时 direct-owner instruction budget 从 35% 提升到 40%，并额外预留两份用户级指令的实际 token，防止固定身份、行为规则与管理工具 schema 挤掉原本可用的 active Skill；总量仍不超过 input budget。Soul 与 Preferences 单文件最多读取 20000 字符；required sections 合计仍超限时请求明确失败并要求精简，而不是静默丢掉身份或稳定行为规则。只要本轮结构化能力允许读取本地工作区，`ProjectGuidanceLoader` 就从 workspace root 到当前目录层级读取已有的 `AGENTS.md` 与 `CLAUDE.md`；同目录以后加载的 `AGENTS.md` 为准。Prompt 文本位置不构成授权：ToolPolicy、Security profile、provenance、workspace scope 和副作用账本仍由 Host 强制，所有 Guidance 都不能扩大 Runtime 权限。

MemoryHub 是 Runtime 的唯一记忆门面。Session/Event/Document 是 L0 Evidence 真相；schema v2 L1 Memory Atom 与 L2 Scene/Topic 继续使用 private/workspace LLMWiki Markdown 和同一套 Compilation/Revision，旧 schema v1 页面兼容读取。L2 的 `derivedFrom` 保留到 L1/L0 的下钻链；正文承载自然语言，typed facets 只承载 kind、实体、关系、时间和来源。L3 Personal Context 由只读 Assembler 从检索卡片按 token 预算派生，不拥有事实，也不反向写 Memory、Goal 或 Schedule。

owner 私有三层 Vault 位于 `<dataRoot>/memory/vaults/owner/`：`raw/` 是内容寻址、正常维护不可改写的证据快照，`wiki/` 是 LLM 编译的当前知识，根目录 `WIKI.md` 是可执行维护 Schema；其他 profile 使用独立 Vault。内部 SQLite catalog 位于 `<dataRoot>/memory/state/profiles/<hash>/memory.db`，旧 `profiles/<hash>` 首次打开时先备份再一次性迁移。workspace Wiki 位于 `knowledge/wiki/`，Schema 位于 `knowledge/WIKI.md`。自动召回 query 通常只含当前用户意图；只有“继续”等短续接才补 active Goal 和最近两轮 user/assistant 对话，工具协议不参与，恒定 source/actor/conversation 字段也不参与检索，hot profile 不再每轮注入。

SQLite FTS5/BM25 始终作为词法基线；精确锁定的 `sqlite-vec@0.1.9` 只在同一 `memory.db` 存储 chunk vector 并执行 vec0 KNN，不生成 embedding，也不拥有事实。启动必须通过 `vec_version()` 与最小 KNN 自检，结构化、BM25、vector top-k 用 RRF 融合，最终查询不把全量向量读入 JavaScript。Vec、Embedding、超时、模型/维度变化、reindex 或查询异常均回退 lexical-only；FTS5/BM25 建表或查询失败再回退 `documents` 上的有界 `LIKE` 并标记 degraded。错模型/维度在显式 reindex 前不参与混搜。旧 BLOB 向量仅在迁移校验时读取，vec0 校验成功后删除。

本机 owner 历史评测使用 Catalog 的严格只读模式复用同一检索实现：只打开 owner profile 与显式当前 workspace，不创建目录、不 chmod、不切 WAL、不备份、不迁移 schema/旧向量，也不写 vector metadata；vec0 自检只建立 TEMP 表。为避免 SQLite 只读连接仍创建或修改 WAL/SHM，评测以 realpath、主库 identity 和 WAL 状态包围每个 immutable snapshot 查询窗口；活动或变化中的 Catalog 返回 incomplete，不 checkpoint、复制或借其他 profile 掩盖。Session 只从 owner-trusted Memory provenance 定界并直接有界解析，不调用会修权限或隔离损坏文件的状态恢复 API。真实问题只驻内存，远程 embedding 禁用，输出仅含受控证据类型和聚合数字；无标签结果不参与正确率门禁。

`auto` retrieval 在没有专用 Embedding 配置时不创建 Provider，直接保持 lexical-only。只有显式 `MIMI_EMBEDDING_API_KEY` 才启用远程 OpenAI-compatible Provider，不复用对话 Provider Key。同步本地推理不得进入 CLI/Daemon 的自动 Context 召回热路径；即使调用方显式注入库级 Local Provider，无参数的自动搜索也必须跳过它并立即使用词法通道。这样 Memory 召回方式不会绕开主模型，也不会阻塞 IPC、取消和生命周期控制。

仓库仍保留 direct BGE q8 的显式库级实现及固定 revision/asset manifest，用于隔离实验，不是产品默认 Provider。2026-08-05 的离线 warm-query 微基准不能代表常驻 Daemon 的冷启动和资源争用；真实安装验收已证明同步 ONNX 可能长时间占用主循环。Local Provider 若未来重新进入产品运行时，必须先迁移到可终止的隔离执行边界并通过冷启动、并发、取消和 IPC 延迟验收。

自动检索最多处理 20 张候选/2400 tokens。普通新请求仍按当前意图检索相关 Memory，但不装配完整 L3；主动任务或长事务续跑/恢复时，L3 Assembler 才按默认 900-token 预算组成四类宽上下文，不再按固定卡片数截断。`source_receipts`、`suppressions` 和 `decision_events` 是不可随 reindex 删除的控制真相；页面、FTS、vec0 和 links 是可重建派生数据。`knowledge/sources/` 对 MemoryHub 只读。

Runtime 只暴露 `memory_search`、`memory_read`、`memory_links`、`remember`、`forget` 和 `memory_ingest`。Plan 模式及 SubAgent/Team 只有 workspace 读工具；private Wiki 与 episode 不下放。完整 round 作为 private episode 证据索引，只有 owner 明确历史访问时可检索；相关性查询要求非空 query，宽泛的最近历史请求使用 `memory_search(order=recent)`，只按时间返回有界 private episode，不把空相关性结果解释为 Memory 或 Session 不存在。`remember` 用结构化 `provenance=owner-explicit|autonomous` 决定来源与置信度，不扫描本轮 owner 文本。首次切换在修改旧状态前备份 Mimi SQLite/WAL/SHM、`memories.json`、`rag-index.json` 与旧 guidance；只有结构化 legacy Memory 记录会转换为 private Wiki，旧 `MIMI.md` 原文只备份而不按关键词挖取所谓“用户事实”，随后由纯 Soul 模板替换；转换、Lint 和控制账本验证完成后才写 cutover marker。新 Runtime 不再读取旧文件。

普通 Task 在终态事务中登记有 provenance 的 Memory observation，并保存 ≤8KB 的不可变 objective/result/error evidence snapshot；maintenance 后续不再联表读取可变 Task 正文。达到 10 条或最老等待 10 分钟后，统一 Task Scheduler 才发布 `priority: 0` 的 `memory_maintenance` Task。页面变化通过 compilation receipt 幂等计数，累计 50 页或有变化且 7 天未 lint 时，把 semantic lint 合并到下一 Task；成功终态才清零，dead-letter 保留计数。维护 Run 使用固定 profile Session，每批最多 20 条 observation，并把它们冻结为稳定的 `obs-N` 句柄；模型可见证据总量限制在 4KB，避免工具结果被上下文压缩后丢失写入句柄。每批最多 5 页 upsert，只可使用 Wiki 读工具及内部 receipt 工具，不可使用 Shell、文件、网络、MCP、Connector、Schedule 或委派。所有 observation 获得 applied/rejected receipt 后，Task 才能取得 batch completion receipt 并进入 completed；空跑会失败并保留 pending 数据。维护先形成 L1，只有互补 L1 足以支持可复用结论时才创建带 `derivedFrom` 的 inferred L2。单条 external/public observation 的 active 晋级由 Host 硬拒绝；Task dead-letter 时 observation 保持 pending，owner 可用 `/memory maintain` 重试或执行有界 semantic lint。

声明 `eventAcknowledgement:true` 的 stdio Connector 在 Host 持久化每条 Event 后接收 `event_ack`；cursor 轮询只有在整批 ACK 成功后才推进，失败或断线保留旧 cursor 并依靠 `source + externalId` 去重。未声明能力的旧 Connector 不会收到新协议消息。

## Plan 与 Goal

Plan 表示当前任务的步骤视图，Goal 表示跨多轮、跨重启的生命周期：

```text
Goal
├── objective
├── status: active | paused | completed | failed
├── acceptanceCriteria[]
├── completionEvidence
├── checkpoint
├── nextAction
└── PlanStep[]
```

两者按 Session 保存在同一个 `plans.json`。旧版本的纯 Plan 数组会在读取时自动迁移。`/resume` 只根据持久状态在同一 `MimiHost` 中发起下一轮输入，不建立第二套任务或工作流状态。

## Completion Contract 与终态门控

Completion Gate 只约束已经存在或本轮显式创建的持久 Goal。Goal 在调用首个任务工具前通过 `prepare_task` 建立 1～8 条可验证验收条件；普通问答、短操作和未启用 Goal 的任务由模型根据本轮目标与真实工具结果判断是否完成，不创建 Contract，也不调用 `finish_task`。自然语言中的“打开”“运行”“修复”等动词不能自动升级成 Goal。

`finish_task` 只提交候选终态。Host 会把引用的 tool call 与 ExecutionLedger 中的真实结果、调用参数、本轮结构化文件写入/编辑/移动、测试退出码，以及当前任务未完成的 Plan/Team 状态逐项核对；读取预存在文件或普通 Shell `exitCode=0` 不能冒充本轮产物。客观条件必须预先绑定工具和关键参数片段，复合任务必须覆盖产物与外部回执的证据并集。首份 Contract 建立后不可重写降级，长任务的完整 Contract 同时锁在 Goal 中，不会因为别的 Run 更新最近 checkpoint 而丢失。Plan 模式只返回只读方案，不建立无法满足的 artifact Gate。

未通过时，Host 保留 Goal、Contract、未满足项、真实 ExecutionLedger 证据和 checkpoint，并结束当前 Event；后续只能由 owner 使用 `/resume` 继续，不能回滚 Session 后从头自动重放整轮。外部动作只有结构化 `outcome=confirmed` 回执能满足完成条件；`accepted`、超时、断连或未知结果进入待人工核对的终态，禁止再次调用模型或自动重放。后台 `blocked` 还必须成功调用 `request_background_task_input`，由 Host 持久化后才成立。

同一 Run 中连续出现完全相同的副作用工具与参数时，ExecutionLedger 复用第一次成功结果并向模型返回 `already_executed`，避免截断、重复思考或模型重试造成重复发送/启动。只有在其间发生了另一个副作用、客观状态可能已改变时，相同调用才获得新的逻辑执行序号。

Agent、SubAgent 与 Team worker 默认不设置固定 turn 或工具调用次数上限。Run 由任务真实终态、显式取消/暂停、Daemon 空闲超时、租约失效、上下文预算或用户显式配置的 `MIMI_MAX_TURNS` 结束；重复外部动作由 ExecutionLedger 的 at-most-once 语义处理，不能用“重复若干次后中止”替代上下文、工具或模型适配问题的根因治理。

Completion Contract、报告和最近门控结果随 Run checkpoint 持久化，长任务 Contract 还随 Goal 持久化。Goal 只能由通过的 Completion Gate 标记完成，模型不能直接写入 completed；同一 Session 存在未完成 Goal 时，无关 Run 的 Plan/Goal/Team 修改会在工具授权层被拒绝，而不只依赖提示词隐藏。

## 三种运行模式

模式是运行时能力契约，而不是只有提示词差异：

| 模式 | 目标 | 写文件 / Shell | SubAgent | Team |
|---|---|---:|---|---:|
| General | 最短可靠路径完成大多数任务 | 按部署权限 | researcher、reviewer | — |
| Plan | 调查、讨论并形成获批方案 | — | researcher、architect、reviewer，全部只读 | — |
| Ultra Team | 大型代码、可并行或长程任务 | 按部署权限；worker 默认无 Shell | 单个只读委派 + Team workers | ✓ |

`toolsForMode` 在创建主 Agent 时过滤 Function Tools。Plan 不连接 MCP Server Tools，只保留显式的只读 MCP Resource wrappers，因此提示词失效也无法调用内置写文件、Shell 或未知 MCP 动作。Plan 中的 `switch_mode` 只改变下一轮模式；当前 Runner 的工具集合不会中途扩大。

Ultra 仍是一个主 Runner 和单一 Session。主 Agent 是 lead，负责目标、拆分、波次调度、整合和最终回答；worker 不共享对话历史，也不递归委派。

## 前台委派与后台任务

三种看似相近的并行机制解决不同问题：

| 机制 | 何时使用 | 是否阻塞当前对话 | 隔离边界 | 最终结果 |
|---|---|---:|---|---|
| SubAgent | 当前 Run 内的一次有界研究或审查 | 是 | 独立 Runner，上下文受限 | 返回主 Agent 当轮整合 |
| Ultra Team | 当前大型 Run 内可并行的明确子任务 | 是 | 最多 4 个 worker Runner | lead 当轮整合 |
| Background Task | 长程、多阶段、持续等待，或用户不需要立即看到结果 | 否 | 持久 Event + 独立 Task Session + OS 子进程 | Outbox 主动通知 |

主 Agent 应先判断交互预期：简单问答、短操作和用户明确等待当前结果的工作留在 Conversation actor；其余调用 `delegate_background_task`，收到 `taskId` 后立即结束当前委派动作，不轮询、不在前台重复执行。委派参数包含可独立执行的 objective、可选 success criteria/必要上下文、single/team strategy、priority，以及仅在用户明确指定时使用的精确 `modelTarget { providerId, modelId }`。Mimi Task 省略 target 时服从 `background.default` 场景路由；显式 target 作为严格 WorkUnit 路由优先于场景配置，并在未注册、无凭据或能力不兼容时失败关闭。Codex Task 不接受 Mimi modelTarget。写入使用来源 Event 的 ExecutionLedger 与稳定语义键，模型重试不会重复创建同一任务。

Task worker 的外部事务权限由仍存在的 conversation root 确定，而不是由 Task payload 自报。只有 owner-root write Task 可通过 Kernel Broker 执行 `connector_action`；非 owner-root Task 的工具目录会同步隐藏该 action，避免模型调用一个确定会失败的能力。Task 的完成、失败和阻塞通知不依赖该 action，始终由 Kernel Outbox 按原 reply route 可靠投递。

每个后台任务使用 `mimi-task-<uuid>` Session，并记录来源 Session、父/根 Event 与 delegation depth，用于授权重算、历史迁移和引用保护。Task lane 不再创建持久子 Task；需要拆分时，write Task 在当前进程内使用有界 Ultra Team，read Task 只使用只读 SubAgent，从而避免无界进程树。任务生命周期继续使用 Event 状态机：

```text
queued → running → completed / failed / dead_letter / cancelled
   ├────────────→ paused  ── resume ──→ queued
   └─ needs input/dependency/external state → blocked ─ resume + context → queued
```

Task Lead 只有确实缺少无法自行取得的必要信息时才调用 `request_background_task_input`；Store 原子写入 `blocked` 与通知 Outbox，worker 随后退出而不占用进程槽。`/tasks [limit]` 列出近期状态，`/task <id>` 查看目标、结果和错误，`/task pause <id>` 在安全边界暂停，`/task resume <id> [context]` 复用原 Task Session 继续，`/task cancel <id> [reason]` 取消 queued/running/paused/blocked 任务。任务权威状态来自 SQLite Event，不依赖发起 CLI 是否仍然在线。

失败边界持久化稳定 `failure.code` 与 `RunFailureDisposition`；自然语言 `error` 只用于说明，
不参与重试或运维分类。确定性验证、配置、状态和实现错误进入 `failed`；明确 transient
只在耗尽重试后进入 `dead_letter`，已经开始副作用且结果 uncertain 的失败直接进入
`dead_letter` 等待人工核对。`cancelled` 只表示 Owner 或系统显式终止。v16 历史终态保留
原错误与 Event，并以 `historical.*` 事实回填为 `legacy_failure`，不会根据旧错误文案猜测根因。

## Agent Skills

SkillLoader 实现开放 Agent Skills 格式的最小完整客户端流程：

- registry 按 `configured → project-native → project-shared → user-native → user-shared → builtin` 扫描固定根的直接子目录。`configured` 是显式 `MIMI_SKILLS_DIR`；project 分别是 `skills` 与 `.agents/skills`，user 分别是 `~/.mimi-agent/skills` 与 `~/.agents/skills`。builtin 从 MimiAgent 模块位置解析，且只接纳自身 `skills/manifest.json` 中 `published: true` 的条目。
- 来源按优先级、目录按名称确定排序。canonical 文件去重；无效高优先级候选不遮蔽 fallback，有效同名候选只注册 winner 并产生包含双方 source/path 的 shadowed diagnostic。有效注册量限制 200 个、正文总量限制 10MB，达到边界必须诊断。
- YAML Parser 和 Schema 校验 `name`、`description`。初始目录只披露当前 Run 可用 Skill 的名称、描述、胜出来源与绝对位置；owner 还可在原始输入开头用一个或多个 `$skill-name` 显式激活。解析发生在统一 `MimiAgent.stream()` Run 边界，外部/非 owner 输入保持惰性数据。
- `FileSession.activeSkills` 保存名称、source、canonical 文件、SHA-256 与时间。相同绑定幂等，同名换源或正文变化必须重新激活；reload 只重建 registry。模型首次 `use_skill` 获得完整正文并写入绑定，重复调用返回 `already_active`；`/skills active` 与 `/skills deactivate` 管理当前 Session。
- 每轮把当前仍可用且未 stale 的绑定重新解析为完整 `active-skills` host instruction section。`soul`、`base-instructions`、`behavior-preferences`、`runtime-context` 与 `active-skills` 是按此顺序装配的 required section，不经过 ContextManager token 截断；超出 instruction budget 时请求明确失败。Transcript、archive、collapse 与 full compact 不保存或删除这些每轮派生正文。
- Skill 可用 MimiAgent 扩展字段 `required-tools` 声明不可缺少的 Function Tool。catalog、`$skill`、`use_skill`、恢复注入、`list_skills` 与 `read_skill_resource` 共用 availability evaluator，以本轮最终工具名、`canReadLocal`、绑定和指令预算 fail closed。`allowed-tools` 不参与授权，也不能扩大 ToolPolicy。

资源读取要求当前 Session 存在同一份 active binding，且本轮仍 available；随后拒绝绝对路径、目录逃逸和 symlink 逃逸，单个文本资源限制为 256KB。无效 Skill 进入 diagnostics，不影响其他 Skill；`/skills reload` 可热重载 registry。

项目与用户范围的 Skill enable/disable 状态分别保存在工作区数据根和 `~/.mimi-agent` 的原子 `0600` JSON 中。项目级停用优先于用户级；状态进入统一 availability evaluator，因此 catalog、显式 `$skill`、Session 恢复和资源读取不会出现不同步。

## MCP

MCPManager 复用 Agents SDK 的 `MCPServerStdio` 与 `MCPServerStreamableHttp`，不实现自有 JSON-RPC Client。配置兼容 `servers` 和 `mcpServers`，支持：

- stdio：`command`、`args`、`cwd`、`env`
- Streamable HTTP：`type: http`、`url`、`headers`
- `${ENV_NAME}` 环境变量替换
- 并行连接、单 Server 失败隔离、工具计数、状态与 reload
- MCP Resources 的列出和读取
- MCP Prompts 的列出和带显式参数获取；Prompt 返回值作为不可信上下文并限制为 256KB

只有成功连接的 Server 才会进入候选工具集。Host 先列出 MCP Tools，保留 server-prefixed 精确名称和参数 schema，在当前 Run 的 Security/Policy 与 ExecutionLedger 包装完成后把它们纳入统一 capability catalog；首轮 Agent 只看到发现/调用 gateway，不再携带原生 `mcpServers` 让 SDK 隐式展开全部 schema。精确发现后由 gateway 调用已包装工具，因此隐藏只影响披露，不能撤销授权或绕过 at-most-once。工作区 `mcp.json` 需要 `MIMI_TRUST_WORKSPACE_MCP` 与工作区真实路径匹配；完成这一次配置授权后，owner 可在 `workspace/read-only` 使用其 Server Tools，不再叠加 `trusted`。只读 SubAgent 不继承 MCP，Plan 仅保留受控 Resource wrappers，external/public 事件禁用 MCP。Daemon executionKey 会在 MCP transport 调用边界复用 ExecutionLedger，因此成功结果可重放、失败或结果不确定的外部事务不会自动再次执行。远程认证保持在环境变量中，不应写入 `mcp.json`。

## 文件输入、诊断与撤销

终端输入支持 `@image:相对路径`、`@file:相对路径`，含空格时可使用引号。附件必须位于当前工作区且是不跟随符号链接的普通文件，最多 8 个、单个 10MB、合计 20MB；Daemon 以 SHA-256 内容快照保存为 `0600`，模型读取前再次校验摘要。图片作为 `input_image`，其余文件作为 `input_file` 进入原 Session，不把二进制写入事件数据库。

`write_file`、`edit_file`、`apply_patch` 和 `move_file` 完成后自动返回写后诊断：JSON 立即解析，TypeScript/JavaScript 工作区在存在本地 `tsc` 与 `tsconfig.json` 时执行有界 `tsc --noEmit`。同一批文件修改还会记录运行级前后快照；`/undo` 列出可撤销 Run，`/undo <run-id>` 只预览，`/undo <run-id> --apply` 才执行恢复。撤销前会核对每个文件仍等于该 Run 的写后摘要，检测到后续人工或其他 Run 修改时拒绝覆盖；单文件快照上限 5MB、单 Run 合计 20MB，超限修改会在写入前失败关闭。

## Runtime HTTP/SSE

可选的 Runtime HTTP 适配器只监听 loopback，并要求至少 32 字节的 Bearer Token。它提供 `POST /v1/sessions`、`POST /v1/sessions/:id/messages`、`GET /v1/tasks/:id`、`POST /v1/tasks/:id/cancel` 和 `GET /v1/tasks/:id/events`；最后一个接口使用 SSE，并支持 `Last-Event-ID`/`after` 续读。HTTP 层不执行模型、不维护第二份历史，也不绕过 Attention、Task lease、Session FIFO、取消或 Execution Ledger。

## SubAgent

SubAgent 使用 Agents SDK `Agent.asTool()`，而不是 Handoff：

- `delegate_research`：只读文件、知识库和网络；不继承 MCP，避免外部写工具绕过边界。
- `delegate_review`：只读文件和知识库。
- `delegate_architecture`：只读分析边界、取舍和验证方案，仅在 Plan 与 Ultra 提供。
- 子 Agent 不包含委派工具，最大深度固定为 1。
- 主 Agent 继续控制会话、Goal、写操作和最终回答。

SubAgent 不设固定 turn 数，由父 Run 的 AbortSignal、上下文窗口和任务终态
控制；结果封装为 `WorkUnitResult`。这提供了上下文隔离与专业化，又不需要
Agent 图、外部队列或调度服务。

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

SubAgent、Team worker、durable Background Task 和 detached Codex Task 保持各自
调度器，但都投影为 `WorkUnitDescriptor/WorkUnitResult`。统一结果包含 status、
summary、artifacts、evidence 和时间边界；Trace、终端进度与 Completion Gate
消费该契约，不以统一观测为由放宽单层递归、builder path、Task authority 或
Codex 单 Attempt 边界。

## Runtime Control

`runtime/control.ts` 把 CLI 中有实际运行时语义的操作暴露为 Function Tools。只读查询直接复用 `MimiAgent` 方法；模型、模式、Session、输出等级、MCP 和退出等所有变更型 RuntimeAction 都先进入内存队列，等 SDK 完成当前 Session 写入与 `run_end` Hook 后再应用，并把 Effect 交给 CLI 刷新界面。这样 Agent 能代替用户操作，又不会在 Tool Call 尚未闭合时替换模型、能力边界、持久化目标或当前 MCP 连接。

模型控制使用一个结构化 `model_control` 工具执行 list、inspect、current、use、
auto、routes、route 与 doctor。写动作在工具内部要求 direct Owner；整个工具受
ExecutionLedger 保护，Session 选择从下一 Run 生效且不持久化全局活动 Provider、
不重启 Daemon。CLI 的 `/models` 与 `/model current/inspect/use/auto/routes/route/doctor`
通过认证本地 Socket 把同一结构化请求送入对应 Session actor 的 FIFO mutation lane，
不建立第二套选择逻辑，也不走 legacy 全局 Provider 切换或 Daemon 重启。合并 Function
Tool 动作避免把八个低频命令 schema 常驻到每次模型请求。`inspect` 直接投影
Provider endpoint、region、credential 环境变量名和是否已配置，但绝不返回
credential 原值，也不会发起 Provider 请求；实时健康检查只由 `doctor` 执行。
模型无需也不得为排查 Provider 配置读取私有 `models.json` 或枚举环境。
`switch_model`/`switch_provider` 仅保留旧 RuntimeAction 读取兼容，不出现在新模型
工具面；Provider 注册使用 `mimi provider add/set/list/test`，自然语言不能改 registry。

主运行由 `RunScope → RunStateLoader → CapabilityResolver → ContextAssembler →
ToolSetBuilder → AgentRequestFactory → RunCommitCoordinator` 分阶段组装。Scope
在异步读取前冻结；各阶段只接收显式输入，模型请求的工具顺序、权限和 Context
Manifest 因而可以独立测试。Session、Goal/Plan、Team、ExecutionLedger、Trace
和 Run Commit Journal 通过 state ports 装配，组合根不再逐项拼接持久化路径。
`RunPipeline` 只拥有单次 Run 的 prepare/execute 与异常回收，
`RunCommitCoordinator` 独占完成、失败、receipt 恢复和 phase 推进；
`AgentRunService` 不再维护第二个提交 facade。Daemon `service.ts` 只装配生命周期、
初始化、LaunchAgent 与 RPC，`store.ts` 保留跨表 transaction，而已经有独立表和
lease/幂等不变量的 Activity、Outbox、Schedule、Run 与 Memory observation 由紧邻
adapter 持有。三个组合根的源码行数由回归测试锁定为 1800/1800/1900 上限。
`RuntimeComponents` 是模型 registry、Host 资源和 state ports 的唯一装配 owner；各阶段直接
消费这一个端口，不维护平行 Host interface 或 Ledger/Session/Model 镜像。ARC-303 另把所有
新拆出的 20 个生产文件（含共享 stream/XML 投影）锁定在 8505 行总预算内，禁止靠漏计新文件达标。

每个普通 Run 只由 Host 生成一份规范 `RunFinalization`：`outcome` 取
`completed / partial / blocked / interrupted / failed / uncertain`，并绑定答案摘要、
Tool Execution Manifest、Completion decision、原因、下一步和证据引用。判定只消费
SDK 终态、模型可见 Tool facts、Execution Ledger 与显式 Gate，不解析模型自然语言；
非 completed 结果由 Host 约束最终答案，不能被包装为整体完成。Plan 只保留为 UI
进度，Goal/Completion Contract 才是强完成语义。

完成提交写入 `run-commit-journal.json`，只保存 session/run/execution 标识、答案
SHA-256、Completion decision、RuntimeAction、规范 Finalization 和当前 phase，不保存
答案正文。Session、Task、Trace、Journal 与 Outbox 传播同一份 Finalization；旧记录
读取时补齐兼容默认值。Execution receipt 是恢复正文权威；receipt 一旦成功不会因
后续提交失败而删除。恢复按同一 execution key 的最新 attempt 收敛，不重放已经发出
且结果不确定的 Tool。Daemon 在 Task/Outbox 事务成功后确认 finalize。当前仍保留
FileSession 和 JSON stores，SQLite 收敛门槛及禁止双写决策见
[STATE_STORAGE_DECISION.md](STATE_STORAGE_DECISION.md)。

主 Agent 的认证本机 Owner 只由三档 Security 授权：`safe` 只读并移除 Shell、Computer Use、受信 MCP 和外部事务；`workstation` 允许工作区写入、结构化沙箱 Shell 和本机网络读取，但不允许 Connector 外部事务、Computer Use、受信 MCP 或通用网络写入；`full-owner` 使用当前 OS 用户的完整已配置能力且不叠加逐动作审批。旧 `read-only/workspace/trusted` 只做配置读取兼容，冲突时由 Security 覆盖。Plan 仍把最终工具面降为只读；Mode、来源和 Run scope 只能缩小 Security，不能扩大。

## MemoryHub

MemoryHub 统一 private/workspace semantic Wiki 与 workspace 文档来源，但不改写 Session/Event 原始证据。每轮捕获不可变 `profileId + workspaceRoot + sessionId + runId + cause`；私有 profile 使用独立三层 Vault 与 SQLite 控制面，workspace 页面只接受明确文件 provenance。主 Agent 可按未来价值调用 `remember`，本轮明确“不记住”时 Tool 拒绝；external/public Run 不能直接写 active Memory，单来源 inferred 默认保持 proposed。`forget` 删除页面和派生索引并写无正文 suppression，reindex 不能清空控制账本。

L1/L2 页面共享 schema v2 与 revision 语义：L1 不从其他结论派生，L2 必须引用至少一个 L1/L2；`explain` 递归返回结论层级与 SourceRef，循环或缺失引用被有界处理。owner 纠正生成 Revision 并 supersede 旧结论；冲突、过期、来源删除和 forget 都保留可审计原因或 suppression。推断保持 inferred，不能升级成 owner-confirmed。普通 Conversation 只读召回；形成、去重与聚合继续由已有 `memory_maintenance` Task 异步完成，不增加调度器。

Wiki 页面使用严格 YAML frontmatter、稳定 `pageId + canonicalKey`、SourceRef、窄主题正文和单页 atomic rename。所有 remember/capture/maintenance 写入共用 Canonical Topic Resolver，按 targetRef、canonical ID、标题和 alias 查找现有主题；命中时更新并累计来源，不存在时才创建。模型不直接拼接页面 envelope，确定性 renderer 统一生成标题、当前结论、关系与来源。所有写入先持久化 `MemoryCandidate` 和 `CompilationJob(applying)`，再 atomic rename 页面，最后提交 `MemoryPageRevision`、current pointer 与 terminal `CompilationReceiptV2`；重复 digest 返回同一结果。进程在 rename 后退出时用 planned digest 恢复，冲突或部分写入标记 `uncertain`，不会猜测重放。

`WIKI.md` 的 YAML policy 控制 prefer-existing、SourceRef、canonicalKey、inferred-active、页面/来源上限和需要关系的页面类型；Markdown 正文给维护 Agent 定义 Ingest/Query/Lint 纪律，但不能扩大 scope、trust 或工具权限。确定性 Lint 可经 `lint-repair` Revision 修复 envelope、canonicalKey 和 inferred-active；语义维护使用有界 merge、supersede、link、move 与 refresh 工具形成 receipt 闭环。查询只读，不在热路径偷偷刷新 stale 来源；`/memory refresh` 显式重编译并保留旧 revision。查询优先返回 private/workspace Wiki，只有 Wiki 不足时才补充 Session episode/raw evidence；SQLite FTS5/BM25 为默认词法基线，显式专用 Key 的远程 Embedding vector 可通过 RRF 合并，任一 Provider/Vec 故障都不能阻塞词法通道。

自动探测的 `.mimi-agent`、旧 `.nano-agent` 与默认 Daemon 数据根必须是实体目录，符号链接会在启动时失败关闭。Full Owner 的直接本机 CLI 或认证 Runtime HTTP Conversation 可通过文件工具和 Shell 使用当前 OS 用户权限访问这些根与显式运行数据目录；授权在每次 Tool 调用时从冻结的 Run scope 判定。Safe、Workstation、后台/Team worker、Schedule 和外部来源仍拒绝这些路径，包括符号链接解析后的别名。Workstation Shell 固定进入结构化进程沙箱；Safe 和 Plan 没有 Shell。外部事件只能在来源 Scope 与当前 Security 都允许时获得 Shell。

## Hooks 与 Trace

HookBus 当前暴露 `run_start`、`run_end`、`run_error`、`subagent_event`、`team_worker_event` 和统一的 `work_unit_event`。默认订阅器写入本地 JSONL Trace。它是普通进程内事件总线，可用于后续统计、Guardrail 或自定义可观测性，不承担工作流编排。

## 扩展决策

- 新增高频原子动作：Tool。
- 新增可复用任务工作流：Agent Skill。
- 接入外部系统、私有数据或远程能力：MCP。
- 需要隔离上下文的独立研究/审查：单层 SubAgent。
- 需要有限并行的大型任务：Ultra Team task list + worker wave。
- 无需当前对话等待的长任务：durable Background Task + OS worker + Outbox。
- 需要跨重启继续：Goal + Checkpoint。
- 需要长期监听和主动通知：Daemon Event + Schedule + Outbox。

不要在运行内核加入渠道 SDK、分布式队列、通用工作流 DSL、任意深度 Agent 树或企业向量数据库；这些应作为 Connector 或外围集成存在。

## M0 可信地基

M0 在既有状态所有者上补齐四个横切契约，不建立第二套队列、授权或监控系统。

### 敏感数据治理

`core/data-sanitizer.ts` 是写入前和展示前的统一净化边界。Task objective/result/error、
WorkUnit objective/summary/artifact/error、Trace data、Memory evidence/Wiki，以及 Daemon
management summary、Run 和 Schedule prompt 都在各自权威 Store 或投影边界调用同一实现。扫描结果只保留类别、
SHA-256 指纹和逻辑 surface，不返回命中原文。
凭证、授权头和私钥在所有 surface 始终净化；只有 `private/owner` Memory Wiki 可保留
owner 明确要求记住的必要邮箱或电话。Task、WorkUnit、Trace、management、Memory evidence
及非 owner Wiki 仍会净化联系方式，历史扫描与迁移使用同一 surface 规则。

直接 Owner 的敏感输入采用单一短生命周期链路：

```text
captureSensitiveText
→ EphemeralSecretBroker(Event + Session + provenance + TTL)
→ Dispatcher 首次 Conversation claim
→ MimiRunOptions.ephemeralOwnerInput（仅进程内）
→ RunScope + Full Owner 激活
→ Provider 临时宿主上下文 + 主 Agent Shell 环境
→ Session/Trace/Tool/Ledger/Answer 精确脱敏
→ complete | cancel | failure 时销毁
```

`MimiRunOptions` 中的 lease 在 RunScope 校验后立即从保留 options 移除，原值只存在于
active Run 的 owner/run/session 绑定对象；Session port 只获得精确脱敏代理。Run replay、
Daemon restart 和 Task retry 都只能看到持久指纹，不能恢复原值。

历史处置由 `daemon/data-governance.ts` 完成：

```text
dry-run（只读、无原值）
→ verifyMimiBackup（清单摘要 + SQLite integrity）
→ 确认 Daemon socket 不存在
→ SQLite BEGIN IMMEDIATE + 原子文件替换
→ 全目标面复扫为 0
```

备份保留原始数据并提供既有 restore 通道；apply 不删除备份、不修复无关损坏，也不读取
Connector 凭证配置。retention/export/delete 继续由原有 History prune、backup/diagnostic
export 和 owner 管理入口承担，所有展示仍经过净化边界。

### Effective Capability

`EffectiveCapabilitySnapshot` schema v1 由最终 `ToolSetBuilder` 生成，记录本轮实际 Tool、
通过共同 availability evaluator 的 Skill、Run 开始时 Connector/Computer 的实际投影、
permission source、稳定 capabilities、routeOwner，以及统一的
`availability/readiness/freshness/coverage` 术语。`toolSetDigest` 和
`snapshotDigest` 对排序后的实际集合计算；Run runtime info、Daemon status 和 Doctor/
diagnostic bundle 传递同一个最后实跑摘要。旧 Daemon status 没有该可选字段时按 unknown
兼容，不把“未报告”解释为 ready。

### Effect Ledger 与副作用

Security 在 dispatch 前完成唯一授权，Ledger 不再审批动作。`ExecutionLedger` 继续读取
历史 ActionIntent schema v2，但新动作只用业务引用、action family、target、payload
digest 和 policy revision 建立 at-most-once fence。同一业务引用跨 Tool/Provider/route
只执行一次，不同 Event 即使目标和载荷相同也分别执行。

- `confirmed` 跨 Tool、Provider、Connector/Computer route 只返回既有回执。
- `started/uncertain` 永久禁止自动换路重放。
- 只有 `failed_safe` 可以在新 route 重新尝试。
- Connector `write/unknown` 的业务操作引用由 Host 根据不可变 Run 与 Tool Call 身份
  自动建立，模型接口不再暴露 `operationRef`。相同 Host 调用已 confirmed 时复用原
  回执，started/uncertain 时由 Ledger 与运行时 fence 阻止自动重试；只有 failed-safe
  才能重新执行。
- Full Owner 的精确目标动作不再要求第二次一次性审批；Observation 新鲜度、窗口漂移、
  控制面保护、应用 allowlist、动作预算和前后台状态仍由 ComputerManager 在真正执行前
  自动校验。`computer_observe/computer_act` 不向模型暴露 Observation 或授权句柄，
  Manager 自动绑定本轮最新的有效窗口观察。
- personal message 的 `contextToken` 只授权实际 send Tool，读取上下文不误占 Intent；
  它与 Computer 写动作都在原 Tool ledger 外层进入同一 Intent fence；传统
  call receipt 仍保留为 Completion evidence。

通用 Connector action 成功后也把 `execution:*` 回执附加到返回值；只有结果内明确
`outcome=confirmed` 的同 Session 回执可以证明普通 Plan 的外部事务完成。Plan 的
completed 是受约束终态：内部步骤必须提供 evidence refs，外部步骤必须提供通过
ExecutionLedger 验证的 receipt refs；completed step 不能由后续模型静默删除、重开或
替换证据。后台委派同样要求显式 `requiredCapabilities`，Host 在入队前与 executor、
workspaceAccess 和实时 Connector capability 取交集；后台 Computer 固定为 none，
委派不能成为能力升级路径。

Browser 的导航、元素操作和页面脚本是交互层动作：成功回执额外声明
`completionScope=interaction` 与 `businessOutcome=unverified`，不能单独证明网页中的
配置或事务完成。`execute_javascript` 与结构化写动作一样必须消费新鲜 Observation，
且只接受最新 snapshot；所有写动作之后都必须重新观察。外部系统变更在提交前绑定系统、
环境/账号、稳定业务对象和期望旧值/新值，提交后回读同一对象才能晋级为业务完成；
Completion Gate 也拒绝把 interaction-only ActionIntent 回执当作外部事务完成证据。

Tool 或 ActionIntent 已成功执行但结果超过账本上限时，`ExecutionLedger` 不再把动作误记
为失败。它丢弃超限正文并原子提交一个包含 `output_truncated`、原始字节数和 SHA-256 的
有界成功回执；首次返回与崩溃后重放完全一致，且不保存原文。若配置的上限连该安全回执
都容纳不了，则仍失败关闭并永久保留 started/failed fence，不会重放副作用。

### Provider 与资源 SLO

Provider 429、余额、网络和 5xx 使用确定性分类和每个精确模型目标
`providerId/modelId` 的熔断状态，避免同一网关下一个模型的独立限额连带封禁其他模型。
429/余额立即 open；普通瞬时失败达到阈值后 open；恢复只允许一个 half-open probe。主备协调器最多
接受一个 primary 和一个 backup，每个 route 一轮最多尝试一次。`AgentRunService` 只在
SDK streaming handle 尚未形成时允许走 backup；handle 一旦形成，即使尚未看到 Tool
事件也不再切换；只有 stream 正常迭代结束、`completed` 完成且终态校验通过后才记录
Provider success。handle 后的 429、余额、网络或 5xx 会记录该 route failure，并且不切备，
因此任何副作用开始后更不可能重放整轮。当前 AppConfig 未增加新的
公开配置字段；可选 `MIMI_BACKUP_PROVIDER=openai|deepseek` 与
`MIMI_BACKUP_MODEL` 由 runtime 组合根解析，backup 必须不同于 primary 且具备自己的
Provider Key。主 Daemon、每个 Session actor 和 isolated worker 都显式构造同一主备
RunService；worker route/credential 经过严格 IPC schema，credential 不进入基础环境、
Shell 或 MCP。status、Doctor 和 diagnostic bundle 同时报告两条 route health。

Daemon activity 复用 SQLite Task/Run 数据，按日聚合 Run 与 Token，并按稳定
`owner_conversation | connector | health | briefing | maintenance | routine | eval | unknown`
来源分类报告近 24 小时用量；分类只读取 Task type 和不可变 Event source/trust，不解析
prompt 或自然语言结果。unknown 不会静默归零，而是进入 Doctor 风险。

Attention 的 Run/Token 预算只计算自治来源，并把 queued/running Task 作为 Run 预留，避免
并发入口超卖。超过小时、每日或单来源预算后，Connector 事件合并进 Digest，Routine 和
定时 Briefing 在创建 Event/Task 前延后；Owner 直接请求、Owner 手动 Briefing、紧急事件、
已经 dispatch 的事务收尾和 eval 不受机械丢弃。同一来源从耗尽到恢复只产生一次结构化
状态通知。历史 Run 缺少完整 Token 事实时自治入口失败关闭并报告
`token_usage_unavailable`，不会把未知成本冒充为 0。状态复用现有 Attention state/audit，
没有新增常驻服务、状态机或持久系统。

费用只有 Provider
实际返回样本时才显示数值，否则为 `null` 且 sampling=`unknown`，不会伪装为 0。
CPU/内存/磁盘尚无持久样本时同样返回 `null` 和 host sampling=`not_sampled`；实时 Host
摘要不冒充跨重启趋势。只对已知/已采样指标产生预算告警；Provider health、资源趋势、
dead letter/Digest/readiness 分类进入
status、Doctor 和脱敏 diagnostic bundle。dead letter 分类只读取持久化的结构化 failure
事实，不解析自然语言 error；历史记录保留原事实并标为 `legacy_failure/manual_verify`，禁止
自动重放。所有记录只使用计划冻结的 `archive/retry_after_fix/blocked/manual_verify` 处置投影；
缺失结构化 failure 的异常行保持 `unknown/manual_verify` 并继续阻断 Doctor readiness。

### M1 Jarvis Eval

M1 eval 使用 `evals/m1/manifest.v2.json` 固定 dataset、policy、tool snapshot revision
和 `fixture | readiness | live_action | soak` 证据层级，并由 `src/runtime/m1-eval.ts`
同时验证 manifest 与 run record。每条 record 都保留 App/渠道、动作族、执行路径、
风险、Provider、requested/eligible/executed/outcome、首次/重试/接管、S0-S3 和仅含
hash 或 `meta:` 的 evidence ref。旧 v1 因无法还原 provenance 而明确拒绝晋级；
run 文件通过排他锁和原子替换写入，冲突覆盖、损坏输入、重复 run/record/scenario、
跨 run uncertain retry 和伪造 evidence-kind 均 fail closed。

`npm run eval:m1` 会按 manifest 中的公共边界测试文件执行真实 deterministic suite，
然后按 evidence kind × App × action family × execution path 报告 requested coverage
与 eligible execution success；suite 失败不会被 expected blocked/failed 场景掩盖。
`npm run eval:m1:canary` 先读取 Doctor 的 Daemon status，并用 Event、Task、Outbox 和
host mutation 判断整机是否存在执行冲突；无关 Connector 的 readiness warning 不伪装成
“主机忙”，也不会阻断其他能力族。随后通过 control-auth Unix Socket 的固定
`probe.read` profile 执行最多 20 个 Browser、Shortcuts、Computer、Screen 只读动作。
Connector 由同一 ConnectorManager 独立复核 enabled/online/catalog/effect/route owner；
已明确 unavailable 的目标通道直接拒绝，未上报或已过期的 readiness 只能在该注册
`effect=read` 动作真实成功后建立或刷新 15 分钟租约，失败、write、unknown effect 和
route drift 都不能借 probe 晋级 ready。Computer 复用同一 ComputerManager、
CapabilityResolver 和 Tool policy，并执行 allowlist、控制面、frontmost 和前后目标漂移
检查。标签、URL、快捷指令名、OCR 正文和临时图像不会进入 IPC evidence；只有正式
Manager 返回动作结果的 `live_action` 才计入 100 次。readiness、direct worker、
blocked/skipped 和 uncertain 均不能晋级。该 canary 不是 24/72h soak。
默认输出使用不覆盖的时间戳文件名；`run-m1-eval.ts report <run...>` 只聚合同一 dataset
revision 的多次 run，因此分母可以持续累计而不会混入不同口径。
