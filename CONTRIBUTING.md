# Contributing to MimiAgent

感谢你愿意改进 MimiAgent。项目目标是构建真正能处理工作、生活与外部事件的 7×24 小时全能个人 Agent；代码可读性和轻量架构是实现方式，不是功能上限。

## 开始开发

```bash
git clone https://github.com/Kickflip73/MimiAgent.git MimiAgent
cd MimiAgent
npm install
mkdir -p ~/.mimi-agent
cp .env.example ~/.mimi-agent/.env
npm link
```

本地源码安装后也只使用 `mimi`；`npm link` 只是把当前工作树链接到全局命令：

```bash
mimi --help
```

运行质量检查：

```bash
npm run check
npm run build
npm test
npm run eval
```

需要真实模型冒烟时再配置 API Key，并运行 `npm run eval:agent`；单元测试和 Retrieval Eval 不需要 Key。

## 设计约束

- 保持单个主 Agent 和单一 Session 所有者；CLI 与 Daemon 复用同一 `MimiHost`，Connector 凭据只留在隔离子进程中。
- SubAgent 必须是有边界的单层委派，不拥有最终回答或独立会话。
- 优先使用 Node.js 标准库，避免为很小的功能增加重型依赖。
- `runtime/` 负责组装，`core/` 只放 Agent 状态，`extensions/` 放可插拔能力。
- 不在 Context 中持久化临时摘要或检索结果。
- 裁剪 Session 时必须保持工具调用与工具结果成对。
- 新功能同时补充测试、README 和必要的架构说明。
- 新增内置 Tool 前先确认它是否通用、高频，能否通过 Skill、MCP 或现有 Tool 组合完成。
- Skill 应遵循 Agent Skills 开放规范；MCP 优先复用 Agents SDK Client。
- 长任务状态应复用 Goal/Plan，不增加第二套 Todo 或工作流存储。

## 提交 Pull Request

1. 从 `main` 创建小而聚焦的分支。
2. 使用 Conventional Commits，例如 `feat(rag): support custom chunk size`。
3. 确认 `npm run check && npm run build && npm test && npm run eval` 全部通过。
4. 在 PR 中说明动机、实现方式、验证证据和文档变化。
5. 不提交 `.env`、`.mimi-agent/`、API Key、个人数据或本地调试产物。

Bug 修复应尽量包含一个能够复现问题的回归测试。
