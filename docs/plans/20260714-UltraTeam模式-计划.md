# Ultra Team 模式实施计划

日期：2026-07-14
状态：已完成
关联调研：[[../research/20260714-UltraTeam模式-调研.md]]

## 任务目标

将 MimiAgent 模式收敛为 General、Plan、Ultra Team；让 Plan 具备真实只读讨论边界，让 Ultra Team 通过多个专门 SubAgent、依赖任务板、有限并发、Goal checkpoint 和验证门禁完成大规模代码与其他长程任务。

## 方案概述

保留单进程 OpenAI Agents SDK 主循环。模式决定提示词、可用工具、SubAgent 角色和并发上限；新增很小的 TeamTaskStore 与 `run_team` 编排工具，不引入 LangGraph、数据库、队列、tmux、worktree 管理或多层 Agent 网络。

### 模式能力矩阵

| 能力 | General | Plan | Ultra Team |
|---|---:|---:|---:|
| 读取、检索、MCP Resources | ✓ | ✓ | ✓ |
| 写文件、Shell、外部动作 | ✓ | — | ✓ |
| Plan / Goal | 按需 | 必须先规划 | 长任务必须 |
| 单个 researcher/reviewer | ✓ | ✓（只读） | ✓ |
| 共享 TeamTaskStore | — | 只读查看 | ✓ |
| builder/tester/architect | — | architect only | ✓ |
| `run_team` 真并发 | — | — | ✓，最大 4 |
| 完成门禁 | 常规验证 | 等待用户批准 | tester + reviewer |

## UI 变动检测

涉及 UI 变动：否
变动类型：CLI 文案与状态数据调整，无网页/桌面前端
涉及文件：无 `.vue/.tsx/.jsx/.html/.css` 文件
预览状态：无需预览

## 详细步骤

### 1. 收敛三种模式并强化提示词

**涉及文件：** `src/runtime/instructions.ts`、`src/runtime/mimi-agent.ts`、`src/commands.ts`

- `general`：完整工具，按复杂度选择直接执行或轻量委派。
- `plan`：只读调研、澄清目标、列出可验证计划，未经明确批准不得实施；批准后调用 `switch_mode` 切换到 General/Ultra。
- `ultra`：Lead 先建立 Goal 和依赖任务图，只并行独立任务，分波执行，最后测试/审查并保存 checkpoint。
- `/mode` 和 `switch_mode` 只列出这三个模式；默认从 `standard` 改为 `general`。

**拟定类型：**

```ts
export const AGENT_MODES = [
  { id: 'general', label: '通用', ... },
  { id: 'plan', label: 'Plan', ... },
  { id: 'ultra', label: 'Ultra Team', ... },
] as const;
```

### 2. 实现模式级工具策略

**涉及文件：** `src/runtime/tool-policy.ts`、`src/runtime/mimi-agent.ts`

- 按模式过滤主 Agent 工具。
- Plan 模式排除 `write_file`、`edit_file`、`move_file`、`run_shell`、Team builder 等执行工具。
- General 保留现有能力；Ultra 追加 Team 工具。
- SDK 本地 Function Tool 并发：General/Plan 限 2，Ultra 限 4，避免无限 fan-out。

**拟定接口：**

```ts
export function toolsForMode(mode: AgentMode, tools: Tool[], teamTools: Tool[]): Tool[];

const stream = runner.run(agent, input, {
  ...options,
  toolExecution: { maxFunctionToolConcurrency: mode === 'ultra' ? 4 : 2 },
});
```

### 3. 增加共享 TeamTaskStore

**涉及文件：** `src/core/team.ts`

任务字段：`id / description / role / status / dependencies / owner / paths / result / timestamps`。

工具：

- `set_team_tasks`：创建依赖任务图。
- `show_team_tasks`：查看所有任务和可运行任务。
- `claim_team_task`：原子领取未阻塞任务。
- `update_team_task`：保存结果、失败或完成状态。
- `retry_team_task`：显式重置 failed task，completed task 不会被重复执行。

数据按 Session 存入 `.mimi-agent/teams.json`，沿用串行写队列和临时文件 rename，避免并发覆盖。

**拟定数据结构：**

```ts
type TeamRole = 'explorer' | 'architect' | 'builder' | 'tester' | 'reviewer';
type TeamTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

interface TeamTask {
  id: string;
  description: string;
  role: TeamRole;
  status: TeamTaskStatus;
  dependencies: string[];
  paths: string[];
  owner?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}
```

Store 必须在写入时校验：ID 唯一、依赖存在、无自依赖、依赖图无环；`claim` 只允许领取所有依赖已 completed 的 pending task。

### 4. 实现确定性 Ultra Team 编排

**涉及文件：** `src/extensions/team.ts`、`src/extensions/subagents.ts`、`src/runtime/mimi-agent.ts`

- `run_team` 一次运行 2～4 个 ready tasks，使用 Promise Pool 和独立 Runner 真并发。
- 角色：explorer、architect、builder、tester、reviewer。
- 每个 Worker 使用独立 Agent/context、明确输出结构、工具白名单、12～24 turns 上限，不允许嵌套 Team。
- builder 获得文件/Shell 工具，但必须遵守 task paths 所有权；tester/reviewer 在实现波次后运行。
- Worker 自动更新任务状态和 result；Lead 只收到压缩结果并负责归并、后续波次和最终回答。

**拟定编排接口：**

```ts
tool({
  name: 'run_team',
  parameters: z.object({
    taskIds: z.array(z.string()).min(2).max(4),
  }),
  execute: async ({ taskIds }, context) =>
    runTaskPool(taskIds, { maxConcurrency: 4, signal: context?.signal }),
});
```

