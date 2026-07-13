# NanoAgent Architecture

NanoAgent 是轻量级通用 Agent：面向真实文件、命令、检索、知识与外部系统任务，同时保持单进程、本地优先和可直接阅读的运行内核。

## 设计原则

- OpenAI Agents SDK 负责模型循环、Tool、MCP 和 Agent-as-tool 协议。
- 主 Agent 始终拥有会话与最终回答，SubAgent 只处理有边界的独立子任务。
- 会话切换后由 CLI 从持久 Session 重建用户/助手对话视图，工具明细仍只保留在 Session 与 Trace 中。
- JSON/JSONL 负责本地持久化，不引入数据库、消息队列或 ORM。
- `runtime` 负责组装，`core` 保存状态，`extensions` 提供能力，CLI 只负责交互。
- OpenAI 与 DeepSeek 共用同一能力层，避免绑定单一 Provider 的服务端状态。
- 优先扩展 Skill 和 MCP，不持续堆叠内置 Tool。

## 模块边界

```text
CLI
├── index.ts             调度、队列和流消费
├── commands.ts          运行时命令
├── interactive.ts       输入、选择器和状态栏
├── terminal.ts          事件渲染
└── runtime/
    ├── nano-agent.ts    组合根与一轮运行
    ├── model.ts         OpenAI / DeepSeek 模型工厂
    ├── instructions.ts  基础指令与模式
    ├── control.ts       Agent 可调用的运行时控制与延迟 Effects
    └── hooks.ts         生命周期事件总线
        ├── core/
        │   ├── context.ts  Token Budget 与动态上下文
        │   ├── guidance.ts 用户级/项目级 NANO.md
        │   ├── session.ts  Agents SDK Session
        │   ├── memory.ts   跨会话记忆
        │   ├── plan.ts     Plan / Goal / Checkpoint
        │   └── trace.ts    JSONL Trace
        ├── extensions/
        │   ├── skills.ts    Agent Skills
        │   ├── mcp.ts       MCP Client 与生命周期
        │   ├── rag.ts       本地混合检索
        │   └── subagents.ts 单层 Agent-as-tool
        └── tools.ts         高频本地原子工具
```

`src/agent.ts` 仅保留兼容导出，业务实现位于 `runtime/nano-agent.ts`。

## 一轮请求

```text
1. CLI 记录用户输入并创建 AbortSignal
2. Session 修复中断留下的孤立 Tool Call
3. NANO.md、Memory、RAG、Plan、Goal、Session 并行读取
4. ContextManager 按 Token Budget 选择近期完整轮次
5. 持久指令、较早历史、Skill Catalog、Memory、RAG、Goal 被组装为动态 Instructions
6. 主 Agent 获得本地 Tools、MCP Tools/Resources 和两个受控 SubAgent Tools
7. Runner 流式执行，TerminalRenderer 分级展示事件
8. SDK 追加完整 Session，HookBus 记录生命周期 Trace
9. 当前回答完成后应用模型请求的 Session、输出或退出 Effects
```

## 上下文不变量

历史裁剪同时遵守 `HISTORY_LIMIT` 与上下文窗口预算，并从用户消息边界开始。以下协议单元不能被拆开：

```text
user → function_call → function_call_result → assistant
```

较早历史被提取为紧凑的用户、助手、工具调用和工具结果摘要，只进入本轮 Instructions；完整原始 Session 不会被覆盖，也不会持久化伪用户摘要。

## NANO.md 持久指令

`GuidanceLoader` 在每轮开始时读取 `~/.nano-agent/NANO.md` 和 `<workspace>/NANO.md`。项目文件是团队共享的具体约定，优先于用户文件中的全局个人偏好。两者作为动态 Instructions 进入同一 Token Budget，单文件最多注入 20000 字符；不存在或为空时不占上下文。SubAgent 继承相同内容，但不能借此突破自身只读工具与职责边界。

## Plan 与 Goal

Plan 表示当前任务的步骤视图，Goal 表示跨多轮、跨重启的生命周期：

```text
Goal
├── objective
├── status: active | paused | completed | failed
├── checkpoint
├── nextAction
└── PlanStep[]
```

