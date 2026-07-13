# NanoAgent

NanoAgent 是一个使用 TypeScript 和 OpenAI Agents SDK 构建的轻量级 Agent 学习项目。

它用少量代码展示 Agent Loop、多模型、工具调用、上下文管理、持久会话、长期记忆、Skill、MCP 和本地 RAG。NanoAgent 刻意不实现多 Agent、网关、复杂权限系统和分布式任务。

## 核心原则

- 单 Agent、单进程、CLI 优先。
- 每个模块只解释一个 Agent 核心概念。
- 运行数据保存在本地 `.nano-agent` 目录。
- OpenAI Agents SDK 负责模型运行循环，NanoAgent 负责上下文与能力组织。