并发池保留输入顺序返回结果；单个 Worker 失败只把对应 task 标为 failed，不丢失其他 Worker 结果。收到 AbortSignal 后停止领取新任务并中止运行中的 Runner。

### 5. 长程恢复、Hooks 与 CLI 状态

**涉及文件：** `src/core/plan.ts`、`src/runtime/hooks.ts`、`src/commands.ts`、`src/index.ts`

- Ultra 长任务复用 Goal/checkpoint，`/resume` 能看到未完成 Team tasks。
- 增加 team worker/task start/end/failure Hook 事件和 JSONL Trace。
- 增加 `/team` 查看任务板；`/status` 展示当前 Team 进度。
- CLI 不实现复杂 teammate 面板，仍用现有分级事件块展示 worker 状态。

`/resume` 生成的输入会包含 ready/running/failed Team task 摘要；恢复时不得重复执行 completed task。`/team` 只展示任务表和进度，不增加常驻复杂面板。

### 6. 测试、行为 Eval 与文档

**涉及文件：** `tests/*`、`evals/agent-cases.json`、`README.md`、`docs/ARCHITECTURE.md`、`CHANGELOG.md`、`knowledge/mimi-agent.md`

- 验证模式列表恰好为 General/Plan/Ultra。
- 验证 Plan 模式不暴露写入/Shell 工具。
- 验证 Team 依赖解锁、并发 claim、失败记录与 Session 隔离。
- 用可注入 fake worker 验证 `run_team` 的真实并发上限和 fan-in 顺序。
- 真实 Agent Eval 验证 Ultra 模式会创建任务板并调用 `run_team`，而非只改提示词。
- 更新模式选择、成本边界、适用场景、任务板与恢复文档。

## 提示词设计

### General

- 默认直接完成任务，只有独立子任务能显著减少主上下文时才委派。
- 不为普通问题创建 Goal 或 Team，不把小任务过度编排。
- 修改后按风险运行最小必要验证。

### Plan

- 先通过只读工具理解目标、约束、现状和风险。
- 计划必须包含范围、步骤、涉及文件、验证方式、风险和明确的完成标准。
- 未收到用户明确的“批准/开始/实施”前，只能讨论和修订计划。
- 收到批准后调用 `switch_mode` 切到 `general` 或 `ultra`；当前轮仍不写文件。

### Ultra Team Lead

- 仅用于可拆成至少两个相对独立任务的大规模工作；否则退回 General。
- 先设置 Goal，再创建无环依赖任务图；每个 builder 必须声明不重叠 paths。
- 按 ready tasks 分波调用 `run_team`，禁止并行执行有依赖或同文件任务。
- 每波后检查 failed task、保存 checkpoint，并决定重试、重规划或继续。
- 实现完成后必须运行 tester 和 reviewer；验证证据不足不得完成 Goal。
- Lead 负责最终综合，不把互相矛盾的 Worker 结果未经判断地转交用户。

### Worker

- 只处理一个明确 task，不扩大范围、不嵌套委派。
- 开始前读取 MIMI.md 和任务上下文；结束时返回摘要、修改文件、验证证据、风险和后续建议。
- builder 只修改 task.paths；tester/reviewer 默认不修代码，只报告证据和问题。

## 权衡与考量

- 不实现 P2P Mailbox：Lead + shared board + structured result 已覆盖第一版协作闭环。
- 不默认 worktree：MimiAgent 不承担 Git 并行工作区平台；通过 paths 所有权和依赖分波降低冲突。
- 不无限并行：默认 4 个 Worker，任务越多不代表越快。
- Plan 的只读性由工具策略保证；提示词只负责交互流程。
- Ultra Team 是显式模式，不自动把普通任务膨胀成多 Agent 工作流。

## 验收标准

1. `/mode` 选择器和 `availableModes()` 只出现 `general / plan / ultra`，默认是 General。
2. Plan 模式的实际 Agent tool names 中不存在写文件、移动文件和 Shell；单靠 Prompt 无法绕过。
3. Ultra 模式可用一个 `run_team` 调用启动至少两个独立 Worker，并在测试中证明同时运行数大于 1、最大不超过 4。
4. Team task 依赖未完成时不能 claim；依赖完成后自动进入 ready；并发 claim 不会重复领取。
5. Worker 失败、取消和部分成功均持久化，`/resume` 不重复 completed task。
6. builder/tester/reviewer 使用不同工具范围和提示词；Worker 无 Team/委派工具，深度固定为 1。
7. Ultra 完成路径包含 tester 和 reviewer 结果；行为 Eval 能观察到任务板与 `run_team` 工具调用。
8. General 小任务不会被提示词强制创建 Team；现有 Skill、MCP、Memory、Session 和 runtime control 回归测试继续通过。
9. README、ARCHITECTURE、MIMI.md、knowledge、CHANGELOG 与 CLI 帮助保持一致。
10. `npm run check && npm run build && npm test && npm run eval && npm run eval:agent && npm pack --dry-run` 全部通过，并完成敏感信息扫描与推送验证。

## Todo List

- [x] 收敛 General / Plan / Ultra 三模式
- [x] 实现模式级工具策略
- [x] 实现 Session 级 TeamTaskStore
- [x] 实现五角色与 `run_team` 并发编排
- [x] 接入 Goal、Hooks、Trace 与 `/team`
- [x] 补齐单元、集成和真实行为 Eval
- [x] 更新 README、架构、知识与 Changelog
- [x] 运行 check/build/test/eval/package 检查
- [x] 提交并推送
