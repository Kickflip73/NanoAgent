# Mimi macOS Messages 连接器调研报告

日期：2026-07-15  
状态：已审核（用户已授权直接实施）

## 调研范围

- 目标：将 iMessage/SMS/RCS 新消息接入 Mimi，支持查询会话、读取近期消息和主动发送。
- 涉及文件：
  - `examples/connectors/macos-messages-connector.mjs`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
  - `tests/macos-messages-connector.test.ts`

## 核心发现

### 现状分析

macOS 当前 `Messages.sdef` 暴露 account、participant、chat 与 `send`，但不暴露聊天消息历史。历史位于 `~/Library/Messages/chat.db`，常用 schema 由 `message`、`chat`、`handle`、`chat_message_join`、`chat_handle_join` 组成。该数据库受 macOS Full Disk Access 保护，当前开发进程读取 schema 也被 TCC 拒绝。

Node 22 已有项目正在使用的 `node:sqlite`，可以只读方式打开 `chat.db`，无需增加 SQLite 依赖。Messages JXA 则只用于发送，不与数据库写入混合。

### 关键流程

```text
chat.db (read-only)
  -> latest incoming rows
  -> command Event + stable chat/session/reply route
  -> Mimi decision
  -> Outbox or connector_action
  -> Messages JXA send(chat/participant)
```

### 现有约束

- 数据库始终使用 `readOnly:true`，不直接修改 Messages 内部表。
- 每次轮询只扫描有界数量的最新入站消息，再按 lookback 时间过滤。
- `message.guid` 作为稳定事件身份，`chat.guid` 作为 Session 和回传 target。
- 发送正文使用 JSON argv 进入 `osascript`，不经 Shell。
- 数据库打开后先检查必需表和字段，不默认未来 macOS 一定保持私有 schema。

### 风险与问题

- 运行 Daemon 的 Node/Terminal 需要 Full Disk Access 才能读取 `chat.db`；这是操作系统边界，不是 MimiAgent 审批模型。
- Messages 数据库是 Apple 私有 schema；Connector 必须失败清晰、只读打开并以 fixture 覆盖已支持的最小 schema。
- 新系统的富文本可只存于 `attributedBody`；首版不解码 Apple 私有 typedstream，`text` 为空时输出非文本/附件占位，不伪造正文。
- 自动 reply route 意味着 Agent 普通回答会发回原会话；这与 QQ/大象交互模式一致，并由 Attention 决定是否启动 Agent。

## 与任务相关的关键结论

1. 实现单个零依赖 Connector：`node:sqlite` 只读入站，Messages JXA 出站。
2. 对外提供 `list_chats`、`recent_messages`、`send_message` 三个 action，并支持可靠 Outbox delivery。
3. 轮询只发出时间窗内的入站消息，Store 使用稳定 ID 跨重启去重。
4. 真实数据库因 TCC 不可读，实施和自动化验证使用结构一致的临时 fixture，并在文档说明 Full Disk Access。
