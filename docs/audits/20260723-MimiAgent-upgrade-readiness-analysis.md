# MimiAgent 现状深度分析与升级改造基线

> 日期：2026-07-23
> 基线分支：`codex/mimi-agent-hardening`
> 基线提交：`4130461 memory-LLMWiki`
> 文档用途：作为后续升级改造的范围定义、风险排序、架构决策和验收基线
> 结论置信度：高（代码、测试、配置、提交历史和打包清单已交叉核对；真实 Provider 与在线 Daemon 未在本轮复验）

## 1. 执行摘要

MimiAgent 已不再是一个简单的 CLI Agent，而是一个具备本地常驻控制面、可靠事件链、会话隔离、后台任务、多 Agent 编排、长期记忆和多渠道 Connector 的个人 Agent 系统。

项目最有价值的资产不是某个单独工具，而是已经形成的几组系统级不变量：

- 一个常驻 Kernel 统一持有事件、任务、投递和 Connector 生命周期。
- 同一 Session 严格 FIFO，不同 Session 有界并发。
- Event / Task / Run / Outbox 具备持久化、租约、重试和不确定副作用保护。
- 外部内容作为不可信数据处理，工具权限由来源、部署档位和运行模式共同收敛。
- Session、Memory、Goal、Plan、Team、Execution Ledger 各自有明确的持久语义。
- OpenAI 与 DeepSeek 共享能力层，GUI、MCP、Connector、SubAgent 和 Team 均为可选扩展。

这些方向是正确的，升级不应推倒重来。

当前阻碍项目继续扩张的主要问题也已经发生变化：首要风险已不是“功能不够”，而是“可信交付能力落后于功能复杂度”。主要表现为：

1. **仓库已经包含真实认证材料和个人 QQ 数据库，属于立即处理的安全事件。**
2. **最近一轮架构升级中，源代码增长约 26%，测试代码却减少约 38%，大量 Daemon 核心回归测试被删除。**
3. **依赖安装缺少唯一约束：锁文件基线与包声明允许的更新版本行为不一致，更新后的 Agents SDK 会直接拒绝当前 Computer Tool schema。**
4. **关键实现集中在少数超大文件中，`store.ts`、`mimi-agent.ts`、`service.ts` 和 `tools.ts` 同时承担过多变化原因。**
5. **版本、Changelog、打包产物和仓库内容存在明显漂移，发布基线不再可信。**
6. **产品定位仍强调“轻量”，但当前默认能力、平台授权和运维复杂度已经接近一个本地 Agent 操作系统。**

综合判断：

| 维度 | 当前判断 | 说明 |
|---|---:|---|
| 产品能力完整度 | 8/10 | 主动事件、长期任务、Memory、Connector、CLI 已形成闭环 |
| 核心架构方向 | 8/10 | 单 Kernel、Session actor、Task worker、可靠 Outbox 方向合理 |
| 可靠性设计 | 7/10 | 语义设计较强，但近期大规模删测削弱了可信度 |
| 安全设计 | 7/10 | 运行时边界考虑充分，仓库与供应链治理出现严重破口 |
| 可维护性 | 5/10 | 模块命名清晰，但热点文件、反向依赖和职责集中明显 |
| 测试与验证 | 4/10 | 原有基础较好，当前关键 Daemon 回归覆盖大幅收缩 |
| 发布与工程治理 | 3/10 | 版本漂移、依赖漂移、仓库污染、缺少秘密扫描 |
| 可观测与运维 | 5/10 | 有 Doctor、Audit、Trace 和状态接口，缺少统一 SLO 与健康度闭环 |
| 跨平台性 | 4/10 | 核心可跨平台，产品高价值能力和测试实际强依赖 macOS |
| 升级可行性 | 8/10 | 适合冻结扩张后分阶段治理，不需要重写 |

**建议决策：暂停继续横向增加 Connector、工具和长期状态类型，先完成一个“可信基线恢复版本”。**

## 2. 本轮分析范围与方法

### 2.1 覆盖范围

- 产品入口：`README.md`、CLI、交互终端、命令系统。
- 架构与规范：`AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/ATTENTION.md`、`docs/CONNECTORS.md`、`SECURITY.md`。
- 核心运行时：`src/runtime/`、`src/core/`、`src/tools.ts`。
- 扩展能力：Skills、MCP、MemoryHub、SubAgent、Team、Computer Use。
- 常驻系统：Event、Task、Run、Outbox、Schedule、Attention、Connector、IPC、Supervisor。
- 工程系统：依赖、TypeScript、测试、CI、打包、版本、Git 仓库卫生。
- 历史变化：重点比较 2026-07-20 安全加固基线 `478b19e` 与当前 `HEAD`。

### 2.2 使用的方法

- 静态阅读关键模块和架构文档。
- 统计源代码、测试代码、文件规模和测试声明数量。
- 检查模块依赖方向、SDK 耦合和直接环境变量访问。
- 检查 Git 跟踪文件、疑似秘密、数据库和生成产物。
- 对比最近提交的新增、删除和版本变化。
- 使用 `npm pack --dry-run --ignore-scripts` 检查发布清单。
- 尝试按锁文件和非锁定依赖两种方式执行类型检查与测试。

### 2.3 验证限制

- 当前 Codex 桌面 Shell 没有系统 `node` / `npm` PATH。
- 使用非锁定 pnpm 依赖树试跑时，392 项测试中 375 项通过、17 项失败；其中多数 macOS Connector 失败来自子进程找不到 `node`，不能归因于产品代码。
- 非锁定依赖树还暴露了两类有效问题：
  - `@openai/agents-core 0.13.5` 拒绝当前 Computer Tool 中 `.optional()` 但不 `.nullable()` 的参数 schema。
  - 一个 Event/Task retention 断言失败，需要在标准 npm 锁文件环境中复验。
