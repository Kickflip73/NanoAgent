# Mimi Connector 能力目录升级调研报告

日期：2026-07-15
状态：已审核（owner 已明确要求按设计直接实施）

## 调研范围

- 目标：确保已安装的长期运行 Mimi 能自动看见软件升级后新增的内置 Connector action。
- 涉及文件：
  - `src/daemon/service.ts`
  - `src/daemon/connectors.ts`
  - `tests/daemon-service.test.ts`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`

## 核心发现

### 现状分析

`initializeMimi` 只在 `connectors.json` 不存在时读取发布包模板并物化绝对路径。一旦文件存在，初始化只解析和 chmod，不再比较模板。`ConnectorProcess.executeAction` 又严格要求 action 已在配置的 `actions` 中声明。

因此，既有安装升级到新增 Mail/Messages action 的版本后，子进程虽然支持这些 action，Host 仍会以“未声明 action”拒绝执行。重新运行 `daemon init/start/run/install` 都不会修复，除非 owner 手工复制 catalog。这与“开箱长期在线、软件持续演进”的目标冲突。

### 可复用流程

- 发布包模板已经是内置 action 描述的唯一来源，无需让每个 Connector 新增 ready/handshake 协议。
- 初始化已经在所有 Daemon 启动入口执行，是最小升级时点。
- 现有 `localConnectorConfig` 能把模板 node/脚本路径本地化，可直接作为比较基线。
- `connectors.json` 是 owner 配置，写回必须使用同目录临时文件、`0600` 和 atomic rename。

### owner 配置边界

自动同步只能补充内置脚本中缺失的 action：

- 必须保留 `enabled`、command、args、cwd、envAllowlist、source/trust/profile、restart/timeout 等全部 owner 字段；
- 已存在 action 的描述可能被 owner 定制，不能覆盖；
- 只对现有条目中脚本 basename 与内置模板脚本一致的 Connector 同步，避免把内置 action 塞给同名自定义程序；
- 需要一个简单 opt-out：`syncTemplateActions:false`，用于 owner 故意维护精确 action 子集；不设计 action 级 ACL 或审批模型。

### 幂等与并发

首次补充后再次初始化必须 0 变更。写回使用随机同目录临时文件和 atomic rename，避免崩溃留下半个 JSON；初始化发生在 ConnectorManager 加载前，不需要热重载或数据库迁移。

## 与任务相关的关键结论

最轻量方案是在 connector schema 增加一个默认 true 的 `syncTemplateActions`，并让 `initializeMimi` 每次加载本地化模板，对同脚本现有 Connector 做“只补缺失 action”的纯合并。返回补充数量便于 `daemon init` 可观察；没有新增进程协议、状态文件、权限等级或后台同步器。
