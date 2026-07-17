# Palette · classic-soft(经典柔和板,默认)

draw.io 经典柔和色系,fill/stroke 成对用。**默认调性**——适用于绝大多数业务/技术场景,中性、好看、稳定。

## 适用场景

- 业务能力梳理、规划全景、职责分工(biz-arch 层)
- 系统架构、模块分层、平台能力(tech-arch 层)
- 日常流程、审批流(flowchart 层)
- 数据/调用链路、阶段推进(dataflow 层)

**通用推荐**:不确定选什么 palette 时用这个。

## 语义配色表

| 语义 | fillColor | strokeColor |
|---|---|---|
| 中性/默认 | `#f5f5f5` | `#666666` |
| 蓝(系统/平台/接入) | `#dae8fc` | `#6c8ebf` |
| 绿(正向/完成/数据) | `#d5e8d4` | `#82b366` |
| 黄(判断/进行中/警告) | `#fff2cc` | `#d6b656` |
| 紫(外部/第三方) | `#e1d5e7` | `#9673a6` |
| 橙(重点/风险/异常) | `#ffe6cc` | `#d79b00` |
| 白(层内模块) | `#ffffff` | 跟随所在层 stroke |

## 字色

- 正文 `fontColor=#333333`
- 分组框副标题 `fontColor=#666666`
- 强调字 `#FF0000` 整图 ≤2 处

## 连线 strokeColor

- 主链路 / 普通连线 `#666666`
- 辅助 / 旁路 / 异步 `#999999`(虚线时配 dashed=1)
- 异常 / 回滚 用橙色 `#d79b00`,虚线

## 占位映射(按 common-rules.md schema 全覆盖)

**字色族**
| 占位字段 | hex |
|---|---|
| `<palette 正文字>` | `#333333` |
| `<palette 模块文字>` | `#333333` |
| `<palette 副标题字>` | `#666666` |
| `<palette 强调字>` | `#FF0000` |

**结构色族**
| 占位字段 | hex |
|---|---|
| `<palette 中性 fill>` | `#f5f5f5` |
| `<palette 中性 stroke>` | `#666666` |
| `<palette 模块底>` | `#FFFFFF` |
| `<palette 主链路>` | `#666666` |
| `<palette 辅助线>` | `#999999` |

**语义色族**(每个语义拆成 exact fill 和 stroke 两行)
| 占位字段 | hex |
|---|---|
| `<palette 蓝 fill>` | `#dae8fc` |
| `<palette 蓝 stroke>` | `#6c8ebf` |
| `<palette 绿 fill>` | `#d5e8d4` |
| `<palette 绿 stroke>` | `#82b366` |
| `<palette 黄 fill>` | `#fff2cc` |
| `<palette 黄 stroke>` | `#d6b656` |
| `<palette 紫 fill>` | `#e1d5e7` |
| `<palette 紫 stroke>` | `#9673a6` |
| `<palette 橙 fill>` | `#ffe6cc` |
| `<palette 橙 stroke>` | `#d79b00` |
| `<palette 红/异常 fill>` | `#ffe6cc`(同橙,classic-soft 不区分) |
| `<palette 红/异常 stroke>` | `#d79b00`(同橙) |
