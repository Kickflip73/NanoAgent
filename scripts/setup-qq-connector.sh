#!/usr/bin/env bash
# Configure MimiAgent's background-only NapCat/OneBot QQ connector.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOME_DIR="${HOME:?HOME is required}"
NODE_BIN="$(command -v node)"
MIMI_BIN="${MIMI_BIN:-$(command -v mimi || true)}"
RUNNING_CONNECTORS_FILE=""
if [[ -n "$MIMI_BIN" ]]; then
  RUNNING_CONNECTORS_FILE="$("$MIMI_BIN" daemon doctor 2>/dev/null | "$NODE_BIN" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const report = JSON.parse(input);
        if (typeof report?.paths?.connectorsConfig === "string") process.stdout.write(report.paths.connectorsConfig);
      } catch {}
    });
  ' || true)"
fi

if [[ -n "${MIMI_CONNECTORS_CONFIG:-}" ]]; then
  CONNECTORS_FILE="$MIMI_CONNECTORS_CONFIG"
elif [[ -n "$RUNNING_CONNECTORS_FILE" ]]; then
  CONNECTORS_FILE="$RUNNING_CONNECTORS_FILE"
elif [[ -f "$HOME_DIR/.mimi-agent/daemon/connectors.json" ]]; then
  CONNECTORS_FILE="$HOME_DIR/.mimi-agent/daemon/connectors.json"
else
  CONNECTORS_FILE="$HOME_DIR/.mimi-agent/daemon/connectors.json"
fi

if [[ -n "${MIMI_ENV_FILE:-}" ]]; then
  ENV_FILE="$MIMI_ENV_FILE"
elif [[ -f "$HOME_DIR/.mimi-agent/.env" ]]; then
  ENV_FILE="$HOME_DIR/.mimi-agent/.env"
else
  ENV_FILE="$HOME_DIR/.mimi-agent/.env"
fi

mkdir -p "$(dirname "$CONNECTORS_FILE")" "$(dirname "$ENV_FILE")"
chmod 700 "$(dirname "$CONNECTORS_FILE")" "$(dirname "$ENV_FILE")" 2>/dev/null || true

export CONNECTORS_FILE ENV_FILE NODE_BIN PROJECT_ROOT
"$NODE_BIN" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

function readConfig(file) {
  if (!fs.existsSync(file)) return { connectors: {} };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !parsed.connectors || typeof parsed.connectors !== 'object') {
    throw new Error(`invalid Connector config: ${file}`);
  }
  return parsed;
}

function writeAtomic(file, contents) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

function upsertEnv(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, `${key}=${value}`);
  const prefix = contents && !contents.endsWith('\n') ? '\n' : '';
  return `${contents}${prefix}${key}=${value}\n`;
}

const config = readConfig(process.env.CONNECTORS_FILE);
const previous = config.connectors.qq && typeof config.connectors.qq === 'object'
  ? config.connectors.qq
  : {};
const actions = {
  send_message: { description: '向 QQ 私聊或群聊主动发送文本消息' },
  health_check: { description: '调用 NapCat get_status 并确认反向 WebSocket 入站连接是否在线' },
  recent_conversations: { description: '通过 NapCat 后台 API 读取近期 QQ 会话；target 为 all' },
  list_friends: { description: '通过 NapCat 后台 API 列出有界好友目录；target 为 all' },
  list_groups: { description: '通过 NapCat 后台 API 列出有界群目录；target 为 all' },
  friend_history: { description: '读取指定 QQ 好友的有界历史；target 为 private:<QQ号>' },
  group_history: { description: '读取指定 QQ 群的有界历史；target 为 group:<群号>' },
};
config.connectors.qq = {
  ...previous,
  enabled: false,
  command: process.env.NODE_BIN,
  args: [path.join(process.env.PROJECT_ROOT, 'examples/connectors/qq-napcat-connector.mjs')],
  envAllowlist: [...new Set([
    ...(Array.isArray(previous.envAllowlist) ? previous.envAllowlist : []),
    'NC_HTTP_URL', 'NC_WS_PORT', 'NC_ACCESS_TOKEN', 'NC_WS_ACCESS_TOKEN', 'NC_STATUS_POLL_MS',
  ])],
  source: 'qq',
  trust: 'external',
  profileId: 'owner',
  restart: true,
  deliveryTimeoutMs: previous.deliveryTimeoutMs ?? 30_000,
  actionTimeoutMs: previous.actionTimeoutMs ?? 30_000,
  actions: { ...actions, ...(previous.actions || {}) },
};
for (const id of ['qq-applescript', 'wechat-applescript']) {
  if (config.connectors[id]) config.connectors[id].enabled = false;
}
writeAtomic(process.env.CONNECTORS_FILE, `${JSON.stringify(config, null, 2)}\n`);

