# NanoAgent

一个面向真实工作的轻量级通用本地 Agent 产品，也是一套轻量多 Agent 编排框架。

NanoAgent 使用 OpenAI Agents SDK 作为运行内核。产品层提供 CLI、持久会话、长期记忆、Skills、MCP、本地 RAG 与任务恢复；编排层提供受控 SubAgent、持久 Team task list、依赖、原子领取和有限并发。两层共享同一个小型 TypeScript 内核，坚持单进程、本地优先和少量依赖。

> 默认 `workspace` 权限只允许内置文件工具访问当前工作区，并隐藏任意 Shell 与写型 HTTP。只有明确设置 `AGENT_PERMISSION_MODE=trusted` 才开放当前操作系统用户权限。

## 为什么是 NanoAgent

NanoAgent 不是一次性工具调用样例，也不想变成重量级工作流平台。它要成为可日常使用的本地通用 Agent，同时把任务拆分、角色隔离、依赖调度和有限并发沉淀为可复用的轻量编排能力。

## 核心能力

- OpenAI Agents SDK 驱动的 Agent Loop
- OpenAI Responses API 与 DeepSeek OpenAI-compatible API
- 持久化多轮会话，可新建、切换和恢复
- 多实例/多进程安全的原子 JSON 状态、格式校验与损坏隔离
- 用户级与项目级 `NANO.md` 持久指令，每轮自动加载且项目级优先
- CLI 与 Agent 共用运行时控制：模型、模式、输出、Session、MCP 和退出均可由对话触发
- 按 Token Budget 裁剪历史、结构化压缩旧上下文和动态上下文组装
- 可检索、可删除的本地长期记忆
- 兼容 Agent Skills 开放规范的发现、激活、资源读取与热重载
- Agents SDK 原生 MCP Client，支持 stdio 与 Streamable HTTP
- MCP 工具、Resources、连接容错、状态检查与热重载
- Markdown/Text 增量索引、Embedding 与混合检索
- 没有 Embedding Key 时自动使用轻量词法检索
- 多步骤 Plan，以及跨重启 Goal、Checkpoint 与 `/resume`
- 通用 / Plan / Ultra Team 三种有真实工具边界的运行模式
- 单层 SubAgent 与持久 Team task list，支持依赖、原子领取和最多 4 路并行
- `workspace` / `read-only` / `trusted` 本地工具权限档位，Team builder 另受 `task.paths` 强约束
- runId 所有权与副作用执行账本，阻止陈旧 Run 覆盖状态或自动重放本地写操作
- 轻量运行时 Hooks
- Spinner、分块事件、Reasoning Summary 和最终回答流式输出
- 非阻塞输入队列、Esc 中止和永久用户输入记录
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
│   ├── state-file.ts     # 跨实例/进程原子 JSON 状态
│   ├── execution-ledger.ts # 本地副作用执行账本
│   ├── guidance.ts       # 用户级与项目级 NANO.md
│   ├── session.ts        # JSON 持久会话
│   ├── memory.ts         # 长期记忆及工具
│   ├── plan.ts           # Plan、Goal、Checkpoint 与 Resume
│   ├── team.ts           # Ultra Team 任务、依赖与持久状态
│   └── trace.ts          # JSONL 执行记录
├── extensions/
│   ├── skills.ts         # Skill 发现与按需加载
│   ├── mcp.ts            # MCP Client、状态与生命周期
│   ├── rag.ts            # 文档增量索引与混合检索
│   ├── subagents.ts      # 单层只读 Agent-as-tool
│   └── team.ts           # 多角色有限并发执行器
├── runtime/
│   ├── nano-agent.ts     # 运行时组合根
│   ├── components.ts     # 模型、存储与扩展初始化
│   ├── session-state.ts  # Session 摘要与 best-effort 恢复语义
│   ├── model.ts          # Provider 模型工厂
│   ├── instructions.ts   # 基础指令与模式
│   ├── tool-policy.ts    # 模式、角色与权限工具策略
│   ├── tool-ledger.ts    # Function Tool 副作用去重包装
│   ├── run-outcome.ts    # 完成、取消与审批中断判定
│   ├── control.ts        # Agent 可调用的运行时控制
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
      ├─ Researcher / Architect / Reviewer SubAgent
      ├─ Ultra Team Worker（按需）
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
DEEPSEEK_MODEL=deepseek-v4-pro
```

安装完成后使用项目专属命令启动：

```bash
nano-agent
```

执行单次任务：

```bash
nano-agent "读取 package.json 并介绍这个项目"
```

查看命令帮助和版本不需要 API Key：

```bash
nano-agent --help
nano-agent --version
```

开发时也可以不建立全局链接，直接运行 `npm run dev`。`npm install`/`npm link` 会自动构建 `dist/`，`npm start` 则执行已构建版本。

NanoAgent 始终从 `~/.nano-agent/.env` 读取模型和 API Key 配置，因此从任何目录启动都会使用同一套环境变量。需要使用其他配置文件时，可以通过 `DOTENV_CONFIG_PATH` 显式指定。

`nano-agent` 是主命令。为兼容旧版本仍保留 `nano` 别名，但 macOS 和 Linux 通常已有同名 GNU nano 编辑器，不建议把别名作为文档或脚本入口。

项目内的 `.env` 和运行目录 `.nano-agent/` 已被 Git 忽略。不要将真实 API Key 写入代码、配置示例或提交记录。

### 可选配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MAX_TURNS` | `200` | 单次 Agent 运行最大轮数 |
| `HISTORY_LIMIT` | `40` | Token Budget 之外的历史条目上限；从完整用户轮次开始截取 |
| `CONTEXT_WINDOW` | 按模型 Profile | 全局覆盖模型上下文窗口；通常无需设置 |
| `OUTPUT_TOKEN_RESERVE` | 按模型 Profile | 全局覆盖输出 Token 预留与请求 `maxTokens` |
| `OUTPUT_LEVEL` | `tools` | 启动时的事件展示等级：`answer`、`thinking`、`tools`、`trace` |
| `OPENAI_MODELS` / `DEEPSEEK_MODELS` | 内置常用模型 | `/model` 选择器追加的逗号分隔模型列表 |
| `AGENT_SESSION` | 未设置 | 显式指定启动 Session；未设置时交互模式自动新建对话 |
| `AGENT_MODE` | `general` | 启动模式：`general`、`plan`、`ultra` |
| `AGENT_PERMISSION_MODE` | `workspace` | 内置本地工具权限：工作区读写、工作区只读或完全信任；见下文 |
| `TEAM_MAX_CONCURRENCY` | `4` | Ultra Team worker 并发上限，运行时强制不超过 4 |
| `AGENT_WORKSPACE` | 当前目录 | 文件、Skill 和知识库的工作区；Shell 仅在 `trusted` 开放 |
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
| `/mode [name]` | 在 `general`、`plan`、`ultra` 之间切换 |
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
| `/compact` | 归档较早上下文并保留最近两轮；原始 Session 不删除 |
| `/instructions` | 查看当前加载的用户级和项目级 `NANO.md` |
| `/memories` | 列出长期记忆 |
| `/plan` | 查看当前任务计划 |
| `/team` | 查看当前 Ultra Team 子任务、依赖、负责人和结果 |
| `/goal [objective]` | 查看或设置跨多轮长期目标 |
| `/resume` | 根据 Checkpoint、Goal、Plan 与 Team 状态进行 best-effort 续跑 |
| `/index [path]` | 构建 RAG 索引，默认 `knowledge/` |
| `/retry` | 重新执行上一条用户输入 |
| `/help` | 查看全部命令 |
| `/exit` | 退出 |

