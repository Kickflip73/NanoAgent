# 权限与 Prompt Injection Eval

`evals/security-policy-cases.json` 是 MimiAgent 的离线恶意输入矩阵。它覆盖：

- external/public 正文伪装成 system 或 owner；
- 受限来源试图把 `reply` 升级成 `work`；
- 已授权 work 正文试图修改控制面、跨 Session、写私人 Memory 或启用未知 MCP；
- Safe 部署下正文试图恢复 Shell、文件写、网络写、Connector 和 Computer Use。

运行：

```bash
npm run eval:security
```

Eval 先由真实 `decideEvent` 根据 Host 认定的 provenance/source policy 生成
`RunPolicy`，再依次应用安全档位和单次 Run 工具策略，最后对权威
`ToolDescriptor` 全目录验证精确 allowlist 与 forbidden tools。正文内容只作为
case payload，不能参与授权计算。

这是一套确定性授权回归，不调用模型或公网。新增内置工具、能力类别、安全档位或
来源策略时必须扩展矩阵；真实模型 Prompt Injection canary 可作为补充，但不能替代
Host 侧 fail-closed 策略。
