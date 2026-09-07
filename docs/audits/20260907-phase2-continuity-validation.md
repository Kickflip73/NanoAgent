# 第二阶段持续任务验证记录

分支：`codex/phase2-continuous-tasks`，基于 `02e0cec`。日期：2026-09-07。

## 实现与验证边界

复用现有 Event/Task/Session/Schedule/Outbox；本轮增加完成后的原对话核查、Schedule 上下文与上次结果、同计划未完成实例去重、使用统计，并修复 SDK 连接异常分类及状态查询的历史统计负担。没有新增工作流平台或关键词路由，也没有改变用户原有权限配置。

自动测试覆盖了 SQLite 原子提交、重启、重复结算、取消计划、旧库迁移、Host/Dispatcher/工具的核查及定时接续、静默完成、统计缺失值、写锁争用。该集成测试中的模型决策由可控执行器提供，不能替代真实模型评估。

## 真实模型运行：部分通过，未验收完成

使用隔离目录 `/tmp/mimi-phase2-live.o0Q1m4`，只读复用现有 Provider 配置。独立 Daemon 前台进程启动，没有安装/改写全局 LaunchAgent；Connector 全部关闭，通知送到本地控制台；未向正常会话、计划或外部业务系统写入测试数据。

实际场景：委派 Mimi 后台创建 `proof.txt` → 原对话核查 → 约 30 秒后再检查并创建 `followup.txt`。

- 提交客户端断开后，后台独立执行成功，`proof.txt` 内容确为 `phase-two-ok`。
- `task.completed` 自动创建了原 `phase2-smoke` Session 的核查任务，继承同一 authority，后台原始完成结果没有重复通知。
- 核查任务调用模型时遇到 `HTTP 402`，记录为 `provider.http_402`，失败通知成功投递。不能仅凭状态码判断是余额、套餐还是网关路由策略问题。
- 没有生成后续 Schedule/`followup.txt`，因此真实模型全链路**尚未通过**。没有自动切换付费模型，也没有重放后台已完成的文件写入。
- 测试进程已停止，临时证据保留。正式 Daemon 的既有 3 个活动对话未强制中断。

## 性能证据与限制

对正式数据库执行只读方法对比（三次）：旧 `activitySnapshot(1)` 为 469/70/69ms，新 `healthSnapshot()` 为 1/1/1ms。它只证明被替换的统计调用变轻，不是完整 IPC 响应或所有超时已修复的保证。

SDK 连接错误曾以 `.name === 'Error'` 漏过可重试分类；回归使用真实 `APIConnectionError` / `APIConnectionTimeoutError` 类型。只恢复原有有界重试，不自动重放 uncertain 副作用。

真实 trace 还显示后台写文件+读取核对耗时约 105 秒，调用 12 次工具，其中包括建 Goal/Plan、四次计划更新和三次 finish_task；累计输入 Token 约 14.3 万（各轮合计，不是单个提示词长度）。后台 Playbook 的“开始时建立或恢复 Goal/Plan”是一个明确的流程膨胀来源。本轮据此改为：简单后台工作直接完成，复杂或已有持久 Goal 才用对应计划与完成契约；没有改成关键词判断，也没有放松现有 Goal 的完成校验。该提示词修正通过策略回归，但由于 HTTP 402，尚未取得修正后的真实模型耗时对比。

## 已执行检查

- `npm run check`、`npm run build`、`npm run test:package` 通过。
- 全量测试最终重跑 998/998 通过；期间既有 macOS Desktop Connector 测试曾偶发失败，单独重跑 2/2 和随后全量重跑均通过。此后简单后台 Playbook 的文字修正另行跑策略与持续任务回归。
- `git diff --check` 通过。
- `npm run check:repo` 的 hygiene、release consistency、dependency direction 通过；asset boundary 因已存在但未登记进清单的 `meeting-notebooklm-km-skill` 失败，本轮未修改该技能或清单。

下一步：恢复当前 Provider 的可用性后重跑真实核查与定时接续，再在无活动任务或用户同意中断的情况下切换正式 Daemon。长时间睡眠/断网与真实复杂任务质量仍需后续使用验证。

## 14:41 运维恢复补充

用户明确要求处理、重启并恢复后，实测 Friday `deepseek-v4-pro` 返回 HTTP 402，正文明确为 Credit 已耗尽。DeepSeek 官方同名模型和既有 GeniusRD `gpt-5.6-sol` 小请求检查通过。

- 备份用户模型配置和 SQLite 数据库后，通过既有 `ModelConfigStore` 原子更新默认、`conversation.default` 与 `agent` 路由到 `deepseek/deepseek-v4-pro`，routeVersion 从 27 升至 28；保留全部登记模型、其他场景路由和用户历史任务。
- 无活动任务时正常停止服务，重新构建并启动第二阶段代码；新正式进程 PID 48077，build suffix `f1c5713a7a0a`。未强制中断任务或批量重放失败记录。
- 原模型登记会话的恢复核验任务 `c0645bd1-5b91-4a97-91e3-9df4218cf167` 于 14:41:41 完成：实际绑定官方 DeepSeek，`inspect_capabilities`、`model_control` 工具成功，最终回答正常返回；未重放登记命令。
- 四项新增登记（DeepSeek vision-exp、GeniusRD gpt-6/gpt-6-astra、Ollama deepseek-r1:14b）的极小文本请求均获成功 HTTP 响应。这只验证基础接口可调用，不代表视觉、推理、工具调用等完整能力已验收。
- 本轮重新运行 `npm run check`、持续任务与重试策略测试（12/12）及 `npm run build`，均通过。

服务仍有历史任务/投递死信、摘要积压、自主任务预算和电脑能力就绪警告。没有清除这些记录或改变预算；音频历史产物复用问题、第二阶段真实后台核查与定时接续全链路仍未完成验收。
