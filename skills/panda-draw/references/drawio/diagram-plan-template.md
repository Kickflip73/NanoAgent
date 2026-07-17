# 图规格 plan 模板(AI 自用的内部蓝图)

> 借鉴 DiagrammerGPT(COLM 2024)的两阶段范式:**先把"画什么 + 谁在哪、多大"写成结构化规格,再生成最终 XML**。
> 让 LLM 先用草坐标把布局想清楚,重叠和连线穿越会显著减少——这是本地 .drawio(无 ELK 自动布线)出好图的关键一步。

## 这份文件是什么

`panda-draw` draw.io 模式在生成最终 XML **之前**,先产出一份 plan 文件,落 `tmp/panda-draw/drawio/<YYYYMMDD-HHMM>-<slug>.plan.md`。

它是 **AI 内部蓝图**,**不展示给用户**(SKILL.md 已删 Step 3 复合 gate,默认端到端跑完不打扰用户)。它的两个用途:

1. **给 Step 3 生成 XML 当蓝图**:严格按 plan 的实体清单 / 关系清单 / bbox 草排落 XML,不临场重想布局
2. **给迭代/局部改时当对照基线**:plan 文件留作快照,用户后续要求"改某节点"时,按 cell-id 局部改,不整图重生成
3. **Codex 商量时的上下文**:Step 5 自检失败找 Codex 时,把 plan + PNG + XML 一起发过去,Codex 看蓝图意图就知道该怎么改

plan 是中间产物,不是交付物;交付物是 `.drawio`。

## 何时必写 plan(硬条件)

**默认必写**。**同时**满足以下**全部**条件才允许跳过 plan,直接生成 XML:

- ≤5 节点
- 单一路径(线性主链路无分支)
- 无容器/泳道(parent 全部是 `1`)
- 无跨组/异常/回路边
- 输入**不是** wiki / 长文 / 文章路径(**只要是文章或 wiki 输入永远写 plan**)
- layout 不是 `agent-workflow-board`(**Agent 工作流看板永远写 plan**)

不满足任一条 = 必写 plan,哪怕节点不多。

## plan 文件格式

```markdown
---
slug: panda-mem-publish-flow
layout: dataflow          # 选定的布局预设(biz-arch/tech-arch/flowchart/dataflow/bridge/dense-modules/agent-workflow-board)
palette: classic-soft     # 选定的配色板(classic-soft/technical-blueprint/morandi-pastel/subway-transit/ikea-minimal)
aspect: landscape         # landscape(横版,默认)/ portrait(竖版)
node_count: 12            # 节点总数,用于规模控制(>25 自动走"总览+细节"或砍粒度)
group_count: 3
---

## 一句话目标

把 panda-mem 发布链路画成横向阶段推进图,体现「源料 → 转换 → 发布」三段。

## 实体清单(节点)

`parent` 字段决定 XML 里这个节点放在哪个 mxCell 下;`bbox` **始终是绝对画布坐标**(读 plan 时不用换算),Step 3 生成 XML 时若 parent 是真容器(tech-arch 层、flowchart 泳道、嵌套架构容器)再换算成 parent-relative。默认 `parent: 1`(画布根)。

| id | 标签(≤8字) | 分组 | parent | 草排 bbox [x,y,w,h](绝对画布) | 形状/语义 |
|----|-----------|------|--------|------------------------------|----------|
| c1 | 写正文     | 源料 | 1      | [40,80,120,40]               | 标准卡片 |
| c2 | 生成slug   | 转换 | 1      | [240,80,120,40]              | 标准卡片 |
| c3 | Hugo转换   | 转换 | 1      | [240,140,120,40]             | 标准卡片 |
| db1 | CF Pages  | 发布 | 1      | [440,80,90,60]               | 存储 cylinder3 |
| ...|           |      |        |                              |          |

tech-arch / flowchart 泳道这类真容器场景示例:

| id | 标签 | 分组 | parent | 草排 bbox [x,y,w,h] | 形状/语义 |
|----|------|------|--------|-------------------|----------|
| svc_layer | 服务层 | — | 1 | [40,140,900,180] | 层容器 swimlane |
| svc_a    | 鉴权服务 | 服务层 | svc_layer | [56,176,140,56] | 层内模块(绝对 bbox,生成 XML 时减 svc_layer 左上角) |

`agent-workflow-board` 必须在实体表后追加这些字段,避免图标 / gate / 失败回路只靠自然语言猜:

| id | 标签 | 分组 | parent | 草排 bbox [x,y,w,h] | 形状/语义 | component_type | role | stage | gate_type |
|----|------|------|--------|-------------------|----------|----------------|------|-------|-----------|
| actor_biz | 业务 | 需求输入 | 1 | [80,220,48,72] | 人类角色 | role-actor | business | input | — |
| agent_plan | 方案Agent | 方案执行 | 1 | [460,220,52,52] | Agent 图标 | agent-icon | agent | design | — |
| gate_review | 评审 | 方案执行 | 1 | [660,226,40,40] | 质量门 | gate-circle | — | design | review |
| fail_rework | 返工 | 方案执行 | 1 | [720,330,54,24] | 失败回路标记 | failed-pill | — | design | risk |

## 关系清单(连线)

| from | to | 方向 | 标签 | route_type | 备注 |
|------|----|----|------|------------|------|
| c1 | c2 | → | — | main | 主链路 |
| c2 | c3 | ↓ | — | main | — |
| c3 | db1 | → | 部署 | handoff | — |
| c5 | c8 | → | 回滚 | failed-loop | 旁路,虚线;会穿过 c6 → 加 waypoint |
| ...|    |    |      |      |

`agent-workflow-board` 的关系表里,`main` / `handoff` 默认表示同一水平泳道的直线边:
生成 XML 时优先用 `edgeStyle=none;exitX=1;exitY=0.5;entryX=0;entryY=0.5`。只有跨泳道、
错位或确需绕障碍时,才把 `route_type` 写成 `main-orthogonal` 并使用正交线 / waypoint。

## 分组/分层

- **源料**(虚线分组框,含 c1)
- **转换**(虚线分组框,含 c2 c3 c4)
- **发布**(虚线分组框,含 db1 c8 c9)

## 布局决策

- 主流向:从左到右(全图统一,不混向)
- 网格:`x = 40 + col×180`,`y = 40 + row×110`(分组框内从 (16,32) 起排)
- 风险点:c5→c8 会穿过 c6,加 `<Array as="points">` waypoint 沿外围绕行
- 图例:有彩色分类 → 右下角放图例
```

