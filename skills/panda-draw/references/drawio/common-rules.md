# 通用硬规则(所有 layout × palette 组合共用)

这是 `panda-draw` draw.io 模式**所有 layout 和 palette 组合都必须遵守**的最底层规则,从 layout/palette 的具体 token 抽离出来。生成 XML 时,无论选哪个 layout × palette,都先读本文件。

## Token 优先级(关键,先读)

`layout × palette` 的 token 表分工:

1. **layout 文件** 提供:**形状选择**(矩形 / 椭圆 / 菱形 / 步骤块 / 泳道)+ **尺寸**(width / height / arcSize)+ **结构 token**(swimlane / flexArrow / cylinder3 等 shape 名)+ **布局骨架**
2. **palette 文件** 提供:**颜色全套**(fillColor / strokeColor / fontColor / 连线 stroke 色)
3. **visual-hierarchy.md** 提供:**描边粗细 / 字号节奏 / 强调标记 / 留白 / 对齐 / 图例**(跨 layout × palette 共用层次规则)

**优先级(发生冲突时谁说了算)**:`palette > visual-hierarchy > layout > common-rules`

- **palette 永远覆盖 layout token 里的颜色**:layout 里看到 `fontColor=#333333` `strokeColor=#666666` `fillColor=#ffffff` 等具体 hex,**视为示例占位**,生成 XML 时按选定 palette 的同语义色替换
- **visual-hierarchy 的描边粗细规则覆盖 layout token 的 strokeWidth**:如 layout 写 `strokeWidth=2`,visual-hierarchy 主链路定义为 `2.5`,以 visual-hierarchy 为准
- **layout 的结构 token / 形状选择不能被 palette 覆盖**:palette 不动 shape 名、shape 尺寸、布局骨架
- **common-rules 是底线兜底**:任何 token 不能违反"文字不出框 / 尺寸表"等硬规则

**LLM 实操**:Step 3 生成 XML 时,先读 selected layout 拿形状/尺寸/结构,再读 selected palette 拿颜色全套,把 layout token 里的颜色占位替换成 palette 同语义色;描边粗细按 visual-hierarchy 三级套(主链路 / 辅助 / 强调)。本文件 + xml-reference.md 是底线。

## Palette 占位字段 Schema(关键,5 个 palette 必须按此 schema 实现)

所有 layout token 表引用的 `<palette ...>` 占位字段,5 个 palette 的「占位映射」段必须**逐项**给出 hex。如下 schema 是 layout 可引用的全集:

**字色族(4 个)**
- `<palette 正文字>` — 大区域 / 主标签字色
- `<palette 模块文字>` — 模块底之上的字色(浅底 palette 同正文字,深底 palette 是白)
- `<palette 副标题字>` — 分组框副标题 / 图例 / 备注字色
- `<palette 强调字>` — 整图 ≤2 处的强调字色(红 / 蓝 / 主题色)

**结构色族(3 个)**
- `<palette 中性 fill>` / `<palette 中性 stroke>` — 默认卡片底 / 描边
- `<palette 模块底>` — 容器内模块卡的底色(浅底 palette 是 `#FFFFFF`;深底 palette 是中明度 `#2B4868`)
- `<palette 主链路>` / `<palette 辅助线>` — 主流程边 / 辅助旁路边

**语义色族(6 组,每组 fill+stroke)**
- `<palette 蓝 fill>` / `<palette 蓝 stroke>` — 系统 / 平台 / 接入语义
- `<palette 绿 fill>` / `<palette 绿 stroke>` — 正向 / 完成 / 数据语义
- `<palette 黄 fill>` / `<palette 黄 stroke>` — 进行中 / 警告 / 数据存储
- `<palette 紫 fill>` / `<palette 紫 stroke>` — 外部 / 第三方
- `<palette 橙 fill>` / `<palette 橙 stroke>` — 重点 / 风险 / 异常
- `<palette 红/异常 fill>` / `<palette 红/异常 stroke>` — 严重异常 / 回滚(可与橙合并使用)

