# Provider Contract

MimiAgent 的 OpenAI 与 DeepSeek 支持共享同一能力层。可机器读取的基线位于
`evals/provider-contracts.json`，固定每个 Provider 的：

- 必需 API Key 环境变量；
- 默认模型与 transport；
- context window、输出预留和图片输入能力；
- 跨 Provider Session message ID 的保留/清洗规则。

运行：

```bash
npm run test:provider-contract
```

测试不会调用 Provider 或公网。它同时实例化两类本地 model adapter，核对默认
profile、缺失 Key 的 fail-fast 行为、message ID 可移植性、Tool 名唯一性，以及
HTTP Tool JSON Schema 不包含 Chat Completions 不兼容的 `format: uri` /
`propertyNames`。

Provider 特有差异必须先更新 fixture 和本文件，再修改实现；其余 Runtime、权限、
Session、Tool 和完成语义应保持一致。真实 Provider canary 是单独的 opt-in 评测，
不能用来替代这个确定性 contract。
