# MimiAgent

一个 7×24 小时在线、本地优先的全能个人 Agent：持续接收工作、生活和外部世界的事件，主动处理事务，并只在恰当时机打扰你。

MimiAgent 使用 OpenAI Agents SDK 作为运行内核。CLI 对话与长期运行服务是同一个系统的两种入口，共享模型、Session、长期记忆、Skills、MCP、RAG、任务恢复和运行控制。唯一常驻 Kernel 负责可靠事件、Attention、Schedule、Connector broker 和主动通知；Conversation 层按 Session actor 并行；无需当前窗口等待的长任务先持久化，再由独立 OS 子进程执行。编排层仍提供受控 SubAgent 与有限并发 Team，同时保持 TypeScript 内核轻量、直接可读。

> 本机 owner 默认拥有完整执行能力，Shell、文件、网络、Connector 和已信任 MCP 无需逐任务审批。Plan 模式保持只读；外部事件正文始终是不可信数据，默认使用最小事件策略，只有命中 owner 明确配置的 source policy 才获得该策略范围内的代办能力。只有在运行陌生工作区或主动收紧部署时，才需要显式选择 `workspace` 或 `read-only`。

## 为什么是 MimiAgent

MimiAgent 不是一次性工具调用样例，也不想变成重量级工作流平台。它要成为可日常使用的本地通用 Agent，同时把任务拆分、角色隔离、依赖调度和有限并发沉淀为可复用的轻量编排能力。

## 核心能力

- OpenAI Agents SDK 驱动的 Agent Loop
- OpenAI Responses API 与 DeepSeek OpenAI-compatible API
- 持久化多轮会话，可新建、切换和恢复
- 不同 Session actor 有界并行、同一 Session 严格 FIFO，多个不同 Session 的对话窗口互不阻塞
- 长程、大型和持续型任务持久委派到独立 OS 子进程，当前对话立即恢复可用，终态主动通知
- MimiAgent 守护进程、可靠事件 Inbox/Outbox、定时唤醒与 macOS 主动通知
- 可配置静默时段、自治预算、事件规则、摘要池与定时主动简报
- 可热重载 Standing Orders，按来源、人物和会话执行长期替身决策
- owner-managed People aliases，把同一人物的邮件、IM 和群聊事件统一到连续 Session 与长期记忆
- owner 对话内可创建一次性后续唤醒和周期巡检，支持查询、取消与崩溃重试去重
- Connector Action Bridge，用一个通用工具主动执行 IM、邮件、日历等适配器事务
- 信息雷达持续汇聚 RSS/Atom 与多地点天气风险，低价值信号自动进入简报
- 文件活动雷达持续感知 Downloads、Desktop、共享落盘目录和自动化输出
- Apple Mail 未读感知、搜索整理、附件收发与读取、发送、回复、旗标、移动、删除、草稿全链路 action
- macOS Messages 来信感知、会话检索、附件收发，以及 iMessage/SMS/RCS 主动发送与原会话回复
- macOS Contacts 联系人解析、详情读取、创建与增量维护
- Apple Notes 文件夹、笔记搜索、读取、创建、更新与追加
- Apple Shortcuts 能力总线，可发现并运行用户已有的工作、生活与智能家居自动化
- macOS 通用桌面控制，可感知前台应用/窗口/剪贴板并操作没有专用 API 的应用
- Unix Socket 本地控制面，支持后台任务提交、等待、状态和 Connector 能力查询
- 外部内容与可信 Host 指令分区；`trust` 只记录来源，未命中 owner source policy 的外部事件使用最小策略，命中后才获得本机策略明确范围内的有界代办工具
- 多实例/多进程安全的原子 JSON 状态、格式校验与损坏隔离
- 用户级与项目级 `MIMI.md` 持久指令，每轮自动加载且项目级优先
- CLI 与 Agent 共用运行时控制：模型、模式、输出、Session、MCP 和退出均可由对话触发
- 按 Token Budget 裁剪历史、结构化压缩旧上下文和动态上下文组装
- 可检索、可删除的本地长期记忆
- 兼容 Agent Skills 开放规范的发现、激活、资源读取与热重载
- Agents SDK 原生 MCP Client，支持 stdio 与 Streamable HTTP
- MCP 工具、Resources、连接容错、状态检查与热重载
- Markdown/Text 增量索引、Embedding 与混合检索
- 没有 Embedding Key 时自动使用轻量词法检索
- 多步骤 Plan，以及跨重启 Goal、Checkpoint 与 `/resume`
- 所有执行型任务的 Completion Contract 与 Host 终态门控，按真实工具回执、产物、测试和 Plan 状态验收
- 通用 / Plan / Ultra Team 三种有真实工具边界的运行模式
- 单层 SubAgent 与持久 Team task list，支持依赖、原子领取和最多 4 路并行
- owner 默认完整执行；可选 `workspace` / `read-only` 受限部署，Team builder 另受 `task.paths` 强约束
- runId 所有权与副作用执行账本，阻止陈旧 Run 覆盖状态或自动重放本地写操作
- 轻量运行时 Hooks
- Spinner、分块事件、Reasoning Summary 和最终回答流式输出
- 非阻塞输入队列、Esc 安全取消请求和永久用户输入记录
- 从仅答案到完整工具详情的四级终端事件过滤
- 常驻状态栏、内容摘要会话选择器和斜杠命令补全
- Claude Code 风格的低饱和事件配色与终端友好 Markdown 渲染
- 本地 JSONL Trace 和最小 Retrieval Eval

## 架构

```text
src/
├── index.ts              # CLI 与运行事件消费
├── commands.ts           # 斜杠命令解析与执行
├── interactive.ts        # 输入框、队列、选择器与常驻状态栏
├── agent.ts              # 向后兼容的运行时导出
├── config.ts             # 环境配置
├── core/
│   ├── context.ts        # 上下文裁剪、压缩与组装
│   ├── state-file.ts     # 跨实例/进程原子 JSON 状态
│   ├── execution-ledger.ts # 本地副作用执行账本
│   ├── guidance.ts       # 用户级与项目级 MIMI.md
│   ├── session.ts        # JSON 持久会话
│   ├── memory.ts         # 长期记忆及工具
│   ├── plan.ts           # Plan、Goal、Checkpoint 与 Resume
│   ├── team.ts           # Ultra Team 任务、依赖与持久状态
│   └── trace.ts          # JSONL 执行记录
├── extensions/
│   ├── skills.ts         # Skill 发现与按需加载
│   ├── mcp.ts            # MCP Client、状态与生命周期
│   ├── rag.ts            # 文档增量索引与混合检索
│   ├── subagents.ts      # 单层只读 Agent-as-tool
│   └── team.ts           # 多角色有限并发执行器
├── runtime/
│   ├── bootstrap.ts      # CLI / Daemon 共用 Provider 启动
│   ├── run-service.ts    # 统一 Run 生命周期与 durable outcome
│   ├── mimi-agent.ts     # MimiAgent 运行时组合根
│   ├── mimi-host.ts      # 键控 Session actor、每 Session FIFO 与全局并发槽
│   ├── components.ts     # 模型、存储与扩展初始化
│   ├── session-state.ts  # Session 摘要与 best-effort 恢复语义
│   ├── model.ts          # Provider 模型工厂
│   ├── instructions.ts   # 基础指令与模式
│   ├── tool-policy.ts    # 模式、角色与权限工具策略
│   ├── tool-ledger.ts    # Function Tool 副作用去重包装
│   ├── run-outcome.ts    # 完成、取消与 SDK 中断判定
│   ├── control.ts        # Agent 可调用的运行时控制
│   └── hooks.ts          # 生命周期事件总线
├── daemon/
│   ├── store.ts          # SQLite WAL Inbox / Run / Outbox / Schedule / Digest
│   ├── attention.ts      # 注意力预算、静默时段、摘要与主动简报
│   ├── policy.ts         # Event provenance 与 Session 路由
│   ├── dispatcher.ts     # Conversation lane 有界并发可靠事件循环
│   ├── task-tools.ts     # 后台任务委派、查询与取消
│   ├── task-supervisor.ts # 后台任务 OS 子进程监督
│   ├── task-worker-entry.ts # 单任务子进程入口
│   ├── worker-protocol.ts # Kernel / task worker IPC
│   ├── ipc.ts            # Unix Socket NDJSON RPC
│   ├── service.ts        # 服务生命周期
│   └── notifier.ts       # 主动通知通道
├── tools.ts              # 本机及 OpenAI 托管工具
├── terminal.ts           # 终端动画和流式渲染
└── eval.ts               # 最小检索评测
```

