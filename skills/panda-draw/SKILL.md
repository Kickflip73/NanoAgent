---
name: panda-draw
description: |
  panda-mem 的个人画图统一入口。凡是独立生图、Morandi 知识卡、信息图、架构图、流程图、关系图、组织图、文章封面/正文配图，以及明确要求 draw.io / drawio / .drawio 可编辑图源的任务，都优先使用本 skill。它替代已删除的 baoyu-visual-router、baoyu-visual-publish 和 drawio 三个画图 skill。位图使用 Codex 内置 image_gen / GPT Image 2，不读取 API key；可编辑 draw.io 使用本 skill 内置的 XML 参考、lint 和 render 脚本。不要把已有文本方案的纯 HTML 渲染任务交给本 skill；那类任务用 html-view。
---

# Panda Draw

`panda-draw` 是本仓库的个人画图统一入口。它替代已经删除的项目内旧视觉入口：

- `baoyu-visual-router`：原先负责独立单图生成。
- `baoyu-visual-publish`：原先负责文章封面和正文配图。
- `drawio`：原先负责可编辑 `.drawio` 矢量图。

默认位图视觉家族是 **`morandi-journal`**。可编辑矢量图使用本 skill 内置的 draw.io XML 工作流，因此生成过程不依赖旧 `drawio` skill 入口。

位图 Morandi 图片必须保留完整信息图规划链路：

```text
source
→ analysis.md
→ structured-content.md
→ layout × morandi-journal variant confirmation
→ prompts/infographic.md
→ infographic.png
→ summary
```

本 skill 不依赖 `/Users/peter/Documents/work/aiws/baoyu-skills`、任何外部 baoyu skill、`baoyu-imagine`、xAI 或需要 API key 的图片后端。

## 适用范围

使用本 skill 处理：

- 独立信息图、知识卡、架构总结、流程说明、组织/关系图，以及“一张图讲清楚 X”类请求。
- 明确提到 `panda-draw`、`morandi`、`morandi-journal`、`莫兰迪`、`手账`、`知识卡` 或 `信息图` 的请求。
- 明确要求可编辑矢量源文件的请求，例如 `draw.io`、`drawio`、`.drawio`、`可编辑源文件`。
- 用户提供 Markdown 文章路径，或要求生成封面、正文配图、文章插图、视觉预览、本地发布素材时的文章级视觉任务。
- 面向内部评审、文章写作、个人知识工作的中文优先视觉解释。

不要用本 skill 处理：

- 对已有方案、对比、文章或说明的 HTML 渲染。
- 真实外部发布动作，例如创建微信公众号草稿、发布到公众号、发布到学城。先生成本地视觉素材；如需发布，必须单独确认并使用对应发布 workflow。
- 明确要求历史 baoyu 后端的请求。此时说明本仓库内旧 baoyu 视觉 skill 已删除，并询问是否改用 `panda-draw`。

如果请求在“独立位图”“可编辑 draw.io”“文章视觉”之间存在歧义，按以下信号选择：明确 draw.io 请求 → `drawio` 模式；Markdown 文章路径 / 封面 / 正文配图 → `article-visuals` 模式；其他画图请求 → `raster-morandi` 模式。只有在输出类型无法判断时，才问一个简短澄清问题。

## 模式选择

| 用户信号 | 模式 | 输出 |
|---|---|---|
| `draw.io`、`drawio`、`.drawio`、`可编辑`、`矢量源文件` | `drawio` | `.drawio` + 渲染 PNG |
| Markdown 文章路径、`给文章配图`、`封面`、`正文配图`、`文章视觉预览` | `article-visuals` | 本地 sidecar 方案、prompt、生成图片、可选预览文件 |
| `画图`、`架构图`、`流程图`、`信息图`、`一图讲清楚`、`知识卡`、`morandi`，且没有文章源 | `raster-morandi` | `infographic.png` |

默认模式是 `raster-morandi`。

## 常见调用方式

用户可以自然调用本 skill：

