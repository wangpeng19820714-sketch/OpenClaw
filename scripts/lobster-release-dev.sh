#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-configs/openclaw.json}"
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

echo "Starting OpenClaw gateway for lobster-release development"
echo "OPENCLAW_CONFIG_PATH=$OPENCLAW_CONFIG_PATH"
echo "OPENCLAW_GATEWAY_PORT=$PORT"

exec node scripts/run-node.mjs gateway --port "$PORT"
