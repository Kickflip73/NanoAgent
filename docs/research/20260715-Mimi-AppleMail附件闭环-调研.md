# Mimi Apple Mail 附件闭环调研报告

日期：2026-07-15
状态：已审核（用户已明确要求直接开发）

## 调研范围

- 目标：让 Mimi 能发现、保存和发送邮件附件，真正处理合同、报表、PDF 与工作文档。
- 涉及文件：
  - `examples/connectors/macos-mail-connector.mjs`
  - `tests/macos-mail-connector.test.ts`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
- 本机权威定义：`/System/Applications/Mail.app/Contents/Resources/Mail.sdef`

## 核心发现

### 现状分析

Mail Connector 已能轮询未读、读取正文、发信、回复、标记已读和创建草稿，但刻意不返回或保存附件。邮件事件只能告诉 Agent“请查看附件”，Agent 无法取得文件，也不能在回复/发信中附上本地成果。

### 关键流程

Mail.sdef 证明 received `message` 包含 `mail attachment` elements；每个附件有只读稳定 `id`、`name`、`MIME type`、`file size`、`downloaded`，并响应 Cocoa Standard `save`。Outgoing message 的 content 是 rich text，支持 `attachment` elements，可用 `Attachment({fileName: Path(...)})` 附加本地文件。

### 现有约束

- Incoming message 当前只在统一 inbox 中按 Message-ID/local ID 查找，附件动作沿用相同范围。
- 保存必须由 owner/Agent 指定绝对最终路径，不能使用附件名决定落盘位置。
- 不允许跟随待发送文件的符号链接；附件必须是普通文件。
- 单个发送附件和总量必须有界，防止协议或 Mail 进程被超大文件拖垮。
- 所有 JXA 输入继续通过 JSON argv，不经 Shell；Host 超时后不自动重放外部事务。
- 测试不得读取真实邮件或修改真实 Mail 状态。

### 风险与问题

- Mail `save` 直接写最终路径可能覆盖 owner 文件，也可能在进程崩溃时留下半文件。
- Connector action 超时后 Mail 是否已保存或发信不确定，不能自动重试。
- 附件显示名不可信，可能含路径分隔符；只能作为元数据，不能拼接路径。
- Outgoing path 可能是 symlink、目录或过大文件，必须在 Node 边界 `lstat` 校验。

## 与任务相关的关键结论

新增 `list_attachments` 与 `save_attachment`，并让 send/reply/draft 接受最多 20 个绝对普通文件路径。保存时让 Mail 写入最终目录内的随机临时文件，chmod `0600` 后使用 hard-link create-if-absent 或 atomic rename 提交，finally 清理临时文件；因此默认不覆盖、不会信任附件名，也不留下半文件。发送限制单文件 25MB、合计 50MB。无需新依赖、附件数据库或传输协议。
