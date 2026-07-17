# Mimi Apple Mail 收件箱整理闭环调研报告

日期：2026-07-15
状态：已审核（owner 已明确要求按设计直接实施）

## 调研范围

- 目标：让 Mimi 从“能读写邮件”扩展为“能持续搜索和整理收件箱”。
- 涉及文件：
  - `examples/connectors/macos-mail-connector.mjs`
  - `tests/macos-mail-connector.test.ts`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
  - `/System/Applications/Mail.app/Contents/Resources/Mail.sdef`

## 核心发现

### 现状分析

现有 Mail Connector 已支持未读轮询、读取、已读、发送、回复、草稿和附件收发，但读取范围固定为统一收件箱，无法按发件人/主题和状态检索，也无法列出邮箱目录、加旗标、移动或删除邮件。结果是 Mimi 能参与单封邮件，却不能替 owner 完成日常 inbox triage。

### 本机权威能力

Mail `.sdef` 明确提供：

- account 的 mailbox 元素，mailbox 可递归包含子 mailbox 和 message；
- message 可写的 `read status`、`flagged status`、`flag index`、`deleted status` 与 `mailbox`；
- Mail 定制的 `move` 与 `delete` 命令；
- mailbox 的名称、账号、父容器和未读数。

因此不需要 IMAP 凭证、私有数据库或 GUI 点击即可完成整理事务。

### 可复用流程

- 继续使用单个 JXA `MAIL_SCRIPT` 和 JSON argv，复用 `findMessage`、`messageInfo` 与现有 Node payload 校验。
- 继续通过 Connector Action Bridge 执行真实副作用并记录结果；移动/删除在超时或断线后不自动重放。
- mailbox 用 `{account, path: string[]}` 标识。数组路径避免邮箱名称包含 `/` 时出现歧义，也不依赖 Mail 未公开的 mailbox ID。

### 约束与风险

- 读取 `app.inbox().messages()` 会遍历统一收件箱；现有未读轮询已经使用同一路径。搜索必须限制结果数和正文长度，不扩展到所有账号的全部历史邮箱。
- 同一层级可能存在同名 mailbox；查找必须在每一级检测 0 个或多个匹配并明确失败，不能静默选第一个。
- 邮箱名称、主题、发件人和正文均是不可信外部数据；只作为筛选值和结果，不作为指令。
- delete/move 是不可轻易撤销的真实事务，但项目要求默认开放权限，因此不增加审批；只依赖稳定 message ID、显式目标目录和现有事务 ledger。
- 邮箱本地化使“Archive”名称不可硬编码；只提供显式 `move_message`，由 Agent 先 `list_mailboxes` 获取真实目录。

## 与任务相关的关键结论

最轻量且能闭环的方案是在现有 Mail Connector 增加四类能力：有界 `search_messages`、递归有界 `list_mailboxes`、`set_flagged`、显式目录 `move_message` 和 `delete_message`。不实现邮箱镜像、全文索引、规则引擎、批量 DSL 或硬编码归档目录。
