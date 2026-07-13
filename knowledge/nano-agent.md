# NanoAgent

NanoAgent 是一个使用 TypeScript 和 OpenAI Agents SDK 构建的轻量级通用 Agent。

它面向真实工作提供 Agent Loop、多模型、工具调用、Token-aware 上下文、持久会话、长期记忆、NANO.md 持久指令、Agent Skills、MCP、本地 RAG、Goal/Resume 和受控 SubAgent。NanoAgent 刻意不实现消息网关、任意深度多 Agent 图、复杂权限平台和分布式任务。

安装后可以通过 `nano` 启动交互模式，也可以用 `nano "任务"` 执行单次任务。CLI 提供会话、状态、Skill、MCP、Memory、Plan、Goal、索引和恢复命令；相同运行时能力也作为工具提供给 Agent。能力覆盖文件与 Shell、自身源码修改、网络检索、知识、外部 MCP 系统和独立研究/审查子任务。

## 核心原则

- 单个主 Agent、单进程、本地优先。
- 每个模块只承担一个清晰职责。
- 运行数据保存在本地 `.nano-agent` 目录。
- OpenAI Agents SDK 负责模型运行循环，NanoAgent 负责上下文与能力组织。
