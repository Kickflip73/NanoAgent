# Mimi macOS 邮件连接器实施计划

日期：2026-07-15  
状态：已完成  
关联调研：[[20260715-Mimi-macOS邮件连接器-调研.md]]

## 任务目标

以零额外依赖方式把 Apple Mail 变成 Mimi 的持续邮件入站和主动事务边界。

## 方案概述

复用 macOS Connector 的 JXA argv 模式。轮询脚本只返回有界未读邮件摘要；action 脚本封装单封查找、新邮件、回复、已读状态和草稿。Connector 负责 NDJSON、参数校验、超时和事件转换，Mail 负责账号同步和发件。

## UI 变动检测

涉及 UI 变动：否  
变动类型：无  
预览状态：不适用

## 详细步骤

1. 实现 Apple Mail JXA action 和收件箱未读轮询。
2. 在 Node Connector 层校验邮箱、标题、正文、cc/bcc 和限制。
3. 输出稳定 `ambient` 邮件 Event，不设置自动 reply route。
4. 增加 Connector 目录配置、协议文档、README、Architecture 和打包检查。
5. 使用 mock `osascript` 验证轮询、六个 action、delivery、未知 action 和 Shell 边界。
6. 运行完整 CI。

## 权衡与考量

- 不实现 IMAP/SMTP，因为用户电脑已有 Mail 账号与 Keychain，重复实现会带来依赖、凭证和协议复杂度。
- 不支持附件写入，避免首版引入路径、MIME 和大文件边界；附件可在后续以独立 action 增加。
- 不用邮件入站的默认 Outbox 回传，避免把 Agent 的处理结果等同于给发件人回信。

## Todo List

- [x] 实现轮询与邮件 Event
- [x] 实现六个 action 和 delivery
- [x] 增加配置与文档
- [x] 增加 mock 端到端测试
- [x] 运行完整 CI

## 完成摘要

- 新增零 npm 依赖 Apple Mail Connector，账号和密码仍由 Mail/Keychain 管理。
- 未读邮件作为无自动回复路由的 `ambient` Event，支持稳定去重和会话路由。
- 六个 action、显式 delivery、参数限制和无 Shell 拼接边界通过端到端 mock 验证。
- 完整 CI 通过：206 项测试，lines 85.56% / branches 77.06% / functions 80.52%，构建和 npm 打包通过。
