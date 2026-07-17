# Layout · biz-arch(业务架构图)

提炼自用户历史手稿。**默认 layout** — 不确定时用这个。

## 适用 / 触发关键词

业务能力梳理、系统能力地图、职责分工、规划全景图。信息维度多、要体现分类分层。

**自动触发**:业务能力 / 规划 / 职责 / 全景 / 梳理 / 能力地图 / 战略 / 架构(非技术语境)

## 视觉特征

灰底圆角卡片为主体,虚线无填充分组框划区,彩色仅做分类点缀,左侧竖列大类标签,可选顶部阶段/时间轴,主链路用 flexArrow 大箭头。默认继承 `common-rules.md` 的直线优先、小折角 note、主链路动画规则。

## 推荐 palette

- 默认:`classic-soft`(柔和稳定,适合规划全景)
- 文艺/教程感:`morandi-pastel`(莫兰迪色调)
- 严肃技术:`technical-blueprint`(蓝图,慎用,会和 tech-arch 重叠)

## 形状 Token 表

颜色 token **全部由 palette 套入**,以下 hex 是 classic-soft 示例值,实际生成时按选定 palette 替换。

### 分类强调卡的「语义色」选择(本 layout 定义)

`<palette 语义色 fill/stroke>` 是 layout 复合字段。biz-arch 主体是灰底卡片(`<palette 中性 fill/stroke>`),分类强调卡按内容语义选 palette 的 1-3 个语义色:

- 系统 / 平台 / 接入 → 蓝(palette 蓝)
- 正向 / 完成 / 数据 → 绿(palette 绿)
- 进行中 / 警告 / 待办 → 黄(palette 黄)
- 外部 / 第三方 / 合作 → 紫(palette 紫)
- 重点 / 风险 / 异常 → 橙(palette 橙)

整图分类色 ≤4 种;有彩色分类必须带图例(common-rules.md 硬规则)。

```text
标准卡片:   rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=<palette 中性 fill>;strokeColor=<palette 中性 stroke>;fontColor=<palette 正文字>;fontSize=13;
分类强调卡: rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=<palette 语义色 fill>;strokeColor=<palette 语义色 stroke>;fontColor=<palette 正文字>;fontSize=13;
文档/说明:   shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=8;spacingRight=16;fillColor=<palette 模块底>;strokeColor=<palette 中性 stroke>;fontColor=<palette 正文字>;fontSize=12;
分组虚线框: rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=<palette 辅助线>;verticalAlign=top;align=left;spacingLeft=8;spacingTop=4;fontSize=13;fontColor=<palette 副标题字>;
左侧大类标签: text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=15;fontStyle=1;fontColor=<palette 正文字>;
主流程大箭头: shape=flexArrow;endArrow=classic;html=1;rounded=0;width=6;endSize=5;endWidth=12;fillColor=<palette 中性 fill>;strokeColor=<palette 主链路>;fontSize=13;fontColor=<palette 正文字>;
水平直线:   edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;strokeColor=<palette 主链路>;strokeWidth=2;endArrow=classic;
普通折线:   edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=<palette 主链路>;endArrow=classic;
```

`<palette 中性 fill>` / `<palette 主链路>` / `<palette 正文字>` 等字段在 selected palette 文件里查具体 hex(见各 palette 的「语义配色表」+「连线 strokeColor」+「字色」段)。例如 classic-soft 时 `<palette 中性 fill>` = `#f5f5f5`,`<palette 主链路>` = `#666666`,`<palette 正文字>` = `#333333`;换 morandi-pastel 时 `<palette 中性 fill>` = `#F5F0E6`,`<palette 主链路>` = `#7A6F5E`,`<palette 正文字>` = `#4A4A4A`。

## flexArrow 特殊语法

**flexArrow 是边形状,必须 `edge="1"`,不是 vertex**。两个分组框之间的装饰性大箭头不连具体节点,用 sourcePoint/targetPoint 定位:

```xml
<mxCell id="arrow1" style="shape=flexArrow;endArrow=classic;html=1;rounded=0;width=6;endSize=5;endWidth=12;fillColor=#f5f5f5;strokeColor=#666666;" edge="1" parent="1">
  <mxGeometry relative="1" as="geometry">
    <mxPoint x="466" y="165" as="sourcePoint"/>
    <mxPoint x="514" y="165" as="targetPoint"/>
  </mxGeometry>
</mxCell>
```

## 布局骨架

1. 顶部(可选): 时间轴/阶段轴 — 细长箭头 + text 阶段标签
2. 左列: 大类标签竖排(每个大类一行带,宽 ~90)
3. 主体: 每个大类一条横带,带内若干虚线分组框,框内卡片网格排列(每行 ≤4 张)
4. 跨带主流程用 flexArrow;同一横带内细粒度关系优先用 `水平直线`,跨带/绕障碍才用 `普通折线`
5. 右上角或底部: 图例(有彩色分类时必须有)

**分组框做"视觉分组"**(卡片 parent 仍是 "1",坐标用绝对值,框画在卡片底下先声明)或"真容器"(卡片 parent=框 id,坐标相对框)均可;**同一张图只用一种方式**,真容器方式框 style 需追加 `container=1;pointerEvents=0;`。

## 示例片段(一个分组 + 两张卡 + 一条线)

```xml
<mxCell id="zone1" value="线索采集" style="rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#999999;verticalAlign=top;align=left;spacingLeft=8;spacingTop=4;fontSize=13;fontColor=#666666;" vertex="1" parent="1">
  <mxGeometry x="160" y="120" width="300" height="110" as="geometry"/>
</mxCell>
<mxCell id="c1" value="自动采集" style="rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=#f5f5f5;strokeColor=#666666;fontColor=#333333;fontSize=13;" vertex="1" parent="1">
  <mxGeometry x="176" y="156" width="120" height="40" as="geometry"/>
</mxCell>
<mxCell id="c2" value="BD 录入" style="rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=#dae8fc;strokeColor=#6c8ebf;fontColor=#333333;fontSize=13;" vertex="1" parent="1">
  <mxGeometry x="320" y="156" width="120" height="40" as="geometry"/>
</mxCell>
<mxCell id="e1" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=#666666;endArrow=classic;exitX=1;exitY=0.5;entryX=0;entryY=0.5;" edge="1" parent="1" source="c1" target="c2">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

## 布局变体(挂 biz-arch 下的子骨架)

后续 P2 任务补:bento-grid / comparison-matrix / hierarchical-layers / hub-spoke / jigsaw / venn-diagram。

每个变体在这里加一段说明:何时用、骨架要点、和主骨架的关系。
