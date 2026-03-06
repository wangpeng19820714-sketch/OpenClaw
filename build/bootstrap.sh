#!/usr/bin/env bash
set -euo pipefail

# macOS bootstrap helper for OpenClaw daemon lifecycle.
# Default action is deploy-only (install + configure + stop), not start.

readonly REQUIRED_NODE_MAJOR=22
readonly DEFAULT_PORT=18789
readonly DEFAULT_OPENCLAW_VERSION="2026.3.2"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_CONFIG_PATH="${REPO_ROOT}/configs/openclaw.json"

ENV_FILE="${OPENCLAW_ENV_FILE:-${REPO_ROOT}/.env}"
STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
OPENCLAW_LOG_PREFIX="${OPENCLAW_LOG_PREFIX:-gateway}"

INSTALL_ROOT="${OPENCLAW_INSTALL_ROOT:-${HOME}/.openclaw/bootstrap}"
NPM_PREFIX="${OPENCLAW_NPM_PREFIX:-${INSTALL_ROOT}/npm-global}"
OPENCLAW_NPM_SPEC="${OPENCLAW_NPM_SPEC:-openclaw@${DEFAULT_OPENCLAW_VERSION}}"
OPENCLAW_BIN="${OPENCLAW_BIN:-${NPM_PREFIX}/bin/openclaw}"
GEMINI_BIN="${OPENCLAW_GEMINI_BIN:-}"
GEMINI_CLI_NPM_SPEC="${OPENCLAW_GEMINI_CLI_NPM_SPEC:-@google/gemini-cli}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-${DEFAULT_PORT}}"
GATEWAY_LAUNCHD_LABEL="${OPENCLAW_LAUNCHD_LABEL:-ai.openclaw.gateway}"
GATEWAY_LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/${GATEWAY_LAUNCHD_LABEL}.plist"

if [[ -z "${OPENCLAW_CONFIG_PATH:-}" && -f "${DEFAULT_CONFIG_PATH}" ]]; then
  export OPENCLAW_CONFIG_PATH="${DEFAULT_CONFIG_PATH}"
fi

BOOTSTRAP_LOG_FILE=""
GATEWAY_STDOUT_LOG=""
GATEWAY_STDERR_LOG=""

now() {
  date "+%Y-%m-%d %H:%M:%S"
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

ensure_dir_on_path() {
  local dir="$1"
  [[ -n "${dir}" && -d "${dir}" ]] || return 0
  case ":${PATH}:" in
    *":${dir}:"*)
      ;;
    *)
      PATH="${dir}:${PATH}"
      export PATH
      ;;
  esac
}

refresh_runtime_paths() {
  STATE_DIR="${OPENCLAW_STATE_DIR:-${HOME}/.openclaw}"
  OPENCLAW_LOG_PREFIX="${OPENCLAW_LOG_PREFIX:-gateway}"
  GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-${DEFAULT_PORT}}"

  BOOTSTRAP_LOG_FILE="${STATE_DIR}/logs/bootstrap.log"
  GATEWAY_STDOUT_LOG="${STATE_DIR}/logs/${OPENCLAW_LOG_PREFIX}.log"
  GATEWAY_STDERR_LOG="${STATE_DIR}/logs/${OPENCLAW_LOG_PREFIX}.err.log"
}

ensure_log_dir() {
  mkdir -p "${STATE_DIR}/logs"
  touch "${BOOTSTRAP_LOG_FILE}"
  chmod 600 "${BOOTSTRAP_LOG_FILE}" || true
}

log() {
  local line
  line="[$(now)] $*"
  echo "${line}"
  if [[ -n "${BOOTSTRAP_LOG_FILE}" ]]; then
    echo "${line}" >>"${BOOTSTRAP_LOG_FILE}"
  fi
}

die() {
  log "ERROR: $*"
  exit 1
}

resolve_openclaw_bin_path() {
  local candidate
  for candidate in \
    "${OPENCLAW_BIN}" \
    "${NPM_PREFIX}/bin/openclaw" \
    "${NPM_PREFIX}/node_modules/.bin/openclaw"; do
    if [[ -x "${candidate}" ]]; then
      OPENCLAW_BIN="${candidate}"
      return 0
    fi
  done
  return 1
}

resolve_gemini_bin_path() {
  local candidate discovered
  discovered="$(command -v gemini 2>/dev/null || true)"
  for candidate in \
    "${GEMINI_BIN}" \
    "${discovered}" \
    "${NPM_PREFIX}/bin/gemini" \
    "${NPM_PREFIX}/node_modules/.bin/gemini"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      ensure_dir_on_path "$(dirname "${candidate}")"
      GEMINI_BIN="${candidate}"
      return 0
    fi
  done
  return 1
}

