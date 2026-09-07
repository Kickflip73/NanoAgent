# 历史结果复用与中断连续性修复

日期：2026-09-07。分支：`codex/phase2-continuous-tasks`。

## 事故证据与根因

“播放每日简报”的真实任务约运行 49 分钟，四次 attempt，前三次租约过期、最后一次 HTTP 402；记录中有 118 次工具调用、23 次 Web 查询、28 次能力发现。它偏离了“操作既有结果”，变成重新研究和生成。HTTP 402 已由另一次运维恢复确认是原 Provider Credit 用尽；不是这次反复重做的唯一原因。

代码与日志共同确认了以下通用缺口：

1. 查询入口按任务执行方式割裂。后台任务列表不含定时任务，模型容易把局部空结果当成全局不存在；终态结果也缺少可复用的结构化文件引用。
2. 中断时回滚未完成的 SDK 工具协议是必要的，但原检查点主要保存阶段/最后事件，缺少已完成工具的实际结果。再次运行尤其容易重复查证、重复规划。普通自然语言接续未必经过显式恢复入口。
3. 工具 Promise 正常返回不代表操作成功。`run_shell` 返回 exitCode=1 时，部分事实收集/回执投影仍算 succeeded，导致失败不够明确。
4. Speech 的音频映射只存在当前进程；换会话/重启后的 ID 无法复用，也不能直接播放已有音频文件。超时仅终止调用外壳，独立后端仍可能继续，日志显示客户端断开后还在渲染；缺少可查询的持久生成状态会诱发重复提交。
5. 高频原子操作仍需要反复发现，增加了模型在能力目录中的搜索成本。失败租约还被标注成未开始派发，掩盖“已执行过一部分”的事实。

尚不能从现有证据确定前三次租约过期的直接触发原因。本轮没有把它归因于睡眠、TTS 或事件循环阻塞，也没有通过延长租约掩盖问题。

## 最小通用实现

- 复用现有 Task/SQLite 增加 `task_history`：按本人 profile 分页，统一查询 conversation/background/scheduled 等任务；详情区分任务状态、业务 outcome、实际结果与文件引用。非 owner 来源不开放这一跨会话入口。没有新增任务数据库、产物平台或关键词路由。
- 现有 Finalization 增加可选文件引用；只采集成功工具明确报告的结构化路径，非模型口述。路径不是验收证明，使用前仍要核对日期、内容及存在性。
- 现有 Session Checkpoint 保留最近 12 次工具的脱敏有界摘录和最多 100 个路径，读写受当前 Session/runId 保护。显式重试保留进度；普通后续输入只获得上一轮未完成事实供模型判断，不自动激活旧 Goal/Plan，不伪造 transcript。
- 共享工具结果分类识别非零退出、显式失败和 uncertain；Run 终态与 manifest 保持一致。租约回收记录 dispatchStarted=true。
- Speech 原子 JSON 记录生成凭据；相同文本/选项/渲染器跨进程竞争只认领一次，ready 可按原 ID 播放，未确认状态返回原 ID。现有外部音频可按绝对路径播放，不走研究/写稿/合成。
- 受管本地命令清理其拥有的进程组；不声称能终止自行脱离进程组的第三方服务。speech、task_history、model_control 在既有策略允许时直接暴露给模型，不增加权限确认。

## 验证与边界

回归使用 CSV 报告、图片文件、Shell 非零退出、多种任务来源、跨会话/重启、连续中断、并发音频生成、外部音频播放、路径替换及真实子进程退出；不依赖个人历史、API Key 或真实 Provider。初始回归确实复现“非零退出仍算成功”和“重启后音频 ID 丢失”。

- `npm run check` 通过；全量 `npm test` 最终 1013/1013 通过。
- 此后补充的 Speech 状态提示及“已知路径直接使用、缺少定位才查询”的指令文字调整，分别重跑相关 16 项回归通过，并再次通过类型检查和构建。
- 实际 Runtime 接线回归执行了文件写入 → 模拟模型断线 → 关闭并重开同一 Session → 普通自然语言接续 → 读取已有文件。模型调度由确定性执行器替代，不调用真实 Provider。
- `npm run build`、`npm run test:package`、`git diff --check` 通过。
- `npm run check:repo` 的 hygiene、release consistency、dependency direction 通过；asset boundary 仍因原有 `meeting-notebooklm-km-skill` 未纳入资源清单失败，本轮未改该资源或清单。未运行完整 coverage CI 或真实 Provider 评估。

## 正式服务切换

确认排队/运行任务均为零后，通过已有备份入口保存 `20260907-result-continuity` 备份（12168 个文件，数据库 integrity=ok），然后正常停止、构建并重启，没有批量重试生产任务、清除历史死信、重建简报或播放用户设备音频。

新进程 PID 52172，build suffix `b8752b9724ac`；`mimi daemon status` 正常响应，`mimi daemon doctor` 确认 installed/running 构建完全一致。两个已启用 Connector 均在线且 ready。历史 dead letter、Digest 积压、自主任务预算与 Computer observation 警告仍然保留，不将此次上线表述成全系统健康。

## 改动位置

- `src/core/tool-result.ts`、`run-finalization.ts`、`session.ts`：结果分类、文件引用、原子进度保存。
- `src/runtime/pipeline/run-fact-collector.ts`、`run-pipeline.ts`、`tool-set-builder.ts`，以及 `src/runtime/session-state.ts`、`instructions.ts`、`tool-policy.ts`：真实工具结果接入、接续上下文和工具披露。
- `src/daemon/task-history-tools.ts`、`task-store.ts`、`host-tools.ts`、`policy.ts`、`store.ts`：历史查询与租约失败记录。
- `src/runtime/speech-output.ts`、`speech-tools.ts`、`src/core/managed-process.ts`、`src/tools.ts`：持久音频、已有文件播放、进程生命周期和写文件路径回执。
- `tests/result-continuity.test.ts`、`task-history-tools.test.ts`、`managed-process.test.ts`；同步 README、ARCHITECTURE、CHANGELOG 与本审计记录。

边界：历史记录受既有保留期限制，旧任务不会自动回填缺失产物；旧版进程内音频 ID 无法追溯。没有后端完成确认的超时生成会保持未确认，不会因为文件出现便自行改判完成；此类后端仍需要可查询完成/取消协议，才能可靠自动恢复。宿主修复消除了上述具体缺口，但不等于保证所有模型永不偏题或所有任务必然成功。
