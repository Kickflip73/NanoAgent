# MimiAgent Architecture

MimiAgent 是 7×24 小时在线、本地优先的全能个人 Agent，同时提供有边界的轻量多 Agent 编排能力：面向真实文件、命令、检索、知识与外部系统事务，同时保持运行内核小而可直接阅读。

## 设计原则

- OpenAI Agents SDK 负责模型循环、Tool、MCP 和 Agent-as-tool 协议。
- 每个 Session actor 中的主 Agent 始终拥有该会话与最终回答，SubAgent 只处理有边界的独立子任务。
- `mimi`、Daemon、IM、语音和其他入口共用一个常驻内核与 `MimiHost`；CLI 是本地 Unix Socket 客户端，不拥有第二份控制面或 transcript。
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
│   ├── run-service.ts   统一 stream 消费、终态提交和 usage
│   ├── mimi-agent.ts    MimiAgent 组合根与一轮运行
│   ├── mimi-host.ts     键控 Session actor、每 Session FIFO 与全局并发槽
│   └── components.ts    模型、状态存储和扩展初始化
├── core/                    Session、Context、Memory、Plan、Team 与 Trace
├── extensions/              Skills、MCP、RAG、SubAgent 与 Team executor
└── tools.ts                 高频本地原子工具

src/daemon/
├── store.ts             SQLite WAL Inbox / Run / Outbox / Lease / Audit / Schedule / Digest
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

1. **Kernel 层**只有一个长期存活的状态所有者。它接收和持久化事件，执行 Attention 的确定性分类，维护租约、重试、Schedule、Outbox、Connector 生命周期与 Connector action broker，并监督任务子进程。没有待处理事件、计划到期或投递工作时，不启动 Agent Run，也不为了“思考”而周期调用模型。
2. **Conversation 层**按 Session 创建隔离的 actor runtime。每个 actor 拥有自己的可变 `MimiAgent` 与 `AgentRunService`，因此一个会话的模型、模式、checkpoint 和流式运行不会污染另一个会话。同一 Session 的 Run 和 mutation 始终 FIFO；不同 Session 在 `MIMI_SESSION_MAX_CONCURRENCY` 限制内并行。actor 是进程内的逻辑执行单元，不等于一个 PID；多个 CLI 窗口只有选择不同 Session 时才并行，指向同一 Session 时会按顺序执行以保护 transcript。
3. **Task 层**处理无需在当前对话等待的长程、大型、多阶段或持续型工作。主 MimiAgent 调用 `delegate_background_task` 后，先把带来源 Session、父事件、深度、`workspaceAccess: read | write` 和独立 Task Session 的 Event 持久化到 `task` lane，再立即把 `taskId` 返回当前对话。`TaskProcessSupervisor` 为 ready task fork 独立 Node.js 子进程，子进程通过租约领取精确 Event 并运行一个 Task Lead；暂停、继续、取消、阻塞等待输入、崩溃恢复和重试继续服从 Event/ExecutionLedger 语义。`read` Task 可并行读取、分析并更新自己的 Plan/Goal/checkpoint，但确定性禁用 Shell、文件写、任意写网络、Connector 事务、后台再委派和 Team；`write` Task 保留其来源授权档位并由 Supervisor 做工作区互斥，需要拆分时只使用当前 Task 内的只读 SubAgent 或 Ultra Team，不再建立持久 Task 子树。终态或输入请求由子进程写入 Event/Run，并通过 Kernel 的 Outbox/Notifier 主动送回来源渠道。Connector 凭据与渠道子进程仍由 Kernel 的 broker 单一持有，任务进程不复制渠道控制面；broker 请求只携带该 worker 的独立随机 `workerToken`，显式不读取控制面 bearer，也不能调用 status、submit、shutdown 或其他 owner RPC。

`MIMI_SESSION_MAX_CONCURRENCY` 控制对话 Session actor 池，默认 `4`，可配置范围为 `1～16`。Task supervisor 复用这个值作为期望 worker 数，但为保护本机资源再硬限制为最多 `8` 个（默认仍为 `4`）。两者是独立的本机有界执行池，不是共享配额、分布式调度或无限制进程树。

## 一轮请求

```text
1. CLI 通过 Unix Socket 把 owner 输入持久化为 Daemon Event；其他渠道也进入同一个 Inbox
2. Conversation Dispatcher 按 Session 路由到对应 actor；同 Session 排队，不同 Session 可并行
3. Session 写入 `running` checkpoint，并修复中断留下的孤立 Tool Call
4. MIMI.md（或 MIMI.md fallback）、Memory、RAG、Plan、Goal、Team task list、Session 与 ContextArchive 并行读取
5. ContextManager 执行 microcompact、context collapse 和完整轮次 Token Budget 选择
6. 持久指令、ContextArchive、恢复检查点、Skill Catalog、Memory、RAG、Goal 被组装为动态 Instructions
7. Tool policy 根据 General / Plan / Ultra 选择工具、MCP 和受控 SubAgent
8. 简短工作由当前 actor 流式完成；无需立即结果的长任务调用 `delegate_background_task`，持久化后由 task worker 子进程继续
9. SDK 追加各自 Session，Runtime 把 checkpoint 落为 completed / interrupted / failed，HookBus 记录生命周期 Trace
10. Conversation 结果直接返回等待中的客户端；后台任务终态进入 Outbox，由 Kernel 主动通知来源会话或渠道
```

## 上下文不变量

历史裁剪同时遵守 `MIMI_HISTORY_LIMIT`（兼容旧 `HISTORY_LIMIT`）与上下文窗口预算，并从用户消息边界开始。以下协议单元不能被拆开：