run_quiet() {
  local description="$1"
  shift

  log "${description}"
  if ! "$@" >>"${BOOTSTRAP_LOG_FILE}" 2>&1; then
    log "Command failed. Recent bootstrap log:"
    tail -n 40 "${BOOTSTRAP_LOG_FILE}" || true
    die "${description} failed"
  fi
}

is_gateway_launchagent_loaded() {
  launchctl print "gui/${UID}/${GATEWAY_LAUNCHD_LABEL}" >/dev/null 2>&1
}

ensure_gateway_launchagent_loaded() {
  if is_gateway_launchagent_loaded; then
    return 0
  fi
  [[ -f "${GATEWAY_LAUNCHD_PLIST}" ]] || return 1
  run_quiet "Bootstrapping gateway LaunchAgent" \
    launchctl bootstrap "gui/${UID}" "${GATEWAY_LAUNCHD_PLIST}"
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    die "This script only supports macOS."
  fi
}

require_node_and_npm() {
  command -v node >/dev/null 2>&1 || die "node is required (Node >= ${REQUIRED_NODE_MAJOR})."
  command -v npm >/dev/null 2>&1 || die "npm is required."

  local node_version node_major
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  [[ -n "${node_version}" ]] || die "Unable to detect Node version."

  node_major="${node_version%%.*}"
  if [[ ! "${node_major}" =~ ^[0-9]+$ ]]; then
    die "Unexpected Node version format: ${node_version}"
  fi
  if (( node_major < REQUIRED_NODE_MAJOR )); then
    die "Node ${node_version} is too old. Need Node >= ${REQUIRED_NODE_MAJOR}."
  fi
}

load_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    # User-controlled env file; keep values private and never echo them.
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
    log "Loaded environment from ${ENV_FILE}"
  else
    log "No .env found at ${ENV_FILE}; continuing with current environment."
  fi

  refresh_runtime_paths
  ensure_log_dir
}

sync_env_to_state_dir() {
  local target_env
  target_env="${STATE_DIR}/.env"

  mkdir -p "${STATE_DIR}"

  if [[ ! -f "${ENV_FILE}" ]]; then
    log "Skip syncing .env to state dir: source file not found (${ENV_FILE})."
    return
  fi

  if [[ -f "${target_env}" ]] && cmp -s "${ENV_FILE}" "${target_env}"; then
    log "State .env already up to date (${target_env})."
    return
  fi

  cp "${ENV_FILE}" "${target_env}"
  chmod 600 "${target_env}" || true
  log "Synced .env to ${target_env} (for launchd daemon runtime)."
}

extract_expected_version_from_spec() {
  if [[ "${OPENCLAW_NPM_SPEC}" =~ ^[^@]+@([0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)*)$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi
  echo ""
}

ensure_openclaw_installed() {
  mkdir -p "${NPM_PREFIX}"

  local expected_version installed_version
  expected_version="$(extract_expected_version_from_spec)"

  if resolve_openclaw_bin_path; then
    installed_version="$("${OPENCLAW_BIN}" --version 2>/dev/null || true)"
    if [[ -z "${expected_version}" ]]; then
      log "OpenClaw CLI found at ${OPENCLAW_BIN}."
      return
    fi
    if [[ "${installed_version}" == *"${expected_version}"* ]]; then
      log "OpenClaw CLI already matches version ${expected_version}."
      return
    fi
    log "OpenClaw CLI version mismatch (have: ${installed_version:-unknown}, want: ${expected_version})."
  fi

  run_quiet "Installing ${OPENCLAW_NPM_SPEC} into ${NPM_PREFIX}" \
    npm install -g --prefix "${NPM_PREFIX}" --omit=dev --no-audit --no-fund "${OPENCLAW_NPM_SPEC}"

  resolve_openclaw_bin_path || die "OpenClaw binary not found after install under ${NPM_PREFIX}"
  log "OpenClaw CLI installed at ${OPENCLAW_BIN}."
}

update_openclaw() {
  run_quiet "Updating ${OPENCLAW_NPM_SPEC}" \
    npm install -g --prefix "${NPM_PREFIX}" --omit=dev --no-audit --no-fund "${OPENCLAW_NPM_SPEC}"

  resolve_openclaw_bin_path || die "OpenClaw binary not found after update under ${NPM_PREFIX}"
}

ensure_gemini_cli_installed() {
  if resolve_gemini_bin_path; then
    log "Gemini CLI found at ${GEMINI_BIN}."
    return 0
  fi

  if command -v brew >/dev/null 2>&1; then
    run_quiet "Installing gemini-cli via Homebrew" brew install gemini-cli
  else
    mkdir -p "${NPM_PREFIX}"
    run_quiet "Installing ${GEMINI_CLI_NPM_SPEC} into ${NPM_PREFIX}" \
      npm install -g --prefix "${NPM_PREFIX}" --no-audit --no-fund "${GEMINI_CLI_NPM_SPEC}"
  fi

  resolve_gemini_bin_path || die "Gemini CLI not found after installation."
  log "Gemini CLI ready at ${GEMINI_BIN}."
}

configure_gateway_defaults() {
  run_quiet "Setting gateway.mode=local" \
    "${OPENCLAW_BIN}" config set gateway.mode local

  run_quiet "Setting gateway.port=${GATEWAY_PORT}" \
    "${OPENCLAW_BIN}" config set gateway.port "${GATEWAY_PORT}"
}

install_gateway_daemon() {
  run_quiet "Installing gateway daemon (launchd, port ${GATEWAY_PORT})" \
    "${OPENCLAW_BIN}" gateway install --force --port "${GATEWAY_PORT}"
}

provider_needs_gemini_cli() {
  [[ "${1:-}" == "google-gemini-cli" ]]
}

provider_oauth_status() {
  local provider="$1"
  "${OPENCLAW_BIN}" models status --json 2>>"${BOOTSTRAP_LOG_FILE}" | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const start = input.indexOf("{");
  if (start < 0) {
    process.exit(2);
  }
  const payload = JSON.parse(input.slice(start));
  const provider = process.argv[1];
  const entry = payload?.auth?.oauth?.providers?.find((item) => item.provider === provider);
  process.stdout.write(entry?.status ?? "missing");
});' "${provider}"
}

