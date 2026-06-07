#!/usr/bin/env bash

set -euo pipefail

NODE_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/common.sh"
# shellcheck source=lib/fetch-bundle.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/fetch-bundle.sh"
# shellcheck source=lib/bootstrap-core.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/bootstrap-core.sh"
# shellcheck source=lib/remote-bootstrap.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/remote-bootstrap.sh"
# shellcheck source=lib/install-stack.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/install-stack.sh"

require_cmd openssl

INSTALL_MODE="$(detect_install_mode)"

echo "== Webserver Panel node-installasjon =="
if [ "$INSTALL_MODE" = "local" ]; then
  echo "Modus: lokal (kjører på denne serveren)"
else
  echo "Modus: remote (SSH fra lokal maskin)"
  require_cmd ssh
fi
require_cmd rsync
echo

resolve_node_bundle

if [ -r /dev/tty ] 2>/dev/null && [ -z "${BASE_DOMAIN:-}" ]; then
  echo "Fyll inn verdiene under (Enter = default)." >/dev/tty
  echo
fi

prompt_or_env SERVER_USER "Deploy-bruker på noden" "deploy"
prompt_or_env REMOTE_ROOT "Rotmappe for node-filer" "/home/${SERVER_USER}/skybygger"

if [ "$INSTALL_MODE" = "remote" ]; then
  prompt_or_env SERVER_HOST "Server IP/host" "204.168.157.12"
  prompt_or_env BOOTSTRAP_SSH_USER "SSH-bruker for bootstrap (root på fersk server)" "root"
else
  : "${SERVER_HOST:=}"
  if [ "$(id -u)" -ne 0 ] && [ "$(whoami)" != "$SERVER_USER" ]; then
    echo "Tips: kjør som root på fersk server: curl -fsSL .../install.sh | bash"
    echo "      (eller som ${SERVER_USER} hvis Docker allerede er klart)"
  fi
fi

prompt_or_env BASE_DOMAIN "BASE_DOMAIN (f.eks. apps.webserverpanel.com)" "apps.webserverpanel.com"
prompt_or_env ACME_EMAIL "ACME_EMAIL (Let's Encrypt e-post)" "admin@webserverpanel.com"

AGENT_SECRET_DEFAULT="$(openssl rand -hex 32)"
PG_PASS_DEFAULT="$(openssl rand -hex 24)"
REDIS_PASS_DEFAULT="$(openssl rand -hex 24)"

prompt_secret_or_env AGENT_SECRET "AGENT_SECRET" "$AGENT_SECRET_DEFAULT"
prompt_secret_or_env PG_ADMIN_PASSWORD "PG_ADMIN_PASSWORD" "$PG_PASS_DEFAULT"
prompt_secret_or_env REDIS_PASSWORD "REDIS_PASSWORD" "$REDIS_PASS_DEFAULT"

prompt_or_env PG_ADMIN_USER "PG_ADMIN_USER" "postgres"
prompt_or_env PG_MAX_CONNECTIONS "PG_MAX_CONNECTIONS" "300"
prompt_or_env BACKUP_MAX_FILES_PER_APP "BACKUP_MAX_FILES_PER_APP" "5"
prompt_or_env NIXPACKS_NODE_VERSION "NIXPACKS_NODE_VERSION (tom = default)" ""

AGENT_HOST="agent.${BASE_DOMAIN}"
REMOTE_INFRA_DIR="${REMOTE_ROOT}/infrastructure"
REMOTE_AGENT_DIR="${REMOTE_ROOT}/agent"
REMOTE_SCRIPTS_DIR="${REMOTE_ROOT}/scripts"

TMP_ENV="$(mktemp)"
trap 'rm -f "$TMP_ENV"; cleanup_bundle' EXIT

