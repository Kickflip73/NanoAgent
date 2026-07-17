# Mimi macOS 屏幕感知实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-macOS屏幕感知-调研.md]]

## 任务目标

让 Mimi 能保存有界屏幕截图、对现有图片做本地 OCR，并在不保留临时画面的情况下读取当前屏幕或窗口文字。

## 方案概述

新增 action-only Node Connector，使用参数数组调用系统 `screencapture` 和 Swift Vision helper。Node 负责协议、路径、target、临时文件、超时和输出限制；Swift helper 只负责单张图片的文字识别和结构化 JSON 输出。继续复用 Connector Action Bridge，不修改 Runtime。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：不适用

## 详细步骤

### 1. 实现截图与临时生命周期

**涉及文件：** `examples/connectors/macos-screen-connector.mjs`

支持 `all`、`main`、`display:N`、`window:ID`、`rect:X,Y,W,H` target；`capture_screen` 保存到显式绝对 PNG 路径，`read_screen` 使用受限临时目录并始终清理。

### 2. 实现本机 OCR helper

**涉及文件：** `examples/connectors/macos-screen-ocr.swift`

使用 `VNRecognizeTextRequest` 返回有界 text、line、confidence 和 normalized bounding box；支持 fast/accurate 以及最多十种识别语言。

### 3. 验证协议和边界

**涉及文件：** `tests/macos-screen-connector.test.ts`

用 mock 系统命令覆盖参数数组、临时文件清理、路径和 target 校验、输出限制、失败与超时；用 `swiftc -typecheck` 验证真实 helper 能编译。

### 4. 同步配置与文档

**涉及文件：** `mimi.connectors.example.json`、`README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`SECURITY.md`、`CHANGELOG.md`、`tests/package-smoke.mjs`

记录动作、系统权限、隐私边界、发布包内容和总计划第十七阶段。

## 权衡与考量

- 不持续截屏或监听屏幕变化，避免隐私风险、资源消耗和自触发循环。
- 不把 Vision 或截图逻辑放入 Runtime，保持平台能力可替换和进程隔离。
- 不输出原图 base64；需要视觉模型时保存到显式路径，普通判断优先使用本地 OCR 文本。

## Todo List

- [x] 实现截图 Connector
- [x] 实现并 typecheck Vision OCR helper
- [x] 覆盖协议和失败边界测试
- [x] 更新配置、文档和发布包检查
- [x] 运行完整 CI 并生成会话记录