- 随后尝试通过 `package-lock.json` 恢复标准 npm 依赖树，但 npm 镜像与官方源均未在合理时间内完成。因此本轮没有宣称当前 `npm run ci` 已通过。
- 2026-07-20 审计记录的锁定依赖基线曾通过 568 项测试、覆盖率门禁、构建和包烟测；该结果不能替代当前提交的重新验证。
- 本轮没有调用真实 OpenAI/DeepSeek、发送消息、操作桌面、启动或停止用户 Daemon。

## 3. 当前系统画像

### 3.1 代码与仓库规模

| 区域 | TypeScript 文件 | 行数 |
|---|---:|---:|
| `src/core` | 18 | 3,282 |
| `src/runtime` | 17 | 3,410 |
| `src/extensions` | 18 | 4,097 |
| `src/daemon` | 39 | 14,125 |
| `src/` 根模块 | 10 | 3,875 |
| **全部源码** | **102** | **28,789** |
| **测试** | **53 个主测试文件** | **13,920** |
| **测试声明** |  | **390** |

Daemon 已占全部 TypeScript 源码约 49%，说明项目的主要复杂度已经从模型循环转移到长期状态、可靠执行和系统集成。

最大的实现热点：

| 文件 | 行数 | 主要职责 |
|---|---:|---|
| `src/daemon/store.ts` | 3,054 | Schema、迁移、Event/Task/Run/Outbox、Schedule、Memory observation、retention |
| `src/runtime/mimi-agent.ts` | 1,697 | 组合工具、运行指令、Session、上下文、完成门控、运行时效果 |
| `src/daemon/service.ts` | 1,544 | Daemon 生命周期、launchd、组件装配、IPC、资源协调 |
| `src/tools.ts` | 1,507 | 文件、Shell、HTTP、搜索、Patch、Git 等内置工具 |
| `src/daemon/attention.ts` | 954 | 注意力配置、决策、预算、规则、例程和设置 |
| `src/daemon/chat-client.ts` | 916 | Daemon 客户端与交互终端协调 |
| `src/daemon/dispatcher.ts` | 850 | 任务领取、执行、重试、抢占和投递 |
| `src/daemon/connectors.ts` | 752 | Connector 进程、协议、健康和重载 |

`npm pack --dry-run` 显示当前发布包：

- 包版本：`0.11.0`
- 文件数：566
- 压缩后约 1.05 MB
- 解包后约 4.55 MB
- 同时包含 `src`、`dist`、Source Map、类型声明、23 个 Connector 示例和 4 个打包 Skill

包体积本身尚可，问题在于版本和内容身份不清晰。

### 3.2 当前运行模型

```text
CLI / IM / Voice / Schedule / Webhook / Connector
                       |
                       v
             +-------------------+
             |  Daemon Kernel    |
             | Event / Task / DB |
             +---------+---------+
                       |
          +------------+-------------+
          |                          |
          v                          v
  Conversation Task           Background Task
  Session Actor FIFO          isolated OS worker
  cross-session bounded       Mimi / Codex executor
          |                          |
          +------------+-------------+
                       v
              Run + Outbox commit
                       |
                       v
            CLI / Connector / system
```

持久化语义已经从旧的“Event 既是事实又是工作项”演进为：

- Event：不可变事实、因果关系和审计时间线。
- Task：可执行工作、租约、重试、控制和生命周期。
- Run：Task 的一次 attempt。
- Outbox：独立投递和不确定结果保护。
- Session：用户可见原始对话与模型运行偏好。
- Goal / Plan / Team / Checkpoint：长期任务的进展与验收。
- Execution Ledger：外部副作用的 at-most-once 保护。
- MemoryHub：Markdown Wiki 为可读知识面，SQLite 为检索、来源和抑制控制。

这套模型比传统“把所有状态塞进对话历史”的 Agent 架构可靠得多，是后续升级应保留的核心。

## 4. 做得较好的部分

### 4.1 Session 与并发所有权

`MimiHost` 使用 keyed Session actor：

- 同 Session 通过 lane 串行。
- 跨 Session 通过 semaphore 有界并发。
- 执行 ID 可取消。
- actor 有缓存和空闲回收。
-完成回执可避免 Host 事务提交前崩溃造成重复模型执行。

这与“一个用户会话只有一个状态所有者”的不变量一致。

### 4.2 可靠事件与外部副作用

当前代码明确区分：

- 可重试失败。
- 已确认成功。
- 不确定成功，不允许静默重放。
- 投递失败与业务任务失败。
- Event 事实与 Task 生命周期。

`ExecutionLedger`、Outbox lease、Connector idempotency key、Task attempt 和 Event route receipt 共同形成了较完整的恢复语义。这是项目最难复制的工程能力之一。

### 4.3 权限与不可信内容隔离

权限不是只写在 Prompt 中，而是通过工具选择和策略收敛：

- Plan 固定只读。
- 本地 permission mode 控制文件和 Shell。
- 外部事件默认无通用本地、网络、Memory 和外部事务能力。
- source policy 明确区分 `reply` 和 `work`。
- Task 从原始 authority Event 重新计算权限。
- MCP 工作区信任、Connector action、Computer Use、SubAgent 和 Team 有各自的边界。
- Shell 已有最小环境和进程组回收设计。
- HTTP 已有私网、重定向和跨源写限制。

