# Mimi常驻 Agent 实施计划

日期：2026-07-14  
状态：第三十三阶段已完成，总体目标继续推进（用户已明确要求不再等待确认）  
关联调研：`docs/research/20260714-Mimi常驻Agent-调研.md`

## 任务目标

将 MimiAgent 扩展为可在用户电脑上长期运行的个人助手底座：能持久接收多来源事件，根据注意力策略决定忽略、摘要、通知或执行，在崩溃和重启后恢复，并为大象、QQ、微信、新闻、天气、日历和提醒事项等 Connector 提供统一协议。所有事件默认具有完整 Runtime 能力，来源标签只用于 provenance、Attention 和审计。

## 方案概述

保留现有 MimiAgent Runtime 作为唯一智能执行内核，新增一个单进程 Daemon Host。Host 通过 SQLite WAL 管理可靠事件控制面，通过 Unix Domain Socket 提供本地控制和任务提交，通过单 Dispatcher 调用 AgentRunService。

## UI 变动检测

涉及 UI 变动：否  
变动类型：CLI 命令与后台服务  
预览状态：不适用

## 详细步骤

### 1. 抽取统一 Run 服务

**涉及文件：** `src/runtime/run-service.ts`、`src/runtime/bootstrap.ts`、`src/index.ts`

- 把 stream 消费、完成/失败提交、usage 统计从 CLI 移出。
- 终端通过 Observer 渲染事件，不再负责运行正确性。
- 抽出 OpenAI Client、代理 fetch 和 tracing 的共享启动逻辑。

```ts
interface RunRequest {
  input: string;
  signal?: AbortSignal;
  cause?: RunCause;
  policy?: RunPolicy;
}
```

### 2. 增加事件 provenance 与统一 Tool Policy

**涉及文件：** `src/runtime/mimi-agent.ts`、`src/runtime/tool-policy.ts`

- 所有事件来源默认沿用完整 Runtime 能力。
- `owner/trusted/external/public/system` 是 provenance 标签，不映射为权限等级。
- Tool Policy 继续集中记录副作用分类，用于语义执行台账和 Team 工具范围，不做事件审批。
- 将事件 provenance 作为结构化上下文注入，外部正文明确标记为来源数据。

### 3. 实现持久控制面

**涉及文件：** `src/daemon/types.ts`、`src/daemon/store.ts`

- SQLite WAL schema 覆盖 Event、Run、Outbox、Lease、Audit、Schedule、Digest 和 Attention State。
- 事件按 `source + externalId` 去重。
- claim 使用 lease owner / lease until，失败使用指数退避并最终进入 dead letter。
- 事件终态与 Outbox 在一个事务内提交。

### 4. 实现 Daemon 调度与主动通知

**涉及文件：** `src/daemon/policy.ts`、`src/daemon/dispatcher.ts`、`src/daemon/notifier.ts`

- 区分 command / alert / ambient / schedule 事件。
- 低价值 ambient 事件不启动模型。
- 可执行事件路由到稳定 Session，并在有界 Run 中处理。
- 结果先写 Outbox，再由 delivery loop 发送；macOS 支持系统通知。

### 5. 实现本地 IPC 与 CLI 管理

**涉及文件：** `src/daemon/ipc.ts`、`src/daemon/service.ts`、`src/index.ts`

- Unix Socket 仅允许当前 OS 用户访问。
- 命令：`daemon run/start/stop/status/submit/events/runs/connectors/attention/digest/brief/schedule`。
- `submit --wait` 可作为无头任务提交入口。
- 服务使用操作系统 supervisor 的安装接口作为后续扩展，首版先提供前台与 detached 启动。

### 6. 验证与文档

**涉及文件：** `tests/run-service.test.ts`、`tests/daemon-store.test.ts`、`tests/daemon.test.ts`、`README.md`、`docs/ARCHITECTURE.md`

- 覆盖去重、lease 恢复、重试/dead letter、事务 Outbox、Schedule、IPC 和受限 Run Policy。
- 运行 typecheck、全量测试、build 和 package smoke test。

## 权衡与考量

- SQLite 只承担长期常驻所需的可靠控制面，现有 Session/Memory/RAG 不作大规模迁移。
- 首版使用单 Dispatcher，优先正确性、可观测性和可恢复性。
- 不在首版引入通用工作流 DSL；长任务继续复用 Goal/Plan/Checkpoint，Schedule 只负责唤醒。
- 第三方 Connector 不默认与 Daemon 同进程，避免单渠道崩溃或凭证泄露拖垮主进程。

