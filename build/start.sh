#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "${SCRIPT_DIR}/bootstrap.sh" stop >/dev/null 2>&1 || true

OPENCLAW_CONFIG_PATH=configs/openclaw.json node scripts/run-node.mjs gateway --port 18789
