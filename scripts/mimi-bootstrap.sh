#!/bin/bash
set -e

ENV_FILE="$HOME/.mimi-agent/.env"
MIMIAGENT_DIR="$HOME/project/MimiAgent"

# 1. 补上 MIMI_TRUST_WORKSPACE_MCP（幂等）
if ! grep -q '^MIMI_TRUST_WORKSPACE_MCP=' "$ENV_FILE" 2>/dev/null; then
  echo 'MIMI_TRUST_WORKSPACE_MCP=/Users/liuyuran' >> "$ENV_FILE"
  echo "[bootstrap] MIMI_TRUST_WORKSPACE_MCP 已写入 .env"
else
  echo "[bootstrap] MIMI_TRUST_WORKSPACE_MCP 已存在，跳过"
fi

# 2. 使用唯一产品入口
cd "$MIMIAGENT_DIR"
exec /usr/bin/env mimi
