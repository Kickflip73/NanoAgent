# draw.io XML 参考(本地文件适配版)

> 改编自官方 [jgraph/drawio-mcp `shared/xml-reference.md`](https://github.com/jgraph/drawio-mcp/blob/main/shared/xml-reference.md)(2026-06 vendor)。
> **关键适配**: 官方原文面向 MCP App Server,假设浏览器 viewer 会跑 ELK 自动布线后处理("不用设 exitX/entry、不用加 waypoint")。本 skill 的产物是**本地 .drawio 文件 + 桌面 app 打开,没有任何自动布线后处理**,所以本版删掉了 ELK 依赖,边路由规则反向收紧(见「边的手动路由纪律」)。删除了 MCP 工具相关内容(search_shapes / postLayout)。

## 文件结构

`.drawio` 文件是明文 mxfile XML(**不要生成压缩格式**):

```xml
<mxfile host="app.diagrams.net">
  <diagram id="page1" name="第 1 页">
    <mxGraphModel dx="1422" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0" adaptiveColors="auto">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <!-- 这里禁止真的写注释;所有图元 mxCell 平铺在 root 下,parent="1" -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

- `id="0"` 是根,`id="1"` 是默认图层,两者必须存在
- 所有 mxCell **XML 层面平铺**为 root 的兄弟节点,层级关系只靠 `parent` 属性表达;**禁止把 mxCell 嵌套进另一个 mxCell**
- 横版图用 `pageWidth="1169" pageHeight="826"`(A4 landscape);竖版互换
- id 从 "2" 起用语义化短 id(如 `zone1` `c3` `e7`),全文件唯一

## 常用形状

```xml
<mxCell id="2" value="标签" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="120" height="60" as="geometry"/>
</mxCell>

<mxCell id="3" value="判断?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1">
  <mxGeometry x="100" y="200" width="120" height="80" as="geometry"/>
</mxCell>
```

## 样式属性速查

| 属性 | 取值 | 用途 |
|----------|--------|---------|
| `rounded=1` | 0/1 | 圆角(`arcSize=8` 控制弧度) |
| `whiteSpace=wrap` | wrap | 文字换行(所有 vertex 必带) |
| `html=1` | 0/1 | 标签 HTML 渲染(所有 cell 必带) |
| `fillColor=#dae8fc` | hex/none | 填充色 |
| `strokeColor=#6c8ebf` | hex/none | 边框色 |
| `fontColor=#333333` | hex | 字色 |
| `fontSize=13` / `fontStyle=1` | px / 1=粗 2=斜 4=下划线(可按位或) | 字号字重 |
| `align` / `verticalAlign` | left/center/right, top/middle/bottom | 标签对齐 |
| `spacingLeft=8;spacingTop=4` | px | 标签内边距 |
| `dashed=1` | 0/1 | 虚线 |
| `ellipse` / `rhombus` / `text` | 首 token | 椭圆/菱形/纯文本 |
| `shape=cylinder3` | 形状名 | 数据库(`boundedLbl=1;backgroundOutline=1;size=12`) |
| `shape=document` / `shape=cloud` / `shape=process` / `shape=step` | 形状名 | 文档/云/子流程/阶段块 |
| `shape=flexArrow` | 形状名 | 粗箭头(主流程视觉轴) |
| `swimlane` | 首 token | 带标题条容器(`startSize` 控制标题条厚度) |
| `group` | 首 token | 不可见分组容器 |
| `container=1` + `pointerEvents=0` | 0/1 | 任意形状变真容器 |
| `opacity=50` | 0-100 | 透明度 |

## HTML 标签规则

- `value` 含 HTML(`<b>` `<br>` `<font>` 等)时 style 必含 `html=1`;属性值里 HTML 必须 XML 转义: `<`→`&lt;` `>`→`&gt;` `&`→`&amp;` `"`→`&quot;`
- 换行用 `&lt;br&gt;`(需 html=1)或 `&#xa;`;**绝不用 `\n`**(会渲染成字面反斜杠 n)
- 整段加粗用 `fontStyle=1`,局部加粗才用 `&lt;b&gt;`;两者不要叠用

```xml
<mxCell id="4" value="&lt;b&gt;标题&lt;/b&gt;&lt;br&gt;说明文字" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">
  <mxGeometry x="100" y="100" width="120" height="60" as="geometry"/>
</mxCell>
```

## 边(edge)

**硬规则: 每条边必须有 `<mxGeometry relative="1" as="geometry"/>` 子元素**,自闭合边 cell 不渲染:

```xml
<mxCell id="e1" value="是" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=classic;exitX=0.5;exitY=1;entryX=0.5;entryY=0;" edge="1" parent="1" source="a" target="b">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>
```

| 边风格 | 语法 | 适用 |
|-------|--------|---------|
| 正交 | `edgeStyle=orthogonalEdgeStyle` | 流程/架构/网络(默认选这个) |
| 直线 | 不写 edgeStyle | UML 类图/时序消息 |
| ER | `edgeStyle=entityRelationEdgeStyle` | ER 图(两端垂直短桩) |
| 曲线 | `curved=1` | 脑图/非正式 |

通用属性: `rounded=1`(拐角圆滑)、`endArrow=classic/block/open/none`、`startArrow`、`dashed=1`、`strokeWidth=2`、边标签直接写 `value`。**一张图统一一种边风格。**

### 边的手动路由纪律(替代官方 ELK 段)

本地文件打开时 mxGraph 只做朴素正交折线,**不会全局避障**。生成边时:

1. **显式指定连接点**: 每条边写 `exitX/exitY/entryX/entryY`。下行流 `exitX=0.5;exitY=1` → `entryX=0.5;entryY=0`;右行流 `exitX=1;exitY=0.5` → `entryX=0;entryY=0.5`。**禁止角点连接**(X、Y 同时取 0/1)
2. **同对节点多条边错开**: 第一条 0.3、第二条 0.7,不许共路径;双向(A↔B)走两侧对开
3. **预判穿越**: 写边前看 source 与 target 之间有没有第三个节点;有就加 waypoint 沿外围绕行,离障碍边界 ≥20px:

```xml
<mxCell id="e2" style="edgeStyle=orthogonalEdgeStyle;html=1;exitX=0.5;exitY=0;entryX=1;entryY=0.5;endArrow=classic;" edge="1" parent="1" source="hotfix" target="main">
  <mxGeometry relative="1" as="geometry">
    <Array as="points">
      <mxPoint x="750" y="80"/>
      <mxPoint x="750" y="150"/>
    </Array>
  </mxGeometry>
</mxCell>
```

4. **布局先行**: 节点按列/行分区排,留 ≥30px 连线通道;边自然同向(全 TB 或全 LR),交叉自然就少
5. 写完心里过一遍: 有边穿过非端点节点吗?有两条边共路径吗?有角点连接吗?有就改

## 容器与分组

嵌套结构用真正的父子容器,**不要只把小形状摆在大形状上面**(那是"视觉分组",仅 biz-arch 虚线框场景允许)。

### 容器要点

- 子 cell 设 `parent="容器id"`,坐标**相对容器左上角**
- 容器 style 加 `pointerEvents=0;`(除非容器自身要连线 — 那种场景用 swimlane)
- **跨容器的边 `parent="1"`**,否则被容器裁剪
- 边连进容器内的子节点会穿过容器边界,这是正确行为,不用绕

| 类型 | style | 适用 |
|------|-------|-------------|
| 不可见分组 | `group;` | 无边框、纯组合移动 |
| 带标题容器 | `swimlane;startSize=28;` | 有标题条(层/泳道/池) |
| 任意形状容器 | 任意 style + `container=1;pointerEvents=0;` | 视觉自定义容器 |

### 泳道(多角色流程)

横带泳道,固定值直接用,不要重新推导:

- 泳道: `swimlane;horizontal=0;startSize=110;html=1;` + `x=0, y=index×150, width=画布宽, height=150`
- 节点: `parent=泳道id`,`x = 120 + col×180`,`y=45`,尺寸 140×60(菱形 140×80)
- 跨泳道边 `parent="1"`
- 泳道底色轮换: `#f5f5f5 #e8f4f8 #fff0e6 #e8f5e9 #fff9e6 #fce4ec`

### 嵌套架构容器(VPC→AZ→实例 这类)

每级都是 `swimlane;startSize=24/28`,子级相对坐标,从 `(16, 36)` 起排:

```xml
<mxCell id="vpc" value="VPC" style="swimlane;startSize=24;fillColor=#dae8fc;strokeColor=#6c8ebf;html=1;" vertex="1" parent="1">
  <mxGeometry x="40" y="40" width="720" height="360" as="geometry"/>
</mxCell>
<mxCell id="az1" value="AZ-a" style="swimlane;startSize=24;fillColor=#fff2cc;strokeColor=#d6b656;html=1;" vertex="1" parent="vpc">
  <mxGeometry x="20" y="36" width="320" height="300" as="geometry"/>
</mxCell>
<mxCell id="web1" value="web-1" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="az1">
  <mxGeometry x="30" y="40" width="120" height="60" as="geometry"/>
</mxCell>
```

### 交叉职能表格(角色 × 阶段 双轴)

双轴矩阵用 table 形状(自动栅格):外层 `shape=table;childLayout=tableLayout;startSize=0;collapsible=0;fillColor=none;`,行 `shape=tableRow;horizontal=0;startSize=0;collapsible=0;`,格子是行的子 vertex,流程节点放进格子(`parent=格子id`)。首行放阶段表头,每行首格放角色名。跨格边 `parent="1"`。行高/格宽写个大概即可,tableLayout 会归一化。单轴分组用泳道就够,别上表格。

## 图层(layers)

图层控制可见性与 z 序,`parent="0"` 的无 vertex/edge 属性 cell 即图层;后声明的层画在上面。给"标注/批注"单独开层方便读者开关:

```xml
<mxCell id="layer2" value="批注" parent="0"/>
<mxCell id="note1" value="注: 已废弃" style="text;html=1;" vertex="1" parent="layer2">
  <mxGeometry x="100" y="170" width="120" height="30" as="geometry"/>
</mxCell>
```

默认单层(`parent="1"`)就够;图特别复杂才分层。

## 标签过滤(tags)与元数据

- tags 需要 `<object>` 包装: `<object id="2" label="Auth 服务" tags="critical v2"><mxCell .../></object>`;一个元素可多 tag,viewer 里 Edit > Tags 过滤
- 元数据 + 占位符: `<object>` 上加自定义属性 + `placeholders="1"`,label 里 `%key%` 取值
- 普通图不用这两样;用户要"可过滤/带属性面板"的图才用

## 深浅色适配

`mxGraphModel` 带 `adaptiveColors="auto"` 即可:显式颜色在暗色主题下自动反转。一般不用管;个别颜色反转难看时才用 `fontColor=light-dark(#7EA6E0,#FF0000)` 双值。

## XML 良构(CRITICAL)

- **绝不输出 XML 注释 `<!-- -->`**(上面文件结构示例里那行注释只是说明,真实产物不能有)
- 属性值转义: `&amp;` `&lt;` `&gt;` `&quot;`
- 每个 mxCell id 唯一;边的 source/target 必须引用存在的 id
- 标签语言跟随用户语言(中文需求出中文图)

## 深层样式查询

极少数要用行业图标库(AWS/Azure/GCP/Cisco/K8s)或冷门形状时,查官方完整样式参考:
<https://github.com/jgraph/drawio-mcp/blob/main/shared/style-reference.md>(927 行,含全部 shape/样式/调色板)。常规图用本文件 + `common-rules.md` + 选定的 `layouts/<layout>.md` + `palettes/<palette>.md` + `visual-hierarchy.md` 已足够,不要为标准矩形/菱形去翻它。
