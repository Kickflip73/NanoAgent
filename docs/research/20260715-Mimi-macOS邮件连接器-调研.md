# Mimi macOS 邮件连接器调研报告

日期：2026-07-15  
状态：已审核（用户已授权直接实施）

## 调研范围

- 目标：让常驻 Mimi 持续感知 Apple Mail 未读邮件，并能主动读取、发送、回复、标记已读和创建草稿。
- 涉及文件：
  - `examples/connectors/macos-mail-connector.mjs`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
  - `tests/macos-mail-connector.test.ts`

## 核心发现

### 现状分析

Connector Action Bridge 已经提供事件入站、主动 action、凭证隔离与不确定结果不自动重放。macOS 生活 Connector 也已证明 `osascript` + JXA 能以零 npm 依赖方式连接本机应用。

Apple Mail 随系统提供的 `Mail.sdef` 明确暴露了统一 inbox、message ID、subject、sender、content、date received、read status，以及 reply/send/outgoing message/to/cc/bcc recipient 和 save 能力。这些足以实现小而完整的邮件边界，不需要在 MimiAgent 内实现 IMAP/SMTP 协议栈。

### 关键流程

```text
Apple Mail unified Inbox
  -> bounded unread poll
  -> ambient mail Event with stable message ID
  -> Attention / Briefing / Agent
  -> connector_action(read/reply/send/mark/draft)
  -> Apple Mail
```

### 现有约束

- 不读取 Mail 账号密码；系统 Mail 使用已配置账号和 Keychain。
- 轮询只处理统一收件箱中有界数量的未读邮件，正文严格截断。
- 邮件不设置 `replyTarget`；处理结果不会自动回复所有发件人，Mimi 需要显式选择 `reply_message` action。
- 所有发送参数以 JSON argv 传给 `osascript`，不通过 Shell 拼接。
- 邮件外部正文仍是来源数据，不成为系统指令。

### 风险与问题

- 第一次自动化访问需要 macOS 系统授权；MimiAgent 不叠加自己的审批层。
- 部分邮件正文会触发 Mail 下载；轮询预览必须限长，并提供单封读取 action 用于需要的时候。
- Mail 的 reply 命令会生成一封 outgoing message；必须在同一 action 内设置正文并发送，返回明确结果。

## 与任务相关的关键结论

1. 实现独立 `macos-mail-connector.mjs`，不修改 Runtime 或引入邮件依赖。
2. 轮询未读邮件产生低打扰 `ambient` Event，稳定 ID 交给 Store 跨重启去重。
3. 对外声明 `list_unread`、`read_message`、`send_message`、`reply_message`、`mark_read`、`create_draft` 六个 action。
4. 支持 Connector delivery 作为显式收件人的新邮件发送，但入站 Event 不自动建立该路由。