## bbox 草排规范(核心,别省)

**为什么要草排坐标**:本地 .drawio 没有自动布线,LLM 一边想"画什么"一边算最终坐标,容易顾此失彼——要么节点叠一起,要么连线穿过别的节点。先单独把"谁在哪、多大"用草坐标定下来,再生成 XML 时坐标已经是想好的,出框/重叠/穿越大幅减少。

草排不是最终坐标,是"够用的近似",遵守:

- **坐标系**:bbox 一律是 **draw.io 画布绝对像素坐标**,不用归一化;画布从 `(40,40)` 起步,全部非负。生成 XML 时:`parent: 1` 节点的 bbox 直接进 mxGeometry;`parent` 是真容器(tech-arch 层 / flowchart 泳道 / 嵌套架构容器)的节点,bbox 减去 parent 的左上角 → 写 parent-relative 坐标
- **宽度按标签字数定**:可容纳单行 CJK 字数 ≈ `(width-16)/fontSize`;宁可加宽,不缩字号到 12 以下(和 `common-rules.md` 通用硬规则一致)
- **尺寸照 `common-rules.md` 的尺寸表**:标准卡片 120×40、宽卡片 160×44、判断菱形 140×70、起止椭圆 100×40、存储 cylinder3 90×60
- **间距**:同组卡片间距 ≥16,组与组 ≥40,预留连线通道 ≥30
- **草排时就过一遍连线**:在"关系清单"的备注列标出"会穿过谁 / 要不要 waypoint / exit-entry 走哪侧",别等生成 XML 才发现

草排坐标和最终 XML 坐标可以有出入(生成时微调对齐),但**分组归属、相对位置、主流向不能变**——那是 plan 蓝图的核心结构。

## layout × palette 选定的逻辑

Step 1 自动选了 layout + palette 后,写 plan 时:

- frontmatter 的 `layout` 和 `palette` 字段必填,这两个字段决定 Step 3 读哪两个 reference 文件套样式 token
- bbox 草排时,**形状/尺寸跟随 layout**(如 tech-arch 用 swimlane 层容器,flowchart 用菱形判断节点,agent-workflow-board 用 role/agent/doc/code/gate token),**配色填进 frontmatter 即可不重复在每个节点写**——Step 3 生成 XML 时按 palette 配色板统一套
- shape / component token 归 layout 管,palette 只提供颜色语义;不要为了某张图临时新增 components 维度
- 拿不准选哪个 layout × palette → 走 Codex 商量(见 SKILL.md「找 Codex 商量」一节)
