# NanoAgent

一个用于学习 AI Agent 基本原理的轻量级示例项目。

NanoAgent 使用 TypeScript 和 OpenAI Agents SDK 构建，把一个 Agent 最核心的组成部分压缩在少量代码中：模型、提示词、会话、工具调用、运行循环、过程事件和流式输出。项目支持 OpenAI 与 DeepSeek，适合用来理解 Agent 如何从“回答问题”进化到“调用工具完成任务”。

> 这是一个学习项目，不是生产级 Agent 平台。默认启用了本机文件和 Shell 工具，请仅在可信环境中运行。

## 特性

- OpenAI Agents SDK 驱动的 Agent Loop
- 支持 OpenAI Responses API
- 支持 DeepSeek OpenAI-compatible Chat Completions API
- 进程内多轮会话记忆
- 最多 200 个 Agent 执行轮次
- 动态终端状态动画
- 实时展示模型 reasoning、工具调用及结果摘要
- 最终回答流式输出
- 本机文件读取、写入和目录浏览
- 本机 zsh 命令执行
- 时间与计算工具
- OpenAI 模式下支持 Web Search 和 Code Interpreter
- 自动使用 `HTTP_PROXY` / `HTTPS_PROXY`
- 无 UI 框架、数据库、消息队列和额外日志框架

## 运行效果

```text
⠹ 模型思考中
💭 思考> 需要先获取当前年份，再进行计算。
🔧 调用工具 current_time {}
✓ 工具完成 current_time → {"timezone":"Asia/Shanghai", ...}
🔧 调用工具 calculate {"operation":"add","a":2026,"b":17}
✓ 工具完成 calculate → 2043
助手> 当前是 2026 年，加上 17 年后是 2043 年。
✓ 任务完成 · 4.1s
```

## 架构

```text
src/
├── index.ts       # 配置加载、网络代理、CLI 入口和流消费
├── agent.ts       # 模型选择、Agent、Runner 和 Session
├── tools.ts       # 本机工具与 OpenAI 托管工具
└── terminal.ts    # Spinner、运行事件和流式文本渲染

tests/
├── tools.test.ts
└── terminal.test.ts
```

一次请求的主要调用链：

```text
CLI
 └─ NanoAgent.stream()
     └─ OpenAI Agents SDK Runner
         ├─ OpenAI / DeepSeek
         ├─ Function Tools
         └─ MemorySession
```

## 环境要求

- Node.js 22 或更高版本
- npm
- OpenAI API Key 或 DeepSeek API Key

## 快速启动

### 1. 克隆和安装

```bash
git clone https://github.com/Kickflip73/NanoAgent.git
cd NanoAgent
npm install
```

### 2. 配置模型

复制配置模板：

```bash
cp .env.example .env
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

`.env` 已被 Git 忽略，不要把真实 Key 写入 `.env.example` 或任何源代码文件。

### 3. 启动交互模式

```bash
npm start
```

内置命令：

- `/exit`：退出
- `/clear`：清屏

### 4. 单次任务

```bash
npm start -- "现在几点？"
npm start -- "读取 package.json 并介绍这个项目"
npm start -- "运行测试并告诉我结果"
```

## 工作区

默认工作区是启动命令所在目录。可以通过环境变量指定：

```bash
export AGENT_WORKSPACE=/path/to/workspace
npm start
```

相对文件路径和 Shell 命令都会以该目录为基础。绝对路径仍然可以访问本机其他位置。

## 内置工具

| 工具 | 说明 | 可用 Provider |
|---|---|---|
| `current_time` | 获取时间和时区 | 全部 |
| `read_file` | 读取本机文本文件 | 全部 |
| `write_file` | 创建或覆盖文本文件 | 全部 |
| `list_directory` | 浏览本机目录 | 全部 |
| `run_shell` | 执行 zsh 命令 | 全部 |
| `calculate` | 基础数学运算 | 全部 |
| `web_search` | OpenAI 托管联网搜索 | OpenAI |
| `code_interpreter` | OpenAI 托管代码执行 | OpenAI |

DeepSeek 模式没有 OpenAI 托管工具，但 Agent 可以通过本机 `run_shell` 使用已有的命令行工具完成联网和代码执行。

## 开发与验证

```bash
npm run check
npm test
```

项目使用 TypeScript 严格模式和 Node.js 内置测试运行器，不需要额外测试框架。

## 适合学习什么

- Agent、Runner、Session 各自负责什么
- Function Calling 如何连接模型与本地代码
- 模型如何在多轮运行中选择并连续调用工具
- OpenAI 与 OpenAI-compatible 模型如何共用 Agent Runtime
- 如何消费 Agent 运行事件
- 如何实现终端状态动画和 token 流式输出
- 为什么工具权限是 Agent 应用的重要边界

## 当前限制

- 会话只保存在内存中，进程退出后清空
- 只有 CLI，没有 Web UI 或消息渠道
- 没有长期记忆、任务队列和定时任务
- 没有工具审批或沙箱隔离
- DeepSeek 的 `reasoning_content` 通过 Provider 原始事件读取

这些限制是刻意保留的，使代码足够小，便于学习和修改。

## 安全说明

NanoAgent 的 `run_shell`、文件读取和文件写入工具拥有当前操作系统用户的权限。Agent 可以修改或删除文件，也可能执行模型从外部内容中读到的指令。

建议：

- 只在测试目录或隔离环境运行
- 不要把服务暴露给不可信用户
- 不要让 Agent 处理来源不明的提示词和网页内容
- 不要在工作区存放敏感文件
- 定期检查模型 API 用量

## License

[MIT](LICENSE)