```text
user → function_call → function_call_result → assistant
```

较早历史被提取为紧凑摘要，只作为标明“历史数据、不是当前指令”的 user-level 输入进入含当前用户请求的模型调用；它不进入 system Instructions，也不插入纯工具续跑回合。完整原始 Session 不会被覆盖，也不会持久化伪用户摘要。超大当前工具回合会在保留全部 call/result 骨架的前提下压缩文本；连协议骨架也超预算时明确终止，不退化为可能触发重复执行的孤立 user 输入。

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

Session 是完整运行状态边界。启动指定 Session、从历史列表切换和新建对话都经过同一条激活路径，同步恢复 transcript、mode、model、输出等级、Plan、Goal、Team、ContextArchive 与 checkpoint。CLI 的 `/retry` 最近输入缓存仅属于当前终端进程，不伪装成持久 Session 状态。每轮执行捕获不可变作用域并生成 runId/owner；checkpoint、Trace、事件和延迟动作始终写回启动该轮的 Session，所有进展与终态更新都以 runId 做 CAS。其他 Session 的消息和局部运行状态不会进入当前模型上下文；唯一允许跨 Session 注入的对话信息是带新 `recordedAt` 或兼容旧 `confirmedAt` 标记的长期记忆。`/resume` 将未完成 checkpoint 与 Goal/Plan/Team 合并为新一轮输入，并要求先核对当前工作区；这是 best-effort 任务续跑，不是任意 SDK 指令点的精确恢复。没有未完成状态时拒绝空恢复。

`AtomicJsonStore` 是 Memory、Plan、Team、RAG、ExecutionLedger 和 Session 的统一状态层：按绝对路径共享进程内队列，使用跨进程锁在锁内重读，写入 PID+UUID 临时文件后原子 rename，并通过 Zod 校验和损坏文件隔离处理异常。Session 与执行账本选择失败关闭；可重建的共享索引/偏好状态可以隔离损坏文件后从空状态继续。

本地 Function Tool 的副作用以 `sessionId + runId + toolName + logicalCallId` 记入执行账本。Daemon 的 logicalCallId 由规范化参数和同参数调用序号组成：同一 attempt 内的合法重复调用分别执行，跨 attempt 的对应序号才回放；`started` 或 `failed` 状态不会自动重试。原生 MCP transport 也使用同一 executionKey；Hosted Tools 仍不在本地账本控制内。

模型可调用的 Shell 默认只获得 PATH、HOME、locale、终端和临时目录等显式白名单环境；Provider、数据库、遥测、Connector 和 Mimi 控制面变量都不进入 Shell。Shell 的正常退出、超时和取消都会回收完整 POSIX 进程组，文本后台语法检查只是早期提示。HTTP Tool 只允许公网 HTTP(S)，在初始 URL、实际 socket DNS lookup 和每次重定向处拒绝 loopback、私网、link-local、metadata、multicast、IPv4-mapped IPv6 与混合解析；禁止 HTTPS 降级，跨源只跟随无正文的 GET/HEAD 并仅保留安全读取头。

Session 模型偏好同时记录 provider；切换 Provider 或读取没有 provider 标记的旧偏好时回退当前 Provider 默认模型，不把一个 Provider 的模型名发送给另一个端点。

## MimiAgent 常驻事件循环

常驻模式不是一条无限运行的模型请求，而是一个长期在线、每次唤醒都有界的事件循环：

```text
Connector / CLI / Schedule
  → EventEnvelope(source, externalId, trust, priority, replyRoute)
  → SQLite Inbox 去重并持久化
  → Kernel Attention: run / digest / notify / ignore
      ├─ digest → 摘要池 → 定时 Briefing Event
      └─ run → Policy 选择 Session / RunPolicy / execution lane
  → conversation lane → Dispatcher claim + lease
      → MimiHost Session actor（同 Session FIFO，跨 Session 并行）
      → AgentRunService → MimiAgent bounded run
  → task lane → TaskProcessSupervisor
      → fork OS worker → 精确 claim Event → isolated Task Session run
  → replyRoute = Event route ?? owner.replyRoute
  → Event 终态 + Outbox 同事务提交
  → Kernel Notifier deliver；失败独立退避重试
```

`MimiHost` 是 Session actor registry，而不是全局单工 lane。每个 actor 是其可变 Agent 的唯一所有者，Session 选择、模型/模式变更、清理和 Run 在该 Session 的 FIFO lane 内执行；Host 的 semaphore 只限制同时活跃的不同 Session 数。只读 `sessionSnapshot(id)` 直接读取指定 FileSession，不切换当前 Session。Conversation Dispatcher 可同时持有多个不同 Session 的 Event lease，但不会并发写同一个 transcript；Task Dispatcher 位于独立子进程并只领取 supervisor 指定的 task Event。Agent Run 期间有一个局部 ready Event 查询：达到 Attention `urgentPriority` 的高优先级候选可在没有 Tool 在途时 abort 当前模型思考；Tool 在途时等待结果落账。Event 的过期租约会回到待处理状态并依靠执行账本恢复；Outbox 的过期 `sending` 租约代表远端结果不确定，会直接进入 dead letter。明确可重试的普通失败才指数退避并在达到上限后 dead-letter。

