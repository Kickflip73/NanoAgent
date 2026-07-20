# MimiAgent 统一 Memory Hub 调研报告

日期：2026-07-15

状态：已完成（2026-07-20 按现有代码与用户设计决策修订；未实施）

## 调研目标

评估是否应把 LLMWiki 作为 MimiAgent 的统一记忆入口，并在保留 Session、Goal/Plan/Checkpoint、Skills、MIMI.md 与 Mimi 可靠执行能力的前提下，形成一套轻量、本地优先、能持续积累知识的 Memory 架构；同时纠正现有 Event/Task 语义混用。

本次只做调研、设计与方案 Review，不修改运行时代码。

## 结论先行

推荐把 LLMWiki 定义为 MimiAgent 的统一 **Memory Hub 和语义记忆层**，但不推荐把所有状态物理合并进 Wiki。

最合适的模型是：

> Session 保真，Wiki 复利，Skill 行动，Plan 管当前任务，MIMI.md 定义 Mimi 的 Soul，AGENTS.md/CLAUDE.md 管项目，硬安全边界在代码；Memory Hub 统一检索、读取、自主沉淀和遗忘。

因此，“统一”指统一 API、统一检索体验、统一来源与生命周期，不是统一成一个 Markdown 目录或一张数据库表。

## 当前架构现状

| 信息类型 | 当前归属与存储 | 当前优点 | 当前问题 |
|---|---|---|---|
| 当前对话与工具轨迹 | `FileSession`，`.mimi-agent/sessions/*.json` | 原始 transcript 保真；有 runId/owner 与 Tool Pair 修复 | 不能作为高效的跨 Session 知识入口 |
| 上下文归档 | Session 内 `ContextArchive` | 不污染原始 transcript；可恢复 | 只是当前 Session 的模型视图，不是长期知识 |
| 长期记忆 | `MemoryStore`，`.mimi-agent/memories.json` | 主 Agent 已可按未来价值主动 `remember`，无需逐条确认；有 provenance 和跨 Session 注入边界 | 仍是平面记录、精确去重和浅词法排序；无 Wiki 页面、时间演化、冲突与结构化复利 |
| 文档知识 | `RagStore`，`.mimi-agent/rag-index.json` | 本地文件、可选 OpenAI Embedding、词法/vector 混合排序、按 digest 复用向量、原子索引与路径隔离 | 固定字符切片；整份 JSON 索引；与 Memory 分裂；无页面、链接、编译和维护生命周期 |
| 当前任务状态 | `Goal/Plan/Checkpoint/Team` | 适合恢复、并发与当前任务进度 | 不应迁入长期记忆，否则会形成第二套 Todo/Workflow |
| 程序性知识 | `Skills` | 按需加载、可执行、可测试 | 不应降级为普通 Wiki 文本 |
| 当前持久指令 | 用户级/项目级 `MIMI.md` | 每轮加载，实现简单 | 同一文件混合了 Mimi 身份、项目规则和安全说明；不能与 Codex/Claude 共享项目合约，且 Mimi 的自我会随 workspace 改变 |
| Mimi Event/Task | `MimiStore` 的 SQLite WAL，当前共用 `events` 表 | Run、Lease、Retry、Outbox、Schedule、Digest 已具备可靠语义 | Event 事实与 Task 队列混在同一模型；后台 Task 只是 `execution_lane = task` 的 Event，需先拆层，再接 Memory |

### 当前调用链的关键事实