安全文档对同 UID、本地 Shell、macOS 权限和外部内容边界的描述相对诚实，没有把应用层限制夸大成 OS 沙箱。

### 4.4 持久状态与迁移意识

项目对长期状态的主要危险已有明确意识：

- JSON 状态通过锁和原子替换。
- SQLite 使用 WAL、`STRICT` 表、外键检查和 `BEGIN IMMEDIATE`。
- Event 表有不可变触发器。
- v12 Event/Task cutover 有计数与外键校验。
- v13 MemoryHub、v14 route repair 在迁移前创建数据库备份。
- 对半迁移、损坏行和 poison row 有 fail-closed 或隔离路径。

这比“只要迁移脚本能跑完”高一个成熟度等级。

### 4.5 MemoryHub 的信息架构

MemoryHub 已开始区分：

- 用户私有事实。
- 工作区知识。
- Session episode。
- 外部/public observation。
- 来源 receipt、内容 digest、forget suppression。
- Wiki 可读页面与 SQLite 派生索引。

并且禁止单条外部观察直接升级为 active Memory，能降低 Prompt Injection 通过长期记忆固化的风险。

### 4.6 开发契约清晰

`AGENTS.md` 对模块边界、不变量、测试标准、数据安全和变更范围的要求清楚，已经具备成为工程治理入口的条件。问题主要是近期提交没有持续满足它，而不是规则本身缺失。

## 5. 多维度现状分析

### 5.1 产品定位：能力领先，边界描述滞后

当前产品同时覆盖：

- 交互式个人助手。
- 7×24 主动 Agent。
- 本地自动化与 Computer Use。
- IM、邮件、日历、提醒、浏览器、屏幕、语音和文件雷达。
- 开发任务与 Codex 后台执行。
- Memory Wiki。
- 多 Agent 编排库。

这已经不是通常意义上的“轻量 Agent”。“轻量”只能解释为：

- 不引入外部队列、ORM 和工作流平台。
- 单机、本地优先。
- 依赖数量相对受控。

它不能再解释为“能力简单、授权面小、运维成本低”。

建议重新明确一句主定位：

> MimiAgent 是面向单一可信用户的、本地优先、可长期运行并对真实系统执行工作的个人 Agent Runtime；它不是多租户沙箱，也不是通用分布式工作流平台。

同时把能力分成三个产品层级：

1. Core：CLI、Session、Memory、文件/网络只读。
2. Always-on：Daemon、Attention、Schedule、Task、Outbox。
3. Device integrations：Connector、Computer Use、IM 和 macOS 权限。

首次安装不应让用户在不知道风险的情况下自动进入第三层。

### 5.2 架构边界：方向清楚，实现仍有反向依赖

文档规定：

```text
CLI / Daemon -> runtime -> core + extensions + tools
extensions -> core
core -X-> runtime / CLI / daemon
```

当前主要偏差：

- `extensions/subagents.ts` 和 `extensions/team.ts` 依赖 `runtime/model.ts`、`runtime/instructions.ts`、`runtime/tool-policy.ts`。
- `core/plan.ts`、`core/team.ts` 直接创建 OpenAI Agents SDK Tool。
- `core/session.ts`、`core/context.ts` 直接使用 Agents SDK Session/Input 类型。
- `daemon/chat-client.ts` 直接依赖 `interactive.ts`。
- `runtime/components.ts` 直接读取 `process.env` 创建 Embedding Client，配置来源未完全收口到 `AppConfig`。

这些耦合短期不会导致功能错误，但会造成：

- core 语义难以独立测试和复用。
- SDK 升级影响持久状态层。
- CLI/Daemon 边界难以复用到其他前端。
- 工具策略与扩展实现相互引用，增加循环演进风险。

建议采用端口适配器，而不是引入新框架：

- core 只定义状态、schema、domain service 和端口。
- runtime 提供 Agents SDK Tool adapter。
- extensions 接收 `ModelPort`、`ToolCatalogPort`，不导入 runtime。
- CLI adapter 持有 `InteractiveTerminal`，Daemon client 只处理 RPC。
- 所有环境变量在 bootstrap 一次解析为不可变配置。

### 5.3 Daemon 与数据库：语义成熟，物理结构过度集中

`src/daemon/store.ts` 同时承担：

- 数据库初始化和 PRAGMA。
- 14 个 schema 版本的演进。
- Event/Task 路由。
- Task claim、attempt、lease、控制和恢复。
- Run、Outbox、Schedule、Digest。
- Memory observation 和 maintenance。
- retention、quarantine、audit。

3,054 行并不只是“文件太长”，而是多个变化频率不同的子系统共享同一个修改热点。任何新表、新生命周期或 retention 规则都可能触碰它。

应拆为：

```text
daemon/persistence/
  database.ts              连接、PRAGMA、事务协调
  schema/
    current.ts             新库 schema
    migrations/            一版本一文件，显式 pre/post check
  repositories/
    event-repository.ts
    task-repository.ts
    run-repository.ts
    outbox-repository.ts
    schedule-repository.ts
    memory-observation-repository.ts
  maintenance/
    retention.ts
    integrity.ts
```

事务仍由一个 `MimiStore` facade 或 `UnitOfWork` 协调，避免把原子操作拆散。目标是降低修改耦合，不是引入 ORM。

### 5.4 Runtime：组合根正在变成第二个平台内核

`src/runtime/mimi-agent.ts` 已包含：

- 工具集合构造。
- Skill/MCP/Memory/Computer/Team/SubAgent 接入。
- Session 切换。
- Instructions 和上下文。
- Completion Contract。
- 用户意图和渐进式工具披露。
- Ledger 和 Runtime Effects。
- Provider 运行前后处理。

