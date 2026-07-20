# Security Policy

MimiAgent 是本地优先的通用 Agent。它可以帮助可信用户完成真实工作，但默认不是面向不可信租户的隔离执行服务。

## 权限模型

工具最终权限取运行模式、本地部署权限和事件策略的交集。认证本机 owner 默认使用 `trusted`，General/Ultra 可直接使用当前操作系统用户的 Shell 和内置工具，不增加逐任务审批；运行陌生仓库时可显式选择 `workspace`，纯检查部署可选择 `read-only`。已配置 Connector 由 Host 身份与事件策略控制；工作区 MCP 只需一次 `MIMI_TRUST_WORKSPACE_MCP` 明确信任，不再叠加 permission mode。Plan 始终只读；外部事件默认使用最小策略，只有命中 owner 明确配置的 source policy 才获得固定 `reply | work` 代办档位，旧策略默认安全的 `reply`。外部内容无论 provenance 都只能作为数据。

建议：

- 在专用测试目录、容器或虚拟机中运行。
- `trusted` Shell 等同当前操作系统用户权限，也能访问该用户可读的 `.mimi-agent` Session、Trace 和环境文件；私有路径屏蔽只约束内置文件与 Memory 工具，不是针对 owner Shell 的安全沙箱。
- Daemon 的 `0600` Unix Socket 不能单独证明 owner 身份。初始化会在同一 `0700` 数据根原子创建并校验稳定的 `0600` 随机 control bearer；CLI 和 OpenClaw Bridge 自动读取，Kernel 对除专用 Task worker broker 外的所有 RPC 做 constant-time 校验。bearer 不进入状态、环境、status、Doctor、日志或错误文本，运行中缺失、权限错误、格式错误或不匹配均 fail closed。Task worker 不读取该 bearer，只携带 Supervisor 分配且绑定当前 Task 的独立 `workerToken`；因此知道 Socket 路径不足以调用 submit、tasks、shutdown 等 owner 控制面。这个边界仍依赖 Daemon 私有目录对 Task 工具保持不可读，不能把同 UID 的任意未受约束本地代码描述成 OS 沙箱。
- 不要在工作区保存凭证、私钥或个人数据。
- 不要把 CLI 或 MCP Server 暴露给不可信用户。
- 审核第三方 Skill、知识文档和 MCP Server 后再启用。
- 运行陌生仓库前先审核项目 `MIMI.md`（或旧 `MIMI.md`）；它会影响模型行为，但不能扩大工具策略。
- Agent 可通过绝对路径修改 MimiAgent 自身或工作区代码；只在可信仓库中发出自修改请求，并通过 Git 审查和回滚变更。
- 远程 MCP Token 通过环境变量引用，不要直接写入 `mcp.json`。
- 不要让 Agent 访问包含敏感响应的内部 HTTP 服务。
- 定期检查模型 API 用量和 `.mimi-agent/traces/`。
- 除 `owner/system` 外的事件默认只保留当前 attempt 内的静默投递控制，并关闭通用网络读取、Session/Memory、本地文件、持久状态、Shell、MCP、未知工具和外部写事务。`trust` 是 Host 固定的 provenance 标签，不接受 payload 自报，也不直接授权。只有本机 owner source policy 的 source/kind/actor/conversation 全部命中时，事件才获得权限：`reply` 只可结合当前人物 Session 的有界上下文形成回复，绝不开放 Shell、文件写、`http_request`、`connector_action`、后台委派或 Team；只有显式 `work` 才获得静态工作工具集。多个匹配取最高档。长任务从仍被保留且确认为 conversation root 的 Event 重新计算同一授权；删除 policy、root/parent 缺失或指向 Task 时强制最小策略，即使 Task provenance 为 owner 也一样。Connector 边界继续实施身份白名单、速率限制和最小凭证。
- `workspaceAccess=read` 的后台 Task 使用确定性只读任务策略：可以读取/搜索工作区、Memory 和 Skill，使用只读网络与 `memory_search/read/links`，并更新自身 Plan/Goal/checkpoint、请求必要输入或调用工具集被硬限制为只读的 SubAgent；不能运行 Shell、写文件、调用 `http_request`/`connector_action`、继续委派后台任务或启动 Team。`workspaceAccess=write` 才保留来源授权允许的写能力，并由 Task Supervisor 做工作区互斥；Task lane 无论档位都不再开放 `delegate_background_task`，拆分只限当前 Task 内的 SubAgent/Ultra Team。
- 达到 `assistant.json` 中 `urgentPriority` 且会被 Attention 执行/通知的外部事件可以让低优先级模型思考让路。工具和外部事务不会被中途 abort，但持续伪造紧急事件的来源仍可能造成任务饥饿；应在 Connector/Webhook 边界验证身份、限制事件速率，并只给真实紧急信号高 priority。该阈值是调度优先级，不是权限等级。
- `assistant.json execution.runIdleTimeoutMs` 会中止连续无模型/Runtime 进展的 Run 并触发既有重试，但 Tool 在途时暂停，避免自动重放结果不确定的事务。它依赖 SDK/provider 遵守 AbortSignal，不是操作系统级强杀；macOS 上运行 `mimi` 会在持久 Provider Key 可用时自动接入 launchd，由其负责进程级异常恢复。
- `assistant.json maintenance` 默认删除 90 天前且已安全终结、没有活引用的控制面历史；dead letter、待执行/待投递/待简报状态不会自动删除。保留期也是 Event 去重窗口，极旧来源 ID 被重新回放时可能再次执行，因此高风险来源应同时使用自身游标和稳定回看边界。自动维护不执行 `VACUUM`。
- Memory maintenance 只能读取本机生成的有界 observation cards 和 Memory API，不能使用 Shell、通用文件、网络、MCP、Connector、Schedule、委派或用户 Session。单条 external/public observation 不能晋级为 active 事实；跨 Session episode 只有 owner 明确请求历史证据时可读，SubAgent/Team 永远只有 workspace Memory 视图。
- Event 或非系统渠道最终失败时会发送本机 system fallback。载荷不复制外部 payload、投递正文或 target，只包含有界 ID、source/channel、次数和错误摘要；错误文本本身仍可能含路径或 Provider 信息，并可能显示在 macOS 锁屏通知中。需要更严格隐私时应在系统设置中关闭 MimiAgent 通知预览。system fallback 自身失败不会递归。
- 首次启动会默认启用十一个 macOS 本机 Connector，但 QQ/微信 UI 自动化不在默认集合，也不会在后台 API 失败时自动降级为截图、OCR、模拟输入或点击。首次访问 Calendar、Mail、Messages、Contacts、Notes、Accessibility、Browser Automation、Screen Recording、Microphone 或 Speech Recognition 时，macOS 仍可能向实际 Node/Terminal/LaunchAgent 请求授权。无需这些能力时在 `~/.mimi-agent/daemon/connectors.json`（或旧目录）中关闭对应项；初始化不会覆盖该选择。
- 软件升级会为仍指向同名内置脚本的 Connector 自动补齐新增 action；它不会开启已关闭的 Connector，也不会修改路径、环境、来源、超时和已有描述。若需要维持精确删减后的 action 目录，请在删除前设置 `syncTemplateActions:false`。这个开关只控制 catalog 同步，不构成权限或审批层。
- `daemon connectors reload` 会立即应用最新 Connector 命令、环境白名单和 action 目录。新配置会先验证，在途投递/action 存在时拒绝换代；但配置有效不代表外部程序可信，启用前仍应审核命令路径和传入的凭证。重载不会给 action 增加审批层。
- macOS System Connector 每分钟读取电池、内存、CPU 负载、非 loopback IP 地址和指定文件系统容量。它不需要额外系统隐私权限，也不读取 SSID、进程列表或文件正文；IP 地址和磁盘路径仍会进入本机模型上下文。无需主动系统健康事件时可将 `MACOS_SYSTEM_POLL_INTERVAL_MS=0`，action 仍可按需使用。
- macOS Life Connector 可创建、修改和删除 Calendar 日程与 Reminders 提醒事项。MimiAgent 不增加逐次审批；稳定 UID/ID、可选容器范围和不确定事务不重放用于避免误选与重复执行，但不能撤销 owner Standing Orders 或模型主动做出的真实更改。重要共享日历和提醒列表仍应依赖系统账号自身的恢复/审计能力。
- macOS Life/Mail/Messages、File Radar、Contacts、Notes、Shortcuts 与 Desktop Connector 的内置 provenance 为 `external`；本机 Connector 固定了来源也不表示其日程、文件、邮件、消息或剪贴板内容可信。此类入站默认没有私有上下文或 action；owner 可用精确 source policy 的 `reply` 档开放有界会话回复，只有明确选择 `work` 后才可读取本地资料、发信或处理工作，并继续受部署权限、执行账本和账号恢复能力约束。
- OpenClaw 微信桥的 pairing 不是 MimiAgent owner 认证。插件 `ownerSenders` 必须配置精确 `sender` 或 `account:sender`；只有命中项才进入 owner Session 并使用 owner provenance，未配置或未命中者固定作为 `external` 且不会读取 owner Session。
- NapCat/OneBot 是个人 QQ 的非官方协议路径，不等同于腾讯官方 API，可能触发账号风控并需要修改 QQ Electron 入口。只在可承受风险的账号上使用，固定 loopback HTTP/WS、强 token 和单一反向 WebSocket 上游；升级 QQ 或 NapCat 前先回归，不能接受该风险时改用能力范围更窄的腾讯官方 QQ Bot。macOS 安装器要求 GitHub Release SHA-256 digest、兼容 QQ build、完整代码签名、Apple 执行策略、腾讯 Team ID 和已知入口同时成立，保留精确备份并提供 `restore`；推荐修改经过同样校验的 owner-only 私有 QQ 副本，不修改系统应用。NapCat 入口在导入第三方代码前把 Electron activation policy 设为 `prohibited`，API 缺失即失败；所选路径仅持久化在 `0600` 状态文件中。系统 QQ 或私有普通 QQ 正在运行、入口被升级重置或 Shell 缺失时，LaunchAgent 启动守卫也会失败关闭，不能退化成普通 QQ UI 启动。
- `assistant.json` Standing Orders 与 source policies 是本机 owner 管理的可信替身策略，文件权限固定为 `0600`，状态接口不返回正文。全局 Standing Orders 自身不授权外部来源；命中的 source policy 才授予固定 `reply | work` 代办档位，并把全局/局部规则作为 Host 指令注入。外部消息正文仍不是指令，且替身 Run 没有修改这些策略的工具。仍应避免在配置中保存密码或 token。
- `assistant.json` Daily Routines 同样是 owner 可信指令，会在本地时点按当前部署权限主动运行，即使当时没有外部事件。只配置愿意无人值守执行的检查和事务，不在 prompt 中保存密码、token 或复制外部消息；状态接口只返回例程总数和启用数。
- MimiAgent 可以无需逐次确认主动写入跨 Session Memory，但 Host 强制 profile/scope/source/trust/suppression 和 immutable Run ownership。外部/public Run 不能直接写 active Memory；workspace Wiki 只接受明确文件来源，private profile 使用独立 Vault/SQLite；密码、token 和密钥在写入前拒绝。owner 明确说“不要记住”会阻止本轮写入，`forget` 会删除页面并写无正文 suppression。使用 `/memory list|read|lint|forget` 检查和清理长期状态。
- `assistant.json people` 的 alias 和人物 context 是 owner 可信配置。alias 可为匹配渠道派生稳定、符合核心 schema 的 Person Session ID；默认受限事件不读取该 Session，也不会携带 canonical person 或注入人物 context，命中 owner source policy 后才可在替身判断中使用这些元数据。系统不自动验证两种地址是否属于同一人；优先配置精确 alias，并避免在 context 中保存密码、token 或不必要的敏感资料。
- macOS Messages Connector 需要“完全磁盘访问权限”才能只读 `~/Library/Messages/chat.db` 和本地附件目录。该系统授权会让对应进程访问消息历史、图片和文件；只授予实际使用的可执行程序。Connector 不写 Messages 数据库，文本和文件发送仅走系统自动化接口，但组合发送中途失败时前序项可能已经送达。
- macOS Contacts Connector 会读取并可修改系统通讯录。查询与写入仍分别受事件策略、部署权限和 macOS 隐私授权约束；通讯录不会被 MimiAgent 另行镜像。
- macOS Notes Connector 会读取并可修改 Apple Notes。查询与写入仍分别受事件策略、部署权限和 macOS 自动化授权约束；Connector 不解锁密码保护笔记，也不镜像 Notes 数据库。
- macOS Shortcuts Connector 可以运行用户已有的任意快捷指令；快捷指令可能控制文件、网络、应用、账号和智能家居。MimiAgent 不增加审批层，系统权限提示和 Shortcut 自身配置是实际边界。内联输入使用 `0600` 临时文件并在执行后删除，现有输入/输出文件必须使用绝对路径。
- macOS Desktop Connector 可读取前台应用、窗口和文本剪贴板，并通过 Accessibility/Automation 激活应用、发送键盘操作和点击菜单。启用剪贴板轮询可能把复制的密码、令牌或私人内容作为 Event 交给 Agent，因此默认关闭；只在理解该数据会进入模型上下文时设置 `MACOS_DESKTOP_CLIPBOARD_POLL_MS`。Connector 自身写入会更新基线以避免自触发，但 macOS 的受保护输入框和权限提示仍是实际系统边界。
- macOS Browser Connector 复用 Safari/Chrome 当前 profile、Cookie 和登录态，可读取页面正文并执行 JavaScript，因此能代表用户操作已登录网站和访问其中的敏感数据。只在接受该能力边界时启用浏览器 Automation/Apple Events JavaScript；页面内容继续按外部不可信数据处理，Connector 不保存浏览历史或 Cookie。
- macOS Screen Connector 获得 Screen Recording 权限后可读取屏幕上显示的消息、密码、令牌和私人内容。它不持续录屏，`read_screen` 会在 OCR 后删除临时图片，只有 `capture_screen` 会保存到 owner 明确指定的路径；OCR 文本和坐标仍会进入模型上下文并按外部不可信数据处理。只向实际使用的 Terminal/Node/LaunchAgent 授予系统权限。
- macOS Voice Connector 开启 listener 后会持续使用麦克风和 Speech Recognition 权限。原始音频不落盘，非唤醒语音不产生 Event，但附近的人可能尝试发出唤醒命令；内置配置因此固定为 `external`。只有另行完成说话人认证，或 owner 明确接受物理环境中的任何人都能唤醒完整权限，才可在本机 Connector 配置中改为 `owner` provenance。
- File Radar 会把配置目录中的绝对路径、文件名、大小和时间作为 Event 元数据交给 Agent；它不读取正文或跟随符号链接。事件能否继续读取或修改文件由其 event policy 与部署权限共同决定。

## 凭证

API Key 只能放在被 Git 忽略的 `.env` 或进程环境变量中。`.env.example` 只能包含占位符。

如果 Key 曾经出现在终端共享记录、Git 历史或公开 Issue 中，请立即在对应平台撤销并重新生成；仅从文件中删除不能使旧 Key 失效。

## 报告问题

请不要在公开 Issue 中披露可直接利用的漏洞、真实凭证或个人数据。优先使用 GitHub 仓库的私密漏洞报告功能；如果该功能不可用，请只创建不包含利用细节的 Issue，请求维护者提供私密联系方式。

报告中请包含受影响版本、复现条件、影响范围和建议修复方向。
