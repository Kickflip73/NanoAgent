# Ultra Team 模式实施记录

日期：2026-07-14
关联计划：[[../plans/20260714-UltraTeam模式-计划.md]]
关联调研：[[../research/20260714-UltraTeam模式-调研.md]]

## 完成内容

- 将运行模式从四个提示词预设收敛为 General、Plan、Ultra Team 三个能力契约，默认 General。
- 新增模式级 Tool policy；Plan 从实际 Agent 工具集合移除文件写入、Shell、HTTP 动作和 MCP Server Tools，只保留读取、检索、计划与安全运行时控制。
- 新增按 Session 持久化的 TeamTaskStore，支持唯一 ID、无环依赖、ready 计算、原子 claim、状态结果、失败重试和临时文件原子写入。
- 新增 explorer、architect、builder、tester、reviewer 五角色与 `run_team` Promise Pool；worker 独立上下文，最多四路并发，单个失败不丢失其他结果。
- builder 并行前必须声明 paths，重叠路径确定性拒绝；存在 builder 时任务图必须包含依赖其结果的 tester 和 reviewer 门禁。
- Esc AbortSignal 传入嵌套 Runner；取消结果持久化为 failed，可显式 retry，completed 不会重新进入 ready。
- Team 摘要加入动态上下文、runtime status 和 `/resume`，新增 `/team`、Team Hook/Trace 与启动配置。
- 更新 README、架构、知识、项目指令、环境示例、Changelog 和版本至 0.10.0。

## 验证证据

- `npm run check`：通过。
- `npm test`：60/60 通过，覆盖依赖、并发 claim、Session 隔离、验证门禁、四路并发、部分失败、取消恢复、路径冲突、角色工具范围与 Plan policy。
- `npm run build`：通过。
- `npm run eval`：2/2 通过。
- `npm run eval:agent`：4/4 通过；真实模型调用了 Skill、SubAgent、模式切换，以及 `set_team_tasks + run_team`。
- `npm pack --dry-run`：通过；发布包包含新增运行时代码与文档。
- 敏感信息扫描与 `git diff --check`：通过，未发现 API Key。

## 设计取舍

- 不引入 LangGraph、数据库、外部队列、tmux、worktree 或 P2P mailbox；保持单进程、一个 lead、一层 worker。
- 文件 paths 是调度冲突门禁与 worker 责任边界，不是操作系统沙箱；NanoAgent 仍使用当前用户权限。
- Team task list 保存结构化结果摘要，不把 worker 完整上下文写进主 Session，控制上下文与成本。
- 失败任务必须显式 retry，避免恢复时无意重复 completed 工作。
