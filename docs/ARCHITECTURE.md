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
  ├─ CommandHandler
  ├─ InteractiveTerminal
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
2. FileSession 清理旧版本生成的无效摘要，并修复中断留下的孤立工具调用/结果
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

## CLI 与分发

`package.json` 将 `nano` 映射到构建后的 `dist/index.js`。`src/index.ts` 保留 Node.js shebang，`tsconfig.build.json` 只编译 `src/`，避免把测试代码带进运行产物。

```text
npm install / npm link
  → prepare
  → npm run build
  → dist/index.js
  → nano
```

`nano --help` 和 `nano --version` 在创建模型客户端之前处理，因此不需要 API Key。交互模式中的斜杠命令由 `commands.ts` 统一解析，`interactive.ts` 提供轻量键盘输入、命令补全和选择器，`index.ts` 只负责 FIFO 调度和流消费。未知斜杠命令不会被发送给模型。

交互输入和 Agent 执行彼此独立。每次提交进入内存队列，调度器逐条执行；当前任务持有独立的 `AbortController`，按 `Esc` 会通过 SDK 的 `AbortSignal` 中止模型请求及工具链，然后继续处理剩余队列。会话选择器读取本地 JSON 会话，以首条有效用户消息生成标题、以最近用户消息生成预览，不产生额外模型调用。

模型选择属于运行时状态：`/model` 更新 `NanoAgent` 当前的模型实例，Provider 和 API Key 仍由启动配置决定。OpenAI 使用 SDK 模型名，DeepSeek 则重建兼容的 `OpenAIChatCompletionsModel`，不会重建会话、工具、MCP 或其他核心组件。顶部 Banner 和清屏后的重新渲染仍由终端层负责。

`/mode` 只切换一段轻量的模式指令，并在每轮构建 Instructions 时注入；标准、规划、编码、调研模式复用同一 Runner、会话和工具集合。状态栏中的上下文长度通过序列化会话近似估算 Token 数，窗口来自 `CONTEXT_WINDOW`，未配置时按 Provider 使用保守默认值。

内置命令只做运行时管理和高频查看；需要模型推理的能力应实现为 Tool、Skill 或 MCP，而不是 CLI 命令。

## 终端事件流

`TerminalRenderer` 只处理展示，不参与 Agent 决策：

- Spinner 表示当前仍在运行。
- Reasoning、工具调用、工具结果、回答和完成使用不同的低饱和前景色。
- 事件块之间保留空行。
- Markdown 按行转换为终端文本。
- 没有换行的回答每约 45ms 增量刷新，避免整段完成后才出现。
- 非 TTY 输出不包含 ANSI 控制符。
- 基础 Instructions 引导模型生成紧凑的终端内容，默认限制行数并避免表格、碎片化标题和手工对齐。
- 渲染器压缩普通文本中的异常连续空格，并把多个连续空行收敛为一个空行；代码块内容保持原样。
- 交互区按“等待队列 → 命令候选 → 常驻状态栏 → 单行输入框”排列，输入框始终位于最底部。
- 等待队列由调度器同步给终端层，只展示尚未开始执行的消息，并按终端宽度生成单行省略预览。
- 调度器取出消息时先调用终端层记录 `> 用户输入`，再启动命令或 Agent；排队消息因此只在开始执行时进入永久终端历史，不会打断上一条流式回答。

事件详细度同样只存在于展示层。`answer`、`thinking`、`tools`、`trace` 四级过滤复用同一个 `RunStreamEvent` 流，不改变 Runner、会话记录、工具执行或 Trace 持久化。最高等级直接渲染工具参数和结果，单条详情设置 20000 字符的显示上限；默认 `tools` 只暴露工具名称。

Trace 只记录高层展示事件和最终答案，不保存模型隐藏思维链。

## 内置工具边界

NanoAgent 只内置通用、高频且容易理解的原子工具：

- 文件读取、写入、精确编辑、移动、列表和搜索。
- Shell、HTTP、时间和计算。
- Memory、Skill、RAG 与 Plan 各自提供少量领域工具。

工具数量不是能力目标。Git 工作流、浏览器控制、数据库和第三方服务更适合通过 Shell、Skill 或 MCP 接入，以避免 `tools.ts` 演变成平台层。

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