- `用 panda-draw 画一张图解释下面这段内容`
- `用莫兰迪手账风格做一张信息图`
- `panda-draw 原版手账风`
- `panda-draw 朴素版，适合技术架构`
- `panda-draw style=plain-sketch`
- `把这个架构画成 morandi knowledge card`
- `panda-draw 直接生成，16:9`
- `panda-draw 高密度信息图，4:5`
- `panda-draw 生成一个可编辑 draw.io 架构图`
- `给 03-outputs/articles/xxx.md 生成封面和正文配图`

用户说 `panda-draw` 时，视为选择这个自包含 skill，不要路由到外部 baoyu。

## Morandi 变体选择

始终保留两个内置变体：

| 变体 | 用户说法 | 适合场景 | 风格意图 |
|---|---|---|---|
| `cozy-journal` | `原版`、`手账`、`温暖`、`装饰`、`cozy`、`journal` | 社交卡片、生活方式说明、面向用户的教育概览 | 温暖 Morandi 手账风，包含胶带、小涂鸦、callout 和手绘装饰细节 |
| `plain-sketch` | `朴素`、`简洁`、`技术`、`架构`、`白板`、`plain`、`clean`、`technical` | 架构图、业务系统、内部评审、技术/流程解释 | 克制的 Morandi 技术草图，使用朴素卡片、清晰箭头、轻微纸纹和最少装饰 |

选择策略：

- 用户明确指定变体或描述目标观感时，按用户要求选择。
- 技术、架构、流程、系统、业务、数据、内部评审类图，默认使用 `plain-sketch`。
- 温暖知识卡、社交贴、生活方式指南、消费类对比、装饰性手账感图片，默认使用 `cozy-journal`。
- 请求含糊且用户没有说 `直接生成` 时，询问：`用原版手账风 cozy-journal，还是朴素技术版 plain-sketch？`
- 用户说 `直接生成` 时，根据内容类型选择默认值，并在生成前说明假设。

## 后端规则

位图生成只能使用 **Codex 内置 `image_gen` 工具**。

- 不要调用 `baoyu-imagine`、`baoyu-image-gen`、`baoyu_image_call.py`、xAI、OpenAI Images API、Azure、Google、Seedream、OpenRouter 或任何需要 API key 的图片后端。
- 不要读取、请求、设置或依赖 `OPENAI_API_KEY`、`XAI_API_KEY`、`OPENAI_BASE_URL`、`XAI_BASE_URL`。
- 普通生成不要使用系统 `imagegen` skill 的 CLI fallback，因为那条路径需要 API 凭证。
- 如果当前 runtime 没有内置 `image_gen`，停止并告诉用户本 skill 需要 Codex 内置生图能力；不要静默 fallback。

Codex 内置生图默认把输出保存在 `$CODEX_HOME/generated_images/...`。生成后，把选中的图片复制到 workspace 输出目录，再结束任务。

可编辑 draw.io 模式不要调用图片模型。应生成本地 XML，lint，使用 draw.io Desktop 渲染，并打开 `.drawio` 文件。

## 内置参考文件

本 skill 是自包含的。只使用以下本地文件：

- `references/analysis-framework.md`：写 `analysis.md` 前读取。
- `references/structured-content-template.md`：写 `structured-content.md` 前读取。
- `references/layouts/index.md`：选择 layout 前读取。
- `references/layouts/<layout>.md`：组装 prompt 前读取选中的 layout。
- `references/styles/morandi-journal.md`：组装 prompt 前读取。
- `references/base-prompt.md`：写 `prompts/infographic.md` 前读取。
- `references/drawio/index.md`：选择 draw.io layout × palette 前读取。
- `references/drawio/layouts/<layout>.md` 和 `references/drawio/palettes/<palette>.md`：只读取选中的 draw.io layout 与 palette。
- `references/drawio/common-rules.md`、`references/drawio/visual-hierarchy.md`、`references/drawio/xml-reference.md`、`references/drawio/diagram-plan-template.md`：生成 draw.io XML 时读取。

执行本 skill 时，不要读取 `/Users/peter/Documents/work/aiws/baoyu-skills`，也不要调用任何 baoyu 脚本。

## 输出结构

