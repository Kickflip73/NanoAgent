# Mimi macOS 生活连接器调研

日期：2026-07-15  
状态：已审核

## 目标

让常驻 Mimi 在不增加核心依赖的前提下，可以查询和创建 macOS 日历/提醒事项、完成提醒事项、发送本机通知，并把即将开始的日程和到期提醒事项转为事件。

## 现状

- Connector Action Bridge 已支持任意子进程声明并执行 action。
- Connector 可主动输出 Event，事件 Store 的 `externalId` 去重可跨进程重启工作。
- macOS 自带 `osascript` 和 Calendar/Reminders/System Events 自动化接口，无需新 npm 包或常驻数据库。

## 设计结论

- 使用单个 stdio Connector 脚本和 JXA（JavaScript for Automation），平台逻辑不进入 Runtime 核心。
- 对外提供 `notify`、`calendar_list`、`calendar_create`、`reminder_list`、`reminder_create`、`reminder_complete` 六个 action。
- 用一个可关闭的低频轮询，把未来时间窗内的日程/提醒输出为 `alert` Event；不在 Connector 内再建状态库。
- 所有参数通过 argv/JSON 传给 `osascript`，不经 Shell 拼接，避免标题和备注变成命令。
- 首次访问时由 macOS 系统弹出自动化/日历/提醒事项权限；MimiAgent 不叠加自己的审批层。

## 边界

- 本阶段不实现邮件、通讯录、付款或 GUI 鼠标自动化。
- 不引入平台通用 DSL；action payload 保持小而明确。
- 系统隐私权限、用户日历中已有数据和 Apple 自动化能力仍是外部约束。
