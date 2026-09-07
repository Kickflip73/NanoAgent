# MimiAgent

一个 7×24 小时在线、本地优先的全能个人 Agent：持续接收工作、生活和外部世界的事件，主动处理事务，并只在恰当时机打扰你。

MimiAgent 使用 OpenAI Agents SDK 作为运行内核。CLI 对话与长期运行服务是同一个系统的两种入口，共享模型、Session、MemoryHub、Skills、MCP、任务恢复和运行控制。唯一常驻 Kernel 负责可靠 Event/Task、Attention、Schedule、Connector broker 和主动通知；Conversation 层按 Session actor 并行；无需当前窗口等待的长任务先持久化，再由独立 OS 子进程执行。编排层仍提供受控 SubAgent 与有限并发 Team，同时保持 TypeScript 内核轻量、直接可读。

> 本机 owner 只需选择 Safe、Workstation、Full Owner 三档 Security。Full Owner 默认拥有完整执行能力且不叠加逐动作审批；Workstation 允许工作区写入和沙箱 Shell，但不允许 Connector 外部事务、Computer Use 或受信 MCP；Safe 只读。Plan 模式固定只读；外部事件正文始终是不可信数据。

## 为什么是 MimiAgent

MimiAgent 不是一次性工具调用样例，也不想变成重量级工作流平台。它要成为可日常使用的本地通用 Agent，同时把任务拆分、角色隔离、依赖调度和有限并发沉淀为可复用的轻量编排能力。

## 核心能力

- OpenAI Agents SDK 驱动的 Agent Loop
- 同一 Daemon 内按 Session、场景、SubAgent、TeamTask 和 Media WorkUnit 独立路由模型
- OpenAI Responses、OpenAI-compatible、Anthropic Messages 与 Google Generate Content adapter
- 持久化多轮会话，可新建、切换和恢复
- 不同 Session actor 有界并行、同一 Session 严格 FIFO，多个不同 Session 的对话窗口互不阻塞
- 长程、大型和持续型任务持久委派到独立 OS 子进程，当前对话立即恢复可用，终态主动通知
- MimiAgent 守护进程、可靠事件 Inbox/Outbox、定时唤醒与 macOS 主动通知
- 可配置静默时段、自治预算、事件规则、摘要池与定时主动简报
- 可热重载 Standing Orders，按来源、人物和会话执行长期替身决策
- owner-managed People aliases，把同一人物的邮件、IM 和群聊事件统一到连续 Session 与长期记忆
- owner 对话内可创建一次性后续唤醒和周期巡检，支持查询、取消与崩溃重试去重
- 高层业务工具 + Effective Capability Snapshot；内部 Connector action 不进入模型目录
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
- 用户级 `MIMI.md` Soul、`PREFERENCES.md` 行为偏好与层级化 `AGENTS.md` / `CLAUDE.md` 项目开发指令，分层加载且不授予权限
- CLI 与 Agent 共用运行时控制：模型、模式、输出、Session、MCP 和退出均可由对话触发
- 按 Token Budget 裁剪历史、结构化压缩旧上下文和动态上下文组装
- 统一 MemoryHub：L0 Evidence、L1 Atom、L2 Scene/Topic、只读 L3 Personal Context，支持来源下钻、纠正、冲突、过期与遗忘
- 兼容 Agent Skills 开放规范的发现、激活、资源读取与热重载
- Agents SDK 原生 MCP Client，支持 stdio 与 Streamable HTTP
- MCP 工具、Resources、连接容错、状态检查与热重载
- SQLite FTS5/BM25 + `sqlite-vec` vec0 + RRF 混合检索；Vec、Embedding 或 reindex 异常时自动回退词法通道
- 多步骤 Plan，以及跨重启 Goal、Checkpoint 与 `/resume`
- 跨会话查询对话、后台及定时任务结果，复用已有文件；中断检查点保留有界工具进度
- 所有执行型任务的 Completion Contract 与 Host 终态门控，按真实工具回执、产物、测试和 Plan 状态验收
- 通用 / Plan / Ultra Team 三种有真实工具边界的运行模式
- 单层 SubAgent 与持久 Team task list，支持依赖、原子领取和最多 4 路并行
- 三档 Security：Safe 只读、Workstation 本机工作、Full Owner 完整执行；Team builder 另受 `task.paths` 强约束
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
│   ├── guidance.ts       # Mimi Soul 与 AGENTS/CLAUDE 项目指令
│   ├── session.ts        # JSON 持久会话
│   ├── memory.ts         # MemoryHub 稳定语义导出
│   ├── memory/           # Memory contracts、policy、ranking 与 compiler
│   ├── plan.ts           # Plan、Goal、Checkpoint 与 Resume
│   ├── team.ts           # Ultra Team 任务、依赖与持久状态
│   └── trace.ts          # JSONL 执行记录
├── extensions/
│   ├── skills.ts         # Skill 发现与按需加载
│   ├── mcp.ts            # MCP Client、状态与生命周期
│   ├── memory/           # Wiki Vault、SQLite catalog、compiler、lint 与工具
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

使用任意 OpenAI Chat Completions 兼容服务（包括 Kimi、通义千问或本地网关）：

```dotenv
MIMI_MODEL_PROVIDER=openai-compatible
MIMI_PROVIDER_API_KEY=your-provider-api-key
MIMI_PROVIDER_BASE_URL=https://api.provider.example/v1
MIMI_MODEL=provider-model-id
# 可选：/model 中展示的候选模型
MIMI_MODELS=provider-model-id,provider-fast-model-id
```

`MIMI_PROVIDER_BASE_URL` 和 `MIMI_MODEL` 必须填写服务商当前文档给出的实际值。
该通用 Provider 使用 OpenAI Chat Completions 协议；原生 `openai` Provider 仍使用
OpenAI Responses API。兼容服务若只实现了部分 OpenAI 协议，Tool Calling、图片输入
或流式响应能力仍取决于服务端实现。自定义模型默认关闭图片输入，并使用模型注册值、
模型专属环境变量或内置 profile；完全未知且未注册窗口的 legacy 模型才回退到
`MIMI_CONTEXT_WINDOW` / `MIMI_OUTPUT_TOKEN_RESERVE`。图片能力可通过
`MIMI_MODEL_SUPPORTS_IMAGE_INPUT` 显式覆盖。

多 Provider 并行使用时，在 owner 私有的 `~/.mimi-agent/models.json` 注册精确
`providerId/modelId`、transport、`apiKeyEnv` 和 `imageInput/imageOutput/toolCalling`
三项硬能力；可用 `MIMI_MODELS_CONFIG` 覆盖路径。配置文件不保存 API key，写入采用
严格校验、共享锁和原子替换。文件不存在时继续按上面的旧环境变量启动，行为兼容。
Session 固定值只影响下一 Run，不修改全局 Provider，也不重启 Daemon；结构化
`model_control` 可查看注册、当前 binding、路由和健康状态；其 direct Owner 写动作
可固定/清除当前 Session target 或修改场景路由。
OpenAI-compatible 健康检查只依赖协议通用的认证 `/models` 列表端点，不要求服务商
额外实现可选的 `GET /models/{id}`。

上层任务只声明场景、复杂度和硬能力，厂商协议由 Gateway adapter 隔离。图片理解与
生图是不同能力：视觉理解模型不能代替图片生成模型；没有兼容模型时明确 blocked。
第一次 `run_team` 会在领取 worker 前用同一配置快照冻结全部 task 的精确 target，
SubAgent 每次委派重新选型；后台 worker 只获得被选 Provider 的 credential。
Conversation、SubAgent 与 Team worker 的 binding 会进入 Trace，usage 记录精确
target、scenario 和选择原因，未配置价格时 cost 显示 `unknown`。

也可以用一条命令原子保存 Provider 配置并重启 Daemon。当前 Owner Run 只有一个
`MIMI_EPHEMERAL_SECRET_n` 时会自动使用该临时值，无需把 API Key 放进命令参数：

```bash
mimi provider set openai-compatible \
  --base-url https://api.moonshot.cn/v1 \
  --model kimi-k3 \
  --context-window 1048576
```

命令只把凭证写入 `0600` 的统一私有环境文件，并同步更新 launchd；不会要求先手工编辑
plist，也不会因为 Key 最初只存在于当前 Shell 而中断重启。存在多个临时敏感值时使用
`--api-key-env MIMI_EPHEMERAL_SECRET_n` 精确选择。

旧的 `mimi provider set` 与单 Provider 环境仍保留兼容；它们管理 legacy 全局启动
配置。启用 `models.json` 后，日常对话选型应使用 Session target 和场景路由，不再
通过切换全局 Provider 重启 Daemon。

编辑 `~/.mimi-agent/.env` 填入所选 Provider 的配置，然后一键启动后台：

```bash
mimi daemon start
```

打开交互界面：

```bash
mimi
```

`mimi daemon start` 会完成初始化、复用属于当前数据根的 macOS LaunchAgent，或启动安全的 detached 后台进程，并等待控制端点健康后再返回。`start`、`stop`、`restart` 和 `status` 是全局服务命令；直接运行 `mimi` 仍会在需要时自动启动同一个后台 Kernel。Kernel 是全局控制面，但不再把所有对话锁死在首次启动目录：每次本地 CLI 命令都会携带本次启动目录，Session 在模型运行前解析该任务的真实工作区，并为文件、Shell、项目指导、Skill、MCP、Team 和后台任务构建对应的工作区运行时。不同 Session 可以同时运行；同一 Session 的消息仍按 FIFO 处理。CLI 退出只关闭当前终端，不会关闭 MimiAgent 或它已接手的后台任务。需要登录后自动启动与异常恢复时，先把 Provider Key 保存到 `~/.mimi-agent/.env`（或显式 `MIMI_ENV_FILE`），再显式运行 `mimi daemon install`。普通启动不会安装、迁移或重写 LaunchAgent；若全局 plist 属于另一个数据根，会明确拒绝覆盖。

`mimi` 默认先进入不落盘的新对话草稿，发送第一条普通消息时才创建真实 Session；如果直接用 `/sessions` 或 `/switch` 切到已有对话，草稿不会留下空 Session。`/model`、`/mode`、`/sessions`、`/history`、`/skills`、`/mcp`、`/memory`、`/plan`、`/goal`、`/tasks` 和 `/task` 等命令与长期运行事件共用同一套实现和 FileSession 原始记录。

执行单次任务仍然使用同一个入口：

```bash
mimi "读取 package.json 并介绍这个项目"
```

后台生命周期和维护命令：

