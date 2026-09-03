#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR/worker"
go mod download
echo "公开 Ark Runtime Go SDK 已就绪"
