# Mimi macOS 快捷指令连接器实施计划

日期：2026-07-15  
状态：已完成  
关联调研：[[20260715-Mimi-macOS快捷指令连接器-调研.md]]

## 任务目标

让 Mimi 能发现并运行用户已有的 Apple Shortcuts，以一个轻量系统接口扩展工作、生活、应用和智能家居自动化能力。

## 方案概述

实现独立 action-only NDJSON Connector，直接 spawn `/usr/bin/shortcuts`。Connector 不解析或编排 Shortcut 内部步骤，只负责有界目录查询、输入准备、执行、输出归一化和清理。

## UI 变动检测

涉及 UI 变动：否  
变动类型：无  
预览状态：不适用

## 详细步骤

1. 实现系统 shortcuts CLI 的参数数组执行器、超时、输出上限和结构化错误。
2. 实现 `list_shortcuts`、`list_folders` 目录 actions。
3. 实现 `run_shortcut` 的内联 text/base64、多个输入路径、输出路径、UTI 和输出编码。
4. 使用 `0600` 临时输入文件并在成功、失败和超时后清理。
5. 更新 Connector 配置、README、Architecture、Security、Connector 文档与 Changelog。
6. 用 mock CLI 覆盖 argv、二进制输出、路径、特殊字符、失败、超时和临时文件清理，并更新 package smoke。
7. 运行完整 CI。

## 权衡与考量

- 不实现通用工作流 DSL，Shortcut 内部流程继续由系统 app 管理。
- 不解析 `list --show-identifiers` 的不稳定展示格式，只返回逐行条目。
- 不自动重试运行失败或超时的快捷指令，避免重复真实副作用。
- 不默认保存 stdout 到持久文件；只有显式 `outputPath` 才写入指定位置。

## Todo List

- [x] 实现三个 Shortcuts actions
- [x] 增加输入输出、超时和临时文件边界
- [x] 更新配置与产品文档
- [x] 增加 mock CLI 测试和 package smoke
- [x] 运行完整 CI
