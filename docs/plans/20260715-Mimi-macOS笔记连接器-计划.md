# Mimi macOS 笔记连接器实施计划

日期：2026-07-15  
状态：已完成  
关联调研：[[20260715-Mimi-macOS笔记连接器-调研.md]]

## 任务目标

让 Mimi 可以在 Apple Notes 中查询现有知识，并创建、更新或追加会议纪要、工作记录和生活笔记。

## 方案概述

实现独立 action-only NDJSON Connector，通过 Notes.app JXA 访问用户现有账号和文件夹。Connector 无轮询、无本地镜像、无新增依赖；纯文本写入转义为 HTML，所有输入输出有界。

## UI 变动检测

涉及 UI 变动：否  
变动类型：无  
预览状态：不适用

## 详细步骤

1. 实现 Notes account/folder/note 定位和有界结构化输出。
2. 实现文件夹列表、标题/纯文本搜索和单笔记读取。
3. 实现默认/指定文件夹创建、正文更新与追加。
4. 增加 action payload 校验、plain/html 渲染、密码保护和附件元数据边界。
5. 更新 Connector 示例配置、README、Architecture、Security、Connector 文档与 Changelog。
6. 使用 mock `osascript` 覆盖六个 action、特殊字符、上限和错误返回，并更新 package smoke。
7. 运行完整 CI。

## 权衡与考量

- 不默认轮询 Notes，避免 Agent 写入后形成自触发循环。
- 不创建本地 Notes 索引；需要全文知识库时仍由用户显式导出到现有 RAG。
- 不下载附件或处理嵌入对象，只暴露有界元数据。
- 不实现删除和移动，首版聚焦高频、语义清楚且可稳定验证的记录工作流。

## Todo List

- [x] 实现六个 Notes actions
- [x] 增加正文格式、密码保护和数据上限
- [x] 更新配置与产品文档
- [x] 增加 mock 协议测试和 package smoke
- [x] 运行完整 CI
