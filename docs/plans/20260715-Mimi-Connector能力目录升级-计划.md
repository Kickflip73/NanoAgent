# Mimi Connector 能力目录升级实施计划

日期：2026-07-15
状态：已完成
关联调研：[[20260715-Mimi-Connector能力目录升级-调研.md]]

## 任务目标

让既有 Mimi 安装在升级软件后自动获得内置 Connector 新增 action，同时不覆盖 owner 的运行配置和已有描述。

## 方案概述

扩展现有初始化流程：每次读取发布模板并本地化，仅为脚本 basename 相同且允许同步的现有 Connector 合并缺失 action，再原子写回。使用一个 `syncTemplateActions` 布尔 opt-out，不增加 capability handshake、迁移数据库或权限层。

## UI 变动检测

涉及 UI 变动：否
变动类型：无
涉及文件：无前端文件
预览状态：用户要求跳过（owner 已明确要求直接编码）

## 详细步骤

### 1. Schema 与纯合并函数

**涉及文件：** `src/daemon/connectors.ts`、`src/daemon/service.ts`

Connector schema 新增默认 true 的 `syncTemplateActions`。实现纯合并：只处理两个配置都有同 basename `.mjs/.cjs/.js` 脚本的现有 Connector；只添加 template 中不存在于 owner actions 的项，保留全部 owner 字段和已有 action 描述。

### 2. 原子升级初始化

**涉及文件：** `src/daemon/service.ts`

无论配置是否已存在都读取本地化模板。新建仍用 exclusive link；既有配置有增量时用同目录 `0600` 临时 JSON + atomic rename，返回 `updatedActions` 数量。无变化不写盘。

### 3. owner opt-out 与幂等测试

**涉及文件：** `tests/daemon-service.test.ts`、`mimi.connectors.example.json`

构造旧 catalog：删除内置 action、定制已有描述、关闭 Connector，并为另一个 Connector 设置 `syncTemplateActions:false`。验证只恢复允许同步的缺项，其他字段不变；第三次初始化为 0 更新。

### 4. 文档与回归

**涉及文件：** `README.md`、`docs/CONNECTORS.md`、`docs/ARCHITECTURE.md`、`CHANGELOG.md`

明确模板 action 是能力发现目录而非权限等级，默认增量同步的语义和 opt-out；运行类型检查、专项测试、完整 CI 与发布包验证。

## 权衡与考量

- 不让子进程动态自报 action，避免改变全部 Connector 协议和绕过 owner catalog。
- 不覆盖已有描述，保持 owner 的提示定制。
- 不自动新增被 owner 删除的整个 Connector 条目；只升级仍存在且明确使用内置脚本的条目。
- opt-out 是配置同步开关，不是审批/权限模型。

## Todo List

- [x] schema 增加 syncTemplateActions
- [x] 实现纯增量合并与原子写回
- [x] 验证 owner 字段、opt-out 和幂等
- [x] 同步模板与文档
- [x] 运行完整 CI 并生成开发记录