enable_google_gemini_cli_auth_plugin() {
  run_quiet "Enabling google-gemini-cli-auth plugin" \
    "${OPENCLAW_BIN}" plugins enable google-gemini-cli-auth
}

ensure_provider_oauth_ready() {
  local provider="$1"
  local status=""

  if provider_needs_gemini_cli "${provider}"; then
    ensure_gemini_cli_installed
    enable_google_gemini_cli_auth_plugin
  fi

  status="$(provider_oauth_status "${provider}")" || die "Failed to inspect OAuth status for ${provider}."
  case "${status}" in
    ok)
      log "OAuth already configured for ${provider}."
      return 0
      ;;
    expiring)
      log "OAuth for ${provider} is valid but expiring soon."
      return 0
      ;;
  esac

  if [[ ! -t 0 || ! -t 1 ]]; then
    die "OAuth missing for ${provider}. Re-run interactively or set OPENCLAW_OAUTH_SKIP=1 to skip validation."
  fi

  log "OAuth missing for ${provider}; starting login flow."
  "${OPENCLAW_BIN}" models auth login --provider "${provider}" --set-default || \
    die "OAuth login failed for ${provider}."

  status="$(provider_oauth_status "${provider}")" || die "Failed to re-check OAuth status for ${provider}."
  case "${status}" in
    ok|expiring)
      log "OAuth verified for ${provider}."
      ;;
    *)
      die "OAuth login completed but ${provider} is still reported as ${status}."
      ;;
  esac
}

ensure_requested_oauth_providers_ready() {
  local raw provider

  if is_truthy "${OPENCLAW_OAUTH_SKIP:-0}"; then
    log "Skipping OAuth validation per OPENCLAW_OAUTH_SKIP."
    return 0
  fi

  raw="${OPENCLAW_OAUTH_PROVIDERS:-}"
  if [[ -z "${raw//[[:space:],]/}" ]]; then
    return 0
  fi

  raw="${raw//,/ }"
  for provider in ${raw}; do
    [[ -n "${provider}" ]] || continue
    ensure_provider_oauth_ready "${provider}"
  done
}

health_check() {
  local timeout_ms="${1:-5000}"

  if "${OPENCLAW_BIN}" health --timeout "${timeout_ms}" --json >/dev/null 2>>"${BOOTSTRAP_LOG_FILE}"; then
    log "Health check OK."
    return 0
  fi

  log "Health check FAILED."
  return 1
}

wait_for_health() {
  local attempts="${1:-15}"
  local sleep_seconds="${2:-2}"
  local i

  for ((i = 1; i <= attempts; i++)); do
    if health_check 4000; then
      return 0
    fi
    sleep "${sleep_seconds}"
  done

  return 1
}

cmd_deploy() {
  require_macos
  require_node_and_npm
  refresh_runtime_paths
  ensure_log_dir
  load_env_file
  ensure_openclaw_installed
  sync_env_to_state_dir
  ensure_requested_oauth_providers_ready
  configure_gateway_defaults
  install_gateway_daemon

  # "Deploy only": keep service installed but not running.
  run_quiet "Stopping gateway service after deploy" "${OPENCLAW_BIN}" gateway stop

  log "Deploy finished. Service is installed but stopped."
  log "Use: $0 start"
}

