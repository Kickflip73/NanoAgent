# Ultra Team 模式调研报告

日期：2026-07-14
状态：已审核并进入实施

## 调研范围

- 目标：把 NanoAgent 的运行模式收敛为通用、Plan、Ultra Team，并设计轻量但真实的多 SubAgent 编排。
- 外部参考：
  - [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
  - [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents)
  - [Claude Code Dynamic Workflows](https://code.claude.com/docs/en/workflows)
  - [Oh My Claude Code](https://ohmyclaudecode.com/)
- 涉及现有模块：
  - `src/runtime/instructions.ts`
  - `src/runtime/nano-agent.ts`
  - `src/extensions/subagents.ts`
  - `src/core/plan.ts`
  - `src/commands.ts`
  - `src/interactive.ts`

## 外部实现结论

### “Ultra Code” 的准确对应

Anthropic 官方没有把 `Ultra Code` 作为稳定模式名称；官方对应能力是 Agent Teams、Subagents 和 Dynamic Workflows。社区 Oh My Claude Code 则提供 Ultrawork/Team/Ralph 等模式：Ultrawork 强调最大并行，Team 强调共享任务列表，Ralph 强调持续执行与验证后完成。因此 NanoAgent 的 Ultra Team 应吸收这些机制，而不是复制某个不存在的官方开关。

### Claude Code Agent Teams

官方 Agent Teams 采用 Lead + 独立 Teammates + Shared Task List + Mailbox。Teammate 有独立上下文，任务支持 pending/in-progress/completed、依赖和原子 claim；官方建议多数任务从 3～5 个成员开始，并明确指出顺序依赖、相同文件编辑和小任务不适合团队模式。复杂或高风险实现可要求 teammate 先提交计划、由 Lead 审批后再写代码。

### Subagents 与动态工作流

Subagent 更轻：独立上下文、定制提示和工具范围，只向主 Agent 返回摘要。Dynamic Workflow 把循环、分支和中间结果留在程序中，只把归并结果送回模型，可减少主上下文膨胀。OpenAI Agents SDK 0.13.2 本地执行器已经支持同一轮 Function Tools 并发，并可通过 `toolExecution.maxFunctionToolConcurrency` 限制并发，因此 NanoAgent 不需要引入队列框架。

## NanoAgent 现状

### 模式

当前有 `standard / plan / code / research` 四种模式，差异仅是追加一句提示词。Plan 模式仍然拥有写文件和 Shell 工具，无法保证“先聊好计划再实施”。Code/Research 与 Skill/SubAgent 的职责重复。

### SubAgent

当前只有 `delegate_research` 和 `delegate_review` 两个只读 Agent-as-tool，最大深度 1。优点是简单、上下文隔离；不足是不能确定性并行启动一组任务、没有 builder/tester/architect 角色、没有共享任务状态，也不能承载大规模代码实现。

### Plan 与 Goal

PlanStore 已有进程内串行写、Session 隔离、Goal/checkpoint/resume，可复用长程任务能力。但 PlanStep 只是展示型数组，不包含依赖、owner、角色、结果或并发 claim，不适合作为 Team 任务板。

## 推荐系统设计

### 三种模式

1. `general`：默认模式，保留完整主 Agent 工具和轻量 researcher/reviewer，适合大部分任务。
2. `plan`：讨论和只读调研模式。主 Agent 只获得读取、检索、计划、Goal 和模式切换工具；隐藏写文件、移动文件和 Shell 等执行能力。用户明确批准后切换到 General 或 Ultra Team，下一轮实施。
3. `ultra`：面向大规模、可拆分、长程任务。要求先建立 Goal 和依赖任务图，再通过受限并发的 Team 工具执行独立任务波次，最后由 tester/reviewer 验证并由 Lead 综合。

### 轻量 Team，而非完整多会话平台

- 新增一个 Session 级 JSON TeamTaskStore：任务、role、dependencies、owner、status、paths、result。
- 新增一个确定性的 `run_team` Tool：一次接收/选择 2～4 个已就绪任务，用 Promise Pool 并行运行独立 Agents SDK Runner，默认最大并发 4。
- 内置五种角色：explorer、architect、builder、tester、reviewer。每个角色有独立系统提示、工具白名单和 turns 上限。
- Lead 仍是唯一编排者和最终回答者；Worker 不嵌套生成团队，也不做 P2P Mailbox。
- Builder 只并行处理声明为不重叠的 paths；相同文件或强依赖任务必须分波次串行。
- Team 中间输出写入任务板，返回 Lead 的是结构化摘要，避免所有日志进入主上下文。
- 复用 Goal/checkpoint 做跨重启恢复，复用 Hook/Trace 记录 worker start/end/failure。

## 风险与边界

- 多 Agent 成本近似随成员数线性增长，因此默认并发 4、单波最多 6，并只在 Ultra 模式暴露 Team 工具。
- 并发写相同文件会冲突；第一版通过 task paths 所有权、依赖和提示约束规避，不引入 Git worktree 管理器。
- Plan 模式必须靠工具过滤形成真实只读边界，不能仅依赖提示词。
- DeepSeek/OpenAI 对并行 Tool Call 的生成倾向不同，因此 `run_team` 必须由代码确定性并发，而不能只期待模型一次发出多个 delegate 调用。
- 不实现 teammate UI、多会话终端、P2P 消息、动态模型路由和任意深度 Agent 树；这些会破坏轻量定位。

## 关键结论

最适合 NanoAgent 的不是复制 Claude Code 全量 Agent Teams，而是“主 Agent Lead + JSON 依赖任务板 + 一层确定性并发 Worker + 验证门禁 + Goal 恢复”。这能覆盖大规模代码、研究和长程任务的核心技术，同时保持单进程、少依赖和可读实现。