SDK Session 完成早于 SQLite Event/Outbox 事务时，执行账本会保留 `sessionId + executionKey` 的完成回执。回执同时保存由成功控制工具恢复并严格校验的 RuntimeAction；模型/模式/输出/Session 切换、清空、MCP 重载和退出效果通过独立 action ledger 至多执行一次。`clear_session` 会保留当前 execution root 及子账本，直到 Event 事务确认后统一清理，因此崩溃恢复不会把清空动作重放到后来数据。若进程在任一边界崩溃，重试读取回执、修复 checkpoint、复用原答案和 RuntimeEffect，不再次调用模型；SQLite 提交成功后才清理回执。该机制与 Tool at-most-once ledger 一起缩小跨存储崩溃窗口，但不把两种存储宣称为分布式 exactly-once 事务。

CLI 启动快照只携带有界的最近对话和当前 Plan，避免 7×24 Session 最终撞上本地 IPC 帧上限；`/history` 与 `/memories` 通过带 revision 的分块 RPC 重组权威数据，读取期间发生变化会失败关闭并提示重试。Event、Run、Outbox 和 Schedule 的列表 RPC 只读取不含大正文的有界摘要，`daemon show` 再按 ID 读取单项详情；IPC 分别限制 1MiB 请求与 8MiB 响应，服务端在写出前失败关闭。Plan 更新作为同一 Event 的 live stream 事件送到输入区，完成结果中的 RuntimeEffect 则更新远程 CLI 的 Session、输出状态和退出行为，不建立客户端状态真相。

同一 Dispatcher 内还有一个局部 Agent idle watchdog。每次 Run 从最新 Attention 配置读取 `execution.runIdleTimeoutMs`；模型流和 Runtime Event 刷新 timer，Tool 在途时暂停，最后一个 Tool 输出后恢复。无进展超时只 abort 当前 Run，继续复用 Event retry、execution ledger 和最终失败升级，不建立 watchdog 服务或硬总时长。Daemon stop 请求若遇到在途 Tool 会等待其输出落账，再中止模型、撤销本次 claim attempt、立即重排队并把 Host Run 标为 interrupted，正常升级或重启不会切断外部事务或消耗失败次数。

Dead letter 不是静默终态。Event 达到最大尝试次数时，状态更新、Host Run 失败、audit 和一个绑定原 Event 的 system Outbox 在同一事务提交；它绕过模型直接使用本机 Notifier。非 system Outbox 的普通可重试失败按退避耗尽后进入 dead letter；超时、进程中断、ACK 丢失或 Connector 显式 `uncertain:true` 则首个 attempt 直接 dead-letter，避免结果不确定的消息自动重放。sending 租约默认 180 秒，覆盖内置 Connector 最大 120 秒投递超时；崩溃恢复遇到真正过期的 sending 也原子 dead-letter，而不是重置 pending。投递最多使用四个有界 lane，lane key 是精确 `(channel,target)`：同一会话保持 FIFO，一个失联 QQ 群不会阻塞其他 QQ 私聊或微信会话。两种 dead letter 都在状态事务内插入 system fallback；若 fallback 本身也失败，只记录 system dead letter，不再生成下一层通知。载荷只含有界 ID/source/channel/attempts/error 摘要，不复制 Event payload、消息正文、投递内容或 target。owner 可通过窄 RPC/CLI 把 dead letter 原 ID 重排队或标记为 archived，四种变化都以状态 CAS 和 audit 原子提交；后台从不自动重放。owner 显式 Outbox 重投保持 at-least-once 语义，控制面明确提示远端确认丢失时可能重复。这里没有告警服务、失败 Agent、审批流或第二张升级表。

Schema v7 在 v6 历史保留索引之上增加 Event `executionLane`、`originSessionKey`、`parentEventId`、`rootEventId`、`taskDepth` 与 ready-task 索引；v8 再增加 nullable `taskControl/taskControlReason`；v9 为 Schedule 增加 nullable `authorityEventId`，并为旧 owner/system 计划回填终态 Conversation authority root，旧外部计划缺根时禁用而不提升 provenance。运行中 Task 的 cancel/pause 必须先持久化控制意图，再尽力通过 IPC 提醒 worker；worker 在 Tool 安全边界和续租时消费它。若 Kernel 或 worker 先崩溃，claim/lease recovery 会把 cancel 收敛为 `archived`、把 pause 收敛为 `paused`，且 cancel 始终覆盖 pause，不会把已接受控制的工作重新排队。后台任务因此继续复用原 Event / Run / lease / retry / Outbox 状态机，不增加第二套 workflow 表。Dispatcher 低频调用 `pruneHistory(cutoff)`；Store 在一个 transaction 内先删除旧 sent/archived Outbox 和已归档 Digest，再删除无引用 completed/ignored/digested/archived Event 的非运行 Runs 与 Event，最后清理旧 disabled Schedule、Attention checkpoint 和普通 Audit。所有活状态、dead letter、未解决 Outbox/Digest、被活跃 Task 作为 parent/root 引用的来源 Event，以及仍被 Schedule 引用的 authority root 都由显式查询条件保护；这也保留了 Task 重新计算 owner source-policy 授权所需的 provenance 链。事务后只做轻量 optimize/passive checkpoint，不自动 VACUUM，也没有维护表、线程或服务。

