# Mimi macOS 生活连接器实施计划

日期：2026-07-15  
状态：已完成  
关联调研：[[20260715-Mimi-macOS生活连接器-调研.md]]

## UI 变动检测

涉及 UI 变动：否  
变动类型：无  
预览状态：不适用

## 实施步骤

1. 实现无依赖 macOS stdio Connector 和 6 个 action。
2. 增加可配置的日程/提醒轮询 Event，复用 Store 去重。
3. 增加示例配置、安装包文件和使用文档。
4. 使用 mock `osascript` 进行协议、参数和 Event 测试。
5. 运行完整 CI 和产物冒烟。

## Todo List

- [x] 实现 Connector action
- [x] 实现轮询 Event
- [x] 更新配置、文档和打包
- [x] 增加自动测试
- [x] 完成全量验证

## 完成摘要

- 新增单文件、无 npm 依赖的 macOS 生活 Connector，复用现有 NDJSON 协议和 Action Bridge。
- 日历、提醒事项、通知六个 action 以及主动事件轮询已实现。
- `npm run ci` 通过：204 项测试，lines 85.56% / branches 77.06% / functions 80.52%。
- npm 产物已确认包含大象、QQ 和 macOS 三个 Connector 示例。
