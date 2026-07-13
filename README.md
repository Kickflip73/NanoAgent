# NanoAgent

一个用于学习现代 AI Agent 核心技术的轻量级 TypeScript 项目。

NanoAgent 使用 OpenAI Agents SDK 作为运行内核，在少量代码中展示 Agent Loop、工具调用、流式事件、上下文管理、持久会话、长期记忆、Skill、MCP、本地 RAG、轻量计划与 Trace。它保持单 Agent、单进程和 CLI 形态，不尝试成为生产级平台。

> 默认包含本机文件和 Shell 工具，请只在可信环境中运行。

## 为什么是 NanoAgent

许多 Agent 示例只展示一次工具调用，而完整框架又很难看清核心机制。NanoAgent 选择中间路线：保留一个可直接运行的 Agent，把上下文、会话、记忆、Skill、MCP 和 RAG 分别放进小而明确的模块中，方便阅读、调试和替换。

## 核心能力

- OpenAI Agents SDK 驱动的 Agent Loop
- OpenAI Responses API 与 DeepSeek OpenAI-compatible API
- 持久化多轮会话，可新建、切换和恢复
- 上下文窗口裁剪、旧历史压缩和动态上下文组装
- 可检索、可删除的本地长期记忆
- Markdown Skill 扫描与按需加载
- Agents SDK 原生 stdio MCP Client
- Markdown/Text 文档切片、Embedding 和本地 JSON 检索
- 没有 Embedding Key 时自动使用轻量词法检索
- 多步骤任务 Plan
- Spinner、分块事件、Reasoning Summary 和最终回答流式输出
- Claude Code 风格的低饱和事件配色与终端友好 Markdown 渲染
- 本地 JSONL Trace 和最小 Retrieval Eval

## 架构

```text
src/
├── index.ts              # CLI 与运行事件消费
├── commands.ts           # 斜杠命令解析与执行
├── agent.ts              # Agent 组装和一次运行
├── config.ts             # 环境配置
├── core/
│   ├── context.ts        # 上下文裁剪、压缩与组装
│   ├── session.ts        # JSON 持久会话
│   ├── memory.ts         # 长期记忆及工具
│   ├── plan.ts           # 当前会话计划及工具
│   └── trace.ts          # JSONL 执行记录
├── extensions/
│   ├── skills.ts         # Skill 发现与按需加载
│   ├── mcp.ts            # MCP Server 生命周期
│   └── rag.ts            # 文档索引与检索
├── tools.ts              # 本机及 OpenAI 托管工具
├── terminal.ts           # 终端动画和流式渲染
└── eval.ts               # 最小检索评测
```

一次请求的调用链：

```text
用户输入
  → 检索长期记忆和知识库
  → 加载 Skill 目录与当前 Plan
  → Context Manager 组装 Instructions
  → Agents SDK Runner
      ├─ OpenAI / DeepSeek
      ├─ 内置 Tools
      ├─ MCP Tools
      └─ 持久 Session
  → 流式输出并写入 Trace
```

这里刻意只分两层：`core` 是 Agent 自身状态，`extensions` 是可插拔能力。详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 快速启动

要求 Node.js 22 或更高版本。

```bash
git clone https://github.com/Kickflip73/NanoAgent.git
cd NanoAgent
npm install
cp .env.example .env
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

> macOS 和 Linux 通常已经安装 GNU nano 编辑器。执行 `type -a nano` 可以查看命令解析顺序；如果系统编辑器排在前面，请运行 `export PATH="$(npm prefix -g)/bin:$PATH"`，并把它加入 shell 配置。运行 `npm unlink --global nano-agent` 可移除项目链接并恢复原编辑器命令。

`.env` 和运行目录 `.nano-agent/` 已被 Git 忽略。不要将真实 API Key 写入代码、配置示例或提交记录。

### 可选配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAX_TURNS` | `200` | 单次 Agent 运行最大轮数 |
| `HISTORY_LIMIT` | `40` | 送入模型的近期历史条数；会从完整用户轮次开始截取 |
| `AGENT_WORKSPACE` | 当前目录 | 文件、Shell、Skill 和知识库的工作区 |
| `AGENT_DATA_DIR` | `<workspace>/.nano-agent` | 会话、记忆、计划、索引和 Trace 目录 |
| `AGENT_SKILLS_DIR` | `<workspace>/skills` | Skill 根目录 |
| `MCP_CONFIG` | `<workspace>/mcp.json` | MCP Server 配置文件 |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | RAG Embedding 模型 |

## 会话与上下文

内置命令：

