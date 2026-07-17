# Mimi macOS 生活事务闭环实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-macOS生活事务闭环-调研.md]]

## 任务目标

补齐 Calendar 与 Reminders 的 update/delete，让 Mimi 能完整代办日程和提醒事务。

## 方案概述

只扩展现有 macOS Life Connector 的 action catalog 和 JXA 脚本。按稳定 UID/ID 遍历查找对象，校验有界 payload 后原地修改或调用 Cocoa Standard delete；继续复用 Action Bridge 的不确定结果不重放语义。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：不适用

## 详细步骤

### 1. 统一对象查找与输入校验

**涉及文件：** `examples/connectors/macos-life-connector.mjs`

增加按 calendar/list 可选范围查找稳定 ID 的 helper、日期/文本/优先级校验和非空变更检测。

### 2. Calendar 完整闭环

**涉及文件：** `examples/connectors/macos-life-connector.mjs`

实现标题、起止时间、地点、备注、全天状态修改和 UID 删除。

### 3. Reminders 完整闭环

**涉及文件：** `examples/connectors/macos-life-connector.mjs`

实现标题、到期时间、备注、优先级、完成状态、flagged 修改和 ID 删除；complete 复用统一查找。

### 4. Catalog、测试与文档

**涉及文件：** `mimi.connectors.example.json`、`tests/macos-life-connector.test.ts`、`README.md`、`docs/CONNECTORS.md`、`CHANGELOG.md`

同步四个 action，验证 hostile payload 仍原样走 argv、未知 ID/无变更由实际脚本明确失败，并运行完整 CI。

## 权衡与考量

- 不增加通用 CRUD DSL，动作名称与系统对象一一对应。
- 不自动选择重名日历/提醒；容器名仅用于缩小稳定 ID 搜索。
- 不为 recurrence 建第二套模型，最终语义交给 Calendar.app。
- 不直接测试真实用户数据，协议测试使用 mock 系统命令。

## Todo List

- [x] 增加统一查找和校验 helper
- [x] 实现 Calendar update/delete
- [x] 实现 Reminders update/delete
- [x] 同步 catalog、测试和文档
- [x] 运行完整 CI 并生成开发记录
