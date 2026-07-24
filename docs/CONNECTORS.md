# MimiAgent Connector Protocol

Connector 把大象、QQ、微信、邮件、新闻、天气、日历或其他事件源适配为 MimiAgent 的统一事件协议。它运行在独立子进程中，通过 stdin/stdout 交换一行一个 JSON 的 NDJSON；渠道 SDK、崩溃和凭证不会进入 MimiAgent Runtime。

## 配置

首次运行 `mimi` 会自动从发布包内的 `mimi.connectors.example.json` 创建 `~/.mimi-agent/daemon/connectors.json`，将 Node 和 Connector 脚本转换为当前安装位置的绝对路径。macOS 默认只启用不启动 GUI App 的 System Connector；Calendar、Mail、Messages、Contacts、Notes、Shortcuts、Desktop、Browser、Screen 和 Voice 均需用户显式启用。旧版自动启用的 canonical 本机 Connector 会一次性迁移到这个无界面默认，之后用户的显式启停选择继续保留。Calendar/Reminders 启用后通过 EventKit 静默访问系统数据；Mail 的主动轮询只在 Mail 已经运行时读取，绝不为了后台轮询重新打开 App。需要 Token 或额外数据源配置的大象、QQ、OpenClaw 微信、Radar 和 File Radar 同样默认关闭。QQ/微信不会默认启用 AppleScript、截图、OCR、键盘或点击式 Connector；正式 IM 接入必须使用后台 API/协议桥。后续初始化会补齐缺失的 enabled 默认本机 Connector，但不会加入默认关闭的外部通道；同 ID、仍指向 canonical 内置脚本的 Connector 会补充发布包新增的 action。已有命令、参数、环境白名单、来源和 owner action 描述保持不变。写入是原子的，无新增项时不改文件。也可用 `MIMI_CONNECTORS_CONFIG` 指向其他绝对配置文件。

`~/.mimi-agent/daemon` 是唯一默认常驻状态目录。三个配置示例文件均使用统一的 MimiAgent 命名。

`mimi daemon doctor` 复用与 Host 相同的 schema，只读检查配置、启用项、脚本路径、必要系统命令、Provider Key 是否存在以及本机 Socket/launchd 状态。它不启动 Connector、不读取邮件、消息、联系人、屏幕等私人数据，也不主动触发 macOS 权限提示。

已有渠道可由 Agent 调用 `set_mimi_connector_enabled` 原子启停：它只修改目标 Connector 的 `enabled`，不读取或改写凭证、命令、环境白名单和 action 目录。修改其他配置后运行 `mimi daemon connectors reload` 或让 Agent 调用 `reload_mimi_connectors`，可在不重启 Daemon 的情况下换代 Connector 子进程。`inspect_mimi_capabilities` 返回配置文件绝对路径和有界能力目录。Host 会完整解析新配置；JSON/schema 无效时旧集合保持在线。启停和重载都仅在没有进行中的 delivery/action 时切换，避免中断结果不确定的真实事务；繁忙时配置不变并快速失败。切换会短暂停止旧渠道再启动新渠道，不运行双份 Connector，也不自动监视文件变化。

```json
{
  "connectors": {
    "my-im": {
      "enabled": true,
      "command": "/absolute/path/to/my-im-bridge",
      "args": ["--stdio"],
      "cwd": "/absolute/working/directory",
      "envAllowlist": ["MY_IM_TOKEN"],
      "source": "my-im",
      "trust": "external",
      "profileId": "owner",
      "restart": true,
      "healthEvents": true,
      "healthStabilityMs": 5000,
      "deliveryTimeoutMs": 30000,
      "actionTimeoutMs": 30000,
      "syncTemplateActions": true,
      "actions": {
        "send_message": { "description": "主动发送一条消息" }
      }
    }
  }
}
```

Daemon 只向子进程传递 `PATH`、`HOME`、locale、临时目录和 `envAllowlist` 明确列出的变量，不会把整份模型密钥环境泄漏给 Connector。`actions` 是能力发现目录：未声明的 action 不会发给子进程。`syncTemplateActions` 默认开启，只负责随软件升级补齐内置 Connector 新增的 action，不是权限等级或审批模型。若 owner 需要主动移除内置 action 或完全维护自定义目录，应先将它设为 `false`。`trust` 是 Host 认定的事件 provenance，不是来源自称即可获得的授权；除 `owner/system` 外的值都进入同一最小外部事件策略。

`healthEvents` 默认开启。Connector 异常退出或启动失败时，Host 会把一条 `system:connector-health` 告警先写入 Inbox，再沿用 Attention、Agent 与 Outbox 处理；正常 daemon 停止和 disabled Connector 不产生告警。自动重启期间的连续失败属于同一个故障窗口，不重复告警；子进程连续存活 `healthStabilityMs`（默认 5 秒）后才生成一次恢复事件。MimiAgent 会先核对实时能力：自动重启中的故障只建立一个恢复 Watch，未启用自动重启的瞬时故障最多执行一次启停恢复，配置或命令缺失则给出精确修复信息；已恢复且没有遗留影响时静默结束。中断期间结果不确定的 delivery/action 永不自动重放。诊断 Event 只保存有界错误类别；完整子进程错误仍留在本机 daemon stderr。

Connector 明确返回“尚未执行”的普通失败时，Outbox 按指数退避最多尝试 8 次。发送后置校验失败、ACK 丢失、进程中断或超时属于结果不确定，第一次失败就直接进入 dead letter，绝不自动重放；Manager 同时终止该 Connector，阻止本地动作继续晚到。Outbox 的默认 sending 租约为 180 秒，长于内置 Connector 允许的最长 120 秒投递超时；若 Daemon 崩溃使租约真的过期，恢复时同样按结果不确定直接 dead-letter，而不是把 `sending` 静默改回 `pending`。dead letter 会原子创建一个不含原始消息正文和 target 的本机 system fallback，提醒 owner 使用 `mimi daemon outbox` 检查；如果本机 system 通知也失败，不再递归创建告警。owner 可执行 `mimi daemon retry outbox <id>` 原 ID 重投，或执行 `mimi daemon archive outbox <id>` 标记已处置；显式重投仍是 at-least-once，远端已接收但 ACK 丢失时可能重复。

## Connector → MimiAgent

```json
{"type":"event","externalId":"message-123","kind":"command","payload":{"text":"帮我总结"},"occurredAt":"2026-07-14T10:00:00Z","priority":80,"actor":{"id":"user-1","displayName":"Alice"},"conversation":{"id":"group-1"},"replyTarget":"group-1"}
```

- `externalId`：来源内稳定且唯一，用于去重，必填。
- `kind`：`command | alert | ambient | webhook`；缺省为 `webhook`。
- `payload`：原始事件正文或结构化数据，必填。
- `occurredAt`：来源发生时间；无效或缺省时使用接收时间。
- `priority`：0～100，默认 50。
- `actor` / `conversation`：用于 provenance 与稳定 Session 路由。
- `replyTarget`：存在时，Agent 结果通过同一 Connector 的 Outbox 回传。

stdout 必须专用于协议消息；诊断日志写 stderr。单条未换行消息最大 1MB。

需要以 cursor 消费上游事件的 Connector 必须先通过 status 声明
`"eventAcknowledgement":true`。Daemon 只有在 Event 已写入持久 Inbox（重复
`source + externalId` 也视为已持久化）后，才向 stdin 返回：

```json
{"type":"event_ack","externalId":"message-123","ok":true,"eventId":"host-event-id"}
```

写入失败返回 `ok:false` 和有界 `error`。Connector 必须等整批 Event 全部收到
成功 ACK 后才推进上游 cursor；ACK 丢失或失败时保留原 cursor 并重读，由 Host
去重。未声明该能力的旧 Connector 不会收到新消息类型。

## OpenClaw 微信传输桥

已登录 `@tencent-weixin/openclaw-weixin` 的机器可以复用该通道，不需要在 MimiAgent 中复制微信 Token：

1. 用 `openclaw plugins install --link <MimiAgent>/examples/openclaw/mimiagent-bridge` 安装薄桥插件。
2. 在该插件配置中设置非空 `ownerSenders`，每项必须是精确 `sender` 或更严格的 `account:sender`，例如 `{"ownerSenders":["wxid-owner","bot-account:wxid-owner"]}`，然后重启 OpenClaw Gateway。
3. 启用 `openclaw-weixin` Connector 后重载 MimiAgent Connectors。

