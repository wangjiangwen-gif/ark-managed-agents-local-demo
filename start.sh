#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 18 或更高版本。"
  exit 1
fi

export ARK_DEMO_OPEN_BROWSER="${ARK_DEMO_OPEN_BROWSER:-1}"
export ARK_DEMO_SUPERVISED=1
opened=0
while true; do
  if [ "$opened" -eq 1 ]; then
    export ARK_DEMO_OPEN_BROWSER=0
  fi
  if node server.mjs; then
    exit_code=0
  else
    exit_code=$?
  fi
  if [ "$exit_code" -ne 75 ]; then
    exit "$exit_code"
  fi
  opened=1
  echo "正在重新启动本地服务…"
done