**Layout 复合字段**(由 layout 文件本身定义如何套语义色,palette 不直接给):
- `<palette 层色 fill>` / `<palette 层色 stroke>` — tech-arch 层容器色,由 tech-arch.md 定义"接入层=蓝,服务层=绿,..."后映射到语义色
- `<palette 同层 stroke>` — tech-arch 层内模块描边,等于该模块所在层的语义色 stroke
- `<palette 分类色 fill>` / `<palette 分类色 stroke>` — dense-modules 模块的分类色,由 layout 用"分类编号 N → 第 N 个语义色"映射(超 6 类合并)
- `<palette 语义色 fill>` / `<palette 语义色 stroke>` — biz-arch 分类强调卡的语义色,等同语义色族 fill/stroke

**LLM 套用 layout 时**:看到 `<palette 层色 ...>` `<palette 同层 ...>` `<palette 分类色 ...>` `<palette 语义色 ...>` 这类 Layout 复合字段,**先按 layout 文件里的"层/分类编号→语义色"映射规则定到具体语义色**,再套 palette 同语义色的 hex。

## 文字永不出框 — 第一优先级

- 所有 vertex style 必含 `whiteSpace=wrap;html=1`
- 卡片可容纳单行 CJK 字数 ≈ `(width - 16) / fontSize`,例: 宽 120、字号 13 → 8 个汉字。**写 XML 前先数标签字数定宽度**,宁可加宽,**不许缩字号到 12 以下**
- 标签超过 2 行 → 精简文字,长说明移到分组框副标题或图例,不要做 3 行卡片
- 菱形(rhombus)文字区只有外框的 ~52%,标签 ≤6 个汉字;云朵(cloud)~55%,标签 ≤4 个汉字
- `shape=note` 必须显式写小折角:`size=8~10`,最大 12;同时加 `spacingRight=16`,避免折角遮挡右侧文字

## 尺寸与网格

| 元素 | 默认尺寸 | 说明 |
|---|---|---|
| 标准卡片 | 120×40 | ≤8 汉字单行;两行加高到 52 |
| 宽卡片 | 160×44 | 9-11 汉字 |
| 判断菱形 | 140×70 | ≤6 汉字 |
| 起止椭圆 | 100×40 | ≤5 汉字 |
| 存储 cylinder3 | 90×60 | 标签短写 |
| 文档 note | 108×60 起 | 必含 `size=8~10;spacingRight=16`;右上折角不遮字 |
| 分组框 | 内容包络 + 四周 padding ≥16, 顶部 ≥28(留标题) | |

- 坐标全部非负,画布从 `(40, 40)` 起步
- 同组卡片间距 ≥16px;组与组 ≥40px;预留连线通道 ≥30px
- 列网格 `x = 40 + col×180`,行网格 `y = 40 + row×110`(分组框内从 (16, 32) 起排)
- 单页上限 ~1600×1100;**超过自动走"总览页 + 细节页"**(mxfile 多 `<diagram>`)或抽象一层,不再问用户

## 连线纪律(本地 .drawio 无 ELK 自动布线,路由自己负责)

- **直线优先**:同一水平/垂直泳道且无遮挡时,用直线边,不要用正交狗腿线。水平直线:
  `edgeStyle=none;rounded=0;html=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;endArrow=classic;`;垂直直线:
  `edgeStyle=none;rounded=0;html=1;exitX=0.5;exitY=1;entryX=0.5;entryY=0;endArrow=classic;`
- **正交线只用于需要转弯的边**:跨泳道、跨层错位、绕障碍、异常/回滚/旁路时,才用 `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;`
- **回流线走外侧通道**:返工/回滚/重试指向上游节点时,先出到主流程外侧通道,再从目标节点的上边或下边进入;入口可用 `entryX=0.3/0.7/0.8` 避开主线。不要让 draw.io 自动从目标右侧生成水平向左的箭头,那会像"回折倒插"。典型上方回流:
  `edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;flowAnimation=1;exitX=0.5;exitY=0;entryX=0.5;entryY=0;dashed=1;endArrow=classic;`
