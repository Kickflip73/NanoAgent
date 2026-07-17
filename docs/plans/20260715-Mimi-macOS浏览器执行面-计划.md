# Mimi macOS 浏览器执行面实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-macOS浏览器执行面-调研.md]]

## 任务目标

让 Mimi 复用 Safari/Chrome 的现有登录会话，以结构化动作查询和操作标签页、读取页面正文并执行有界 DOM JavaScript。

## 方案概述

新增一个零依赖、action-only macOS Connector，通过 `/usr/bin/osascript -l JavaScript` 调用浏览器随应用提供的脚本接口。所有动作继续走现有 Action Bridge，不增加浏览器驱动、常驻轮询、审批层、Agent 或工作流。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
预览状态：不适用

## 详细步骤

1. 实现 Safari/Chrome 标签页目录与稳定格式引用。
2. 实现打开、导航、激活、关闭和刷新动作。
3. 实现有界正文提取和 JavaScript 执行，保留外部数据标记。
4. 使用 mock osascript 覆盖协议、注入边界、验证、失败、超时和输出上限。
5. 更新 Connector 示例、架构、安全、README、Changelog、发布包验证和总计划。
6. 运行聚焦测试、完整 CI 与 diff 检查，补充开发记录。

## Todo List

- [x] 实现浏览器 Connector
- [x] 覆盖动作与边界测试
- [x] 更新配置和文档
- [x] 运行完整质量门禁
- [x] 完成 RPI 记录与总计划
