# last30days 调研增强

本文件用于 writing-partner 的调研阶段。它不是独立写作流程，只是给 `workflow-create.md`、`workflow-research.md`、`workflow-tech-design.md` 增加一个最近 30 天的社区信号通道。

**核心定位**：`last30days` 回答“最近大家实际在说什么、怎么用、踩什么坑”。它不能替代官方文档、GitHub、内部事实、公司案例或学术论文。

---

## 触发条件

命中以下任一条件时，调研阶段应考虑叠加 `last30days`：

- 用户明确说“用 last30days 调研”或“看最近大家怎么说”
- 主题涉及 AI 演进、行业趋势、社区反馈、开源项目、工具选型、产品/竞品动态
- 需要判断“现在是否已经成为趋势”“真实使用者怎么评价”“最近有什么坑”
- 技术方案或调研报告里需要补充最近 30 天的社区证据、反向证据或实践案例

以下情况默认不启用：

- 纯内部周报、进展同步、复盘、纪要
- 用户已提供完整事实、数据和判断，只需要表达打磨
- 任务只要求改语言、改结构，不需要新增外部证据

---

## 检测与安装

### 1. 先检测是否已安装

按顺序检查以下路径是否存在：

```bash
test -f "$HOME/.codex/skills/last30days/SKILL.md"
test -f "$HOME/.claude/skills/last30days/SKILL.md"
test -f "$HOME/.agents/skills/last30days/SKILL.md"
```

如果任一路径存在，读取对应 `SKILL.md`，按该 skill 的合同执行。不要把 `/last30days` 当成普通搜索词即兴发挥。

### 2. 未安装时的处理

如果没有检测到 `last30days`：

- 用户本轮已经明确授权安装外部 skill：可以安装后继续
- 用户没有明确授权：先停下询问是否安装，不要静默安装

推荐安装命令：

```bash
npx skills add https://github.com/mvanhorn/last30days-skill --skill last30days
```

也可以按用户环境使用全局安装：

```bash
npx skills add mvanhorn/last30days-skill -g
```

安装完成后重新检测 `SKILL.md`，确认可读后再执行调研。

### 3. X / xAI 凭证边界

不要把 `XAI_API_KEY` 当成 x.com 登录态或 X 官方 API 凭证。

- `AUTH_TOKEN` + `CT0`：x.com 浏览器登录 cookie，适合 cookie-backed X 抓取
- X OAuth / `xurl`：X 官方 API 路径
- `XAI_API_KEY`：xAI provider key，不等于 x.com API auth

如果需要 X.com 登录态，应引导用户登录 x.com，并使用 `AUTH_TOKEN` / `CT0` 或 `FROM_BROWSER` 相关配置。

### 4. 不改外部 skill 目录

`last30days` 是外部 skill。writing-partner 只在本文件规定调用、覆盖检查和降级交互；不要在 `~/.agents/skills/last30days/`、`~/.codex/skills/last30days/` 或 `~/.claude/skills/last30days/` 下新增 wrapper、patch 脚本或本仓专用配置。

---

## 执行规则

1. **先锁定调研问题**：从当前 workflow 的 Step 1 中提炼 1-3 个 `last30days` 主题，不要把整篇写作需求原样丢给它。
2. **按 last30days 合同执行**：读取检测到的 `last30days/SKILL.md`，运行其 Python engine；不能用普通 Web 搜索或几条链接摘要替代。
3. **Codex 无 WebSearch 时走降级分支**：如果当前运行环境没有 last30days 要求的 WebSearch 工具，按该 skill 的无 WebSearch 分支加 `--auto-resolve`，不要自行跳过预解析。
4. **优先用用户原话**：保留关键实体、产品名、技术名；必要时补英文关键词。
5. **输出必须中文**：`last30days` 原始结果可以是英文，但写入调研素材和展示给用户的发现、判断、边界必须用中文表达。
6. **保留来源链接**：每条引用写清标题/作者或账号/时间/URL；不要只写“社区认为”。
7. **区分证据类型**：
   - 一手事实：官方文档、GitHub、论文、内部数据
   - 社区信号：Reddit、X、HN、YouTube、TikTok 等最近讨论
   - 推演判断：AI 基于材料形成的判断
   - 反向证据：失败案例、反对意见、落地阻力
8. **不要用社区热度替代事实**：热度只能说明关注度，不能直接证明方案正确。
9. **不要自动进入下一步**：`last30days` 调研完成后，必须停下给用户确认，再进入蓝图或成稿。

---

## 覆盖与降级门禁（禁止静默略过）

### 1. 调研前诊断

每个触发 `last30days` 的调研主题，执行前先按 `last30days/SKILL.md` 的 Runtime Preflight 确认 `SKILL_DIR` 和 `LAST30DAYS_PYTHON`，然后运行：