默认位图 workspace：

```text
tmp/panda-draw/<YYYYMMDD-HHMMSS>-<slug>/
├── source.md
├── analysis.md
├── structured-content.md
├── prompts/
│   └── infographic.md
├── infographic.png
└── summary.md
```

默认 draw.io workspace：

```text
tmp/panda-draw/drawio/<YYYYMMDD-HHMM>-<slug>.plan.md
tmp/panda-draw/drawio/<YYYYMMDD-HHMM>-<slug>.drawio
tmp/panda-draw/drawio/<YYYYMMDD-HHMM>-<slug>.png
```

默认文章视觉 workspace：

```text
<article.md>.diagrams/
├── analysis/
├── structured/
├── prompts/
├── images/
├── cover/
└── panda-draw-visuals.json
```

如果输入是粘贴的文章/文本，而不是文件路径，使用：

```text
tmp/panda-draw/article/<YYYYMMDD-HHMMSS>-<slug>/
```

规则：

- 用户指定输出目录时，使用用户指定目录。
- 否则使用 `tmp/panda-draw/`。
- 不要写入 `01-raw/`、`02-wiki/`、仓库根目录或文章 assets 目录，除非用户明确要求。
- 不要覆盖已有文件。如果 `analysis.md`、`structured-content.md`、`prompts/infographic.md` 或 `infographic.png` 已存在，先把旧文件重命名为 `-backup-YYYYMMDD-HHMMSS`。

## 工作流

先选择三种模式之一，然后按对应章节执行。

## 模式 A：Raster Morandi Image

### 1. 准备 Source

创建 workspace，并把用户提供的视觉源材料保存为 `source.md`。

输入处理：

- 粘贴文本：去除其中可能出现的 secret 或凭证后直接保存。
- 本地文件路径：只读取相关文件内容，并把视觉源摘录保存到 `source.md`。
- 长文章或报告：除非用户要求全篇视觉化，否则只提取当前独立信息图需要的章节。
- 现有图片参考：只有当图片需要作为参考时，才复制或记录文件路径到 workspace。

不要把源材料写入 `01-raw/`、`02-wiki/` 或文章 assets 目录。

### 2. 分析内容 -> `analysis.md`

结构化信息图之前，先写 `analysis.md`。这是主要质量闸口：先理解内容，再画图。

写此文件前读取 `references/analysis-framework.md`，然后使用下面的项目结构。

使用这个结构：

```markdown
---
title: "<主标题>"
topic: "<educational/technical/business/creative/etc.>"
data_type: "<timeline/hierarchy/comparison/process/system/overview/etc.>"
complexity: "<simple/moderate/complex>"
point_count: <number>
source_language: "<检测到的语言>"
user_language: "<用户语言>"
style: "morandi-journal"
variant: "cozy-journal | plain-sketch"
---

## Main Topic
<用 1-2 句话概括内容主题>

## Learning Objectives
看完这张信息图后，观众应理解：
1. <主要目标>
2. <次要目标>
3. <可选第三目标>

## Target Audience
- Knowledge Level: <Beginner/Intermediate/Expert>
- Context: <他们为什么看这张图>
- Expectations: <他们需要从图中获得什么>

## Content Type Analysis
- Data Structure: <信息之间如何关联>
- Key Relationships: <什么连接到什么>
- Visual Opportunities: <哪些内容适合视觉化>

## Key Data Points (Verbatim)
- "<精确统计、日期、名称、引用或技术术语>"

## Layout Signals
- Content type: <type> -> suggests <layout>
- Complexity: <level> -> suggests <density>
- Audience: <audience> -> suggests <readability constraints>

## Morandi Style Signals
- 为什么 morandi-journal 适合这个请求
- 应使用哪个 morandi 变体：`cozy-journal` 或 `plain-sketch`
- 这个内容需要避免哪些元素

## Recommended Layouts
1. <layout> (Recommended): <简短理由>
2. <layout>: <简短理由>
3. <layout>: <简短理由>
```

规则：