```bash
mimi daemon start
mimi daemon stop
mimi daemon restart
mimi daemon restart --force
mimi daemon status
mimi daemon doctor
mimi daemon diagnostics ./mimi-diagnostics.json
mimi daemon backup ./mimi-backup
mimi daemon backup verify ./mimi-backup
mimi daemon --help
```

`mimi daemon status` 默认输出适合终端阅读的健康摘要；脚本、自动化和完整排障数据使用 `mimi daemon status --json`。

普通 `restart` 在有活动工作时失败关闭。`restart --force` 只会中断并安全重排“尚无
在途 Tool”的模型 Run；在途 Tool、独立 Task worker、Host mutation 或正在发送的
Outbox 仍会阻止重启，避免 uncertain 副作用被重放。排队、阻塞、死信和待简报等持久
积压本身不是重启阻塞项。若从 MimiAgent 自己的 Shell Tool 内执行，当前 Tool 会构成
安全阻塞；需要在另一个终端运行该维护命令。

首次 `mimi` 会执行幂等初始化：创建权限为 `0700` 的 MimiAgent 数据目录、`0600` 的策略/Connector 配置和本机数据库，并把发布包内的 Connector 目录物化为当前安装位置的绝对路径。macOS 默认启用无界面的 System Connector 和 action-only Desktop Connector；Desktop 默认不轮询、不打开 GUI，只有明确调用 action 才执行。Calendar、Mail、Messages、Contacts、Notes、Shortcuts、Browser、Screen、Voice 和大象/QQ 两个个人消息配置槽位默认关闭。旧版自动启用的 canonical 本机 Connector 会一次性切换到轻量默认，后续用户显式启停仍会保留；个人消息槽位也只补一次，owner 删除后不会反复恢复。Calendar/Reminders 与 Mail 即使被启用，也不会为了后台轮询重新打开已关闭的 App。Radar 等额外数据源保持关闭。升级会删除全部旧微信 Connector/桥、旧大象 Bot/AppleScript、QQ OneBot/NapCat、通用 HTTP Action 及 QQ AppleScript Connector 配置，补齐缺失的默认本机 Connector，并为仍指向同名内置脚本的 Connector 补充新 action。MimiAgent 不再注册、探测、读取或发送任何微信渠道；个人 QQ 继续只走受约束的 CUA route。发布构建把完整 Git commit 与 dirty 标志写入包内 identity，并和运行代码内容摘要共同形成 Daemon 版本；dirty/unknown 构建可开发运行但不能建立 soak T0。`mimi daemon doctor` 只读检查模型 Key、脚本、系统命令、后台、运行中 Connector、dead letter、容量阈值、launchd 状态，以及 installed/running/workspace HEAD 的构建漂移；它不读取邮件、消息或屏幕，不触发系统授权，也不会因漂移自动重启或修改工作树。

LaunchAgent 的 plist 不保存 API Key，而是读取持久环境文件；只在当前 Shell `export` 的临时 Key 不会被写入磁盘，此时 MimiAgent 仍可在当前登录会话内运行。首次访问邮件、消息、联系人、屏幕等能力时，macOS 可能向实际 Node/Terminal/LaunchAgent 进程请求系统权限；MimiAgent 不再叠加审批层。

常驻模式把事件先持久化再执行。重复来源事件按 `source + externalId` 去重；崩溃中的租约会被恢复；完成回执可避免“Session 已完成但事件事务尚未提交”时重复调用模型；结果和待发送通知在同一 SQLite 事务中提交。入站 IM 等来源自带 reply route 时原路回复；最近 7 天 owner 使用过的 Connector 会按 profile 成为自主简报、告警和巡检的优先回访渠道，过期或不存在时回退 `assistant.json owner.replyRoute`。本地 CLI 和无回复语义的 Webhook 永不使用这个回退，CLI 结果只返回正在等待的 Socket 客户端。`trust` 只是不可由 payload 自报的来源审计标签，不直接授予或拒绝能力：未命中 owner source policy 的 trusted/external/public 事件只保留当前 attempt 的静默投递控制；命中策略后，`access: "reply"` 只允许结合当前人物 Session 形成回复，`access: "work"` 才开放固定的本地工作、Connector 和后台委派工具。旧策略省略 `access` 时安全默认为 `reply`；原本确实用于代办工作、发消息或运行 Shell 的策略需要显式补成 `work`。Task worker 会从仍被保留的原始 conversation Event 重新计算同一授权。外部正文无论 provenance 都只是数据，不能扩大目标、权限、收件人或副作用范围。系统通知默认使用 macOS Notification Center，其他消息渠道通过 `NotifierRegistry` 扩展。

长期数据库默认每 24 小时执行一次有引用保护的历史维护，清理 90 天前的 sent/archived Outbox、已归档 Digest、无引用的终态 Task、对应 Run 和不可变 Event，以及旧 disabled Schedule/checkpoint/audit。queued、running、paused、blocked、dead letter Task、未投递 Outbox、待简报 Digest 和启用 Schedule 永不自动删除。owner 可用 `mimi daemon retry task|outbox <id>` 原 ID 显式重试 dead letter，或归档 Outbox；Event 是不可变事实，不能重试或归档。Daemon 不会自动重放 dead letter。Outbox 是 at-least-once 投递，显式重试在远端确认丢失时可能产生重复消息。可在 `assistant.json maintenance` 调整或关闭；保留期同时是 `source + externalId` 去重窗口，极旧来源项被重新回放时可能再次处理。维护不自动 `VACUUM`，SQLite 会复用释放页面。

Daemon 在安全重启前轮转超过 10 MiB 的 stdout/stderr 日志，每类最多保留 5 份历史，并把活动文件重新创建为 `0600`。Doctor 和脱敏诊断包同时检查活动日志、SQLite/WAL/SHM 与 Memory 目录的容量：日志在 10/100 MiB、数据库在 512 MiB/2 GiB、Memory 在 1/4 GiB 分别进入 warning/critical。轮转只发生在旧进程退出后，避免移动仍由运行中进程持有的文件描述符。

`mimi daemon backup [输出目录]` 使用 SQLite Online Backup API 捕获一致数据库快照，并备份 Session、Plan、Team、Execution Ledger、Memory、Trace、用户 Soul 和两份 Daemon 配置；control bearer、Socket、日志和 Computer 临时产物不会进入备份。目录和文件固定为 `0700`/`0600`，`manifest.json` 保存每个文件的大小与 SHA-256，创建结束和 `backup verify` 都执行 SQLite `integrity_check`。`mimi daemon restore <备份目录>` 会再次校验完整清单，只允许后台已停止且工作/Daemon 数据根都不存在时恢复，并通过同目录 staging 后再改名提交；它不会覆盖已有状态，也不会恢复旧 control bearer。恢复完成后重新运行 `mimi daemon doctor`，启动时会生成当前机器的新控制令牌。

`mimi daemon events/runs/outbox/schedule list` 返回不携带大正文的有界管理摘要；需要查看原始 payload、answer、投递内容或完整 prompt 时，使用 `mimi daemon show event|run|outbox|schedule <id>`。这样长期积累的大记录不会挤爆本地 IPC；CLI 的 `/history` 使用 revision 分块读取，Memory 列表只返回摘要和 ref，正文必须显式 `/memory read`。

长期在线事件先经过注意力层：环境信号、静默时段消息和超出自治预算的事件会可靠进入摘要池；只有 owner 启用定时简报后才会在配置时点主动合并，新安装默认安静，手动简报始终可用。简报继续携带 `external` provenance 和受限策略，不会把其中来源内容洗成 system 指令。Run/Token 预算只统计 Connector、health、briefing、maintenance、routine 等自治来源，并为 queued/running Task 预留 Run；缺失 Token 事实时失败关闭，不把未知冒充成 0。高优先级告警、owner 命令和手动简报仍及时执行。`daemon activity`、Doctor 和脱敏诊断按稳定来源分类显示近 24 小时 Run/Token 与当前预算耗尽状态，同一来源从耗尽到恢复只通知一次。达到 `urgentPriority`、严格高于当前任务且会被 Attention 执行/通知的事件，可以在模型思考阶段抢占低优先级长任务；工具或外部事务在途时先等其安全结束，紧急事件处理并可靠投递结果后，原任务无失败惩罚续跑。模型连续无进展达到 `execution.runIdleTimeoutMs`（默认 20 分钟）会中止并按普通失败重试；流式输出或 Runtime 进展会刷新计时，Tool 在途时暂停。正常 Daemon 停机也会先等在途 Tool 返回，再无失败惩罚重排队。`assistant.json` 中的 Standing Orders 与 People 私有 context 会附加到 owner/system Run，以及命中 owner source policy 的替身 Run；未授权事件仍可按 alias 派生稳定 Person Session ID，但看不到该 Session 或私人 metadata。Daily Routines 也是显式启用的 owner Event：新安装没有预置晨间或晚间任务，owner 创建后才按本地时区运行，并可通过 `inspect_mimi_activity` 检查自身积压、失败和近期状态。定时简报与 Routine 都只在计划时刻后的 15 分钟内补发，避免长时间停机后集中执行过期任务。非 command 自主运行确认没有新变化、风险、动作或需关注事项时，可调用 `finish_mimi_silently` 安静完成：Event/Run/答案/usage/原因仍保留，只省略通知 Outbox。这些能力复用同一个 Kernel、Session actor 系统与 Event 流，不创建第二套工作流。配置、决策顺序与规则示例见 [docs/ATTENTION.md](docs/ATTENTION.md)。

owner/system 以及命中 owner source policy 的 MimiAgent 事件可使用有界运行自省与 follow-up/watch 工具推进当前事务；未授权事件不会获得这些工具。每个计划持久保存原 Conversation authority、origin Session 和 reply route；到期后进入独立 `mimi-task-*` Session 与 OS worker，不会占住创建计划的对话。Task 在执行时从原始 root 与当前 source policy 重新计算权限：root 缺失或 provenance 不匹配会失败关闭，撤销 external work policy 后不会继续原工作，周期 watch 只保留停止自身的能力，避免无权限轮询。条件监控同 Session 有新事件时立即触发，平时按周期兜底；结束条件成立后通过 `complete_current_mimi_schedule` 自行停止，没有变化时安静完成。用户还可直接说“现在给我汇总一下”，由 `request_mimi_briefing` 原子领取当前摘要并通过既有事件和投递链路送达；说“每天 9 点检查重要邮件”或“删除晚间收尾”时，Agent 会通过 `list_mimi_routines`、`upsert_mimi_routine`、`remove_mimi_routine` 原子管理固定本地时刻的 Daily Routines；Routine 删除、禁用或更新后，已排队的旧版本触发会在执行前失效。也可由 owner 对话管理 Standing Orders、来源规则、注意力规则和 People alias，无需手改 `assistant.json`。替身 Run 不获得这些配置控制工具，不能通过外部正文修改自己的授权。Activity 视图不包含其他 Event 正文、Run 答案、Outbox 内容或 target；一次性唤醒至少延后 5 秒、周期巡检最短 5 分钟、最多保留 100 个启用计划，配置写工具进入事件级副作用账本，崩溃重试不会重复修改。