MimiAgent Event 获得一个只读运行自省 Host Tool 与四个 Schedule Host Tool。`inspect_mimi_activity` 直接从 Store 生成有界快照，包括 counts、积压、dead letter、Digest/Schedule 数量及近期 Event/Run/Outbox/Audit 元数据，不返回其他事务正文、答案、投递内容或 target。Schedule Tools 用于创建一次性 follow-up、周期 routine、查询和取消计划；新计划保留发起事件的 origin Session、profile、trust provenance、reply route 和不可变 Conversation authority root。到期 occurrence 总是进入独立 `mimi-task-*` Session 与 Task lane，由 OS worker 执行，不占用来源 Conversation actor；Task 每次从 durable root 与当前 source policy 重新计算权限。owner/system 的本机 CLI 计划使用可审计的合成 root；外部来源缺根、根被删除或 provenance 不匹配时失败关闭且不发出新 Task。撤销外部 work policy 后，一次性 follow-up 只能受限收尾，interval/watch 只获得绑定当前 authentic occurrence 的 `complete_current_mimi_schedule` 以停止轮询，伪造 occurrence 不获得该工具。非 command Event 额外获得 `finish_mimi_silently`：它只修改当前 attempt 的内存 DeliveryControl，成功提交时把 suppression reason 放入 Event result 并省略 Outbox；直接 command 没有该工具，失败/重试也不继承状态。所有能力继续位于同一个事务语境，不引入 RPC 回环或工作流引擎；创建/取消工具进入事件级语义账本，重试不会重复建立计划，静默控制不是外部副作用且不进入 ledger。

最终工具集取 `mode capability ∩ local deployment permission ∩ event policy`。认证本机 owner 的默认部署权限是 `trusted`，保留 main CLI 原有的 Shell、文件和网络执行能力，不增加逐任务审批；`workspace/read-only` 仅是显式收紧选项。已配置的 Connector Host Tools 仍经过 mode/event policy，已显式信任的 MCP 配置本身就是 owner/system 的执行授权。外部事件默认禁用 Session/Memory、本地文件、Shell、MCP、未知工具和外部写事务。命中 owner source policy 后使用固定 `reply | work` 档位，旧配置默认 `reply`，多个匹配取最高档：`reply` 只有时间、计算、当前 Session 有界活动与投递控制，不能调用 Shell、文件写、任意写网络、Connector action、后台委派或 Team；`work` 才获得原静态工作 allowlist，但仍不能读写 Runtime/Attention/People/Standing Order/Connector 配置、写 Memory、管理任意既有后台任务或调用未知 MCP。Task 的 `workspaceAccess=read` 再与来源权限相交，形成固定只读研究/checkpoint 工具集。

Attention Engine 是同步、确定性的 Host 层分类器，不是第二个模型。它从 `assistant.json` 读取 owner 关注点、默认 reply route、时区、静默时段、运行预算、阈值和有序规则。Settings Host Tools 以完整快照更新这些标量设置；Rule Host Tools 按稳定 ID 列举、完整 upsert、删除规则，并通过 `beforeId` 保持“第一条匹配生效”的显式顺序，二者复用同一原子配置变更且不触碰其他配置域。来源自带 route 时保持原会话回复；缺失时使用最近 owner Connector 或 `owner.replyRoute`，但 `local-cli` 与 Webhook 明确不回落，避免把 CLI 返回值重复发往旧渠道。Routine、Briefing 和后续 Schedule 复用同一路由，可覆盖 channel/target；status 只暴露 channel。这里没有 fan-out、路由规则表或通知工作流。低价值事件原子转为 `digested` 并写入 `digest_items`；到达简报时点或 Agent 调用 `request_mimi_briefing` 后只创建一个普通 `external` Event，继续复用同一 Dispatcher、受限 event policy、Session 和 Outbox，摘要内容不会因聚合而洗成 system 指令。摘要只有在简报 Event 成功终结后才归档，dead-letter 或 archived 简报关联项会在下次创建时释放，从而避免丢失；Host Tool 不返回摘要正文。

同一个 `assistant.json` 还保存 daemon-only Standing Orders。owner/system Run 总能使用匹配的可信策略；外部 Run 只有命中一条 source policy 时才获得替身授权，并同时注入去重后的全局/局部 order。`access` 是 Host 校验的固定档位而非提示词，缺省为 `reply`，多匹配取最高的 `work`。原始事件正文保持原样作为 user input，继续被单独标为不可信数据，不会与契约、人物上下文或剧本拼成一段伪用户指令；它不能扩大本机策略的目标、收件人或副作用范围。`MIMI.md`（兼容 `MIMI.md`）继续负责 CLI 与 Daemon 共用的全局行为，因此没有第二套 instructions loader 或策略 Agent。

`assistant.json people` 在 Attention Host 内做 owner-managed canonical identity resolution。每个 person 只包含稳定 ID、显示名、有界 `source + actor` glob aliases 和可信 context；按配置顺序采用首个匹配项，不做模型推断、联系人同步或身份图。Host Tools 可列举、完整 upsert 和删除人物，并复用 Routine/Standing Order 的原子配置变更。显式 Event sessionKey 优先且必须通过核心 Session schema；否则匹配人物从 ID 派生稳定安全的 `mimi-person-*`，不兼容字符或超长 ID 使用稳定摘要。默认受限事件仍可使用该路由键，但看不到既有 Session；owner/system 或命中 source policy 的替身 Run 才携带 canonical person、注入人物 context，只有 `work` 档位开放有界 `recall`。status 只暴露 person/alias 数量。

同一配置中的 Daily Routines 负责本地时区日常节奏。AttentionEngine 只检查 `time + optional weekdays`，为每个 occurrence 写入终态 owner Conversation authority root，再生成绑定该 root 的 `attention:routine` Task Event；`source + routine:<id>:<local-date>:<time>` 复用 Event 唯一键实现每日幂等和晚启动补发，进程内按日期 checkpoint 避免高频重复写库。每个 occurrence 使用独立 Task Session/OS worker，原 Routine Session 只作为 `originSessionKey`，因此固定巡检不会阻塞同源对话；配置删除、禁用或 revision 变化仍会在执行前使旧 occurrence 失效。Daemon Host Tools 可列举、upsert 和删除 Routine；写入串行读取最新文件、复用完整 schema 校验并以 `0600` 临时文件 atomic rename，随后更新同一内存 Engine。默认晨间和晚间例程先调用运行自省工具核对积压与失败，再检查外部工作生活来源；有关键结果就汇报，确实无变化时显式静默完成。它不新增 cron parser、调度表或执行路径，prompt 最终仍由同一个 Dispatcher 和 MimiAgent 处理。

