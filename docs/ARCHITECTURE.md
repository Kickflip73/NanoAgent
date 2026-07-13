# NanoAgent Architecture

NanoAgent 的目标是用尽量少的层次解释现代 Agent 的核心组成，而不是构建生产级平台。

## 设计原则

- 单 Agent、单进程、CLI 优先。
- OpenAI Agents SDK 负责模型运行循环和工具协议。
- JSON/JSONL 负责本地持久化，不引入数据库和 ORM。
- 模块通过构造函数直接组合，不引入依赖注入框架。
- MCP 使用 SDK 原生实现，RAG 使用本地索引。
- 一个文件解释一个核心概念，扩展能力不能破坏主调用链的可读性。

## 模块边界

```text
CLI (index.ts)
  ├─ TerminalRenderer
  └─ NanoAgent (agent.ts)
      ├─ Core
      │   ├─ ContextManager
      │   ├─ FileSession
      │   ├─ MemoryStore
      │   ├─ PlanStore
      │   └─ TraceStore
      ├─ Extensions
      │   ├─ SkillLoader
      │   ├─ MCPManager
      │   └─ RagStore
      └─ OpenAI Agents SDK Runner
```

### Core

`core` 保存 Agent 自身运行所需的状态：

- `session.ts`：完整对话历史，实现 Agents SDK `Session` 接口。
- `context.ts`：裁剪近期历史，生成较早对话摘要，并注入记忆、文档、Skill 目录和 Plan。
- `memory.ts`：少量跨会话稳定信息及对应工具。
- `plan.ts`：当前会话的多步骤任务状态及对应工具。
- `trace.ts`：可回放的高层执行事件。

### Extensions

`extensions` 提供可选能力：

- `skills.ts`：扫描 Markdown 工作流，按需返回全文。
- `mcp.ts`：根据 `mcp.json` 管理 stdio MCP Server 生命周期。
- `rag.ts`：文档切片、Embedding、索引和召回；Embedding 不可用时回退到词法检索。

## 一轮请求

```text
1. CLI 接收用户输入
2. FileSession 清理旧版本生成的无效摘要记录
3. Memory、RAG、Plan 与完整 Session 并行读取
4. ContextManager 构建动态 Instructions
5. ContextManager 从完整用户轮次边界裁剪近期历史
6. Runner 执行模型、内置 Tool 和 MCP Tool
7. TerminalRenderer 消费事件并增量渲染
8. SDK 将本轮输入、工具事件和回答追加到 FileSession
9. TraceStore 保存高层事件和最终回答摘要
```

## 上下文协议不变量

工具调用不是普通文本，裁剪历史时必须维持模型协议：

```text
user message
  → function_call
  → function_call_result
  → assistant message
```

NanoAgent 不直接执行 `history.slice(-limit)`，而是从目标位置向前回退到一个完整的用户消息边界，保证所有工具结果都保留对应的工具调用。较早对话摘要只进入本轮动态 Instructions，不能作为伪用户消息写回 Session。

这两个不变量分别避免：

- `Messages with role 'tool' must be a response to ... tool_calls`
- 每轮重复持久化摘要、导致会话持续污染

## Session、Memory、RAG、Context

| 模块 | 内容 | 生命周期 | 是否直接进入历史 |
|---|---|---|---|
| Session | 完整对话和工具事件 | 按会话持续追加 | 是 |
| Memory | 用户偏好、事实、决策、待办 | 跨会话 | 否，按需注入 Instructions |
| RAG | 外部 Markdown/Text 文档 | 重新索引时更新 | 否，检索后注入 Instructions |
| Context | 本轮实际发送给模型的信息 | 每轮动态生成 | 不持久化 |

`NanoAgent.stream()` 是组合点：它根据用户输入并行检索 Memory、RAG、Plan 和 Session，生成动态 Instructions，再把持久 Session、内置 Tools 与 MCP Servers 交给 Runner。

## 终端事件流

`TerminalRenderer` 只处理展示，不参与 Agent 决策：

- Spinner 表示当前仍在运行。
- Reasoning、工具调用、工具结果、回答和完成使用不同的低饱和前景色。
- 事件块之间保留空行。
- Markdown 按行转换为终端文本。
- 没有换行的回答每约 45ms 增量刷新，避免整段完成后才出现。
- 非 TTY 输出不包含 ANSI 控制符。

Trace 只记录高层展示事件和最终答案，不保存模型隐藏思维链。

## 数据目录

```text
.nano-agent/
├── sessions/*.json
├── memories.json
├── plans.json
├── rag-index.json
└── traces/*.jsonl
```

该目录只包含运行数据并被 Git 忽略。删除它即可重置 NanoAgent，不影响代码、Skill 和知识文档。

## 扩展方式

- 新增原子动作：在 `tools.ts` 注册 Tool。
- 新增可复用工作流：添加 `skills/<name>/SKILL.md`。
- 接入外部系统：在 `mcp.json` 添加 MCP Server。
- 添加项目知识：放入 `knowledge/` 后重新执行 `/index`。
- 替换存储：实现相同的 Session、Memory 或 RAG 方法，不需要修改 Agent Loop。

新增模块前请先判断它是否属于 Agent 核心学习范围。多 Agent、消息网关、工作流引擎和企业权限系统不属于当前边界。