长事务上下文被压缩或跨渠道继续时，同一 profile 的 owner 在 CLI、IM 和语音等可信入口共享稳定 Session；显式 `sessionKey` 仍可隔离专题事务，但必须符合核心 Session schema，非法值在 IPC 或持久化前直接拒绝。人物和 Routine ID 含点号等非 Session 字符时会稳定哈希为安全 ID。Agent 可用 `inspect_mimi_session_activity` 检索当前 Session 近期做过的事和有界结果；它直接投影现有 Event/Run，不复制状态，也不返回事件原文、其他会话、Outbox 内容或 target。同 Session 的新 owner 命令还能打断同优先级任务，并通过 `cancel_interrupted_mimi_task` 取消被替换的旧任务。

每个 Daemon Run 都获得同一份精简的常驻执行契约：能直接完成就执行，依赖未来状态就建立 follow-up 或有结束条件的 watch，稳定决策与承诺写入 Memory，需要旧进展时恢复当前 Session Activity；自主巡检无变化时静默。外部事件正文始终位于契约之后的不可信数据区。

`get_mimi_settings` 与 `update_mimi_settings` 让 owner 通过对话调整个人画像、时区、静默时段、自治预算、告警阈值、运行超时、历史保留和简报设置。更新使用先读后写的完整快照，不会覆盖上述独立管理的人物、规则、例程和替身策略。需要临时专注时可直接说“免打扰 2 小时”，由 `snooze_mimi` 暂停非紧急自主处理和定时简报，到期自动恢复；当前 owner 命令与紧急事件照常执行，`clear_mimi_snooze` 可提前恢复。

邮件、Messages、新闻和天气等渠道通过隔离的 stdio Connector 接入：Daemon 负责拉起、确定性 readiness 探活、连续失败后的单 Connector 重启、崩溃退避、事件去重和可靠回传，Connector 只负责渠道协议。探活与恢复不启动模型 Run；MimiAgent 只在无法自愈或影响事务时通知，中断期间结果不确定的外部动作不会自动重放。每个 Daemon Run 都通过统一的 `inspect_capabilities`/`invoke_capability` 按需查看和调用 Connector action；目录直接读取 Manager 的 enabled、online、readiness 和 action 快照，readiness 变化会使本 Run 的发现缓存失效。配置示例见 `mimi.connectors.example.json`，协议见 [docs/CONNECTORS.md](docs/CONNECTORS.md)。

大象个人账号通道通过默认关闭的 `personal-daxiang` Connector 接入已登录的专用
Chrome 后台标签，动态分页发现当前账号已有会话并提供有界读取、首次监听历史基线、
ACK 后游标和一次性观察式发送。专用标签由 Connector 自行补建并始终保持非活动；
用户点开它时 Connector 会立即停止页面操作并迁移到新的后台标签，因此轮询切换会话
不会再改变用户正在看的大象页面。读取不要求预配会话 allowlist；按姓名发起新会话使用
`search_targets` 返回有界稳定候选，再以一次性 `candidateToken` 调用 `bind_target`，
重名必须由 owner 消歧，显示名不能直接成为发送目标。监听和发送仍只允许 owner 明确
绑定的稳定 sid，账号/页面指纹未锁定时失败关闭。个人 QQ 已有事件绑定的
`PersonalMessageHub → ComputerManager/CUA` 窄路由：只读取当前唯一后台窗口，按界面
账号与会话指纹复核目标，保护 owner 前台活动和已有草稿，并在唯一一次 Return 后重新
观察同一会话；缺少正式入站观察器或 Computer 实机 readiness 时仍保持 unavailable，
不会退回外部 Shell Skill。微信渠道已经整体退休，不存在个人账号或 Bot 降级路线。
向 owner 自己发送时模型只调用 `send_owner_message(channel,text)`；自会话、账号、
最新上下文和一次性发送由 Host 与 Connector 内部完成。
owner 查询大象消息时通过稳定 capability 发现正式 action，再使用
`list_targets/get_context`；`list_targets` 默认只返回最近活跃的一页，查看需注意消息时
优先处理该页的 unread/近期会话。只有当前页信息不足或 owner 明确要求更早/全部会话时，
才按 `nextCursor` 继续分页。该查询不会因 ID 猜错或 bounded coverage
自动降级到 CUA、Browser、桌面或 Shell。
更完整的范围见 [Connector 文档](docs/CONNECTORS.md)。

`radar-connector.mjs` 用单个零依赖子进程轮询多个 RSS/Atom feed 和 Open-Meteo 地点。新闻以 `ambient` 进入 Attention 摘要池，命中降水、阵风、高低温或恶劣天气代码阈值时产生 `alert`。配置起点见 `mimi.radar.example.json`。

`file-radar-connector.mjs` 对 Downloads、Desktop、共享收件箱或其他配置目录做有界元数据扫描。同一路径的 size/mtime 连续两次稳定后才成为可去重 external Event，避免读取下载或复制中的半成品；默认入站只分析元数据并通知，读取、转换、改名、移动、归档或外部回复必须由 owner/system Run，或命中 owner 明确 File Radar source policy 的替身 Run 发起。Connector 本身不读取正文、不跟随符号链接、不保存游标。配置起点见 `mimi.files.example.json`。

`macos-mail-connector.mjs` 直接复用 Apple Mail 中已配置的账号和 Keychain，不在 MimiAgent 内保存邮箱密码。它将未读邮件转为可去重 external `alert` Event：白天默认即时判断，静默时段、Snooze 或超过预算时进入简报；无需动作的邮件可静默完成。Connector 提供收件箱搜索、显式历史邮箱搜索、邮箱目录、读取、附件列举/保存、发送、回复、已读、旗标、显式目录移动、删除和草稿 action；默认受限入站不能调用这些 action，owner/system 或命中 owner 邮件 source policy 的替身 Run 可按策略使用。轮询只报告有界预览和附件数量，不自动下载；真正发信始终使用显式 action，不会把无 reply route 的普通邮件 Event 输出误当回信。

`macos-messages-connector.mjs` 只读本机 Messages 数据库来感知新消息、查询会话和列举附件，发送则调用 Messages 的 JXA 接口，不写私有数据库。MimiAgent 可把已下载附件原子保存到显式绝对路径，也可发送有界本地普通文件；轮询只报告附件数量，不自动复制。入站消息作为高优先级 alert 进入事务判断：需要答复时处理结果直接回复同一 iMessage/SMS/RCS 会话，无需答复或已经显式发件时静默结束，依赖对方后续时建立 Watch。实际运行需要给 Node/Terminal 或 LaunchAgent 对应可执行程序授予“完全磁盘访问权限”；首次发送还会触发 macOS 自动化授权。

`macos-contacts-connector.mjs` 按姓名、组织、邮箱或电话查询系统通讯录，返回稳定联系人 ID 和全部候选，供 MimiAgent 再调用 Mail 或 Messages。它也可创建联系人、更新常用字段并追加邮箱或电话；不轮询、不复制通讯录、没有额外依赖。

`macos-notes-connector.mjs` 复用 Apple Notes 现有账号和 iCloud 同步，按需列出文件夹、搜索和读取笔记，并可创建、更新或追加工作记录与生活笔记。它不轮询、不镜像 Notes 数据库；密码保护笔记不尝试解锁，附件只返回元数据。

`macos-shortcuts-connector.mjs` 直接调用系统 `shortcuts` CLI，让 MimiAgent 可以发现并运行用户已有的快捷指令。Catalog 返回结构化稳定 id，执行只接受最近一次真实列出的 id，不把名称猜测当目标；它支持文本、base64 和多个文件输入，可返回有界 text/base64 stdout 或写入显式绝对输出路径，不实现第二套自动化 DSL。

`macos-desktop-connector.mjs` 通过 System Events 感知前台应用和窗口，并可激活应用、打开 URL/绝对路径、读写文本剪贴板、输入文本、发送 key code 和点击一级菜单项。`open_visible` 要求精确 bundle ID，并且只有观察到目标应用已置前且存在可见窗口才返回 `outcome=confirmed`；系统只接受打开请求但验证超时会返回 uncertain，禁止重放。剪贴板感知默认关闭，持久启停只由 operator 管理。

