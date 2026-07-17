# Mimi macOS 桌面控制连接器实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-macOS桌面控制连接器-调研.md]]

## 任务目标

提供一个零依赖、隔离的 macOS Desktop Connector，让 Mimi 可以读取桌面上下文、控制普通应用并可选感知剪贴板变化，从“调用专用系统”扩展到“操作任意桌面应用”。

## 方案概述

Connector 通过 JXA/System Events 执行上下文、应用、窗口、剪贴板、菜单和键盘动作，通过 `/usr/bin/open` 打开 URL/绝对路径。所有输入有明确上限并只走 argv。剪贴板轮询默认关闭，开启时首次读取只建立基线，变化以 `ambient` Event 进入现有 Attention；Connector 自己写入时更新基线，防止自触发。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无
预览状态：用户要求跳过

## 详细步骤

### 1. 实现通用桌面 Action

**涉及文件：** `examples/connectors/macos-desktop-connector.mjs`

**修改说明：**

实现 `desktop_context`、`frontmost_app`、`list_apps`、`list_windows`、`activate_app`、`open_item`、`clipboard_read`、`clipboard_write`、`keyboard_type`、`keyboard_key` 和 `click_menu`。查询结果、文本、应用名、菜单名、key code、modifier、窗口数、超时与输出均有界。

**代码片段：**

```javascript
const child = spawn(osascript, ['-l', 'JavaScript', '-e', ACTION_SCRIPT, action, target, JSON.stringify(payload)]);
```

### 2. 实现可选剪贴板事件

**涉及文件：** `examples/connectors/macos-desktop-connector.mjs`

**修改说明：**

用有界 interval 读取文本剪贴板并比较 SHA-256。首次轮询静默建立基线；变化时输出有长度上限的 `ambient` Event；action 写入和清空后同步更新 hash。

### 3. 增加隔离 mock 测试

**涉及文件：** `tests/macos-desktop-connector.test.ts`

**修改说明：**

使用临时 mock `osascript` 和 `open`，验证动作目录、hostile 字符保持 argv 数据、路径与 modifier 校验、剪贴板基线/变化/自写抑制、错误、超时和协议边界，不访问真实桌面数据。

### 4. 同步配置、文档和包内容

**涉及文件：** `mimi.connectors.example.json`、`tests/package-smoke.mjs`、`README.md`、`SECURITY.md`、`docs/ARCHITECTURE.md`、`docs/CONNECTORS.md`、`CHANGELOG.md`

**修改说明：**

增加默认关闭的示例配置，说明 Accessibility/Automation 权限、剪贴板隐私、Action Bridge 不重放语义，并验证发布包包含脚本。

### 5. 完整验证与记录

**涉及文件：** `docs/plans/20260714-Mimi常驻Agent-计划.md`、`docs/sessions/20260715-Mimi-macOS桌面控制连接器-记录.md`

**修改说明：**

运行脚本语法检查、聚焦测试、JSON 校验、类型检查和完整 CI，更新总计划和开发记录。

## 权衡与考量

- 不引入 Playwright、Computer Use 或 AX 包装库；系统 UI 能力保持在一个可替换 Connector 中。
- 只支持一级菜单与菜单项，避免发展成脆弱的 UI 工作流 DSL。
- 剪贴板监听默认关闭；用户需要持续感知时才通过 allowlist 环境变量开启。
- 不声明 UI 动作 exactly-once；继续依靠 Action Bridge 在结果不确定时拒绝自动重放。

## Todo List

- [x] 实现桌面上下文和通用 UI actions
- [x] 实现有界剪贴板事件及自触发抑制
- [x] 增加 mock 端到端测试
- [x] 更新示例配置、文档和包验证
- [x] 运行聚焦验证和完整 CI
- [x] 生成开发记录并更新总计划
