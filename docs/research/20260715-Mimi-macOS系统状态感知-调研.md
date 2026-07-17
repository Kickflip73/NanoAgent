# Mimi macOS 系统状态感知调研报告

日期：2026-07-15
状态：已审核（用户已明确要求直接开发）

## 调研范围

- 目标：让长期运行的 Mimi 主动理解电脑自身状态，并在低电量、断网和磁盘空间不足等关键时刻进入现有事件链路。
- 涉及文件：
  - `examples/connectors/macos-life-connector.mjs`
  - `examples/connectors/macos-desktop-connector.mjs`
  - `src/daemon/connectors.ts`
  - `src/daemon/service.ts`
  - `mimi.connectors.example.json`
  - `tests/macos-life-connector.test.ts`

## 核心发现

### 现状分析

Mimi 已能感知日历、提醒事项、邮件、消息、文件、剪贴板、语音和外部 Radar，但没有电脑自身健康状态来源。Runtime 虽然可用 Shell 临时查询系统，只有 Agent 已经被其他事件唤醒时才会执行，无法在低电量、网络中断或磁盘不足时主动通知 owner。

### 关键流程

现有 Connector NDJSON 协议已经同时支持主动 Event 与按需 Action。系统状态适合做一个独立、无状态的本机 Connector：Node 内置 `os` 和 `fs.statfs` 提供内存、负载、网络接口和磁盘容量，macOS 自带 `pmset -g batt` 提供电池与供电状态。阈值变化生成普通 `alert/ambient` Event，由中心 Store 去重并继续经过 Attention、Agent 和 Outbox。

### 现有约束

- 不把轮询器、系统命令或平台字段塞入 Runtime。
- 不新增依赖、数据库表、权限审批或第二套告警系统。
- 子进程命令必须使用 argv，不经 Shell；输出、超时和事件频率必须有界。
- 初次网络快照只建立基线，不把 Daemon 启动误报为网络变化。
- 测试不能依赖真实电池、网络状态或用户数据。

### 风险与问题

- 高频系统采样会制造事件噪音；只在阈值 band 或网络 online 状态变化时生成 Event。
- Connector 重启可能重复低资源告警；外部 ID 使用本地日期与阈值 band，中心 Store 跨重启去重。
- 台式 Mac 没有电池；`pmset` 无电池结果应作为 `available:false`，不能导致 Connector 崩溃。
- catalog 目前还存在重复 `create_contact` JSON key，应在继续复用 catalog 前清理。

## 与任务相关的关键结论

新增一个 `macos-system` Connector 即可补齐主动系统感知，无需扩展 Daemon 核心。它提供 `system_snapshot`、`battery_status`、`network_status`、`storage_status` 四个只读 action，并默认每分钟采样：低/危急电量、离线/恢复、低磁盘空间才产生 Event。Connector 作为第十一个默认本机能力进入首次初始化；Doctor 只检查 `pmset` 是否存在，不执行真实状态读取。