建议拆分为内部协作者：

- `RunContextBuilder`
- `CapabilityResolver`
- `ToolCatalog`
- `CompletionCoordinator`
- `SessionRuntime`
- `RuntimeEffectCollector`

`MimiAgent` 保持 facade 和一轮运行编排，不再直接拥有所有策略细节。

### 5.5 工具与能力策略：中心化是优点，双重登记是风险

`TOOL_POLICY` 已经集中记录 capability、mode、role 和 side effect，这比散落判断更可靠。但工具定义与策略登记仍是两个来源：

- 新工具可能被创建但忘记加入策略。
- 工具重命名可能导致 fail-closed，但运行时体验突然退化。
- 动态 MCP/Connector 工具与静态内置工具的元数据来源不同。

建议建立唯一 `ToolDescriptor`：

```ts
interface ToolDescriptor {
  name: string;
  create: (...) => Tool;
  capabilities: ToolCapability[];
  modes: AgentMode[];
  sideEffect: boolean;
  roles: ...;
}
```

静态工具从 descriptor 同时生成 Tool 和 policy；动态工具通过同一规范注册。继续保留未知工具 fail-closed。

### 5.6 MemoryHub：方向正确，需明确唯一事实源和修复模型

MemoryHub 同时使用：

- Markdown Wiki/Vault。
- SQLite FTS5/BM25。
- 可选 embedding + RRF。
- source receipts。
- maintenance Task。
- semantic lint、Error Book、episode retention。

主要风险不是检索算法，而是“双存储 + 异步编译”带来的状态组合：

- Markdown 已更新，索引未更新。
- 索引存在，来源已变化。
- forget suppression 与重新 ingest 竞态。
- maintenance Task 失败后 observation 长期堆积。
- 私有 profile、workspace 和 episode 视图边界发生漂移。

升级时必须明确：

- Markdown 是用户可读的 canonical knowledge。
- SQLite 是可重建的索引与控制状态；不能成为无法导出的隐藏真相。
- 每个派生项必须能追溯 source digest 和 compiler version。
- `rebuild`、`doctor`、`backup`、`restore` 必须可演练。
- embedding 不可用只能降低排序质量，不能阻止基本 recall。

### 5.7 Connector：产品价值高，也是最大授权面

项目拥有 23 个 Connector 示例，macOS 默认可启用多种系统能力。优点是：

- Connector 在独立进程中。
- 使用 NDJSON 和 action catalog。
- 有 event ACK、健康、重载、超时和 idempotency。
- 凭证不进入主模型 Shell。

风险是：

- Mail、Messages、Contacts、Notes、Browser、Screen、Voice、Desktop 的组合权限接近完整用户身份。
- macOS 权限弹窗、Accessibility、Full Disk Access 和 Browser Automation 不是统一的应用层权限。
- 非官方 QQ 路径包含账号风控和供应链风险。
- Connector 进程存活不等于业务 API、轮询或发送真正可用。
- 当前 CI 只有 Ubuntu，无法验证主要 macOS 能力。

建议：

- 首次启动改为 capability onboarding，按能力组逐一启用。
- 默认只启用无敏感系统授权的最小 Core。
- readiness 至少区分 `process`、`protocol`、`read`、`write`、`poll`。
- 为 Connector 建立统一 contract test harness 和故障注入。
- macOS CI 跑协议与 mock integration；真实权限测试保留为受控 nightly/manual。

### 5.8 安全：运行时设计较强，仓库治理出现 P0 事件

当前 Git 跟踪了：

- `data/auth_token.txt`：270 字节、高熵样式认证材料。
- `data/machine_guid.bin`：设备标识。
- `guild1.db`：192 KB QQ Guild SQLite 数据库，包含 ChannelAuthStore、用户资料、频道和消息列表等表。

其中认证材料和设备标识在提交 `4130461` 中进入仓库；QQ 数据库更早已被跟踪，并在该提交中从约 4 KB 增长到 192 KB。无论仓库当前是否公开，都应按凭证与个人数据已泄露处理：

1. 立即撤销/轮换对应 Token、会话和设备身份。
2. 从当前树移除。
3. 评估 Git 历史清理；如果已推送，历史重写前先协调所有协作者。
4. 检查 Release、CI artifact、镜像、Fork 和缓存。
5. 增加秘密扫描和禁止运行数据提交的 CI。

`.gitignore` 当前没有覆盖：

- `data/`
- `*.db`、`*.db-wal`、`*.db-shm`
- `.playwright-cli/`
- 本地截图和录屏产物
- 本地 Connector 身份文件

这说明安全问题不是单个误操作，而是仓库防线缺失。

此外，`trusted` owner Shell 等同当前用户权限，11 类 macOS Connector 和 Computer Use 可叠加授权。建议明确三个安全档：

- Safe：只读工作区，无设备 Connector，无 Computer。
- Workstation：工作区写入 + 经选择的 Connector。
- Full Owner：Shell、Computer、敏感系统 Connector。

每个档位在 `/status` 中显示当前有效能力和风险摘要。

### 5.9 测试：从优势变成当前最大工程风险

从 `478b19e` 到当前 `HEAD`：

| 指标 | 旧基线 | 当前 | 变化 |
|---|---:|---:|---:|
| TypeScript 源码行数 | 22,790 | 28,789 | +26.3% |
| 测试代码行数 | 22,321 | 13,920 | -37.6% |
| 测试/源码行数比 | 0.98 | 0.48 | -51.0% |
| 已记录通过的测试数/当前声明数 | 568 | 390 | -31.3% |