来源 `trust` 只作为 provenance 标签，授权由本机 event policy 决定；它绝不因消息自称 owner/trusted 而扩大部署权限。owner/system 在部署权限内工作；其他 provenance 默认受限，只有 Host 用 source/kind/actor/conversation 命中本机 owner source policy 时才获得固定 `reply | work` 档位。后台 Task 不把 provenance 改写成 owner，而是从被保留且确认为 conversation root 的来源 Event 与当前 source policy 重新计算授权；policy 被删除、root/parent 缺失或引用 Task 而非 conversation root 时失败关闭，即使 Task 自带 owner provenance 也不能绕过。外部正文始终只作为数据并记录 provenance。

Connector Action Bridge 把外部凭证保留在 Kernel 监督的隔离 Connector 子进程中。一个 Daemon 数据根只有一个 Connector Manager/broker；Conversation actor 与后台 Task worker 都不能各自拉起同一渠道或复制凭证，而是通过这一个 broker 做能力发现和 action。每个 Connector 在 owner 配置里声明 action 目录；Agent 可先通过动态只读 `inspect_mimi_capabilities` 查看配置路径及 enabled/online 状态，通过 `reload_mimi_connectors` 复用 Manager 的 validate-before-swap/drain 热重载，再通过通用 `connector_action` 发出 `action(id, action, target, payload)` 并等待 `action_result`。能力快照最多返回 50 个 Connector、全局 100 个 action 和 300 字符描述，同时保留真实 totals/truncated，避免异常配置膨胀上下文；action 执行时仍由 Manager 做最终在线检查。目录用于能力发现，不是审批层。超时或子进程退出时不自动重放，以避免不确定结果造成重复事务；Agent 只能选择不会重复原事务的替代执行面或向 owner 汇报。

Daemon 的本地副作用账本使用稳定的 `eventId` 作为 execution scope，并以工具名和规范参数生成语义 call ID。模型重试时即使 SDK call ID 改变，相同动作也只重放已保存结果。账本只在 Event 成功提交后清理；retry、抢占和 dead letter 都保留它，因此 dead letter 原 ID 显式恢复时仍不会再次执行已经成功落账的相同动作。若进程在外部动作后、事件提交前崩溃，租约恢复后的重试也不会重复该动作。

Unix Socket 位于 `MIMI_DAEMON_DATA_DIR`（可回退旧目录）且权限为 `0600`，提供 status、chat snapshot/history/invoke、activity、submit、events、tasks、runs、outbox、dead-letter retry/archive、attention、connectors、schedules 和 shutdown。仅靠同用户可连接的 Socket 不作为 owner 认证：bootstrap 在同目录原子创建并校验一个 `0600` 随机 control bearer，普通 `mimiRpc`/CLI 自动读取并随请求发送，Kernel 对除两条专用 worker broker 方法外的全部 RPC（包括 ping/status/submit/shutdown）做固定长度摘要的 constant-time 比较。token 不进入 SQLite、环境、status、Doctor、日志或错误文本；运行中新 daemon 的 token 文件缺失、权限错误、内容错误或值不匹配都 fail closed。Task worker broker 只验证 Supervisor 分配的独立 `workerToken`，其客户端显式不读取 control bearer。旧 daemon 会忽略新请求附带的 `auth` 字段；尚未初始化 token 的只读探测也仍可使用旧协议，因此新 CLI 能读取 status 并完成安全升级。协议版本提升确保已运行旧实例不会被误当成当前控制面；同协议 status 还必须携带由包版本、入口文件内容和构建时间导出的 build identity，缺失或不一致都按待升级处理。status 同时携带活跃 Session Event、task worker PID/heartbeat 及在途 Host/管理 mutation 数；Chat 修改、Attention reload 和 Connector 热重载共用一个关闭门，shutdown 只有在 Event、task worker、Outbox 和管理事务都空闲时才原子停止接收新事务。CLI 未显式配置 workspace 时会从任意目录采用现有后台的绑定工作区，并按该工作区重新解析默认数据、Skill 与 MCP 路径；显式配置时只复用匹配工作区的后台。空闲旧版会先经 shutdown 安全退出再由当前入口重启，活动 Event、task、Outbox 或 mutation、显式异工作区和未来版本都不会被强制终止。已安装 launchd 的后台升级后仍由重写为当前入口的同一 KeepAlive job 托管，不退化为 detached 进程。交互式与单次 CLI 都走该入口；命令通过共享 `CommandHandler` 和远程 adapter 作用于同一个 Host。FileSession 是唯一 transcript 真相；`chat.snapshot` 只返回指定 Session 的有界展示项、偏好、Plan 与恢复点，`chat.history` 按修订号分块传送完整权威 items，两者都不切换当前 Session。SQLite Event/Run 只做可靠控制面和 Activity，不再拼装第二份聊天记录。

