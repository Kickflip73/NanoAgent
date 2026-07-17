# Layout · dense-modules(高密度信息图)

借鉴 baoyu-infographic `dense-modules` 骨架。6-9 个带分类色 + 编号标签的紧密模块网格,小红书/知乎风的完整指南、能力清单、checklist。

## 适用 / 触发关键词

完整指南、能力清单、买家指南、checklist、能力盘点、维度全景、高密度信息汇总。

**自动触发**:完整指南 / 全景清单 / 一图看懂 / 能力盘点 / 多维度 / checklist / 大全 / X 类 Y 维度

## 视觉特征

竖版网格(3 列 × 2-3 行)或横版网格(3-4 列 × 2 行),每个模块带:**编号** + **分类色条** + **简短标题** + **2-3 行核心要点**。模块之间紧贴(间距小),整体填满画布。**不强调主线流程**,强调"维度并列"。

## 推荐 palette

- 默认:`classic-soft`(6 语义色循环用作模块色条,信息密度高时柔和不刺眼)
- 多分类强对比:`subway-transit`(6 条线色,适合分类多 ≥ 5 个的情况)
- 内容/教程类:`morandi-pastel`

## 形状 Token 表

颜色全由 palette 套入。**模块色条**的 fill 必须用 palette **stroke**(深色),才能配白字得到足够对比;palette 浅色 fill 是给模块底色用的。

### 分类 → 语义色映射(本 layout 定义)

`<palette 分类色 fill/stroke>` 是 layout 复合字段,按"分类编号 N → 第 N 个语义色"映射,再查 palette 占位映射拿 hex:

| 分类编号 | 映射到 palette 语义色 |
|---|---|
| 第 1 类 | 蓝(palette 蓝 fill/stroke) |
| 第 2 类 | 绿(palette 绿 fill/stroke) |
| 第 3 类 | 黄(palette 黄 fill/stroke) |
| 第 4 类 | 紫(palette 紫 fill/stroke) |
| 第 5 类 | 橙(palette 橙 fill/stroke) |
| 第 6 类 | 红/异常(palette 红/异常 fill/stroke) |

超过 6 类:合并相似分类,或换 palette(subway-transit 也只有 6 条线色,本质同上限)。

```text
模块主框: rounded=1;whiteSpace=wrap;html=1;arcSize=4;fillColor=<palette 模块底>;strokeColor=<palette 分类色 stroke>;strokeWidth=1.5;fontColor=<palette 正文字>;fontSize=12;verticalAlign=top;align=left;spacingLeft=10;spacingTop=8;
模块色条: rounded=0;whiteSpace=wrap;html=1;fillColor=<palette 分类色 stroke>;strokeColor=<palette 分类色 stroke>;fontColor=#FFFFFF;fontSize=11;fontStyle=1;align=center;verticalAlign=middle;
          (注意:色条 fill 用 palette 分类色 stroke 深色,fontColor 强制白色;白色 stroke 在分类色 stroke 上对比足够)
模块编号: text;html=1;align=center;verticalAlign=middle;fontSize=20;fontStyle=1;fontColor=<palette 分类色 stroke>;
模块标题: text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=13;fontStyle=1;fontColor=<palette 正文字>;
模块要点: text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=11;fontColor=<palette 副标题字>;
区块图标(可选): rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=none;(用 draw.io 内置 shape 库的 emoji/icon)
```

**technical-blueprint 例外覆盖**:`technical-blueprint` palette 模块底 `#2B4868`(深色)+ 白字。token 表的"色条 fill = `<palette 分类色 stroke>`"在此 palette 下指向深色蓝绿黄紫等(#5A7FAA / #4A8B6D 等),色条会和模块底相邻深色相混。**覆盖规则**:用 `technical-blueprint` 时,模块色条 fill 改用 `<palette 黄 fill>`(琥珀 `#F59E0B`),fontColor 改用 `#222222`(黑字),用最亮的琥珀 + 黑字突破深底层次;模块编号 fontColor 也改用 `<palette 黄 fill>` 琥珀。其他 palette 走上面默认 token,不需覆盖。

## 布局骨架

```
+------+------+------+
| 01   | 02   | 03   |
| 模块 | 模块 | 模块 |
+------+------+------+
| 04   | 05   | 06   |
| 模块 | 模块 | 模块 |
+------+------+------+
```

1. 标题区(画布顶部):大字号画图主题 + 副标题(可选)
2. 模块网格:3 列 × 2-3 行(横版)或 2 列 × 3-4 行(竖版),模块尺寸建议 240×160 或 280×140
3. 每个模块内部布局:
   - 左上角:大字号编号(`01` `02` ...)
   - 右上角或顶部条:分类色条(filled 矩形带白字分类名)
   - 正文区:加粗标题 + 2-3 行要点
   - 可选右下角:emoji / shape 库图标
4. 模块间距 16-24px,**比常规图小**,体现"密度"
5. 不画连线;模块之间是**并列关系**,顺序由编号体现
6. 整体留白:画布四周 padding 40,模块之间 padding 16

## 示例片段(一个模块,classic-soft palette,蓝色分类)

示例 hex 已遵循上面 token 表的规则:模块主框 fill `#ffffff`(classic-soft 模块底)/ stroke `#6c8ebf`(蓝 stroke);**色条** fill 也用 `#6c8ebf`(蓝 stroke,非蓝 fill)+ 白字,得到足够对比;编号字色用 `#6c8ebf`(分类色 stroke)。

```xml
<mxCell id="m1" value="" style="rounded=1;whiteSpace=wrap;html=1;arcSize=4;fillColor=#ffffff;strokeColor=#6c8ebf;strokeWidth=1.5;" vertex="1" parent="1">
  <mxGeometry x="60" y="120" width="240" height="160" as="geometry"/>
</mxCell>
<mxCell id="m1_bar" value="架构" style="rounded=0;whiteSpace=wrap;html=1;fillColor=#6c8ebf;strokeColor=#6c8ebf;fontColor=#ffffff;fontSize=11;fontStyle=1;align=center;verticalAlign=middle;" vertex="1" parent="1">
  <mxGeometry x="60" y="120" width="60" height="22" as="geometry"/>
</mxCell>
<mxCell id="m1_no" value="01" style="text;html=1;align=center;verticalAlign=middle;fontSize=20;fontStyle=1;fontColor=#6c8ebf;" vertex="1" parent="1">
  <mxGeometry x="260" y="124" width="36" height="24" as="geometry"/>
</mxCell>
<mxCell id="m1_title" value="LLM 主导编译" style="text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=13;fontStyle=1;fontColor=#333333;" vertex="1" parent="1">
  <mxGeometry x="70" y="150" width="220" height="22" as="geometry"/>
</mxCell>
<mxCell id="m1_body" value="离线把源料编译成结构化条目,绕过 RAG;查询时直接搜索 markdown" style="text;html=1;align=left;verticalAlign=top;whiteSpace=wrap;fontSize=11;fontColor=#666666;" vertex="1" parent="1">
  <mxGeometry x="70" y="180" width="220" height="90" as="geometry"/>
</mxCell>
```
