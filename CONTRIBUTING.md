# Contributing to NanoAgent

感谢你愿意改进 NanoAgent。这个项目的首要目标是帮助读者看懂 Agent，而不是堆叠功能。

## 开始开发

```bash
git clone https://github.com/Kickflip73/NanoAgent.git
cd NanoAgent
npm install
cp .env.example .env
```

运行质量检查：

```bash
npm run check
npm test
npm run eval
```

需要真实模型冒烟时再配置 API Key；单元测试和 Retrieval Eval 不需要 Key。

## 设计约束

- 保持单 Agent、单进程和 CLI 结构。
- 优先使用 Node.js 标准库，避免为很小的功能增加重型依赖。
- `core/` 只放 Agent 自身状态，`extensions/` 只放可选能力。
- 不在 Context 中持久化临时摘要或检索结果。
- 裁剪 Session 时必须保持工具调用与工具结果成对。
- 新功能同时补充测试、README 和必要的架构说明。

## 提交 Pull Request

1. 从 `main` 创建小而聚焦的分支。
2. 使用 Conventional Commits，例如 `feat(rag): support custom chunk size`。
3. 确认 `npm run check && npm test && npm run eval` 全部通过。
4. 在 PR 中说明动机、实现方式、验证证据和文档变化。
5. 不提交 `.env`、`.nano-agent/`、API Key、个人数据或本地调试产物。

Bug 修复应尽量包含一个能够复现问题的回归测试。
