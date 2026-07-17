# Mimi macOS 通讯录连接器调研报告

日期：2026-07-15  
状态：已审核（用户已授权直接实施）

## 调研范围

- 目标：让 Mimi 能把自然语言中的联系人姓名解析为真实邮箱、手机号和组织信息，并可维护联系人。
- 涉及文件：
  - `examples/connectors/macos-contacts-connector.mjs`
  - `mimi.connectors.example.json`
  - `docs/CONNECTORS.md`
  - `tests/macos-contacts-connector.test.ts`

## 核心发现

### 现状分析

Mimi 已能通过 Apple Mail 和 Messages 执行收发事务，但 action target 仍要求邮箱、号码或 chat GUID。现有 Runtime、Memory 和 Session 没有联系人目录，也不应复制一份通讯录状态。

本机 Contacts scripting dictionary 提供 person、phone、email、address、group、persistent id，以及 make/save/delete 等标准命令。它足以完成按姓名、组织、邮箱和电话检索，读取联系人详情，以及创建和更新常用字段，无需引入 Contacts.framework 原生扩展或第三方 npm 包。

### 关键流程

```text
“给张三发消息”
  -> connector_action(macos-contacts, search_contacts, 张三)
  -> contact id + phones + emails
  -> connector_action(macos-messages / macos-mail, send_message, resolved target)
```

### 现有约束

- Contacts 凭证和对象继续留在独立 Connector 子进程，不进入 Runtime。
- Connector 只响应显式 action，不轮询或复制通讯录，因此没有第二份索引、cursor 或同步状态。
- 查询结果和字段长度必须有界；图片、vCard 二进制和完整地址暂不输出。
- 所有输入通过 JSON argv 传给 `osascript`，不经 Shell 拼接。
- Mimi 默认开放全部 Runtime 权限；action 目录是能力发现，不是审批模型。

### 风险与问题

- 首次运行会触发 macOS Contacts 自动化/隐私授权；这是操作系统边界，不能由 MimiAgent 绕过。
- 姓名可能重名，搜索必须返回稳定 contact id 和候选列表，不能静默选择第一个联系人。
- Contacts JXA 是系统脚本接口，系统版本差异应隔离为清晰 action error，不影响 Daemon。
- 创建或更新失败时不能自动重放不确定事务；现有 Action Bridge 已采用该语义。

## 与任务相关的关键结论

1. 新增一个无 npm 依赖、无轮询的 `macos-contacts` Connector，不修改 Runtime/Daemon 核心。
2. 提供 `search_contacts`、`get_contact`、`create_contact`、`update_contact` 四个 action。
3. 搜索返回多个有界候选及稳定 id，由 Agent结合上下文决定目标；不会在重名时自动猜测。
4. 创建和更新由 Contacts.app 保存，依赖 Action Bridge 的事件级语义账本和不确定结果不重放边界。
