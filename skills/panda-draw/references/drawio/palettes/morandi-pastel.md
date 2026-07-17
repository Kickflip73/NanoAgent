# Palette · morandi-pastel(莫兰迪柔和)

借鉴 baoyu-infographic `morandi-journal` 配色(失去手绘笔触,保留莫兰迪色调)。雾蓝 / 暖棕 / 米色 / 灰玫的中明度低饱和。

## 适用场景

- 内容/教程类(温和质感)
- 业务规划全景(文艺调性)
- 个人作品集 / 学习笔记可视化
- 对外软性沟通(产品对客、用户教育)

**不推荐**:工程严谨场景(过软)、强对比场景(色差不够)。

## 视觉特征

中明度、低饱和、调性偏暖。整体像水彩涂层的色块,无生硬色。

## 语义配色表

| 语义 | fillColor | strokeColor |
|---|---|---|
| 中性 / 默认 | `#F5F0E6`(米色) | `#A89F8E` |
| 蓝(系统 / 平台) | `#B8CAD3`(雾蓝) | `#7BA3A8` |
| 绿(正向 / 完成) | `#C3D4BB`(雾绿) | `#7A9970` |
| 黄(进行中 / 警告) | `#E8D9B0`(米黄) | `#B8A06A` |
| 紫(外部 / 第三方) | `#D5C5D2`(灰玫) | `#A88AA0` |
| 橙(重点 / 风险) | `#E8C9B0`(暖橙) | `#C49A6E` |
| 棕(强调主题色) | `#D4956A` | `#A06D45` |

## 字色

- 正文 `fontColor=#4A4A4A`(深暖灰)
- 副标题 `fontColor=#7A6F5E`
- 强调 `fontColor=#A06D45`(主题棕)整图 ≤2 处

## 连线 strokeColor

- 主链路 `#7A6F5E`(深暖灰)
- 辅助 `#A89F8E`(中暖灰,虚线)
- 异常 `#A06D45`(主题棕,虚线)

## 配色 hex 速查

```text
米底:    #F5F0E6  stroke #A89F8E
雾蓝:    #B8CAD3  stroke #7BA3A8
雾绿:    #C3D4BB  stroke #7A9970
米黄:    #E8D9B0  stroke #B8A06A
灰玫:    #D5C5D2  stroke #A88AA0
暖橙:    #E8C9B0  stroke #C49A6E
主题棕:  #D4956A  stroke #A06D45
正文字:  #4A4A4A
```

## 注意

- 字色用 `#4A4A4A` 而非纯黑,和柔和色调匹配
- 不用 `#FF0000` 强调红(过刺眼),用主题棕 `#A06D45` 代替

## 占位映射(按 common-rules.md schema 全覆盖)

**字色族**
| 占位字段 | hex |
|---|---|
| `<palette 正文字>` | `#4A4A4A` |
| `<palette 模块文字>` | `#4A4A4A` |
| `<palette 副标题字>` | `#7A6F5E` |
| `<palette 强调字>` | `#A06D45`(主题棕) |

**结构色族**
| 占位字段 | hex |
|---|---|
| `<palette 中性 fill>` | `#F5F0E6` |
| `<palette 中性 stroke>` | `#A89F8E` |
| `<palette 模块底>` | `#FFFFFF` |
| `<palette 主链路>` | `#7A6F5E` |
| `<palette 辅助线>` | `#A89F8E` |

**语义色族**(每个语义拆成 exact fill 和 stroke 两行)
| 占位字段 | hex |
|---|---|
| `<palette 蓝 fill>` | `#B8CAD3` |
| `<palette 蓝 stroke>` | `#7BA3A8` |
| `<palette 绿 fill>` | `#C3D4BB` |
| `<palette 绿 stroke>` | `#7A9970` |
| `<palette 黄 fill>` | `#E8D9B0` |
| `<palette 黄 stroke>` | `#B8A06A` |
| `<palette 紫 fill>` | `#D5C5D2` |
| `<palette 紫 stroke>` | `#A88AA0` |
| `<palette 橙 fill>` | `#E8C9B0` |
| `<palette 橙 stroke>` | `#C49A6E` |
| `<palette 红/异常 fill>` | `#E8C9B0`(同橙,无独立红) |
| `<palette 红/异常 stroke>` | `#A06D45`(主题棕作异常) |
