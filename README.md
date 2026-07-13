# NanoAgent

一个真正帮助用户完成工作的轻量级通用 Agent。

NanoAgent 使用 OpenAI Agents SDK 作为运行内核，覆盖工具调用、流式事件、Token-aware 上下文、持久会话、长期记忆、开放 Agent Skills、MCP、本地 RAG、Goal/Resume、受控 SubAgent 与 Trace。它对标 Claude Code、Codex、OpenClaw、Hermes 等通用 Agent 的核心技术，但坚持单进程、本地优先和少量依赖，不复制它们的重量级平台能力。

> 默认包含本机文件和 Shell 工具，请只在可信环境中运行。

## 为什么是 NanoAgent

许多 Agent 项目要么只能演示一次工具调用，要么引入复杂服务和编排平台。NanoAgent 选择第三条路线：提供可以直接处理文件、执行命令、检索资料、连接 MCP、恢复长期目标和委派子任务的通用 Agent，同时让代码仍然足够小、清晰、可替换。

## 核心能力

- OpenAI Agents SDK 驱动的 Agent Loop
- OpenAI Responses API 与 DeepSeek OpenAI-compatible API
- 持久化多轮会话，可新建、切换和恢复
- 按 Token Budget 裁剪历史、结构化压缩旧上下文和动态上下文组装
- 可检索、可删除的本地长期记忆
- 兼容 Agent Skills 开放规范的发现、激活、资源读取与热重载
- Agents SDK 原生 MCP Client，支持 stdio 与 Streamable HTTP
- MCP 工具、Resources、连接容错、状态检查与热重载
- Markdown/Text 增量索引、Embedding 与混合检索
- 没有 Embedding Key 时自动使用轻量词法检索
- 多步骤 Plan，以及跨重启 Goal、Checkpoint 与 `/resume`
- 单层 researcher/reviewer SubAgent，主 Agent 保持最终控制
- 轻量运行时 Hooks
- Spinner、分块事件、Reasoning Summary 和最终回答流式输出
- 非阻塞输入队列、Esc 中止和永久用户输入记录
- 标准、规划、编码、调研四种运行模式
- 从仅答案到完整工具详情的四级终端事件过滤
- 常驻状态栏、内容摘要会话选择器和斜杠命令补全
- Claude Code 风格的低饱和事件配色与终端友好 Markdown 渲染
- 本地 JSONL Trace 和最小 Retrieval Eval

## 架构

```text
src/
├── index.ts              # CLI 与运行事件消费
├── commands.ts           # 斜杠命令解析与执行
├── interactive.ts        # 输入框、队列、选择器与常驻状态栏
├── agent.ts              # 向后兼容的运行时导出
├── config.ts             # 环境配置
├── core/
│   ├── context.ts        # 上下文裁剪、压缩与组装
│   ├── session.ts        # JSON 持久会话
│   ├── memory.ts         # 长期记忆及工具
│   ├── plan.ts           # Plan、Goal、Checkpoint 与 Resume
│   └── trace.ts          # JSONL 执行记录
├── extensions/
│   ├── skills.ts         # Skill 发现与按需加载
│   ├── mcp.ts            # MCP Client、状态与生命周期
│   ├── rag.ts            # 文档增量索引与混合检索
│   └── subagents.ts      # 单层 Agent-as-tool
├── runtime/
│   ├── nano-agent.ts     # 运行时组合根
│   ├── model.ts          # Provider 模型工厂
│   ├── instructions.ts   # 基础指令与模式
│   └── hooks.ts          # 生命周期事件总线
├── tools.ts              # 本机及 OpenAI 托管工具
├── terminal.ts           # 终端动画和流式渲染
└── eval.ts               # 最小检索评测
```

一次请求的调用链：

```text
用户输入
  → 检索长期记忆和知识库
  → 加载 Skill 目录、Plan 与 Goal checkpoint
  → Context Manager 组装 Instructions
  → Agents SDK Runner
      ├─ OpenAI / DeepSeek
      ├─ 内置 Tools
      ├─ MCP Tools / Resources
      ├─ Researcher / Reviewer SubAgent
      └─ 持久 Session
  → 流式输出并写入 Trace
```

`runtime` 只负责组装和运行，`core` 保存 Agent 状态，`extensions` 提供可插拔能力。详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速启动

要求 Node.js 22 或更高版本。

```bash
git clone https://github.com/Kickflip73/NanoAgent.git
cd NanoAgent
npm install
mkdir -p ~/.nano-agent
cp .env.example ~/.nano-agent/.env
npm link
```

使用 OpenAI：

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.4-mini
```

使用 DeepSeek：

```dotenv
MODEL_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

安装完成后使用项目专属命令启动：

```bash
nano
```

执行单次任务：

```bash
nano "读取 package.json 并介绍这个项目"
```

