# Palette · subway-transit(地铁线路色)

借鉴 baoyu-infographic `subway-map` 调性。6 条线色对应 6 种语义分类,白底 + 粗描边 + 鲜明色彩。

## 适用场景

- 多线并行流程(≥3 条并发链路)
- 网络拓扑、调用链多源汇聚
- 多角色泳道(每个角色一条"地铁线")
- 高分类数信息图(dense-modules 分类 ≥5 类)
- 流程图多状态机

**慎用**:仅 1-2 个分类的简单图(过于花哨)。

## 视觉特征

**白底** + **6 种鲜明线色**(地铁系统的红/蓝/绿/黄/橙/紫)+ **粗描边 2-3px**(强化线路质感)+ **圆角站点**。整体明快、清晰、易区分。

## 语义配色表

6 条"线路色"循环使用,**按分类编号分配**而非按语义:

| 线 | fillColor(浅) | strokeColor(深,2-3px)|
|---|---|---|
| 红线 | `#FFE4E1` | `#E63946` |
| 蓝线 | `#DDE9F7` | `#2D6CDF` |
| 绿线 | `#DDF1DC` | `#3CAA5F` |
| 黄线 | `#FFF4D1` | `#E9A23B` |
| 橙线 | `#FFE3D1` | `#F26B3A` |
| 紫线 | `#E8DEF2` | `#8A4FBF` |

中性 / 默认:fill `#FFFFFF` stroke `#666666`

## 字色

- 正文 `fontColor=#222222`(白底深字,高对比)
- 强调 `fontColor=<对应线 stroke>`(整图 ≤2 处)

## 连线 strokeColor

- **统一**与节点同色(节点在哪条"线",节点出去的边也用那条线色)
- 粗线 strokeWidth=2.5
- 跨线主链路 `#666666` 黑灰中性
- 异常 `#E63946` 红虚线

## 站点圆点(可选,模拟地铁站点)

```text
站点圆: ellipse;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=<对应线色>;strokeWidth=2.5;fontColor=#222222;fontSize=12;
中转换乘: shape=mxgraph.basic.cross2;rotation=45;fillColor=#FFFFFF;strokeColor=#222222;strokeWidth=2;
```

## 配色 hex 速查

```text
红线:  #FFE4E1  stroke #E63946  (2.5px)
蓝线:  #DDE9F7  stroke #2D6CDF
绿线:  #DDF1DC  stroke #3CAA5F
黄线:  #FFF4D1  stroke #E9A23B
橙线:  #FFE3D1  stroke #F26B3A
紫线:  #E8DEF2  stroke #8A4FBF
中性:  #FFFFFF  stroke #666666
```

## 注意

- 一张图最多 6 条线(超过分类要么合并、要么换 palette);LLM 自动控制
- strokeWidth 必须 2-3px(细线会失去地铁感)
- 节点形状用圆角矩形 arcSize=8 或圆点 ellipse

## 占位映射(按 common-rules.md schema 全覆盖)

按"分类编号 → 6 条线色"映射:**第 N 个分类**用第 N 条线色,超 6 条线要么合并要么换 palette。

**字色族**
| 占位字段 | hex |
|---|---|
| `<palette 正文字>` | `#222222` |
| `<palette 模块文字>` | `#222222`(白底深字) |
| `<palette 副标题字>` | `#666666` |
| `<palette 强调字>` | 对应线色 stroke 深值 |

**结构色族**
| 占位字段 | hex |
|---|---|
| `<palette 中性 fill>` | `#FFFFFF` |
| `<palette 中性 stroke>` | `#666666` |
| `<palette 模块底>` | `#FFFFFF` |
| `<palette 主链路>` | `#666666`(中性灰;分类内连线用对应线色) |
| `<palette 辅助线>` | `#999999` |

**语义色族**(6 条地铁线色,每个语义拆成 exact fill 和 stroke 两行)
| 占位字段 | hex |
|---|---|
| `<palette 蓝 fill>` | `#DDE9F7` |
| `<palette 蓝 stroke>` | `#2D6CDF` |
| `<palette 绿 fill>` | `#DDF1DC` |
| `<palette 绿 stroke>` | `#3CAA5F` |
| `<palette 黄 fill>` | `#FFF4D1` |
| `<palette 黄 stroke>` | `#E9A23B` |
| `<palette 紫 fill>` | `#E8DEF2` |
| `<palette 紫 stroke>` | `#8A4FBF` |
| `<palette 橙 fill>` | `#FFE3D1` |
| `<palette 橙 stroke>` | `#F26B3A` |
| `<palette 红/异常 fill>` | `#FFE4E1` |
| `<palette 红/异常 stroke>` | `#E63946` |