完整会话保存在 `.nano-agent/sessions/`。直接运行 `nano-agent` 会默认创建一个新 Session；若存在历史，启动选择器会展示最多 5 条最近对话并默认高亮“新对话”，使用 ↑↓ 和 Enter 可快速继续历史，Esc 则留在新对话。历史会话按最近活跃时间倒序排列，再次继续的会话会回到顶部；名称从首条有实际主题的用户内容生成，自动跳过“你好”“在吗”等问候和纯命令。当前空白新会话不会出现在最近列表中。设置 `AGENT_SESSION` 可显式打开指定会话，也可通过 `/sessions`、`/switch` 随时恢复。每个 Session 除 SDK transcript 外，还独立保存 mode、model、输出等级、最近运行检查点和上下文压缩档案，切换对话不会串用运行状态。切换后终端会按时间顺序回放持久化的用户消息和最终回答；若上次运行被 Esc、中断、异常或进程退出停止，底部会显示 `↻ 可恢复`、最后阶段和 `/resume` 入口。普通回放不会展示全部工具明细，需要时可使用 `/history` 检查完整记录。

发送给模型的有效上下文分四层管理：较早 Tool Result 先做 microcompact；超过 `HISTORY_LIMIT` 或 Token Budget 后把旧完整轮次持久化为 context archive；`/compact` 可主动执行 full compact 并保留最近两轮；仍超预算时才按完整用户轮次做 PTL truncation。窗口由当前模型 Profile 决定，切换或恢复模型时同步更新；完整预算包含动态 Instructions、历史、当前输入、Function Tool Schema、协议安全余量和输出预留，输出预留同时作为模型请求的 `maxTokens`。压缩只改变模型视图，不覆盖、删除或伪造原始 transcript。`/context` 会区分请求前估算、Provider 返回的上次请求实际 usage 与整轮累计 usage。

