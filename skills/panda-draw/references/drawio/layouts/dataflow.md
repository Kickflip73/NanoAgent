# Layout · dataflow(数据流 / 链路图)

横向阶段推进为主轴,数据节点用 cylinder/document 语义形状。

## 适用 / 触发关键词

数据链路、调用链路、漏斗 / 管道、阶段推进全景。

**自动触发**:数据链路 / 管道 / 漏斗 / 调用链 / 阶段推进 / ETL / pipeline / 流水线

## 视觉特征

横向阶段推进为主轴(flexArrow 大箭头或 step 形状串联),每阶段下方挂细节卡片组,数据节点用 cylinder/document 语义形状。

## 推荐 palette

- 默认:`classic-soft`(蓝色阶段轴 + 灰色明细 + 黄色存储 + 绿色产出)
- 工程蓝图:`technical-blueprint`(适合 ETL、严肃数据链路文档)
- 多源/多并行链路:`subway-transit`(6 线色区分不同数据来源/通路)

## 形状 Token 表

颜色全由 palette 套入。

```text
阶段大箭头: shape=flexArrow;endArrow=classic;html=1;rounded=0;width=10;endSize=4;endWidth=18;fillColor=<palette 蓝 fill>;strokeColor=<palette 蓝 stroke>;fontColor=<palette 正文字>;fontSize=14;fontStyle=1;
            (边形状: edge="1" + sourcePoint/targetPoint,见 biz-arch.md 末尾示例;标签直接写 value)
阶段块(替代箭头时): shape=step;perimeter=stepPerimeter;whiteSpace=wrap;html=1;fixedSize=1;size=20;fillColor=<palette 蓝 fill>;strokeColor=<palette 蓝 stroke>;fontColor=<palette 正文字>;fontSize=14;fontStyle=1;
明细卡片:   rounded=1;whiteSpace=wrap;html=1;arcSize=8;fillColor=<palette 中性 fill>;strokeColor=<palette 中性 stroke>;fontColor=<palette 正文字>;fontSize=13;
存储:      shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=12;fillColor=<palette 黄 fill>;strokeColor=<palette 黄 stroke>;fontColor=<palette 正文字>;fontSize=12;
文档/报表:  shape=document;whiteSpace=wrap;html=1;boundedLbl=1;fillColor=<palette 绿 fill>;strokeColor=<palette 绿 stroke>;fontColor=<palette 正文字>;fontSize=12;
外部源:    shape=cloud;whiteSpace=wrap;html=1;fillColor=<palette 紫 fill>;strokeColor=<palette 紫 stroke>;fontColor=<palette 正文字>;fontSize=12;
数据流线:   edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=<palette 主链路>;endArrow=classic;
异步/旁路:  edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=<palette 辅助线>;dashed=1;endArrow=open;
```

## 布局骨架

1. 主轴: 阶段从左到右排,step 块等宽相接(或 flexArrow 串联),y 固定
2. 每阶段正下方一个虚线分组框(token 同 biz-arch 分组框),放该阶段的明细卡片/数据节点
3. 数据形状语义: 外部来源 cloud → 处理卡片 → 存储 cylinder3 → 产出 document
4. 旁路/异步链路用灰虚线 + open 箭头,与主链路区分
5. cloud 形状文字区极小(~55%×50%),标签 ≤4 汉字,宽 ≥120

## 布局变体(挂 dataflow 下)

后续 P2 任务补:funnel / periodic-table / dashboard。