1. `MimiAgent.stream()` 每轮会自动搜索当前可用的 `MemoryStore`，最多注入少量相关记忆。
2. `RagStore` 只通过 `search_knowledge` 工具按需查询；有 OpenAI Embedding 凭证时已使用 vector + lexical 混合分数，否则回退词法分数。当前 `ContextManager` 虽支持 `documents`，Runtime 实际传入的是空数组。
3. 当前 `docs/ARCHITECTURE.md` 和 Runtime 允许主 Agent 按未来价值主动 `remember`，无需用户逐条确认；原始输入明确要求“不记住”时会确定性拒绝。
4. `GuidanceLoader` 当前每轮读取用户级和项目级 `MIMI.md`；目标设计将其拆分为 SoulLoader 与读取 `AGENTS.md/CLAUDE.md` 的 ProjectGuidanceLoader。
5. 当前 `StoredEvent` 同时拥有来源/正文/发生时间和 status/attempts/lease/result；`TaskProcessSupervisor` 也通过 Event API 领取后台 Task。这证明现有实现可靠，但领域边界不清。目标设计保留事务、租约、重试和 Outbox 语义，把它们从 Event 平移到正式 Task 层；Event 改为不可变事实流。

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

对 MimiAgent 的直接启发：Wiki 应是可复利的语义层，原始 Session、不可变 Event、Task Run 和文档仍是可追溯证据层。

### 长期记忆不能只保留抽取后的事实

