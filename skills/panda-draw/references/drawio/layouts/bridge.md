# Layout · bridge(战略转型对比图)

借鉴 baoyu-infographic `bridge` 骨架。左侧"现状",右侧"未来",中间跨越台阶/箭头叙事。

## 适用 / 触发关键词

战略转型、迁移方案、before-after 对比、版本升级、范式转移、能力对比。

**自动触发**:转型 / 迁移 / 升级 / 从 X 到 Y / before-after / V1 vs V2 / 现状 → 未来 / 取代 / 替换 / 演进

## 视觉特征

横向三段式:**左卡片堆叠表"现状/问题"** + **中间跨越箭头/台阶表"转型路径"** + **右卡片堆叠表"未来/方案"**。中间台阶通常 3-5 步,标明从 A 到 B 关键转变。

## 推荐 palette

- 默认:`classic-soft`(左灰 → 中蓝箭头 → 右绿,情感语义:沉重 → 推进 → 正向)
- 严谨技术演进:`technical-blueprint`
- 教学温和:`morandi-pastel`

## 形状 Token 表

颜色全由 palette 套入。

```text
左侧现状卡(灰沉): rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=<palette 中性 fill>;strokeColor=<palette 中性 stroke>;fontColor=<palette 正文字>;fontSize=13;
右侧未来卡(主色): rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=<palette 绿 fill>;strokeColor=<palette 绿 stroke>;fontColor=<palette 正文字>;fontSize=13;
中间台阶块: shape=step;perimeter=stepPerimeter;whiteSpace=wrap;html=1;fixedSize=1;size=20;fillColor=<palette 蓝 fill>;strokeColor=<palette 蓝 stroke>;fontColor=<palette 正文字>;fontSize=13;fontStyle=1;
跨越主箭头: shape=flexArrow;endArrow=classic;html=1;rounded=0;width=8;endSize=5;endWidth=18;fillColor=<palette 蓝 fill>;strokeColor=<palette 蓝 stroke>;fontColor=<palette 正文字>;fontSize=14;fontStyle=1;
区块大标题: text;html=1;align=center;verticalAlign=middle;whiteSpace=wrap;fontSize=16;fontStyle=1;fontColor=<palette 正文字>;
分组框: rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=<palette 辅助线>;verticalAlign=top;align=center;spacingTop=4;fontSize=13;fontColor=<palette 副标题字>;
```

## 布局骨架

```
+---------------+    +-------------------+    +---------------+
|  现状(左)    |   |  转型路径(中)   |   |  未来(右)   |
|  ┌──────┐   |   |  step1 → step2 → |   |  ┌──────┐   |
|  │卡 1  │   |   |  step3           |   |  │卡 1  │   |
|  └──────┘   |   |                  |   |  └──────┘   |
|  ┌──────┐   |   |  flexArrow 跨越   |   |  ┌──────┐   |
|  │卡 2  │   |   |  现状 → 未来      |   |  │卡 2  │   |
|  └──────┘   |   |                  |   |  └──────┘   |
+---------------+    +-------------------+    +---------------+
```

1. 左右两侧各一个虚线分组框,标题分别"现状 / 当前痛点"和"未来 / 目标"
2. 中间区域 step 块串联(3-5 个,横向相接),表示转型的关键步骤
3. 横跨左右的大 flexArrow,起点在左侧区域中心、终点在右侧区域中心(用 sourcePoint/targetPoint 定位,不连具体节点),作为"叙事主轴"
4. 主流向严格从左到右,不混向
5. 顶部可加一行总标题(text shape)概括转型主题
6. 左侧卡片可用沉色调(灰),右侧用主色调(绿)强化"问题→改善"的视觉对比

## 示例片段(三段大致比例 280:240:280)

```xml
<mxCell id="zone_now" value="现状(2025)" style="rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#999999;verticalAlign=top;align=center;spacingTop=4;fontSize=13;fontColor=#666666;" vertex="1" parent="1">
  <mxGeometry x="40" y="80" width="280" height="280" as="geometry"/>
</mxCell>
<mxCell id="zone_path" value="转型路径" style="rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#999999;verticalAlign=top;align=center;spacingTop=4;fontSize=13;fontColor=#666666;" vertex="1" parent="1">
  <mxGeometry x="340" y="80" width="240" height="280" as="geometry"/>
</mxCell>
<mxCell id="zone_next" value="未来(2026)" style="rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#999999;verticalAlign=top;align=center;spacingTop=4;fontSize=13;fontColor=#666666;" vertex="1" parent="1">
  <mxGeometry x="600" y="80" width="280" height="280" as="geometry"/>
</mxCell>
<mxCell id="arrow_bridge" style="shape=flexArrow;endArrow=classic;html=1;rounded=0;width=8;endSize=5;endWidth=18;fillColor=#dae8fc;strokeColor=#6c8ebf;" edge="1" parent="1">
  <mxGeometry relative="1" as="geometry">
    <mxPoint x="180" y="220" as="sourcePoint"/>
    <mxPoint x="740" y="220" as="targetPoint"/>
  </mxGeometry>
</mxCell>
```