运行时分为三个协作层：

```text
CLI / IM / Voice / Schedule / Connectors
  → Kernel（唯一常驻进程）
      SQLite · Attention · lease/retry · Schedule · Connector broker · Outbox
      ├─ Conversation lane
      │   ├─ Session A actor：FIFO ─┐
      │   └─ Session B actor：FIFO ─┴─ 不同 Session 有界并行
      └─ Task lane
          └─ Task supervisor → 独立 OS worker / 独立 Task Session
                                → Event outcome → Outbox 主动通知
```

Kernel 空闲时不会发起模型请求；只有事件通过 Attention 进入执行、用户发来对话或计划任务到期时才启动有界 Agent Run。Conversation actor 是进程内隔离执行单元，不保证每个对话都对应一个 PID；真正需要脱离当前窗口的后台任务才使用独立 OS 子进程。`runtime` 只负责组装和运行，`core` 保存 Agent 状态，`extensions` 提供可插拔能力。详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速启动

要求 Node.js 22.19.0 或更高版本（Daemon 使用内置 `node:sqlite`，直接依赖也以该版本为最低运行环境）。

```bash
git clone https://github.com/Kickflip73/MimiAgent.git MimiAgent
cd MimiAgent
npm install
npm install -g .
mkdir -p ~/.mimi-agent
cp .env.example ~/.mimi-agent/.env
```

使用 OpenAI：

```dotenv
MIMI_MODEL_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.4-mini
```

使用 DeepSeek：

```dotenv
MIMI_MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-pro
```

编辑 `~/.mimi-agent/.env` 填入所选 Provider 的配置，然后启动：

```bash
mimi
```

就这一种启动方式。`mimi` 首次运行会自动初始化并启动后台 Kernel，之后所有终端输入、IM、语音和外部事件都进入同一个 MimiAgent 系统。未显式设置 `MIMI_WORKSPACE` 或兼容的 `AGENT_WORKSPACE` 时，从其他目录再次运行 `mimi` 会继续连接并采用已有 Kernel 的工作区，不会另起一套控制面。不同 Session 可以同时运行；同一 Session 的消息仍按 FIFO 处理。CLI 退出只关闭当前终端，不会关闭 MimiAgent 或它已接手的后台任务。macOS 上只要 Provider Key 保存在 `~/.mimi-agent/.env`（或显式 `MIMI_ENV_FILE`），首次运行还会自动安装用户级 LaunchAgent，使 MimiAgent 在登录后启动并在异常退出后恢复；不需要单独管理服务启动。

`mimi` 默认先进入不落盘的新对话草稿，发送第一条普通消息时才创建真实 Session；如果直接用 `/sessions` 或 `/switch` 切到已有对话，草稿不会留下空 Session。`/model`、`/mode`、`/sessions`、`/history`、`/skills`、`/mcp`、`/index`、`/memories`、`/plan`、`/goal`、`/tasks` 和 `/task` 等命令与长期运行事件共用同一套实现和 FileSession 原始记录。

执行单次任务仍然使用同一个入口：

```bash
mimi "读取 package.json 并介绍这个项目"
```

下面是维护与诊断命令，不是其他启动方式：

```bash
mimi daemon status
mimi daemon doctor
mimi daemon --help
```

首次 `mimi` 会执行幂等初始化：创建权限为 `0700` 的 MimiAgent 数据目录、`0600` 的策略/Connector 配置和本机数据库，并把发布包内的 Connector 目录物化为当前安装位置的绝对路径。macOS 自带的 System、Calendar、Mail、Messages、Contacts、Notes、Shortcuts、Desktop、Browser、Screen 和 Voice Connector 默认启用；需要 Token 或额外数据源配置的大象、QQ、OpenClaw 微信、Radar 等保持关闭。QQ/微信不默认启用 AppleScript、截图、OCR、键盘或点击式 Connector，正式 IM 接入必须使用后台 API/协议桥。后续升级会补齐缺失的默认本机 Connector，并为仍指向同名内置脚本的 Connector 补充新 action；同名内置脚本的旧 `command: "node"` 会迁移成当前安装所用的绝对 Node 路径，避免 launchd 找不到命令。已有 enabled、owner 路径、环境、来源和 action 描述保持不变，自定义 command 也不会被覆盖。`syncTemplateActions: false` 可固定自定义 action 集合。`mimi daemon doctor` 只读检查模型 Key、脚本、系统命令、后台、运行中 Connector、dead letter 和 launchd 状态，不读取邮件、消息或屏幕，也不触发系统授权。

LaunchAgent 的 plist 不保存 API Key，而是读取持久环境文件；只在当前 Shell `export` 的临时 Key 不会被写入磁盘，此时 MimiAgent 仍可在当前登录会话内运行。首次访问邮件、消息、联系人、屏幕等能力时，macOS 可能向实际 Node/Terminal/LaunchAgent 进程请求系统权限；MimiAgent 不再叠加审批层。

常驻模式把事件先持久化再执行。重复来源事件按 `source + externalId` 去重；崩溃中的租约会被恢复；完成回执可避免“Session 已完成但事件事务尚未提交”时重复调用模型；结果和待发送通知在同一 SQLite 事务中提交。入站 IM 等来源自带 reply route 时原路回复；最近 7 天 owner 使用过的 Connector 会按 profile 成为自主简报、告警和巡检的优先回访渠道，过期或不存在时回退 `assistant.json owner.replyRoute`。本地 CLI 和无回复语义的 Webhook 永不使用这个回退，CLI 结果只返回正在等待的 Socket 客户端。`trust` 只是不可由 payload 自报的来源审计标签，不直接授予或拒绝能力：未命中 owner source policy 的 trusted/external/public 事件只保留当前 attempt 的静默投递控制；命中策略后，`access: "reply"` 只允许结合当前人物 Session 形成回复，`access: "work"` 才开放固定的本地工作、Connector 和后台委派工具。旧策略省略 `access` 时安全默认为 `reply`；原本确实用于代办工作、发消息或运行 Shell 的策略需要显式补成 `work`。Task worker 会从仍被保留的原始 conversation Event 重新计算同一授权。外部正文无论 provenance 都只是数据，不能扩大目标、权限、收件人或副作用范围。系统通知默认使用 macOS Notification Center，其他消息渠道通过 `NotifierRegistry` 扩展。