每轮开始即写入带 runId/owner 的 `running` checkpoint，所有进展与终态写入都做 runId 比对；旧 Run 不能覆盖新 Run，成功 Run 也不会被迟到的失败回调翻转。Esc 会终止 Shell 子进程组并把本轮落为 `interrupted`。`/resume` 合并 checkpoint、Goal、Plan 与 Team 状态，先核对工作区再发起新一轮任务；它是 best-effort 任务续跑，不声称能从任意模型或工具指令点精确恢复。

交互模式不会阻塞输入：Agent 执行时仍可继续提交消息，消息会进入 FIFO 队列并在当前任务结束后依次执行。输入框支持多行编辑：`Shift+Enter` 插入换行，`Command+←/→` 跳到当前行首/行尾，只有手动 `Enter` 才发送；终端 bracketed paste 中自带的换行只会进入编辑区，不会触发提交。按 `Esc` 可停止当前任务，队列中的后续消息不受影响。长程或多阶段任务通过 `update_plan` 建立阶段任务，当前会话的完成数、当前步骤和最多 5 条附近任务会实时显示在输入框上方；长描述保持单行省略，全部完成后折叠为一行。输入 `/` 会展示命令面板，使用黑色活动光标配合 `↑` / `↓` 选择、`Tab` 补全。`/new`、`/clear` 会清理终端并保留项目顶部信息；会话切换则清理当前画面、恢复顶部信息、任务进度并回放目标会话的历史消息。

输入区固定在终端交互区域的最底部，以 `┊> ` 提示符展示。输入区正上方是常驻状态栏：空闲时显示就绪状态，执行时显示动态 Spinner，并持续展示当前模式、模型以及估算上下文 Token/窗口。如果存在等待消息，更上方会常驻显示 FIFO 队列中的每条对话内容，过长内容以 `...` 省略，消息开始执行后自动从队列区域移除。

用户提交的内容不会随输入框清空而消失：空闲消息开始执行时会立即以 `> 内容` 写入终端对话历史；执行期间提交的消息先常驻等待队列，轮到执行时再移入历史区，避免插入并打断上一条流式回答。

内置模式不仅改变提示词，也改变可用工具：`general` 是默认模式，以最短可靠路径处理大多数任务；`plan` 只保留读取、检索、计划和模式切换能力，先与用户形成完整方案，明确批准后下一轮才能进入实施；`ultra` 为大型代码和长程任务提供 task list 与多角色并行执行。`/mode` 无参数时可通过选择器切换，模型也可调用 `switch_mode`。

Ultra Team 由主 Agent 担任 lead，将工作拆成 2～6 个 `explorer / architect / builder / tester / reviewer` 子任务。`run_team` 每波执行 1～4 个 ready task：单任务可推进依赖流水线，多任务可有限并行。整波任务原子领取；builder 必须声明负责路径且只能写入这些路径，所有 worker 默认都没有 Shell，tester/reviewer 保持只读。task list 按 Session 持久化并随 `/resume` 恢复，租约中断的任务会变为 failed，必须显式重试。