let env = fs.existsSync(process.env.ENV_FILE) ? fs.readFileSync(process.env.ENV_FILE, 'utf8') : '';
const existing = Object.fromEntries(env.split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  return match ? [[match[1], match[2]]] : [];
}));
const sharedToken = existing.NC_ACCESS_TOKEN || randomBytes(32).toString('base64url');
env = upsertEnv(env, 'NC_HTTP_URL', existing.NC_HTTP_URL || 'http://127.0.0.1:3000');
env = upsertEnv(env, 'NC_WS_PORT', existing.NC_WS_PORT || '3080');
env = upsertEnv(env, 'NC_ACCESS_TOKEN', sharedToken);
env = upsertEnv(env, 'NC_WS_ACCESS_TOKEN', existing.NC_WS_ACCESS_TOKEN || sharedToken);
writeAtomic(process.env.ENV_FILE, env);
NODE

echo "MimiAgent QQ 后台 Connector 配置已增量写入：${CONNECTORS_FILE}"
echo "凭证已写入 owner-only 环境文件：${ENV_FILE}（不会输出 token）"
echo "QQ/微信 UI 自动化 Connector 已关闭。"

if [[ -n "$MIMI_BIN" ]]; then
  "$MIMI_BIN" daemon connectors reload >/dev/null
  echo "MimiAgent Connector 已热重载，UI Connector 进程已停止。"
fi

if "$NODE_BIN" <<'NODE'
const { readFileSync } = await import('node:fs');
const values = Object.fromEntries(readFileSync(process.env.ENV_FILE, 'utf8').split(/\r?\n/).flatMap((line) => {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  return match ? [[match[1], match[2]]] : [];
}));
const base = values.NC_HTTP_URL || 'http://127.0.0.1:3000';
const headers = { 'content-type': 'application/json' };
if (values.NC_ACCESS_TOKEN) headers.authorization = `Bearer ${values.NC_ACCESS_TOKEN}`;
try {
  const response = await fetch(`${base.replace(/\/$/, '')}/get_status`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  process.exit(response.ok && (body.status === 'ok' || body.retcode === 0) ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
then
  export CONNECTORS_FILE
  "$NODE_BIN" <<'NODE'
const fs = require('node:fs');
const file = process.env.CONNECTORS_FILE;
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
config.connectors.qq.enabled = true;
const temporary = `${file}.tmp-${process.pid}`;
fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, file);
NODE
  echo "NapCat HTTP 已响应，QQ Connector 已启用。"
  if [[ -n "$MIMI_BIN" ]]; then
    "$MIMI_BIN" daemon connectors reload >/dev/null
    echo "MimiAgent Connector 已热重载。"
  fi
else
  echo "NapCat HTTP 尚未响应；QQ Connector 保持禁用，避免误报在线。"
  echo "安装/状态入口：$PROJECT_ROOT/scripts/install-napcat-macos.mjs（推荐把已验证的官方 QQ 副本通过 NAPCAT_QQ_APP 安装到 MimiAgent 私有目录）。"
  echo "NapCat 配置：HTTP 127.0.0.1:3000；反向 WS ws://127.0.0.1:3080/；两端 token 使用 $ENV_FILE 中的值。"
fi