```bash
"$LAST30DAYS_PYTHON" "$SKILL_DIR/scripts/last30days.py" --diagnose
```

诊断输出只用于判断可用源和缺失原因，不直接写入正文。若诊断显示关键源不可用，先处理问题，再决定是否继续。

### 2. 预期覆盖矩阵

执行前根据写作任务声明本次期待覆盖哪些源：

| 场景 | 默认关键源 |
|---|---|
| AI 工具 / 模型 / Agent / 技术选型 | Reddit、X、GitHub、YouTube、HN |
| 开源项目 / SDK / 框架 | GitHub、Reddit、HN、X |
| 行业趋势 / 竞品动作 / 产品动态 | X、Reddit、YouTube、Web |
| 社区反馈 / 用户口碑 / 真实踩坑 | Reddit、X、YouTube |
| 预测、市场预期或事件赔率 | Polymarket、X、Reddit、Web |

不是所有源都必须有结果，但关键源为 0、认证缺失或网络失败时，必须显式记录原因。

### 3. 失败处理顺序

出现 X、Reddit、GitHub、YouTube 等关键源缺失时，不得删除该源继续，也不得只写“未找到相关信息”。按顺序处理：

1. **确认调用正确**：是否读取了实际安装的 `last30days/SKILL.md`；是否运行 `scripts/last30days.py`；是否用了 `--emit=compact`；Codex 无 WebSearch 时是否加了 `--auto-resolve`。
2. **确认诊断结果**：重跑 `--diagnose`，看是认证缺失、依赖缺失、网络失败、源被排除，还是该主题确实低信号。
3. **按源排障**：
   - X：检查 `AUTH_TOKEN` / `CT0`、`FROM_BROWSER`、`xurl` 或 `XAI_API_KEY` 是否可用；需要登录态时请用户登录或授权，不把 xAI key 当 x.com cookie。
   - Reddit：检查网络/代理、公共 Reddit 是否可达、是否可用 ScrapeCreators 备份；不能访问时先按本机网络排障处理。
   - GitHub：检查 `gh`、仓库/用户名解析和 GitHub 网络访问；开源项目主题不能用博客星标数替代 live GitHub 结果。
   - YouTube：检查 `yt-dlp` 与网络访问；视频/教程类主题不能静默删掉 YouTube。
4. **重跑一次**：修复后对同一主题重跑 `last30days`，保留新的 raw 路径。
5. **仍失败才降级**：输出覆盖缺口报告，等待用户确认是否接受降级进入下一步。

### 4. 覆盖缺口报告格式

```markdown
## last30days 覆盖缺口

| 关键源 | 状态 | 已尝试处理 | 对本文判断的影响 |
|---|---|---|---|
| X | 不可用：缺少登录态 / 网络失败 / 0 结果 | 已运行 --diagnose；已检查 ... | 缺少实时观点扩散和作者/产品方口径 |
| Reddit | ... | ... | 缺少一线用户踩坑和反向证据 |

是否接受这个覆盖缺口，继续进入蓝图？如果不接受，我会继续排障或调整调研范围。
```

用户明确确认接受降级前，不得进入蓝图、正文或选型结论。

---

## 素材写入格式

把 `last30days` 结果合并进当前 workflow 的调研素材文件，建议追加小节：

```markdown
## last30days 最近 30 天社区信号

### 主题：{调研主题}

- 原始结果：{~/Documents/Last30Days/...raw...md 或实际保存路径}
- 覆盖来源：Reddit / X / YouTube / HN / GitHub / Web 等
- 时间窗口：{YYYY-MM-DD} 至 {YYYY-MM-DD}
- 覆盖缺口：{无 / X 不可用，已获用户确认降级 / Reddit 0 结果，原因...}

#### 关键发现

1. {中文发现}
   - 证据：{来源标题/账号/社区, 时间, URL}
   - 可支撑判断：{它支撑当前调研问题中的哪个判断}
   - 边界：{为什么不能直接套用，或证据不足在哪里}

2. ...

#### 反向证据 / 风险

- {中文风险或反对观点}
  - 证据：{来源, 时间, URL}
  - 对当前写作的影响：{应在正文中如何处理}
```

---

## 进入写作前检查

使用 `last30days` 后，进入蓝图或正文前必须确认：

- [ ] 每条社区信号都已用中文重述
- [ ] 原始 raw 文件路径或关键来源 URL 已记录
- [ ] 已声明预期覆盖矩阵，并检查实际来源覆盖
- [ ] X / Reddit / GitHub / YouTube 等关键源未被静默略过；如缺失，已完成诊断、排障和用户降级确认
- [ ] 没有把热度、点赞数直接写成事实结论
- [ ] 已区分事实、社区信号、推演判断、反向证据
- [ ] 用户已确认这些发现可以进入下一步写作