## Todo List

- [x] 抽取 AgentRunService 和 bootstrap
- [x] 增加 Event Run Policy
- [x] 实现 SQLite 控制面
- [x] 实现 Dispatcher 与 Notifier
- [x] 实现 Unix Socket IPC 和 CLI 命令
- [x] 实现隔离 Connector、认证 Webhook 与 launchd 自启
- [x] 实现开放权限 Connector Action Bridge 与事件级副作用幂等
- [x] 补齐测试和文档
- [x] 运行全量质量门禁

## 第二阶段：注意力管理与主动简报

在可靠事件底座上增加一个确定性的 Attention Engine，不引入第二套 Agent Runtime 或工作流框架：

- [x] 增加 `assistant.json` 用户画像、时区、静默时段、自治预算和有序来源规则
- [x] 将 run / digest / notify / ignore 四类决策接入 Dispatcher
- [x] 升级 SQLite schema v3，持久化摘要池与简报 checkpoint
- [x] 到达配置时点时合并摘要，生成普通内部 briefing Event
- [x] 简报成功后归档摘要，dead letter 后自动释放并允许下一次重领
- [x] 增加 `daemon attention / digest / brief` IPC 与 CLI 命令
- [x] 覆盖规则、静默时段、预算、幂等简报和失败恢复测试
- [x] 增加注意力策略文档与配置示例

## 第三阶段：自主后续唤醒

让 owner 事件中的 Mimi 可以为当前事务创建未来工作，同时继续复用现有 Schedule 和事件循环：

- [x] 增加一次性 follow-up 与周期 routine Host Tool
- [x] 增加计划查询和精确取消工具
- [x] 后续 Event 继承发起事件的 Session、profile、trust provenance 与 reply route
- [x] 限制最短时间、最短周期、最远时间与启用计划总量，避免失控自循环
- [x] 将创建和取消注册为 `state-write` 副作用，复用事件级语义账本去重
- [x] 所有来源都可直接建立计划，不按 trust 分级权限
- [x] 覆盖创建、触发、取消、provenance 继承和 changed call ID 重试测试

## 第四阶段：开放执行与 Connector Action Bridge

让任何事件来源都可代表用户直接处理事务，同时用进程隔离和语义去重保持可靠性：

- [x] 移除按 trust 分级的 Event RunPolicy，所有来源沿用完整 Runtime 能力
- [x] 通用 `connector_action` 工具与 `action/action_result` NDJSON 协议
- [x] Connector 配置声明 action 能力目录、独立超时和在线状态
- [x] 大象与 QQ 示例支持主动 `send_message`
- [x] 子进程断线或超时时失败且不自动重放
- [x] Schema v5 新库移除 Approval/Mandate 表和公开控制面，旧库无损前进
- [x] 完整 CI 和编译后真子进程 action 端到端验证

## 第五阶段：macOS 工作/生活连接器

用一个无 npm 依赖的独立 Connector 扩展本机事务，不让平台代码进入 Runtime 核心：

- [x] 增加 macOS Notification Center 主动通知
- [x] 增加 Calendar 查询和创建 action
- [x] 增加 Reminders 查询、创建和完成 action
- [x] 低频轮询即将开始的日程和到期提醒，转为可去重 `alert` Event
- [x] 参数使用 argv/JSON 传递，不经 Shell 拼接
- [x] 增加 mock `osascript` 协议测试和 npm 包内容验证

## 第六阶段：主动信息雷达

用单个轻量 Connector 汇聚无回调的外部信息源，让 Mimi 从等待消息进一步变成持续感知：

- [x] 零依赖 RSS 2.x / Atom 有界解析和关键词过滤
- [x] Open-Meteo 小时预报与降水、阵风、高低温、天气代码阈值
- [x] 稳定 externalId，复用中心 Store 跨重启去重
- [x] `refresh`、`weather_snapshot`、`sources` 主动 action
- [x] 独立多 source 配置、超时、响应大小上限和条目上限
- [x] 本机 HTTP fixture 覆盖 RSS、Atom、天气与 action
- [x] 完整 CI 和 npm 包验证

## 第七阶段：Apple Mail 工作事务入口

复用本机 Apple Mail 账号和 Keychain，让 Mimi 不仅能看到邮件，还能完成常用邮件事务：