查看命令帮助和版本不需要 API Key：

```bash
nano --help
nano --version
```

开发时也可以不建立全局链接，直接运行 `npm run dev`。`npm install`/`npm link` 会自动构建 `dist/`，`npm start` 则执行已构建版本。

NanoAgent 始终从 `~/.nano-agent/.env` 读取模型和 API Key 配置，因此从任何目录启动都会使用同一套环境变量。需要使用其他配置文件时，可以通过 `DOTENV_CONFIG_PATH` 显式指定。

> macOS 和 Linux 通常已经安装 GNU nano 编辑器。执行 `type -a nano` 可以查看命令解析顺序；如果系统编辑器排在前面，请运行 `export PATH="$(npm prefix -g)/bin:$PATH"`，并把它加入 shell 配置。运行 `npm unlink --global nano-agent` 可移除项目链接并恢复原编辑器命令。

项目内的 `.env` 和运行目录 `.nano-agent/` 已被 Git 忽略。不要将真实 API Key 写入代码、配置示例或提交记录。

### 可选配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAX_TURNS` | `200` | 单次 Agent 运行最大轮数 |
| `HISTORY_LIMIT` | `40` | Token Budget 之外的历史条目上限；从完整用户轮次开始截取 |
| `CONTEXT_WINDOW` | OpenAI `400000` / DeepSeek `128000` | 状态栏用于展示上下文占用的 Token 窗口 |
| `OUTPUT_LEVEL` | `tools` | 启动时的事件展示等级：`answer`、`thinking`、`tools`、`trace` |
| `OPENAI_MODELS` / `DEEPSEEK_MODELS` | 内置常用模型 | `/model` 选择器追加的逗号分隔模型列表 |
| `AGENT_SESSION` | `default` | 启动时使用的本地会话 ID |
| `AGENT_WORKSPACE` | 当前目录 | 文件、Shell、Skill 和知识库的工作区 |
| `AGENT_DATA_DIR` | `<workspace>/.nano-agent` | 会话、记忆、计划、索引和 Trace 目录 |
| `AGENT_SKILLS_DIR` | `<workspace>/skills` | Skill 根目录 |
| `MCP_CONFIG` | `<workspace>/mcp.json` | MCP Server 配置文件 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | RAG Embedding 模型 |
| `DOTENV_CONFIG_PATH` | `~/.nano-agent/.env` | 显式指定统一环境配置文件 |

## 会话与上下文

内置命令：

| 命令 | 作用 |
|---|---|
| `/model [name]` | 查看或切换当前 Provider 下的模型；无参数时使用选择器 |
| `/mode [name]` | 在标准、规划、编码和调研模式之间切换 |
| `/output [level]` | 切换终端执行事件的展示详细度 |
| `/new [id]` | 新建并切换会话 |
| `/sessions` | 按内容摘要列出最近对话，使用 ↑↓ 和 Enter 切换 |
| `/switch <id>` | 切换已有会话 |
| `/history` | 查看当前完整历史 |
| `/clear` | 清空当前会话 |
| `/status` | 查看模型、会话、Skills、Memory 和 MCP 状态 |
| `/skills [reload]` | 列出或重新扫描 Agent Skills |
| `/tools` | 列出当前可用工具 |
| `/mcp [reload]` | 查看状态或重新连接 MCP Server |
| `/context` | 查看历史、记忆和计划用量 |
| `/memories` | 列出长期记忆 |
| `/plan` | 查看当前任务计划 |
| `/goal [objective]` | 查看或设置跨多轮长期目标 |
| `/resume` | 从 Goal checkpoint 继续执行 |
| `/index [path]` | 构建 RAG 索引，默认 `knowledge/` |
| `/retry` | 重新执行上一条用户输入 |
| `/help` | 查看全部命令 |
| `/exit` | 退出 |

完整会话保存在 `.nano-agent/sessions/`。启动已有会话，或通过 `/sessions`、`/switch` 切换后，终端会按时间顺序回放持久化的用户消息和最终回答；最新对话位于输入框上方，更早内容可使用终端原生滚动区向上查看。普通回放不会展示工具参数和原始工具结果，需要时可使用 `/history` 检查完整记录。

发送给模型时同时遵守 `HISTORY_LIMIT` 和上下文 Token Budget，并从完整用户轮次边界裁剪，避免拆散工具调用与结果；较早的用户消息、回答和工具摘要会压缩为结构化动态 Instructions，不会反向污染原始会话。

交互模式不会阻塞输入：Agent 执行时仍可继续提交消息，消息会进入 FIFO 队列并在当前任务结束后依次执行。按 `Esc` 可停止当前任务，队列中的后续消息不受影响。输入 `/` 会展示命令面板，使用黑色活动光标配合 `↑` / `↓` 选择、`Tab` 补全。`/new`、`/clear` 会清理终端并保留项目顶部信息；会话切换则清理当前画面、恢复顶部信息并回放目标会话的历史消息。

