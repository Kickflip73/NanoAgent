# Mimi macOS 语音交互实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-macOS语音交互-调研.md]]

## 任务目标

让 owner 可以用唤醒短语直接向长期运行的 Mimi 下达语音命令，并让 Mimi 能朗读结果、查询系统声音及转写音频文件。

## 方案概述

新增 action + event 双向 `macos-voice` Connector。Swift helper 使用 Speech/AVFoundation 完成分段麦克风识别和文件转写；Node 只负责 wake phrase、事件、去重、进程生命周期、`say` action 和协议限制。继续复用 Connector Host，不修改 Runtime 或 Attention。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：不适用

## 详细步骤

### 1. 原生语音识别 helper

**涉及文件：** `examples/connectors/macos-voice-recognizer.swift`

实现 `transcribe` 与 `listen` 两种模式；支持 locale、on-device、最长分段和正文上限，输出逐行 JSON，不保存麦克风音频。

### 2. Voice Connector

**涉及文件：** `examples/connectors/macos-voice-connector.mjs`

实现可配置 listener、wake phrase 前缀提取、短期重复抑制、高优先级 owner command Event，以及 `speak`、`list_voices`、`transcribe_audio`、`listener_status/start/stop/restart` actions。朗读时暂停并恢复 listener。

### 3. 协议与生命周期测试

**涉及文件：** `tests/macos-voice-connector.test.ts`

覆盖非唤醒内容过滤、多语言唤醒、重复抑制、朗读回声抑制、listener 控制、音频路径/文本/locale 边界、子进程失败和超时；真实 Swift helper 运行 typecheck。

### 4. 配置、发布包和文档

**涉及文件：** `mimi.connectors.example.json`、`README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`、`tests/package-smoke.mjs`

补充系统权限、隐私、on-device 限制、默认关闭和 Action Bridge 语义，更新总计划第十八阶段。

## 权衡与考量

- 使用短分段而非无限实时音频流，能在进程崩溃、权限失败和资源占用之间保持清晰边界。
- wake phrase 在 Connector 确定性过滤，不为环境语音启动模型。
- 不保存音频、不接云端 SDK；Speech Framework 是否联网由 `onDevice` 与系统 locale 能力决定。

## Todo List

- [x] 实现并 typecheck Swift 识别 helper
- [x] 实现持续唤醒、语音输出和转写 actions
- [x] 覆盖协议、回声抑制、去重和失败测试
- [x] 更新示例、文档和发布包检查
- [x] 运行完整 CI 并生成开发记录
