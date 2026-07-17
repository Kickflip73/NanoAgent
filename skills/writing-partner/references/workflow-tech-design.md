# 技术方案流程

当商务工作分支的子类型选择为「技术方案」时加载本文件。

**目标**：产出一份足够精确的技术方案文档，精确到 AI 看了就能直接写代码——模块划分、关键数据结构、核心流程伪代码都要到位。

**前置要求**：执行本流程前，应已加载 `content-report.md`（会指引加载 `voice/` 风格源）。

**交互规则**：每一步完成后必须停下来等用户确认，绝对禁止自动进入下一步。

**产出规则**：
- 技术调研素材 → `99-materials/<季度>/<YYYYMMDD-项目名>/`（季度由 LLM 推算,通过 `resolve-path.sh --dir 99-materials/<季度>/<项目>` 获取路径 + Write/Edit 工具写入）
- 技术方案正文 → `03-outputs/reports/`（通过 `resolve-path.sh --dir 03-outputs/reports` 获取路径 + Write/Edit 工具写入）

---

## Step 1: 需求锁定

### 必须明确的信息

- **要解决什么问题**：业务背景 + 技术痛点（为什么要做这个）
- **约束条件**：
  - 技术栈（语言、框架、已有基础设施）
  - 团队规模和技术能力
  - 时间约束
  - 预算约束（如适用）
  - 兼容性要求（需要兼容什么已有系统）
- **非功能需求**：性能、安全、可扩展性、可维护性、可观测性
- **产出粒度确认**：默认为「模块划分 + 关键数据结构 + 核心流程伪代码」，如用户有更细或更粗的需求，在此确认

### AI 主动补充

如果用户给的信息足够明确，不追问，直接进入下一步。如果模糊，AI 主动提出建议并列出需要确认的点：

> 基于你的描述，我理解需求是：[复述]
> 约束条件：[列出已知的]
> 还需要确认：
> 1. [具体问题]
> 2. [具体问题]

---

## Step 2: 技术调研

**本步骤默认执行。** 只有当技术选型已完全确定（用户明确指定了所有技术栈且无需对比）时才可跳过。

### 调研范围

- **选型维度**：框架、库、API/SDK、架构模式、部署方案
- **每个候选方案记录**：
  - 名称、版本、官方文档 URL
  - 优势和劣势
  - 社区活跃度（GitHub stars、最近更新时间、issue 响应速度）
  - 适用场景和不适用场景
  - 已知坑（breaking changes、性能陷阱、兼容性问题）

### last30days 最近 30 天社区信号（按需增强）

如果技术方案涉及 AI 工具/框架、开源项目、快速变化的 SDK/API、社区采用情况、竞品对比或近期踩坑经验，加载 `references/research-last30days.md` 并叠加 `last30days`。

执行要求：
- 先检测 `last30days` 是否已安装；未安装时按 `research-last30days.md` 的规则安装或征求用户确认
- 每个关键候选方案最多提炼 1 个 `last30days` 查询主题，避免把调研变成泛搜
- `last30days` 原始结果可以保留英文，但选型材料、对比表、结论依据和边界说明必须用中文输出
- 按 `research-last30days.md` 的覆盖与降级门禁执行；关键源不可访问时先诊断和排障，不能静默略过
- 结果只用于补充“近期社区使用、真实踩坑、反向证据、采用热度”，不能替代官方文档、GitHub release/issue 或 benchmark
- raw 结果路径和关键来源 URL 必须写入 `99-materials/<季度>/<项目>/技术调研素材.md`
- 完成后停下让用户确认，再进入选型结论和方案设计

### 子 Agent 并行搜索

- **子 Agent 1**：搜索候选技术的官方文档、GitHub 仓库、benchmark 数据
- **子 Agent 2**：搜索实际使用案例、踩坑经验、社区讨论
- **子 Agent 3**（复杂选型才需要）：搜索替代方案、反向证据

子 Agent 工具指引：
- WebSearch 用于发现信息来源和线索
- WebFetch 用于从具体 URL 定向提取内容（官方文档、GitHub README）
- 一手来源优于二手来源：官方文档 > GitHub > 权威技术博客 > 社区讨论