- [x] 零依赖 Apple Mail JXA Connector
- [x] 统一收件箱未读轮询、正文截断与稳定 externalId
- [x] 按发件人和归一化主题路由稳定 Session
- [x] `list_unread`、`read_message`、`send_message`、`reply_message`、`mark_read`、`create_draft` actions
- [x] 显式邮件 delivery，入站 Event 不自动回复
- [x] 参数限制、邮箱校验和无 Shell 拼接边界
- [x] mock `osascript` 端到端测试
- [x] 完整 CI 和 npm 包验证

## 第八阶段：macOS Messages 实时沟通入口

用只读消息感知与系统发送接口接入本机 iMessage、SMS 和 RCS，不把 Messages 私有实现扩散到 Runtime：

- [x] `node:sqlite` 只读打开 Messages 数据库并验证最小 schema
- [x] 有界轮询新来信、稳定 externalId、conversation 与原会话 reply route
- [x] `list_chats`、`recent_messages`、`send_message` actions
- [x] Messages JXA 发送与可靠 Outbox delivery
- [x] Full Disk Access、自动化授权与 attributed body 限制文档
- [x] 合成 SQLite fixture 和 mock `osascript` 端到端测试
- [x] 完整 CI 和 npm 包验证

## 第九阶段：macOS 通讯录人物目录

让 Mimi 能把自然语言中的人解析为真实联系方式，并复用现有 Mail/Messages 执行事务：

- [x] 无依赖、无轮询的 Contacts JXA Connector
- [x] `search_contacts` 和 `get_contact` 有界候选与稳定 ID
- [x] `create_contact` 和 `update_contact` 显式保存及追加联系方式
- [x] 字段、数组、结果体积和 JSON argv 边界
- [x] mock `osascript` 端到端测试和 npm 包内容检查
- [x] 完整 CI 验证

## 第十阶段：文件活动雷达

让 Mimi 主动感知 Downloads、Desktop、共享落盘目录和自动化输出，再复用现有文件工具完成处理：

- [x] 零依赖、有界轮询的文件元数据 Connector
- [x] 多 watch、有限递归、扩展名过滤、隐藏文件和符号链接边界
- [x] `watchId + path + mtime + size` 稳定 Event 身份
- [x] `scan_now`、`recent_files`、`watches` actions
- [x] 独立示例配置、fixture 测试和 npm 包内容检查
- [x] 完整 CI 验证

## 第十一阶段：Apple Notes 知识与记录入口

让 Mimi 能直接读取和沉淀工作记录、会议纪要、生活清单及随手知识：

- [x] 无依赖、无轮询、无本地镜像的 Notes JXA Connector
- [x] `list_folders`、`search_notes`、`read_note` actions
- [x] `create_note`、`update_note`、`append_note` actions
- [x] plain/html 正文、密码保护、附件元数据和结果体积边界
- [x] mock `osascript` 测试和 npm 包内容检查
- [x] 完整 CI 验证

## 第十二阶段：macOS Shortcuts 通用能力总线

复用用户已有快捷指令扩展应用控制、文件处理、网络事务和智能家居，而不引入第二套工作流：

- [x] 无依赖、action-only 的系统 `shortcuts` CLI Connector
- [x] `list_shortcuts`、`list_folders`、`run_shortcut` actions
- [x] text/base64/文件输入、stdout/文件输出和 UTI
- [x] 临时文件权限与清理、超时、输出和路径边界
- [x] mock CLI 测试和 npm 包内容检查
- [x] 完整 CI 验证

## 第十三阶段：Connector 自愈健康监控

让长期运行的 Mimi 不再静默失去信息源，并避免重启抖动制造通知风暴：

- [x] 首次异常退出生成可靠内部健康告警
- [x] 同一故障窗口内连续失败不重复告警
- [x] 子进程稳定运行后才报告恢复
- [x] 正常停止、禁用 Connector 和显式关闭健康事件不告警
- [x] 复用 Attention、Inbox 与 Outbox，不增加监控表或第二工作流
- [x] 完整 CI 验证

## 第十四阶段：macOS 通用桌面控制

让 Mimi 在没有专用 API 的应用中也能感知上下文和直接完成桌面事务：

- [x] 前台应用、运行应用和窗口上下文查询
- [x] 应用激活、URL/绝对路径打开
- [x] 文本剪贴板读取、写入和可选变化事件
- [x] 有界键盘、key code 和一级菜单操作
- [x] argv-only、Accessibility 边界和不确定结果不重放
- [x] mock 系统命令测试、发布包检查和完整 CI