输入框固定在终端交互区域的最底部，以单行虚线方框和 `>` 提示符展示。输入框正上方是常驻状态栏：空闲时显示就绪状态，执行时显示动态 Spinner，并持续展示当前模式、模型以及估算上下文 Token/窗口。如果存在等待消息，更上方会常驻显示 FIFO 队列中的每条对话内容，过长内容以 `...` 省略，消息开始执行后自动从队列区域移除。

用户提交的内容不会随输入框清空而消失：空闲消息开始执行时会立即以 `> 内容` 写入终端对话历史；执行期间提交的消息先常驻等待队列，轮到执行时再移入历史区，避免插入并打断上一条流式回答。

内置模式会直接补充 Agent 的运行指令：`standard` 平衡速度与完整性，`plan` 强调先规划后执行，`code` 强调检查、修改和验证代码，`research` 强调多来源检索与交叉验证。`/mode` 无参数时可通过选择器切换。

终端事件支持四个轻量输出等级，可通过 `/output` 选择或使用 `OUTPUT_LEVEL` 设置启动默认值：

| 等级 | 展示内容 |
|---|---|
| `answer` | 只流式显示最终答案 |
| `thinking` | 增加模型公开的思考过程 |
| `tools` | 增加工具调用名称，不展示参数和结果；默认等级 |
| `trace` | 展示输入任务、思考、工具参数和工具完整结果 |

`trace` 适合学习和排查 Agent 执行过程，例如 `read_file` 会显示读取到的文件内容。为避免意外输出超大内容，单条详情最多展示 20000 个字符；此限制只作用于终端显示，不改变工具实际返回给模型的数据。

`/model` 默认展示当前 Provider 的常用模型，也会合并 `OPENAI_MODELS` 或 `DEEPSEEK_MODELS` 中以逗号分隔的自定义模型名称。`/model <name>` 可以直接切换未列出的兼容模型；切换只影响当前进程，不修改 `.env`。

## 终端展示

交互输出使用低饱和前景色和简洁符号区分事件，并在事件块之间保留空行。下面是 `trace` 详细等级的示例：

```text
> 读取 package.json 并介绍项目

✦ 思考
需要读取项目配置。

● 工具  read_file
  {"path":"package.json"}

└ 结果  read_file
  {"name":"nano-agent", ...}

◆ 回答
项目配置已读取。

✓ 完成  2.1s
```

默认 `tools` 等级只显示思考、工具名称和最终答案，不会展示上例中的工具参数与 `└ 结果` 内容。

颜色只在 TTY 中启用，管道和日志输出不会包含 ANSI 控制符。最终回答会定时增量刷新，并按行渲染 Markdown：标题不再显示 `###`，列表、引用、代码块、表格、粗体、行内代码和链接会转换为适合终端阅读的形式。

Agent 的基础 Instructions 使用“终端优先”输出约束：普通回答默认不超过约 12 行，优先采用少量紧凑段落，避免 Markdown 表格、连续标题、频繁空行和手工空格对齐；列表通常不超过 5 项且每项保持单行。渲染层还会压缩异常的横向空白和连续空行，作为模型输出不稳定时的显示兜底。用户明确要求详细内容时，模型仍可按任务需要展开。

## 长期记忆

会话保存“发生过什么”，记忆保存“以后仍有价值的信息”。Agent 可调用：

- `remember`：保存偏好、事实、决策或待办
- `recall`：搜索相关记忆
- `list_memories`：列出记忆
- `forget`：删除指定记忆

用户明确说“记住……”时，Agent 会使用 `remember`。记忆保存在 `.nano-agent/memories.json`，并在后续相关问题中自动检索。

## Skill

每个 Skill 是一个目录和 `SKILL.md`：

```text
skills/code-review/SKILL.md
```

```md
---
name: code-review
description: 审查当前代码变更
---

1. 获取 git diff。
2. 阅读相关文件。
3. 运行测试并输出问题。
```

NanoAgent 遵循 Agent Skills 的渐进披露方式：启动时只暴露名称、描述和位置；匹配任务后调用 `use_skill` 激活完整说明，再通过 `read_skill_resource` 按需读取 `references/`、`scripts/` 或其他文本资源。YAML 元数据会按开放规范校验，无效 Skill 只产生诊断，不阻断其他 Skill。修改后执行 `/skills reload` 即可生效。

内置 Skill 工具：`use_skill`、`read_skill_resource`、`list_skills`、`reload_skills`。仓库保留 `code-review`、`research` 和 `web-research` 三个精简示例，用户可在工作区自由添加更多 Skills。

## MCP

