# Mimi Apple Mail 附件闭环实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-AppleMail附件闭环-调研.md]]

## 任务目标

让 Mimi 能列出/保存收到的附件，并在发送、草稿和回复中附加本地文件。

## 方案概述

扩展现有 Mail JXA 与 Node Connector 边界。JXA 只负责 Mail 对象操作，Node 负责绝对路径、普通文件、大小、覆盖策略与原子落盘；继续使用现有 NDJSON Action Bridge。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：不适用

## 详细步骤

### 1. Incoming 附件目录

**涉及文件：** `examples/connectors/macos-mail-connector.mjs`

为 messageInfo 增加最多 50 项附件元数据，实现稳定 attachment ID 查找和 `list_attachments`。

### 2. 原子保存附件

**涉及文件：** `examples/connectors/macos-mail-connector.mjs`

实现 `save_attachment`：显式绝对 outputPath、同目录随机临时文件、0600、默认 hard-link no-clobber、显式 overwrite 时 atomic rename、全终态清理。

### 3. Outgoing 附件

**涉及文件：** `examples/connectors/macos-mail-connector.mjs`

send/create_draft/reply 接受最多 20 个绝对普通文件，单文件 25MB、总计 50MB，并由 JXA 加入 outgoing rich text attachments。

### 4. Catalog、测试与文档

**涉及文件：** `mimi.connectors.example.json`、`tests/macos-mail-connector.test.ts`、`README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`

使用 mock osascript 和 fake Mail JXA 验证元数据、保存提交、no-clobber、发送路径边界、argv-only 与发布兼容。

## 权衡与考量

- 不自动下载轮询事件中的附件，只暴露元数据；保存必须是显式 action。
- 不信任附件名，不提供“保存到 Downloads 并自动命名”的隐式行为。
- 不把附件内容塞入 NDJSON；保存为文件后复用现有文件/PDF/文档能力。
- 不扩展 Mail 搜索范围或实现邮箱同步缓存。

## Todo List

- [x] 实现附件元数据与稳定 ID 查找
- [x] 实现原子 save_attachment
- [x] 实现 send/draft/reply attachments
- [x] 同步 catalog、测试和文档
- [x] 运行完整 CI 并生成开发记录
