# Mimi macOS 通讯录连接器实施计划

日期：2026-07-15  
状态：已完成  
关联调研：[[20260715-Mimi-macOS通讯录连接器-调研.md]]

## 任务目标

让 Mimi 通过姓名、组织、邮箱或号码解析联系人，并能创建、补充和更新联系人常用字段，为 Mail、Messages 等事务提供稳定的人物目录。

## 方案概述

实现单个独立 NDJSON Connector，用 Contacts.app JXA 读取和修改系统通讯录。Connector 无轮询、无本地副本、无新增依赖；所有结果有界，所有写操作显式保存并复用现有 Connector Action Bridge。

## UI 变动检测

涉及 UI 变动：否  
变动类型：无  
预览状态：不适用

## 详细步骤

1. 实现 Contacts JXA 的搜索、详情、创建和更新逻辑。
2. 增加 action/target/payload 验证、字段上限和结构化错误。
3. 在 Connector 示例配置中声明四项能力。
4. 更新 README、Connector、Architecture、Security 和 Changelog 文档。
5. 用 mock `osascript` 覆盖查询、重名候选、写入、特殊字符和失败边界。
6. 更新 npm package smoke 并运行完整 CI。

## 权衡与考量

- 不实现通讯录镜像或全文索引，避免一致性和隐私复杂度。
- 不把联系人作为长期 Memory 自动注入；只有实际事务需要时才查询。
- 首版更新标量字段，并支持追加邮箱和电话；不做模糊的批量覆盖或隐式删除。
- 不输出联系人图片、完整 vCard 和地址，保持数据面与结果体积清晰。

## Todo List

- [x] 实现四个 Contacts actions
- [x] 增加输入边界与错误处理
- [x] 更新 Connector 配置和产品文档
- [x] 增加 mock 协议测试和 package smoke
- [x] 运行完整 CI