Daemon 启动前经过一个幂等 bootstrap，而不是额外安装服务：首次运行从发布包 Connector catalog 物化绝对 Node/脚本路径，创建 `0700` 数据目录、原子且稳定的 `0600` control bearer、`0600` 配置和 SQLite 数据库。Darwin 本机 Connector 默认启用，凭证型外部来源保持待配置；QQ/微信 UI 自动化不属于默认集合。升级现有配置时只补缺失的默认 enabled 本机 Connector，不加入模板中默认关闭的外部通道。对同 ID、canonical packaged script 路径/文件身份一致且未关闭 `syncTemplateActions` 的现有 Connector 合并缺失 action；`macos-system` 也只有满足该身份校验时才迁移精确旧 provenance。其他 owner 的 enabled、执行路径、环境、来源、超时和已有描述均保持不变，且无变更时不写文件。Detached 与 launchd 启动复用同一个非敏感环境构造器，保持 workspace、状态目录、Skills、MCP、permission 和运行限制一致；Daemon status 返回实际 permission，CLI 会和本地解析值一起核对。正常 `mimi` 连接也会轻量核对 supervisor：持久 Key 就绪且后台空闲时把 detached worker 安全迁移到 launchd，忙碌时继续复用并延后。协议过期或 permission 不一致的同工作区后台只有在 Event、Outbox 和 Host mutation 全部空闲时才会被替换；launchd 立即拉起的旧 plist 实例也会在重装 supervisor 前再次核对。首次解析的 env 文件路径会固化为绝对路径，API Key 等秘密仍只来自进程环境或该受保护 env 文件。安装 launchd 前必须确认所选 Provider Key 确实存在于该持久 env 文件，避免当前 Shell 可用而登录重启后循环失败。Doctor 复用同一 schema 做只读静态检查和短时认证 Unix Socket status，不拉起 Connector、不探测私人数据库、不会输出 control bearer，也不触发系统权限。

渠道通过独立 NDJSON 子进程接入。Host 只传递 allowlist 环境变量，负责子进程退避重启；带 `replyTarget` 的结果走 Connector Outbox 并等待 delivery ACK，主动事务走 Action Bridge。没有专用 Bridge 或必须先经过官方服务端回调的来源可使用只绑定 `127.0.0.1` 的 Bearer Webhook；Webhook 固定产生 external provenance，限制 1MB 和每分钟 60 次，并接受有界 `reply:{connector,target}` 转换为现有 Connector route。`notify:false` 表示显式无回传，不继承 owner route。大象的官方 Thrift/OCTO 鉴权和 3 秒快速确认留在主干 relay，本机只负责持久化、去重、Agent 和 Outbox。两种入口都不把渠道 SDK 或凭证耦合进 Agent Runtime。

Connector 配置换代复用同一个 Manager 对象和显式 Unix Socket RPC。新文件在触碰旧进程前完整解析；Manager 先确认没有 pending delivery/action，再 drain、停止并精确注销旧 notification sink，最后安装启动新 Map。每条 delivery/action 带绝对截止时间；外层超时会关闭 stdin、终止并按配置重启整个 Connector，UI Connector 同时负责终止自己的在途系统子进程，避免调用方已收到超时而动作仍晚到。Dispatcher 每个 Event 动态构造 action tool，execute 闭包也始终查询同一 Manager，因此无需重建 Agent、Dispatcher 或 Daemon。这里刻意没有文件 watcher、配置版本表或双进程交接协议。

Connector 自愈也复用普通 Event 语义，不建立健康表或监控循环。第一次意外退出或启动失败打开一个故障窗口并持久化高优先级 `system:connector-health` Event；退避重启期间的后续失败被合并，稳定存活达到阈值后才以恢复 Event 关闭窗口。正常 Daemon stop 不报告离线，健康 Event 继续受 Attention 静默时段、规则和预算约束。完整故障写本机 stderr，进入 Agent 上下文的错误摘要不包含命令参数或原始路径。

无回调能力的信息源复用同一 Connector 协议做有界轮询。内置 Radar 示例只包含 RSS/Atom 和 Open-Meteo 两个明确 driver，不引入通用爬虫 DSL；新闻产生 ambient Event，天气阈值产生 alert Event，跨重启去重仍由中心 Store 完成。

文件活动雷达沿用相同的无状态轮询边界，但只扫描配置目录的元数据。它不读取正文、不跟随符号链接、不保存 cursor，也不重复实现移动/删除等 Runtime 已有文件工具；`watchId + path + mtime + size` 形成稳定事件身份，扫描深度、条目数、回看窗口和单轮事件数全部有界。这样 Downloads、共享落盘目录或外部自动化输出可以主动唤醒 MimiAgent，而不把平台文件监听器塞进 Daemon。

macOS System 适配让电脑自身成为普通事件源。Node 内置 API提供内存、负载、非 loopback 网络接口和 `statfs` 容量，固定 argv 的 `pmset -g batt` 提供电池状态；没有平台监控框架、进程枚举或额外状态库。首轮网络只建立基线，后续只在 online 边沿输出；电池和磁盘只在阈值 band 边沿输出，并由带本地日期的 external ID 继续交给中心 Store 去重。按需快照也走同一个 Connector Action Bridge。

macOS Life 适配通过同一 JXA 边界完成 Calendar/Reminders 生命周期。查询和创建之外，update/delete 按系统稳定 UID/ID 跨可选 calendar/list 查找，不按标题猜测；字段、日期和长度在 Connector 内验证。Calendar recurrence 的最终修改/删除语义留给系统应用，所有写入继续由 Action Bridge 记录为不确定结果不重放的外部事务，没有额外日程数据库或 CRUD 框架。

