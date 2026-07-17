# MimiAgent QQ / 微信后台双向连接设计

日期：2026-07-16

## 目标与验收

硬约束：QQ/微信收发不得激活桌面 App、抢占焦点、截图/OCR、模拟键盘或点击。

端到端验收必须分别证明：

1. 后台 transport 的真实账号/通道在线，而不只是子进程存在。
2. 一条真实入站消息形成稳定 `externalId`，持久写入 Event Store，并能在 Daemon 重启后去重。
3. MimiAgent 回复经 Outbox 投递到原会话；主动发送通过明确 target 完成。
4. QQ 能读取近期会话以及指定好友/群历史；读取 action 有数量和内容上限。
5. 微信明确展示 iLink Bot 范围；没有 personal-inbox/history/contact 能力时必须返回 unsupported，而不是 UI fallback。
6. 实际运行配置中 `qq-applescript` 和 `wechat-applescript` 均为 disabled/不存在。

## 拓扑

```text
QQ personal account
  NapCat/NTQQ
    ├─ reverse WebSocket events ─> qq-napcat connector ─> ConnectorManager
    └─ loopback HTTP actions <──── qq-napcat connector <─ Outbox/action bridge

Weixin Bot
  Tencent iLink API
    <─ getUpdates/sendMessage ─> OpenClaw + official openclaw-weixin plugin
                                   ├─ inbound_claim ─> authenticated Unix socket submit
                                   └─ openclaw CLI send <─ openclaw-weixin connector

ConnectorManager / IPC submit
  ─> SQLite Event Store ─> Dispatcher ─> Run ─> Outbox ─> original connector route
```

不增加第二套消息队列、会话库或任务系统。事件持久化、租约、去重、重试和不确定副作用处理继续由现有 Daemon/Outbox 承担。

## QQ Connector 改造

- ID 全程保留字符串，拒绝空值、额外 target 类型和超限 payload。
- 入站事件保留 `messageId`、消息类型、发送人、会话 ID 和规范化文本；非文本段生成有界占位符，不因图片/文件而把事件变成空消息。
- 新增只读 actions：
  - `recent_conversations`：`target=all`，payload `count` 1～100。
  - `list_friends`：`target=all`，payload `limit` 1～500。
  - `list_groups`：`target=all`，payload `limit` 1～500。
  - `friend_history`：`target=private:<qq>`，payload `count` 1～100、可选 `messageSeq`、`reverseOrder`。
  - `group_history`：`target=group:<qq>`，payload `count` 1～100、可选 `messageSeq`、`reverseOrder`。
- action 结果裁剪到有界字段和 20,000 字符文本，避免把 NapCat 内部字段、凭证或无限历史直接注入模型。
- `health_check` 同时验证 `get_status.online/good` 与反向 WebSocket；定时刷新 readiness，HTTP 不在线时 outbound 必须是 `unavailable`。
- WebSocket 和 HTTP token 可分离；两者只从 Connector env allowlist 注入，监听固定为 loopback。

## 微信 Bridge 改造

- 使用 OpenClaw 的 `inbound_claim`，在 OpenClaw Agent 运行前把消息交给 MimiAgent 并返回 `handled:true`，保证只有一个 Agent owner；`before_dispatch` 是出站 hook，不能承担入站接管。
- Unix socket 请求携带 owner-only `0600` control token；`source + externalId` 由 MimiAgent Store 去重。
- `ownerSenders` 必须显式配置。未匹配 sender 保持 `external`，不得进入 owner Session 或获得 owner 工具权限。
- readiness 需要同时满足官方 channel account `enabled/configured/running/no lastError` 和 Mimi bridge plugin `loaded/activated`。
- `send_message` target 只接受入站路由产生的 `account=<id>&to=<id>`；不提供联系人名称猜测。
- `deliveryConfirmed` 仅表示 API transaction 已被上游接受，不宣称收件人已读；真实验收用回消息闭环。
- 官方协议没有历史读取 API。MimiAgent 只查询自身已记录 Event；若历史在 bridge 接通前已被 sync cursor 消费，明确报告不可恢复。

## 配置与迁移

- 发布模板不再提供 QQ/微信 AppleScript Connector 条目；保留旧示例文件只用于兼容说明，不作为支持路径。
- 当前机器先关闭 `qq-applescript`、`wechat-applescript`，启用 `openclaw-weixin`；NapCat 安装、token 与 loopback HTTP/WS 配完后再启用 `qq`。
- 安装脚本必须增量修改实际 Connector 配置，不能用仓库模板覆盖用户现有 `connectors.json`，也不能把空 token 写成“配置完成”。
- macOS NapCat 安装必须先校验 GitHub Release digest、QQ 最低构建、完整代码签名、Apple 执行策略、腾讯 Team ID 和入口，精确备份后才原子替换。优先修改 owner-only 私有 QQ 副本，不修改 `/Applications/QQ.app`；安装器用 `0600` 状态文件记住所选路径。日常由用户级 LaunchAgent 直接执行带守卫的后台入口，并在导入 NapCat 前把 Electron activation policy 设为 `prohibited`，不支持即失败；系统/私有普通 QQ 正在运行、QQ 升级重置入口或 Shell 缺失时也 fail closed，不退出、激活或操控桌面 App。
- `mimi daemon connectors` 的能力目录增加 QQ 历史 actions；Doctor/文档必须区分 official bot 与 personal account。

## 测试

- 使用本地 fake NapCat HTTP server + authenticated reverse WebSocket 覆盖：字符串 ID、入站媒体规范化、历史 actions、边界、掉线 readiness、发送事务。
- 使用 fake OpenClaw CLI + 真实本地 IPC server 覆盖：bridge claim、owner/external 隔离、控制 token、发送和 readiness。
- 运行 `npm run check`、聚焦测试、`npm test` 和 `npm run build`。
- 真实验收时只用 CLI/API；通过进程焦点/前台 App 状态证明测试期间没有调用 UI Connector。