| 命令 | 作用 |
|---|---|
| `/new [id]` | 新建并切换会话 |
| `/sessions` | 列出本地会话 |
| `/switch <id>` | 切换已有会话 |
| `/history` | 查看当前完整历史 |
| `/clear` | 清空当前会话 |
| `/status` | 查看模型、会话、Skills、Memory 和 MCP 状态 |
| `/skills` | 列出可用 Skills |
| `/memories` | 列出长期记忆 |
| `/plan` | 查看当前任务计划 |
| `/index [path]` | 构建 RAG 索引，默认 `knowledge/` |
| `/retry` | 重新执行上一条用户输入 |
| `/help` | 查看全部命令 |
| `/exit` | 退出 |

完整会话保存在 `.nano-agent/sessions/`。发送给模型时会从最近的完整用户轮次开始保留约 `HISTORY_LIMIT` 条历史，避免拆散工具调用与工具结果；更早的人类对话压缩到动态 Instructions，且不会反向写入会话。完整原始历史不会因此删除。

## 终端展示

交互输出使用低饱和前景色和简洁符号区分事件，并在事件块之间保留空行：

```text
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

颜色只在 TTY 中启用，管道和日志输出不会包含 ANSI 控制符。最终回答会定时增量刷新，并按行渲染 Markdown：标题不再显示 `###`，列表、引用、代码块、表格、粗体、行内代码和链接会转换为适合终端阅读的形式。

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

启动时只把名称和描述放入上下文；Agent 调用 `use_skill` 后才读取完整工作流。仓库包含 `code-review` 和 `research` 两个示例。

## MCP

`mcp.json` 默认不启动任何 Server。复制示例即可接入 filesystem MCP：

```bash
cp mcp.example.json mcp.json
npm start
```

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": "."
    }
  }
}
```

NanoAgent 负责读取配置和连接/关闭 Server，工具发现与调用直接交给 Agents SDK，不重复实现 MCP 协议。

## RAG

将 Markdown 或文本文件放到 `knowledge/`，然后在交互模式执行：

```text
/index knowledge
```

RAG 流程：

```text
读取文档 → 切片 → Embedding → JSON 索引 → 相似度检索 → 注入上下文
```

如果配置了 `OPENAI_API_KEY`，默认使用 `text-embedding-3-small`；没有 Key 或 Embedding 请求失败时自动回退到词法相似度，因此 DeepSeek-only 环境也能运行。索引保存在 `.nano-agent/rag-index.json`，适合小型学习知识库，不面向海量数据。

## Plan、Trace 与 Eval

复杂任务可以调用 `update_plan`，计划按会话保存在 `.nano-agent/plans.json`。运行事件保存在 `.nano-agent/traces/<session-id>.jsonl`，只记录展示事件和工具摘要，不保存模型隐藏思维链。

运行类型检查、测试和最小 RAG 评测：

```bash
npm run check
npm test
npm run eval
```

## 内置工具

| 类别 | 工具 |
|---|---|
| 文件 | `read_file`、`write_file`、`edit_file`、`move_file`、`list_directory`、`search_files` |
| 系统与网络 | `run_shell`、`http_request`、`current_time`、`calculate` |
| 记忆 | `remember`、`recall`、`list_memories`、`forget` |
| Skill | `use_skill`、`list_skills` |
| RAG | `search_knowledge`、`index_knowledge` |
| Plan | `update_plan`、`show_plan` |
| OpenAI 托管 | `web_search`、`code_interpreter` |
| MCP | 来自 `mcp.json` 中已连接的 Server |

新增的四个高频工具保持原子化：`search_files` 同时搜索文件名和文本内容，`edit_file` 做精确局部替换，`move_file` 默认拒绝覆盖目标，`http_request` 支持常见 HTTP 方法并复用代理配置。更复杂的 Git、数据库或业务能力应优先通过 Skill、MCP 或现有 Shell 工具组合，而不是继续堆内置工具。

## 有意保留的边界

NanoAgent 不实现 Web UI、多 Agent、消息网关、分布式任务、复杂工作流、企业向量数据库、权限审批平台或 Docker 沙箱。这些是生产系统能力，不是本项目要解释的核心机制。

`run_shell` 和文件工具拥有当前操作系统用户权限。请在测试目录或隔离环境运行，不要处理不可信提示词，也不要在工作区存放敏感文件。

## 项目文档

- [架构与设计不变量](docs/ARCHITECTURE.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [版本记录](CHANGELOG.md)

欢迎提交 Issue 和 Pull Request。新增能力时请优先保证代码可读性，避免把 NanoAgent 扩展成复杂平台。

## License

[MIT](LICENSE)