cat >"$TMP_ENV" <<EOF
BASE_DOMAIN=${BASE_DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
AGENT_SECRET=${AGENT_SECRET}
PG_MAX_CONNECTIONS=${PG_MAX_CONNECTIONS}
BACKUP_MAX_FILES_PER_APP=${BACKUP_MAX_FILES_PER_APP}
PG_ADMIN_USER=${PG_ADMIN_USER}
PG_ADMIN_PASSWORD=${PG_ADMIN_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
EOF

if [ -n "$NIXPACKS_NODE_VERSION" ]; then
  echo "NIXPACKS_NODE_VERSION=${NIXPACKS_NODE_VERSION}" >> "$TMP_ENV"
fi

echo
echo "== Oppsummering =="
if [ "$INSTALL_MODE" = "local" ]; then
  echo "Server: denne maskinen (bruker ${SERVER_USER})"
else
  echo "Server: ${SERVER_USER}@${SERVER_HOST} (bootstrap via ${BOOTSTRAP_SSH_USER})"
fi
echo "Rotmappe: ${REMOTE_ROOT}"
echo "BASE_DOMAIN: ${BASE_DOMAIN}"
echo "Agent host: ${AGENT_HOST}"
echo "Kilde: ${NODE_INSTALL_SOURCE:-auto} (${BUNDLE_ROOT})"
echo

echo "== Bootstrap og forutsetninger =="
if [ "$INSTALL_MODE" = "local" ]; then
  ensure_local_ready "$SERVER_USER" "$REMOTE_ROOT"
else
  ensure_remote_ready "$BOOTSTRAP_SSH_USER" "$SERVER_USER" "$REMOTE_ROOT" "$SERVER_HOST"
  check_remote_prereqs
fi
echo "OK: docker + compose klart."
echo

if ! ask_yes_no "Fortsette med installasjon?" "y" "INSTALL_CONFIRM"; then
  echo "Avbrutt."
  exit 0
fi

if [ "$INSTALL_MODE" = "local" ]; then
  mkdir -p "$REMOTE_INFRA_DIR" "$REMOTE_AGENT_DIR" "$REMOTE_SCRIPTS_DIR"
  sync_bundle_local "$BUNDLE_INFRA_DIR" "$BUNDLE_AGENT_DIR" "$BUNDLE_SCRIPTS_DIR" "$REMOTE_ROOT" "$SERVER_USER"

  echo "== Docker Hub-speil (daemon.json) =="
  configure_registry_mirror_local "$REMOTE_SCRIPTS_DIR" || true

  echo "== Lager .env =="
  write_env_local "${REMOTE_INFRA_DIR}/.env" "$TMP_ENV"
  if [ "$(id -u)" -eq 0 ] && [ "$(whoami)" != "$SERVER_USER" ]; then
    chown "${SERVER_USER}:${SERVER_USER}" "${REMOTE_INFRA_DIR}/.env"
  fi

  echo "== Starter stack (docker compose) =="
  start_stack_local "$SERVER_USER" "$REMOTE_INFRA_DIR"

  echo "== Oppretter agent route i Traefik =="
  configure_traefik_agent_route_local "$SERVER_USER" "$AGENT_HOST"

  echo "== Verifiserer tjenester =="
  verify_stack_local "$SERVER_USER" "$REMOTE_INFRA_DIR"

  if ask_yes_no "Installere daglig auto-cleanup timer nå?" "y" "INSTALL_CLEANUP_TIMER"; then
    echo "== Installerer agent-cleanup timer =="
    REMOTE_ROOT="$REMOTE_ROOT" SERVER_USER="$SERVER_USER" \
      "${REMOTE_SCRIPTS_DIR}/install-agent-cleanup-timer-local.sh" || \
      echo "Advarsel: klarte ikke installere cleanup-timer."
  fi
else
  ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p '${REMOTE_INFRA_DIR}' '${REMOTE_AGENT_DIR}' '${REMOTE_SCRIPTS_DIR}'"

  sync_bundle_remote "$BUNDLE_INFRA_DIR" "$BUNDLE_AGENT_DIR" "$BUNDLE_SCRIPTS_DIR" \
    "$SERVER_USER" "$SERVER_HOST" "$REMOTE_ROOT"

  echo "== Docker Hub-speil (daemon.json) =="
  configure_registry_mirror_remote "$SERVER_USER" "$SERVER_HOST" "$REMOTE_SCRIPTS_DIR" || true

  echo "== Laster opp .env =="
  write_env_remote "$SERVER_USER" "$SERVER_HOST" "${REMOTE_INFRA_DIR}/.env" "$TMP_ENV"

  echo "== Starter stack (docker compose) =="
  start_stack_remote "$SERVER_USER" "$SERVER_HOST" "$REMOTE_INFRA_DIR"

  echo "== Oppretter agent route i Traefik =="
  configure_traefik_agent_route_remote "$SERVER_USER" "$SERVER_HOST" "$AGENT_HOST"

  echo "== Verifiserer tjenester =="
  verify_stack_remote "$SERVER_USER" "$SERVER_HOST" "$REMOTE_INFRA_DIR"

  if ask_yes_no "Installere daglig auto-cleanup timer nå?" "y" "INSTALL_CLEANUP_TIMER"; then
    echo "== Installerer agent-cleanup timer =="
    SERVER_HOST="$SERVER_HOST" SERVER_USER="$SERVER_USER" REMOTE_ROOT="$REMOTE_ROOT" \
      "${BUNDLE_SCRIPTS_DIR}/install-agent-cleanup-timer-remote.sh" || \
      echo "Advarsel: klarte ikke installere cleanup-timer."
  fi
fi

echo
echo "Ferdig."
echo "Agent health URL: https://${AGENT_HOST}/health"
echo "Sett i dashboard:"
echo "  AGENT_URL=https://${AGENT_HOST}"
echo "  AGENT_SECRET=${AGENT_SECRET}"