两者按 Session 保存在同一个 `plans.json`。旧版本的纯 Plan 数组会在读取时自动迁移。`/resume` 只根据持久状态生成下一轮输入，不启动后台守护进程，因此长任务仍然可观察、可中断。

## Agent Skills

SkillLoader 实现开放 Agent Skills 格式的最小完整客户端流程：

1. 扫描 `skills/*/SKILL.md`。
2. 用 YAML Parser 和 Schema 校验 `name`、`description`。
3. 只把名称、描述和绝对位置放入初始上下文。
4. 模型调用 `use_skill` 激活完整说明。
5. 模型调用 `read_skill_resource` 按需读取 Skill 根目录内资源。

资源读取拒绝绝对路径和目录逃逸，单个文本资源限制为 256KB。无效 Skill 进入 diagnostics，不影响其他 Skill；`/skills reload` 可热重载。

## MCP

MCPManager 复用 Agents SDK 的 `MCPServerStdio` 与 `MCPServerStreamableHttp`，不实现自有 JSON-RPC Client。配置兼容 `servers` 和 `mcpServers`，支持：

- stdio：`command`、`args`、`cwd`、`env`
- Streamable HTTP：`type: http`、`url`、`headers`
- `${ENV_NAME}` 环境变量替换
- 并行连接、单 Server 失败隔离、工具计数、状态与 reload
- MCP Resources 的列出和读取

只有成功连接的 Server 会交给主 Agent；当前只读 SubAgent 不继承 MCP。远程认证保持在环境变量中，不应写入 `mcp.json`。

## SubAgent

SubAgent 使用 Agents SDK `Agent.asTool()`，而不是 Handoff：

- `delegate_research`：只读文件、知识库和网络，最多 16 turns；不继承 MCP，避免外部写工具绕过边界。
- `delegate_review`：只读文件和知识库，最多 12 turns。
- 子 Agent 不包含委派工具，最大深度固定为 1。
- 主 Agent 继续控制会话、Goal、写操作和最终回答。

这提供了上下文隔离与专业化，又不需要 Agent 图、队列或调度器。

## Runtime Control

`runtime/control.ts` 把 CLI 中有实际运行时语义的操作暴露为 Function Tools。查询、模型切换和模式切换直接复用 `NanoAgent` 方法；Session 切换/清空、MCP reload、输出等级和退出先进入内存队列，等 SDK 完成当前 Session 写入与 `run_end` Hook 后再应用，并把 Effect 交给 CLI 刷新界面。这样 Agent 能代替用户操作，又不会在 Tool Call 尚未闭合时替换持久化目标或关闭当前 MCP 连接。

文件与 Shell 工具同时接受工作区相对路径和绝对路径。`runtime_status` 暴露 `workspaceRoot` 与 `runtimeRoot`，使明确授权的自检查、自修改和自测试不需要新增一套代码编辑协议。

## Memory 与 RAG

Memory 保存少量跨会话偏好、事实、决策和待办，包含来源、重要度和更新时间。RAG 面向本地中小型 Markdown/Text 知识库：固定切片、按内容摘要与模型复用 Embedding、进程内索引缓存、向量与词法混合排序。每轮自动注入只做本地词法检索，显式 `search_knowledge` 才请求查询向量；Embedding 不可用时自动降级为纯词法检索。

## Hooks 与 Trace

HookBus 当前暴露 `run_start`、`run_end`、`run_error` 和 `subagent_event`。默认订阅器写入本地 JSONL Trace。它是普通进程内事件总线，可用于后续统计、Guardrail 或自定义可观测性，不承担工作流编排。

## 扩展决策

- 新增高频原子动作：Tool。
- 新增可复用任务工作流：Agent Skill。
- 接入外部系统、私有数据或远程能力：MCP。
- 需要隔离上下文的独立研究/审查：单层 SubAgent。
- 需要跨重启继续：Goal + Checkpoint。

不要在运行内核加入消息网关、分布式队列、通用工作流 DSL、任意深度 Agent 树或企业向量数据库；这些应作为外围集成存在。