macOS 邮件适配也保持在独立 Connector：JXA 只调用 Apple Mail 已配置账号，不把 IMAP/SMTP、Keychain 凭证或 Mail 对象引入 Runtime。未读轮询产生无 reply route 的 ambient Event，发信/回信是显式 Connector action，所以普通 Agent 结果不会意外外发。收件箱搜索复用系统统一 inbox 并做有界 sender/subject 与状态筛选；邮箱目录以 account + 名称数组表达，旗标、移动和删除按稳定 message ID 作为显式事务执行，不引入历史邮箱镜像、搜索索引、规则引擎或本地化归档猜测。附件仍沿用同一 Action Bridge：轮询只携带数量，按稳定 attachment ID 显式列举/保存，二进制不进 NDJSON；Node 边界验证绝对路径、普通文件与大小，并用同目录 `0600` 临时文件完成 no-clobber 或 atomic overwrite。发送、草稿和回复直接复用 Mail rich-text attachment，不新增 MIME、缓存或文件服务。

macOS Messages 适配采用两个窄边界：`node:sqlite` 只读打开 `~/Library/Messages/chat.db` 感知来信、查询历史和按 message/attachment 关系读取附件元数据，JXA 只负责经 Messages.app 发送 text/file。Connector 启动时验证核心表，附件 action 按需检测系统版本可选列，不尝试写库或解析不稳定的 attributed body。附件轮询只携带数量，显式保存复用同目录 `0600` 临时副本和原子 no-clobber/overwrite；发件文件走官方 `send(file)`，不新增附件缓存、MIME 或上传层。入站消息保留 chat GUID 作为 reply route，可直接复用可靠 Outbox 回复原会话。

macOS Contacts 适配是无轮询的 action-only Connector。它按需通过 Contacts.app JXA 返回稳定 contact ID、候选邮箱和电话，供 Mail/Messages Connector 继续执行跨渠道事务；创建和更新也在同一系统边界内显式保存。Runtime 不维护联系人镜像、搜索索引或额外身份图谱，重名消歧仍由主 Agent 基于候选和当前上下文完成。

macOS Notes 适配同样保持 action-only。Notes.app JXA 负责账号、文件夹、稳定 note ID、纯文本/HTML 正文和附件元数据；Runtime 不读取私有数据库、不建立 Notes 镜像，也不默认轮询，从而避免 Agent 写入后触发自身。纯文本写入在 Connector 内转义为 HTML，密码保护正文不尝试解锁，修改动作继续服从 Action Bridge 的不确定结果不重放语义。

macOS Shortcuts 适配把系统 `shortcuts` CLI 作为通用能力总线，但不解析 Shortcut 内部步骤，也不引入工作流 DSL。目录查询和运行均使用 argv；内联输入通过短生命周期 `0600` 临时文件桥接，文件输入/输出使用明确绝对路径，stdout、超时和输入大小有硬上限。Shortcut 的网络、应用和智能家居副作用仍由 macOS 管理，Connector 断线或超时后不会自动重放。

macOS Desktop 适配补齐没有专用 API 的即时桌面操作。System Events/JXA 只承担前台应用、窗口、剪贴板、菜单和键盘的窄动作，`/usr/bin/open` 只接受参数数组形式的 URL 或绝对路径；复杂多步骤流程仍交给 Shortcuts。可选剪贴板轮询只有进程内 hash：首次读取静默建立基线，外部变化产生 ambient Event，Connector 自身写入同步更新基线，避免形成自触发循环。它不引入 UI 工作流、截图模型或额外持久状态。

macOS Browser 适配补齐已登录网页执行面。独立 Connector 只调用 Safari/Chrome 随应用提供的 JXA 字典，复用浏览器当前 profile，不引入 Playwright、WebDriver、扩展或登录态镜像。标签引用是当前窗口/标签索引快照；页面正文和 JavaScript 结果有硬上限并标为外部不可信数据，所有导航与脚本参数经 argv JSON 传递，超时结果不自动重放。

macOS Screen 适配补齐非 DOM 视觉文字入口。Node Connector 只编排系统 `screencapture` 和一份窄职责 Swift Vision helper；截图 target、图片大小、OCR 字符/行数、子进程输出和超时全部有界。`read_screen` 的临时图片在所有终态清理，显式 `capture_screen` 才持久保存文件；没有持续录屏、屏幕轮询、图片数据库、云端 OCR 或视觉 Agent。

macOS Voice 适配是 action + event 双向 Connector。Swift helper 只负责 Speech/AVFoundation 分段识别，Node 负责唤醒短语、去重、listener 生命周期和系统 `say`；命令仍进入普通 Event/Attention/Session/Runtime 路径。环境语音不通过 wake prefix 就被丢弃，麦克风 buffer 不落盘，朗读期间 listener 暂停，因此没有第二个语音对话服务、自触发回路或长期音频存储。

## MIMI.md 持久指令

`GuidanceLoader` 在每轮开始时读取用户级与项目级 `MIMI.md`。项目文件优先于用户文件。内容进入同一 Token Budget，单文件最多 20000 字符；SubAgent 继承内容但不能突破工具边界。

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

Agent、SubAgent 与 Team worker 默认不设置固定 turn 或工具调用次数上限。Run 由任务真实终态、显式取消/暂停、Daemon 空闲超时、租约失效、上下文预算或用户显式配置的 `MIMI_MAX_TURNS` 结束；重复外部动作由 ExecutionLedger 的 at-most-once 语义处理，不能用“重复若干次后中止”替代根因治理。

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

主 Agent 应先判断交互预期：简单问答、短操作和用户明确等待当前结果的工作留在 Conversation actor；其余调用 `delegate_background_task`，收到 `taskId` 后立即结束当前委派动作，不轮询、不在前台重复执行。委派参数只包含可独立执行的 objective、可选 success criteria/必要上下文、single/team strategy 和 priority。写入使用来源 Event 的 ExecutionLedger 与稳定语义键，模型重试不会重复创建同一任务。