OpenClaw 插件只在 `inbound_claim` 截获微信入站并写入本用户的 MimiAgent Unix Socket；成功后返回 `handled`，所以 OpenClaw 自己的 Agent 不再处理同一条消息。`before_dispatch` 是出站 hook，不能用于接收微信消息。桥兼容 hook 把 channel/account/sender 放在 event 或 context、以及正文为字符串或 text parts 的形态；部分 OpenClaw 版本不传 `context.accountId` 时，可在插件配置写精确 `accountId` 作为只读路由兜底。桥会从 Socket 同目录读取 bootstrap 自动维护的 `0600` control bearer 并随每个 RPC 发送，不需要新增插件凭证，也不会把 token 写入日志；旧 daemon 尚无 token 时仍可完成协议升级，新 daemon 的 token 缺失、权限错误或不匹配则 fail closed。`dmPolicy: pairing` 只限制谁能到达插件，不等于 MimiAgent owner 身份。桥会精确比较 `ownerSenders`：命中者才先读取同一 Owner Session 并以 owner provenance 提交；未配置或未命中者固定作为 `external`，不请求、不携带 owner Session，只能按普通外部 Event 或另行配置的 source policy 处理。来源始终保留为 `openclaw-weixin`。MimiAgent 的回复由 `openclaw-weixin-connector.mjs` 调用 OpenClaw 官方发送命令回到同一账号和联系人。若 MimiAgent 不在线，插件会明确失败并阻止第二 Agent 接管。Connector readiness 还会用 `MIMI_DAEMON_SOCKET` 和同目录 control token 执行认证 `status` RPC；只有腾讯 channel、bridge plugin 和真实 MimiAgent socket 三者同时可用才报告双向 ready。OpenClaw 插件显式配置其他 `socketPath` 时，这个环境变量必须指向同一路径。

插件目录、package name 和 ID 统一为 `mimiagent-bridge`，显示名为 **MimiAgent Bridge**。Socket 优先级是插件 `socketPath` → `MIMI_DAEMON_SOCKET` → `MIMI_DAEMON_DATA_DIR` 下的 socket → 默认 `~/.mimi-agent/daemon/mimi.sock`。

这条通道是腾讯 iLink Bot，不是个人微信桌面账号的完整收件箱：只能回复已经与机器人建立上下文的配对用户，不能按个人微信通讯录昵称主动联系任意好友，也没有联系人目录或任意历史消息查询 API。MimiAgent 只保留 bridge 接通后自己持久化的 Bot Event；`local_history` 可按精确 account/to 路由读取本机 OpenClaw 会话文件中仍留存的有界微信入站记录（包括 `.deleted.*` 归档），但它不是腾讯上游历史，已被 sync cursor 消费且本机未落盘的消息仍不可恢复。读取过程不打开或操控 WeChat.app。仓库中的 `wechat-applescript-connector.mjs` 仅为旧安装兼容保留，不在默认目录和支持路径中；后台通道失败时不得自动降级为启动 WeChat.app、截图/OCR 或模拟输入。

Connector 应在渠道状态变化时输出就绪度；这和子进程是否存活是两件事：

```json
{"type":"status","inbound":"ready","outbound":"ready","deliveryConfirmed":true,"eventAcknowledgement":true,"freshForMs":90000}
```

`inbound` / `outbound` 只能是 `ready | unavailable | unknown`。`deliveryConfirmed:false` 表示 UI 自动化等执行面只能确认动作已尝试，不能确认远端实际收到。`eventAcknowledgement:true` 表示 Connector 会等待 Inbox 持久化 ACK；未声明时 Host 保持旧协议兼容。轮询 Connector 可声明 1 秒到 7 天的 `freshForMs`，并在每次成功轮询后重发同一 status 作为 heartbeat；Host 以接收时间计算 `reportedAt` / `freshUntil`，过期后即使进程仍在线也标记 `stale`，从 readiness 计数中移除并进入统一 health 风险。不能持续报告 heartbeat 的 Connector 应省略该字段，不能伪造 freshness。未上报 status 的旧 Connector 保持 `unknown`；进程离线时两项统一为 `unavailable`。因此 `online` 只用于诊断子进程，不能再被解释为渠道已经可收发。

## 通用本机 Webhook

没有专用 stdio Bridge 时，可开启只绑定 `127.0.0.1` 的认证入口：

```dotenv
MIMI_WEBHOOK_PORT=7788
MIMI_WEBHOOK_TOKEN=a-random-secret-at-least-24-characters
```

```bash
curl -X POST http://127.0.0.1:7788/v1/events \
  -H "Authorization: Bearer $MIMI_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"externalId":"weather-123","channel":"weather","kind":"alert","payload":{"text":"暴雨预警"},"priority":90}'
```

Webhook 来信固定为 `external`，请求体不能指定 trust；默认通过系统通知返回处理结果。`actor` 和 `conversation` 可保留人物与会话 provenance。官方回调 relay 还可声明严格的 Connector 回路：

```json
{
  "externalId": "daxiang-message-42",
  "channel": "daxiang",
  "kind": "command",
  "payload": { "text": "请处理这项工作" },
  "priority": 85,
  "actor": { "id": "user-42", "displayName": "Alice" },
  "conversation": { "id": "group-7", "threadId": "thread-9" },
  "reply": { "connector": "daxiang", "target": "group:group-7" }
}
```

`reply.connector` 只能是 1～100 字符的 Connector ID，`target` 最多 500 字符；Host 转换为 `connector:<id>` route。`reply` 存在时优先于 `notify`；没有 reply 时，`notify:true` 走 system，`notify:false` 明确不投递 Agent 结果，也不会继承 owner 默认 route。入口限制单体 1MB、每分钟 60 个已认证请求。它不会监听公网地址；需要接入云端或官方服务端回调时，应由已完成平台鉴权的窄 relay 转发到本机，不要直接暴露端口。

## MimiAgent → Connector

当 Outbox 需要回传时，Daemon 向 stdin 写入：

```json
{"type":"deliver","id":"outbox-uuid","target":"group-1","payload":{"text":"处理结果"},"deadlineAt":1784176000000}
```

Connector 完成远端发送后必须确认：

```json
{"type":"delivery_ack","id":"outbox-uuid","ok":true}
```

确认未执行、可以安全重试时返回 `{"type":"delivery_ack","id":"...","ok":false,"error":"rate limited"}`。动作可能已经发生但无法确认时必须返回 `{"type":"delivery_ack","id":"...","ok":false,"uncertain":true,"error":"send result is uncertain"}`；Daemon 会直接 dead-letter 而不自动重试。Connector 应使用 Outbox `id` 作为远端幂等键（渠道支持时）。

## 主动事务 Action Bridge

Agent 需要主动执行 Connector 事务时，调用通用 `connector_action`。Daemon 先检查配置中的 `actions` 目录，再向子进程发送：

每个 Daemon Agent Run 还会获得只读 `inspect_mimi_capabilities`，动态返回当前 Connector 的 enabled/online、inbound/outbound readiness 和 action 目录。已知 ID 时用 `connector` 精确过滤，只知道“微信”等渠道词时用 `query` 匹配 ID、source、action 或描述；过滤后的能力输出最多包含 50 个 Connector、全局 100 个 action、单项 300 字符描述，并用 totals 与 `truncated` 明示是否截断。`connector_action` 使用固定短描述并要求先调用这份小范围能力检查，避免整份动态目录在每轮模型请求中重复占用上下文；状态仍可能随后变化，因此 Manager 在真正发送前再次校验。

```json
{"type":"action","id":"action-uuid","action":"send_message","target":"group:123","payload":{"text":"会议延后 10 分钟"},"deadlineAt":1784176000000}
```

Connector 执行完成后返回：

```json
{"type":"action_result","id":"action-uuid","ok":true,"result":{"sent":true}}
```

失败返回 `ok:false` 和简短 `error`。`target` 是主要事务对象，`payload` 是 Connector 自己定义的 JSON。`deadlineAt` 是 Daemon 给出的 Unix 毫秒绝对截止时间；新 Connector 应在截止时间前停止底层进程或请求并返回失败，旧 Connector 可忽略该兼容字段。外层 `deliveryTimeoutMs` / `actionTimeoutMs` 到达后，Manager 会终止并重启整个 Connector 子进程，防止已经向调用方报超时的本地动作继续晚到；子进程退出或 action 超时时仍把结果视为不确定并拒绝自动重放。Connector 应在上游支持时使用 action `id` 做幂等键。

运行 `mimi daemon connectors` 可查看每个 Connector 的当前进程状态、双向就绪度和 action 目录，输出不包含凭证。恢复通知仍需要通过上述稳定窗口。

### 通用双向 HTTP Connector

`examples/connectors/http-action-connector.mjs` 把上述 `deliver` 和已声明的任意 `action` 原样 POST 到 `MIMI_HTTP_ACTION_URL`，并可从 `MIMI_HTTP_EVENT_URL` 按游标拉取标准 Connector Event，适合连接微信网关、内部服务、家庭自动化或 SaaS adapter，而无需再写本地 Connector。URL 固定在环境配置中，不接受模型输入；公网地址必须使用 HTTPS，本机 relay 可使用 loopback HTTP。可选 `MIMI_HTTP_ACTION_TOKEN` 以 Bearer Token 双向鉴权，响应大小、超时和轮询周期分别由 `MIMI_HTTP_ACTION_MAX_RESPONSE_BYTES`、`MIMI_HTTP_ACTION_TIMEOUT_MS`、`MIMI_HTTP_EVENT_POLL_INTERVAL_MS` 限制。

POST 请求体包含 `version:1`、`type`、稳定 `id`、`target`、`payload`，Action 额外包含 `action`；同一 `id` 同时放入 `Idempotency-Key`，消息类型放入 `X-Mimi-Message-Type`。Relay 以 2xx 表示接收，Action 可返回 `{"ok":true,"result":...}`；非 2xx 或 `{"ok":false,"error":"..."}` 会沿既有失败语义返回。

