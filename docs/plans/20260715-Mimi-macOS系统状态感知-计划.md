# Mimi macOS 系统状态感知实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-macOS系统状态感知-调研.md]]

## 任务目标

让 Mimi 持续获得有界的本机系统快照，并在电池、网络和磁盘状态需要 owner 关注时主动唤醒现有 Agent。

## 方案概述

新增一个零依赖 stdio Connector，复用 Node 内置系统 API和 macOS `pmset`。只保留进程内变化基线，所有跨重启去重仍交给 Mimi Store；Action 与 Event 都沿用现有 Connector 协议。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：不适用

## 详细步骤

### 1. 系统状态 Connector

**涉及文件：** `examples/connectors/macos-system-connector.mjs`

实现有界命令执行、电池解析、内存/负载/网络/磁盘快照、四个只读 action，以及低电量、断网/恢复、低磁盘事件。

### 2. Catalog 与初始化

**涉及文件：** `mimi.connectors.example.json`、`src/daemon/service.ts`

声明系统 Connector action 与环境变量，将其加入 Darwin 默认启用集合，并让 Doctor 静态检查 `pmset`。

### 3. 测试与发布

**涉及文件：** `tests/macos-system-connector.test.ts`、`tests/daemon-service.test.ts`、`tests/package-smoke.mjs`

使用 mock pmset 验证 action、阈值事件、网络初始静默、协议错误、无 Shell 插值和发布包包含关系。

### 4. 文档

**涉及文件：** `README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`

说明采样数据、阈值、默认启用、隐私边界和配置方式。

## 权衡与考量

- 只做系统健康与连接状态，不引入通用监控 DSL。
- 只读 action 不重复已有 Shell 的任意执行能力。
- 默认采样一分钟且只在状态边沿产生事件，保持低 CPU、低噪音。
- 不读取 Wi-Fi SSID、进程列表、浏览历史或文件正文。

## Todo List

- [x] 实现系统快照与 pmset 解析
- [x] 实现有界主动事件
- [x] 接入 catalog、初始化和 Doctor
- [x] 更新测试、文档和发布包检查
- [x] 运行完整 CI 并生成开发记录
