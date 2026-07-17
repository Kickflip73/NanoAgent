# Mimi macOS 快捷指令连接器调研报告

日期：2026-07-15  
状态：已审核（用户已授权直接实施）

## 调研范围

- 目标：把用户已有的 Apple Shortcuts 作为 Mimi 的轻量通用能力总线，覆盖智能家居、应用自动化、文件处理和个人流程。
- 涉及文件：
  - `examples/connectors/macos-shortcuts-connector.mjs`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
  - `tests/macos-shortcuts-connector.test.ts`

## 核心发现

### 现状分析

本机 `/usr/bin/shortcuts` 提供稳定 CLI：`list` 可列出快捷指令或文件夹并显示 identifier；`run` 可按名称或 identifier 执行，接受多个 `--input-path`、可选 `--output-path` 和 Universal Type Identifier `--output-type`。

MimiAgent 已有 Connector Action Bridge、事件级语义副作用台账和“不确定结果不自动重放”边界，因此无需在 Runtime 中实现通用工作流 DSL。一个很小的 Shortcuts Connector 就能复用用户自己维护的自动化，同时保持平台逻辑隔离。

### 关键流程

```text
Mimi decision
  -> connector_action(macos-shortcuts, run_shortcut, shortcut name/id)
  -> /usr/bin/shortcuts run (argv only)
  -> bounded stdout or explicit output path
  -> structured action_result
```

### 现有约束

- Connector 只使用参数数组调用系统 CLI，不经过 Shell。
- `inputPaths` 和 `outputPath` 使用绝对路径；内联 text/base64 输入写入 `0600` 临时文件并在结束后删除。
- stdout、stderr、超时、输入大小、路径数和列表条目数必须有界。
- 输出到文件时不再把文件内容复制进 action result；无输出路径时支持 text 或 base64 返回。
- action 目录是能力发现，不是审批；所有事件默认可调用快捷指令。

### 风险与问题

- 快捷指令可以包含网络、文件、应用控制、智能家居等真实副作用，其权限由 Shortcuts 和 macOS 系统承担。
- Shortcuts 超时或 Connector 断线后可能已经产生副作用，不能自动重放；现有 Action Bridge 已采用该语义。
- CLI 列表输出是面向人的逐行文本，首版保留有界原始条目而不猜测不稳定格式。
- 某些快捷指令会请求前台交互或应用权限；后台 launchd 环境可能失败，错误应原样作为 action error 返回。

## 与任务相关的关键结论

1. 新增无 npm 依赖、无常驻轮询的 `macos-shortcuts` Connector，不修改 Runtime/Daemon 核心。
2. 提供 `list_shortcuts`、`list_folders` 和 `run_shortcut` 三个 action。
3. `run_shortcut` 支持内联 text/base64、现有输入路径、输出路径、输出 UTI、text/base64 stdout 和独立超时。
4. 不实现快捷指令编辑、签名或第二套流程编排；复杂流程继续由 Shortcuts app 自己维护。
