# MimiAgent 多会话与后台任务运行时调研

日期：2026-07-16

状态：已完成，作为三层并发运行时设计依据

落地说明：调研阶段曾比较“每个活跃 Conversation 都 fork Worker”和 durable child task tree。最终实现选择更轻量的 keyed Session actor（进程内独立 Runtime、同 Session FIFO、跨 Session 并行），只为 detached Task fork OS 子进程；Task 内拆分使用一层 SubAgent / Ultra Team，不递归创建 durable Task。终态由 Kernel Outbox 原路通知，不再为整理通知额外唤醒一次模型。最终契约以 `docs/ARCHITECTURE.md` 为准。

## 调研问题

本轮聚焦四个问题：

1. 为什么当前两个 Session 不能同时对话？
2. 怎样让同一个 Mimi 拥有多个并发对话，而不破坏 Session、Tool Call 和副作用一致性？
3. 怎样把长程任务交给真正独立的后台子进程，并支持进度、暂停、取消、阻塞、恢复和完成通知？
4. 怎样在不引入工作流平台、外部 MQ 或另一套 Agent 身份的前提下完成改造？

## 结论摘要

用户感知是准确的：当前进程里虽然存在 Connector 子进程、SDK SubAgent 和 Ultra Team worker，但所有用户可见的主 Agent 执行仍被三层全局状态串行化：

- `src/runtime/mimi-host.ts` 只有一条全局 `lane`，所有 Session 的 `execute`、`mutate` 和 ledger finalize 都排在同一 Promise 链上；
- `src/runtime/mimi-agent.ts` 只有一个可变 current Session 和一个 `activeRun`，运行期间禁止切换 Session；
- `src/daemon/dispatcher.ts` 只有一个 `loopPromise`、一个 `activeEvent`、一组全局 Tool/取消/抢占状态，`processOnce()` 会等待整个 Event 完成才领取下一个 Event。

因此当前系统不是“操作系统层面只有一个进程”，而是“智能执行控制面只有一个全局串行槽”。第二个 CLI、第二个 Session、外部事件和后台任务最终都会争用同一个槽。

适合 MimiAgent 的最小改造不是把同一个可变 `MimiAgent` 设为可重入，而是采用 Session Actor + 有界 Worker Process：

- 同一 Session 始终只有一个 owner，按 FIFO 串行执行；
- 不同 Session 由不同 actor/worker 并发执行；
- Kernel Daemon 只负责可靠事件、路由、调度、监督和通知，空闲时不调用模型；
- 前台对话与后台任务使用隔离的 Worker 配额，长任务不能占满对话能力；
- 后台任务继续落在现有 Event/Run/Goal/Plan/Checkpoint 语义上，不增加第二套 Todo 或通用工作流 DSL；
- 子 Agent 只产出任务结果，最终面向用户的解释和通知仍回到 requester Session，由同一个 Mimi 完成。

## 当前项目证据

### 1. 全局 Host lane 是直接阻塞点

`MimiHost.execute()`、`mutate()` 和 `finalizeExecutionLedger()` 最终都调用同一个 `enqueue()`：

```text
operation -> this.lane.then(operation) -> replace this.lane
```

它正确保护了可变 Runtime，却把保护范围扩大到了所有 Session。Session A 的模型或 Tool 运行十分钟，Session B 的纯对话、Session 切换和管理操作都只能等待。

### 2. 不能只删除 lane

`MimiAgent` 当前把以下状态保存在单实例可变字段中：

- model、mode、output level；
- current `sessionId`、`FileSession`、Context、Plan、Team；
- 单个 `activeRun`、运行时事件、pending actions、execution ledger 上下文。

`stream()` 在 `activeRun` 存在时明确拒绝第二次运行，`switchSession()` 也拒绝在运行中切换。直接删除 Host lane 会让两个 Run 互相覆盖 Session、checkpoint、Tool ledger 和 RuntimeEffect，属于数据一致性错误，而不是并发优化。

### 3. Dispatcher 同样是单 worker

