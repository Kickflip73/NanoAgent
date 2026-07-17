#!/usr/bin/env bash
# Compatibility entrypoint. IM setup must stay incremental and background-only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "MimiAgent 后台 Connector 配置"
echo "QQ 将使用 NapCat/OneBot HTTP + 反向 WebSocket；不会修改或操作 QQ.app。"
echo "微信需单独配置腾讯 openclaw-weixin Bot bridge；不会操作 WeChat.app。"
echo

"$SCRIPT_DIR/setup-qq-connector.sh" "$@"

echo
echo "其他 Connector 凭证不会由本脚本覆盖；请在现有 MimiAgent 环境文件中增量配置。"
echo "微信后台桥说明：docs/CONNECTORS.md#openclaw-微信传输桥"