- 精确保留源事实；不要四舍五入数字、重命名实体或添加隐含信息。
- 去除 secret、API key、token、password、私人联系方式和直接支付标识。
- 除非用户要求更装饰的社交卡片感，技术/业务内容优先使用 `plain-sketch`。

### 3. 生成结构化内容 -> `structured-content.md`

把 `analysis.md` 和 `source.md` 转成设计师可用内容。这还不是最终图片 prompt。

写此文件前读取 `references/structured-content-template.md`，然后使用下面的项目结构。

使用这个结构：

```markdown
# <Infographic Title>

## Overview
<用 1-2 句话描述这张信息图>

## Learning Objectives
观众将理解：
1. <目标>
2. <目标>

---

## Section 1: <Section Title>

**Key Concept**: <一句话概括>

**Content**:
- <从源材料复制或严谨提炼的要点>
- <从源材料复制或严谨提炼的要点>

**Visual Element**:
- Type: <icon/chart/diagram/card/callout/flow>
- Subject: <表现什么>
- Treatment: <morandi-journal 应如何渲染>

**Text Labels**:
- Headline: "<短可见标题>"
- Labels: "<短标签 1>", "<短标签 2>"

---

<重复 sections>

---

## Data Points (Verbatim)
- "<精确统计/名称/日期/引用/术语>"

## Design Instructions
- Style: morandi-journal
- Variant: cozy-journal | plain-sketch
- Aspect: <16:9 / 3:4 / 4:5 / 1:1>
- Density: <medium / medium-high / high>
- Visible text policy: short labels only
```

规则：

- 不添加新事实。
- 可见标签必须足够短，保证在位图中清晰可读。
- 如果源内容复杂，减少图中文字，把细节转为布局、图标、箭头、分组和 callout 表达。

### 4. 选择 Layout × `morandi-journal`

视觉风格始终是 `morandi-journal`；变化的是信息布局。

选择 layout 前读取 `references/layouts/index.md`。选定后，读取对应的 `references/layouts/<layout>.md`。

使用这些默认值：

| 内容形态 | Layout pattern |
|---|---|
| 多模块、系统或主题概览 | `bento-grid` |
| 高密度指南、清单、多要点 | `dense-modules` |
| 中心概念及其相关部分 | `hub-spoke` |
| 流程、工作流、时间线 | `linear-progression` |
| A vs B、前后对比、取舍 | `comparison-matrix` |
| 层级、分层、架构层 | `hierarchical-layers` |
| 数据访问、管道、组件剖面 | `structural-breakdown` |

优先保证可读性，而不是追求巧妙布局。如果源内容文字太多，减少可见标签，把细节留在对话回复里，不塞进图片。

默认变体：

- 技术架构、Agent 系统、业务流程、数据治理、安全、工作流、内部评审图，默认 `plain-sketch`。
- 温暖知识卡、消费者教育、生活方式指南、社交卡片视觉、装饰性解释图，默认 `cozy-journal`。

默认比例：

- 内部评审、架构解释、桌面阅读：`16:9`。
- 知识卡、社交贴：`3:4` 或 `4:5`。
- 紧凑概念卡：仅在需要时使用 `1:1`。

确认策略：

- 默认询问用户确认 layout、aspect、density，以及使用 `plain-sketch` 还是 `cozy-journal`。
- 如果用户说 `直接生成`、`不用确认`、`按默认出图`、`--yes` 或同义表达，可以跳过确认，但生成前要说明假设。
- 永远不要跳过 `source.md`、`analysis.md`、`structured-content.md` 或 `prompts/infographic.md`。

### 5. 生成 Prompt -> `prompts/infographic.md`

调用 `image_gen` 前，先把完整最终 prompt 写入 `prompts/infographic.md`。

读取 `references/base-prompt.md`、`references/styles/morandi-journal.md` 和选中的 layout 文件。最终 prompt 必须把这三者与 `structured-content.md` 合并；已有内置参考时不要凭记忆即兴发挥。

使用这个 prompt 结构：

