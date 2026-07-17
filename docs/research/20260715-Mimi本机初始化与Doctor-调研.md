# Mimi 本机初始化与 Doctor 调研报告

日期：2026-07-15
状态：已审核（用户已明确要求直接开发）

## 调研范围

- 目标：让已实现的 Mimi 能力在首次启动时真正接入本机，而不是以 0 Connector 静默运行。
- 涉及文件：
  - `src/daemon/service.ts`
  - `src/daemon/connectors.ts`
  - `src/daemon/cli.ts`
  - `mimi.connectors.example.json`
  - `tests/daemon-service.test.ts`
  - `tests/daemon-cli.test.ts`

## 核心发现

### 现状分析

`ConnectorManager.load` 在配置文件不存在时返回空 Manager，Daemon 随后正常启动并报告 `connectorCount=0`。仓库虽然包含完整 Connector catalog，但文档要求手工复制 JSON、替换每个 `/absolute/path/to/MimiAgent` 并逐项启用。安装包已包含 catalog 和全部脚本，因此这些步骤完全可以确定性完成。

### 关键流程

`startMimiDaemon`、`runMimiDaemon` 和 `installMimiLaunchAgent` 是全部常驻启动入口，均通过 `mimiPaths` 确定用户状态目录。此处可以在创建 Runtime 前执行一次幂等初始化；已有配置必须保持原样。

### 现有约束

- 不把 API Key、Token 或真实用户数据写入生成文件。
- macOS 本机 Connector 使用系统应用和当前登录态；凭证型 Daxiang/QQ、Radar/File Radar 仍需 owner 配置外部参数。
- launchd 的 PATH 较窄，Connector command 应使用当前 `process.execPath`，脚本应使用安装包绝对路径。
- 系统隐私授权属于 macOS 边界，不再建立 MimiAgent 审批模型。
- 单元测试不能触发真实权限提示、启动真实 Connector 或访问用户状态。

### 风险与问题

- 覆盖已有 `connectors.json` 会破坏 owner 定制，初始化必须只在文件不存在时创建。
- 在非 macOS 平台启用 macOS Connector 会产生重启噪音，因此只在 Darwin 默认启用。
- Doctor 若主动调用 Calendar/Screen/Microphone 会触发系统授权和真实数据读取；应只检查文件、脚本、平台、Provider 配置与 Daemon 可达性。

## 与任务相关的关键结论

复用发布包中的 `mimi.connectors.example.json` 作为唯一 catalog，解析后将 Node command 固定为 `process.execPath`、脚本占位根目录替换为实际 runtime root，并在 macOS 默认启用本机 life/mail/messages/contacts/notes/shortcuts/desktop/browser/screen/voice。`start/run/install` 自动调用；`daemon init` 显式展示结果但保持幂等。`daemon doctor` 只输出结构化就绪度与 next actions。无需新依赖、安装器框架或权限状态数据库。