- 主流向一致: 自上而下 或 从左到右,选一个
- 每条边显式 `exitX/exitY/entryX/entryY`: 下行流 exit(0.5,1)→entry(0.5,0),右行流 exit(1,0.5)→entry(0,0.5);**禁止角点**(两个坐标同时为 0/1)
- 同一对节点两条边,exit/entry 错开(0.3/0.7),不许共路径
- 边会穿过第三个节点时,加 `<Array as="points">` waypoint 沿外围绕行,离节点边界 ≥20px
- 边标签 ≤4 字(是/否/成功/失败)
- 流程/链路/调用方向明显的图,主链路加 `flowAnimation=1`;PNG 不显示动画,交付前仍要打开 `.drawio` 或查 XML 确认

## 字色与对比

- **字色具体值由 palette 决定**:浅底用深字、暗底用白字、柔底用对应主题色。本文件示例里出现的 `#333333` 等仅为占位,以 palette 同语义为准
- **强调文字**:语义"高风险/警示",颜色用 palette 的"强调字"色(如 classic-soft 红 `#FF0000`、morandi-pastel 主题棕、ikea-minimal 警示红)。整图 ≤2 处
- 同一语义同一颜色;颜色种类一张图 ≤4 种 + 中性灰;**有彩色分类必须带图例**

## 中文标签简短化(设计动作,不是偷懒)

砍字优先于缩字号(fontSize ≥12),优先于撑大节点。长概念起短名,全称放分组框副标题或图例。

## 通用元素 token(layout/palette 共用,颜色由 palette 套入)

```text
图标题(画布顶):   text;html=1;align=left;verticalAlign=middle;fontSize=18;fontStyle=1;fontColor=<palette 正文字>;
区块标题(分组内): text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=15;fontStyle=1;fontColor=<palette 正文字>;
图例项:           rounded=0;whiteSpace=wrap;html=1;fontSize=11;fontColor=<palette 正文字>;(fill/stroke 用 palette 对应语义色)
暖纸色分区:       rounded=0;whiteSpace=wrap;html=1;container=1;collapsible=0;pointerEvents=0;fillColor=#F9F7ED;strokeColor=none;
文档 note:        shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=8;spacingRight=16;fillColor=<palette 模块底>;strokeColor=<palette 中性 stroke>;fontColor=<palette 正文字>;fontSize=12;
水平主链路:       edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;strokeColor=<palette 主链路>;strokeWidth=2;endArrow=classic;
垂直主链路:       edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=0.5;exitY=1;entryX=0.5;entryY=0;strokeColor=<palette 主链路>;strokeWidth=2;endArrow=classic;
上方回流线:       edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;flowAnimation=1;exitX=0.5;exitY=0;entryX=0.5;entryY=0;strokeColor=<palette 橙 stroke>;strokeWidth=1.5;dashed=1;endArrow=classic;
```

`<palette 正文字>` 字段查 palette 文件的「字色」段(classic-soft 为 `#333333`,technical-blueprint 为 `#FFFFFF`,morandi-pastel 为 `#4A4A4A`,subway-transit 为 `#222222`,ikea-minimal 为 `#222222`)。

## XML 良构(摘自 xml-reference.md,在此重申硬底线)

- 明文 mxfile,不压缩(deflate base64 禁用)
- **绝不**输出 XML 注释 `<!-- -->`
- 每个 mxCell id 唯一;边的 source/target 必须引用存在的 id
- 每条边 `<mxGeometry relative="1" as="geometry"/>` 子元素必备,自闭合边不渲染
- 属性值转义: `&amp;` `&lt;` `&gt;` `&quot;`;换行用 `&lt;br&gt;`(需 html=1),绝不用 `\n`

详细 XML 语法见 `xml-reference.md`,视觉层次细节见 `visual-hierarchy.md`,布局骨架见 `layouts/<选定>.md`,配色板见 `palettes/<选定>.md`。