`MimiDispatcher.processOnce()` 领取一个 Event 后立即 `await processEvent(event)`。`activeEvent`、`activeTools`、`cancelRequested`、lease renewal、idle watchdog 和抢占 timer 都是单值字段；Daemon status 也只暴露一个 `activeEventId`。

即使 Runtime 能并发，当前 Dispatcher 仍会让所有事件单路执行。反过来，只扩 Dispatcher 而不拆 Runtime 也不安全。

### 4. 已有可靠性基础可以复用

项目已有的能力足以支撑轻量多进程，不需要引入新平台：

- SQLite WAL Inbox/Run/Outbox、短 `BEGIN IMMEDIATE` 事务、lease/retry/dead letter；
- `leases` 表和 fencing token；
- FileSession、AtomicJsonStore 的跨进程锁、原子替换与 schema 校验；
- execution ledger 对 Shell、文件、MCP、Connector 副作用的至多一次保护；
- Goal/Plan/Checkpoint 表达长程目标和恢复点；
- Unix Socket RPC、Connector NDJSON 隔离、Outbox 独立投递；
- `AgentRunService` 的统一开始、流式事件、成功、失败和 RuntimeEffect 终态。

缺少的是正确的并发所有权、任务投影和 Worker 监督，不是存储或工作流基础设施。

## 一手资料与可借鉴结论

### OpenAI Agents SDK：Session 是历史边界，不是全局 Runtime 锁

来源：