被删除的测试包括：

- `daemon-store`
- `daemon-dispatcher`
- `daemon-policy`
- `runtime-event-policy`
- `daemon-service`
- `daemon-connectors`
- `daemon-chat-client`
- `daemon-schedule-tools`
- `daemon-task-tools`
- `daemon-attention`
- 多个配置写工具与 Webhook 测试

而同期恰好发生了：

- Event / Task v12 cutover。
- MemoryHub v13。
- route repair v14。
- Codex task executor。
- Computer Use。
- 任务监督器和 CLI draft 重构。

这意味着风险最高的变化与测试收缩发生在同一时间。

当前测试仍有不少优点：

- 使用 `node:test`，依赖少。
- 大量临时目录和确定性 fixture。
- 对 Ledger、Session CAS、symlink、Context 协议、Team 并发有细粒度测试。
- `package.json` 设置了 85% 行、75% 分支、75% 函数覆盖率门禁。

但在重新执行 `npm run ci` 前，不能确认门禁仍能通过。即使总覆盖率通过，也不能替代以下关键不变量测试：

- Event 不可变、Task 唯一、route exactly-once。
- Task claim/lease/recovery/control 优先级。
- Run 与 Outbox 同事务终结。
- uncertain side effect 不重放。
- migration 前后计数、引用和语义一致。
- retention 不删除活引用。
- source policy 撤销后后台任务失权。
- Connector ACK/cursor 和投递不确定性。

### 5.10 依赖与可复现性：锁文件可靠，但包声明不可靠

当前：

- 提交 `package-lock.json`。
- 没有 `packageManager` 字段。
- 直接依赖大量使用 `^`。
- 没有 `overrides` 锁定 OpenAI Agents SDK 家族内部版本。

锁文件固定：

- `@openai/agents` / core / openai / realtime：`0.13.2`
- `openai`：`6.46.0`
- `zod`：`4.4.3`
- `ws`：`8.21.0`
- `typescript`：`5.9.3`

使用非 npm 安装器按 semver 重新解析后，`@openai/agents-core` 进入 `0.13.5`，当前 Computer Tool 的 optional schema 在工具创建阶段失败。这说明：

- 锁文件可保护标准 `npm ci`。
- `package.json` 表达的兼容范围并不真实。
- 本地使用不同安装器或重新生成 lockfile 会得到不可运行组合。

建议：

- 增加 `"packageManager": "npm@<固定主次版本>"`。
- 对 SDK、OpenAI、Zod、ws 使用精确版本；至少 SDK 家族必须一致。
- 使用 `overrides` 强制 `@openai/agents-*` 同版本。
- CI 增加 `npm ci` 后 lockfile clean 检查。
- 增加一个“允许升级依赖”的独立兼容任务，不与稳定 CI 混为一谈。
- 新 SDK 升级必须运行 Tool schema contract tests。

### 5.11 发布治理：版本身份已经失真

当前 `package.json` 和 `package-lock.json` 版本仍为 `0.11.0`，但 `CHANGELOG.md` 已记录：

- `0.11.1`
- `0.11.2`
- `0.11.3`
- `0.11.4`
- `0.11.5`
- `0.11.6`
- `0.11.7`

同时存在三个 `Unreleased` 区域。`npm pack` 仍会生成 `mimi-agent-0.11.0.tgz`，但内容包含后续全部功能。

后果：

- Daemon build identity 与 npm semver 对用户表达不同事实。
- 无法判断 Bug 属于哪个发布版本。
- Changelog 不能可靠驱动升级说明。
- 回滚、兼容矩阵和数据迁移支持范围难以定义。

建议：

- 先确定当前代码应成为 `0.12.0` 还是新的预发布版本。
- 合并 `Unreleased`。
- 自动生成或校验 package、lockfile、tag、Changelog 一致性。
- 发布流水线必须从干净 tag 构建、执行 `npm run ci`、生成 SBOM/清单并验证 packed package。
- 数据库 schema 版本和应用版本建立显式兼容表。

### 5.12 仓库边界：主产品仓库已经混入工作区产物

当前主仓库还跟踪：

- `.playwright-cli/` 页面快照。
- Unity 游戏项目 `projects/echoes-of-another-world/`。
- 3D portfolio 项目和根级 HTML。
- 大体积 GIF/PNG 预览。
- `air_mouse.py`、`finger_recognition.py`。
- 33 个 Skill 目录，但发布包只包含 4 个。
- 个人知识与研究产物。

这些内容不一定都无价值，但缺少分类会带来：

- Secret/个人数据更容易混入。
- Code review 信噪比降低。
- “MimiAgent 产品代码”和“由 MimiAgent 生成的用户工作”边界消失。
- 包含策略、CI、License、维护人和发布范围不清晰。
- Agent 自己在工作区生成成果时可能再次提交到产品仓库。

建议优先采用最小治理：

- `src/`、`tests/`、`docs/`、正式 `skills/`、正式 `examples/` 留在主仓库。
- 用户项目迁出主仓库，或进入明确的 `playground/` 且默认忽略生成物。
- 浏览器快照、数据库、截图、Token、模型产物默认忽略。
- 建立 `skills/manifest.json` 或同类正式清单，明确哪些 Skill 是产品资产。
- CI 检查包声明和正式资产清单的一致性。

### 5.13 可观测性与运维：有数据，缺少服务等级定义

已有：

- Run、Audit、Trace、Task、Outbox、Dead Letter。
- `daemon status`、`doctor`、activity、capability 检查。
- build identity。
- Connector health 和 readiness。
- retention 与历史维护。

缺少：

