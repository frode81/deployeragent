#!/usr/bin/env bash
# SSH-basert bootstrap (fra lokal maskin mot annen server).

# shellcheck source=bootstrap-core.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-core.sh"

remote_probe_deploy_ready() {
  local user="$1"
  local host="$2"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${user}@${host}" \
    'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && groups | grep -qw docker' \
    2>/dev/null
}

remote_probe_ssh() {
  local user="$1"
  local host="$2"
  ssh -o BatchMode=yes -o ConnectTimeout=10 "${user}@${host}" "echo ok" >/dev/null 2>&1
}

run_remote_bootstrap() {
  local bootstrap_user="$1"
  local deploy_user="$2"
  local remote_root="$3"
  local host="$4"

  echo "== Bootstrap på server (${bootstrap_user}@${host}) =="
  echo "   Oppretter ${deploy_user}, installerer Docker, setter opp ${remote_root}"

  if ! remote_probe_ssh "$bootstrap_user" "$host"; then
    echo "Klarte ikke SSH til ${bootstrap_user}@${host}." >&2
    exit 1
  fi

  ssh -tt "${bootstrap_user}@${host}" "bash -s" <<REMOTE_BOOTSTRAP
set -euo pipefail
$(declare -f bootstrap_server)
bootstrap_server $(printf '%q' "$deploy_user") $(printf '%q' "$remote_root")
REMOTE_BOOTSTRAP

  stty sane 2>/dev/null || true
  sleep 2
}

ensure_remote_ready() {
  local bootstrap_user="$1"
  local deploy_user="$2"
  local remote_root="$3"
  local host="$4"

  if [ "${INSTALL_SKIP_BOOTSTRAP:-}" = "y" ] || [ "${INSTALL_SKIP_BOOTSTRAP:-}" = "1" ]; then
    echo "Hopper over bootstrap (INSTALL_SKIP_BOOTSTRAP)."
    return 0
  fi

  if remote_probe_deploy_ready "$deploy_user" "$host"; then
    echo "OK: ${deploy_user}@${host} har Docker — bootstrap hoppes over."
    return 0
  fi

  run_remote_bootstrap "$bootstrap_user" "$deploy_user" "$remote_root" "$host"
}
