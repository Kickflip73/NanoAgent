# MimiAgent 统一 Memory Hub 调研报告

日期：2026-07-15

状态：已完成（作为设计输入，未实施）

## 调研目标

评估是否应把 LLMWiki 作为 MimiAgent 的统一记忆入口，并在不破坏现有 Session、Goal/Plan/Checkpoint、Skills、MIMI.md 与 Mimi 可靠事件模型的前提下，形成一套轻量、本地优先、能持续积累知识的 Memory 架构。

本次只做调研、设计与方案 Review，不修改运行时代码。

## 结论先行

推荐把 LLMWiki 定义为 MimiAgent 的统一 **Memory Hub 和语义记忆层**，但不推荐把所有状态物理合并进 Wiki。

最合适的模型是：

> Session 保真，Wiki 复利，Skill 行动，Plan 管当前任务，MIMI.md 守住可信规则；Memory Hub 在上层统一检索、读取、沉淀和遗忘。

因此，“统一”指统一 API、统一检索体验、统一来源与生命周期，不是统一成一个 Markdown 目录或一张数据库表。

## 当前架构现状

| 信息类型 | 当前归属与存储 | 当前优点 | 当前问题 |
|---|---|---|---|
| 当前对话与工具轨迹 | `FileSession`，`.mimi-agent/sessions/*.json` | 原始 transcript 保真；有 runId/owner 与 Tool Pair 修复 | 不能作为高效的跨 Session 知识入口 |
| 上下文归档 | Session 内 `ContextArchive` | 不污染原始 transcript；可恢复 | 只是当前 Session 的模型视图，不是长期知识 |
| 长期记忆 | `MemoryStore`，`.mimi-agent/memories.json` | 必须由用户明确确认；跨 Session 注入边界清楚 | 只有四种平面类型、精确去重和浅词法排序；无来源链、时间演化、冲突与结构化复利 |
| 文档知识 | `RagStore`，`.mimi-agent/rag-index.json` | 本地文件、可选 Embedding、原子索引、路径隔离 | 固定字符切片；整份 JSON 索引；与 Memory 分裂；无页面、链接、编译和维护生命周期 |
| 当前任务状态 | `Goal/Plan/Checkpoint/Team` | 适合恢复、并发与当前任务进度 | 不应迁入长期记忆，否则会形成第二套 Todo/Workflow |
| 程序性知识 | `Skills` | 按需加载、可执行、可测试 | 不应降级为普通 Wiki 文本 |
| 可信常驻规则 | 用户级/项目级 `MIMI.md` | 每轮加载，优先级确定，适合安全与行为不变量 | 若放入大量事实会持续占用上下文；但不能被普通检索结果替代 |
| Mimi 事件状态 | `MimiStore` 的 SQLite WAL | Inbox、Run、Lease、Retry、Outbox、Schedule、Digest 已具备可靠语义 | 尚无长期记忆观察、批量巩固和来源回指机制 |

### 当前调用链的关键事实

1. `MimiAgent.stream()` 每轮会自动搜索已确认的 `MemoryStore`，最多注入少量相关记忆。
2. `RagStore` 只通过 `search_knowledge` 工具按需查询；当前 `ContextManager` 虽支持 `documents`，Runtime 实际传入的是空数组。
3. `MemoryStore` 只接受本轮用户明确要求“记住”的写入，旧版或未确认内容不会跨 Session 注入。
4. `MIMI.md` 每轮读取，属于高优先级 instructions；它和检索到的事实不是同一信任层。
5. Mimi 只有一个 Dispatcher；事件终态与 Outbox 同事务提交，租约过期可恢复，失败有界重试。任何 Memory 后台机制都应复用这条路径。

## 现有方案为什么显得“有点 low”

问题不在于用了 JSON 或没有图数据库，而在于知识生命周期太短：

- Memory 和 RAG 是两个互不理解的入口，Agent 不知道某条信息是个人偏好、项目事实、历史经历还是原始文档。
- 文档只被切块和召回，没有被持续编译成概念、实体、决策、经验和关系。
- 记忆缺少 `sourceRef`、有效时间、置信等级、替代关系和冲突状态，更新只能追加或精确文本去重。
- 简单中文分词按单字匹配，容易召回噪声；当前 retrieval eval 只有两个单文档问题，不能证明长期记忆质量。
- Mimi 能持续处理事件，却不会把成功经验、反复失败和环境 gotcha 稳定沉淀下来。
- `todo` 进入 Memory 会和现有 Goal/Plan/Checkpoint 重复，长期运行后容易出现过期任务被误当成事实。

这些问题需要的是统一语义与生命周期，而不是引入更重的向量数据库、知识图数据库或工作流平台。

## 外部研究得到的约束

### LLMWiki 的价值是“编译”，不是换一种 RAG UI