- 统一的健康状态模型和严重级别。
- 每类 Task/Connector 的成功率、延迟、重试和 backlog 指标。
- 日志轮转与容量预算。
- 数据库大小、WAL、checkpoint、fragmentation 和备份状态。
- Session/Memory/Outbox 的 SLO。
- 一键生成脱敏诊断包。

建议定义本地 SLO：

- Event 入库成功率。
- Task terminal success / blocked / dead-letter 比例。
- Outbox confirmed / uncertain / failed 比例。
- Connector poll freshness。
- Session 排队时延。
- Memory recall 时延和 observation backlog。
- 数据库迁移、备份、恢复最近一次成功时间。

### 5.14 性能与容量：设计有界，但缺少基准

当前很多接口已有 limit、分页和预算，是良好基础。潜在瓶颈：

- SQLite `BEGIN IMMEDIATE` 下长事务阻塞所有写入。
- `store.ts` 的维护与迁移会对控制面产生集中压力。
- Session JSON transcript 长期增长。
- Memory Wiki + FTS + embedding 重建成本。
- Connector 风暴和 Digest backlog。
- 多个 macOS Connector 轮询叠加。
- Task 子进程和 Codex 进程并发带来的 CPU/内存峰值。

建议建立本地 benchmark：

- 10k / 100k Event 入库、路由、claim、retention。
- 1k Session、单 Session 10k round 的读取与 compact。
- 100k Memory item 的 lexical recall 与 rebuild。
- 100 个 Connector event burst。
- 4 个 Session actor + 4 个 read task + 1 个 write task 的调度公平性。
- 迁移 v11→v14 的时间、磁盘峰值和失败恢复。

### 5.15 Provider 与模型质量：能力抽象存在，证据不足

项目努力保持 OpenAI/DeepSeek 对齐，并有：

- provider-bound Session model preference。
- Context Window profile。
- DeepSeek reasoning delta。
- strict schema 和工具兼容处理。
- `evals/` 与 opt-in `eval:agent`。

不足：

- `evals` 数据量很小。
- 没有稳定的 provider contract fixture 套件。
- 真实 Provider 评测不是常规发布门禁。
- Tool schema 对 SDK 小版本变化敏感。
- Completion、Memory 和主动决策缺少质量趋势基线。

建议维护三类评测：

1. 无网络协议测试：流、tool call、错误、取消、上下文 trim fixture。
2. 小规模真实 Provider canary：OpenAI/DeepSeek 各自固定任务。
3. 产品质量 eval：记忆召回、权限拒绝、长期任务恢复、外部内容注入。

## 6. 风险清单与优先级

### 6.1 P0：升级前必须处理

| ID | 风险 | 影响 | 建议 |
|---|---|---|---|
| P0-01 | Git 中存在认证材料、设备标识和 QQ 私人数据库 | 凭证滥用、个人数据泄露、合规与账号风险 | 轮换、移除、评估历史清理、扫描所有远端副本 |
| P0-02 | Daemon 关键测试大幅删除 | 迁移、重试、投递、权限回归可能无预警进入发布 | 恢复/重写不变量测试，重新通过 coverage 和完整 CI |
| P0-03 | 依赖范围允许不兼容 SDK 组合 | 安装方式或 lockfile 更新后 Tool 在启动时失败 | 固定安装器、精确版本、SDK overrides、schema contract test |

### 6.2 P1：可信基线版本应处理

| ID | 风险 | 影响 | 建议 |
|---|---|---|---|
| P1-01 | package 仍为 0.11.0，Changelog 已到 0.11.7 | 发布、回滚、支持范围失真 | 统一版本、tag、Changelog、build identity |
| P1-02 | `store.ts` / `mimi-agent.ts` / `service.ts` 过度集中 | 修改冲突、审查困难、回归半径大 | 保持单体，按事务/策略/适配器拆模块 |
| P1-03 | core、runtime、extensions 和 CLI 存在反向依赖 | SDK 升级和复用成本高 | 引入少量端口接口，Tool adapter 上移 |
| P1-04 | 只有 Ubuntu CI，主要能力依赖 macOS | Connector 和权限相关问题无法持续验证 | 增加 macOS mock/contract CI |
| P1-05 | 主仓库混入用户项目与运行产物 | 再次泄密、审查噪音、发布边界不清 | 仓库分区、忽略规则、正式资产 manifest |
| P1-06 | 数据迁移与 retention 测试不足 | 长期用户状态损坏或误删 | golden DB、故障注入、前后语义校验 |

### 6.3 P2：稳定版前处理

| ID | 风险 | 影响 | 建议 |
|---|---|---|---|
| P2-01 | 默认能力和 macOS 授权面过大 | 用户难以理解实际授权 | capability onboarding 与安全档位 |
| P2-02 | 健康度和 SLO 不统一 | 进程在线但业务失效难以发现 | 统一 health model、指标和脱敏诊断 |
| P2-03 | MemoryHub 双存储修复语义复杂 | 索引/来源/抑制漂移 | canonical source、rebuild/doctor/restore |
| P2-04 | Tool 定义与 Tool policy 双重登记 | 新工具暴露或隐藏错误 | 单一 ToolDescriptor |
| P2-05 | 缺少性能容量基准 | 长期积累后才暴露退化 | 建立本地容量与迁移 benchmark |
| P2-06 | 公共 API 暴露较多 runtime/core 类型 | 重构容易造成 semver 破坏 | 定义稳定 API 层与 API 兼容测试 |

## 7. 建议的目标架构

不建议立刻拆成多个服务或引入工作流引擎。目标应是“边界更清晰的模块化单体”：