`mcp.json` 默认不启动任何 Server。复制示例即可接入 filesystem MCP：

```bash
cp mcp.example.json mcp.json
npm start
```

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "."
    }
  }
}
```

NanoAgent 同时接受 `servers` 和主流的 `mcpServers` 配置键。stdio Server 使用 `command/args`；远程 Server 使用 `type: "http"` 和 `url`，可通过 `${ENV_NAME}` 引用 Header 环境变量。工具发现、调用和协议通信直接交给 Agents SDK，不重复实现 MCP 协议。

单个 Server 连接失败不会阻断 NanoAgent 启动。`/mcp` 会展示传输类型、工具数和错误，`/mcp reload` 可重新连接。除了模型自动获得 MCP Tools，Agent 还可以通过 `list_mcp_resources`、`read_mcp_resource` 访问 Resources。

## RAG

将 Markdown 或文本文件放到 `knowledge/`，然后在交互模式执行：

```text
/index knowledge
```

RAG 流程：

```text
读取文档 → 切片与内容摘要 → 复用未变化 Embedding → JSON 索引 → 向量/词法混合检索 → 注入上下文
```

如果配置了 `OPENAI_API_KEY`，默认使用 `text-embedding-3-small`；没有 Key 或 Embedding 请求失败时自动回退到词法相似度，因此 DeepSeek-only 环境也能运行。每轮自动注入先做零网络成本的词法检索；模型显式调用 `search_knowledge` 时启用向量/词法混合检索。重新索引会按内容摘要和 Embedding 模型复用未变化的向量，索引在进程内缓存，适合本地中小型知识库。

## Plan、Goal、SubAgent、Trace 与 Eval

复杂任务使用 `update_plan` 管理当前步骤；需要跨多轮或跨重启时使用 `set_goal`，并通过 `update_goal` 保存状态、checkpoint 和 next action。`/resume` 会从持久状态生成恢复输入。两者共享 `.nano-agent/plans.json`，不会产生重复的 Todo 系统。

主 Agent 可将独立研究或审查任务交给 `delegate_research`、`delegate_review`。SubAgent 使用独立上下文、只读本地/网络工具、有限轮数且不能嵌套委派；它们不继承 MCP，最终回答和外部写操作仍由主 Agent 负责。运行生命周期和 SubAgent 事件通过轻量 Hooks 写入 `.nano-agent/traces/<session-id>.jsonl`，不保存模型隐藏思维链。

运行类型检查、测试和最小 RAG 评测：

```bash
npm run check
npm test
npm run eval
```

需要 API Key 的可选 Agent 行为评测会验证模型是否真实激活 Skill 和调用 SubAgent：

```bash
npm run eval:agent
```

## 内置工具

| 类别 | 工具 |
|---|---|
| 文件 | `read_file`、`write_file`、`edit_file`、`move_file`、`list_directory`、`search_files` |
| 系统与网络 | `run_shell`、`http_request`、`web_search`、`current_time`、`calculate` |
| 记忆 | `remember`、`recall`、`list_memories`、`forget` |
| Skill | `use_skill`、`read_skill_resource`、`list_skills`、`reload_skills` |
| RAG | `search_knowledge`、`index_knowledge` |
| Plan / Goal | `update_plan`、`show_plan`、`set_goal`、`update_goal`、`show_goal` |
| SubAgent | `delegate_research`、`delegate_review` |
| OpenAI 托管 | `code_interpreter`，以及 Provider 支持时的托管能力 |
| MCP | Server Tools、`list_mcp_resources`、`read_mcp_resource` |

新增的四个高频工具保持原子化：`search_files` 同时搜索文件名和文本内容，`edit_file` 做精确局部替换，`move_file` 默认拒绝覆盖目标，`http_request` 支持常见 HTTP 方法并复用代理配置。更复杂的 Git、数据库或业务能力应优先通过 Skill、MCP 或现有 Shell 工具组合，而不是继续堆内置工具。

## 有意保留的边界

NanoAgent 不追求复刻大型 Agent 平台的全部能力。当前不实现 Web UI、消息网关、分布式任务、任意深度多 Agent 图、复杂工作流 DSL、企业向量数据库、权限审批平台或容器集群；这些能力可通过 MCP、Skill 或外围系统组合，而不应进入轻量运行内核。

`run_shell` 和文件工具拥有当前操作系统用户权限。请在测试目录或隔离环境运行，不要处理不可信提示词，也不要在工作区存放敏感文件。

## 项目文档

- [架构与设计不变量](docs/ARCHITECTURE.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [版本记录](CHANGELOG.md)

欢迎提交 Issue 和 Pull Request。新增能力应优先帮助用户完成真实工作，同时保持本地优先、模块边界清晰和依赖克制。

## License

[MIT](LICENSE)