cmd_start() {
  require_macos
  require_node_and_npm
  refresh_runtime_paths
  ensure_log_dir
  load_env_file
  ensure_openclaw_installed
  sync_env_to_state_dir
  ensure_requested_oauth_providers_ready
  ensure_gateway_launchagent_loaded || true

  run_quiet "Starting gateway service" "${OPENCLAW_BIN}" gateway start

  if wait_for_health 15 2; then
    log "Gateway started and healthy on port ${GATEWAY_PORT}."
  else
    die "Gateway started but health check did not pass in time."
  fi
}

cmd_stop() {
  require_macos
  require_node_and_npm
  refresh_runtime_paths
  ensure_log_dir
  load_env_file
  ensure_openclaw_installed

  run_quiet "Stopping gateway service" "${OPENCLAW_BIN}" gateway stop
  log "Gateway stopped."
}

cmd_status() {
  require_macos
  require_node_and_npm
  refresh_runtime_paths
  ensure_log_dir
  load_env_file
  ensure_openclaw_installed

  "${OPENCLAW_BIN}" gateway status || true

  if health_check 4000; then
    return 0
  fi

  log "Gateway not healthy (or not running)."
  return 1
}

cmd_health() {
  require_macos
  require_node_and_npm
  refresh_runtime_paths
  ensure_log_dir
  load_env_file
  ensure_openclaw_installed

  health_check 8000
}

cmd_logs() {
  refresh_runtime_paths
  ensure_log_dir

  local target="gateway"
  local follow="0"
  local lines="200"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      gateway|stderr|bootstrap)
        target="$1"
        shift
        ;;
      -f|--follow)
        follow="1"
        shift
        ;;
      -n|--lines)
        [[ $# -ge 2 ]] || die "--lines requires a value"
        lines="$2"
        shift 2
        ;;
      *)
        die "Unknown logs option: $1"
        ;;
    esac
  done

  local file
  case "${target}" in
    gateway)
      file="${GATEWAY_STDOUT_LOG}"
      ;;
    stderr)
      file="${GATEWAY_STDERR_LOG}"
      ;;
    bootstrap)
      file="${BOOTSTRAP_LOG_FILE}"
      ;;
    *)
      die "Unsupported logs target: ${target}"
      ;;
  esac

  [[ -f "${file}" ]] || die "Log file not found: ${file}"

  if [[ "${follow}" == "1" ]]; then
    tail -n "${lines}" -f "${file}"
  else
    tail -n "${lines}" "${file}"
  fi
}

cmd_update() {
  require_macos
  require_node_and_npm
  refresh_runtime_paths
  ensure_log_dir
  load_env_file
  update_openclaw
  sync_env_to_state_dir
  configure_gateway_defaults
  install_gateway_daemon
  run_quiet "Stopping gateway service after update" "${OPENCLAW_BIN}" gateway stop
  log "Update finished. Service remains stopped."
}

usage() {
  cat <<USAGE
Usage: $0 [deploy|start|stop|status|logs|health|update]

Commands:
  deploy   Install/update CLI + configure daemon + stop it (default, no startup)
  start    Start gateway service and wait for health check
  stop     Stop gateway service
  status   Show service status and health probe
  health   Run health check only
  logs     Tail logs (targets: gateway|stderr|bootstrap, flags: -f, -n)
  update   Optional: update CLI + reinstall daemon, then stop

Environment variables:
  OPENCLAW_ENV_FILE     Path to .env (default: ${REPO_ROOT}/.env)
  OPENCLAW_NPM_SPEC     npm package spec (default: openclaw@${DEFAULT_OPENCLAW_VERSION})
  OPENCLAW_NPM_PREFIX   npm prefix for local install (default: ${NPM_PREFIX})
  OPENCLAW_BIN          Explicit openclaw binary path
  OPENCLAW_GEMINI_BIN   Explicit gemini binary path
  OPENCLAW_OAUTH_PROVIDERS
                       Comma-separated OAuth providers to verify during deploy/start
                       (example: google-gemini-cli,openai-codex)
  OPENCLAW_OAUTH_SKIP   Skip OAuth verification when set to 1/true/yes/on
  OPENCLAW_GATEWAY_PORT Default gateway port (default: ${DEFAULT_PORT})
USAGE
}

main() {
  local command="${1:-deploy}"
  shift || true

  case "${command}" in
    deploy)
      cmd_deploy
      ;;
    start)
      cmd_start
      ;;
    stop)
      cmd_stop
      ;;
    status)
      cmd_status
      ;;
    logs)
      cmd_logs "$@"
      ;;
    health)
      cmd_health
      ;;
    update)
      cmd_update
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      usage
      die "Unknown command: ${command}"
      ;;
  esac
}

main "$@"