```text
Adapters
  CLI / IM / Voice / Webhook / Connector / launchd
                         |
                         v
Application
  MimiHost / RunCoordinator / TaskDispatcher / CapabilityResolver
                         |
             +-----------+-----------+
             |                       |
             v                       v
Domain/Core Ports                Extension Ports
  Session / Event / Task           Memory / MCP / Skill
  Goal / Plan / Team               Computer / Provider
  Completion / Authority           Connector Actions
             |                       |
             +-----------+-----------+
                         v
Infrastructure
  SQLite repositories / JSON stores / Agents SDK adapters
  Filesystem / HTTP / Shell / macOS process adapters
```

约束：

- 一个 Daemon、一个 SQLite、一个 Host，不引入分布式事务。
- Event、Task、Run、Outbox 语义保持不变。
- 同 Session FIFO 与副作用不重放保持不变。
- core 不创建 SDK Tool。
- SDK、Shell、HTTP、SQLite、macOS 都是 adapter。
- `MimiAgent` 和 `MimiStore` 继续提供兼容 facade，内部逐步迁移。

## 8. 分阶段升级路线图

### Phase 0：安全止血与变更冻结（1～3 天）

目标：让仓库重新满足最低安全线。

- [ ] 轮换 `data/auth_token.txt` 对应的 Token/会话。
- [ ] 评估 `machine_guid.bin` 与 QQ 会话的撤销或重置。
- [ ] 从 Git 当前树移除 `data/`、`guild1.db*`。
- [ ] 评估并执行受控 Git 历史清理。
- [ ] 扫描远端、Release、CI artifact、Fork 和缓存。
- [ ] 扩充 `.gitignore`。
- [ ] 增加 gitleaks 或等价 secret scanning。
- [ ] 在完成 Phase 1 前冻结新 Connector、新持久表和新内置 Tool。

验收：

- 仓库和历史扫描无有效秘密。
- 所有已暴露凭证已轮换。
- CI 对同类文件提交 fail closed。

### Phase 1：恢复可信工程基线（1～2 周）

目标：能够回答“当前 HEAD 是否可发布”。

- [ ] 固定 npm 版本和全部关键依赖。
- [ ] 修复 Computer Tool 对新旧 SDK 均明确的 schema。
- [ ] 复验 retention 失败。
- [ ] 恢复被删除的 Daemon 不变量测试。
- [ ] 重新运行 `npm run ci`。
- [ ] 增加 macOS CI contract job。
- [ ] 统一 package/lockfile/Changelog/tag 版本。
- [ ] 清理多个 `Unreleased`。
- [ ] 建立发布 checklist 和 packed artifact 清单。

验收：

- `npm ci && npm run ci` 在干净环境通过。
- Ubuntu 与 macOS contract CI 均通过。
- 关键可靠性不变量具有显式测试。
- 当前代码拥有唯一、可解释的版本身份。

### Phase 2：拆解高风险热点（2～4 周）

目标：降低下一轮升级的回归半径。

- [ ] 拆分 `daemon/store.ts`，保留统一事务 facade。
- [ ] 将 migrations 变成按版本独立文件。
- [ ] 拆分 `runtime/mimi-agent.ts` 内部协调器。
- [ ] 让 core Tool 定义上移到 runtime adapter。
- [ ] 消除 extensions → runtime 反向依赖。
- [ ] 将终端交互从 Daemon RPC client 中移出。
- [ ] 统一 `ToolDescriptor`。

验收：

- 依赖方向有自动检查。
- 每个迁移有 golden DB、pre-check、post-check 和 rollback/backup 演练。
- 关键 facade 的公开行为不变。
- 不新增框架或运行时服务。

### Phase 3：产品安全与可运维性（2～4 周）

目标：让普通用户能理解、控制和诊断长期运行系统。

- [ ] 首次启动 capability onboarding。
- [ ] Safe / Workstation / Full Owner 三档安全配置。
- [ ] Connector 分层 readiness。
- [ ] 统一 health model 与 `/status` 风险摘要。
- [ ] 日志轮转和容量阈值。
- [ ] 数据库、Memory、Connector 脱敏诊断包。
- [ ] 一键 backup/restore/doctor 演练。
- [ ] Dead Letter、Digest backlog、poll freshness 告警。

验收：

- 用户可从状态页回答“现在有哪些系统权限和外部写能力”。
- 进程在线但业务失效能被识别。
- 备份可在空白环境恢复。

### Phase 4：性能、评测与稳定 API（持续）

目标：从“功能正确”进入“长期可演进”。

- [ ] 建立 Event/Task/Memory/Session 容量 benchmark。
- [ ] 建立 Provider contract fixture。
- [ ] 建立小规模真实 Provider canary。
- [ ] 建立权限与 Prompt Injection eval。
- [ ] 定义稳定公共 API 和兼容测试。
- [ ] 决定非产品项目、实验 Skill 和用户知识的最终仓库归属。

## 9. 建议的升级验收指标

### 9.1 安全

- Git 当前树和历史中有效秘密：0。
- 私人数据库和设备身份文件：0。
- 所有外部写工具都能在 Tool catalog 中被识别为 side effect。
- external/public 默认权限测试覆盖所有工具类别。
- 未知工具始终 fail closed。

### 9.2 可靠性

- Event 路由重复执行：0。
- 已确认或不确定副作用的自动重放：0。
- 迁移前后 Event/Task/Run/Outbox 引用丢失：0。
- retention 删除活引用：0。
- Connector ACK 前推进 cursor：0。
- 同 Session 并发写：0。

### 9.3 工程