终端事件支持四个轻量输出等级，可通过 `/output` 选择或使用 `OUTPUT_LEVEL` 设置启动默认值：

| 等级 | 展示内容 |
|---|---|
| `answer` | 只流式显示最终答案 |
| `thinking` | 增加模型公开的思考过程 |
| `tools` | 增加工具调用参数摘要和截断后的结果；默认等级 |
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

## NANO.md 持久指令

NanoAgent 使用两层纯 Markdown 指令文件，把需要在每次任务中生效的约定附加到 Agent 上下文：

```text
~/.nano-agent/NANO.md   用户级：个人偏好，适用于所有工作区
<workspace>/NANO.md     项目级：项目约定，优先级高于用户级
```

两个文件都会在每一轮任务开始前重新读取，修改后无需重启或新建会话。若两层存在冲突，项目级 `NANO.md` 生效；主 Agent 和受控 SubAgent 都能看到这些指令，但 SubAgent 的只读边界不会被覆盖。空文件会被忽略，单个文件注入上限为 20000 字符，超出时 `/instructions` 会显示截断状态。

适合放入 `NANO.md` 的内容包括构建与测试命令、代码规范、项目结构、常用工作流和回答偏好。一次性的任务要求应留在当前对话，可复用的多步骤流程应写成 Skill，事实和用户偏好则可交给 Memory。仓库中的 [NANO.md](NANO.md) 可作为项目级示例。