## 第十五阶段：Standing Orders 替身决策

让 Mimi 针对不同来源、人物和会话按 owner 长期原则直接代为处理：

- [x] daemon-only 全局 Standing Orders，与 MIMI.md 明确分工
- [x] source/kind/actor/conversation 有序匹配与多规则合并
- [x] 本地可信策略与外部不可信正文明确分区
- [x] 旧配置兼容、热重载和 20000 字符总上限
- [x] status 只暴露计数、不泄漏规则原文
- [x] 聚焦测试、文档和完整 CI

## 第十六阶段：macOS 已登录浏览器执行面

让 Mimi 能直接复用 Safari/Chrome 当前登录会话完成网页事务：

- [x] Safari/Chrome 标签页查询和结构化引用
- [x] 打开、导航、激活、关闭和刷新动作
- [x] 有界页面正文读取与 JavaScript DOM 执行
- [x] argv-only、外部数据和不确定结果边界
- [x] mock 系统命令测试、发布包检查和完整 CI

## 第十七阶段：macOS 原生屏幕感知

让 Mimi 在浏览器 DOM 和应用接口不可用时仍能理解当前屏幕文字：

- [x] 主屏、display、window 和矩形区域静默截图
- [x] Vision Framework 本地有界 OCR
- [x] 临时截图成功、失败、超时均清理
- [x] action-only、argv-only、无持续录屏和无图片历史库
- [x] mock 命令测试、Swift typecheck、发布包检查和完整 CI

## 第十八阶段：macOS 原生语音交互

让 Mimi 长期在线时也能免键盘接收 owner 命令并主动朗读：

- [x] “Mimi/Mimi”唤醒短语与高优先级 command Event
- [x] Speech Framework 分段麦克风监听和音频文件转写
- [x] 系统 `say` 朗读、声音目录和朗读期间回声抑制
- [x] 默认关闭、无原始音频保存、短期重复抑制和有界输出
- [x] mock 协议测试、Swift typecheck、发布包检查和完整 CI

## 第十九阶段：主动日常例程

让 Mimi 在没有新消息时也按 owner 的本地日常节奏主动工作：

- [x] assistant.json 有界 daily routine 配置和开箱默认值
- [x] 本地时区、weekday、晚启动补发与跨重启每日幂等
- [x] 普通 owner schedule Event、稳定 Session 和 reply route
- [x] 热重载、状态隐私和 prompt 总量边界
- [x] 聚焦测试、文档和完整 CI

## 第二十阶段：自主长期记忆

让 Mimi 在长期替 owner 工作时自行沉淀未来仍有价值的上下文：

- [x] 无需逐次确认的 owner 偏好、事实、决策和承诺写入
- [x] Session、Event、source trust 来源审计
- [x] 旧 Memory 隔离兼容和新记录可用标记
- [x] 明确“不记住”、秘密与容量边界
- [x] 聚焦测试、文档和完整 CI

## 第二十一阶段：跨渠道人物上下文

让 Mimi 在不同通信渠道中连续理解同一个人：

- [x] owner-managed canonical people 与 source/actor aliases
- [x] 跨渠道稳定 Person Session，显式 sessionKey 仍优先
- [x] 人物可信 context 与外部正文分区
- [x] Person/actor/conversation Memory provenance 与召回
- [x] 热重载、隐私状态、边界测试和完整 CI

## 第二十二阶段：本机初始化与 Doctor

让 Mimi 从“代码里有能力”变成首次启动即可实际加载本机能力：

- [x] 首次启动自动物化绝对路径 Connector 配置
- [x] macOS 本机 Connector 默认开放，凭证型外部来源保持待配置
- [x] 已有 owner 配置幂等不覆盖
- [x] 无模型、无真实数据读取的 `daemon doctor`
- [x] CLI、权限、打包、边界测试和完整 CI

## 第二十三阶段：macOS 系统状态感知

让 Mimi 不依赖人工询问也能理解电脑自身的关键状态：

- [x] 电池、内存、负载、网络和磁盘有界快照
- [x] 低/危急电量、网络断开/恢复和低磁盘主动事件
- [x] 网络初始静默、状态边沿抑制和跨重启事件去重
- [x] macOS 本机默认启用、Doctor 与发布包接入
- [x] mock 系统状态测试、文档和完整 CI

## 第二十四阶段：macOS 生活事务完整闭环

