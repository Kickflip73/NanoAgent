# Palette · technical-blueprint(工程蓝图)

借鉴 baoyu-infographic `technical-schematic` 调性。深蓝底 + 白线 + 琥珀标注的工程严谨感。

## 适用场景

- 严谨系统架构、对外正式架构方案
- ETL / 数据链路工程文档
- 协议设计、网络拓扑、部署架构

**慎用**:轻量业务图、规划全景、教学场景(过冷,会显得严肃过头)。

## 视觉特征

**深蓝主体** + **白色描边/连线** + **琥珀色标注/强调**。整体冷峻、专业、像工程图纸。

## 语义配色表

**深底 palette 双字色**(关键):大区域填充用深蓝 + 白字;小模块内部走"中明度蓝灰底 + 浅蓝字"或"白底 + 深蓝字"两种之一。**不要**白底白字。

| 语义 | fillColor | strokeColor |
|---|---|---|
| 画布背景(深底) | `#0E2A47` | — |
| 中性 / 默认 / 层底 | `#0E2A47`(深蓝底)| `#3D5B7D` |
| 蓝(接入 / 服务) | `#1E3A5F` | `#5A7FAA` |
| 绿(数据 / 完成) | `#1F4A38` | `#4A8B6D` |
| 黄 / 强调(标注 / 警示) | `#F59E0B` | `#D97706` |
| 紫(外部 / 第三方) | `#3F2A5A` | `#7A5BA8` |
| 橙(回滚 / 异常) | `#7A3F0E` | `#D97706` |
| **模块底**(层容器内的模块卡片底)| `#2B4868`(中明度蓝)| 跟随所在层 stroke |

`<palette 模块底>` 字段 = `#2B4868`(不是 `#FFFFFF`)。这是为了和深底有对比、同时承载白字。

## 字色(双字色)

- **`<palette 正文字>`**:正文 `fontColor=#FFFFFF`(白,用在深色 fill 上,如模块底、层底、深色填充节点)
- **`<palette 模块文字>`**:此 palette 中等同于 `<palette 正文字>`(模块底也是深色,统一白字);其他 palette 中模块底是白色时,模块文字 = palette 正文字 = 深字
- **`<palette 副标题字>`**:`fontColor=#A8B5C8`(淡灰白)
- **`<palette 强调字>`**:`fontColor=#F59E0B`(琥珀)整图 ≤2 处

## 连线 strokeColor

- 主链路 `#FFFFFF`(白线,深底上突出)
- 辅助 / 旁路 `#5A7FAA`(蓝灰,虚线)
- 异常 / 回滚 `#F59E0B`(琥珀虚线)

## 配色 hex 速查(给 LLM 照抄)

```text
画布背景:  #0E2A47  (mxGraphModel.background)
深底/层底: #0E2A47  stroke #3D5B7D
层蓝:      #1E3A5F  stroke #5A7FAA
数据绿:    #1F4A38  stroke #4A8B6D
琥珀强调:  #F59E0B  stroke #D97706
模块底:    #2B4868  stroke 跟随所在层(关键:不是白色,是中明度蓝;承载白字)
正文白字:  #FFFFFF  (用在所有深色 fill 上)
副标题灰:  #A8B5C8
强调字:    #F59E0B
```

## 占位映射(按 common-rules.md schema 全覆盖)

**字色族**
| 占位字段 | hex |
|---|---|
| `<palette 正文字>` | `#FFFFFF` |
| `<palette 模块文字>` | `#FFFFFF`(模块底 `#2B4868` 上用白字) |
| `<palette 副标题字>` | `#A8B5C8` |
| `<palette 强调字>` | `#F59E0B`(琥珀) |

**结构色族**
| 占位字段 | hex |
|---|---|
| `<palette 中性 fill>` | `#0E2A47`(深底) |
| `<palette 中性 stroke>` | `#3D5B7D` |
| `<palette 模块底>` | `#2B4868`(中明度蓝,**不是白色**) |
| `<palette 主链路>` | `#FFFFFF`(深底上突出) |
| `<palette 辅助线>` | `#5A7FAA`(蓝灰,虚线) |

**语义色族**(每个语义拆成 exact fill 和 stroke 两行)
| 占位字段 | hex |
|---|---|
| `<palette 蓝 fill>` | `#1E3A5F` |
| `<palette 蓝 stroke>` | `#5A7FAA` |
| `<palette 绿 fill>` | `#1F4A38` |
| `<palette 绿 stroke>` | `#4A8B6D` |
| `<palette 黄 fill>` | `#F59E0B` |
| `<palette 黄 stroke>` | `#D97706` |
| `<palette 紫 fill>` | `#3F2A5A` |
| `<palette 紫 stroke>` | `#7A5BA8` |
| `<palette 橙 fill>` | `#7A3F0E` |
| `<palette 橙 stroke>` | `#D97706` |
| `<palette 红/异常 fill>` | `#7A2424` |
| `<palette 红/异常 stroke>` | `#E63946` |

## 注意

- 整图必须加 `<mxGraphModel ... background="#0E2A47">` 暗底,所有 vertex 都在暗底上;不然白色描边会消失,白字也会和默认白底无对比
- 字号比 classic-soft 大半号(13 → 14)避免暗底上小字模糊
- **不允许白底白字**:模块底必须是 `#2B4868`(或其他深色),正文字才能用白
