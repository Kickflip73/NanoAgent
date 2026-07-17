# Mimi 本机初始化与 Doctor 实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi本机初始化与Doctor-调研.md]]

## 任务目标

让 Mimi 首次 `start/run/install` 自动获得可执行的本机 Connector 配置，并能通过一个轻量 Doctor 命令确认真实运行准备度。

## 方案概述

从发布包自带 Connector catalog 物化用户配置：绝对 runtime 路径、绝对 Node executable、平台默认 enabled。只做 create-if-absent，现有文件不修改。Doctor 复用同一 schema 做只读检查并尝试短时 IPC ping。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：不适用

## 详细步骤

### 1. Connector catalog 复用

**涉及文件：** `src/daemon/connectors.ts`

导出已验证配置类型/解析入口，Host 初始化与运行加载使用同一 Zod schema，避免复制协议结构。

### 2. 幂等本机初始化

**涉及文件：** `src/daemon/service.ts`

创建 `initializeMimi`：生成 `0600` connectors.json、assistant.json 和必要目录/数据库；Darwin 默认启用本机 Connector，外部配置型能力保持关闭。使用原子 rename，已有配置绝不覆盖。

### 3. Doctor 与启动接入

**涉及文件：** `src/daemon/service.ts`、`src/daemon/cli.ts`

增加 `daemon init` 和 `daemon doctor`；start/run/install 自动初始化。Doctor 报告 Provider、平台、状态文件、Connector 数量/脚本、launchd 文件和 Daemon IPC，不读取私人内容或触发系统权限。

### 4. 测试与文档

**涉及文件：** `tests/daemon-service.test.ts`、`tests/daemon-cli.test.ts`、`README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`

覆盖首次创建、绝对路径、平台 enable、文件权限、幂等不覆盖、Doctor 缺口和 CLI help，再运行完整 CI。

## 权衡与考量

- 默认启用 macOS 本机能力，符合 owner 默认开放要求；系统权限仍由 macOS 管理。
- 不自动启用需要 Token/额外数据配置的 Daxiang、QQ、Radar 和 File Radar。
- 不探测具体隐私数据库或调用系统 App，避免 Doctor 本身读取真实用户数据。

## Todo List

- [x] 复用 Connector schema/catalog
- [x] 实现幂等 initializeMimi
- [x] 接入 start/run/install、init 和 doctor
- [x] 更新测试和文档
- [x] 运行完整 CI 并生成开发记录