让 Mimi 真正完成日程与提醒的整个生命周期，而不只负责创建：

- [x] Calendar 稳定 UID 查找与 update/delete
- [x] Reminders 稳定 ID 查找与 update/delete
- [x] 有效日期、priority、非空变更与明确 not-found 边界
- [x] 继续使用 argv-only 和不确定外部事务不重放语义
- [x] mock 系统命令测试、catalog、文档和完整 CI

## 第二十五阶段：Apple Mail 附件事务闭环

让 Mimi 能实际接收和交付工作文档，而不只处理邮件文字：

- [x] 收件附件稳定 ID、名称、MIME、大小与下载状态目录
- [x] 显式绝对路径、0600 临时文件与原子 no-clobber/overwrite 保存
- [x] send/draft/reply 最多 20 个有界普通文件附件
- [x] 不信任附件名、不跟随 symlink、不把二进制塞进 NDJSON
- [x] fake Mail/mock osascript 测试、catalog、文档和完整 CI

## 第二十六阶段：Apple Mail 收件箱整理闭环

让 Mimi 能长期维护工作收件箱，而不只逐封读写邮件：

- [x] 统一收件箱按账号、发件人/主题、已读和旗标有界搜索
- [x] 账号邮箱目录递归列举与无歧义路径标识
- [x] 稳定 message ID 旗标、显式目录移动和删除事务
- [x] 不硬编码本地化归档目录、不新增邮箱镜像或批量 DSL
- [x] fake Mail/mock osascript 测试、catalog、文档和完整 CI

## 第二十七阶段：macOS Messages 附件事务闭环

让 Mimi 能在日常 iMessage/SMS/RCS 沟通中实际接收和交付文件：

- [x] 只读 attachment 关联、稳定 ID、名称、MIME、大小、状态与 availability
- [x] 显式绝对路径、0600 临时副本与原子 no-clobber/overwrite 保存
- [x] send/delivery 文本或最多 20 个有界普通文件
- [x] 不自动复制轮询附件、不写 Messages 私有数据库、不解析 typedstream
- [x] SQLite fixture/fake JXA/mock osascript、catalog、文档和完整 CI

## 第二十八阶段：内置 Connector 能力目录自动升级

让长期安装的 Mimi 在软件升级后真正获得新增能力，而不要求 owner 手抄 action catalog：

- [x] 同内置脚本缺失 action 的只增不改合并
- [x] enabled、路径、环境、来源、超时和已有描述全部保留
- [x] `syncTemplateActions:false` 单开关固定自定义 action 集合
- [x] 同目录 0600 临时文件与 atomic rename、无变化不写盘
- [x] 旧 catalog/opt-out/幂等测试、文档和完整 CI

## 第二十九阶段：Connector 显式热重载

让长期运行的 Mimi 无需重启整个 Daemon 即可安全更新渠道能力：

- [x] 新配置先完整校验，无效配置保持旧集合在线
- [x] 同一 Manager 原位换代，Dispatcher 与 action execute 路径自动使用新集合
- [x] 在途 deliver/action busy guard，避免中断结果不确定的外部事务
- [x] Notifier 旧 sink 精确注销，删除渠道不残留离线路由
- [x] CLI/RPC、能力刷新/删除测试、文档和完整 CI

## 第三十阶段：紧急事件安全抢占

让 Mimi 在低优先级长任务运行中仍能及时响应关键告警和 owner 紧急命令：

- [x] 复用 Attention urgentPriority，不增加第二套优先级配置
- [x] 只允许 ready、达到阈值且严格更高优先级的 Event 抢占
- [x] 抢占无失败重试惩罚，Host Run 标记 interrupted 并保留副作用 ledger
- [x] 保持单 Dispatcher/单 Agent，不打断 Outbox 和 Connector 外部事务
- [x] 低任务→紧急任务→低任务续跑顺序测试、文档和完整 CI

## 第三十一阶段：最终失败主动升级

让无人值守任务和渠道投递失败不再静默沉入 dead letter：

- [x] Event 最终失败原子创建本机 system 通知
- [x] 非 system Outbox 最终失败回落到 system 通知
- [x] system fallback 自身失败不递归、不形成告警风暴
- [x] 只携带有界元数据和错误摘要，不复制外部正文
- [x] retry/terminal/递归边界测试、文档和完整 CI

## 第三十二阶段：运行卡死回收与优雅停机