```text
Use case: infographic-diagram
Asset type: standalone panda-mem visual explanation
Style preset: morandi-journal
Variant: <cozy-journal | plain-sketch>
Aspect ratio: <ratio>
Language: zh

Primary request:
<一句话目标>

Information architecture:
- Layout: <layout pattern>
- Sections: <section list from structured-content.md>
- Flow/relationships: <edges, sequence, hierarchy, grouping, or comparison>

Visible text, verbatim short labels only:
- <label 1>
- <label 2>
- <label 3>

Morandi journal style:
- Warm cream/beige paper background with subtle paper texture (#F5F0E6).
- Muted teal/sage green (#7BA3A8) for headers, borders, and frames.
- Warm terracotta/orange (#D4956A) for highlights, step numbers, and key values.
- Dark charcoal brown (#4A4540) hand-drawn line art.
- Pale yellow (#F5E6C8) soft highlight strips.
- Icons must be hand-drawn symbols, not system emoji glyphs.

Variant-specific style:
<只粘贴 references/styles/morandi-journal.md 中选中变体的 block>

Readability constraints:
- Keep all Chinese labels short, large, and readable.
- Do not generate long paragraphs inside the image.
- Do not invent facts, numbers, names, or claims beyond the source.
- Do not include API keys, tokens, personal contact data, or secrets.
- Avoid flat vector/corporate style, pure white background, photorealism, strict geometric precision, and cluttered tiny text.
- For `plain-sketch`, also avoid decorative-only elements such as stars, sparkles, clouds, stickers, tape corners, cute mascot faces, large banners, or oversized props.

Source-derived structured content:
<粘贴精简后的 structured-content.md 内容>
```

如果提供了参考图片，在 prompt 文件里记录它们，并说明参考用途是构图、调色还是风格。内置 `image_gen` 可以使用对话中可见的图片作为参考；本地图片文件应先检查，使其进入上下文。

### 6. 使用内置 `image_gen` 生成

使用最终 prompt 内容调用 Codex 内置 `image_gen`。

生成后：

1. 检查图片是否匹配风格、文字是否清晰、是否有明显幻觉、关键 section 是否都被表达。
2. 从 `$CODEX_HOME/generated_images/...` 复制选中的输出到 `infographic.png`。
3. 尽可能 inline 展示图片，并报告 workspace 路径。

如果图片文字乱码或过小：

- 不要用 Pillow、ImageMagick、SVG、HTML/CSS overlay 或手工文字替换来修补位图。
- 写修订 prompt 到 `prompts/infographic-v2.md`，减少可见标签，然后生成 `infographic-v2.png`。
- 除非用户要求删除，否则保留之前候选图用于对比。

### 7. 写 Summary -> `summary.md`

生成后写 `summary.md`：

```markdown
# Panda Draw Summary

- Topic:
- Layout:
- Style: morandi-journal
- Variant:
- Aspect:
- Language:
- Backend: Codex built-in image_gen
- Source:
- Analysis:
- Structured content:
- Prompt:
- Image:
- Iterations:
- Known caveats:
```

然后向用户报告同样的简短摘要。

## 质量检查清单

结束前检查：

- prompt 文件已在生成前存在。
- 最终图片已复制到 workspace。
- `analysis.md` 和 `structured-content.md` 存在且内容有意义。
- 风格清楚体现 Morandi journal：温暖纸张、低饱和青绿、陶土色强调、手绘涂鸦质感。
- 中文文字短且可读。
- 图片解释了用户要求的结构，而不只是装饰。
- 没有使用外部后端、API key 或 baoyu 脚本。

## 回复格式

完成后简短报告：

- 输出图片路径。
- Analysis 路径。
- Structured content 路径。
- Prompt 路径。
- Layout pattern 和 aspect ratio。
- 是否发生迭代。

不要声称图片由 API 或外部 baoyu 后端生成。应说明使用的是 Codex 内置生图能力。

## 模式 B：Editable draw.io

用户明确要求 draw.io / drawio / `.drawio` / 可编辑矢量输出时，使用此模式。

### B1. 选择 Layout × Palette

读取 `references/drawio/index.md`，然后从 selector 中选择一个 layout 和一个 palette。只读取：

