# Mimi Connector 热重载实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-Connector热重载-调研.md]]

## 任务目标

让长期运行的 Mimi 在不重启 Daemon、不打断 Agent 主循环的情况下，显式加载最新 Connector 配置和内置 action catalog。

## 方案概述

保持单个 `ConnectorManager` 对象，由它原位替换内部 Connector Map。新配置先解析验证；旧集合无在途请求时停止并精确注销通知 sink，再安装启动新集合。CLI/RPC 提供一个显式 reload 命令，不增加 watcher、配置数据库或审批层。

## UI 变动检测

涉及 UI 变动：否
变动类型：CLI 与后台逻辑
涉及文件：无前端文件
预览状态：用户要求跳过

## 详细步骤

### 1. 可换代 Connector Manager

**涉及文件：** `src/daemon/connectors.ts`、`src/daemon/notifier.ts`

抽出配置读取/进程构造，Manager 保存 configFile/store/notifier。新增 reload 串行锁和 pending deliver/action busy guard；无效配置不影响旧集合。Notifier 使用 sink 身份条件注销，避免旧 Manager 删除新路由。

### 2. Daemon RPC 与 CLI

**涉及文件：** `src/daemon/service.ts`、`src/daemon/cli.ts`

增加 `connectors.reload`。先执行幂等初始化和 action catalog 升级，再原位 reload，返回 total/enabled/online/capabilities。CLI 支持 `daemon connectors reload`，并为可能包含 5 秒子进程终止兜底使用更长 RPC timeout。

### 3. 生命周期与边界测试

**涉及文件：** `tests/daemon-connectors.test.ts`、`tests/daemon-cli.test.ts`

验证无效配置保持旧进程在线；有效配置刷新 source/action；旧 action 被拒绝、新 action可执行；删除 Connector 后旧通知路由消失；CLI 发出正确 reload RPC。

### 4. 文档与完整回归

**涉及文件：** `README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`

说明显式热重载、在途事务保护和短暂渠道切换窗口，运行专项测试、完整 CI 与发布包 smoke test。

## 权衡与考量

- 显式 reload 比文件 watcher 更可预测，不会因编辑器临时文件或半次修改频繁重启渠道。
- 运行中的 Agent Event 不重建；每次真正调用 action 时仍通过同一 Manager 查找当前 Connector。
- 在途协议请求时拒绝 reload，比强停并猜测事务结果更可靠。
- Connector 进程切换存在一个有界短窗口，但不需要双进程并行和事件重复抑制协议。

## Todo List

- [x] Manager 原位 reload 与 busy guard
- [x] Notifier sink 精确注销
- [x] RPC/CLI reload 入口
- [x] 无效配置、能力刷新、路由清理测试
- [x] 文档、完整 CI 与开发记录
