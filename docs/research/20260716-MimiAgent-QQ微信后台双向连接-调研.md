# MimiAgent QQ / 微信后台双向连接调研

日期：2026-07-16

## 结论

QQ 与微信都不能再用 `System Events`、截图/OCR、键盘输入或点击发送作为正式通道。这类方案会抢占焦点、干扰用户操作，而且无法证明服务端接收或持续入站。

当前可落地的后台方案分成两类，不能混为一谈：

1. **官方 Bot 通道**：腾讯官方 QQ Bot 与 `@tencent-weixin/openclaw-weixin`。稳定性、合规性和后台运行体验最好，但只能处理 Bot 会话，不等于接管个人 QQ/微信账号的全部好友、群、联系人和历史记录。
2. **个人账号协议框架**：QQ 可用 NapCatQQ/OneBot 11 连接已登录 NTQQ，支持好友/群收发和历史接口；它不是腾讯官方个人号 API，存在账号风控、客户端版本兼容和第三方框架供应链风险。个人微信没有同等级、官方认可且能在 macOS 后台接管全部好友消息的接口。

因此，本次采用：

- 微信：腾讯官方 `openclaw-weixin` 插件的 iLink Bot API，使用 `getUpdates` 长轮询和 `sendMessage`，经本地 Unix socket 接入 MimiAgent。
- QQ：个人号需求使用 NapCatQQ 的 OneBot 11 HTTP + 反向 WebSocket；如果用户以后接受“QQ 机器人”而非个人号，优先迁移到腾讯官方 `openclaw-qqbot`。
- 明确禁止在产品状态中把“桌面 App 已登录”“Connector 进程存在”或“CLI 返回成功”误报为个人账号全量双向已打通。

## 上游能力证据

### 微信 iLink Bot

腾讯官方仓库 `Tencent/openclaw-weixin` 提供 QR 授权、`getUpdates` 长轮询、`sendMessage`、媒体上传和 typing API：

- https://github.com/Tencent/openclaw-weixin

协议约束：

- `getUpdates` 只按 `get_updates_buf` 游标读取 Bot 的新增消息，不提供任意个人微信会话历史查询。
- `sendMessage` 需要目标 `to_user_id` 和该会话的 `context_token`。未知联系人或从未和 Bot 建立上下文的个人微信用户不能按联系人名称任意主动发送。
- OpenClaw 只是插件宿主；账号 token、sync buffer、context token 和长轮询均由腾讯插件管理。

这条路线完全在后台运行，不需要启动或操作 `WeChat.app`。它也不读取桌面微信数据库。

### QQ NapCat / OneBot 11

NapCatQQ 是基于 NTQQ 的非官方协议框架，官方文档确认支持 HTTP、正向/反向 WebSocket、好友/群消息发送、好友/群列表和历史读取：

- https://github.com/NapNeko/NapCatQQ
- https://napneko.github.io/onebot/network
- https://napneko.github.io/onebot/api
- https://napneko.github.io/develop/api/doc

NapCat 官方只把 Windows OneKey 与 Linux `xvfb` 路径明确描述为无头；macOS 安装器文档描述的是修改 Electron 入口并传 `--no-sandbox`，没有单独承诺无窗口。因此本机 macOS 方案额外在导入 NapCat 前调用 Electron 官方 `app.setActivationPolicy('prohibited')`；该策略不出现在 Dock、不能创建窗口或被激活，API 缺失时拒绝启动：

- https://www.electronjs.org/docs/latest/api/app#appsetactivationpolicypolicy-macos

本次需要的接口：

- `get_status`：登录和协议端状态。
- `send_private_msg` / `send_group_msg`：文本发送。
- `get_recent_contact`：近期会话。
- `get_friend_msg_history`：好友历史。
- `get_group_msg_history`：群历史。
- `get_friend_list` / `get_group_list`：显式发现目标 ID。

NapCat v4.8.115+ 建议 `message_id`、`user_id`、`group_id` 使用字符串，避免 JavaScript 数值精度损失；Connector 不应再 `parseInt`。

### QQ 官方 Bot 备选

腾讯官方 `tencent-connect/openclaw-qqbot` 支持 C2C Bot 私聊、群 @、富媒体和主动推送：

- https://github.com/tencent-connect/openclaw-qqbot

它要求 QQ 开放平台的 AppID/AppSecret，目标是 Bot 会话，不读取用户当前个人 QQ 客户端的好友历史，因此不能直接替代本次个人号目标。