事件端点接收 `limit=100` 和可选 `cursor`，返回 `{"events":[...],"cursor":"next"}`；每个 Event 使用本章 Connector → MimiAgent 的字段。Cursor 是非破坏性读取位置：Relay 必须让旧 cursor 和无 cursor 请求在足够长的保留窗口内重放事件，不能因一次 GET 就删除消息。Connector 等待该批 Event 的持久化 ACK 后才在进程内推进 cursor；ACK 失败、丢失或进程异常都会保留旧 cursor 并主动重读，由中心 `source + externalId` 去重。通用 HTTP Connector 把三倍轮询周期（最少 5 秒、最多 7 天）声明为 freshness 窗口，每次成功轮询刷新 heartbeat；轮询卡死或持续失败会在窗口到期后形成 `connector_stale` 风险。轮询首次失败和恢复各产生一个有界健康 Event，失败期间指数退避但不影响出站能力。启用模板中的 `http-action` 后，可把 `actions` 目录替换成远端真正支持的明确事务名称；不配置事件 URL 时仍可结合 localhost Webhook 的 `reply.connector` 形成闭环。

这只是一个通用适配协议，不代表 MimiAgent 已经登录或直连微信。只有外部微信网关同时提供真实事件端点、事务端点并完成账号侧配置后，才能启用并视为在线；缺少这些条件时应保持 Connector disabled，不能把模板存在误报为“微信已打通”。

## 大象机器人 Bridge

仓库提供 `examples/connectors/daxiang-connector.mjs`，使用大象开放平台机器人服务端 API，把 Outbox 文本发送到单聊或群聊：

- `target=single:<mis或userId>`：机器人单聊
- `target=group:<chatId>`：机器人群聊
- 必填环境：`DX_APP_KEY`、`DX_APP_SECRET`、`DX_ROBOT_ID`
- `DX_ENV=test|prod` 选择环境；st 与 prod 消息数据共用，测试时避免消息轰炸
- `health_check` 只获取官方 access token，不发送消息；成功表示服务端出站认证可用，并会明确提示入站仍依赖已发布的事件订阅 Relay

在首次初始化生成的 `~/.mimi-agent/daemon/connectors.json` 中配置脚本绝对路径并启用，随后执行 `mimi daemon connectors reload`。发布包模板 `mimi.connectors.example.json` 只用于首次物化，不是运行时配置。该 Connector 同时声明 `send_message`，所以 MimiAgent 既可回复原会话，也可主动发送。开放平台后台还需要启用机器人、申请相应能力并发布应用；`30002 auth fail` 或 `ability permission denied` 优先检查权限、token 环境和是否发布。

大象的事件订阅走主干环境 Thrift/OCTO 回调，不是本机普通 HTTP Webhook。业务回调必须按官方规则注册接口、配置 `com.sankuai.dxenterprise.open.gateway` 白名单并发布应用；平台超时约 3 秒且会重试，因此回调应先快速返回非 null 的正确类型，再异步转发，并用大象消息 ID 作为 `externalId`。转发时带上上述 `actor`、`conversation` 和 `reply:{connector:"daxiang",target:"single:<uid>|group:<chatId>"}`，中心 Store 会吸收重复回调，Agent 结果再经现有大象 Outbox 回原会话。当前示例不会把本机端口暴露到公网，也不会臆造官方 Thrift IDL、签名或 OCTO 部署。动态卡片、侧边栏和网页应用是不同能力路线，不应塞进这个文本机器人 Bridge。

`daxiang-applescript-connector.mjs` 可作为本机桌面 UI 出站兜底：它不需要 API Key，但只能尽力执行按键，不能接收入站消息，也不能确认服务端实际送达，不能视为完整大象接管。

## QQ (OneBot 11) Bridge

仓库提供 `examples/connectors/qq-napcat-connector.mjs`，通过 loopback HTTP 和鉴权反向 WebSocket 接入 OneBot 11 实现。它既可连接宿主在用户可见 QQ 进程内的 LLOneBot/LLBot，也兼容独立 NapCat 进程，支持私聊和群聊消息的接收、回复、目录和有界历史查询。这些都不是腾讯官方个人号 API，存在账号风控、客户端版本兼容和第三方供应链风险；不能接受时应改用腾讯官方 QQ Bot，但其能力范围不是个人 QQ 收件箱。

**工作原理：** Connector 启动 WebSocket 服务，OneBot 实现作为客户端推送事件。收到消息后转为 MimiAgent 协议输出到 stdout；MimiAgent 的 deliver 指令通过 OneBot HTTP API 发回 QQ。

### 桌面 QQ 共存模式（同一账号）

当 OneBot 插件运行在当前桌面 QQ 进程内时，MimiAgent 复用这一个已登录会话，不再启动第二个模拟客户端。这是“桌面 QQ 正常使用 + MimiAgent 收发同一账号消息”的接入模式。

1. 安装与当前 QQ 构建兼容的 LLOneBot/LLBot，并在它的设置中启用 HTTP Server `127.0.0.1:3000`。
2. 运行 `./scripts/setup-qq-desktop-connector.sh`。脚本生成 owner-only token，但在 OneBot HTTP 真正就绪前保持 Connector disabled。
3. 把 `~/.mimi-agent/.env` 中 `QQ_ONEBOT_ACCESS_TOKEN` 的值设为 OneBot HTTP token；把 `QQ_ONEBOT_WS_ACCESS_TOKEN` 设为反向 WebSocket token。两者可相同，不得留空。
4. 在 OneBot 中新增反向 WebSocket Client：`ws://127.0.0.1:3080/`，配置同一 WS token，然后再运行一次 `./scripts/setup-qq-desktop-connector.sh`。
5. 用 `mimi daemon connectors` 确认 `qq` 的 inbound/outbound 均 ready。

脚本不下载、注入或修补 QQ.app，也不代替 OneBot 项目自身的版本兼容检查。LiteLoaderQQNT 上游已于 2026 年归档，而 LLOneBot/LLBot 仍在演进；每次 QQ 或插件升级后都应重新验证登录、收件和发件，不要使用来路不明的注入二进制。

`QQ_ONEBOT_HTTP_URL`、`QQ_ONEBOT_WS_PORT`、`QQ_ONEBOT_ACCESS_TOKEN`、`QQ_ONEBOT_WS_ACCESS_TOKEN` 和 `QQ_ONEBOT_STATUS_POLL_MS` 是该模式的首选环境变量。后续的 `NC_*` 变量仅为 NapCat 安装和旧配置保留；两组同时存在时 `QQ_ONEBOT_*` 优先。`send_message`、`get_status`、`get_friend_list` 和 `get_group_list` 属于通用 OneBot 路径；`get_recent_contact` 和历史 action 是实现扩展，不支持时会显式返回 action 错误，不会降级到 UI 自动化。

### 独立 NapCat 模式

**前置条件：**
- 必须是 NapCat 当前支持的 NTQQ 构建。`scripts/install-napcat-macos.mjs` 会在写入前读取 QQ `buildVersion` 并对照 Release 最低要求；不兼容时 fail closed，不自动下载或替换系统 QQ。
- NapCat 仍依赖一个已登录的 NTQQ 进程，但日常消息收发只经过 OneBot HTTP/WebSocket，不读取窗口、不截图/OCR、不模拟键盘或点击。
- 腾讯没有个人 QQ 完整收件箱的官方公共 API。腾讯官方 QQ Bot 可以完全服务端运行，但不能代替个人号好友目录、历史和任意私聊；需要这些能力时 NapCat 属于有账号风控的非官方选择。

macOS 推荐按以下顺序安装：

```bash
./scripts/setup-qq-connector.sh
./scripts/install-napcat-macos.mjs status
./scripts/install-napcat-macos.mjs install
./scripts/setup-qq-connector.sh
```

默认目标仍是 `/Applications/QQ.app`。更安全的推荐做法是先从腾讯官方渠道取得与 NapCat 兼容的 QQ，核对发布哈希、Apple 公证/Developer ID 和腾讯 Team ID 后复制到 owner-only 的 MimiAgent 私有目录，再显式选择该副本：

```bash
NAPCAT_QQ_APP="$HOME/.mimi-agent/runtime/qq/QQ.app" \
  ./scripts/install-napcat-macos.mjs install --no-start
```

安装成功后，选择的绝对路径会写入 owner-only `~/.mimi-agent/napcat-installer.json`，后续 `status/start/stop/restore` 无需重复传环境变量。仓库安装器本身不会下载或复制 QQ，因此私有副本在修改前的来源校验仍由部署者负责。