[Karpathy 的 LLM Wiki idea file](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)把系统分为不可变原始来源、LLM 维护的 Wiki 和约束维护方式的 schema。核心价值是让跨来源综合、冲突识别和链接关系成为持续维护的产物，而不是每次查询重新从切片拼装。

[LLM-Wiki 论文](https://arxiv.org/abs/2605.25480)进一步把检索定义为 `search → read → link traversal` 的推理过程，并通过持久 Error Book 纠正结构与语义错误。它对多文档问题有优势，但不意味着原始来源可以删除。

对 MimiAgent 的直接启发：Wiki 应是可复利的语义层，原始 Session、事件和文档仍是可追溯证据层。

### 长期记忆不能只保留抽取后的事实

[LongMemEval](https://arxiv.org/abs/2410.10813)覆盖信息抽取、跨 Session、时间推理、知识更新和拒答五类能力。其结果表明，过度压缩成单条事实会丢失细节；多路径索引、时间感知查询和结构化阅读都影响最终正确率。

[LongMemEval-V2](https://arxiv.org/abs/2605.12493)把 Agent 经验扩展为静态状态、动态变化、工作流、环境陷阱和前提感知，并显示失败轨迹也可能包含关键经验。文件化原始轨迹能提供较高准确率，但查询时让 Agent遍历大量文件的延迟很高。

对 MimiAgent 的直接启发：保留原始 episode，通过 Wiki 和索引提供快速路径；必要时再回读证据，而不是在“全存原文”和“只存摘要”之间二选一。

### 业内共识是分层与冷热路径分离

[LangGraph Memory 文档](https://langchain-ai.github.io/langgraphjs/how-tos/manage-conversation-history/)区分 thread-scoped short-term memory 与 cross-thread long-term memory，并区分 semantic、episodic、procedural memory；记忆可以在交互热路径写入，也可以在后台巩固。

对 MimiAgent 的直接启发：用户明确要求记住时可立即写入；Mimi 自动总结与知识编译应放到低优先级维护路径，不能拖慢事件处理和回复。

## 本地技术可行性

MimiAgent 已要求 Node.js 22，并且 Mimi 已使用内置 `node:sqlite`，因此无需新增数据库依赖。当前开发环境验证结果：

- `node:sqlite` 可用；
- SQLite 编译启用了 FTS5；
- FTS5 `trigram` 能支持中文三字及以上子串和英文子串；
- 两个汉字的 MATCH 不会命中，这是 SQLite 官方文档说明的行为，设计中必须增加短查询的受限 `LIKE`/别名回退，不能把 trigram 当成完整中文检索器。

参考：[Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)、[SQLite FTS5 文档](https://www.sqlite.org/fts5.html)。

## 推荐的边界

### 应进入 Wiki 的内容

- 已确认的个人偏好与稳定事实；
- 项目概念、实体、架构决策、领域定义；
- 有来源的经验总结、环境 gotcha、重复出现的失败模式；
- 跨多个来源形成的比较、联系与综合判断；
- 已完成任务中未来仍会复用的结论。

### 不应进入 Wiki 的内容

- 完整 Session transcript 和原始 Tool Call；
- 当前 Goal、Plan、Checkpoint、Team task；
- 临时草稿、一次性通知、普通环境噪声；
- 密钥、令牌和不应跨会话扩散的敏感信息；
- 可执行流程本体。稳定流程应进入 Skill，Wiki 只保留说明和指向 Skill 的引用；
- 核心安全、权限和行为不变量。它们继续由 MIMI.md/代码策略承载。

## MIMI.md 的结论

`MIMI.md` 仍然必要，但应缩成“可信启动宪法”，而不是长期知识文件。

它保留：

- 安全与权限边界；
- 架构不变量；
- Memory 的写入、引用和隐私规则；
- 何时使用 Skill、Plan、Wiki、Session 的路由规则。

项目事实、历史结论、教程、个人档案和研究材料迁入 Wiki。这样既减少每轮常驻 Token，又不会把普通检索内容抬升成可信指令。

## 最终建议

采用“LLMWiki 作为统一 Memory Hub、底层保留分层存储”的方向，推荐度高。实现时必须守住六条原则：

1. Wiki 是语义编译层，不是唯一真相源。
2. Markdown 是可读、可版本化的语义产物；SQLite 只做可重建索引和回执。
3. 私有记忆与工作区共享知识物理隔离，默认不跨域提升。
4. 普通检索不调用 LLM、不依赖网络、不默认生成 Embedding。
5. Mimi 的自动巩固复用现有 Event/Lease/Retry，由 Dispatcher 只在有待处理来源时合并发布维护事件，不新建第二个 Dispatcher。
6. 任何自动学习都带来源、幂等键、预算和状态门禁；不可信外部事件不能直接变成 active 长期记忆。

详细架构、数据模型、Mimi 接入、迁移和 Review 见关联计划：`docs/plans/20260715-MimiAgent统一MemoryHub-计划.md`。
