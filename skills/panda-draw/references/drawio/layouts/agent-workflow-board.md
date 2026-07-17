# Layout · agent-workflow-board（Agent 工作流看板）

用于画“人 + Agent + 产物 + 质量门”的 AI 研发 / AI 协作流程。它学习的是
`6.drawio` 的构图语言：横向阶段看板、暖纸色分区、角色 / Agent / 文档 / 代码 /
gate 混排、失败回路和图例，而不是复制具体内容。

## 适用条件

必须同时满足：

- 主题有明确 Agent / AI coding / 人机协作 / 智能体编排 / 多 Agent 协作信号。
- 内容包含跨阶段流转，例如需求、方案、编码、评审、测试、验收、发布。
- 需要表达角色、Agent、产物、质量门或失败回路之间的协作关系。

仅出现“评审 / 测试 / 审批 / 多角色 / 多团队”但没有 Agent 或 AI 协作信号时，仍使用
`flowchart` 或其他常规 layout。

## 画布结构

- 推荐画布：`wide-landscape`，宽高比约 2.2-2.8:1。
- 横向分为 3-5 个阶段 panel：输入 / 设计执行 / 验收 / 发布。
- 主链路从左到右，优先排成 1-2 条水平泳道；能通过移动节点解决的，不用折线解决。
- 主链路默认使用动画线 `flowAnimation=1`，让 draw.io 源文件打开后有流动感；PNG 仍是静态预览。
- 失败回路走下方或外侧通道，不穿过节点；不要在画面中央来回折返。
- 阶段 panel 使用暖纸底色，角色和 gate 颜色必须有图例。
- 这个 layout 信息密度较高，必须先写 `*.plan.md`，不适用简单场景跳过计划。

## 密度与切页策略

这个 layout 的目标是表达协作结构，不是把每个执行细节都塞进一页。

- 单页建议 12-22 个语义节点，硬上限 25 个语义节点；stage panel、纯文本标签、图例项不计入。
- 每个阶段 panel 内最多放 5 个关键语义节点；超过 5 个时，保留主链路节点，把细节合并成 note 或拆到细节页。
- 超过 25 个语义节点时，默认生成多页 mxfile：第 1 页是总览看板，后续每页展开 1-2 个复杂阶段。
- 如果必须单页表达，优先抽象成“角色 / Agent / 产物 / gate”四类节点，不展开每个子任务。
- 不允许通过缩小字号、缩小 gate、压缩间距来容纳更多节点；字号、标签长度和外置标签 bbox 仍按 `common-rules.md` 约束执行。

## Layout-Owned Shape Tokens

palette 只提供颜色语义，形状和结构 token 归 layout 管。不要把下面的 shape token 放进
palette。

| token | 用途 | style 基础 |
| --- | --- | --- |
| `stage-panel` | 阶段背景 | `rounded=0;whiteSpace=wrap;html=1;container=1;collapsible=0;pointerEvents=0;fillColor=#F9F7ED;strokeColor=none;` |
| `stage-title` | 阶段标题 | `text;html=1;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;strokeColor=none;fillColor=none;fontSize=13;fontStyle=1;fontColor=<body-text>;` |
| `role-actor` | 人类角色 | `shape=actor;whiteSpace=wrap;html=1;fillColor=<role-fill>;strokeColor=<role-stroke>;fontColor=<body-text>;` |
| `agent-icon` | Agent 节点 | `shape=mxgraph.veeam.2d.agent;html=1;verticalLabelPosition=bottom;verticalAlign=top;align=center;outlineConnect=0;fillColor=<primary-stroke>;strokeColor=none;` |
| `doc-note` | 文档 / 计划 / 报告 | `shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=10;spacingRight=16;fillColor=<module-fill>;strokeColor=<neutral-stroke>;fontColor=<body-text>;` |
| `code-artifact` | 代码 / 工程产物 | `shape=mxgraph.aws4.source_code;html=1;fillColor=#232F3D;strokeColor=none;` |
| `gate-circle` | 小质量门 | `ellipse;whiteSpace=wrap;html=1;aspect=fixed;fillColor=<gate-fill>;strokeColor=<gate-stroke>;fontColor=<gate-text>;fontSize=10;fontStyle=1;` |
| `failed-pill` | 失败 / 返工标记 | `rounded=1;whiteSpace=wrap;html=1;arcSize=50;fillColor=<module-fill>;strokeColor=<error-stroke>;fontColor=<error-stroke>;fontSize=10;fontStyle=1;` |
| `hub` | 汇聚 / 编排节点 | `rounded=0;whiteSpace=wrap;html=1;fillColor=<primary-fill>;strokeColor=<primary-stroke>;fontColor=<body-text>;fontStyle=1;` |