安装器只从 NapCat 官方 GitHub Release 获取 `NapCat.Shell.zip`，要求 Release 提供的 SHA-256 digest 匹配后才解压。它先验证目标 QQ 的完整代码签名、Apple 执行策略、腾讯 `TeamIdentifier=FN2V63AD2J` 和已知 Electron 入口，再创建精确备份并原子替换 `package.json`；由于这一步必然使腾讯 bundle 的资源封印失效，安装器随后只对已修改的目标副本执行 macOS ad-hoc 深度签名并立即复验，系统 QQ 不受影响。修改系统应用时可能需要终端中的管理员授权，私有 owner 可写副本不需要。NapCat Shell、loader、OneBot 配置、缓存和启动器全部位于 owner-only `~/.mimi-agent/runtime/qq/`，不依赖 QQ App Sandbox 容器中的脚本或配置文件；旧容器 loader 入口会在下一次 `install` 时单向迁移。安装器不通过 AppleScript、Terminal UI 或 LaunchServices 启动应用。用户级 LaunchAgent 直接运行带伪终端的受保护后台入口，并在导入 NapCat 前要求 Electron 支持并设置 `app.setActivationPolicy('prohibited')`；按 Electron 的平台契约，这个模式不出现在 Dock、不能创建窗口或被激活，不支持时启动失败关闭。LaunchAgent 丢弃原始 stdout/stderr，健康检查只读取结构化 OneBot 状态，避免 NapCat 启动期把历史消息正文写入日志。若系统 QQ 或选定副本中的普通 QQ 正在运行，`install/start` 不会替用户退出或激活它，而是明确停止并要求用户自行退出一次；之后执行 `start` 即可。目标 QQ 自动升级、入口重置或 NapCat Shell 缺失时，启动守卫会退出，绝不把普通 QQ 窗口误启动出来。

```bash
./scripts/install-napcat-macos.mjs start        # 后台启动
./scripts/install-napcat-macos.mjs stop         # 只停止 MimiAgent 管理的进程
./scripts/install-napcat-macos.mjs configure    # 原子更新 OneBot，并清理旧 Mimi 重复项
./scripts/install-napcat-macos.mjs status --json
./scripts/install-napcat-macos.mjs restore      # 恢复原始 QQ 入口，保留数据和备份
```

安装器会增量维护 NapCat 的 HTTP Server 和反向 WebSocket Client，并把旧 `mimi-http`/`mimi-reverse-ws` 精确迁移为唯一的 `mimiagent-*` 条目，避免同一端口重复监听；其他用户配置保持不变。`configure` 还会关闭 NapCat 文件/控制台消息日志并记录唯一历史账号。只有当前 NapCat Shell 明确内置精确的 `<QQ版本>-<build>-<arch>` 支持项时才生成快速登录 enable marker；不支持的较新 QQ 仍保留账号记录，但启动时不传 `-q`，避免卡死在不兼容的快速登录。每次 `start` 都会在启动新进程前删除旧的 `cache/qrcode.png`；首次登录只能使用当前后台进程重新生成的二维码，不能复用此前文件或截图。HTTP 固定 `127.0.0.1`，反向 WS 固定 `ws://127.0.0.1:<NC_WS_PORT>/`，token 与 MimiAgent owner-only 环境文件一致。无需打开 NapCat WebUI。

**环境变量：**
- `NAPCAT_QQ_APP`：要安装/管理的 QQ.app 绝对路径；首次成功安装后持久化，默认 `/Applications/QQ.app`
- `NAPCAT_INSTALLER_STATE_FILE`：可选的安装器路径状态文件，默认 `~/.mimi-agent/napcat-installer.json`
- `NC_HTTP_URL`：NapCat HTTP API 地址，如 `http://127.0.0.1:3000`（必填）
- `NC_WS_PORT`：Connector 监听的 WebSocket 端口，默认 `3080`
- `NC_ACCESS_TOKEN`：NapCat HTTP Server token；未配置独立 WS token 时也用于反向 WebSocket
- `NC_WS_ACCESS_TOKEN`：可选的 NapCat WebSocket Client token；有效 WS token 为 `NC_WS_ACCESS_TOKEN || NC_ACCESS_TOKEN`，两者至少配置一个，否则 Connector 拒绝启动
- `NC_STATUS_POLL_MS`：后台状态轮询周期，默认 30 秒

反向 WebSocket 握手使用 OneBot 标准的 `Authorization: Bearer <token>`。为兼容旧集成也接受 URL 查询参数 `access_token`，但不建议这样配置，避免 token 进入 URL 或日志；header 与 query 同时出现且不同会拒绝。未认证连接和第二个并发上游会在进入事件管道前拒绝，且不改变当前健康状态；超过 1 MiB 的消息会关闭当前已认证上游并把入站标为 `unavailable`，等待 NapCat 重连。

**消息路由：**
- `target=private:<QQ号>`：私聊消息
- `target=group:<QQ群号>`：群聊消息

QQ 号、群号和消息 ID 全程作为字符串处理，避免超出 JavaScript 安全整数后失真。`recent_conversations`、`list_friends`、`list_groups`、`friend_history`、`group_history` 分别调用 NapCat 的近期会话、好友/群目录和历史接口；目录最多返回 500 项，单次历史最多 100 条，消息正文和 action 结果均有大小上限。

`health_check` 会调用 NapCat 的 `get_status`，同时报告是否已有反向 WebSocket 客户端接入。HTTP API 可用只证明能够出站；只有 NapCat 登录状态正常且反向 WebSocket 已连接，才形成可收可发的双向闭环。`./scripts/setup-qq-connector.sh` 增量写入实际配置、生成 owner-only token 并关闭旧 QQ/微信 UI Connector；NapCat 未响应时脚本保持 `qq` disabled，避免误报在线。NapCat 首次 ready 后再运行一次该脚本即可启用并热重载 QQ Connector。

仓库中的 `qq-applescript-connector.mjs` 仅为旧安装兼容保留，不在默认目录和支持路径中；NapCat 不在线时不得自动降级为启动 QQ.app、截图/OCR 或模拟输入。

**配置示例（mimi.connectors.example.json）：**
```json
"qq": {
  "enabled": true,
  "command": "node",
  "args": ["/absolute/path/to/MimiAgent/examples/connectors/qq-napcat-connector.mjs"],
  "envAllowlist": ["QQ_ONEBOT_HTTP_URL", "QQ_ONEBOT_WS_PORT", "QQ_ONEBOT_ACCESS_TOKEN", "QQ_ONEBOT_WS_ACCESS_TOKEN", "QQ_ONEBOT_STATUS_POLL_MS"],
  "source": "qq",
  "trust": "external",
  "profileId": "owner",
  "restart": true,
  "deliveryTimeoutMs": 30000,
  "actionTimeoutMs": 30000,
  "actions": {
    "send_message": { "description": "向 QQ 私聊或群聊主动发送文本消息" },
    "health_check": { "description": "检查 OneBot HTTP 状态与反向 WebSocket 入站连接" },
    "recent_conversations": { "description": "读取有界近期 QQ 会话" },
    "list_friends": { "description": "列出有界 QQ 好友目录" },
    "list_groups": { "description": "列出有界 QQ 群目录" },
    "friend_history": { "description": "读取指定好友的有界历史" },
    "group_history": { "description": "读取指定群的有界历史" }
  }
}
```

## 信息雷达（RSS / Atom / 天气）

`examples/connectors/radar-connector.mjs` 是一个零额外依赖的 HTTP 轮询 Connector。它从 `MIMI_RADAR_CONFIG` 指向的 JSON 读取多个 source，一个子进程即可同时处理 RSS 2.x、Atom 和 Open-Meteo 小时预报。起步配置见 `mimi.radar.example.json`。

```bash
mkdir -p ~/.mimi-agent/daemon
cp mimi.radar.example.json ~/.mimi-agent/daemon/radar.json
```

在 `~/.mimi-agent/.env` 中设置：

```dotenv
MIMI_RADAR_CONFIG=/absolute/path/to/.mimi-agent/daemon/radar.json
```

再启用 `~/.mimi-agent/daemon/connectors.json` 中的 `radar` Connector 并执行 `mimi daemon connectors reload`。配置层级的 `pollIntervalMs`、`requestTimeoutMs` 和 `maxResponseBytes` 控制轮询与资源上限；`RADAR_POLL_INTERVAL_MS` 可临时覆盖轮询间隔，设为 `0` 关闭自动轮询但保留主动 action。

Feed source 字段：

- `id`、`type: "feed"`、`url` 必填。
- `maxItems` 限制单次处理条数，默认 20；`priority` 默认 40。
- `includeKeywords` / `excludeKeywords` 对标题和摘要执行不区分大小写的字面过滤。
- 条目输出为 `ambient` Event，guid/id/link 优先作为稳定身份，通常由 Attention 进入早晚简报。

Open-Meteo source 字段：

- `id`、`type: "open-meteo"`、`latitude`、`longitude` 必填，`timezone` 默认 `auto`。
- `horizonHours` 默认 24；Connector 只请求温度、降水概率、WMO weather code 和阵风四个字段。
- `thresholds` 支持 `precipitationProbability`、`windGustKmh`、`temperatureHighC`、`temperatureLowC` 和 `weatherCodes`。
- 命中阈值的时段输出为 `alert` Event，payload 保留原始数值和 `reasons`。这是个人阈值检测，不是政府气象预警。

Agent 可以使用三个 action：

- `refresh`：`target=all|<source-id>`，立即获取并输出新事件。
- `weather_snapshot`：`target=all|<weather-source-id>`，返回小时快照和风险数，不额外输出 Event。
- `sources`：`target=all|<source-id>`，返回已配置目录。