让单 Dispatcher 不会因模型无响应永久停止工作，并让正常重启不伤害任务：

- [x] `assistant.json` 增加可热重载的模型无进展超时
- [x] 模型/Runtime 进展刷新 watchdog，Tool 执行期间暂停
- [x] 超时复用失败重试与最终主动升级
- [x] Daemon 优雅停机无惩罚重排队
- [x] timeout/tool/shutdown 边界测试、文档和完整 CI

## 第三十三阶段：长期运行历史保留

让持续接收事件的 SQLite 控制面保持有界，同时保留所有活状态与失败修复证据：

- [x] `assistant.json` 增加可热重载的维护周期和保留期
- [x] 按外键顺序清理 sent/archived/terminal 历史
- [x] queued/running/dead letter/pending/sending/未归档摘要永不自动删
- [x] 复用 Dispatcher 低频检查，不新增维护线程或服务
- [x] retention/引用保护/禁用测试、文档和完整 CI

## 第三十四阶段：死信显式处置

让 owner 能在不引入审批系统的前提下修复或关闭长期运行失败：

- [x] Event dead letter 原 ID 显式重试或归档
- [x] Outbox dead letter 原 ID 显式重试或归档，并提示可能重复投递
- [x] archived 纳入统计、Digest 释放与历史保留
- [x] RPC/CLI 薄控制面，不做后台自动重放
- [x] 状态边界、并发 CAS、保留清理测试、文档和完整 CI

## 第三十五阶段：运行自省与主动汇报

让 Mimi 能在不建立监控子系统的前提下理解并汇报自己的运行状态：

- [x] Store 统一生成有界运行快照
- [x] Agent 获得只读 `inspect_mimi_activity` Host Tool
- [x] CLI/RPC 复用同一 activity 视图
- [x] 不暴露其他 Event 正文、Run 答案、Outbox 内容或 target
- [x] 快照/策略/注入/控制面测试、文档和完整 CI

## 第三十六阶段：Connector 动态能力感知

让 Mimi 在执行外部事务前知道当前可用执行面，而不是盲调离线渠道：

- [x] 有界 Connector capability snapshot
- [x] Agent 动态刷新 online/disabled/action 目录
- [x] `connector_action` 初始描述标注实时状态
- [x] 不自动重放结果不确定事务，不增加 fallback 引擎
- [x] 上下线/边界/策略/注入测试、文档和完整 CI

## 第三十七阶段：Apple Mail 历史邮箱事务闭环

让 Mimi 能检索并处理显式归档目录中的工作历史，而不扫描全部邮箱：

- [x] `search_messages` 可选精确账号+邮箱路径
- [x] 历史邮件 read/attachments/reply/mark/move/delete source locator
- [x] 默认统一收件箱行为保持兼容
- [x] 不遍历所有邮箱、不猜本地化目录、不建立邮件镜像
- [x] 路径/wildcard/歧义/事务测试、文档和完整 CI

## 第三十八阶段：Owner 主动投递路由

让无来源回信地址的自主任务处理结果也能可靠抵达 owner：

- [x] `owner.replyRoute` 单一默认投递地址与旧配置兼容
- [x] 来源 reply route 优先，缺失时统一回落 owner route
- [x] Routine、Briefing 和 Schedule 支持具体 Connector target
- [x] status 不暴露 target，不新增 fan-out、路由 DSL 或审批层
- [x] 路由继承/热重载/投递测试、文档和完整 CI

## 第三十九阶段：认证回调中继与会话回路

让大象等官方服务端回调经过本机 relay 后仍能形成可靠双向事务：

- [x] Webhook `reply.connector/target` 严格 schema
- [x] actor、conversation、externalId 与原会话 ReplyRoute 完整保留
- [x] `notify:false` 在 owner fallback 下仍明确无回传
- [x] 不伪造大象 Thrift/OCTO、不暴露公网端口、不新增依赖或任务表
- [x] 幂等/认证/路由/边界测试、文档和完整 CI

## 第四十阶段：静默自主巡检

让 Mimi 能后台持续检查，但只在真的值得打扰时推送：

- [x] 非 command Event 获得 `finish_mimi_silently`
- [x] command Event 结构性禁止静默，直接请求始终回复
- [x] 静默成功保留 Event/Run/answer/usage/reason，仅省略 Outbox
- [x] 不增加通知评分、阈值 DSL、表、migration 或副作用 ledger
- [x] 工具/策略/重试/投递测试、文档和完整 CI