`agent-icon` 和 `code-artifact` 不承载长文本。标签优先用独立 text cell 放在图标下方，
并预留固定 bbox；如果使用 draw.io 外置标签，也必须给周围节点保留至少 8px 空隙。

## 颜色纪律

- 默认搭配 `classic-soft`；需要更柔和的视觉时可搭配 `morandi-pastel`。
- `#F9F7ED` 是 layout 的 stage 背景，不计入 palette 的核心色数。
- 角色色和 gate 色属于同一套“有图例语义色系统”；出现 3 个以上角色或红绿 gate 时必须画 legend。
- 角色建议：业务=黄，研发=蓝，产品=紫，测试=绿。不要再额外引入无图例颜色。

## 文案规则

- 小 gate 直径通常 36-44px，中文标签最多 3 个字，例如：`评审`、`测试`、`准出`、`验收`。
- 超过 3 个中文字符的 gate 文案改成外部 text/pill，gate 本体只保留短词。
- Agent 图标、代码图标不写长 label；长说明放到相邻 note。
- `doc-note` 的折角必须小：`size` 建议 8-10，最大 12；右侧保留 `spacingRight=16`，避免折角压到文字。
- 同一阶段内 label 和节点之间至少留 8px，避免 PNG 上贴边。

## Plan 字段

实体表可追加这些列：

| 字段 | 值域 | 说明 |
| --- | --- | --- |
| `component_type` | `stage-panel` / `role-actor` / `agent-icon` / `doc-note` / `code-artifact` / `gate-circle` / `failed-pill` / `hub` / `label` | 决定使用哪个 layout token |
| `role` | `business` / `dev` / `product` / `test` / `agent` / `ops` | 用于角色色和 legend |
| `stage` | 自定义阶段 id | 用于检查节点归属和横向顺序 |
| `gate_type` | `review` / `test` / `acceptance` / `release` / `risk` | 决定 gate 色 |

关系表可追加 `route_type`：

| route_type | 视觉语义 |
| --- | --- |
| `main` | 主链路，默认直线，从左到右；同一水平泳道必须落到 `main-direct` token |
| `main-orthogonal` | 主链路跨泳道 / 错位 / 绕障碍时才用正交线 |
| `handoff` | 人 / Agent 交接，默认直线，可加短标签 |
| `failed-loop` | 失败回路，红色虚线，走外侧通道 |
| `review-return` | 评审退回，红色虚线或折线 |
| `async` | 异步触发，灰色虚线 |

## Edge Tokens

- 主链路直线（默认）：
  `edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;strokeColor=<primary-stroke>;strokeWidth=2;endArrow=classic;`
- 主链路正交（仅跨泳道或确需绕障碍时）：
  `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;flowAnimation=1;strokeColor=<primary-stroke>;strokeWidth=2;endArrow=classic;`
- 失败回路：
  `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;flowAnimation=1;strokeColor=<error-stroke>;strokeWidth=1.5;dashed=1;endArrow=classic;`
- 异步触发：
  `edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;flowAnimation=1;strokeColor=<neutral-stroke>;strokeWidth=1.5;dashed=1;endArrow=open;`

## 动线纪律

- 先排节点再连线：主链路节点的中心 y 尽量一致，让大部分边自然成为水平直线。
- 普通 `main` / `handoff` 边的折点预算是 0；同一水平泳道必须用 `edgeStyle=none` 的直线边。
- 只有跨泳道、跨阶段错位、需要绕障碍、失败/异步回路时，才允许 `orthogonalEdgeStyle` 和 waypoint。
- `async` 边最多 1 个视觉转折；`failed-loop` 可以走外侧 bus，但同一回路最多 3 段。
- 同一条水平泳道上，节点间距保持 55-90px；间距太小会让箭头和 label 粘在一起。
- 外围回路统一贴 stage 底部或画布底部，不要穿过 agent 图标、文档或 gate。
- 需要强调主流程时提高 `strokeWidth`，不要靠增加颜色或额外装饰。

## 验收重点

- 必须运行 `drawio_lint.py`，并检查外置标签 bbox warning。
- 必须导出 PNG 目视检查：外置标签不重叠、主链路基本水平直线、失败回路不穿节点、stage panel 不遮挡节点。
- 必须检查 `doc-note` 折角不遮挡文字：`size<=12` 且右侧留白充足。
- 必须打开 `.drawio` 源文件确认主链路含 `flowAnimation=1`，PNG 看不到动画不代表没有动画。
- gate 小圆里不能塞长句；长文案使用外部 label 或 `failed-pill`。
