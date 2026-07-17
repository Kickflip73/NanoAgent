# Mimi macOS 生活事务闭环调研报告

日期：2026-07-15
状态：已审核（用户已明确要求直接开发）

## 调研范围

- 目标：让 Mimi 不仅能创建日程和提醒，也能代表 owner 改期、修改、完成、取消和删除。
- 涉及文件：
  - `examples/connectors/macos-life-connector.mjs`
  - `tests/macos-life-connector.test.ts`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
- 本机权威定义：
  - `/System/Applications/Calendar.app/Contents/Resources/iCal.sdef`
  - `/System/Applications/Reminders.app/Contents/Resources/Reminders.sdef`

## 核心发现

### 现状分析

Life Connector 已提供 Calendar list/create 和 Reminders list/create/complete，但没有修改与删除。Agent 可以答应“把会议改到下午”或“取消这个提醒”，却缺少实际执行 action，无法形成事务闭环。

### 关键流程

Connector 已通过单个 JXA `ACTION_SCRIPT` 处理全部 Calendar/Reminders action，并把 JSON payload 作为 argv 传递。新增动作只需复用现有 calendar/list 遍历与稳定 UID/ID，不需要改变 Daemon、Runtime、Action Bridge 或 Store。

### 现有约束

- Calendar 字典确认 event 的 `description/start date/end date/allday event/summary/location` 可写，`uid` 只读。
- Reminders 字典确认 reminder 的 `name/body/completed/due date/priority/flagged` 可写，`id` 只读。
- 两个应用都引入 Cocoa Standard Suite，支持标准 delete command。
- 输入继续使用 JSON argv，不经 Shell；删除和更新属于不确定外部事务，Host 超时后不自动重放。
- 测试不能修改真实用户 Calendar 或 Reminders，只能用 mock osascript 验证协议和参数边界。

### 风险与问题

- UID/ID 找不到必须明确失败，不能静默成功或选择模糊候选。
- 同一 UID 搜索可用可选 calendar/list 缩小范围；默认跨全部容器查找。
- 更新 payload 为空应拒绝，避免把“没有改变任何字段”误报成成功。
- Calendar 起止时间和 Reminder dueAt 必须验证为有效日期；priority 限制为系统字典的 0～9。
- Calendar recurrence occurrence 的具体删除语义由系统应用决定，Connector 不自建 recurrence DSL。

## 与任务相关的关键结论

在现有 Life Connector 增加 `calendar_update`、`calendar_delete`、`reminder_update`、`reminder_delete` 四个 action 是最小且完整的方案。返回修改后的结构化对象或明确 deleted 结果；`reminder_complete` 保留为高频便利动作，并复用相同查找 helper。无需新依赖、权限层、持久状态或工作流。
