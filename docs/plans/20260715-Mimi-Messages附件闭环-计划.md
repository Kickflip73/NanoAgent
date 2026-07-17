# Mimi macOS Messages 附件闭环实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-Messages附件闭环-调研.md]]

## 任务目标

让 Mimi 能列出并显式保存 iMessage/SMS/RCS 收件附件，也能向现有 participant/chat 发送本地图片和文件。

## 方案概述

在现有 Messages Connector 内增加可选 attachment schema 读取、原子文件复制和 JXA file send。保持数据库只读、JSON argv、NDJSON Action Bridge 与不确定事务不重放语义。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无前端文件
预览状态：用户要求跳过（owner 已明确要求直接编码）

## 详细步骤

### 1. 收件附件目录

**涉及文件：** `examples/connectors/macos-messages-connector.mjs`

动态检查 attachment/join 最小列，在指定 message GUID/本地 ID 下返回最多 50 个稳定 attachment ID、名称、MIME、声明大小、传输状态、本地路径和 availability。私有可选字段不存在时返回空值，不影响纯文本消息。

### 2. 原子显式保存

**涉及文件：** `examples/connectors/macos-messages-connector.mjs`

新增 `save_attachment`：要求 attachmentId 和绝对 outputPath，重新验证源为普通文件，用同目录随机临时副本、`0600`、hard-link no-clobber 或显式 atomic rename 提交，并清理所有终态。

### 3. 文件发送

**涉及文件：** `examples/connectors/macos-messages-connector.mjs`

让 `send_message` 与 delivery 接受可选 text 和 attachments，至少一项存在；最多 20 个绝对普通文件，单个 250MB、总计 500MB。JXA 依次发送文本和 `Path(file)`，目标解析仍复用 chat/participant 稳定标识。

### 4. Catalog、测试与文档

**涉及文件：** `tests/macos-messages-connector.test.ts`、`mimi.connectors.example.json`、`README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`

合成 SQLite fixture 覆盖真实关联和可选 schema，mock osascript 覆盖路径边界和保存事务，fake JXA 覆盖 text/file send；同步发布目录、权限与不确定多发送语义。

## 权衡与考量

- 不直接解析富文本 typedstream；附件走结构化 attachment 关系。
- 不自动复制轮询到的附件，Event 仍只报告数量；下载/保存必须是显式 action。
- 不修改 Messages 私有数据库，不引入附件缓存或 MIME 层。
- 一次文本加附件发送包含多个系统事务，失败时返回错误但不自动重放已成功部分。

## Todo List

- [x] 实现附件 schema、元数据和稳定查找
- [x] 实现原子 save_attachment
- [x] 实现 send/deliver attachments
- [x] 同步 catalog、测试和文档
- [x] 运行完整 CI 并生成开发记录
