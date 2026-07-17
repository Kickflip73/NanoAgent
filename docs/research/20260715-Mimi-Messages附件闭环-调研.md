# Mimi macOS Messages 附件闭环调研报告

日期：2026-07-15
状态：已审核（owner 已明确要求按设计直接实施）

## 调研范围

- 目标：让 Mimi 在 iMessage/SMS/RCS 会话中接收和发送图片、文档等附件。
- 涉及文件：
  - `examples/connectors/macos-messages-connector.mjs`
  - `tests/macos-messages-connector.test.ts`
  - `mimi.connectors.example.json`
  - `/System/Applications/Messages.app/Contents/Resources/Messages.sdef`

## 核心发现

### 现状分析

Messages Connector 已通过只读 `chat.db` 感知来信和读取会话，通过 JXA 发送文本。数据库查询只统计附件数量，无正文时输出 `[Attachment or rich message]`；没有列举、保存或发件附件能力，因此 Mimi 无法实际处理朋友、家人或同事发来的图片和文件。

### 本机权威能力

Messages `.sdef` 的 `send` 命令直接参数同时接受 `text` 和 `file`，目标可以是 participant 或 chat。字典还公开 file transfer 的稳定 ID、名称、本地路径、方向、账号、参与者、大小、进度与状态。

`chat.db` 的常见稳定关系是 `message_attachment_join(message_id, attachment_id)` → `attachment`。系统版本之间 attachment 可选字段会变化，因此 Connector 只能要求关联键、稳定 guid/ROWID 与 filename，其他 MIME、大小、状态字段按实际 schema 动态选择，不能把完整私有 schema 当成固定契约。

### 可复用流程

- 继续以只读 SQLite 打开 `chat.db`，使用固定 SQL 和 schema 检测，不写 Messages 私有数据库。
- 复用 Mail 附件的 Node 边界：显式绝对输出路径、普通文件、同目录随机临时文件、`0600`、默认 no-clobber、显式 atomic overwrite。
- 发件继续通过 JXA JSON argv；文本和附件分别调用系统 `send`，不实现 MIME、上传协议或聊天数据库写入。

### 风险与约束

- `chat.db` 和附件目录需要 Full Disk Access；Connector 不绕过系统授权。
- attachment filename、MIME 和原始文件均是不可信外部输入。filename 只用于显示，不用于推导 owner 的输出路径。
- 附件可能尚未下载、已被系统清理或位于符号链接；列表应报告 availability，保存时重新 `lstat` 并只接受普通文件。
- 文本加多个文件会形成多个 Messages send 事务；任一步超时后结果不确定，Action Bridge 不自动重放整组操作。
- 为保持有界，单消息最多列出 50 个附件；发送最多 20 个普通文件，单个 250MB、总计 500MB。

### WeChat 现状结论

本机 WeChat 4.0.5 没有 AppleScript/JXA 字典或稳定公开个人号消息 API。直接读加密私有库或依赖 OCR/坐标轮询不满足“可靠长期助手”，因此不把脆弱 UI 脚本标记为微信 Connector 完成；外部微信桥仍可通过现有 Webhook/Connector 协议接入。

## 与任务相关的关键结论

Phase 27 应扩展现有 Messages Connector：增加 `list_attachments`、`save_attachment`，并让 `send_message`/Outbox delivery 接受文本或附件。全部复用现有 SQLite、JXA 和原子文件模式，不新增依赖、服务、缓存、审批层或附件协议。