- `references/drawio/layouts/<layout>.md`
- `references/drawio/palettes/<palette>.md`
- `references/drawio/common-rules.md`
- `references/drawio/visual-hierarchy.md`
- `references/drawio/xml-reference.md`
- `references/drawio/diagram-plan-template.md`

技术层级/模块图用 `tech-arch`；过程逻辑用 `flowchart`；管道/调用链用 `dataflow`；业务能力地图用 `biz-arch`；只有在明确是 Agent / AI coding / 人机协作工作流看板时，才用 `agent-workflow-board`。

### B2. 写 Plan

把 draw.io 方案写到：

```text
tmp/panda-draw/drawio/<YYYYMMDD-HHMM>-<slug>.plan.md
```

遵循 `references/drawio/diagram-plan-template.md`。写 XML 前，保持节点标签简短，并包含 bbox 坐标。

### B3. 生成 XML

把明文 mxfile XML 写到：

```text
tmp/panda-draw/drawio/<YYYYMMDD-HHMM>-<slug>.drawio
```

规则：

- 不使用压缩/base64 draw.io 内容。
- 不写 XML comments。
- 每条边都有 `<mxGeometry relative="1" as="geometry"/>`。
- 真正的容器内使用 parent-relative 坐标。
- 对齐且无遮挡的连接优先使用直线边。

### B4. Lint 和 Render

运行：

```bash
python3 skills/panda-draw/scripts/drawio/drawio_lint.py tmp/panda-draw/drawio/<file>.drawio
bash skills/panda-draw/scripts/drawio/render.sh tmp/panda-draw/drawio/<file>.drawio
```

把所有 ERROR 修到 0。WARN 也视为需要处理，除非它明确是有意设计。

结束前用当前 runtime 的图片查看工具检查渲染 PNG。如果 PNG 语义混乱、标签重叠、文字不可读或边线缠绕，更新 XML 并重新 lint/render。

### B5. 打开并报告

运行：

```bash
bash skills/panda-draw/scripts/drawio/render.sh tmp/panda-draw/drawio/<file>.drawio --no-export --open
```

报告 `.drawio`、`.png`、`.plan.md` 路径，以及使用的 layout × palette 和 lint 结果。

## 模式 C：Article Visuals

用户提供 Markdown 文章路径，或要求为文章生成封面/正文配图时，使用此模式。

此模式替代旧文章视觉工作流中的画图部分，但不会创建真实微信公众号草稿或执行外部发布。

### C1. 准备 Sidecar

如果用户提供 Markdown 文件路径，创建：

```text
<article.md>.diagrams/
```

如果用户粘贴文本，创建：

```text
tmp/panda-draw/article/<YYYYMMDD-HHMMSS>-<slug>/
```

然后把 source、analysis、structured extraction、visual plan 和 prompts 保存到这个 workspace。不要修改源文章。

### C2. 构建视觉计划

创建简短的 `visual-plan.md` 或 `panda-draw-visuals.json`，列出：

- 是否需要 cover image。
- 是否需要每张 body visual。
- anchor heading 或源句子。
- kind：`cover`、`infographic`、`diagram` 或 `illustration`。
- aspect ratio。
- Morandi variant。
- 可见短标签。

完整文章的第一轮默认只生成一张代表性样图，除非用户明确要求批量生成。

### C3. 生成图片

每张图片都遵循模式 A 的 `analysis -> structured-content -> prompt -> image_gen` 纪律。复用 `morandi-journal` 变体：

- 技术架构、工作流、业务系统、数据/安全主题使用 `plain-sketch`。
- 温暖文章解释图或社交卡片视觉使用 `cozy-journal`。

把生成图片写在文章 sidecar 下。除非用户明确批准 finalization，不要直接写入持久化的 `03-outputs/articles/assets/`。

### C4. 预览和外部发布边界

如果用户要求本地预览，在 sidecar 内创建本地预览文件。如果用户要求创建真实微信公众号草稿或外部发布，先停在本地视觉素材，并要求明确确认发布动作和对应发布机制。不要为了画图而恢复 `baoyu-visual-publish`。