长期数据库默认每 24 小时执行一次有引用保护的历史维护，清理 90 天前的 sent/archived Outbox、已归档 Digest、无引用的终态 Task、对应 Run 和不可变 Event，以及旧 disabled Schedule/checkpoint/audit。queued、running、paused、blocked、dead letter Task、未投递 Outbox、待简报 Digest 和启用 Schedule 永不自动删除。owner 可用 `mimi daemon retry task|outbox <id>` 原 ID 显式重试 dead letter，或归档 Outbox；Event 是不可变事实，不能重试或归档。Daemon 不会自动重放 dead letter。Outbox 是 at-least-once 投递，显式重试在远端确认丢失时可能产生重复消息。可在 `assistant.json maintenance` 调整或关闭；保留期同时是 `source + externalId` 去重窗口，极旧来源项被重新回放时可能再次处理。维护不自动 `VACUUM`，SQLite 会复用释放页面。

`mimi daemon events/runs/outbox/schedule list` 返回不携带大正文的有界管理摘要；需要查看原始 payload、answer、投递内容或完整 prompt 时，使用 `mimi daemon show event|run|outbox|schedule <id>`。这样长期积累的大记录不会挤爆本地 IPC；CLI 的 `/history` 和 `/memories` 则使用带 revision 的分块读取，不静默漏项。

长期在线事件先经过注意力层：环境信号、静默时段消息和超出自治预算的事件会可靠进入摘要池，并在配置时点合并为主动简报；简报继续携带 `external` provenance 和受限策略，不会把其中来源内容洗成 system 指令。高优先级告警和 owner 命令仍及时执行。达到 `urgentPriority`、严格高于当前任务且会被 Attention 执行/通知的事件，可以在模型思考阶段抢占低优先级长任务；工具或外部事务在途时先等其安全结束，紧急事件处理并可靠投递结果后，原任务无失败惩罚续跑。模型连续无进展达到 `execution.runIdleTimeoutMs`（默认 20 分钟）会中止并按普通失败重试；流式输出或 Runtime 进展会刷新计时，Tool 在途时暂停。正常 Daemon 停机也会先等在途 Tool 返回，再无失败惩罚重排队。`assistant.json` 中的 Standing Orders 与 People 私有 context 会附加到 owner/system Run，以及命中 owner source policy 的替身 Run；未授权事件仍可按 alias 派生稳定 Person Session ID，但看不到该 Session 或私人 metadata。Daily Routines 是 owner Event，会按本地时区主动执行晨间规划、晚间收尾和自定义日常检查，并通过 `inspect_mimi_activity` 主动检查自身积压、失败和近期运行状态。非 command 自主运行确认没有新变化、风险、动作或需关注事项时，可调用 `finish_mimi_silently` 安静完成：Event/Run/答案/usage/原因仍保留，只省略通知 Outbox。这些能力复用同一个 Kernel、Session actor 系统与 Event 流，不创建第二套工作流。配置、决策顺序与规则示例见 [docs/ATTENTION.md](docs/ATTENTION.md)。

owner/system 以及命中 owner source policy 的 MimiAgent 事件可使用有界运行自省与 follow-up/watch 工具推进当前事务；未授权事件不会获得这些工具。每个计划持久保存原 Conversation authority、origin Session 和 reply route；到期后进入独立 `mimi-task-*` Session 与 OS worker，不会占住创建计划的对话。Task 在执行时从原始 root 与当前 source policy 重新计算权限：root 缺失或 provenance 不匹配会失败关闭，撤销 external work policy 后不会继续原工作，周期 watch 只保留停止自身的能力，避免无权限轮询。条件监控同 Session 有新事件时立即触发，平时按周期兜底；结束条件成立后通过 `complete_current_mimi_schedule` 自行停止，没有变化时安静完成。用户还可直接说“现在给我汇总一下”，由 `request_mimi_briefing` 原子领取当前摘要并通过既有事件和投递链路送达；说“每天 9 点检查重要邮件”或“删除晚间收尾”时，Agent 会通过 `list_mimi_routines`、`upsert_mimi_routine`、`remove_mimi_routine` 原子管理固定本地时刻的 Daily Routines；Routine 删除、禁用或更新后，已排队的旧版本触发会在执行前失效。也可由 owner 对话管理 Standing Orders、来源规则、注意力规则和 People alias，无需手改 `assistant.json`。替身 Run 不获得这些配置控制工具，不能通过外部正文修改自己的授权。Activity 视图不包含其他 Event 正文、Run 答案、Outbox 内容或 target；一次性唤醒至少延后 5 秒、周期巡检最短 5 分钟、最多保留 100 个启用计划，配置写工具进入事件级副作用账本，崩溃重试不会重复修改。

长事务上下文被压缩或跨渠道继续时，同一 profile 的 owner 在 CLI、IM 和语音等可信入口共享稳定 Session；显式 `sessionKey` 仍可隔离专题事务，但必须符合核心 Session schema，非法值在 IPC 或持久化前直接拒绝。人物和 Routine ID 含点号等非 Session 字符时会稳定哈希为安全 ID。Agent 可用 `inspect_mimi_session_activity` 检索当前 Session 近期做过的事和有界结果；它直接投影现有 Event/Run，不复制状态，也不返回事件原文、其他会话、Outbox 内容或 target。同 Session 的新 owner 命令还能打断同优先级任务，并通过 `cancel_interrupted_mimi_task` 取消被替换的旧任务。

每个 Daemon Run 都获得同一份精简的常驻执行契约：能直接完成就执行，依赖未来状态就建立 follow-up 或有结束条件的 watch，稳定决策与承诺写入 Memory，需要旧进展时恢复当前 Session Activity；自主巡检无变化时静默。外部事件正文始终位于契约之后的不可信数据区。

`get_mimi_settings` 与 `update_mimi_settings` 让 owner 通过对话调整个人画像、时区、静默时段、自治预算、告警阈值、运行超时、历史保留和简报设置。更新使用先读后写的完整快照，不会覆盖上述独立管理的人物、规则、例程和替身策略。需要临时专注时可直接说“免打扰 2 小时”，由 `snooze_mimi` 暂停非紧急自主处理和定时简报，到期自动恢复；当前 owner 命令与紧急事件照常执行，`clear_mimi_snooze` 可提前恢复。

大象、QQ、微信、邮件、新闻和天气等渠道通过隔离的 stdio Connector 或认证 localhost callback relay 接入：Daemon 负责拉起、崩溃退避重启、故障自愈跟踪、事件去重和可靠回传，Connector 只负责渠道协议。MimiAgent 会核对实时能力、跟踪到稳定恢复，并只在无法自愈或影响事务时通知；中断期间结果不确定的外部动作不会自动重放。relay 可保留 actor、conversation 和 `reply:{connector,target}`，让官方服务端回调经 MimiAgent 处理后回到原会话；`notify:false` 可显式关闭结果投递。内置零依赖 `http-action-connector.mjs` 还能从固定 HTTPS relay 按游标拉取事件，并把任意已声明 Action 和回复投回同一 adapter，供微信网关、内部服务、家庭自动化或 SaaS 共用；事件由中心 Inbox 去重，外部事务携带稳定幂等键。连续启动失败会合并成一个故障窗口，不会形成通知风暴。每个 Daemon Run 都获得动态只读 `inspect_mimi_capabilities`，可按精确 `connector` 或渠道 `query` 小范围查看 enabled/online/readiness/action 目录，并用 `set_mimi_connector_enabled` 原子启停已有渠道；它不接触凭证或进程配置。`connector_action` 保持固定短描述，避免每轮重复注入整份渠道目录；执行前先调用能力检查，Manager 在发送时再做最终校验。owner 修改其他配置后可调用 `reload_mimi_connectors`，也可执行 `mimi daemon connectors reload`，均无需重启 Daemon。无效配置或在途事务会保持旧 Connector 在线并快速返回错误。配置示例见 `mimi.connectors.example.json`，协议见 [docs/CONNECTORS.md](docs/CONNECTORS.md)。

