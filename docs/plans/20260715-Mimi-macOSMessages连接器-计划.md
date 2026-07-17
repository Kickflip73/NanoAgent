# Mimi macOS Messages 连接器实施计划

日期：2026-07-15  
状态：已完成  
关联调研：[[20260715-Mimi-macOSMessages连接器-调研.md]]

## 任务目标

让 Mimi 持续感知 iMessage/SMS/RCS，保持会话上下文，并可查询或主动发送。

## 方案概述

Connector 每次以只读 SQLite 快照查询最新入站行，归一化 Apple epoch 时间、handle 和 chat 路由，输出 `command` Event。查询 action 复用同一只读边界；发送使用 Messages JXA 的 chat/participant `send`。

## UI 变动检测

涉及 UI 变动：否  
变动类型：无  
预览状态：不适用

## 详细步骤

1. 实现 `chat.db` 只读打开、schema 校验、时间归一化和查询。
2. 实现有界入站轮询和稳定 Event/Session/reply route。
3. 实现 `list_chats`、`recent_messages`、`send_message` 与 delivery。
4. 增加 Connector 配置、Full Disk Access 文档、README、Architecture 和打包检查。
5. 用临时 SQLite fixture + mock `osascript` 覆盖入站、查询、发送、delivery、schema 失败和参数边界。
6. 运行完整 CI。

## 权衡与考量

- 不修改私有数据库，不尝试通过 SQLite 发消息。
- 不解码私有 `attributedBody` typedstream，空文本明确降级为占位。
- 不持久化第二份 cursor/seen set，去重仍由 Mimi Store 负责。
- 不绕过 macOS TCC，只在文档中说明实际运行进程需要 Full Disk Access。

## Todo List

- [x] 实现只读 DB 边界和 schema 校验
- [x] 实现轮询 Event 和去重身份
- [x] 实现三个 action 和 delivery
- [x] 更新配置、文档和打包
- [x] 增加 fixture/mock 端到端测试
- [x] 运行完整 CI
