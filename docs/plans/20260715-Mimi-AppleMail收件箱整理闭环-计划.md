# Mimi Apple Mail 收件箱整理闭环实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-AppleMail收件箱整理闭环-调研.md]]

## 任务目标

让 Mimi 能搜索当前收件箱、理解邮箱目录，并完成旗标、移动和删除邮件的日常整理事务。

## 方案概述

扩展现有 Apple Mail JXA Connector，不增加新进程类型或数据层。JXA 负责系统 Mail 对象读取和事务，Node 负责输入边界；所有能力继续经同一 NDJSON Action Bridge 暴露。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无前端文件
预览状态：用户要求跳过（owner 已明确要求直接编码）

## 详细步骤

### 1. 有界搜索与状态元数据

**涉及文件：** `examples/connectors/macos-mail-connector.mjs`

新增 `search_messages`，在统一收件箱内按 account、sender/subject query、read、flagged 筛选，最多返回 100 条；正文仍按既有上限和显式 `includeBody` 控制。扩展 message metadata，返回 mailbox path、flagged/deleted 状态。

### 2. 邮箱目录

**涉及文件：** `examples/connectors/macos-mail-connector.mjs`

新增 `list_mailboxes`，递归返回最多 200 个 `{account,path,unreadCount}`。移动目标使用最多 20 段的显式路径数组，逐层精确查找并拒绝缺失或歧义。

### 3. 整理事务

**涉及文件：** `examples/connectors/macos-mail-connector.mjs`

新增 `set_flagged`、`move_message`、`delete_message`。旗标支持布尔状态和 0～6 色号；移动要求显式 destinationAccount/destinationPath；删除使用 Mail 原生命令。所有动作按收件箱稳定 message ID 查找，不实现批量 DSL。

### 4. Catalog、测试与文档

**涉及文件：** `tests/macos-mail-connector.test.ts`、`mimi.connectors.example.json`、`README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`

用 mock osascript 验证协议、边界和 hostile 文本 argv；用 fake Mail JXA 对象验证路径递归、搜索筛选、旗标、移动、删除和歧义失败。同步能力目录、架构与真实事务风险。

## 权衡与考量

- 搜索只覆盖统一收件箱，避免读取所有历史邮箱和引入私有索引；已整理邮件可通过明确目录读取能力后续扩展。
- 不硬编码 Archive/归档等本地化名称，先列目录再显式移动。
- 不新增确认或权限等级；稳定 ID、显式 destination 和不确定结果不重放是轻量可靠边界。
- 不实现批量动作，避免一次模型误判扩大影响；Agent 可通过多次 ledgered action 组合。

## Todo List

- [x] 实现 search_messages 与扩展元数据
- [x] 实现 list_mailboxes 与精确路径解析
- [x] 实现 set_flagged/move/delete
- [x] 同步 catalog、测试和文档
- [x] 运行完整 CI 并生成开发记录