仓库内置大象开放平台、QQ NapCat、腾讯 iLink 微信 Bot 桥和一组零依赖 macOS Bridge。QQ 个人号通过 NapCat/OneBot 的 loopback HTTP 与鉴权反向 WebSocket 在后台收发，并可有界读取近期会话、好友/群目录和历史；NapCat 是非官方个人号方案，需自行承担账号风控。macOS 可用 `scripts/install-napcat-macos.mjs` 校验官方 Release digest、QQ 构建、Apple 执行策略和腾讯 Team ID，创建可恢复备份并安装后台 LaunchAgent；推荐将官方 QQ 复制到 MimiAgent 私有目录后通过 `NAPCAT_QQ_APP` 选择，避免修改系统 `/Applications/QQ.app`，安装器会记住该路径。NapCat 启动分支在加载协议端前把 Electron activation policy 设为 `prohibited`；当前 Electron 不支持该 API 时失败关闭，因此不能创建窗口、出现在 Dock 或被激活。系统或私有普通 QQ 仍在运行时也会拒绝启动。微信使用腾讯官方 `openclaw-weixin` Bot 通道，不操作 WeChat.app，但它不是个人微信完整收件箱，不能读取任意联系人和历史。更完整的范围、安装和安全约束见 [Connector 文档](docs/CONNECTORS.md)。`macos-system-connector.mjs` 每分钟读取电池、内存、负载、非 loopback 网络接口和默认磁盘容量，只在低/危急电量、断网/恢复或低磁盘状态边沿唤醒 MimiAgent。`macos-life-connector.mjs` 可查询、创建、改期、修改和取消日程，查询、创建、修改、完成和删除提醒事项，发送系统通知，并主动感知临近日程、改期、删除、提醒变更、完成与逾期；逾期提醒按紧急事件唤醒。临近会议会触发会前材料与冲突检查，确有产出或承诺时可复用 Schedule 在结束后整理纪要、行动项、负责人和截止时间。大象入站事件订阅仍在主干 Thrift/OCTO 服务完成官方回调鉴权并快速确认，再异步转发规范化事件到本机 Webhook；本地端口不对公网开放。

`radar-connector.mjs` 用单个零依赖子进程轮询多个 RSS/Atom feed 和 Open-Meteo 地点。新闻以 `ambient` 进入 Attention 摘要池，命中降水、阵风、高低温或恶劣天气代码阈值时产生 `alert`。配置起点见 `mimi.radar.example.json`。

`file-radar-connector.mjs` 对 Downloads、Desktop、共享收件箱或其他配置目录做有界元数据扫描。同一路径的 size/mtime 连续两次稳定后才成为可去重 external Event，避免读取下载或复制中的半成品；默认入站只分析元数据并通知，读取、转换、改名、移动、归档或外部回复必须由 owner/system Run，或命中 owner 明确 File Radar source policy 的替身 Run 发起。Connector 本身不读取正文、不跟随符号链接、不保存游标。配置起点见 `mimi.files.example.json`。

`macos-mail-connector.mjs` 直接复用 Apple Mail 中已配置的账号和 Keychain，不在 MimiAgent 内保存邮箱密码。它将未读邮件转为可去重 external `alert` Event：白天默认即时判断，静默时段、Snooze 或超过预算时进入简报；无需动作的邮件可静默完成。Connector 提供收件箱搜索、显式历史邮箱搜索、邮箱目录、读取、附件列举/保存、发送、回复、已读、旗标、显式目录移动、删除和草稿 action；默认受限入站不能调用这些 action，owner/system 或命中 owner 邮件 source policy 的替身 Run 可按策略使用。轮询只报告有界预览和附件数量，不自动下载；真正发信始终使用显式 action，不会把无 reply route 的普通邮件 Event 输出误当回信。

`macos-messages-connector.mjs` 只读本机 Messages 数据库来感知新消息、查询会话和列举附件，发送则调用 Messages 的 JXA 接口，不写私有数据库。MimiAgent 可把已下载附件原子保存到显式绝对路径，也可发送有界本地普通文件；轮询只报告附件数量，不自动复制。入站消息作为高优先级 alert 进入事务判断：需要答复时处理结果直接回复同一 iMessage/SMS/RCS 会话，无需答复或已经显式发件时静默结束，依赖对方后续时建立 Watch。实际运行需要给 Node/Terminal 或 LaunchAgent 对应可执行程序授予“完全磁盘访问权限”；首次发送还会触发 macOS 自动化授权。

`macos-contacts-connector.mjs` 按姓名、组织、邮箱或电话查询系统通讯录，返回稳定联系人 ID 和全部候选，供 MimiAgent 再调用 Mail 或 Messages。它也可创建联系人、更新常用字段并追加邮箱或电话；不轮询、不复制通讯录、没有额外依赖。

`macos-notes-connector.mjs` 复用 Apple Notes 现有账号和 iCloud 同步，按需列出文件夹、搜索和读取笔记，并可创建、更新或追加工作记录与生活笔记。它不轮询、不镜像 Notes 数据库；密码保护笔记不尝试解锁，附件只返回元数据。

`macos-shortcuts-connector.mjs` 直接调用系统 `shortcuts` CLI，让 MimiAgent 可以发现并运行用户已有的快捷指令。它支持文本、base64 和多个文件输入，可返回有界 text/base64 stdout 或写入显式绝对输出路径；不实现第二套自动化 DSL。

`macos-desktop-connector.mjs` 通过 System Events 感知前台应用和窗口，并可激活应用、打开 URL/绝对路径、读写文本剪贴板、输入文本、发送 key code 和点击一级菜单项。它让 MimiAgent 能处理没有专用 Connector 的普通桌面应用；剪贴板感知默认关闭，可由 Agent 持久启停并跨重启恢复，启用后首次读取只建立基线，Connector 自己写入的内容不会反向触发新事件。