## 本机现状证据

2026-07-16 的只读检查显示：

- MimiAgent Daemon 正在运行，实际数据目录仍是兼容路径 `~/.mimi-agent/mimi`。
- `openclaw-weixin` 2.4.3 与 OpenClaw 2026.6.6 已加载，iLink account 和 gateway 存在。
- 腾讯插件曾在 2026-07-15 收到一条入站消息，但当时 MimiAgent socket 不存在，`mimiagent-bridge` 报 `ENOENT`；sync buffer 已前移，所以这条消息没有进入 MimiAgent Event Store。
- 当前 MimiAgent 数据库中没有 `qq` 或 `openclaw-weixin` Event，不能把当前状态算作已完成端到端验证。
- QQ 的 NapCat 进程和 HTTP/WS 端口不存在，正式 `qq` Connector 被禁用；运行中的 `qq-applescript`、`wechat-applescript` 是 UI 自动化兜底，应关闭。
- 旧 QQ 配置还缺少反向 WebSocket token allowlist，日志反复出现 `missing NC_WS_ACCESS_TOKEN`。
- NapCatQQ 最新 release 为 v4.18.9；下载的 `NapCat.Framework.zip` 已与 GitHub release SHA-256 digest 核对一致。官方 macOS 安装器 v1.4 会把框架放入 QQ 沙箱容器、备份并修改 `/Applications/QQ.app/Contents/Resources/app/package.json`，需要管理员权限。当前机器没有无交互 sudo，因此不能在不弹授权界面的情况下完成个人 QQ 安装。

## 2026-07-16 实际切换结果

- 实际运行配置中的 `qq-applescript`、`wechat-applescript` 已 disabled，两个 UI Connector 子进程已停止。
- 腾讯 iLink account 与 MimiAgent bridge 均已 ready；唯一已配对 sender 已显式加入 `ownerSenders`。
- 一条真实微信测试消息已经通过 `openclaw message send` 的后台 API 路径发送，上游返回非 dry-run message ID；没有启动或操作 WeChat.app。
- 腾讯上游没有历史接口，但本机 OpenClaw 的 current/deleted session archive 仍保留了 2026-06-15 的真实微信入站。新增 `local_history` 后已按当前 account/to 路由实机读回 10 条，包含稳定本地消息 ID、发生时间和有界正文；这只证明本机留存历史可读，不把它表述为腾讯云端历史。
- 观察窗口内尚未收到收件端回复，因此只能确认微信真实出站和后台监听在线，不能把真实入站闭环写成已通过。
- QQ Connector 已具备七个后台 actions 和双 token 配置，但 NapCat HTTP/WS 不存在，故保持 disabled；不能把代码就绪写成账号已打通。
- 腾讯官方下载的 QQ 6.9.96（内部 build 49738）已核对发布 SHA-256、Apple 公证/Developer ID 与腾讯 Team ID；NapCat 当前 offset 数据包含该 build。已把它复制到 `~/.mimi-agent/runtime/qq/QQ.app` 并只在这个私有副本安装 NapCat，系统 `/Applications/QQ.app` 保持原 build 36580 和原入口不变。
- 私有副本的 LaunchAgent 尚未启动：只读进程检查仍发现系统普通 QQ 正在运行，启动守卫已真实拒绝启动且没有代替用户退出、激活或操控 QQ。待用户自行退出一次后，才能继续 QQ 真实 HTTP/WS、好友“好乖乖”发送、历史和入站闭环验收。

## 风险与不能承诺的范围

- 个人微信：在不使用 UI 自动化、注入/Hook、逆向桌面数据库或非官方 iPad 协议的前提下，无法稳定读取当前个人微信账号的全部联系人消息和历史，也无法按任意联系人主动发送。MimiAgent 必须把 iLink Bot 范围如实展示。
- 个人 QQ：NapCat 能满足后台个人号能力，但不是腾讯官方 API。需要专用/可承受风控的 QQ 账号、只绑定 loopback、强 token、版本固定和升级前回归。
- 历史消息：QQ 可由 NapCat API 拉取；微信 iLink 没有历史 API，只能读取 MimiAgent/OpenClaw 已经记录过的 Bot 会话，不能通过重置 sync cursor 冒险重放未知范围。
- 发送确认：HTTP/API 成功证明上游接受事务，不等于对方客户端已读。真实验收仍需收件端确认或回消息闭环。
