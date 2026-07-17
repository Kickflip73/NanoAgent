# MimiAgent

MimiAgent 是一个使用 TypeScript 和 OpenAI Agents SDK 构建的轻量级、本地优先、长期在线的个人 Agent。

它由一个长期运行的 `MimiHost` 统一承载 Agent Runtime、Session、Memory、Goal/Plan、Skills、MCP、RAG、SubAgent 和受控 Ultra Team。CLI、IM、邮件、日程、天气与其他 Connector 都是同一个 MimiAgent 的输入输出渠道，不会各自创建独立 Agent。外部事件先可靠写入 SQLite Inbox，再经过 Attention、权限收窄和串行 Run，结果按需进入 Outbox 主动投递。

安装后只需运行 `mimi`：它会自动连接或启动长期运行的同一个 Agent，也可通过 `mimi "任务"` 执行单次任务。CLI 提供会话、状态、Skill、MCP、Memory、Plan、Goal、索引和恢复命令，并与长期运行模式共享同一套命令语义和 FileSession transcript。

## 核心原则

- 一个主 Agent、一个 Session 真相、一个串行 Host 所有者；Team worker 只有一层且由 lead 统一整合。
- Runtime 负责组合与执行，Core 负责持久状态，Daemon 负责可靠长期事件，Connector 负责隔离渠道协议与凭证。
- 新安装的运行数据保存在本地 `.mimi-agent`；新目录为空或不存在而旧 `.mimi-agent` 有状态时安全复用旧目录，两边都有状态则拒绝猜测。
- 外部事件正文始终是不可信数据，事件策略只能收窄部署权限，未知工具默认拒绝。
- 优先复用 Node.js、OpenAI Agents SDK、SQLite 和 NDJSON 小协议，避免引入工作流平台。