该设计参考了 [Codex AGENTS.md](https://developers.openai.com/codex/concepts/customization#agents-guidance)、[Claude Code CLAUDE.md](https://code.claude.com/docs/zh-CN/memory) 和 [OpenClaw workspace bootstrap](https://docs.openclaw.ai/agent-workspace) 的持久上下文模式，同时只保留 NanoAgent 当前需要的两层结构。

## Agent 自管理与自修改

CLI 斜杠命令和模型工具调用复用相同的 NanoAgent 运行时方法。用户既可以输入 `/model`，也可以直接说“切换到某个模型”；Agent 会实际调用工具，而不是只回复操作步骤。

| CLI 能力 | Agent 工具 |
|---|---|
| `/status`、`/context`、`/tools` | `runtime_status` 与现有状态工具 |
| `/model`、`/mode`、`/output` | `switch_model`、`switch_mode`、`set_output_level` |
| `/sessions`、`/history` | `list_sessions`、`get_session_history` |
| `/switch`、`/new`、`/clear` | `switch_session`、`new_session`、`clear_session` |
| `/skills`、`/mcp`、`/index` | `list_skills`、`reload_skills`、`reload_mcp`、`index_knowledge` |
| `/memories`、`/plan`、`/goal` | Memory、Plan 和 Goal 工具 |
| `/exit` | `request_exit` |

模型和模式切换从下一轮生效；Session、输出等级和退出在当前回答完整写入后生效，避免留下孤立 Tool Call。`/retry` 与 `/resume` 属于重新发起一轮对话的 CLI 入口，Agent 在当前轮中分别通过重试工具和 Goal 工具完成相同语义，不递归启动自身。

`runtime_status` 同时返回当前工作区、运行时代码目录和权限档位。默认 `workspace` 下，文件工具只能读写工作区且会拒绝符号链接逃逸；`read-only` 进一步移除写工具；`trusted` 才提供绝对路径与 Shell。NanoAgent 源码位于当前工作区时仍可自检查和修改，安装在工作区外时需要用户显式选择更高权限。

## 长期记忆

会话保存“发生过什么”，记忆保存“以后仍有价值的信息”。普通 transcript、摘要、Plan、Team、mode 和模型都严格留在各自 Session；只有用户在本轮明确说“记住”或“保存为长期记忆”时，`remember` 才获得跨 Session 写入权限，并记录来源 Session 与确认时间。旧版未确认 Memory 不会注入模型；文件、Shell 和 RAG 工具也不能读取或索引 `.nano-agent` 私有运行数据。Agent 可调用：

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

如果配置了 `OPENAI_API_KEY`，默认使用 `text-embedding-3-small`；没有 Key 或 Embedding 请求失败时自动回退到词法相似度，因此 DeepSeek-only 环境也能运行。知识库不会自动跨 Session 注入，只有模型在当前任务中显式调用 `search_knowledge` 时才执行向量/词法混合检索。重新索引会按内容摘要和 Embedding 模型复用未变化的向量；并发提交通过文件锁保持完整，最后完成的整份索引原子替换旧版本，不依赖进程内缓存。默认权限拒绝索引工作区外或 `.nano-agent` 私有运行数据。

## Plan、Goal、Ultra Team、Trace 与 Eval

复杂任务使用 `update_plan` 管理当前步骤：阶段开始前标记 `running`，结束后立即更新为 `completed` 或 `failed`，再推进下一阶段。Session、mode、model、运行状态和 Plan 当前进度会作为紧凑会话状态注入每轮模型上下文；`update_plan` 返回的完整列表则是本轮后续推理的权威进度。需要跨多轮或跨重启时使用 `set_goal`，并通过 `update_goal` 保存状态、checkpoint 和 next action。`/resume` 会从持久状态生成恢复输入。两者共享 `.nano-agent/plans.json`，不会产生重复的 Todo 系统。

通用模式可将独立研究或审查交给 `delegate_research`、`delegate_review`；Plan 与 Ultra 还提供只读 `delegate_architecture`。Ultra 的 `set_team_tasks` 与 `run_team` 才会启动 builder/tester 等角色。SubAgent 不继承 MCP、不包含委派工具，最终整合仍由主 Agent 负责。该设计借鉴 [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) 的 lead、共享任务和 mailbox 思想，但只保留本地 task list、依赖与有限并发，不引入额外进程或复杂编排服务。

运行生命周期、SubAgent 和 Team worker 事件通过轻量 Hooks 写入 `.nano-agent/traces/<session-id>.jsonl`。Trace 只记录公开运行事件与公开 reasoning summary，不保存模型隐藏思维链。

运行类型检查、测试和最小 RAG 评测：

```bash
npm run check
npm test
npm run eval
```

需要 API Key 的可选 Agent 行为评测会验证模型是否真实激活 Skill、调用 SubAgent、切换模式并执行 Ultra Team wave：

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
| SubAgent | `delegate_research`、`delegate_architecture`、`delegate_review`（按模式提供） |
| Ultra Team | `set_team_tasks`、`show_team_tasks`、`claim_team_task`、`update_team_task`、`retry_team_task`、`run_team` |
| OpenAI 托管 | `code_interpreter`，以及 Provider 支持时的托管能力 |
| MCP | Server Tools、`list_mcp_resources`、`read_mcp_resource` |

新增的四个高频工具保持原子化：`search_files` 同时搜索文件名和文本内容，`edit_file` 做精确局部替换，`move_file` 默认拒绝覆盖目标，`http_request` 支持常见 HTTP 方法并复用代理配置。更复杂的 Git、数据库或业务能力应优先通过 Skill、MCP 或现有 Shell 工具组合，而不是继续堆内置工具。

## 有意保留的边界

NanoAgent 不追求复刻大型 Agent 平台的全部能力。当前不实现 Web UI、消息网关、分布式任务、任意深度多 Agent 图、复杂工作流 DSL、企业向量数据库、完整 HITL 审批平台或容器集群；这些能力可通过 MCP、Skill 或外围系统组合，而不应进入轻量运行内核。

`workspace` 是安全默认值，但显式配置的 MCP Server 仍拥有其自身声明的外部权限。`trusted` 会开放任意 Shell、绝对路径和写型 HTTP，只应在可信工作区和可信提示词下使用。

## 项目文档

- [架构与设计不变量](docs/ARCHITECTURE.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)
- [版本记录](CHANGELOG.md)

欢迎提交 Issue 和 Pull Request。新增能力应优先帮助用户完成真实工作，同时保持本地优先、模块边界清晰和依赖克制。

## License

[MIT](LICENSE)
