---
name: web-research
description: 使用内置 web_search 工具检索最新互联网资料并进行多来源信息调研
---

# Web Research

使用 MimiAgent 内置的 `web_search` 工具进行互联网搜索。OpenAI 使用托管搜索，DeepSeek 默认使用本地 Bing 适配器；两者使用相同工具名。

## 使用方式

直接调用 `web_search` 工具：

```
工具名: web_search
参数:
  query: 搜索关键词（尽量精确）
  num: 返回结果数量（1-10，默认5）
```

## 搜索技巧

### 关键词优化
- 中文搜索用中文关键词
- 技术问题用英文关键词（结果更精准）
- 加限定词：`tutorial`、`docs`、`example`、`vs`、`alternative`

### 结果解读

每个结果包含：
- 标题（通常是文章标题或网站名）
- 链接（原始 URL）
- 摘要（页面描述或片段）

### 信息验证
- 优先查看官方文档/官网
- 核实信息后用 `http_request` 打开具体页面获取详细内容
- 关键事实交叉验证

## 局限

- 不同 Provider 的搜索来源和排序可能不同
- 搜索结果不含发布时间
- 如配置了 `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX`，会自动用 Google（质量更好）
