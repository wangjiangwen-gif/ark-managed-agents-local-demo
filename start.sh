#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18 或更高版本。"
  exit 1
fi

export ARK_DEMO_OPEN_BROWSER="${ARK_DEMO_OPEN_BROWSER:-1}"
exec node server.mjs
