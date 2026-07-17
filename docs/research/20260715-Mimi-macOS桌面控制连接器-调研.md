# Mimi macOS 桌面控制连接器调研报告

日期：2026-07-15
状态：已审核

## 调研范围

- 目标：让 Mimi 能感知当前桌面上下文并直接操作未提供专用 API 的 macOS 应用，同时保持 Runtime 和 Daemon 轻量。
- 涉及文件：
  - `examples/connectors/macos-life-connector.mjs`
  - `examples/connectors/macos-shortcuts-connector.mjs`
  - `src/daemon/connectors.ts`
  - `tests/macos-life-connector.test.ts`
  - `tests/macos-shortcuts-connector.test.ts`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`

## 核心发现

### 现状分析

现有 Connector Action Bridge 已能把任意有声明的 action 可靠交给隔离子进程，断线或超时后不会自动重放。Calendar、Mail、Messages、Contacts、Notes 和 Shortcuts 覆盖了常用结构化事务，但 Mimi 仍无法查看当前前台应用/窗口，不能直接激活普通应用、打开本地项目、操作菜单或键盘，也不能按需读写剪贴板。

### 关键流程

macOS 自带 JXA/`osascript` 可通过 System Events 查询 application process、窗口，并执行激活、菜单和键盘动作；Standard Additions 可读写文本剪贴板。`/usr/bin/open` 可用参数数组打开 URL、绝对路径或指定应用。两者都适合留在零依赖 Connector 内，不需要把平台 API 加入 Runtime。

### 现有约束

- 所有 action 参数必须经过有界校验并以 argv/JSON 传递，不能经过 Shell。
- UI、键盘、菜单动作属于真实外部副作用；Action Bridge 超时或断线后必须继续保持“不确定结果不重放”。
- System Events 会要求 macOS Accessibility/Automation 权限；MimiAgent 不叠加审批模型。
- 外部剪贴板内容必须作为事件数据而非系统指令处理。
- 测试不得读取真实剪贴板、真实窗口或操作用户应用。

### 风险与问题

- 持续监听剪贴板可能捕获密码或大段隐私内容，因此默认关闭，并限制事件正文长度。
- Connector 写入剪贴板后若立即产生事件，会造成 Agent 自触发；需要在成功写入时同步更新本地基线。
- 启动时把现有剪贴板当作新事件会制造噪声；首次轮询只建立基线。
- 菜单结构和应用窗口在不同版本间会变化，通用 Connector 只提供窄的一级菜单/菜单项能力，复杂流程继续交给 Shortcuts。
- Unicode 输入、受保护输入框和无障碍未授权会由 macOS 拒绝，Connector 应返回清晰错误而不是模拟成功。

## 与任务相关的关键结论

增加单个 `macos-desktop-connector.mjs` 即可形成通用桌面执行面：上下文、应用、窗口、打开项目、剪贴板、菜单和键盘动作共享一段 JXA 与一个 NDJSON 循环。可选剪贴板轮询只保存进程内 hash，不引入 cursor、数据库或监听框架；中心 Store 仍负责事件可靠性和跨运行去重。该方案与现有 Shortcuts 互补：简单即时 UI 操作用 Desktop Connector，复杂稳定流程由用户已有 Shortcut 承担。