`browser-connector.mjs` 是唯一网页语义执行面，只使用 Chrome 和 OpenCLI Browser Bridge。它提供隔离/绑定会话、DOM/AX 状态、语义 locator、标签、正文、iframe、网络 shape、表单和结构化页面动作；`observationId` 只作为读取回执，不再是写动作门禁，写后仍重新观察并核对结果。MimiAgent 不再提供 Safari/JXA Browser 路径，也不通过 Shell 直接运行 OpenCLI。安装与完整动作见 [docs/CONNECTORS.md](docs/CONNECTORS.md#browser-connector)。

`macos-screen-connector.mjs` 使用系统 `screencapture` 和 Vision Framework 读取原生应用、画布、远程桌面等非 DOM 界面的屏幕文字。它支持显式保存 PNG、OCR 已有图片，以及临时截图后 OCR 并立即清理；默认不持续录屏、不轮询屏幕、不保存图片历史，也不增加云端 OCR 依赖。

`macos-voice-connector.mjs` 使用 Speech/AVFoundation 和系统 `say` 提供免键盘交互：可选持续监听“MimiAgent”开头的 owner 命令、转写已有音频、列出声音，并把命令结果经可靠 Outbox 自动朗读。监听默认关闭，但一次 `listener_start/stop` 会原子保存并跨 Connector/Daemon 重启恢复；不保存麦克风音频，非唤醒语音不会形成 Event，重复命令会短期抑制，朗读期间 listener 自动暂停以避免自我唤醒。

临时集成也可设置 `MIMI_WEBHOOK_PORT` 与 `MIMI_WEBHOOK_TOKEN` 开启仅监听 localhost 的认证 Webhook。所有 Webhook 来信固定记录为 external provenance；默认使用受限事件策略，只有命中 owner 明确配置的 source policy 才获得对应代办权。

本机 IDE、脚本或其他客户端也可设置 `MIMI_RUNTIME_HTTP_PORT` 与至少 32 字节的 `MIMI_RUNTIME_HTTP_TOKEN` 复用 Runtime。适配器只监听 `127.0.0.1`，提供 Session、消息提交、Task 查询/取消和 SSE 事件接口；请求仍进入同一套 Event、Task、Session actor 与 `MimiHost`，`Idempotency-Key` 可避免客户端重试产生重复任务。

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
| `MIMI_CONFIG_VERSION` | `4` | 配置模板版本；保留此项可区分主动权限限制与旧模板默认值 |
| `MIMI_MODEL_PROVIDER` | `openai` | 模型 Provider：`openai`、`deepseek` 或 `openai-compatible` |
| `MIMI_PROVIDER_API_KEY` | 未设置 | `openai-compatible` Provider 的 API Key |
| `MIMI_PROVIDER_BASE_URL` | 未设置 | `openai-compatible` Provider 的 OpenAI 兼容 API 根地址 |
| `MIMI_MODEL` / `MIMI_MODELS` | 未设置 | 通用 Provider 的默认模型与全局 `/model` 候选列表 |
| `MIMI_MAX_TURNS` | 不限制 | 可选的单次 Agent 运行轮数上限；默认由 Goal/Plan 状态、取消、空闲超时与上下文预算控制 |
| `MIMI_HISTORY_LIMIT` | `40` | Token Budget 之外的历史条目上限；从完整用户轮次开始截取 |
| `MIMI_CONTEXT_WINDOW` | 按模型 Profile | 未知 legacy 模型未声明窗口时的兼容回退；不会覆盖模型注册值或内置 Profile |
| `MIMI_OUTPUT_TOKEN_RESERVE` | 按模型 Profile | 未知 legacy 模型的输出 Token 兼容回退；不会覆盖内置 Profile |
| `MIMI_OUTPUT_LEVEL` | `tools` | 启动时的事件展示等级：`answer`、`thinking`、`tools`、`trace` |
| `MIMI_TTS_ENABLED` | `false` | 原生本机 TTS 总开关；Host 也可通过 `agent.speech.setEnabled()` 在运行时切换 |
| `MIMI_TTS_COMMAND` | `~/.mimi-agent/runtime/tts/render` | 原生 SpeechOutput 的唯一受管渲染器；接收输入文件、`--no-play` 和唯一 WAV 输出路径 |
| `MIMI_TTS_PLAYBACK_COMMAND` | `/usr/bin/afplay` | 本机音频播放命令 |
| `MIMI_TTS_SYNTHESIS_TIMEOUT_MS` | `180000` | 单次语音合成超时 |
| `MIMI_TTS_PLAYBACK_TIMEOUT_MS` | `600000` | 单次音频播放超时 |
| `OPENAI_MODELS` / `DEEPSEEK_MODELS` | 内置常用模型 | 全局 `/model` 选择器中各 Provider 追加的逗号分隔模型列表 |
| `MIMI_SESSION` | 未设置 | 显式进入已有 Session；未设置时 CLI 使用首次发言才落盘的新对话草稿 |
| `MIMI_MODE` | `general` | 启动模式：`general`、`plan`、`ultra` |
| `MIMI_SECURITY_PROFILE` | `full-owner` | 本机认证 Owner 的运行权限：默认直接使用当前 OS 用户权限；仅在需要整体收紧时设置 `safe` 或 `workstation` |
| `MIMI_PERMISSION_MODE` | 由 Security 派生 | 仅用于读取旧配置；不再参与授权，冲突时以 `MIMI_SECURITY_PROFILE` 为准 |
| `MIMI_COMPUTER_BACKEND` | 自动发现 | Full Owner 在 `~/.local/bin` 或 `PATH` 发现兼容 `cua-driver` 时自动注册 `computer_observe` / `computer_act`；设为 `off` 可关闭，第一阶段仅 macOS |
| `MIMI_CUA_DRIVER_COMMAND` | 未设置 | 可选的 Cua Driver 可执行文件绝对路径覆盖；未设置时自动发现，当前适配器允许并测试 `0.8.x`（patch ≥3）、`0.9.0`、`0.12.3`、`0.14.1`、`0.16.0` |
| `MIMI_COMPUTER_DEFAULT_ACCESS` | `foreground` | 本机 Full Owner Run 的最大档位；Host 仍后台优先，只在目标已置前或后台明确未执行时用前台投递。可改为 `none/observe/background/foreground/admin`；Daemon 事件仍需 source policy 显式授权 |
| `MIMI_COMPUTER_MAX_ACTIONS_PER_RUN` | `50` | 单个 Run 的 GUI 写动作预算 |
| `MIMI_COMPUTER_MAX_SCREENSHOTS_PER_RUN` | `12` | 单个 Run 的窗口/桌面/局部截图预算 |
| `MIMI_COMPUTER_ARTIFACT_MAX_MIB` | `1024` | 受保护录制/轨迹 artifact 的单项大小上限 |
| `MIMI_MODEL_SUPPORTS_IMAGE_INPUT` | 按内置模型 Profile | 自定义模型是否明确支持图像输入；未声明时视觉观察失败关闭 |
| `MIMI_TEAM_MAX_CONCURRENCY` | `4` | Ultra Team worker 并发上限，运行时强制不超过 4 |
| `MIMI_SESSION_MAX_CONCURRENCY` | `4` | Session actor 池并发上限，范围 `1～16`、同 Session 仍 FIFO；task worker 复用该值但硬限制最多 `8` 个 |
| `MIMI_WORKSPACE` | 当前 CLI 的启动目录 | 本次本地对话建议的项目工作区；对话中显式指定的项目目录优先 |
| `MIMI_DATA_DIR` | `<workspace>/.mimi-agent` | 会话、记忆、计划、索引和 Trace |
| `MIMI_DAEMON_DATA_DIR` | `~/.mimi-agent/daemon` | 数据库、Socket 与日志 |
| `MIMI_CONNECTORS_CONFIG` | `<MIMI_DAEMON_DATA_DIR>/connectors.json` | 隔离子进程 Connector 配置 |
| `MIMI_ASSISTANT_CONFIG` | `<MIMI_DAEMON_DATA_DIR>/assistant.json` | 用户画像、Standing Orders、静默时段、预算、规则与主动简报配置 |
| `MIMI_WEBHOOK_PORT` | 未启用 | localhost 认证 Webhook 端口 |
| `MIMI_WEBHOOK_TOKEN` | 未设置 | Webhook Bearer Token，启用时至少 24 字符 |
| `MIMI_RUNTIME_HTTP_PORT` | 未启用 | 仅监听 localhost 的 Runtime HTTP/SSE 端口 |
| `MIMI_RUNTIME_HTTP_TOKEN` | 未设置 | Runtime HTTP Bearer Token，启用时至少 32 字节 |
| `MIMI_SKILLS_DIR` | 未设置 | 最高优先级额外 Skill 根目录；不再替换标准发现位置 |
| `MIMI_MCP_CONFIG` | `<workspace>/mcp.json` | MCP Server 配置文件 |
| `MIMI_EMBEDDING_API_KEY` | 未设置 | 可选的专用 OpenAI-compatible Embedding 凭证；只有显式设置才改用远程 Provider，不复用对话 Provider Key |
| `MIMI_EMBEDDING_BASE_URL` | OpenAI 默认端点 | 仅远程 Embedding Provider 使用的 API 根地址 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | 仅远程 Embedding Provider 使用的模型 |
| `MIMI_MEMORY_RETRIEVAL_MODE` | `auto` | `auto` 默认使用 FTS/BM25，配置专用 Embedding Key 后启用 hybrid；`lexical` 固定纯本地 FTS/BM25 |
| `MIMI_ENV_FILE` | 自动选择 | 显式指定统一环境配置文件 |

通用 `AGENT_*`、模型与 MCP 变量仍按明确白名单作为后备别名。`MIMI_CONFIG_VERSION>=2` 用于区分显式 `workspace` 限制与早期模板默认值。

本机认证 Owner 默认使用 **Full Owner**，直接获得当前 OS 用户权限下的原生 Host Shell、文件能力，以及已显式配置的 Computer Use 和受信工作区 MCP；`run_shell` 可以管理当前用户的 `launchd` 等宿主服务，不再被 Darwin capability sandbox 拦截，也不再要求每个 Session 单独选择安全档位。Owner 在直接命令中本轮提交、且被敏感数据治理识别的值，可以只在当前 Run 发送给当前配置的模型 Provider（配置了兼容备选路由时也包括该路由）。外部事件、后台 Task、SubAgent 和 Team worker 不继承这项 Owner 权限，仍按来源和任务策略隔离。

临时敏感原值不会进入工具参数、进程命令行或执行账本。模型若误把原值拼进参数，工具会返回可重试拒绝，当前 Run 可立即改用 `MIMI_EPHEMERAL_SECRET_n` 环境变量继续，不再因此销毁整轮。Owner 本轮明确要求为指定本机 Provider 或集成持久配置 credential 时，主 Agent Shell 可通过该环境变量写入 owner-private 配置目标并保持 `0600`；其他文件、日志、Session、Memory、后台任务和委派仍不得继承原值。

需要整体收紧某个运行环境时，可在启动前设置 **Safe**（只读，无 Shell、Computer Use 和外部事务）或 **Workstation**（工作区可写并提供结构化沙箱 Shell，但无 Connector 外部事务、Computer Use 或受信工作区 MCP）。旧 Session 保存的安全档位不再参与授权，避免切换对话时意外降权。交互式 CLI 输入 `/security` 会像 `/sessions` 一样打开 Safe、Workstation、Full Owner 三档列表，可用 `↑` / `↓` 选择、`Enter` 确认、`Esc` 取消；也可直接输入 `/security safe|workstation|full-owner`。切换从下一轮生效，作用于当前运行实例，重启后恢复环境配置。旧 `MIMI_PERMISSION_MODE` 只做读取兼容，不能覆盖当前 Security。

Browser 是主 Agent 的一等能力：Browser Connector 的 open/close 生命周期实时 ready 时，标准后台网页任务直接使用 `browser_open`、`browser_observe`、`browser_act`、`browser_wait` / `browser_assert` 和 `browser_close`，不需要先发现 Connector 或激活 Browser Skill；Connector disabled、offline、stale 或生命周期不完整时，Host 不向模型暴露这组工具。Host 按 Run 持有一个会话生命周期，标准 snapshot 固定走 DOM，表单优先 accessible label/role/name，单次模型结果按最终 JSON 字节限制在 16 KiB。OpenCLI/Chrome 仍是隐藏 backend；其内部 session ref 不进入模型参数或结果。Connector 用独立后台 session 实现逻辑多标签，避免底层切换标签时丢失原页；owner 要求“打开给我看”时走 Computer `launch_app + urls`，不使用后台 Browser 会话，也不拆成地址栏点击和按键输入。`list_tabs` 返回稳定 page ID，`select_tab` 精确切换，`close_tab` 可关闭指定页或当前页并返回恢复后的活动页。open 结果不确定时禁止继续页面动作，close 最多投递一次；Daemon 只有 cleanup 成功才发布完成，否则任务进入不可重试 dead letter。

Full Owner 在本机发现兼容 Cua Driver 时自动启用 Computer Use，也可用 `MIMI_COMPUTER_BACKEND=off` 关闭。模型只看到 app-centric 的 `computer_observe` 和 `computer_act`：Host 自动解析精确窗口、优先读 AX、必要时回退窗口截图，并在普通 UI 动作后直接返回 fresh state。模型不管理 Session、PID、window id、Observation id、投递模式或执行状态。Host 后台优先；本机 Full Owner 目标已置前或 Driver 明确返回后台未执行时，才自动使用一次前台投递。Daemon status 区分 Driver RPC 的 `transportReady` 与真实窗口观察的 `operationalReadiness`，只有两者都通过时 `computer.ready=true`。Safe/Workstation、SubAgent、Team worker 和独立后台 Task 不获得桌面能力；Daemon owner channel 还需在 `assistant.json` 的 source policy 中显式设置 `computerAccess`，并可用 `computerApps` 限制 bundle ID。完整边界与实机命令见 [docs/COMPUTER_USE.md](docs/COMPUTER_USE.md)。

## 会话与上下文

模型可用 `task_history` 分页查询本人已保留的对话、后台和定时任务结果，并检查历史工具报告的文件路径。它不会自动载入其他会话全文，也不把“任务 completed”或“没查到文件”分别当作交付成功或重新生成的指令。普通聊天接续会提供上一轮未完成的工具进度，由大模型判断是否相关；显式恢复仍使用原有检查点和执行账本。

原生 `speech` 支持持久音频 ID、已有音频绝对路径播放和生成状态查询。重启或换会话不会丢失新生成音频的 ID；相同文本、音色及渲染配置复用同一生成记录。超时返回原操作 ID 和未确认状态，不自行换引擎生成副本。受管命令的子进程组会被清理，但独立后台服务不一定随客户端结束；没有后台完成回执时仍需核查，不能把文件刚出现当作整段合成已完成。旧版只有内存记录的 ID 不会凭空恢复，仍可通过已有可访问音频文件定位结果。

默认 `mimi` 连接常驻 MimiAgent 后展示一个仅存在于当前 CLI 内存中的新对话草稿，不读取旧对话，也不创建 Session 文件。第一条普通消息被后台接受后，草稿 ID 才成为真实 Session；在此之前执行 `/exit`，或用 `/sessions`、`/switch` 进入已有 Session，都不会留下空会话。全部内置命令通过本地 Socket 读写同一个 Kernel；`/new` 重新准备一个草稿，`/switch` 只选择已存在的 Session actor，不创建第二个控制面。`/exit` 只关闭终端，Esc 会请求后台安全取消当前 Task；若外部 Tool 正在执行，会先等待其结果落账再结束，不把不确定事务当作可重放失败。

一个 `MIMI_DAEMON_DATA_DIR` 对应一个常驻 Kernel 控制面，但一个 Kernel 可以承载多个项目工作区。工作区只由可信 Host 的结构化绝对目录选择：当前 CLI Event 携带的启动目录优先，其次是 Session 已绑定目录，最后是 Runtime 默认目录。MimiAgent 不从自然语言中抽取项目名、绝对路径片段、“新建”或“继续”意图，不搜索候选仓库，也不自动创建 `~/MimiWorkspace` 目录；无效结构化目录会直接失败关闭。当前仓库中的分析以及随任务创建的文档、报告和脚本都留在选定工作区。`MIMI_SESSION`（兼容 `AGENT_SESSION`）会选择 CLI 首次连接的 Session；未设置时使用稳定 Owner Session。

内置命令：

| 命令 | 作用 |
|---|---|
| `/model [name]` | 查看或切换所有已配置 Provider 的模型；无参数时使用全局选择器 |
| `/models`、`/model current` | 列出精确 target/硬能力，或查看当前 Session、下一 Run 与最近 binding |
| `/model inspect <target>`、`/model doctor [target]` | 查看注册信息、Provider endpoint、credential 环境变量名/配置状态（不返回原值），或执行无副作用健康检查 |
| `/model use <target>`、`/model auto` | 固定或清除当前 Session target；只影响下一 Run，不重启 Daemon |
| `/model routes`、`/model route <scenario> <target\|auto>` | 查看、修改或清除持久场景路由 |
| `/mode [name]` | 在 `general`、`plan`、`ultra` 之间切换 |
| `/output [level]` | 切换终端执行事件的展示详细度 |
| `/new [id]` | 准备一个首次发言才落盘的新对话草稿 |
| `/sessions` | 按内容摘要列出最近对话，使用 ↑↓ 和 Enter 切换 |
| `/switch <id>` | 切换已有会话 |
| `/history` | 查看当前完整历史 |
| `/clear` | 清空当前会话 |
| `/status` | 查看模型、会话、Skills、Memory 和 MCP 状态 |
| `/skills [reload\|active\|deactivate <name>]` | 列出、重新扫描或管理当前 Session 的 Agent Skills |
| `/tools` | 列出当前可用工具 |
| `/mcp [reload]` | 查看状态或重新连接 MCP Server |
| `/context` | 查看历史、记忆和计划用量 |
| `/compact` | 归档较早上下文并保留最近两轮；原始 Session 不删除 |
| `/instructions` | 查看当前加载的 Soul、Preferences 与项目指令 |
| `/memory status` | 查看页面、冲突、stale、FTS/Embedding 状态 |
| `/memory search <query>` | 搜索 private/workspace Wiki |
| `/memory read <scope:id>` | 显式读取一页 Memory |
| `/memory ingest <path>` | 导入一个 workspace Markdown/text 来源 |
| `/memory refresh [1-50]` | 显式重编译 stale workspace 来源并保留旧 Revision |
| `/memory lint`、`/memory reindex` | 检查 Wiki 或重建派生索引（保留控制账本） |
| `/memory forget <scope:id>` | 遗忘页面并写 suppression |
| `/plan` | 查看当前任务计划 |
| `/team` | 查看当前 Ultra Team 子任务、依赖、负责人和结果 |
| `/tasks [limit]` | 查看最近的持久后台任务，默认 20、最多 50 条 |
| `/task <id>` | 查看一个后台任务的目标、状态、工作进程、最近进度、结果与错误 |
| `/task pause <id>` | 在安全边界暂停 queued/running 后台任务 |
| `/task resume <id> [context]` | 继续 paused/blocked 任务，可补充必要上下文 |
| `/task cancel <id> [reason]` | 取消 queued/running/paused/blocked 后台任务 |
| `/goal [objective]` | 查看或设置跨多轮长期目标 |
| `/confirm-send <text>` | 在当前个人消息 Session 中结构化确认一次精确发送正文 |
| `/resume` | 根据 Checkpoint、Goal、Plan 与 Team 状态进行 best-effort 续跑 |
| `/retry` | 重新执行上一条用户输入 |
| `/help` | 查看全部命令 |
| `/exit` | 退出 |

完整会话保存在当前唯一数据根 `.mimi-agent/sessions/`。草稿不在该目录创建文件；`/sessions`、`/switch` 和显式 `MIMI_SESSION` 只选择已有 Session，`/new` 只替换内存草稿。每个真实 Session 独立保存 SDK transcript、mode、model、输出等级、最近运行检查点和上下文压缩档案；列表标题只对最长的用户消息做有界词法压缩，不按业务关键词猜测主题或意图。切换后按时间回放原始用户/助手消息，工具调用与结果仍保留在 FileSession 中。默认启动草稿不读取历史，已有 Session 快照只返回有界最近对话；`/history` 会通过多个小型本地 RPC 分块重组完整权威历史，避免长期 Session 超过 IPC 帧上限。若上次运行中断，底部显示恢复点和 `/resume` 入口。

发送给模型的有效上下文分四层管理：较早 Tool Result 先做 microcompact；超过 `MIMI_HISTORY_LIMIT`（兼容旧 `HISTORY_LIMIT`）或 Token Budget 后把旧完整轮次持久化为 context archive；`/compact` 可主动执行 full compact 并保留最近两轮；仍超预算时才按完整用户轮次做 PTL truncation。窗口由当前模型 Profile 决定，切换或恢复模型时同步更新；完整预算包含动态 Instructions、历史、当前输入、Function Tool Schema、协议安全余量和输出预留，输出预留同时作为模型请求的 `maxTokens`。每次请求都会生成不进入模型输入的 Context Manifest，记录估算器、输入预算、各 section 用量和确定性压缩记录；Provider 返回 usage 后只回填最近请求 actual，不反向篡改估算值。压缩只改变模型视图，不覆盖、删除或伪造原始 transcript。`/context` 会区分 Raw Session、Effective History、Request Estimate、Provider 返回的 Last Request Actual 与 Run Actual。

每轮开始即写入带 runId/owner 的 `running` checkpoint，所有进展与终态写入都做 runId 比对；旧 Run 不能覆盖新 Run，成功 Run 也不会被迟到的失败回调翻转。统一 CLI 中，Esc 只向后台请求取消当前 Event；若外部 Tool 正在执行，Dispatcher 会等待它到达安全边界并完成结果落账，再中止模型并把 Host Run 记为 `interrupted`，不会直接杀掉正在执行的 Shell。`/resume` 合并 checkpoint、Goal、Plan 与 Team 状态，先核对工作区再发起新一轮任务；它是 best-effort 任务续跑，不声称能从任意模型或工具指令点精确恢复。

Run 的各阶段通过显式 pipeline 和 state ports 装配。跨 FileSession、Goal、
Task 与 RuntimeAction 的完成过程写入只含摘要和 phase 的 Run Commit Journal；
完成回执一旦落盘，后续崩溃恢复会复用它而不会再次调用模型。JSON 状态本轮
保持单读单写，不与 SQLite 长期双写。

默认 CLI 交互不会阻塞输入：MimiAgent 执行时仍可继续提交消息。当前窗口指向同一 Session 的普通 `Enter` 消息进入 FIFO 队列并依次执行；发现当前方向有误时可用 `Command+Enter` 立即发送新指引，后台会先持久化新 Event，再在外部 Tool 的安全边界结束旧 Run 并按新方向继续。Apple Terminal 默认不会把 Command 修饰键传给 TTY，需要在当前 Profile 的 `Keyboard` 设置中把 `Command+Return` 映射为 `ESC+Return`；MimiAgent 会在 readline 拆分按键前识别这组字节以及兼容终端的 CSI-u 序列。另一个窗口选择不同 Session 后，可在 `MIMI_SESSION_MAX_CONCURRENCY` 限制内同时运行，不必等待前一个 Session 结束。输入框支持多行编辑：`Shift+Enter` 插入换行，`Command+←/→` 跳到当前行首/行尾；终端 bracketed paste 中自带的换行只会进入编辑区，不会触发提交。长文本只渲染光标附近的有界视窗并标注隐藏行数，发送时仍提交完整内容，避免粘贴大段文本时反复刷新整个终端；Apple Terminal 上使用不会产生物理软换行的单行视窗，并关闭可能撞入输入法 marked-text 生命周期的自主动画重绘。草稿非空时到达的并发回答会暂存到内存，在 `Enter` 提交或草稿清空后的安全点按原顺序显示，完整长文本和多行输入都不会丢失。按 `Esc` 会请求后台在外部 Tool 的安全边界取消当前 Event，队列中的后续消息不受影响。长程或多阶段任务通过 `update_plan` 建立阶段任务，当前会话的完成数、当前步骤和最多 5 条附近任务会实时显示在输入框上方；长描述保持单行省略，全部完成后任务面板会自动消失。普通 Run 若仍拥有 `running`、`pending` 或 `failed` 的 Plan 步骤，Host 会拒绝把该 Run 标记为完成。输入 `/` 会展示命令面板，使用黑色活动光标配合 `↑` / `↓` 选择、`Tab` 补全。`/new`、`/clear` 会清理终端并保留项目顶部信息；会话切换则清理当前画面、恢复顶部信息、任务进度并回放目标会话的历史消息。

简单问答、短操作以及你明确要在当前窗口看到结果的任务，会留在 Conversation actor 中流式执行。长程、大型、多阶段、持续等待或你明确无需立即结果的任务，主 MimiAgent 会调用 `delegate_background_task`：任务写入 SQLite 后立即返回 `taskId`，当前对话恢复可用，`TaskProcessSupervisor` 再用独立 Node.js 子进程和独立 Task Session 执行。默认省略 `modelTarget`，由 `background.default` 场景路由选择模型；用户明确指定模型时，`executor: "mimi"` 可携带精确 `{ providerId, modelId }`，worker 会按严格 WorkUnit target 解析并在 Provider 未注册、凭据缺失或能力不兼容时失败关闭，不会把裸 modelId 发给当前 Provider。`executor: "codex"` 是例外，它由 detached runner 启动独立 Codex CLI，不使用 Mimi Provider registry，也不创建 Mimi Plan 或进入 Mimi 的工具调用和重试流程；新任务完成后会唤醒原对话的 Mimi 核查产物、按原目标安排后续检查，再汇报核实结果。到期 Schedule 与 Daily Routine 也复用同一 Task lane，而不是占用来源 Conversation。默认 `workspaceAccess=write`，写任务独占工作区；明确声明 `read` 的分析任务使用确定性只读工具，可与其他只读后台任务并行。Task 一旦被接受就不会因 snooze、静默时段或 Attention 预算被转成 Digest；这些设置控制的是新事件是否值得接受，不会吞掉执行队列。Task 内不再递归创建 durable 子任务；大型可拆分任务在同一 worker 内用有界 Ultra Team 汇总。只有 owner conversation root 的 write Task 可执行 Connector action；外部 source-policy work Task 不会看到必然被 Broker 拒绝的 action 工具，但完成结果仍由 Outbox 原路返回。发起 CLI 即使已退出，任务仍继续；完成结果由 Outbox 主动发往原渠道或系统通知。若任务确实缺少必要输入，它会持久化为 `blocked` 并主动问你，补充上下文后从原 Task Session 继续。运行中执行 `/task pause` 会先返回“已请求暂停”，并在当前 Tool 完成后的安全点落成 `paused`；pause/cancel 控制会在回复 CLI 前先写入 SQLite，即使 Kernel 或 worker 随后崩溃，重启恢复也不会继续执行已取消任务，已暂停任务仍保持 `paused`。不要为了“并行”把普通短任务强制后台化；用 `/tasks`、`/task <id>`、`/task pause <id>`、`/task resume <id> [context]` 和 `/task cancel <id>` 管理真正的后台工作。

后台 Task 的自然语言错误只用于说明，不参与重试判断：确定性错误进入 `failed`，明确 transient 只在耗尽重试后进入 `dead_letter`，已经开始且结果 uncertain 的副作用直接进入 `dead_letter` 等待人工核对；只有 Owner 或系统显式终止才进入 `cancelled`。

输入区固定在终端交互区域的最底部，以 `┊> ` 提示符展示。输入区正上方是常驻状态栏：空闲时显示就绪状态，执行时显示动态 Spinner，并持续展示当前模式、模型以及上下文 Token/窗口。数值后缀明确标记 `actual`、`est` 或 `raw`；有请求 Manifest 时不再用完整 transcript 冒充当前请求，发生压缩时同时显示压缩前后大小。如果存在等待消息，更上方会常驻显示 FIFO 队列中的每条对话内容，过长内容以 `...` 省略，消息开始执行后自动从队列区域移除。

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

MimiAgent 在 `agent.speech` 上原生提供 `listVoices()`、`setEnabled()`、
`synthesize()`、`play()` 和 `speak()` 原子能力，并向主 Agent 暴露
一个紧凑的 `speech` 工具，其 action 可选 `voices`、`synthesize`、`play` 或
`speak`。底层按调用方给出的原始文本合成，不解释
Markdown 或回答结构。包含中文的内容（包括夹杂大量英文的中文回答）默认走持久
ChatTTS，失败自动降级 Kokoro；纯英文和日文走 Kokoro。可选音色收敛为 10 个：
ChatTTS 提供 2 个男声和 3 个女声，其中 `chattts:young-lively` 偏年轻活泼，
`chattts:mature-steady` 偏成熟稳重；默认使用男声
`chattts:male-1`；模型可先调用 `voices`，再在每次合成时通过 `voice` 灵活切换。
`speech` 是模型唯一支持的 TTS 入口；模型不得通过 Shell、
脚本或 Skill 绕过它。播报内容、表达风格、分段和调用时机均由上层或模型决定。

`/models` 展示私有 `models.json` 中已注册的精确
`providerId/modelId`、能力和配置状态。`/model use <providerId/modelId>` 只更新当前
Session，`/model route <scenario> <providerId/modelId>` 更新场景路由；两者都从下一
Run 生效，不修改活动 Provider，也不重启 Daemon。运行中的 Run 和已经冻结的 Team
继续使用原 binding。自然语言查看或调整 Session/route 统一调用结构化
`model_control`，不会猜测模型 ID 或能力。

Provider 和模型注册由 CLI 管理，配置只保存 credential 环境变量引用，不保存 key：

```bash
mimi provider add acme \
  --label Acme \
  --transport openai-chat-completions \
  --base-url https://api.example.com/v1 \
  --api-key-env ACME_API_KEY \
  --model exact-model-id \
  --tool-calling true
mimi provider add acme/second-exact-model-id \
  --tool-calling true
mimi provider list
mimi provider test acme/exact-model-id
mimi provider set acme/exact-model-id
```

已有 Provider 可用 `providerId/modelId` 简写追加模型，连接地址和 credential 引用继承
该 Provider；未知能力仍默认 `false`，必须按已知协议能力显式声明。registry 的任何
实际内容变化都会由缓存 Session actor 在下一 Run/control 安全点重载，即使旧工具没有
递增 `routeVersion`；活动 Run/Team 的冻结 binding 不变。`reload_mcp` 只重载 MCP，
不会也不需要用来刷新模型 registry。

未知能力默认 `false`；不兼容的视觉、生图或推理要求会在 Provider 调用前失败关闭。
旧环境变量模型列表和 `mimi provider set openai|deepseek|openai-compatible ...`
仅用于没有 registry 的 legacy 部署兼容。

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

## Soul、行为偏好与项目开发指令

MimiAgent 用两个用户级文档保持自身连续性，并与项目开发合约物理分开：

```text
~/.mimi-agent/MIMI.md   Soul：名字、人格、价值观与表达风格
~/.mimi-agent/PREFERENCES.md
                         owner 要求 Mimi 跨直接对话默认遵循的稳定行为
<workspace>/AGENTS.md   canonical 项目开发合约
<workspace>/CLAUDE.md   同目录兼容补充，冲突时 AGENTS.md 优先
```

direct-owner 每轮开始前由可信 Host 热读取两个用户级文档，不依赖本轮是否开放普通本地文件工具；只要结构化能力允许读取本地工作区，已有项目指令再按目录层级加载。单文件最多注入 20000 字符。上下文固定按 `MIMI.md Soul → Runtime 核心准则 → Preferences → 当前 Runtime Context → active Skill` 排列，这五层完整保留；Session state、项目指令、Goal/Plan、Memory Cards 与历史摘要随后按预算装配。存在 Soul 或 Preferences 时 direct-owner instruction budget 从 35% 提升到 40%，并额外预留两份用户级指令的实际 token，避免固定身份、行为规则和管理工具挤掉原本可用的 Skill；required sections 仍超限时会明确失败，不会静默丢失。SubAgent/Team 不获得 owner Preferences。

`MIMI.md` 只适合稳定身份和表达风格，是 Mimi 自己可控 Prompt 的第一身份层；`PREFERENCES.md` 只保存 owner 明确要求 Mimi 每次 direct-owner 对话默认遵循的行为规则，当前轮明确指令优先。模型通过 `list_mimi_preferences`、`add_mimi_preference`、`remove_mimi_preference` 管理该文件，写入使用跨进程锁、原子替换和 `0600` 权限。构建命令、代码规范和架构约束写入 `AGENTS.md` / `CLAUDE.md`；一次性任务留在当前 Session；可执行流程写成 Skill；稳定事实、人物偏好和经验交给 MemoryHub。文档顺序不代表授权顺序；所有这些上下文都不能扩大 Runtime 的工具、scope、trust 或权限。

该设计参考了 [Codex AGENTS.md](https://developers.openai.com/codex/concepts/customization#agents-guidance)、[Claude Code CLAUDE.md](https://code.claude.com/docs/zh-CN/memory) 和 [OpenClaw workspace bootstrap injection](https://docs.openclaw.ai/concepts/system-prompt#workspace-bootstrap-injection) 的持久上下文模式；OpenClaw 拆分 SOUL、IDENTITY、USER、MEMORY 等多类文件，MimiAgent 只保留 Soul 与 Preferences 两个用户级文档。

## Agent 自管理与自修改

CLI 斜杠命令和模型工具调用复用相同的 MimiAgent 运行时方法。用户既可以输入 `/model`，也可以直接说“切换到某个模型”；Agent 会实际调用工具，而不是只回复操作步骤。

| CLI 能力 | Agent 工具 |
|---|---|
| `/status`、`/context`、`/tools` | `runtime_status` 与现有状态工具 |
| `/model`、`/mode`、`/output` | `switch_model`、`switch_mode`、`set_output_level` |
| `/sessions`、`/history` | `list_sessions`、`get_session_history` |
| `/switch`、`/new`、`/clear` | `switch_session`、`new_session`、`clear_session` |
| `/skills`、`/mcp` | `list_skills`、`reload_skills`、`reload_mcp` |
| `/memory ...` | `memory_search`、`memory_read`、`memory_links`、`remember`、`forget`、`memory_ingest` |
| `/plan`、`/goal` | Plan 和 Goal 工具 |
| `/exit` | `request_exit` |

模型、模式和安全档位切换从下一轮生效；Session、输出等级和退出在当前回答完整写入后生效，避免留下孤立 Tool Call。`/retry` 与 `/resume` 属于重新发起一轮对话的 CLI 入口，Agent 在当前轮中分别通过重试工具和 Goal 工具完成相同语义，不递归启动自身。

`runtime_status` 同时返回当前工作区、运行时代码目录和三档 Security，CLI `/status` 会明确显示当前模式下 Shell 是否可用。新安装的认证本机 owner 默认 Full Owner；Workstation 使用结构化沙箱 Shell，Safe 和 Plan 不提供 Shell。旧执行档位仅为状态兼容，不参与授权。

## 统一 MemoryHub

Session/Event/Document 是证据真相，LLMWiki Markdown 是持续编译的 semantic memory，SQLite 只是可重建索引与不可随 reindex 删除的 receipt/suppression 控制账本。owner 私有 Obsidian Vault 位于 `<dataRoot>/memory/vaults/owner/`，其中 `raw/` 保存内容寻址的不可变证据快照，`wiki/` 保存编译知识，`WIKI.md` 是机器可校验且人类可读的维护 Schema；内部 SQLite 位于 `<dataRoot>/memory/state/profiles/<hash>/memory.db`。workspace 继续使用 `knowledge/sources/`、`knowledge/wiki/` 与 `knowledge/WIKI.md`，禁止私人 provenance，Sources 对 MemoryHub 只读。

Memory schema v2 在同一套页面和 revision 上增加 L1 Atom 与 L2 Scene/Topic；旧 schema v1 页面继续兼容读取。自由文本始终留在正文，typed facets 只承载 kind、实体、关系、时间和来源。L2 通过 `derivedFrom` 指向 L1/L2，`memory_read`/解释路径可以继续下钻到 L0 SourceRef；L3 Personal Context 是只读派生视图，不拥有事实，也不写 Goal、Schedule 或 Memory。普通新请求仍由模型处理并按当前意图检索相关 Memory，但不再每轮注入整套“今天重点/最近承诺/等待别人/项目风险”；这些宽上下文只在主动任务或长事务恢复时按 900-token 预算装配。

- `memory_search`：默认 Wiki-first 相关性搜索；owner 明确询问最近做过什么时可用 `order=recent` 按时间返回有界 Session round
- `memory_read` / `memory_links`：按 ref 渐进读取正文与一跳关系
- `remember`：保存稳定偏好、事实、决策或经验（不保存 todo）
- `forget`：删除页面并写 suppression
- `memory_ingest`：编译明确的 workspace 来源

所有 `remember`、capture 和 maintenance 写入先经过同一个 Canonical Topic Resolver；标题和 alias 命中已有主题时更新原页面并累计 SourceRef，只有不存在主题时才创建。模型只提交内容、关系和来源，H1、当前结论、关系及来源章节由确定性 renderer 生成。Lint 会自动修复 canonicalKey、页面 envelope 和不合规的 inferred-active 状态；重复、冲突、过期、孤页和 Scope 错置由有 Revision/Receipt 的 merge、supersede、link、move、refresh 治理操作修复。

用户明确说“记住……”时 Agent 会使用 `remember`；即使没有这句话，也可在硬门禁内主动沉淀未来有价值的信息。明确说“不要记住”会阻止本轮写入；外部未验证断言、瞬时内容、密码和密钥不能进入 active Memory。首次切换会备份 Mimi SQLite/WAL/SHM、旧 `memories.json` / `rag-index.json` 和两类旧 MIMI guidance；只转换带 `recordedAt` 或旧 `confirmedAt` 的非 todo 记忆及可识别 owner 事实，完成 Lint/控制账本校验后才写幂等 cutover marker。

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

MimiAgent 遵循 Agent Skills 的渐进披露方式：启动时只暴露名称、描述、胜出来源和位置；匹配任务后调用 `use_skill` 激活完整说明，也可在 owner 消息开头写 `$code-review`（支持多个 `$skill-name`）显式激活。原始输入仍原样保存在 Session，外部事件、非 owner 内容、转义或正文中间的 `$name` 不会触发激活。

发现优先级从高到低为：`MIMI_SKILLS_DIR`、`<workspace>/skills`、`<workspace>/.agents/skills`、`~/.mimi-agent/skills`、`~/.agents/skills`、npm 包自身的 `skills/`。同名时只注册最高优先级的有效候选，`/skills` 会显示来源、位置、active/stale/unavailable 状态；无效高优先级候选不会遮蔽有效 fallback。包内来源还必须在 `skills/manifest.json` 中标记 `published: true`，因此实验 Skill 不会被当作内置产品能力。

激活记录属于当前 Session，并以 Skill 名称、canonical 文件路径和 SHA-256 正文摘要幂等去重。`/skills active` 查看记录，`/skills deactivate <name>` 停用；`/skills reload` 只重建 registry，不会把同名新来源静默绑定到旧记录。激活正文每轮从 Session 恢复为完整的受保护 `active-skills` 指令区，因此重启、自动 collapse 和 `/compact` 不会令它失效，也不会伪造 user/assistant 历史；完整正文放不下时会明确失败，不会截断后继续。

YAML 元数据会按开放规范校验，无效 Skill 只产生诊断，不阻断其他 Skill。依赖可选运行时工具的 Skill 可声明 MimiAgent 扩展字段 `required-tools`（数组、逗号或空格分隔）；目录披露、显式/模型激活、恢复注入与资源读取都按当前 Run 的最终工具集和本地读取权 fail closed。`allowed-tools` 只保留为元数据，不能注册工具或扩大权限。`read_skill_resource` 还要求当前 Session 已激活同一份、未 stale 且本轮仍可用的绑定，并继续拒绝绝对路径、目录逃逸、symlink 逃逸和超过 256KB 的文本。

内置 Skill 工具：`use_skill`、`read_skill_resource`、`list_skills`、`reload_skills`。发布包保留 `code-review`、`computer-use`、`research` 和 `web-research` 四个 manifest allowlist Skill，项目与用户可在标准位置安装更多 Skills。

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

## Wiki ingest 与混合检索

将 Markdown 或文本来源放到 workspace，再显式执行：

```text
/memory ingest knowledge/sources/example.md
```

Memory 编译与查询流程：

```text
读取来源 → 校验 SourceRef/digest → 持久化多页 CompilationPlan → 逐页原子提交 → Lint/index/log → Wiki-first 召回
```

`auto` 模式在未配置 Embedding 时直接使用本地 FTS5/BM25，不创建本地推理 Provider，也不会在模型调用前加载 ONNX。显式设置专用 `MIMI_EMBEDDING_API_KEY`（可配 `MIMI_EMBEDDING_BASE_URL` 和 `EMBEDDING_MODEL`）才启用远程 OpenAI-compatible 向量通道；对话用的 OpenAI/DeepSeek Key 不会被自动复用。自然语言请求仍全部进入主模型，这里的 lexical/hybrid 只决定模型运行前如何召回相关 Memory。

仓库保留 direct BGE q8 的显式库级 Provider 和固定资产 manifest，供隔离实验或调用方主动注入，但 CLI/Daemon 不再默认选择它，自动 Context 召回也不会执行同步本地向量推理。没有显式 Provider 时，`/memory reindex` 只重建词法派生数据并在 status 中提示配置 Embedding Provider。

FTS5/BM25 是词法基线；`sqlite-vec@0.1.9` 只负责在同一 `memory.db` 存储 chunk vector 并执行 vec0 KNN，不拥有 Memory 正文，也不负责生成 embedding。启动会执行 `vec_version()` 和最小 KNN 自检；结构化、BM25 与 vec0 top-k 通过 RRF 合并，查询热路径不会把全部向量加载到 JavaScript。Vec、Embedding、模型/维度或 reindex 异常时回退 lexical-only；FTS5/BM25 建表或查询失败时再回退有界 `LIKE`，并在 status 标记 degraded。错误模型或维度绝不混搜。旧 BLOB 派生向量只在迁移校验期间读取，vec0 校验通过后删除；`/memory reindex` 只重建页面、向量和 links 等派生数据，不清空 suppression 与 compilation receipt。

2026-08-05 的 Darwin arm64 离线微基准记录了 direct BGE 的 warm query p95 2.111 ms；但真实常驻 Daemon 验收发现，同步 ONNX 的冷启动或争用会阻塞 IPC 和交互请求，因此该微基准不足以支持把它放进默认热路径。它同时存在明显跨语召回限制，所以当前产品选择 BM25/结构化基线和可选远程 Provider。

每个已完成的 Session round 都会作为 private episode 增量索引；owner 的普通 Memory 检索默认同时搜索已编译 Wiki 和全部历史 episode，因此新 Session 可以直接回忆其他 Session 的相关信息。private episode 不向外部来源或 SubAgent/Team 开放。Daemon 在普通 Task 终态事务中登记 observation，达到 10 条或最老等待 10 分钟后才创建低优先级 `memory_maintenance` Task；连续 50 个页面变化，或有变化且 7 天未 lint 时，把 semantic lint 合并进下一维护 Task。维护 Run 每批最多读取 20 条 observation，使用稳定的 `obs-N` 批内句柄和从 ≤8KB 不可变快照提取的 ≤4KB 可见证据，最多写 5 页且只能使用 Memory 工具；未完成整个批次的 Task 不能进入 completed。维护先形成 L1，只有至少两个互补 L1 足以支持可复用结论时才形成带 `derivedFrom` 的 inferred L2；单条 external/public 断言不能直接成为 active 事实。`/memory maintain` 可显式触发无网络的有界 semantic lint。

## Plan、Goal、Ultra Team、Trace 与 Eval

复杂任务使用 `update_plan` 管理当前步骤：阶段开始前标记 `running`，结束后立即更新为 `completed` 或 `failed`，再推进下一阶段。Session、mode、model、运行状态和 Plan 当前进度会作为紧凑会话状态注入每轮模型上下文；`update_plan` 返回的完整列表则是本轮后续推理的权威进度。需要跨多轮或跨重启时使用 `set_goal`，并通过 `update_goal` 保存状态、checkpoint 和 next action。`/resume` 会从持久状态生成恢复输入。两者共享当前唯一数据根中的 `plans.json`（新安装通常为 `.mimi-agent/plans.json`），不会产生重复的 Todo 系统。

通用模式可将独立研究或审查交给 `delegate_research`、`delegate_review`；Plan 与 Ultra 还提供只读 `delegate_architecture`。Ultra 的 `set_team_tasks` 与 `run_team` 才会启动 builder/tester 等角色。SubAgent 不继承 MCP、不包含委派工具，最终整合仍由主 Agent 负责。它们是当前 Run 内等待结果的 Runner，不是后台任务，也不会让当前对话提前返回。只有 `delegate_background_task` 会创建持久 Task 和 OS 进程，并通过 Outbox 异步通知。委派时可选 `executor: "codex"` 使用本机 Codex CLI：Mimi 只登记 Task、启动 detached runner 和展示进程/产物状态；Codex 独立完成工作并直接回写退出码、最终摘要、thread、PID、JSONL 与 summary 文件。Codex 缺失或失败不会回退给 Mimi，也不会触发相同任务的 Mimi Plan 或 Shell 重做。Ultra Team 借鉴 [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) 的 lead、共享任务和 mailbox 思想，但只保留本地 task list、依赖与有限并发，不引入复杂编排服务。

这四类执行面不共享调度器，但共享 WorkUnit 观测与结果字段：状态、摘要、
产物、证据和起止时间。终端、Trace 与 Completion Gate 因而不需要按
SubAgent、Team、Background、Codex 分别猜测结果格式；原有权限、路径
ownership、单层递归和 Codex 单 Attempt 约束保持不变。

运行生命周期、SubAgent 和 Team worker 事件通过轻量 Hooks 写入 `.mimi-agent/traces/<session-id>.jsonl`。Trace 只记录公开运行事件与公开 reasoning summary，不保存模型隐藏思维链。

运行类型检查、测试和 MemoryHub retrieval eval：

```bash
npm run check
npm test
npm run eval
npm run eval:memory
npm run eval:memory:local
npm run eval:security
npm run bench:capacity
npm run test:provider-contract
npm run test:api-contract
```

`npm run eval:memory` 使用临时目录复跑 20 个 fixtures 上的 60 个手写自然问题，分别报告 lexical/hybrid 的 correct、partial、evidence-insufficient、incorrect、来源覆盖率和 p50/p95，并执行 Vec 故障、错误维度、embedding 变化与 reindex 反向探针。真实 owner 问题只允许通过 [`evals/memory/README.md`](evals/memory/README.md) 的本机只读入口评测；入口只打开 owner profile 和显式当前 workspace，从 owner-trusted Memory provenance 定界 Session，复用生产 Catalog 检索，活动/变化 WAL 失败关闭并报告 incomplete，只输出无标签脱敏聚合，不保存问题、Memory 正文、ref 或私有路径，也不把命中冒充正确率。

`npm run eval:memory:local` 则使用零 Key 生产 LocalEmbeddingProvider 和合成临时文本，证明 lexical miss 经 ONNX BGE、vec0 SQL KNN 与 RRF 成为正确命中，再以禁止网络的新进程验证离线缓存启动；输出仅含模型身份、行数、状态、时延、内存和布尔结果。

容量基准不调用模型或读取用户状态；参数、隔离规则和结果解释见
[docs/BENCHMARKS.md](docs/BENCHMARKS.md)。
Provider contract 同样完全离线，固定 OpenAI/DeepSeek 的默认模型、profile、
Session 输入清洗和 Tool schema 兼容性，详见
[docs/PROVIDER_CONTRACTS.md](docs/PROVIDER_CONTRACTS.md)。
`eval:security` 用 checked-in 恶意输入矩阵验证 provenance、来源策略和安全档位
的交集不会被正文扩大，详见 [docs/SECURITY_EVALS.md](docs/SECURITY_EVALS.md)。
公共 npm 入口的运行时和 TypeScript 符号由版本化契约锁定，详见
[docs/PUBLIC_API.md](docs/PUBLIC_API.md)。

需要 API Key 的可选 Agent 行为评测会验证模型是否真实激活 Skill、调用 SubAgent、切换模式并执行 Ultra Team wave：

```bash
npm run eval:agent
npm run eval:canary -- --provider all
```

Provider canary 对 OpenAI/DeepSeek 各执行一个固定、低成本、Safe 档位的真实 Tool
任务；它不进入常规 CI，运行和脱敏报告格式见
[docs/PROVIDER_CANARY.md](docs/PROVIDER_CANARY.md)。

## 内置工具

| 类别 | 工具 |
|---|---|
| 文件 | `read_file`、`write_file`、`edit_file`、`apply_patch`、`move_file`、`list_directory`、`search_files`、`inspect_changes` |
| 系统与网络 | `inspect_processes`、`run_shell`、`http_request`、`web_search`、`current_time`、`calculate` |
| MemoryHub | `memory_search`、`memory_read`、`memory_links`、`remember`、`forget`、`memory_ingest` |
| Mimi Preferences | `list_mimi_preferences`、`add_mimi_preference`、`remove_mimi_preference` |
| Skill | `use_skill`、`read_skill_resource`、`list_skills`、`reload_skills` |
| 验收 / Plan / Goal | `prepare_task`、`finish_task`、`update_plan`、`show_plan`、`set_goal`、`update_goal`、`show_goal` |
| 后台任务 | `delegate_background_task`、`list_background_tasks`、`inspect_background_task`、`pause_background_task`、`resume_background_task`、`cancel_background_task`、`request_background_task_input`（按事件策略提供） |
| SubAgent | `delegate_research`、`delegate_architecture`、`delegate_review`（按模式提供） |
| Ultra Team | `set_team_tasks`、`show_team_tasks`、`claim_team_task`、`update_team_task`、`retry_team_task`、`run_team` |
| OpenAI 托管 | `code_interpreter`，以及 Provider 支持时的托管能力 |
| MCP | Server Tools、`list_mcp_resources`、`read_mcp_resource` |

文件工具保持小而可组合：`list_directory` 支持有界递归和 glob；`read_file` 保持默认全文字符串兼容，并在分段读取或显式请求元数据时返回 SHA-256；`search_files` 优先使用 ripgrep，并支持纯路径清单、正则、glob、大小写和上下文行，不可用时回退内置搜索；`edit_file` 负责精确局部替换；`apply_patch` 在校验全部 unified-diff hunk 与可选旧文件摘要后写入，当前不处理删除，重命名继续使用 `move_file`；`inspect_changes` 只读返回有界 Git status、diffstat 和 diff。Full Owner 的直接本机 CLI 或认证 Runtime HTTP 对话可通过这些文件工具访问 MimiAgent 运行数据；Safe、Workstation、后台/Team worker 和外部来源仍拒绝这些路径。`inspect_processes` 是一个窄例外：macOS 的 `ps`/`top` 不能从通用 Shell 沙箱可靠启动，它用固定 argv 返回有界 CPU/内存进程快照，不读取命令行参数，也不能控制进程。更复杂的 Git、数据库或业务能力应优先通过 Skill、MCP 或现有 Shell 工具组合，而不是继续堆内置工具。

## 有意保留的边界

MimiAgent 不追求复刻大型 Agent 平台的全部能力。当前不在运行内核中实现 Web UI、渠道 SDK、托管式消息网关、分布式任务、任意深度多 Agent 图、复杂工作流 DSL、企业向量数据库、完整 HITL 审批平台或容器集群；Task worker 只是同一台机器上的有界 OS 子进程，外部渠道通过隔离 Connector 接入，其余能力可由 MCP、Skill 或外围系统组合。

本机 owner 只由三档 Security 授权，不增加逐任务审批。Safe 只读；Workstation 允许工作区写入、沙箱 Shell 和本机网络读取，但不允许 Connector 外部事务、Computer Use、受信 MCP 或通用网络写入；Full Owner 才可使用这些完整能力。旧 `workspace/read-only/trusted` 字段只保留读取兼容，不再形成第二套决策。external/public 仍由最小来源策略隔离，Plan 模式始终只读。

在认证本机 Owner 的直接 CLI 或认证 localhost Runtime HTTP 命令中临时粘贴 credential、authorization 或 private key 时，MimiAgent 不再要求重复设置：`captureSensitiveText` 先生成脱敏输入和无原值指纹，Event、Task、正式 user input、Session、Trace、Memory、管理接口和 ExecutionLedger 始终只接触脱敏版本。原值只在 Daemon 内存 broker 中最多等待十五分钟，并以 Event + Session + provenance 绑定的一次性 lease 交给首次 Run。

若该 Run 冻结的档位是 Full Owner，lease 会作为仅本轮宿主上下文发送给配置的模型 Provider，使模型能理解、比较、校验或按要求使用值；同时只向主 Agent Shell 注入 `MIMI_EPHEMERAL_SECRET_1` 等变量。原值不得进入工具参数，Shell 只引用变量；SubAgent/Team 不继承 Shell 注入，MCP/Connector 不继承 lease。包含原值的工具参数会在账本前被拒绝，工具结果、错误、Trace、流式输出和最终回答会按当前 lease 精确脱敏。Run 完成、取消、Provider 最终失败、首次领取、超时或 Daemon 重启都会销毁能力，任务不会带原值自动重放。Safe/Workstation 只处理脱敏输入，不把原值发送给模型，也不会因此扩大权限。

## 项目文档

- [架构与设计不变量](docs/ARCHITECTURE.md)
- [本地容量基准](docs/BENCHMARKS.md)
- [Provider 兼容契约](docs/PROVIDER_CONTRACTS.md)
- [真实 Provider Canary](docs/PROVIDER_CANARY.md)
- [权限与 Prompt Injection Eval](docs/SECURITY_EVALS.md)
- [公共 API 兼容契约](docs/PUBLIC_API.md)
- [仓库与发布资产边界](docs/REPOSITORY_BOUNDARIES.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [版本记录](CHANGELOG.md)

欢迎提交 Issue 和 Pull Request。新增能力应优先帮助用户完成真实工作，同时保持本地优先、模块边界清晰和依赖克制。

## License

[MIT](LICENSE)
