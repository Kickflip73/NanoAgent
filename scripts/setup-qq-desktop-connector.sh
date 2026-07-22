#!/usr/bin/env bash
# Connect MimiAgent to a OneBot plugin hosted by the already-running desktop QQ.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export QQ_ONEBOT_MODE=desktop
exec bash "$SCRIPT_DIR/setup-qq-connector.sh" "$@"