- 干净环境 `npm ci && npm run ci`：通过。
- 行/分支/函数覆盖率不低于现有 85% / 75% / 75%。
- 可靠性关键状态机使用场景覆盖，不只看总覆盖率。
- package、lockfile、tag、Changelog 版本一致。
- Linux 核心 CI 与 macOS contract CI 均通过。

### 9.4 运维

- Doctor 能区分 process online 与业务 ready。
- 备份恢复演练成功。
- 10k backlog 下无任务永久饥饿。
- 日志和 SQLite 增长有明确上限或告警。
- 脱敏诊断包不包含 Event 正文、消息 target、Token 和私人 Memory。

### 9.5 产品

- 首次启动默认不自动获得高敏感 macOS 权限。
- 用户可查看、启用、关闭每类能力。
- `/status` 明确显示 provider、版本、workspace、权限档、Connector readiness、Task/Outbox backlog。
- CLI 退出不影响已持久化任务。

## 10. 建议的首批改造任务

按实际依赖关系排序：

1. **安全清仓**
   - 凭证轮换、私人数据库移除、历史评估、secret scan。
2. **基线重建**
   - 固定依赖、恢复标准 npm 环境、当前 HEAD 全 CI。
3. **测试补洞**
   - 优先恢复 `store`、`dispatcher`、`policy`、`service`、`connector`、`schedule` 测试。
4. **版本统一**
   - 决定下一个版本、合并 Changelog、建立自动校验。
5. **仓库边界**
   - 清理工作区产物和用户项目，建立正式 Skill/Example 清单。
6. **数据库模块化**
   - 先移动代码不改行为，再做迁移 framework-lite。
7. **Runtime 模块化**
   - 提取 Capability、Context、Completion 和 Tool catalog 协调器。
8. **macOS 合同测试**
   - 用 fixture/mock 验证协议，再保留受控真实授权测试。
9. **健康度与诊断**
   - 统一 readiness、SLO、日志和诊断包。
10. **性能与质量基线**
    - 容量 benchmark、Provider canary、权限 eval。

## 11. 不建议做的事情

- 不要立即重写为微服务。
- 不要引入 Temporal、Kafka、Redis 或外部数据库来替代当前单机 SQLite。
- 不要在测试未恢复前继续增加持久状态类型。
- 不要用更多 Prompt 规则替代 Tool policy 和 Host 校验。
- 不要把 owner 本地 Shell 描述成安全沙箱。
- 不要为了降低文件行数而破坏 Event/Task/Outbox 原子事务。
- 不要直接把所有实验 Skill、用户项目和知识资产都纳入 npm 包。
- 不要在版本身份未统一前发布新的稳定版。
- 不要把总覆盖率当成可靠状态机的唯一验收。

## 12. 最终判断

MimiAgent 的核心问题不是架构方向错误，而是演进速度已经超过了工程控制面的承载能力。

值得保留并继续投资的部分：

- 单 Kernel 与 Session actor。
- Event / Task / Run / Outbox 可靠链。
- Execution Ledger。
- Host 强制的权限与来源策略。
- Goal / Plan / Team / Completion 语义。
- MemoryHub 的来源与隔离模型。
- Connector 进程隔离和能力发现。

必须先收敛的部分：

- 仓库秘密与个人数据。
- Daemon 核心测试缺口。
- 依赖和发布身份。
- 超大热点文件和反向依赖。
- macOS 能力的持续验证。
- 默认授权面与用户可理解性。

如果按本文 Phase 0～2 执行，MimiAgent 可以在不改变产品核心方向的前提下，从“功能快速增长的个人 Agent 原型”升级为“有可信发布基线、可长期维护的本地 Agent Runtime”。如果继续优先增加能力而不先恢复这些工程基础，下一次 Event schema、Memory、Connector 或 SDK 升级很可能以数据损坏、重复副作用、安装失败或隐私事件的形式支付成本。

---

## 附录 A：本轮关键证据

- 当前源码：102 个 TypeScript 文件，28,789 行。
- 当前测试：53 个主测试文件，13,920 行，390 个测试声明。
- `478b19e` 基线：22,790 行源码，22,321 行测试。
- 当前最大文件：`src/daemon/store.ts` 3,054 行。
- 当前 package/lockfile 版本：`0.11.0`。
- Changelog 已记录最高版本：`0.11.7`。
- 发布包：566 文件，约 1.05 MB 压缩、4.55 MB 解包。
- CI：单 Ubuntu Node 22 job。
- 当前正式打包 Skill：4 个；仓库 Skill 目录：33 个。
- Git 跟踪的高风险数据：认证 Token、设备 GUID、QQ Guild 数据库。
- 非锁定依赖试跑：Agents SDK Tool schema 出现兼容失败。

## 附录 B：与 2026-07-20 审计的关系

`docs/audits/20260720-MimiAgent-current-state-audit.md` 主要完成了运行时安全和可靠性的缺陷发现与修复闭环，包括 Shell 环境、HTTP SSRF、Execution Ledger、Connector ACK、poison row、Completion Gate、Daemon build identity 和 Provider 偏好。

本文不是重复该审计，而是把视角扩展到：

- 修复之后新引入的 Event/Task、MemoryHub、Computer 和 Codex task 变化。
- 测试资产的结构性收缩。
- 仓库秘密和项目边界。
- 依赖、版本、打包和 CI。
- 后续升级的目标架构、阶段与验收指标。

两份文档共同构成后续改造基线：

1. 2026-07-20 审计：运行时已知缺陷与修复历史。
2. 2026-07-23 本文：当前工程成熟度、升级顺序和目标状态。
