# Mimi macOS 笔记连接器调研报告

日期：2026-07-15  
状态：已审核（用户已授权直接实施）

## 调研范围

- 目标：让 Mimi 能在 Apple Notes 中检索、读取和沉淀工作记录、会议纪要、生活清单与随手知识。
- 涉及文件：
  - `examples/connectors/macos-notes-connector.mjs`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
  - `tests/macos-notes-connector.test.ts`

## 核心发现

### 现状分析

MimiAgent 已有内部 Memory、RAG 和本地文件能力，但用户日常信息可能长期存在 Apple Notes。Notes scripting dictionary 提供 account、folder、note、稳定 id、纯文本、HTML body、创建/修改时间、密码保护状态和附件元数据，足以通过独立 JXA Connector 完成常用笔记事务。

该能力不适合进入 Runtime 内核，也不应把 Notes 私有数据库重新索引或同步到 MimiAgent。按需 action 可以复用现有 Connector Action Bridge，同时保持系统账号、iCloud 同步和 Notes 对象都在应用边界内。

### 关键流程

```text
owner / schedule / external event
  -> connector_action(macos-notes, search/read/create/update/append)
  -> Notes.app JXA
  -> structured bounded result
```

### 现有约束

- Connector action-only，不默认轮询笔记，避免写后再触发自身的反馈循环。
- 搜索返回标题和有界纯文本预览；完整读取正文上限 50000 字符。
- 创建、更新和追加正文上限 40000 字符，支持 plain 或显式 HTML。
- 密码保护笔记不尝试解锁，正文访问失败时只返回元数据。
- 附件只返回名称、ID、URL 和时间等元数据，不下载二进制内容。
- 所有输入通过 JSON argv 传给 `osascript`，不经 Shell 拼接。

### 风险与问题

- 首次运行会触发 macOS Notes 自动化权限；这是系统边界，不由 MimiAgent 绕过。
- Notes 的 `body` 是 HTML，而 `plaintext` 只读；纯文本写入必须转义为 HTML，不能把用户文本当作标签执行。
- Notes 数量可能很多，搜索扫描和结果必须有上限并报告 truncated。
- 修改动作超时或子进程退出后的结果不确定，现有 Action Bridge 不自动重放。

## 与任务相关的关键结论

1. 新增无依赖、无轮询的 `macos-notes` Connector，不修改 Runtime、Daemon 或持久 schema。
2. 提供 `list_folders`、`search_notes`、`read_note`、`create_note`、`update_note`、`append_note` 六个 actions。
3. 创建使用默认文件夹或稳定 folder ID；搜索和读取返回稳定 note ID，后续写操作不依赖易变标题。
4. 首版不实现附件上传、删除、移动或 Notes 镜像，保持可验证的常用事务面。