`macos-browser-connector.mjs` 复用 Safari/Chrome 当前 profile 和已登录会话，提供标签页查询、打开、导航、激活、关闭、刷新、正文读取和 JavaScript DOM 执行。它无浏览器驱动、扩展和新增依赖，不轮询或保存浏览历史；页面正文与脚本结果始终标记为不可信外部数据。详细动作和系统设置见 [docs/CONNECTORS.md](docs/CONNECTORS.md#macos-browser-bridge)。

`macos-screen-connector.mjs` 使用系统 `screencapture` 和 Vision Framework 读取原生应用、画布、远程桌面等非 DOM 界面的屏幕文字。它支持显式保存 PNG、OCR 已有图片，以及临时截图后 OCR 并立即清理；默认不持续录屏、不轮询屏幕、不保存图片历史，也不增加云端 OCR 依赖。

`macos-voice-connector.mjs` 使用 Speech/AVFoundation 和系统 `say` 提供免键盘交互：可选持续监听“MimiAgent”开头的 owner 命令、转写已有音频、列出声音，并把命令结果经可靠 Outbox 自动朗读。监听默认关闭，但一次 `listener_start/stop` 会原子保存并跨 Connector/Daemon 重启恢复；不保存麦克风音频，非唤醒语音不会形成 Event，重复命令会短期抑制，朗读期间 listener 自动暂停以避免自我唤醒。

临时集成也可设置 `MIMI_WEBHOOK_PORT` 与 `MIMI_WEBHOOK_TOKEN` 开启仅监听 localhost 的认证 Webhook。所有 Webhook 来信固定记录为 external provenance；默认使用受限事件策略，只有命中 owner 明确配置的 source policy 才获得对应代办权。

查看命令帮助和版本不需要 API Key：

```bash
mimi --help
mimi --version
```

MimiAgent 优先从 `~/.mimi-agent/.env` 读取模型和 API Key。需要指定其他文件时使用 `MIMI_ENV_FILE`，兼容 `DOTENV_CONFIG_PATH`。

`mimi` 是唯一安装、文档化和支持的终端命令。npm 包名仍为 `mimi-agent`，但它只是包标识，不是另一条 shell 命令。

SQLite、Socket、launchd、Tool ID、OpenClaw plugin ID 和配置示例均使用 MimiAgent 命名，统一属于同一个 MimiHost。

项目内的 `.env` 和运行目录 `.mimi-agent/` 已被 Git 忽略。不要将真实 API Key 写入代码、配置示例或提交记录。

### 可选配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MIMI_CONFIG_VERSION` | `3` | 配置模板版本；保留此项可区分主动权限限制与旧模板默认值 |
| `MIMI_MODEL_PROVIDER` | `openai` | 模型 Provider：`openai` 或 `deepseek` |
| `MIMI_MAX_TURNS` | 不限制 | 可选的单次 Agent 运行轮数上限；默认由 Goal/Plan 状态、取消、空闲超时与上下文预算控制 |
| `MIMI_HISTORY_LIMIT` | `40` | Token Budget 之外的历史条目上限；从完整用户轮次开始截取 |
| `MIMI_CONTEXT_WINDOW` | 按模型 Profile | 全局覆盖模型上下文窗口；通常无需设置 |
| `MIMI_OUTPUT_TOKEN_RESERVE` | 按模型 Profile | 全局覆盖输出 Token 预留与请求 `maxTokens` |
| `MIMI_OUTPUT_LEVEL` | `tools` | 启动时的事件展示等级：`answer`、`thinking`、`tools`、`trace` |
| `OPENAI_MODELS` / `DEEPSEEK_MODELS` | 内置常用模型 | `/model` 选择器追加的逗号分隔模型列表 |
| `MIMI_SESSION` | 未设置 | 显式进入已有 Session；未设置时 CLI 使用首次发言才落盘的新对话草稿 |
| `MIMI_MODE` | `general` | 启动模式：`general`、`plan`、`ultra` |
| `MIMI_PERMISSION_MODE` | `trusted` | 本机 owner 默认完整执行；陌生工作区可显式选择 `workspace`，纯检查可选择 `read-only` |
| `MIMI_TEAM_MAX_CONCURRENCY` | `4` | Ultra Team worker 并发上限，运行时强制不超过 4 |
| `MIMI_SESSION_MAX_CONCURRENCY` | `4` | Session actor 池并发上限，范围 `1～16`、同 Session 仍 FIFO；task worker 复用该值但硬限制最多 `8` 个 |
| `MIMI_WORKSPACE` | 首次启动时的当前目录 | 文件、Skill 和知识库的工作区；未显式配置时，后续 CLI 采用已有 Host 的工作区 |
| `MIMI_DATA_DIR` | `<workspace>/.mimi-agent` | 会话、记忆、计划、索引和 Trace |
| `MIMI_DAEMON_DATA_DIR` | `~/.mimi-agent/daemon` | 数据库、Socket 与日志 |
| `MIMI_CONNECTORS_CONFIG` | `<MIMI_DAEMON_DATA_DIR>/connectors.json` | 隔离子进程 Connector 配置 |
| `MIMI_ASSISTANT_CONFIG` | `<MIMI_DAEMON_DATA_DIR>/assistant.json` | 用户画像、Standing Orders、静默时段、预算、规则与主动简报配置 |
| `MIMI_WEBHOOK_PORT` | 未启用 | localhost 认证 Webhook 端口 |
| `MIMI_WEBHOOK_TOKEN` | 未设置 | Webhook Bearer Token，启用时至少 24 字符 |
| `MIMI_SKILLS_DIR` | `<workspace>/skills` | Skill 根目录 |
| `MIMI_MCP_CONFIG` | `<workspace>/mcp.json` | MCP Server 配置文件 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | RAG Embedding 模型 |
| `MIMI_ENV_FILE` | 自动选择 | 显式指定统一环境配置文件 |

通用 `AGENT_*`、模型与 MCP 变量仍按明确白名单作为后备别名。`MIMI_CONFIG_VERSION=2` 用于区分显式 `workspace` 限制与早期模板默认值。

## 会话与上下文

默认 `mimi` 连接常驻 MimiAgent 后展示一个仅存在于当前 CLI 内存中的新对话草稿，不读取旧对话，也不创建 Session 文件。第一条普通消息被后台接受后，草稿 ID 才成为真实 Session；在此之前执行 `/exit`，或用 `/sessions`、`/switch` 进入已有 Session，都不会留下空会话。全部内置命令通过本地 Socket 读写同一个 Kernel；`/new` 重新准备一个草稿，`/switch` 只选择已存在的 Session actor，不创建第二个控制面。`/exit` 只关闭终端，Esc 会请求后台安全取消当前 Task；若外部 Tool 正在执行，会先等待其结果落账再结束，不把不确定事务当作可重放失败。

一个 `MIMI_DAEMON_DATA_DIR` 对应一个常驻 Kernel 和一个绑定工作区。未显式设置 `MIMI_WORKSPACE` 或 `AGENT_WORKSPACE` 时，CLI 从任意目录连接都会采用该 Kernel 已绑定的工作区；显式设置后仍会严格校验，避免把命令交给错误的工作区。要显式切换工作区时，先停止该后台再从新工作区启动，或为不同工作区设置不同的 `MIMI_DAEMON_DATA_DIR`。`MIMI_SESSION`（兼容 `AGENT_SESSION`）会选择 CLI 首次连接的 Session；未设置时使用稳定 Owner Session。

内置命令：

| 命令 | 作用 |
|---|---|
| `/model [name]` | 查看或切换当前 Provider 下的模型；无参数时使用选择器 |
| `/mode [name]` | 在 `general`、`plan`、`ultra` 之间切换 |
| `/output [level]` | 切换终端执行事件的展示详细度 |
| `/new [id]` | 准备一个首次发言才落盘的新对话草稿 |
| `/sessions` | 按内容摘要列出最近对话，使用 ↑↓ 和 Enter 切换 |
| `/switch <id>` | 切换已有会话 |
| `/history` | 查看当前完整历史 |
| `/clear` | 清空当前会话 |
| `/status` | 查看模型、会话、Skills、Memory 和 MCP 状态 |
| `/skills [reload]` | 列出或重新扫描 Agent Skills |
| `/tools` | 列出当前可用工具 |
| `/mcp [reload]` | 查看状态或重新连接 MCP Server |
| `/context` | 查看历史、记忆和计划用量 |
| `/compact` | 归档较早上下文并保留最近两轮；原始 Session 不删除 |
| `/instructions` | 查看当前加载的 `MIMI.md` |
| `/memories` | 列出长期记忆 |
| `/plan` | 查看当前任务计划 |
| `/team` | 查看当前 Ultra Team 子任务、依赖、负责人和结果 |
| `/tasks [limit]` | 查看最近的持久后台任务，默认 20、最多 50 条 |
| `/task <id>` | 查看一个后台任务的目标、状态、工作进程、最近进度、结果与错误 |
| `/task pause <id>` | 在安全边界暂停 queued/running 后台任务 |
| `/task resume <id> [context]` | 继续 paused/blocked 任务，可补充必要上下文 |
| `/task cancel <id> [reason]` | 取消 queued/running/paused/blocked 后台任务 |
| `/goal [objective]` | 查看或设置跨多轮长期目标 |
| `/resume` | 根据 Checkpoint、Goal、Plan 与 Team 状态进行 best-effort 续跑 |
| `/index [path]` | 构建 RAG 索引，默认 `knowledge/` |
| `/retry` | 重新执行上一条用户输入 |
| `/help` | 查看全部命令 |
| `/exit` | 退出 |

完整会话保存在当前唯一数据根 `.mimi-agent/sessions/`。草稿不在该目录创建文件；`/sessions`、`/switch` 和显式 `MIMI_SESSION` 只选择已有 Session，`/new` 只替换内存草稿。每个真实 Session 独立保存 SDK transcript、mode、model、输出等级、最近运行检查点和上下文压缩档案；列表标题会综合多轮用户消息提炼并随主题演进，而不是复制第一句话。切换后按时间回放原始用户/助手消息，工具调用与结果仍保留在 FileSession 中。默认启动草稿不读取历史，已有 Session 快照只返回有界最近对话；`/history` 会通过多个小型本地 RPC 分块重组完整权威历史，避免长期 Session 超过 IPC 帧上限。若上次运行中断，底部显示恢复点和 `/resume` 入口。

发送给模型的有效上下文分四层管理：较早 Tool Result 先做 microcompact；超过 `MIMI_HISTORY_LIMIT`（兼容旧 `HISTORY_LIMIT`）或 Token Budget 后把旧完整轮次持久化为 context archive；`/compact` 可主动执行 full compact 并保留最近两轮；仍超预算时才按完整用户轮次做 PTL truncation。窗口由当前模型 Profile 决定，切换或恢复模型时同步更新；完整预算包含动态 Instructions、历史、当前输入、Function Tool Schema、协议安全余量和输出预留，输出预留同时作为模型请求的 `maxTokens`。压缩只改变模型视图，不覆盖、删除或伪造原始 transcript。`/context` 会区分请求前估算、Provider 返回的上次请求实际 usage 与整轮累计 usage。

每轮开始即写入带 runId/owner 的 `running` checkpoint，所有进展与终态写入都做 runId 比对；旧 Run 不能覆盖新 Run，成功 Run 也不会被迟到的失败回调翻转。统一 CLI 中，Esc 只向后台请求取消当前 Event；若外部 Tool 正在执行，Dispatcher 会等待它到达安全边界并完成结果落账，再中止模型并把 Host Run 记为 `interrupted`，不会直接杀掉正在执行的 Shell。`/resume` 合并 checkpoint、Goal、Plan 与 Team 状态，先核对工作区再发起新一轮任务；它是 best-effort 任务续跑，不声称能从任意模型或工具指令点精确恢复。

默认 CLI 交互不会阻塞输入：MimiAgent 执行时仍可继续提交消息。当前窗口指向同一 Session 的消息进入 FIFO 队列并依次执行；另一个窗口选择不同 Session 后，可在 `MIMI_SESSION_MAX_CONCURRENCY` 限制内同时运行，不必等待前一个 Session 结束。输入框支持多行编辑：`Shift+Enter` 插入换行，`Command+←/→` 跳到当前行首/行尾，只有手动 `Enter` 才发送；终端 bracketed paste 中自带的换行只会进入编辑区，不会触发提交。按 `Esc` 会请求后台在外部 Tool 的安全边界取消当前 Event，队列中的后续消息不受影响。长程或多阶段任务通过 `update_plan` 建立阶段任务，当前会话的完成数、当前步骤和最多 5 条附近任务会实时显示在输入框上方；长描述保持单行省略，全部完成后折叠为一行。输入 `/` 会展示命令面板，使用黑色活动光标配合 `↑` / `↓` 选择、`Tab` 补全。`/new`、`/clear` 会清理终端并保留项目顶部信息；会话切换则清理当前画面、恢复顶部信息、任务进度并回放目标会话的历史消息。

简单问答、短操作以及你明确要在当前窗口看到结果的任务，会留在 Conversation actor 中流式执行。长程、大型、多阶段、持续等待或你明确无需立即结果的任务，主 MimiAgent 会调用 `delegate_background_task`：任务写入 SQLite 后立即返回 `taskId`，当前对话恢复可用，`TaskProcessSupervisor` 再用独立 Node.js 子进程和独立 Task Session 执行；到期 Schedule 与 Daily Routine 也复用同一 Task lane，而不是占用来源 Conversation。默认 `workspaceAccess=write`，写任务独占工作区；明确声明 `read` 的分析任务使用确定性只读工具，可与其他只读任务并行。Task 一旦被接受就不会因 snooze、静默时段或 Attention 预算被转成 Digest；这些设置控制的是新事件是否值得接受，不会吞掉执行队列。Task 内不再递归创建 durable 子任务；大型可拆分任务在同一 worker 内用有界 Ultra Team 汇总。只有 owner conversation root 的 write Task 可执行 Connector action；外部 source-policy work Task 不会看到必然被 Broker 拒绝的 action 工具，但完成结果仍由 Outbox 原路返回。发起 CLI 即使已退出，任务仍继续；完成结果由 Outbox 主动发往原渠道或系统通知。若任务确实缺少必要输入，它会持久化为 `blocked` 并主动问你，补充上下文后从原 Task Session 继续。运行中执行 `/task pause` 会先返回“已请求暂停”，并在当前 Tool 完成后的安全点落成 `paused`；pause/cancel 控制会在回复 CLI 前先写入 SQLite，即使 Kernel 或 worker 随后崩溃，重启恢复也不会继续执行已取消任务，已暂停任务仍保持 `paused`。不要为了“并行”把普通短任务强制后台化；用 `/tasks`、`/task <id>`、`/task pause <id>`、`/task resume <id> [context]` 和 `/task cancel <id>` 管理真正的后台工作。

输入区固定在终端交互区域的最底部，以 `┊> ` 提示符展示。输入区正上方是常驻状态栏：空闲时显示就绪状态，执行时显示动态 Spinner，并持续展示当前模式、模型以及估算上下文 Token/窗口。如果存在等待消息，更上方会常驻显示 FIFO 队列中的每条对话内容，过长内容以 `...` 省略，消息开始执行后自动从队列区域移除。

用户提交的内容不会随输入框清空而消失：空闲消息开始执行时会立即以 `> 内容` 写入终端对话历史；执行期间提交的消息先常驻等待队列，轮到执行时再移入历史区，避免插入并打断上一条流式回答。

内置模式不仅改变提示词，也改变可用工具：`general` 是默认模式，以最短可靠路径处理大多数任务；`plan` 只保留读取、检索、计划和模式切换能力，先与用户形成完整方案，明确批准后下一轮才能进入实施；`ultra` 为大型代码和长程任务提供 task list 与多角色并行执行。`/mode` 无参数时可通过选择器切换，模型也可调用 `switch_mode`。

Ultra Team 由主 Agent 担任 lead，将工作拆成 2～6 个 `explorer / architect / builder / tester / reviewer` 子任务。`run_team` 每波执行 1～4 个 ready task：单任务可推进依赖流水线，多任务可有限并行。整波任务原子领取；builder 必须声明负责路径且只能写入这些路径，所有 worker 默认都没有 Shell，tester/reviewer 保持只读。task list 按 Session 持久化并随 `/resume` 恢复，租约中断的任务会变为 failed，必须显式重试。

终端事件支持四个轻量输出等级，可通过 `/output` 选择或使用 `MIMI_OUTPUT_LEVEL`（兼容旧 `OUTPUT_LEVEL`）设置启动默认值：

| 等级 | 展示内容 |
|---|---|
| `answer` | 只流式显示最终答案 |
| `thinking` | 增加模型公开的思考过程 |
| `tools` | 增加工具调用参数摘要和截断后的结果；默认等级 |
| `trace` | 展示输入任务、思考、工具参数和工具完整结果 |

`trace` 适合学习和排查 Agent 执行过程，例如 `read_file` 会显示读取到的文件内容。为避免意外输出超大内容，单条详情最多展示 20000 个字符；此限制只作用于终端显示，不改变工具实际返回给模型的数据。

`/model` 默认展示当前 Provider 的常用模型，也会合并 `OPENAI_MODELS` 或 `DEEPSEEK_MODELS` 中以逗号分隔的自定义模型名称。`/model <name>` 可以直接切换未列出的兼容模型；切换保存到当前 Session，关闭 CLI 后同一 Session 的后台与渠道任务继续使用它，但不会修改 `.env` 或其他 Session。

## 终端展示

交互输出使用低饱和前景色和简洁符号区分事件，并在事件块之间保留空行。下面是 `trace` 详细等级的示例：

```text
> 读取 package.json 并介绍项目

✦ 思考
需要读取项目配置。

● 工具  read_file
  {"path":"package.json"}

└ 结果  read_file
  {"name":"mimi-agent", ...}

◆ 回答
项目配置已读取。

✓ 完成  2.1s
```

默认 `tools` 等级只显示思考、工具名称和最终答案，不会展示上例中的工具参数与 `└ 结果` 内容。

颜色只在 TTY 中启用，管道和日志输出不会包含 ANSI 控制符。最终回答会定时增量刷新，并按行渲染 Markdown：标题不再显示 `###`，列表、引用、代码块、表格、粗体、行内代码和链接会转换为适合终端阅读的形式。

Agent 的基础 Instructions 使用“终端优先”输出约束：普通回答默认不超过约 12 行，优先采用少量紧凑段落，避免 Markdown 表格、连续标题、频繁空行和手工空格对齐；列表通常不超过 5 项且每项保持单行。渲染层还会压缩异常的横向空白和连续空行，作为模型输出不稳定时的显示兜底。用户明确要求详细内容时，模型仍可按任务需要展开。

## MIMI.md 持久指令

MimiAgent 使用两层纯 Markdown 指令文件，把需要在每次任务中生效的约定附加到 Agent 上下文：

```text
~/.mimi-agent/MIMI.md   用户级：个人偏好，适用于所有工作区
<workspace>/MIMI.md     项目级：项目约定，优先级高于用户级
```

两个文件都会在每一轮任务开始前重新读取，修改后无需重启或新建会话。若两层存在冲突，项目级 `MIMI.md` 生效；主 Agent 和受控 SubAgent 都能看到这些指令，但 SubAgent 的只读边界不会被覆盖。空文件会被忽略，单文件注入上限为 20000 字符。

适合放入 `MIMI.md` 的内容包括构建与测试命令、代码规范、项目结构、常用工作流和回答偏好。一次性的任务要求应留在当前对话，可复用的多步骤流程应写成 Skill，事实和用户偏好则可交给 Memory。仓库中的 [MIMI.md](MIMI.md) 可作为项目级示例。

该设计参考了 [Codex AGENTS.md](https://developers.openai.com/codex/concepts/customization#agents-guidance)、[Claude Code CLAUDE.md](https://code.claude.com/docs/zh-CN/memory) 和 [OpenClaw workspace bootstrap](https://docs.openclaw.ai/agent-workspace) 的持久上下文模式，同时只保留 MimiAgent 当前需要的两层结构。

## Agent 自管理与自修改

CLI 斜杠命令和模型工具调用复用相同的 MimiAgent 运行时方法。用户既可以输入 `/model`，也可以直接说“切换到某个模型”；Agent 会实际调用工具，而不是只回复操作步骤。

| CLI 能力 | Agent 工具 |
|---|---|
| `/status`、`/context`、`/tools` | `runtime_status` 与现有状态工具 |
| `/model`、`/mode`、`/output` | `switch_model`、`switch_mode`、`set_output_level` |
| `/sessions`、`/history` | `list_sessions`、`get_session_history` |
| `/switch`、`/new`、`/clear` | `switch_session`、`new_session`、`clear_session` |
| `/skills`、`/mcp`、`/index` | `list_skills`、`reload_skills`、`reload_mcp`、`index_knowledge` |
| `/memories`、`/plan`、`/goal` | Memory、Plan 和 Goal 工具 |
| `/exit` | `request_exit` |

模型和模式切换从下一轮生效；Session、输出等级和退出在当前回答完整写入后生效，避免留下孤立 Tool Call。`/retry` 与 `/resume` 属于重新发起一轮对话的 CLI 入口，Agent 在当前轮中分别通过重试工具和 Goal 工具完成相同语义，不递归启动自身。

`runtime_status` 同时返回当前工作区、运行时代码目录和执行档位，CLI `/status` 会明确显示当前模式下 Shell 是否真的可用。本机 owner 默认是 `trusted`，可直接使用当前操作系统用户的 Shell；`workspace` 与 `read-only` 仅用于用户主动要求收紧的部署。CLI 连接后台时会同时核对协议、工作区和实际执行档位；旧 launchd 即使固化过 `workspace`，也只会在空闲时被安全替换，不会继续伪装成已升级实例或打断在途事务。

## 长期记忆

会话保存“发生过什么”，记忆保存“以后仍有价值的信息”。普通 transcript、摘要、Plan、Team、mode 和模型都严格留在各自 Session；MimiAgent 会主动把稳定的 owner 偏好、事实、决策和承诺写入 `remember`，无需为每条记忆请求确认。新记录带 `recordedAt`、来源 Session，并在 Daemon 运行中附带 Event ID/source/trust/person/actor/conversation，便于检查来源和跨渠道召回；旧版只有 `confirmedAt` 的记录继续可用，历史无标记 Memory 不会因升级突然跨 Session 注入。单条正文最多 2000 字符、可用记录最多 1000 条。内置文件与 RAG 工具不会读取或索引 `.mimi-agent` 私有运行数据；默认 `trusted` Shell 等同当前操作系统用户权限，因此能访问该用户本来可访问的运行数据。Agent 可调用：

- `remember`：保存偏好、事实、决策或待办
- `recall`：搜索相关记忆
- `list_memories`：列出记忆
- `forget`：删除指定记忆

用户明确说“记住……”时 Agent 一定会使用 `remember`；即使没有这句话，Agent 也会在判断信息未来仍有价值时主动记录。明确说“不要记住”会确定性阻止本轮写入；瞬时信息、未经验证的外部陈述、密码和密钥不应保存。记忆保存在 `.mimi-agent/memories.json`，并在后续相关问题中自动检索。

## Skill

每个 Skill 是一个目录和 `SKILL.md`：

```text
skills/code-review/SKILL.md
```

```md
---
name: code-review
description: 审查当前代码变更
---

1. 获取 git diff。
2. 阅读相关文件。
3. 运行测试并输出问题。
```

MimiAgent 遵循 Agent Skills 的渐进披露方式：启动时只暴露名称、描述和位置；匹配任务后调用 `use_skill` 激活完整说明，再通过 `read_skill_resource` 按需读取 `references/`、`scripts/` 或其他文本资源。YAML 元数据会按开放规范校验，无效 Skill 只产生诊断，不阻断其他 Skill。修改后执行 `/skills reload` 即可生效。

内置 Skill 工具：`use_skill`、`read_skill_resource`、`list_skills`、`reload_skills`。仓库保留 `code-review`、`research` 和 `web-research` 三个精简示例，用户可在工作区自由添加更多 Skills。

## MCP

`mcp.json` 默认不启动任何 Server。复制示例即可接入 filesystem MCP：

```bash
cp mcp.example.json mcp.json
MIMI_TRUST_WORKSPACE_MCP="$(pwd)" mimi
```

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "."
    }
  }
}
```

MimiAgent 同时接受 `servers` 和主流的 `mcpServers` 配置键。stdio Server 使用 `command/args`；远程 Server 使用 `type: "http"` 和 `url`，可通过 `${ENV_NAME}` 引用 Header 环境变量。工作区 MCP 必须用 `MIMI_TRUST_WORKSPACE_MCP=<工作区绝对路径>` 明确信任整份配置；完成这一次配置授权后，owner 可直接使用其中声明的 stdio/HTTP 工具，不再叠加第二个权限开关。不要信任来源不明的仓库配置。工具发现、调用和协议通信直接交给 Agents SDK，不重复实现 MCP 协议。

单个 Server 连接失败不会阻断 MimiAgent 启动。`/mcp` 会展示传输类型、工具数和错误，`/mcp reload` 可重新连接。owner 可使用已显式信任配置中的 MCP Tools；Plan 和 external/public 事件只保留受控的只读能力，不继承 MCP Server Tools。

## RAG

将 Markdown 或文本文件放到 `knowledge/`，然后在交互模式执行：

```text
/index knowledge
```

RAG 流程：

```text
读取文档 → 切片与内容摘要 → 复用未变化 Embedding → JSON 索引 → 向量/词法混合检索 → 注入上下文
```

如果配置了 `OPENAI_API_KEY`，默认使用 `text-embedding-3-small`；没有 Key 或 Embedding 请求失败时自动回退到词法相似度，因此 DeepSeek-only 环境也能运行。知识库不会自动跨 Session 注入，只有模型在当前任务中显式调用 `search_knowledge` 时才执行向量/词法混合检索。重新索引会按内容摘要和 Embedding 模型复用未变化的向量；并发提交通过文件锁保持完整，最后完成的整份索引原子替换旧版本，不依赖进程内缓存。默认权限拒绝索引工作区外或 `.mimi-agent` 私有运行数据。

## Plan、Goal、Ultra Team、Trace 与 Eval

复杂任务使用 `update_plan` 管理当前步骤：阶段开始前标记 `running`，结束后立即更新为 `completed` 或 `failed`，再推进下一阶段。Session、mode、model、运行状态和 Plan 当前进度会作为紧凑会话状态注入每轮模型上下文；`update_plan` 返回的完整列表则是本轮后续推理的权威进度。需要跨多轮或跨重启时使用 `set_goal`，并通过 `update_goal` 保存状态、checkpoint 和 next action。`/resume` 会从持久状态生成恢复输入。两者共享当前唯一数据根中的 `plans.json`（新安装通常为 `.mimi-agent/plans.json`），不会产生重复的 Todo 系统。

通用模式可将独立研究或审查交给 `delegate_research`、`delegate_review`；Plan 与 Ultra 还提供只读 `delegate_architecture`。Ultra 的 `set_team_tasks` 与 `run_team` 才会启动 builder/tester 等角色。SubAgent 不继承 MCP、不包含委派工具，最终整合仍由主 Agent 负责。它们是当前 Run 内等待结果的 Runner，不是后台任务，也不会让当前对话提前返回。只有 `delegate_background_task` 会创建持久 Event、独立 Task Session 和 OS 子进程，并通过 Outbox 异步通知。委派时可选 `executor: "codex"` 使用本机 Codex CLI；Codex 缺失或失败时同一 Event 自动回到 Mimi 执行，Codex 结果也必须由 Mimi 在真实工作区独立验收，因此没有 Codex 时核心能力不受影响。Ultra Team 借鉴 [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) 的 lead、共享任务和 mailbox 思想，但只保留本地 task list、依赖与有限并发，不引入复杂编排服务。

运行生命周期、SubAgent 和 Team worker 事件通过轻量 Hooks 写入 `.mimi-agent/traces/<session-id>.jsonl`。Trace 只记录公开运行事件与公开 reasoning summary，不保存模型隐藏思维链。

运行类型检查、测试和最小 RAG 评测：

```bash
npm run check
npm test
npm run eval
```

需要 API Key 的可选 Agent 行为评测会验证模型是否真实激活 Skill、调用 SubAgent、切换模式并执行 Ultra Team wave：

```bash
npm run eval:agent
```

## 内置工具

| 类别 | 工具 |
|---|---|
| 文件 | `read_file`、`write_file`、`edit_file`、`apply_patch`、`move_file`、`list_directory`、`search_files`、`inspect_changes` |
| 系统与网络 | `run_shell`、`http_request`、`web_search`、`current_time`、`calculate` |
| 记忆 | `remember`、`recall`、`list_memories`、`forget` |
| Skill | `use_skill`、`read_skill_resource`、`list_skills`、`reload_skills` |
| RAG | `search_knowledge`、`index_knowledge` |
| 验收 / Plan / Goal | `prepare_task`、`finish_task`、`update_plan`、`show_plan`、`set_goal`、`update_goal`、`show_goal` |
| 后台任务 | `delegate_background_task`、`list_background_tasks`、`inspect_background_task`、`pause_background_task`、`resume_background_task`、`cancel_background_task`、`request_background_task_input`（按事件策略提供） |
| SubAgent | `delegate_research`、`delegate_architecture`、`delegate_review`（按模式提供） |
| Ultra Team | `set_team_tasks`、`show_team_tasks`、`claim_team_task`、`update_team_task`、`retry_team_task`、`run_team` |
| OpenAI 托管 | `code_interpreter`，以及 Provider 支持时的托管能力 |
| MCP | Server Tools、`list_mcp_resources`、`read_mcp_resource` |

文件工具保持小而可组合：`list_directory` 支持有界递归和 glob；`read_file` 保持默认全文字符串兼容，并在分段读取或显式请求元数据时返回 SHA-256；`search_files` 优先使用 ripgrep，并支持纯路径清单、正则、glob、大小写和上下文行，不可用时回退内置搜索；`edit_file` 负责精确局部替换；`apply_patch` 在校验全部 unified-diff hunk 与可选旧文件摘要后写入，当前不处理删除，重命名继续使用 `move_file`；`inspect_changes` 只读返回有界 Git status、diffstat 和 diff，并排除 MimiAgent 私有运行数据。更复杂的 Git、数据库或业务能力应优先通过 Skill、MCP 或现有 Shell 工具组合，而不是继续堆内置工具。

## 有意保留的边界

MimiAgent 不追求复刻大型 Agent 平台的全部能力。当前不在运行内核中实现 Web UI、渠道 SDK、托管式消息网关、分布式任务、任意深度多 Agent 图、复杂工作流 DSL、企业向量数据库、完整 HITL 审批平台或容器集群；Task worker 只是同一台机器上的有界 OS 子进程，外部渠道通过隔离 Connector 接入，其余能力可由 MCP、Skill 或外围系统组合。

本机 owner 默认使用当前操作系统用户权限，不增加逐任务审批。`workspace` 会关闭 Shell、通用网络写入和未登记工具，`read-only` 再关闭本地文件写入；这两个档位只在用户显式选择时生效。owner/system 可使用已配置的 Connector 和已明确信任的 MCP；external/public 默认由最小事件策略隔离，只有命中 owner source policy 才获得不含配置控制与未知 MCP 的有界代办工具，Plan 模式始终只读。

## 项目文档

- [架构与设计不变量](docs/ARCHITECTURE.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [版本记录](CHANGELOG.md)

欢迎提交 Issue 和 Pull Request。新增能力应优先帮助用户完成真实工作，同时保持本地优先、模块边界清晰和依赖克制。

## License

[MIT](LICENSE)
