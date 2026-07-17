# Palette · ikea-minimal(北欧极简)

借鉴 baoyu-infographic `ikea-manual` 调性。黑线 + 大白底 + 红警告 + 蓝高亮的极简说明书风。

## 适用场景

- 极简步骤说明(如安装手册、配置 SOP)
- 强调"清晰、不花哨"的技术文档
- 黑白打印友好场景
- 单一主线流程,无复杂分类

**不推荐**:多分类高密度图(色彩太少难区分)、暖调内容场景。

## 视觉特征

**纯黑细线** + **大白底**(无填充或仅极淡填充)+ **红色警告**(整图 ≤2 处)+ **蓝色高亮**(强调操作)。整体克制、像 IKEA 安装说明的工业感。

## 语义配色表

| 语义 | fillColor | strokeColor |
|---|---|---|
| 中性 / 默认 | `#FFFFFF`(纯白) | `#222222`(近黑) |
| 高亮 / 操作 | `#E6F0FF`(极淡蓝) | `#0066FF` |
| 警告 / 注意 | `#FFE6E6`(极淡粉) | `#FF0000`(警示红)|
| 完成 / 正向 | `#F0F0F0` | `#888888`(灰勾)|

无紫橙绿等装饰色 — 极简调性靠克制。

## 字色

- 正文 `fontColor=#222222`(近黑)
- 副标题 `fontColor=#666666`
- 强调操作 `fontColor=#0066FF`(蓝)
- 警示 `fontColor=#FF0000`(红,整图 ≤2 处)

## 连线 strokeColor

- 主链路 `#222222`(黑细线,strokeWidth=1.2)
- 辅助 `#888888`(中灰,虚线)
- 警示 `#FF0000`

## 描边纪律(关键)

- vertex 描边 strokeWidth=1(细 — IKEA 的灵魂是"不喧宾夺主")
- edge strokeWidth=1.2-1.5(略粗于 vertex,清晰但不刺眼)
- 强调边 strokeWidth=2 + 颜色变蓝/红

## 配色 hex 速查

```text
白底:      #FFFFFF  stroke #222222  (1px)
淡蓝高亮:  #E6F0FF  stroke #0066FF
淡红警告:  #FFE6E6  stroke #FF0000
灰完成:    #F0F0F0  stroke #888888
正文字:    #222222
副标题灰:  #666666
高亮蓝字:  #0066FF
警示红字:  #FF0000
```

## 注意

- **强对比 + 极少色** 是核心 — 一张图通常只有 1-2 个非黑节点(蓝高亮 or 红警示)
- 不用渐变、阴影、彩色填充以外的装饰
- 字号 13 默认,标题 16 加粗 — 字重对比是这个调性的主要表达手段

## 占位映射(按 common-rules.md schema 全覆盖)

ikea-minimal 极简,**只有 3 种色**(白 / 蓝高亮 / 红警示)+ 黑灰文字。layout 占位中"蓝绿黄紫橙"5 个语义色降级映射,**不要画出花哨**。

**字色族**
| 占位字段 | hex |
|---|---|
| `<palette 正文字>` | `#222222` |
| `<palette 模块文字>` | `#222222` |
| `<palette 副标题字>` | `#666666` |
| `<palette 强调字>` | `#0066FF` 或 `#FF0000` |

**结构色族**
| 占位字段 | hex |
|---|---|
| `<palette 中性 fill>` | `#FFFFFF` |
| `<palette 中性 stroke>` | `#222222`(strokeWidth 1) |
| `<palette 模块底>` | `#FFFFFF` |
| `<palette 主链路>` | `#222222`(strokeWidth 1.2-1.5) |
| `<palette 辅助线>` | `#888888` |

**语义色族**(降级表 — 极简调性:5 语义压缩到 3 实际色;每个语义拆成 exact fill 和 stroke 两行)
| 占位字段 | hex | 说明 |
|---|---|---|
| `<palette 蓝 fill>` | `#E6F0FF` | 高亮蓝(整图 1-2 处) |
| `<palette 蓝 stroke>` | `#0066FF` | 高亮蓝 |
| `<palette 绿 fill>` | `#F0F0F0` | 降级灰(完成感) |
| `<palette 绿 stroke>` | `#888888` | 降级灰 |
| `<palette 黄 fill>` | `#F0F0F0` | 降级灰 |
| `<palette 黄 stroke>` | `#888888` | 降级灰 |
| `<palette 紫 fill>` | `#F0F0F0` | 降级灰 |
| `<palette 紫 stroke>` | `#888888` | 降级灰 |
| `<palette 橙 fill>` | `#FFE6E6` | 降级警示红 |
| `<palette 橙 stroke>` | `#FF0000` | 警示红 |
| `<palette 红/异常 fill>` | `#FFE6E6` | 警示红 |
| `<palette 红/异常 stroke>` | `#FF0000` | 警示红 |

**关键说明**:此 palette 把"5 种分类色"映射成"主要中性灰 + 1 个高亮 + 1 个警示",所以 dense-modules 这种重分类色的 layout **不推荐**用 ikea-minimal(已在 index.md 推荐组合里避免)。biz-arch / flowchart / tech-arch 上 ikea-minimal 效果最佳。

**关键说明**:此 palette 把"5 种分类色"映射成"主要中性灰 + 1 个高亮 + 1 个警示",所以 dense-modules 这种重分类色的 layout **不推荐**用 ikea-minimal(已在 index.md 推荐组合里避免)。biz-arch / flowchart / tech-arch 上 ikea-minimal 效果最佳。
