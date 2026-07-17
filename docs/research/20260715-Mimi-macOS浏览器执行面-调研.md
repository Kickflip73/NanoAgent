# Mimi macOS 浏览器执行面调研

日期：2026-07-15
状态：已完成

## 目标与现状

MimiAgent 已有 HTTP、桌面键鼠和 Shortcuts 能力，但 HTTP 不继承用户浏览器的登录会话，桌面控制也无法稳定取得标签页、URL 和正文。工作事务经常发生在已登录的网页中，因此仍缺少一个轻量、结构化的浏览器执行面。

## 本机能力核验

- Safari 随应用安装的 `Safari.sdef` 定义了 window/current tab、tab 的 name/URL/index/text/visible，以及 `do JavaScript` 和 close。
- Google Chrome 随应用安装的 `scripting.sdef` 定义了 window/tabs/active tab index、tab 的 id/title/URL/loading，以及 execute/reload/close。
- 两者都可由系统 JXA 通过 argv JSON 调用，不需要 Playwright、WebDriver、扩展或新增 npm 依赖。

## 方案选择

新增 action-only `macos-browser` Connector，直接使用 Safari/Chrome 当前 profile 和登录态。提供标签页目录、打开、导航、激活、关闭、刷新、正文提取和受控 JavaScript 执行。继续复用 Connector Action Bridge 的进程隔离、动作目录、超时和不自动重放语义。

## 边界

- 不轮询浏览历史或页面正文，不建立浏览数据镜像。
- 标签页引用使用 `safari:<window>:<tab>` / `chrome:<window>:<tab>` 的当前索引；页面变化后应重新查询。
- URL、脚本和 payload 只通过 argv JSON 传递，不经过 Shell。
- 页面正文和脚本结果是外部不可信数据；Connector 只做有界返回，不把内容解释为指令。
- JavaScript 执行可能需要浏览器允许来自 Apple Events 的 JavaScript；系统 Automation 权限由 macOS 管理，MimiAgent 不叠加审批。

## 结论

基于浏览器原生脚本字典实现能补齐已登录网页事务，同时保持单文件、零依赖、action-only 的轻量架构。复杂稳定流程仍可沉淀为 Shortcut；这里提供通用即时执行面。