- [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
- [OpenAI Agents SDK Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)

官方文档把 Session 定义为持久对话记忆接口：Runner 在一次 Run 前读取指定 Session，完成后把本轮输入和输出写回。Agents as tools/handoffs 负责委派，Session 本身不要求所有会话共用一个可变 Agent 实例或全局队列。

对 MimiAgent 的启发：

- 一个 Mimi 身份可以服务多个 Session；
- 每个 Run 必须从开始就绑定不可变 `sessionId/runId/owner`；
- 同一 Session 要单写，多个不同 Session 可以并发；
- SDK SubAgent 适合单轮内部协作，不能替代可跨重启、可管理的后台任务。

### Orleans 与 Ray：并发边界应落在 actor，而不是共享可变对象

来源：

- [Microsoft Orleans Scheduling](https://learn.microsoft.com/en-us/dotnet/orleans/implementation/scheduler)
- [Microsoft Orleans Request Scheduling](https://learn.microsoft.com/en-us/dotnet/orleans/grains/request-scheduling)
- [Ray Actors](https://docs.ray.io/en/latest/ray-core/actors.html)
- [Ray Actor Concurrency Groups](https://docs.ray.io/en/latest/ray-core/actors/concurrency_group_api.html)

Orleans 默认让每个 grain activation 一次执行一个 turn；Ray 默认让同一 actor 的方法串行、不同 actor 并行。两者都把状态一致性边界放在“一个有身份的 actor”上，而不是让所有身份共享一个锁。Ray 还用独立 concurrency group 防止一种工作占满全部能力。

对 MimiAgent 的启发：

- `sessionId` 是天然 actor key；
- 同一 Session 的对话、mutation、checkpoint 和 Tool ledger 共用一条局部 lane；
- 不同 Session 进入不同 lane/worker；
- conversation 与 background task 分配独立并发预算，后台吞吐不能牺牲交互延迟；
- 不在同一 Session 内启用任意 reentrancy，避免 await 前后的状态被另一轮改写。

### Temporal：借鉴 durable queue/worker/child 语义，不引入 Temporal

来源：

- [Temporal Task Queues](https://docs.temporal.io/task-queue)
- [Temporal Workers](https://docs.temporal.io/workers)
- [Temporal Child Workflows](https://docs.temporal.io/child-workflows)

Temporal 的 Task Queue 由有空闲容量的 Worker 主动领取，任务在 Worker 崩溃后仍然保留；Child Workflow 有独立历史和 Worker，可选择等待或脱离父任务。但官方也建议：有界问题先从单个 Workflow 开始，不要只为代码组织引入 Child Workflow。

对 MimiAgent 的启发：

- 后台任务必须先持久化再调度，Worker 只是可替换执行者；
- requester、parent、child 和 run 是不同概念；
- 父对话不必等待 child 完成；
- 崩溃恢复依赖 lease、checkpoint 和幂等账本，不依赖某个常驻内存 Promise；
- 任务树必须有界，只有确实需要独立生命周期时才创建 child。

### OpenClaw：Task 是活动记录，不是 Session 或调度器

来源：

- [OpenClaw Background Tasks](https://docs.openclaw.ai/automation/tasks)
- [OpenClaw Background Exec and Process Tool](https://docs.openclaw.ai/gateway/background-process)
- [OpenClaw Session Management](https://docs.openclaw.ai/sessions)

OpenClaw 把普通交互对话、Session、Cron/Heartbeat 和 Background Task 分开：Task 记录 detached work，带 requester Session、child Session、run 和通知策略；它不取代 Session 或调度器。长 Shell 可以先进入后台，再查询或控制进程。

对 MimiAgent 的启发：

- 普通短对话不创建后台 Task；
- Schedule、明确 detached work 和子代理执行创建后台 Task；
- Task 关联 requester Session 与独立 child Session；
- 完成可触发 requester Session wake，由主 Mimi 组织最终通知；
- 任务记录只投影活动与生命周期，Goal/Plan/Checkpoint 仍保存语义进展。

### Node.js：子进程提供真实隔离，但必须有界和懒启动

来源：

- [Node.js `child_process`](https://nodejs.org/api/child_process.html)

`child_process.fork()` 会启动拥有独立 V8 和内存的 Node.js 进程，并自动建立 IPC channel；AbortSignal、进程事件和结构化消息可用于取消与监督。官方同时提醒，大量 Node 子进程有额外资源成本。

对 MimiAgent 的启发：

- Worker Process 使用 Node 内建 `fork()`，不新增进程框架；
- 活跃 Session/Task 才懒启动 Worker，空闲后释放；
- supervisor 设置 conversation/background 两个有界配额；
- Worker 不拥有 Unix Socket、Connector 凭证或全局调度，只执行被 fencing token 绑定的一次工作；
- 进程退出不是任务终态，权威状态始终在 SQLite/FileSession。

### SQLite：适合本机多进程控制面，但写事务必须短

来源：

- [SQLite Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [SQLite Transactions](https://www.sqlite.org/lang_transaction.html)

WAL 允许 reader 与 writer 并行，但同一时刻仍只有一个 writer；`BEGIN IMMEDIATE` 在其他写事务存在时可能返回 `SQLITE_BUSY`。

对 MimiAgent 的启发：

- 多个 Worker 可以共享本机 SQLite WAL；
- claim、lease renew、状态 CAS、Outbox commit 都保持短事务；
- 模型、Tool 和外部 I/O 绝不放在 SQLite 事务内；
- busy timeout、有限重试和 fencing token 是多进程正确性的必要部分；
- SQLite 文件只支持同一台机器，不把这一设计伪装成分布式集群。

## 适合 MimiAgent 的轻量三层模型

### 1. Kernel 层：可靠控制面，不是持续烧 Token 的“内心独白”

Kernel Daemon 常驻并拥有：Unix Socket、Connector、Attention、Schedule/Heartbeat、SQLite、WorkerSupervisor、Outbox 和系统通知。

无事件、无到期 Schedule、无 Worker 状态变化时只阻塞等待 timer/IPC/Connector，不调用模型。需要语义判断的事件被持久化为普通 Agent Event，再交给 conversation 或 task Worker；Kernel 本身不维护第二个聊天 Agent。

### 2. Conversation 层：一个活跃 Session 一个单写 actor

每个活跃 Session 绑定一个 session-scoped Mimi Runtime 和局部 FIFO lane。同一 Session 不并发写 transcript；不同 Session 可由不同 Worker Process 同时运行。Worker 只在活跃期间存在，空闲 Session 仍只是持久状态，不长期占一个进程。

### 3. Task 层：独立 child Session + durable Event + Worker Process

长程任务先写入 EventStore，再由 Task Worker 领取。任务拥有 task/event ID、requester Session、child Session、parent/root、通知策略、进度、Goal/Plan/Checkpoint 和 lease。它可以在安全点暂停、取消或阻塞并释放 Worker；恢复时由任意新 Worker 从持久状态继续。

任务完成后不直接冒充主 Mimi 回复用户，而是生成一个内部 `task.completed` wake Event，回到 requester Session 整理结果并按原渠道通知。

## 前台与后台如何判断

不为每条消息增加一次“分类模型调用”。采用两段式决策：

1. Host 的确定性规则先处理明确情况：Schedule/Watch/Routine、显式“后台执行/不用等/完成后告诉我”、已有 Goal 的周期续跑直接后台；明确“现在告诉我/我在等结果”和普通问答保持前台。
2. 其余情况由当前 conversation Agent 在正常一次推理中决定是否调用 `delegate_background_task`。调用后只返回已受理的 task ID、目标和通知方式，当前对话立即结束，用户可以继续输入。

这样既能理解语境，又不会让每句“你好”多烧一轮 Token。不得只按字数、模型猜测耗时或 Tool 数量强制后台化；涉及用户正在等待的短动作仍应前台完成。

## 并发与一致性原则

| 范围 | 并发策略 | 原因 |
| --- | --- | --- |
| 同一 Session | FIFO 串行、单 owner lease | transcript、checkpoint、RuntimeEffect 和 Tool 协议必须有确定顺序 |
| 不同 Session | 并发 | 状态隔离，可提升多窗口吞吐 |
| Conversation Worker | 独立保留配额 | 后台任务不能阻塞实时对话 |
| Background Task Worker | 有界并发 | 控制内存、Provider 限流和外部副作用压力 |
| Outbox delivery | 独立有界 lane | 模型运行不等待其他渠道投递 |
| 同一外部副作用 | execution ledger + fencing | 崩溃/重试不得静默重复 |

## 明确不照抄的部分

- 不引入 Temporal Server、Ray、Orleans、Redis、Kafka、ORM 或容器编排。
- 不复制 OpenClaw 的 Task Flow、远程 Node、多租户 Gateway 或插件平台规模。
- 不让每个历史 Session 永久占一个 OS 进程；只为活跃运行懒启动并在空闲后回收。
- 不让同一 Session 的两个模型 Run 交错写 transcript，也不靠“可重入”规避队列。
- 不创建第二份聊天历史、第二套 Goal/Todo/Workflow 数据库；Event 是执行控制面，FileSession 是 transcript，Goal/Plan/Checkpoint 是长任务语义。
- 不让 Worker 直接持有 Connector 凭证或监听入口；外部 action 经 Kernel 的窄 RPC bridge。
- 不允许任意递归 spawn。durable task tree 默认最多两级，父子关系、路径和并发预算都由 Kernel 校验。
- 不把“多进程”理解为无限进程；进程数、模型并发、Shell 并发和内存都必须可配置且有安全默认值。
- 不在空闲 heartbeat 中调用大模型；只有真实事件、到期计划或任务状态变化才唤醒推理。

## 最终判断

当前架构无需推倒重写，但旧设计中“唯一 Host = 全局串行 Runtime”这一判断必须修正为“唯一 Kernel = 多个 Session 单写 actor 的监督者”。

Mimi 仍然只有一个身份、一个 Kernel、一个 Memory 和一套能力；并发来自多个受监督的 Session/Task Worker，而不是复制多个互不认识的 Agent。第一原则是缩小串行边界：从整个 Mimi 缩小到单个 Session；第二原则是把长任务的生命周期从 CLI Promise 移到 durable Event/Run/Goal/Checkpoint；第三原则是所有完成结果回到 requester Session，由主 Mimi 统一面向用户。