每次 HTTP 请求都有超时和响应大小上限。RSS/Atom 只解析事件所需的有界字段，不执行 XML 外部实体。Open-Meteo 接口使用和限制以其[Forecast API 官方文档](https://open-meteo.com/en/docs) 为准。

## File Activity Radar

`examples/connectors/file-radar-connector.mjs` 是零依赖、跨平台的文件元数据轮询 Connector。它适合持续观察 Downloads、Desktop、共享落盘目录或其他自动化 inbox；起步配置见 `mimi.files.example.json`。配置路径使用 `MIMI_FILE_RADAR_CONFIG`。

每个 watch 包含：

- `id`、`path`：稳定标识和目录。`~` 展开为用户目录，相对路径相对配置文件解析。
- `recursive`、`maxDepth`：是否递归及最大深度；默认不递归，深度上限 8。
- `ignoreHidden`：默认忽略以 `.` 开头的路径项。
- `extensions`：大小写不敏感的后缀 allowlist，空数组表示全部文件；不引入通用 glob DSL。
- `kind`、`priority`：产生 `ambient`、`alert` 或 `command` Event 及其 Attention 优先级。

配置顶层的 `pollIntervalMs`、`lookbackMinutes`、`maxEventsPerPoll` 和 `maxScanEntries` 分别限制轮询间隔、启动回看、单轮事件和单 watch 访问条目。`FILE_RADAR_POLL_INTERVAL_MS=0` 可关闭自动轮询但保留 actions。可用 actions：

- `scan_now`：`target=<watch-id>|all`，立即扫描；同一路径的 size/mtime 连续两次扫描一致才产生 Event，结果返回 `emitted` 和 `pendingStability`。
- `recent_files`：`target=<watch-id>|all`，payload 支持 `limit`（上限 200）和 `hours`（上限 720），只返回元数据。
- `watches`：列出全部或指定 watch 的生效配置。

Event 只包含绝对路径、相对路径、文件名、扩展名、大小、创建/修改时间和诚实的 `created_or_modified` 活动类型，不读取文件正文。Connector 不跟随文件或目录符号链接；文件必须以相同 size/mtime 连续出现两次才发出事件，避免 MimiAgent 读取尚在下载或复制的半成品。初次启动会在第一轮建立候选基线，随后由中心 Store 根据 `watchId + path + mtime + size` 跨重启去重。固定 `file-radar` 来源还会获得文件收件事务剧本：复核文件未变化后直接读取、提取、转换、重命名、移动、归档或关联现有事务，产物验证前不移走源文件。真正操作继续使用 Runtime 已有文件工具。

## macOS 系统状态 Bridge

`examples/connectors/macos-system-connector.mjs` 使用 Node 内置 `os`、`fs.statfs` 和 macOS 自带 `/usr/bin/pmset` 提供本机健康状态，不需要额外依赖或系统隐私权限。它不读取进程列表、Wi-Fi SSID、文件正文或浏览历史。

Actions：

- `system_snapshot`：`target=system|all`，返回电池、内存、1/5/15 分钟负载、逻辑 CPU 数、非 loopback 网络接口和默认文件系统容量。
- `battery_status`：`target=battery|all`，返回供电来源、电量、充电状态和可用时的预计剩余分钟数；无电池的 Mac 返回 `available:false`。
- `network_status`：`target=network|all`，返回当前在线状态和最多 64 个非 loopback IP 地址，不读取 SSID。
- `storage_status`：`target=storage|default|<absolute-path>`，读取对应文件系统的总量、可用量和比例，不遍历目录。

默认每 60 秒采样一次。首轮低/危急电量和低磁盘会立即产生 `alert`；网络首轮只建立基线，之后离线产生 priority 90 `alert`，恢复产生 priority 45 `ambient`。进程内只在状态 band 变化时输出，电池/磁盘 external ID 还包含本地日期和阈值 band，由中心 Store 跨重启去重。

可配置：

- `MACOS_SYSTEM_POLL_INTERVAL_MS`：默认 300000，`0` 关闭主动 Event 但保留 action。
- `MACOS_SYSTEM_BATTERY_LOW_PERCENT` / `MACOS_SYSTEM_BATTERY_CRITICAL_PERCENT`：默认 20/10。
- `MACOS_SYSTEM_DISK_MIN_PERCENT` / `MACOS_SYSTEM_DISK_MIN_GB`：默认剩余 10% 或 10GB 任一命中即告警，设为 `0` 可分别关闭阈值。
- `MACOS_SYSTEM_DISK_PATH`：默认 `/`，必须是绝对路径。
- `MACOS_SYSTEM_COMMAND_TIMEOUT_MS`：pmset 超时，默认 10000，上限 120000。

所有系统命令都用固定 argv 调用且 stdout 上限 100KB。`pmset` 临时不可用时综合快照仍继续报告网络、内存和磁盘，只把电池标记为不可用；单独 `battery_status` 会返回明确 action 错误。

## macOS 生活 Bridge

`examples/connectors/macos-life-connector.mjs` 通过 macOS EventKit 原生后台接口接入 Calendar 和 Reminders，通过 Notification Center 发送通知，不需要额外 npm 依赖。读取、轮询和增删改不会启动、激活或控制 Calendar/Reminders App，也不会让它们常驻 Dock。开启实际配置 `~/.mimi-agent/daemon/connectors.json` 中的 `macos-life` 后，首次访问仍可能出现 macOS 自己的日历/提醒事项权限提示；这是系统授权窗口，不是对应 App 被启动，授权后访问保持静默。

轮询会把临近日程、日程改期或删除、提醒变更、完成、删除和逾期转换为稳定可去重事件。一个权限为 `0600` 的有界快照只用于跨重启比较，默认位于 `~/.mimi-agent/daemon/macos-life.json`；`MACOS_LIFE_MAX_ITEMS` 控制最多跟踪 200 项，`MACOS_LIFE_STATE_FILE` 可覆盖路径。逾期提醒使用 `urgentPriority` 默认值 95，不会被普通静默时段阻塞。

`calendar_upcoming` 额外携带按 `endAt + 5 分钟` 计算的 `suggestedFollowUpAt`。Daemon 只对固定的 `macos-life` 来源注入会议执行剧本：先完成冲突检查和可用材料准备，确有会议产出时再建立一次会后唤醒；外部来源伪造同名 payload type 不会获得这段可信指令。

Actions：

- `notify`：`target` 是通知标题，payload 支持 `text`、`subtitle`、`sound`。
- `calendar_list`：`target` 是日历名或 `*`，payload 支持 ISO `from`、`to` 和 `limit`。
- `calendar_create`：`target` 是日历名，payload 必填 `title`、`start`，可选 `end`、`location`、`notes`、`allDay`。
- `calendar_update`：`target` 是稳定 event UID；payload 至少包含一个 `title`、`start`、`end`、`location`、`notes`、`allDay`，可用 `calendar` 缩小搜索范围。
- `calendar_delete`：`target` 是稳定 event UID；payload 可用 `calendar` 缩小搜索范围。
- `reminder_list`：`target` 是提醒列表名或 `*`，payload 支持 `completed` 和 `limit`。
- `reminder_create`：`target` 是提醒列表名，payload 必填 `title`，可选 `dueAt`、`notes`、`priority`、`flagged`。
- `reminder_complete`：`target` 是提醒 ID，payload 可用 `list` 缩小搜索范围。
- `reminder_update`：`target` 是稳定 reminder ID；payload 至少包含一个 `title`、`dueAt`、`notes`、`priority`、`completed`、`flagged`，其中 `dueAt:null` 清除到期时间，可用 `list` 缩小范围。
- `reminder_delete`：`target` 是稳定 reminder ID；payload 可用 `list` 缩小搜索范围。

修改动作的标题上限 1000 字符、地点 5000、备注 40000，priority 必须是 0～9，日期必须可解析。空更新、无效字段类型和找不到稳定 ID 都明确失败，不按名称猜测对象。删除 recurring Calendar event 时只操作当前 occurrence，Connector 不引入 recurrence DSL。所有写操作继续使用 Action Bridge 的不确定结果不自动重放保护。

默认每 5 分钟查询未来 30 分钟的日程和到期提醒，并输出 `alert` Event。Store 使用日程/提醒 ID 与时间去重，所以 Connector 重启不会反复执行同一事件。可配置：

- `MACOS_POLL_INTERVAL_MS`：轮询间隔，`0` 关闭主动 Event。
- `MACOS_LOOKAHEAD_MINUTES`：向前查看分钟数。
- `MACOS_CALENDAR`：轮询指定日历名，默认 `*`。
- `MACOS_REMINDER_LIST`：轮询指定提醒列表，默认 `*`。

Connector 通过 argv 向本地 EventKit helper 传 JSON，不用 Shell 拼接日程标题或备注。helper 按源码摘要在 Daemon 数据目录中只编译缓存一次，后续轮询直接执行原生小程序，不会周期性重新编译。首次访问可能出现 macOS 自己的日历或提醒事项授权提示；接受授权后访问保持静默。

## macOS Mail Bridge

`examples/connectors/macos-mail-connector.mjs` 通过 Apple Mail 自带 JXA 字典接入用户已配置的邮件账号。账号密码仍由 Mail/Keychain 管理，Connector 无需获得 IMAP/SMTP 凭证，也没有额外 npm 依赖。

启用实际配置 `~/.mimi-agent/daemon/connectors.json` 中的 `macos-mail` 后，Connector 会轮询 Apple Mail 统一收件箱的未读邮件，输出为 priority 75 的 `alert` Event。默认白天即时进入 Agent，静默时段、Snooze 或达到预算后仍由 Attention 合并进简报；无需动作时 Agent 可静默完成。邮件 message ID 用于稳定去重，发件人和去除 `Re:/Fwd:` 的 `threadSubject` 生成稳定 Session 会话键 `threadId`。正文预览会被截断，Event 只带附件数量，不在轮询阶段下载附件。

Daemon 只对固定 `mail` 来源附加邮件事务剧本，但 event policy 始终优先，剧本不能解锁人物 context、Session、读取或写入工具。默认 external 入站只分析有界 Event；owner/system Run 在权限允许时可显式读取完整正文和附件、代办、回复、整理或建立 Watch。其他来源伪造 `unread_mail` 不会获得该来源剧本。

内置配置把本机 Mail Connector provenance 固定为 `external`。邮件正文始终是不可信 user input；入站 Run 不注入 Standing Orders、人物 context 或既有 Session，也不会因为部署设为 `trusted` 就获得 `connector_action`。读取全文、发信或修改邮箱必须来自 Host 已认证的 `owner/system` 运行。

可配置环境变量：

- `MACOS_MAIL_POLL_INTERVAL_MS`：默认 120000，`0` 关闭主动轮询但保留 action。
- `MACOS_MAIL_MAX_UNREAD`：单次最多处理未读数，默认 20，上限 100。
- `MACOS_MAIL_BODY_CHARS`：预览和单封读取的正文字符上限，默认 4000，上限 50000。
- `MACOS_MAIL_ACCOUNT`：只轮询指定 Mail 账号名，默认 `*` 表示统一收件箱。

Actions：

- `list_unread`：`target=<account-name>|*`，payload 支持 `limit` 和 `includeBody`。
- `search_messages`：`target=<account-name>|*`，默认在统一收件箱按 sender/subject 的 `query`、可选 `read`/`flagged` 筛选；支持 `limit`（最大 100）和 `includeBody`。精确账号 target 可选传 `mailboxPath`。
- `search_mailbox_messages`：显式历史邮箱搜索入口，必须使用精确账号 target 和 `mailboxPath:string[]`；与 `search_messages` 复用同一有界实现。该独立 catalog 名称让已有安装在升级时自动发现新能力。
- `read_message`：`target=<message-id>`，返回正文和最多 50 项附件元数据；payload 可用 `markRead:true` 在读取时标记已读，历史邮件传 `source:{account,path}`。
- `list_mailboxes`：`target=<account-name>|*`，递归返回最多 200 个 `{account,path,unreadCount}`，其中 path 是最多 20 段的名称数组。
- `list_attachments`：`target=<message-id>`，只返回稳定 attachment ID、名称、MIME、大小和下载状态；历史邮件可传 `source`。
- `save_attachment`：`target=<message-id>`，payload 必填 `attachmentId` 和绝对 `outputPath`，仅显式 `overwrite:true` 时覆盖现有文件；历史邮件可传 `source`。
- `send_message`：`target=<primary-recipient>`，payload 必填 `subject`，支持 `body`、`to`、`cc`、`bcc`、`sender` 和 `attachments`。
- `reply_message`：`target=<message-id>`，payload 必填 `body`，可用 `replyAll:true`、`attachments` 和历史邮件 `source`。
- `mark_read`：`target=<message-id>`，payload 用 `read` 切换状态，默认 `true`；历史邮件可传 `source`。
- `set_flagged`：`target=<message-id>`，payload 必填 `flagged`，可选 `color` 为 0～6；历史邮件可传 `source`。
- `move_message`：`target=<message-id>`，payload 必填 `destinationAccount` 和从账号根目录开始的 `destinationPath:string[]`；历史邮件可传 `source`。
- `delete_message`：`target=<message-id>`，删除指定邮件；历史邮件可传 `source`。
- `create_draft`：收件人和 payload 与 `send_message` 相同，但仅保存草稿。

邮件 Event 故意不设置 `replyTarget`：Agent 的普通处理结果不会被当作给发件人的回信。MimiAgent 需要主动选择 `reply_message` 才会发送。Connector 也支持显式 Outbox delivery，此时 target 必须是收件人邮箱。所有标题、正文、地址和路径均以 JSON argv 传入 `osascript`，不经 Shell。

发件 `attachments` 最多 20 个绝对路径，只接受不跟随符号链接的普通文件，单个最大 25MB、合计最大 50MB。收件附件名称属于不可信元数据，不会用于推导落盘路径；`save_attachment` 先让 Mail 写入目标目录中的随机临时文件，验证后设为 `0600`，再以 no-clobber hard link 或显式覆盖时的 atomic rename 提交，并在所有终态清理临时文件。二进制内容不会进入 NDJSON。

搜索默认只覆盖统一收件箱，不建立邮箱镜像或读取所有历史目录。历史查询必须先调用 `list_mailboxes`，再把返回的精确账号和完整 path 原样交给 `search_mailbox_messages`；单次只读取该邮箱且最多返回 100 条。结果中的 `account` 与 `mailboxPath` 可组成后续按 ID 动作的 `source:{account,path}`。邮箱名称可能本地化，因此 Connector 不猜测“Archive/归档”；路径逐层精确匹配，缺失或同层重名时明确失败。旗标、回复、移动和删除是真实外部事务，不增加逐次审批，并沿用 Action Bridge 的不确定结果不自动重放语义。

首次运行时 macOS 会请求对 Mail 的自动化访问。这是操作系统隐私边界，MimiAgent 内部不叠加审批模型。邮件正文始终作为外部来源数据注入 Agent，不作为系统指令。

## macOS Messages Bridge

`examples/connectors/macos-messages-connector.mjs` 使用 Node 内置 `node:sqlite` 以只读模式打开 `~/Library/Messages/chat.db`，并用 Messages.app 的 JXA 字典发送消息，不需要第三方 npm 依赖。它不会写入 Apple 的私有数据库。

启用实际配置 `~/.mimi-agent/daemon/connectors.json` 中的 `macos-messages` 前，需要给实际运行 Connector 的 Node、Terminal 或 LaunchAgent 对应可执行程序授予 macOS“隐私与安全性 → 完全磁盘访问权限”。发送消息时，系统还可能请求对 Messages 的自动化访问。MimiAgent 不在这两层系统权限之上增加审批流程。

可配置环境变量：

- `MACOS_MESSAGES_DB`：Messages 数据库路径，默认 `~/Library/Messages/chat.db`；主要用于测试或非默认用户目录。
- `MACOS_MESSAGES_POLL_INTERVAL_MS`：默认 30000，`0` 关闭主动轮询但保留 action。
- `MACOS_MESSAGES_MAX_EVENTS`：单次最多产生的来信事件数，默认 50，上限 200。
- `MACOS_MESSAGES_LOOKBACK_HOURS`：轮询和默认历史查询回看窗口，默认 24 小时，上限 720 小时。

Actions：

- `list_chats`：列出最近活跃会话；payload 支持 `limit`。
- `recent_messages`：`target=<chat-guid>|<handle>`，payload 支持 `limit`，结果按时间正序返回。
- `list_attachments`：`target=<message-guid>|<local-id>`，payload 支持 `limit`（最大 50），返回稳定 ID、名称、MIME、声明/实际大小、传输状态、本地路径和 availability。
- `save_attachment`：`target=<message-guid>|<local-id>`，payload 必填 `attachmentId` 和绝对 `outputPath`，仅显式 `overwrite:true` 时覆盖。
- `send_message`：`target=<chat-guid>|<phone-or-address>`，payload 支持 `text` 和 `attachments`，至少提供一项。

轮询到的来信输出为 priority 80 的 `alert` Event，发送者作为 actor，chat GUID 同时作为稳定 conversation 和 `replyTarget`。默认白天立即处理，静默时段、Snooze 或达到预算时进入简报。Daemon 只对固定 `messages` 来源注入即时消息事务剧本：需要答复时，Agent 的最终答案作为可直接发送的正文经可靠 Outbox 回复原会话；无需答复或已经显式调用 `send_message` 时安静完成，避免多余或重复回复。需要等待对方确认时可按 chatId、sender 和 receivedAt 建立 Watch。

内置配置同样把本机 Messages Connector provenance 固定为 `external`，来信文字和附件都是不可信数据。当前 Event 仍可通过可靠 reply route 返回普通对话结果，但受限 Run 看不到 Standing Orders、人物 context 或历史，也不能调用 `recent_messages`、`send_message` 等 Connector action；查历史、发附件或跨 Connector 办事必须由 Host 已认证的 `owner/system` 运行发起。

Messages 数据库属于 macOS 私有实现。Connector 启动时会验证核心消息表；附件 action 再按需验证 attachment 关联最小列，并对 MIME、声明大小和传输状态等版本可选列动态读取。富文本 `attributedBody` 不做不稳定的 typedstream 解码；没有普通文本的附件或富消息在 Event 中仍以占位文本和数量呈现，附件不会自动复制。

`save_attachment` 不信任数据库 filename 作为输出名：owner/Agent 必须提供绝对路径，Connector 重新 `lstat` 本地源，只接受不跟随符号链接的普通文件，再通过同目录随机临时副本、`0600`、no-clobber hard link 或显式 atomic overwrite 提交。发件 `attachments` 最多 20 个绝对普通文件，单个 250MB、合计 500MB。文本和每个附件是连续的系统 send 事务；中途失败可能已有前序项成功，Action Bridge 不自动重放整组操作。读取始终使用只读连接，测试也只使用合成 fixture，不访问真实消息。

## macOS Contacts Bridge

`examples/connectors/macos-contacts-connector.mjs` 通过 Contacts.app 的 JXA 字典按需查询和维护系统通讯录，不需要额外 npm 依赖。它是 action-only Connector：不轮询联系人、不复制通讯录，也不会产生后台 Event。

Actions：

- `search_contacts`：`target=<query>|*`，按姓名、昵称、组织、邮箱或电话匹配；payload 支持 `limit`，默认 20，上限 100。
- `get_contact`：`target=<contact-id>`，读取稳定 ID 对应的常用字段、邮箱、电话、分组和最多 4000 字符备注。
- `create_contact`：`target=new`，payload 支持姓名、昵称、组织、部门、职位、备注、`company`、`emails` 和 `phones`。
- `update_contact`：`target=<contact-id>`，可更新上述标量字段，并通过 `addEmails`、`addPhones` 追加联系方式。

`emails`、`phones`、`addEmails` 和 `addPhones` 均为最多 20 项的 `{label, value}` 数组。搜索会返回全部有界候选而不在重名时自动选第一个；Agent 应先取得 contact ID，再把选定的邮箱或号码交给 Mail、Messages 等 Connector。

首次使用时 macOS 会请求对 Contacts 的自动化/隐私访问。这是系统权限边界，MimiAgent 不叠加审批。Connector 不输出图片、二进制 vCard 或完整地址，所有输入使用 JSON argv 传入 `osascript`，不经 Shell。

## macOS Notes Bridge

`examples/connectors/macos-notes-connector.mjs` 通过 Notes.app JXA 接入现有本机/iCloud Notes 账号，不需要额外 npm 依赖。它是 action-only Connector：不轮询、不复制 Notes 私有数据库，也不会在写入后产生自触发 Event。

Actions：

- `list_folders`：`target=all|<account-name>|<account-id>`，列出账号和最多 200 个顶层文件夹及稳定 ID。
- `search_notes`：`target=<query>|*`，搜索标题和纯文本预览；payload 支持 `folderId`、`limit`（上限 100）和 `scanLimit`（上限 5000），并报告 `truncated`。
- `read_note`：`target=<note-id>`，payload 支持 `bodyFormat: plain|html` 和 `bodyChars`（上限 50000）。
- `create_note`：`target=default|<folder-id>`，payload 必填 `title`，支持 `body`、`bodyFormat`。
- `update_note`：`target=<note-id>`，更新标题或替换正文。
- `append_note`：`target=<note-id>`，追加必填 `body`，可配置纯文本 `separator`。

创建、更新和追加正文最多 40000 字符。默认 `bodyFormat` 是 `plain`，Connector 会在 JXA 内将 `& < >` 等字符转义为 HTML；只有显式指定 `html` 才按 HTML body 写入。读取密码保护笔记时不尝试解锁或返回正文，附件最多返回 20 项名称、ID、共享和时间元数据，不下载二进制内容。

首次使用由 macOS 请求对 Notes 的自动化访问。MimiAgent 不叠加审批模型；所有参数通过 JSON argv 传入 `osascript`，不经 Shell。

## macOS Shortcuts Bridge

`examples/connectors/macos-shortcuts-connector.mjs` 直接调用 macOS 自带 `/usr/bin/shortcuts`，把用户已经在 Shortcuts app 中维护的流程作为 MimiAgent 通用能力。Connector action-only、无 npm 依赖，不读取或重新编排 Shortcut 内部步骤。

Actions：

- `list_shortcuts`：`target=all|<folder-name-or-id>`，payload 支持 `limit`（默认 500，上限 1000）；返回 `--show-identifiers` 的有界逐行条目。
- `list_folders`：`target=all`，列出快捷指令文件夹及 identifier。
- `run_shortcut`：`target=<shortcut-name-or-id>`，运行快捷指令并返回结构化结果。

`run_shortcut` payload 支持：

- `input`、`inputEncoding: text|base64`、`inputName`：最多 40000 字符且解码后最多 40000 字节的内联输入，与通用 Action Bridge 载荷上限对齐。Connector 写入权限为 `0600` 的临时文件，并在成功、失败或超时后删除；更大输入应使用 `inputPaths`。
- `inputPaths`：最多 20 个现有绝对文件路径；支持 `~/` 展开。
- `outputPath`：显式绝对输出路径。存在时不再把文件内容复制进 action result。
- `outputType`：最多 200 字符的 Universal Type Identifier，例如 `public.utf8-plain-text`。
- `outputEncoding: text|base64`：没有 `outputPath` 时的 stdout 编码。
- `timeoutMs`：1 秒至 15 分钟，默认 2 分钟；`maxOutputBytes` 默认 100KB，上限 500KB，确保 base64 action result 仍小于单条 Connector 协议边界。

所有命令使用参数数组，不经过 Shell。快捷指令可以执行文件、网络、应用控制和智能家居等真实副作用；MimiAgent 默认可以直接调用，不叠加审批。超时或子进程退出后的结果可能不确定，Action Bridge 不自动重放。

## macOS Desktop Bridge

`examples/connectors/macos-desktop-connector.mjs` 通过 macOS 自带 JXA/System Events 和 `/usr/bin/open` 提供通用桌面执行面，无额外 npm 依赖。它适合没有专用 Connector 的即时应用操作；复杂、重复和需要稳定步骤的流程仍优先封装为 Shortcut。

Actions：

- `desktop_context`：`target=all`，返回前台应用和最多 `windowLimit`（默认 20，上限 100）个窗口；显式设置 `includeClipboard:true` 时附带最多 `clipboardChars`（上限 20000）的文本剪贴板。
- `frontmost_app`：`target=all`，返回应用名、bundle ID、PID、前台、可见和 background-only 状态。
- `list_apps`：`target=all`，payload 支持 `limit`（默认 100，上限 500）和 `includeBackground`。
- `list_windows`：`target=<app-name>|<bundle-id>|frontmost`，payload 支持 `limit`（默认 50，上限 100）。
- `activate_app`：`target=<app-name-or-bundle-id>`，激活指定应用。
- `open_item`：`target=<URL-or-absolute-path>`，支持 `~/` 展开；payload 可用不以 `-` 开头的 `application` 指定打开应用，避免 CLI option 注入。
- `clipboard_read`：`target=clipboard`，返回最多 `maxChars`（默认 40000，上限 100000）的文本、原始字符数和截断标记。
- `clipboard_write`：`target=clipboard`，payload `text` 最多 100000 字符；空字符串表示清空文本剪贴板。
- `clipboard_watch_status/start/stop`：读取、持久启用或停止剪贴板变化感知；`start` 可设置 `pollIntervalMs`（250ms～24h，省略时沿用有效的 `MACOS_DESKTOP_CLIPBOARD_POLL_MS`，否则为 2 秒）。选择原子保存到 `MACOS_DESKTOP_STATE_FILE`（默认 `~/.mimi-agent/daemon/desktop-clipboard.json`），跨 Connector/Daemon 重启恢复。
- `keyboard_type`：`target=<app-name>|<bundle-id>|frontmost`，输入最多 20000 字符；`modifiers` 支持 `command`、`option`、`control`、`shift`、`function`。
- `keyboard_key`：向指定应用发送 0～255 的 `keyCode` 和相同 modifiers。
- `click_menu`：点击指定应用的一级 `menu` / `item`，名称各最多 500 字符。

所有 JXA payload 都作为单个 JSON argv 传递，打开动作也只使用参数数组，不经 Shell。系统命令默认 20 秒超时，可通过 `MACOS_DESKTOP_COMMAND_TIMEOUT_MS` 调整到 100ms～120 秒；Host 的 `actionTimeoutMs` 应不小于它。菜单与键盘动作的结果若因超时或 Connector 断线而不确定，Action Bridge 不自动重放。

设置 `MACOS_DESKTOP_CLIPBOARD_POLL_MS=250..86400000` 可持续监听文本剪贴板；默认 `0` 关闭。首次读取只建立基线，不把启动前内容当成新事件；外部变化产生 priority 45 的 `ambient` Event，正文默认最多 8000 字符，可用 `MACOS_DESKTOP_CLIPBOARD_EVENT_CHARS=100..40000` 调整。Connector 自己成功写入后同步更新 hash，不产生自触发事件；相同内容不重复输出。hash 只在进程内保存，不建立剪贴板历史库。

首次执行窗口、菜单或键盘动作时，macOS 会请求 Accessibility/Automation 权限。该权限属于实际运行 Node/Terminal/LaunchAgent 的系统边界，MimiAgent 不叠加审批。剪贴板可能包含密码、令牌和私人内容，只有明确接受其进入模型上下文时才开启轮询。

## macOS Browser Bridge

`examples/connectors/macos-browser-connector.mjs` 直接调用 Safari 和 Google Chrome 随应用提供的 JXA 脚本接口，复用当前 profile、Cookie 和登录状态；不需要 Playwright、WebDriver、浏览器扩展或额外 npm 依赖。Connector action-only，不轮询标签、正文或浏览历史。

Actions：

- `list_tabs`：`target=all|safari|chrome`，返回最多 `limit`（默认 100，上限 500）个标签。ref 格式是 `safari:<windowIndex>:<tabIndex>` 或 `chrome:<windowIndex>:<tabIndex>`。
- `active_tab`：`target=safari|chrome`，读取最前窗口的当前标签。
- `open_tab`：payload `url` 必须是最多 8000 字符的绝对 http/https URL；`active:false` 可在后台打开。
- `navigate_tab`、`activate_tab`、`close_tab`、`reload_tab`：target 使用上述 tab ref。
- `page_text`：读取 Safari 原生页面 text 或 Chrome `document.body.innerText`，`maxChars` 默认 40000、上限 200000。
- `execute_javascript`：payload `script` 最多 40000 字符，`maxResultChars` 默认 100000、上限 500000；支持即时 DOM 查询和操作。

tab ref 是查询时的索引快照，不是永久 ID；标签增删或窗口重排后应重新调用 `list_tabs`。命令默认 20 秒超时，可用 `MACOS_BROWSER_COMMAND_TIMEOUT_MS=100..120000` 调整，输出硬上限为 1MB。所有 URL、脚本和 payload 都通过 argv JSON 传递，不经过 Shell；页面标题、URL、正文和脚本结果标记为 `untrusted:true`。

首次使用会触发 macOS Automation 权限。Safari 的 JavaScript 动作还要求在开发者设置中允许来自 Apple Events 的 JavaScript；Chrome 也可能要求开启对应的 Apple Events JavaScript 选项。JavaScript、导航、关闭等动作超时后结果可能不确定，Action Bridge 不自动重放。

## macOS Screen Bridge

`examples/connectors/macos-screen-connector.mjs` 通过系统 `/usr/sbin/screencapture` 与 Swift Vision helper 为 MimiAgent 提供原生屏幕文字感知。它 action-only、零 npm 依赖，不持续录屏、不轮询屏幕、不保存截图历史，也不会把图片发送到外部 OCR 服务。

Actions：

- `capture_screen`：target 支持 `main`、`display:N`、`window:ID`、`rect:X,Y,W,H`；payload 必须提供显式绝对 `outputPath`，且以 `.png` 结尾。`includeCursor` 默认 false，window 的 `excludeShadow` 默认 true。
- `ocr_image`：target 是现有图片的绝对路径，使用 Vision Framework 返回文字行、confidence 和 normalized bounding box。
- `read_screen`：target 与 `capture_screen` 相同，在权限为 `0700` 的系统临时目录截图、OCR，并在成功、失败或超时后递归删除临时图片。

OCR payload 支持 `recognitionLevel: accurate|fast`（默认 accurate）、最多 10 个 BCP-47 `languages`、`maxChars`（默认 40000，上限 200000）、`maxLines`（默认 500，上限 2000）和 `maxImageBytes`（默认 50MB，上限 100MB）。所有动作可用 `timeoutMs` 单独覆盖超时。结果包含完整字符/行计数与截断标记，并固定为 `untrusted:true`。命令默认 60 秒超时，可用 `MACOS_SCREEN_COMMAND_TIMEOUT_MS=100..300000` 调整；Host 的 `actionTimeoutMs` 应更长。

首次截图时，macOS 会向实际运行 Node 的 Terminal 或 LaunchAgent 请求 Screen Recording 权限。OCR 对图标、遮挡、小字体和低对比度内容不保证完整；它提供可用于判断和后续桌面动作的文字证据，不是像素级 UI 状态证明。所有命令均使用参数数组，不经过 Shell。

## macOS Voice Bridge

`examples/connectors/macos-voice-connector.mjs` 使用 Swift Speech/AVFoundation helper 和系统 `/usr/bin/say` 提供双向语音交互，无 npm 依赖、云端语音 SDK、音频数据库或常驻模型音频流。它既可产生 Event，也提供 Action Bridge actions。

持续监听默认关闭。`MACOS_VOICE_LISTEN` 只提供首次启动默认值；之后 `listener_start/stop/restart` 会把选择原子保存到本机 `0600` 状态文件，Connector 或 Daemon 重启后继续生效。helper 把麦克风按 2～30 秒的有界 segment 送入系统 Speech Framework；只有转写结果以 `MACOS_VOICE_WAKE_PHRASES` 中的短语开头才产生 priority 100 的 `external` command Event。默认短语是 `咪咪,Mimi,MimiAgent`；命令进入固定 `voice-owner` conversation，Agent 结果经可靠 Outbox 回到同一 Connector 并自动朗读；其他环境语音在 Connector 内丢弃，不启动 Agent。相同命令默认 30 秒内只产生一次 Event，可用 `MACOS_VOICE_DUPLICATE_WINDOW_MS=0..600000` 调整。唤醒短语不是说话人认证；只有另行完成身份校验或明确接受物理环境风险时，owner 才应在本机 Connector 配置中把 provenance 改为 `owner`。

环境配置：

- `MACOS_VOICE_LOCALE`：识别 locale，默认 `zh-CN`。
- `MACOS_VOICE_ON_DEVICE`：默认 false；设为 true 时要求对应 locale 的本机识别模型，不允许 Speech Framework 把音频发送到网络。
- `MACOS_VOICE_SEGMENT_SECONDS`：默认 6 秒，范围 2～30。
- `MACOS_VOICE_MAX_CHARS`：单段最多 1～20000 字符，默认 2000。
- `MACOS_VOICE_COMMAND_TIMEOUT_MS`：Action 默认超时 100ms～15 分钟，默认 2 分钟。
- `MACOS_VOICE_REPLY_MAX_CHARS`：自动朗读回答的最大字符数，默认 80、上限 20000；完整回答仍保留在 Event/Session，更长内容只朗读有界前缀并说明省略。调高时应同步增加 Connector 的 `deliveryTimeoutMs`。
- `MACOS_VOICE_REPLY_RATE`：自动朗读回答的语速，默认 220，范围 80～500。
- `MACOS_VOICE_STATE_FILE`：监听启停状态文件，默认 `~/.mimi-agent/daemon/voice-listener.json`；必须是绝对路径。

Actions：

- `speak`：target 为 `default` 或系统 voice 名称；payload `text` 最多 20000 字符，`rate` 为 80～500 words/minute。若 listener 正在运行，朗读前停止、结束后恢复，避免 MimiAgent 自己唤醒自己。
- `list_voices`：`target=all`，解析 `say -v ?` 的 voice、locale 和示例，最多返回 1000 项。
- `transcribe_audio`：target 为现有音频绝对路径；支持 `locale`、`onDevice`、`maxChars`、`maxAudioBytes`（默认 200MB，上限 1GB）和 `timeoutMs`。
- `listener_status/start/stop/restart`：`target=listener`，读取或持久管理 listener；启停选择跨 Connector/Daemon 重启恢复。

所有文本、路径和选项都使用参数数组，不经过 Shell。listener 不写原始音频文件；转写和命令 payload 标记为 `untrusted:true`，示例 Connector 的 provenance 也固定为 `external`，因此默认只获得最小外部事件能力。首次使用需要向实际运行进程授予 macOS Microphone 与 Speech Recognition 权限。部分 locale 在 `onDevice:false` 时可能联网；需要严格本地时显式设为 true，并确保系统已安装对应语言模型。

## 事件执行权限

只有 `owner/system` 事件可在当前部署权限内直接工作。其余 provenance（包括 `trusted/external/public`）默认只开放当前 attempt 内的静默投递控制，不提供通用网络读取，避免来源内容借 `http_get` 探测 localhost、内网或云 metadata；它们也不可读取 Session 历史/归档/恢复点、Memory、本地文件或持久状态，不可使用 Shell、MCP、状态写入或外部事务。精确匹配 owner source policy 后，默认 `access=reply` 只开放当前人物 Session 的有界上下文和自动回复；只有显式 `access=work` 才开放静态工作工具。来源正文始终作为不可信 user input，不能提升档位或扩大工具范围；常驻执行契约仍由 Host 单独提供。

Connector 仍是首层信任边界：只接入你愿意处理的来源，限制 IM 白名单，且只在 `envAllowlist` 中提供必要凭证。需要代 owner 执行本地或外部事务的控制入口必须在 Host 侧完成认证并明确配置为 `owner`；`trusted` 只记录 provenance，不会提权，事件正文也不能自行改变该标签。
