#!/bin/bash
set -euo pipefail

REPO_URL="${OPENCLAW_MEM0_REPO_URL:-https://github.com/mem0ai/mem0.git}"
TARGET_DIR="${OPENCLAW_MEM0_UPSTREAM_DIR:-${HOME}/.openclaw/vendor/mem0-upstream}"
STATE_DIR="${OPENCLAW_MEM0_STATE_DIR:-${HOME}/.openclaw/services/mem0}"
COMPOSE_FILE="${OPENCLAW_MEM0_COMPOSE_FILE:-extensions-custom/docker-compose.mem0.yml}"
MEM0_BASE_URL="${OPENCLAW_MEM0_BASE_URL:-http://127.0.0.1:8888}"
MEM0_CHAT_MODEL="${OPENCLAW_MEM0_CHAT_MODEL:-qwen2.5:1.5b}"
MEM0_EMBED_MODEL="${OPENCLAW_MEM0_EMBED_MODEL:-nomic-embed-text}"

echo "Preparing Mem0 upstream outside the OpenClaw repo..."
echo "Target: ${TARGET_DIR}"
echo "State dir: ${STATE_DIR}"

mkdir -p "$(dirname "${TARGET_DIR}")"

if [ -d "${TARGET_DIR}/.git" ]; then
  echo "Existing upstream checkout found. Pulling latest changes..."
  git -C "${TARGET_DIR}" pull --ff-only
elif [ -d "${TARGET_DIR}" ]; then
  echo "Directory ${TARGET_DIR} exists but is not a git checkout."
  echo "Delete it or set OPENCLAW_MEM0_UPSTREAM_DIR to another path."
  exit 1
else
  echo "Cloning Mem0 from ${REPO_URL}..."
  git clone "${REPO_URL}" "${TARGET_DIR}"
fi

mkdir -p "${STATE_DIR}/history" "${STATE_DIR}/postgres" "${STATE_DIR}/neo4j" "${STATE_DIR}/ollama"

export OPENCLAW_MEM0_UPSTREAM_DIR="${TARGET_DIR}"
export OPENCLAW_MEM0_STATE_DIR="${STATE_DIR}"

echo "Starting Mem0 Docker stack..."
docker compose -f "${COMPOSE_FILE}" up -d --build

echo "Waiting for Ollama service..."
for _ in $(seq 1 60); do
  if docker compose -f "${COMPOSE_FILE}" exec -T ollama ollama list >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "Pulling Ollama chat model: ${MEM0_CHAT_MODEL}"
docker compose -f "${COMPOSE_FILE}" exec -T ollama ollama pull "${MEM0_CHAT_MODEL}"

echo "Pulling Ollama embedding model: ${MEM0_EMBED_MODEL}"
docker compose -f "${COMPOSE_FILE}" exec -T ollama ollama pull "${MEM0_EMBED_MODEL}"

echo "Waiting for Mem0 API..."
for _ in $(seq 1 60); do
  if curl -fsS "${MEM0_BASE_URL}/docs" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo "Configuring Mem0 to use local Ollama + local Docker storage..."
curl -fsS -X POST "${MEM0_BASE_URL}/configure" \
  -H "content-type: application/json" \
  --data @- <<EOF
{
  "version": "v1.1",
  "vector_store": {
    "provider": "pgvector",
    "config": {
      "host": "postgres",
      "port": 5432,
      "dbname": "postgres",
      "user": "postgres",
      "password": "postgres",
      "collection_name": "openclaw_memories_upstream"
    }
  },
  "graph_store": {
    "provider": "neo4j",
    "config": {
      "url": "bolt://neo4j:7687",
      "username": "neo4j",
      "password": "mem0graph"
    }
  },
  "llm": {
    "provider": "ollama",
    "config": {
      "model": "${MEM0_CHAT_MODEL}",
      "temperature": 0.2,
      "ollama_base_url": "http://ollama:11434"
    }
  },
  "embedder": {
    "provider": "ollama",
    "config": {
      "model": "${MEM0_EMBED_MODEL}",
      "ollama_base_url": "http://ollama:11434"
    }
  },
  "history_db_path": "/app/history/history.db",
  "custom_fact_extraction_prompt": "Extract durable facts from the input. Return strict JSON only in the exact shape {\\"facts\\":[\\"fact 1\\",\\"fact 2\\"]}. Every item in facts must be a plain string. Never return nested arrays. Never return objects inside facts. If there are no durable facts, return {\\"facts\\":[]}."
}
EOF

echo "Reconciling pgvector dimensions with the local embedding model..."
EMBED_DIM="$(
  docker compose -f "${COMPOSE_FILE}" exec -T -e MODEL_NAME="${MEM0_EMBED_MODEL}" mem0 python - <<'PY'
import json
import os
from urllib.request import Request, urlopen

payload = json.dumps(
    {"model": os.environ["MODEL_NAME"], "input": "dimension probe"}
).encode()
request = Request(
    "http://ollama:11434/api/embed",
    data=payload,
    headers={"Content-Type": "application/json"},
)
with urlopen(request) as response:
    data = json.load(response)
embeddings = data.get("embeddings") or []
print(len(embeddings[0]) if embeddings else 0)
PY
)"

CURRENT_VECTOR_DIM="$(
  docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U postgres -d postgres -tA -c "
    SELECT COALESCE(
      (regexp_match(format_type(a.atttypid, a.atttypmod), 'vector\\(([0-9]+)\\)'))[1]::int,
      0
    )
    FROM pg_attribute a
    WHERE a.attrelid = 'openclaw_memories_upstream'::regclass
      AND a.attname = 'vector'
      AND NOT a.attisdropped;
  "
)"

if [ "${EMBED_DIM}" = "0" ]; then
  echo "Failed to detect embedding dimension from Ollama."
  exit 1
fi

if [ "${CURRENT_VECTOR_DIM}" != "${EMBED_DIM}" ]; then
  ROW_COUNT="$(
    docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U postgres -d postgres -tA -c \
      "SELECT count(*) FROM openclaw_memories_upstream;"
  )"

  if [ "${ROW_COUNT}" != "0" ]; then
    echo "Vector dimension mismatch detected: table=openclaw_memories_upstream current=${CURRENT_VECTOR_DIM} embedder=${EMBED_DIM}."
    echo "The table is not empty, so setup-mem0.sh will not rewrite the schema automatically."
    exit 1
  fi

  echo "Updating openclaw_memories_upstream.vector from ${CURRENT_VECTOR_DIM} to ${EMBED_DIM} dimensions..."
  docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U postgres -d postgres -c "
    DROP INDEX IF EXISTS openclaw_memories_upstream_hnsw_idx;
    ALTER TABLE openclaw_memories_upstream
      ALTER COLUMN vector TYPE vector(${EMBED_DIM});
    CREATE INDEX openclaw_memories_upstream_hnsw_idx
      ON openclaw_memories_upstream
      USING hnsw (vector vector_cosine_ops);
  " >/dev/null
fi

echo "Mem0 upstream is ready at ${TARGET_DIR}"
echo "Mem0 API is running at ${MEM0_BASE_URL}"
echo "This repository now only keeps the OpenClaw bridge plugin in extensions-custom/mem0-openclaw."