### 选型对比（强制表格）

| 维度 | 方案A | 方案B | 方案C |
|------|-------|-------|-------|
| 功能覆盖 | ... | ... | ... |
| 性能 | ... | ... | ... |
| 学习成本 | ... | ... | ... |
| 社区生态 | ... | ... | ... |
| 已知坑 | ... | ... | ... |
| 与现有系统兼容性 | ... | ... | ... |

### 选型结论

用 Fact→Judgment 结构给出推荐：

```
选型判断：推荐 {方案X}

依据：
1. 事实：{具体事实}
2. 对标：{谁在用、效果如何}
3. 数据：{benchmark、成本、周期}

边界：{在什么条件下这个选型不成立}
```

### 素材保存

```bash
# 获取素材文件路径(以 2026/05 在做"商分知识库"项目为例)
bash skills/writing-partner/scripts/resolve-path.sh --dir 99-materials/2026Q2/20260505-商分知识库 "技术调研素材.md"
# 输出绝对路径后，用 Write 工具写入
```

素材文件结构：
```markdown
# {主题} 技术调研素材

## 调研范围
[从 Step 1 复制约束条件和选型维度]

## 候选方案

### 方案 1: {名称}
- 官方文档：{URL}
- 版本：{version}
- 优势：...
- 劣势：...
- 已知坑：...

### 方案 2: ...

## 选型对比表
[表格]

## 选型结论
[Fact→Judgment 结构]
```

---

## Step 3: 方案设计

**本步骤是技术方案的核心。** 产出必须精确到 AI 能直接翻译成代码。

### 3.1 整体架构

- 模块划分：列出所有模块，每个模块一句话说明职责
- 模块间依赖关系：哪个模块依赖哪个，数据怎么流转
- 可选：用 mermaid 画模块关系图

```
模块 A（职责：...）
  ├── 依赖 → 模块 B
  └── 依赖 → 模块 C
模块 B（职责：...）
模块 C（职责：...）
```

### 3.2 关键数据结构定义

用项目实际技术栈的语言定义（TypeScript/Python/Go/等），不用伪代码：

```typescript
// 示例：如果项目是 TypeScript
interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  status: OrderStatus;
  createdAt: Date;
  updatedAt: Date;
}

type OrderStatus = 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled';

interface OrderItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}
```

要求：
- 字段名、类型、约束都要写清楚
- 枚举值要列全
- 关联关系要标明
- 可选字段标 `?`，必填字段不标

### 3.3 核心流程伪代码

关键路径的完整流程，精度要求：AI 能直接翻译成可运行代码。

```
function createOrder(userId, items):
    // 1. 参数校验
    validate(userId is not empty)
    validate(items is not empty, each item has productId and quantity > 0)

    // 2. 库存检查
    for each item in items:
        stock = inventoryService.getStock(item.productId)
        if stock < item.quantity:
            throw InsufficientStockError(item.productId, stock, item.quantity)

    // 3. 价格计算
    for each item in items:
        item.unitPrice = pricingService.getPrice(item.productId)
    totalAmount = sum(item.unitPrice * item.quantity for item in items)

    // 4. 创建订单
    order = Order(userId, items, status='pending', totalAmount)
    orderRepository.save(order)

    // 5. 扣减库存
    for each item in items:
        inventoryService.deductStock(item.productId, item.quantity)

    return order
```

要求：
- 覆盖主路径（happy path）
- 覆盖关键异常路径（参数错误、依赖服务失败、并发冲突等）
- 标明调用了哪个模块/服务的哪个方法
- 不要省略步骤，不要用"等等"、"类似处理"

### 3.4 接口契约

模块间接口和外部 API 调用契约：

```
// 模块间接口
OrderService.createOrder(userId: string, items: CreateOrderItem[]): Order
  - 成功：返回 Order 对象
  - 失败：InsufficientStockError | InvalidParameterError

// 外部 API 调用
POST /api/v1/orders
  Request: { userId: string, items: [{ productId: string, quantity: number }] }
  Response 200: { orderId: string, status: string, totalAmount: number }
  Response 400: { error: string, details: [...] }
  Response 409: { error: "insufficient_stock", productId: string }
```

