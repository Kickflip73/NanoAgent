# Layout · flowchart(流程图)

标准 flowchart 形状语义,自上而下主干 + 分支。

## 适用 / 触发关键词

业务流程、审批流、处理逻辑、异常分支、决策树。

**自动触发**:流程 / 审批 / 步骤 / 分支 / 异常处理 / 决策 / 状态机

## 视觉特征

标准 flowchart 形状语义(椭圆起止 / 圆角矩形步骤 / 菱形判断),自上而下主干,分支右出,多角色时用横向泳道。默认继承 `common-rules.md` 的直线优先、小折角 note、主链路动画规则。

## 推荐 palette

- 默认:`classic-soft`(标准 flowchart 配色,绿椭圆 + 蓝矩形 + 黄菱形)
- 多线并行 / 网络流程:`subway-transit`(6 条线色区分多角色或多状态)
- 极简说明书:`ikea-minimal`

## 形状 Token 表

颜色全由 palette 套入。

```text
开始/结束: ellipse;whiteSpace=wrap;html=1;fillColor=<palette 绿 fill>;strokeColor=<palette 绿 stroke>;fontColor=<palette 正文字>;fontSize=13;
步骤:     rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=<palette 蓝 fill>;strokeColor=<palette 蓝 stroke>;fontColor=<palette 正文字>;fontSize=13;
判断:     rhombus;whiteSpace=wrap;html=1;fillColor=<palette 黄 fill>;strokeColor=<palette 黄 stroke>;fontColor=<palette 正文字>;fontSize=13;
子流程:   shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;fillColor=<palette 中性 fill>;strokeColor=<palette 中性 stroke>;fontColor=<palette 正文字>;fontSize=13;
文档/表单: shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=8;spacingRight=16;fillColor=<palette 模块底>;strokeColor=<palette 中性 stroke>;fontColor=<palette 正文字>;fontSize=12;
异常/终止: rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=<palette 橙 fill>;strokeColor=<palette 橙 stroke>;fontColor=<palette 正文字>;fontSize=13;
垂直主线: edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=0.5;exitY=1;entryX=0.5;entryY=0;strokeColor=<palette 主链路>;strokeWidth=2;endArrow=classic;
水平分支: edgeStyle=none;rounded=0;html=1;flowAnimation=1;exitX=1;exitY=0.5;entryX=0;entryY=0.5;strokeColor=<palette 主链路>;strokeWidth=2;endArrow=classic;
折线回路: edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;strokeColor=<palette 辅助线>;endArrow=classic;
返工回路: edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;flowAnimation=1;exitX=0.5;exitY=0;entryX=0.5;entryY=0;strokeColor=<palette 橙 stroke>;strokeWidth=1.5;dashed=1;endArrow=classic;
泳道:     swimlane;horizontal=0;startSize=110;html=1;fontSize=14;fontStyle=1;fontColor=<palette 正文字>;(fillColor 在浅底 palette 轮换 #f5f5f5 #e8f4f8 #fff0e6 #e8f5e9;subway-transit 用 6 条线色 fill;technical-blueprint 用同色系不同明度的 layer fill;ikea-minimal 不用泳道,改单角色主流程)
```

## 布局骨架

- **无泳道**:主干自上而下一条列(x 固定),行距 110;判断的"否"分支右出 180,处理后汇回主干;"是/否"标签必填
- **有泳道(≥2 个角色)**:泳道横带堆叠,`高 150、startSize=110`,节点 `parent=泳道id`、`y=45`、x 按列网格 `120 + col×180`;跨泳道连线 `parent="1"`
- 同列上下游用 `垂直主线` 直线边;同一泳道横向步骤/分支用 `水平分支` 直线边;只有回路、汇回、跨泳道错位时才用 `折线回路`
- 返工/回滚指回上游步骤时用 `返工回路`:从返工节点上边出,走主流程右侧或上方外侧通道,最后从目标节点上边/下边进入;入口可偏到 0.3/0.7/0.8 避开主线,不要从目标右侧自动倒插
- 判断节点 ≤6 汉字;描述长就拆成"步骤 + 判断"两个节点
- 结束节点可以多个(正常结束绿、异常结束橙)

**bbox 草排提醒**:有泳道时,泳道内节点的 bbox 仍是绝对画布坐标,生成 XML 时减去所在泳道的左上角 → parent-relative。

## 布局变体(挂 flowchart 下)

后续 P2 任务补:circular-flow / linear-progression / tree-branching。
