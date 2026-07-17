# Mimi Connector 热重载调研报告

日期：2026-07-15
状态：已审核（owner 已明确要求按设计持续实施）

## 调研范围

- 目标：让长期运行的 Mimi 在不重启 Daemon 的情况下启用、停用和更新 Connector。
- 涉及文件：
  - `src/daemon/connectors.ts`
  - `src/daemon/notifier.ts`
  - `src/daemon/service.ts`
  - `src/daemon/cli.ts`
  - `src/daemon/dispatcher.ts`
  - `tests/daemon-connectors.test.ts`
  - `tests/daemon-cli.test.ts`

## 核心发现

### 现状分析

Daemon 只在启动时调用一次 `ConnectorManager.load()`。`connectors.json` 后续即使被 owner 修改，运行进程中的子进程集合、通知 sink 和 action 能力都不会变化。CLI 的 `daemon connectors` 只能查看状态，唯一重载入口是 Attention 配置。

这意味着新增凭证后启用大象/QQ、临时关闭持续监听能力、修改环境白名单、升级 action catalog，均要求重启整个 Daemon。重启会中断当前 Agent Event，和“长期在线可靠助手”的目标冲突。

### 关键对象关系

- `ConnectorManager` 被 Dispatcher 长期持有，但 `createConnectorActionTool()` 在每个 Event 开始执行时重新读取 Manager 的能力，因此 Manager 只要原位换代内部 Map，新 Event 会自然获得新目录。
- `NotifierRegistry` 以 `connector:<id>` 保存 sink。现有接口只有 register；热重载删除 Connector 时若不精确 unregister，旧停止进程仍会占住路由，使 Outbox 永久投递到离线对象。
- `ConnectorProcess.stop()` 会拒绝在途 deliver/action。显式重载不应在有在途协议请求时破坏不确定外部事务，因此 Manager 需要一个轻量 busy guard。
- 配置 schema 校验和子进程构造不需要启动进程，可以在停止旧集合前完成。无效 JSON/schema 必须保持旧运行集合不变。

### 可靠性边界

- 重载由显式 CLI/RPC 触发，不增加文件 watcher、debounce、配置版本表或后台协调器。
- 先完整读取并校验新配置，再检查旧集合无在途请求，最后停止旧进程、精确注销旧 sink、安装并启动新集合。
- 同一 Manager 实例原位换代，Dispatcher、action tool execute 闭包和 status RPC 不需要重建。
- reload 串行化；并发 reload 或在途 Connector 请求时快速失败，owner 可稍后重试，不自动中断真实事务。
- `initializeMimi()` 在 reload 前继续补齐内置 action catalog，使软件升级和运行时换代形成一个入口。

## 与任务相关的关键结论

最轻量可靠方案是给 `ConnectorManager` 增加显式 `reload()`，并给 `NotifierRegistry` 增加带 sink 身份校验的 `unregister()`。通过 `mimi daemon connectors reload` 调用同一个 Unix Socket RPC；不修改数据库、不新建服务、不引入权限审批，也不自动监视配置文件。
