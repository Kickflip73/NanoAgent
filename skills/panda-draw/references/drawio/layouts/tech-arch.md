# Layout · tech-arch(技术架构图)

横向分层容器自上而下堆叠的经典技术架构表达。

## 适用 / 触发关键词

系统/模块架构、服务分层、部署拓扑、平台能力栈。

**自动触发**:系统架构 / 模块 / 服务 / 微服务 / 部署 / 技术栈 / 平台栈 / 接入层 / 数据层 / 基础设施

## 视觉特征

横向分层容器自上而下堆叠(接入层 → 服务层 → 数据层 → 基础设施),层有淡色底 + 顶部标题条,层内白底模块卡片网格排列,跨层连线垂直为主。默认继承 `common-rules.md` 的直线优先、小折角 note、主链路动画规则。

## 推荐 palette

- 默认:`classic-soft`(每层换语义色: 接入蓝 / 服务绿 / 数据黄 / 基础设施灰 / 外部紫)
- 工程严谨感:`technical-blueprint`(深蓝底 + 白线 + 琥珀标注,适合对外正式架构方案)
- 极简调性:`ikea-minimal`(黑线 + 简色,适合教学/说明书风)

## 形状 Token 表

颜色 token 全部由 palette 套入,visual-hierarchy.md 的 strokeWidth 规则覆盖本表的 strokeWidth。

### 层 → 语义色映射(本 layout 定义,palette 套语义色 hex)

`<palette 层色 ...>` `<palette 同层 ...>` 是 layout 复合字段,先按下表把"层语义"映射到 palette 的语义色族,再查 palette 占位映射拿 hex:

| 层语义 | 映射到 palette 语义色 |
|---|---|
| 接入层 / 边缘 / 网关 | 蓝(palette 蓝 fill/stroke) |
| 服务层 / 业务逻辑 / 微服务 | 绿(palette 绿 fill/stroke) |
| 数据层 / 持久化 / 缓存 | 黄(palette 黄 fill/stroke) |
| 基础设施 / 平台 / 监控 | 中性(palette 中性 fill/stroke) |
| 外部系统 / 第三方 / 上游下游 | 紫(palette 紫 fill/stroke) |

- `<palette 层色 fill>` = 该层映射到的语义色 fill
- `<palette 层色 stroke>` = 该层映射到的语义色 stroke
- `<palette 同层 stroke>` = 模块所在层的语义色 stroke(从模块的 parent 层查映射)

### Token 表

```text
层容器:   swimlane;startSize=28;rounded=0;whiteSpace=wrap;html=1;fontSize=14;fontStyle=1;fontColor=<palette 正文字>;fillColor=<palette 层色 fill>;strokeColor=<palette 层色 stroke>;swimlaneFillColor=<palette 模块底>;
层内模块: rounded=1;whiteSpace=wrap;html=1;arcSize=6;fillColor=<palette 模块底>;strokeColor=<palette 同层 stroke>;fontColor=<palette 模块文字>;fontSize=13;
存储节点: shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;fillColor=<palette 黄 fill>;strokeColor=<palette 黄 stroke>;fontColor=<palette 模块文字>;fontSize=12;
文档/配置: shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=8;spacingRight=16;fillColor=<palette 模块底>;strokeColor=<palette 中性 stroke>;fontColor=<palette 模块文字>;fontSize=12;
外部系统: rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=<palette 紫 fill>;strokeColor=<palette 紫 stroke>;fontColor=<palette 模块文字>;fontSize=13;
垂直主链路: edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=0.5;exitY=1;entryX=0.5;entryY=0;strokeColor=<palette 主链路>;strokeWidth=2;endArrow=classic;
水平主链路: edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;strokeColor=<palette 主链路>;strokeWidth=2;endArrow=classic;
绕障碍连线: edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=<palette 主链路>;endArrow=classic;
普通连线: edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=<palette 辅助线>;endArrow=classic;
```

`<palette 模块底>` 取 palette 占位映射的「结构色族 → 模块底」字段;层内模块底色 vs 层容器底色 形成对比层次(浅底 palette 是白对浅彩;深底 palette 是 `#2B4868` 对 `#0E2A47`)。

## 布局骨架

1. 层容器统一宽(如 900-1200),x 对齐,自上而下按调用方向堆叠,层间距 40
2. 模块是层容器的**真子元素**(`parent=层id`,相对坐标,从 (16, 36) 起排,行高 56)
3. 同层模块等宽等高对齐;模块多时分两行,不要拉长层
4. 跨层连线 `parent="1"`;同列上下游用 `垂直主链路` 直线边,同层左右调用用 `水平主链路` 直线边,只有错位或绕障碍时才用正交线
5. 外部系统放最上方或最右侧,虚线框区别于自有系统

**注意**: swimlane 标题占 startSize=28 高度,子元素 y 从 36 起;层高 = 行数×56 + 36。

**bbox 草排提醒**:plan 里层内模块的 bbox 仍写绝对画布坐标,生成 XML 时减去所在层的左上角 → parent-relative 写入。