### 3.5 错误处理策略

关键路径的异常场景和处理方式：

| 异常场景 | 处理方式 | 是否需要回滚 |
|----------|----------|-------------|
| 库存不足 | 返回错误，不创建订单 | 否 |
| 支付超时 | 订单标记为待支付，定时任务关闭 | 否 |
| 扣库存失败 | 重试 3 次，失败则取消订单 | 是 |

---

## Step 4: 方案自检

### AI 自检 checklist

逐条检查，发现问题立即修补：

- [ ] **可编码性**：拿到这份文档，AI 能否直接开始写代码？有没有模糊地带？
- [ ] **数据结构完整性**：字段、类型、约束、枚举值都定义了吗？
- [ ] **流程完整性**：核心流程覆盖了主路径和关键异常路径吗？
- [ ] **接口明确性**：模块间接口的入参、出参、错误码都写了吗？
- [ ] **选型有据**：技术选型是否来自调研发现，避免只写"我觉得"？
- [ ] **非功能需求**：性能、安全、可扩展性在方案中有体现吗？
- [ ] **约束对齐**：方案是否满足 Step 1 中的所有约束条件？

### 处理方式

- 发现模糊地带 → 回到 Step 3 对应小节补充
- 发现需要用户决策的点 → 标注 `待决策：` 并列出选项和推荐
- 所有 checklist 通过 → 进入 Step 5

---

## Step 5: 技术方案成稿

### 文档结构

```markdown
# 技术方案：{项目名称}

## 一、概述

[一段话说清楚：要做什么、为什么这样做、核心技术选型是什么]

## 二、需求与约束

### 业务背景
[为什么要做]

### 技术约束
[技术栈、兼容性、时间、团队]

### 非功能需求
[性能、安全、可扩展性]

## 三、技术选型

[含调研结论，Fact→Judgment 结构。多方案用表格对比。]

## 四、整体架构

### 模块划分
[每个模块的职责]

### 模块依赖关系
[依赖图或文字描述]

## 五、数据结构定义

[用项目技术栈语言定义，字段/类型/约束完整]

## 六、核心流程

[伪代码级，覆盖主路径和关键异常路径]

## 七、接口契约

[模块间接口 + 外部 API]

## 八、风险与待决事项

[已识别的风险、待决策点、待确认事项]
```

### 写作风格

- 加载 `content-report.md` + `voice/` 系列的所有风格规则
- 结论先行：每章先给结论，再展开
- 数字驱动：性能指标、成本估算用具体数字
- 表格对比：选型对比、错误处理策略用表格
- 克制措辞：技术文档不需要修辞，精确即可

### 逐节写入（强制）

每个章节独立完成、独立确认、独立写入。禁止累积多章再统一写入。

流程：
1. 内部完成一个章节的候选稿，并先做去 AI 味返工、`style_gate.py` 或等效片段扫描、自检和必要 peer review
2. 只把通过质量门禁后的章节候选稿展示给用户确认
3. 等待用户确认（"确认/OK/继续"或修改意见）
4. 用户确认后，**立即写入文件**（通过 `resolve-path.sh` 获取路径 + Write/Edit 工具）
5. 写入后再跑一次 `style_gate.py` 做落盘回归检查；如失败，先修复并重新给用户确认，不继续下一章
6. 写入和回归检查都通过后，再开始下一个章节

违规判定：如果一次输出中包含超过一个章节的完整内容，即为违规。

```bash
# 获取方案文件路径
bash skills/writing-partner/scripts/resolve-path.sh "YYYYMMDD-{项目名}-技术方案.md"
# 输出绝对路径后，用 Write 工具首次创建，用 Edit 工具追加
```

### 质检收尾

1. 再跑一遍 Step 4 的自检 checklist
2. 检查标题是否匹配方案核心内容
3. 检查所有 `待决策` / `待确认` 标签，提醒用户处理
4. 最后通读：确保数据结构和流程伪代码之间没有不一致
5. 用 resolve-path.sh + Write 工具写入最终版本

未完成上述收尾动作，不算真正完稿。
