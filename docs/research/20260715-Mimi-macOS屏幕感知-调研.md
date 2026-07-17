# Mimi macOS 屏幕感知调研报告

日期：2026-07-15
状态：已审核

## 调研范围

- 目标：让 Mimi 在纯文本页面接口不可用时理解当前屏幕或窗口内容。
- 涉及现有能力：macOS Desktop Connector、Browser Connector、Shortcuts Connector、Connector Action Bridge。
- 本机原生能力：`/usr/sbin/screencapture`、Swift 6、Vision Framework。

## 核心发现

### 现状分析

Desktop Connector 能查询窗口并操作键鼠，但看不到窗口内容；Browser Connector 能读取网页 DOM，但无法覆盖原生应用、画布、远程桌面和不可访问 DOM。Runtime 没有必要承担屏幕 API 或图像识别实现，独立 Connector 更符合现有边界。

### 关键流程

macOS `screencapture` 原生支持全屏、主屏、指定 display、window ID 和矩形区域，并能静默保存 PNG。Vision 的 `VNRecognizeTextRequest` 可在本机完成 OCR，不发送图片到外部服务。两者都能通过参数数组调用，无需 shell、npm 包或浏览器驱动。

### 现有约束

- Connector action 必须有界、argv-only，超时后的不确定副作用不自动重放。
- 截图和 OCR 可能包含密码、消息和私人数据，必须显式调用，不建立轮询或历史库。
- 临时截图应使用 `0700` 临时目录并在成功、失败和超时后删除。
- OCR 结果属于外部不可信数据，不能被提升为系统指令。

### 风险与问题

- 首次截图需要 macOS Screen Recording 权限，LaunchAgent 与 Terminal 的系统授权主体可能不同。
- OCR 对小字体、低对比度、图标和非文本 UI 不保证完整；坐标仅用于辅助判断。
- 指定 window/display 的系统 ID 会变化，调用方应从当前桌面上下文获取后即时使用。

## 与任务相关的关键结论

新增一个 action-only `macos-screen` Connector 和一份很小的 Swift Vision helper，可以补齐通用屏幕文字感知，同时保持 Runtime 不变、零新增依赖、无持续录屏和无图片持久状态。动作应限定为 `capture_screen`、`ocr_image`、`read_screen` 三个，避免发展成第二套视觉工作流。
