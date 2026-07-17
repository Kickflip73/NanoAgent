# panda-draw draw.io references 索引(layout × palette 选择器入口)

`panda-draw` draw.io 模式的所有 reference 文件清单 + 选择路径。LLM 在 Mode B 选 layout × palette 时**先读本文件**,然后**只读选定的两个文件 + 通用层 4 个文件**,不要读全部预设(节省上下文 + 提高执行稳定性)。

## 文件结构

```
references/
├── index.md                    # ← 你在这里(选择器入口)
├── common-rules.md             # 通用硬规则(文字不出框 / 尺寸 / 连线纪律 / XML 良构)
├── visual-hierarchy.md         # 视觉层次工具箱(描边粗细 / 字号节奏 / 强调 / 留白)
├── xml-reference.md            # XML 语法参考
├── diagram-plan-template.md    # plan 文件格式
├── layouts/                    # 布局骨架(选 1 个)
│   ├── biz-arch.md             # 业务架构(默认)
│   ├── tech-arch.md            # 技术架构(分层)
│   ├── flowchart.md            # 流程图
│   ├── dataflow.md             # 数据流 / 链路图
│   ├── bridge.md               # 战略转型对比 (新)
│   ├── dense-modules.md        # 高密度信息图 (新)
│   └── agent-workflow-board.md # Agent / AI coding / 人机协作工作流看板
└── palettes/                   # 配色板(选 1 个)
    ├── classic-soft.md         # 经典柔和(默认)
    ├── technical-blueprint.md  # 工程蓝图(深蓝底,严肃技术)(新)
    ├── morandi-pastel.md       # 莫兰迪柔和(文艺质感)(新)
    ├── subway-transit.md       # 地铁线路(多线并行高分类数)(新)
    └── ikea-minimal.md         # 北欧极简(说明书风)(新)
```

## LLM 工作流(Step 1 必读路径)

```
1. 读本 index.md                        ← 看选择映射
2. 根据用户输入内容,自动选 1 个 layout + 1 个 palette(不问用户)
3. 读 selected layout 文件               ← 一个
4. 读 selected palette 文件              ← 一个
5. 读 common-rules.md                    ← 通用硬规则
6. 读 visual-hierarchy.md                ← 视觉层次
7. 读 xml-reference.md                   ← XML 语法
8. (写 plan 时) 读 diagram-plan-template.md
```

**总共读 6-7 个文件**,不读其他 layout 和 palette 文件。**这是为了执行稳定性**——读太多预设导致 LLM 混淆 token。

## 选择映射(内容形态 → 推荐 layout × palette)

### Layout 选择(看内容形态)

| 内容形态 / 关键词 | 推荐 layout |
|---|---|
| 业务能力 / 规划 / 职责 / 全景 / 梳理 / 能力地图 / 战略 | `biz-arch` |
| 系统架构 / 模块 / 服务 / 微服务 / 部署 / 技术栈 / 平台栈 / 接入层 / 数据层 | `tech-arch` |
| 流程 / 审批 / 步骤 / 分支 / 异常处理 / 决策 / 状态机 | `flowchart` |
| 数据链路 / 管道 / 漏斗 / 调用链 / 阶段推进 / ETL / pipeline / 流水线 | `dataflow` |
| 转型 / 迁移 / 升级 / 从 X 到 Y / before-after / V1 vs V2 / 现状 → 未来 / 取代 / 演进 | `bridge` |
| 完整指南 / 全景清单 / 一图看懂 / 能力盘点 / 多维度 / checklist / 大全 / X 类 Y 维度 | `dense-modules` |
| Agent / AI coding / 人机协作 / 智能体编排 / 多 Agent 协作,且包含需求-方案-编码-测试-发布等阶段 | `agent-workflow-board` |

不确定 → 默认 `biz-arch`(用户个人风格,通用)。

仅出现"评审 / 测试 / 审批 / 多角色 / 多团队"但没有 Agent / AI 协作强信号时,不要选
`agent-workflow-board`,用 `flowchart`。

Selector sanity:

- "客服工单从提交、主管审批、测试验证到上线" → `flowchart`(没有 Agent / AI 协作强信号)
- "AI coding 中需求 Agent、编码 Agent、测试 Agent 和人类评审如何协作发布" → `agent-workflow-board`

### Palette 选择(看调性 + 场景)

| 场景 / 调性 | 推荐 palette |
|---|---|
| 通用 / 默认 / 不确定 | `classic-soft` |
| 严肃技术架构 / 对外正式 / 工程文档 | `technical-blueprint` |
| 文艺 / 教程 / 软性沟通 / 个人作品 | `morandi-pastel` |
| 多线并行 ≥3 / 高分类数 ≥5 / 网络拓扑 / 多角色泳道 | `subway-transit` |
| 极简说明书 / 安装手册 / 黑白打印友好 | `ikea-minimal` |

不确定 → 默认 `classic-soft`(柔和稳定)。

### 组合推荐(Layout × Palette 常见配对)

| 内容 | 组合 |
|---|---|
| panda-mem 发布链路图(技术,业务化全景) | `biz-arch` × `classic-soft` |
| 微服务架构(对外正式) | `tech-arch` × `technical-blueprint` |
| 微服务架构(内部对齐) | `tech-arch` × `classic-soft` |
| 审批流程图 | `flowchart` × `classic-soft` |
| 多角色多状态流程(地铁感) | `flowchart` × `subway-transit` |
| 数据 ETL 链路(对外) | `dataflow` × `technical-blueprint` |
| 调用链多源汇聚 | `dataflow` × `subway-transit` |
| "RAG 到 LLM 编译"转型对比 | `bridge` × `classic-soft` 或 `bridge` × `morandi-pastel` |
| AI Coding 能力地图(小红书风) | `dense-modules` × `classic-soft` |
| AI coding / Agent 协作工作流看板 | `agent-workflow-board` × `classic-soft` 或 `agent-workflow-board` × `morandi-pastel` |
| 学习笔记可视化 | `dense-modules` × `morandi-pastel` |
| Skill 配置 SOP 安装手册 | `flowchart` × `ikea-minimal` |

## 拿不准时

**找 Codex 商量**(走 agent-bridge `codex_send`):
- 内容形态横跨两个 layout(如"既是架构又是流程")
- 没有明显的 palette 推荐(无视觉调性提示)
- 节点超 20 / 分类超 5 时,布局是否拆页 / 用哪个组合最稳

发 prompt 时把"用户输入 + 节点统计 + 候选 layout × palette + 困惑点"写清楚。Codex 边界外(品牌偏好、范围裁剪、业务语义缺失)才回退用户。

## 用户主动指定

用户在请求里点名"用 dataflow 风格" / "用 morandi-pastel" / "蓝图配色" → 直接按用户说的;**不需要走映射表**。

用户只指定 layout 没指定 palette → 按上面"组合推荐"表选默认 palette,**不问**。

反之同理。