[LongMemEval](https://arxiv.org/abs/2410.10813)覆盖信息抽取、跨 Session、时间推理、知识更新和拒答五类能力。其结果表明，过度压缩成单条事实会丢失细节；多路径索引、时间感知查询和结构化阅读都影响最终正确率。

[LongMemEval-V2](https://arxiv.org/abs/2605.12493)把 Agent 经验扩展为静态状态、动态变化、工作流、环境陷阱和前提感知，并显示失败轨迹也可能包含关键经验。文件化原始轨迹能提供较高准确率，但查询时让 Agent遍历大量文件的延迟很高。

对 MimiAgent 的直接启发：保留原始 episode，通过 Wiki 和索引提供快速路径；必要时再回读证据，而不是在“全存原文”和“只存摘要”之间二选一。

### 业内共识是分层与冷热路径分离

[LangGraph Memory 文档](https://langchain-ai.github.io/langgraphjs/how-tos/manage-conversation-history/)区分 thread-scoped short-term memory 与 cross-thread long-term memory，并区分 semantic、episodic、procedural memory；记忆可以在交互热路径写入，也可以在后台巩固。

对 MimiAgent 的直接启发：用户明确要求记住时立即写入；Mimi 也可自主判断并沉淀，但自动总结与知识编译应放到低优先级维护路径，不能拖慢事件处理和回复。

## 本地技术可行性

MimiAgent 已要求 Node.js 22，并且 Mimi 已使用内置 `node:sqlite`，因此无需新增数据库依赖。当前开发环境验证结果：

- `node:sqlite` 可用；
- SQLite 编译启用了 FTS5；
- FTS5 `trigram` 能支持中文三字及以上子串和英文子串；
- 两个汉字的 MATCH 不会命中，这是 SQLite 官方文档说明的行为，设计中必须增加短查询的受限 `LIKE`/别名回退，不能把 trigram 当成完整中文检索器。

现有 `RagStore` 已经具备可选 OpenAI Embedding、digest 复用和 vector + lexical 混合打分，因此新 Memory Hub 不需要从零验证语义检索。推荐把这部分能力收敛进统一 retriever，并把词法通道升级为 FTS5/BM25：

- BM25 始终启用，负责离线、低延迟、关键词和代码标识符检索；
- 配置独立 Embedding Provider 时自动增加向量语义通道，失败时直接回退 BM25；
- 用 Reciprocal Rank Fusion 合并结构、BM25 与 vector 的排名，避免直接相加不同量纲的分数；
- 数百到低万个向量直接保存为 SQLite BLOB、进程内做有界 cosine 扫描，不增加向量数据库。

Embedding 的金钱成本很低，但不是零成本。按 2026-07-20 OpenAI `text-embedding-3-small` 的公开价格 $0.02/1M input tokens，10,000 个索引单元、平均每个 500 tokens 的一次全量索引约为 $0.10，之后按 digest 增量更新。10,000 个 512 维 Float32 向量约占 20 MB，1536 维约占 60 MB。更值得关注的是查询时的网络延迟、隐私边界和 model/dimensions 变化后的重建，而不是 API 金额。用户可以强制 `retrievalMode: lexical` 保持纯本地。价格来源：[OpenAI text-embedding-3-small](https://developers.openai.com/api/docs/models/text-embedding-3-small)。

截至本次调研，在 [DeepSeek 官方 API 文档](https://api-docs.deepseek.com/api/create-chat-completion)中未找到可供本设计依赖的独立 Embeddings 接口。这不是对 DeepSeek 永久能力的断言，而是设计约束：DeepSeek 作为对话 Provider 时，向量通道使用独立配置的 OpenAI Embedding 凭证；没有该凭证就完整使用 BM25。

参考：[Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)、[SQLite FTS5 文档](https://www.sqlite.org/fts5.html)。

## 推荐的边界

### 应进入 Wiki 的内容

- 稳定、高置信且未来可复用的个人偏好与事实；
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
- 核心安全、权限和行为不变量。它们继续由代码策略承载，不能依赖可编辑提示词保证。

## MIMI.md 的结论

`MIMI.md` 仍然必要，但定位改为 Mimi 的 **Soul**，而不是项目说明、开发者合约、知识库或安全策略文件。

它只保留相对稳定的自我信息：

- 名字、自我定位与基本背景；
- 人格、性格、价值观和交流风格；
- 对用户的关系边界与长期一致的偏好表达方式。

项目使命、目录、架构、编码规范、命令和验证方式由项目现有的 `AGENTS.md` / `CLAUDE.md` 提供。Mimi 在开发任务中按目录层级读取它们；`AGENTS.md` 是默认共享格式，`CLAUDE.md` 可作为补充。若项目两者都没有，并且当前任务确实需要修改项目且 workspace 可写，Mimi 先做轻量扫描，再创建最小 `AGENTS.md`，让 Codex、Claude 等 Agent 共用同一份项目信息；纯读取任务不应因此落盘。

项目事实、历史结论、教程、个人偏好和研究材料进入 Wiki。硬安全与权限边界留在 Runtime 代码 policy。这样 Soul、项目合约、长期知识和强制安全规则各自只有一个清晰职责，也不会把普通知识抬升成高优先级指令。

## 最终建议

采用“LLMWiki 作为统一 Memory Hub、底层保留分层存储”的方向，推荐度高。实现时必须守住八条原则：

1. Wiki 是语义编译层，不是唯一真相源。
2. Markdown 是可读、可版本化的语义产物；SQLite 只做可重建索引和回执。
3. 私有记忆与工作区共享知识物理隔离，默认不跨域提升。
4. 第一版即提供 BM25 + 可选 vector 的混合检索；BM25 始终可用，Embedding 自动增强但不成为启动依赖。
5. Mimi 的自动巩固复用统一 Task Queue 与执行器：Event 只提供事实证据；只有确有待处理知识时才创建一个低优先级 `memory_maintenance` Task，不启动第二套常驻服务，也不做无意义定时轮询。
6. Mimi 在来源、敏感信息、scope、冲突和预算硬门禁内自主决定沉淀，无需逐条等待人确认；原始外部声明没有独立证据时只保留在 episode，不直接成为 active 长期知识。
7. `MIMI.md` 只定义 Mimi 的 Soul；`AGENTS.md/CLAUDE.md` 定义项目；Wiki 保存长期知识；硬安全规则留在代码。
8. 当前只有单用户，实施采用一次性切换：备份后完成数据转换并移除旧 Memory/RAG 运行路径，不做双读、双写或分阶段兼容。

详细架构、数据模型、Mimi 接入、一次性切换和 Review 见关联计划：`docs/plans/20260715-MimiAgent统一MemoryHub-计划.md`。Event/Task 的前置分层见：`docs/plans/20260720-MimiAgent-Event-Task分层设计.md`。