Task worker 的外部事务权限由仍存在的 conversation root 确定，而不是由 Task payload 自报。只有 owner-root write Task 可通过 Kernel Broker 执行 `connector_action`；非 owner-root Task 的工具目录会同步隐藏该 action，避免模型调用一个确定会失败的能力。Task 的完成、失败和阻塞通知不依赖该 action，始终由 Kernel Outbox 按原 reply route 可靠投递。

每个后台任务使用 `mimi-task-<uuid>` Session，并记录来源 Session、父/根 Event 与 delegation depth，用于授权重算、历史迁移和引用保护。Task lane 不再创建持久子 Task；需要拆分时，write Task 在当前进程内使用有界 Ultra Team，read Task 只使用只读 SubAgent，从而避免无界进程树。任务生命周期继续使用 Event 状态机：

```text
queued → running → completed / dead_letter
   ├────────────→ paused  ── resume ──→ queued
   └─ needs input → blocked ─ resume + context → queued
```

Task Lead 只有确实缺少无法自行取得的必要信息时才调用 `request_background_task_input`；Store 原子写入 `blocked` 与通知 Outbox，worker 随后退出而不占用进程槽。`/tasks [limit]` 列出近期状态，`/task <id>` 查看目标、结果和错误，`/task pause <id>` 在安全边界暂停，`/task resume <id> [context]` 复用原 Task Session 继续，`/task cancel <id> [reason]` 取消 queued/running/paused/blocked 任务。任务权威状态来自 SQLite Event，不依赖发起 CLI 是否仍然在线。

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

只有成功连接的 Server 才会进入候选工具集。工作区 `mcp.json` 需要 `MIMI_TRUST_WORKSPACE_MCP` 与工作区真实路径匹配；完成这一次配置授权后，owner 可在 `workspace/read-only` 使用其 Server Tools，不再叠加 `trusted`。只读 SubAgent 不继承 MCP，Plan 仅保留受控 Resource wrappers，external/public 事件禁用 MCP。Daemon executionKey 会在 MCP transport 调用边界复用 ExecutionLedger，因此成功结果可重放、失败或结果不确定的外部事务不会自动再次执行。远程认证保持在环境变量中，不应写入 `mcp.json`。

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

`runtime/control.ts` 把 CLI 中有实际运行时语义的操作暴露为 Function Tools。只读查询直接复用 `MimiAgent` 方法；模型、模式、Session、输出等级、MCP 和退出等所有变更型 RuntimeAction 都先进入内存队列，等 SDK 完成当前 Session 写入与 `run_end` Hook 后再应用，并把 Effect 交给 CLI 刷新界面。这样 Agent 能代替用户操作，又不会在 Tool Call 尚未闭合时替换模型、能力边界、持久化目标或当前 MCP 连接。

主 Agent 的默认本地部署权限是 `trusted`：认证本机 owner 的 General/Ultra 任务直接使用当前操作系统用户权限并保留 Shell。`workspace` 是显式受限档位，会过滤 Shell、通用网络写入和未登记内置工具；`read-only` 再移除本地文件写入。已配置 Connector 不复用文件/Shell 档位作为第二道开关，但仍经过 mode/event policy；已显式信任 MCP 只供 owner/system 使用，source-policy 替身 Run 的静态 allowlist 不包含未知 MCP。

## Memory 与 RAG

Memory 保存少量跨会话偏好、事实、决策和承诺，包含来源 Session、Daemon Event/source/trust、canonical person、actor/conversation、重要度、记录时间和更新时间。主 Agent 可按未来价值主动调用 `remember`，无需逐条确认；本轮原始输入明确要求“不记住”时 Tool 确定性拒绝。检索文本同时包含正文和 provenance，RunCause 中的 person/source/actor/conversation 会加入 query，从而跨渠道召回同一人物信息。新记录用 `recordedAt` 表示进入可用集合，旧 `confirmedAt` 只作兼容标记，旧无标记项继续隔离。正文最多 2000 字符、可用记录最多 1000 条，精确正文去重复用同一条记录；持久化仍复用原子 JSON 与 ExecutionLedger，不引入画像服务或自动抽取工作流。RAG 面向本地中小型 Markdown/Text 知识库：固定切片、按内容摘要与模型复用 Embedding、每次读取最新原子状态、向量与词法混合排序。并发提交串行原子替换整份索引，不使用跨调用的易过期内存缓存；默认权限同时校验词法路径与 realpath，拒绝工作区外索引。取消信号贯穿扫描、读取、Embedding 和提交。

自动探测的 `.mimi-agent`、旧 `.mimi-agent` 与默认 Daemon 数据根必须是实体目录，符号链接会在启动时失败关闭。文件、搜索和目录工具会拒绝这些根与显式运行数据目录，包括符号链接解析后的路径。默认 owner Shell 使用当前操作系统用户权限；处理陌生仓库时可显式选择 `workspace/read-only` 关闭 Shell。Plan 无论部署档位都没有 Shell；外部事件只有命中 owner source policy 且当前模式/部署权限允许时才可获得 Shell。

## Hooks 与 Trace

HookBus 当前暴露 `run_start`、`run_end`、`run_error`、`subagent_event` 和 `team_worker_event`。默认订阅器写入本地 JSONL Trace。它是普通进程内事件总线，可用于后续统计、Guardrail 或自定义可观测性，不承担工作流编排。

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
