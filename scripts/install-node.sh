#!/usr/bin/env bash

set -euo pipefail

NODE_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/common.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/common.sh"
# shellcheck source=lib/fetch-bundle.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/fetch-bundle.sh"

require_cmd ssh
require_cmd rsync
require_cmd openssl

echo "== Webserver Panel node-installasjon =="
echo "Henter filer fra GitHub-pakke eller lokal monorepo, setter opp node via SSH."
echo

resolve_node_bundle

prompt_or_env SERVER_HOST "Server IP/host" "204.168.157.12"
prompt_or_env SERVER_USER "SSH-bruker" "deploy"
prompt_or_env REMOTE_ROOT "Remote rotmappe" "/home/deploy/skybygger"

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
echo "Server: ${SERVER_USER}@${SERVER_HOST}"
echo "Remote root: ${REMOTE_ROOT}"
echo "BASE_DOMAIN: ${BASE_DOMAIN}"
echo "Agent host: ${AGENT_HOST}"
echo "Kilde: ${NODE_INSTALL_SOURCE:-auto} (${BUNDLE_ROOT})"
echo

echo "== Preflight remote forutsetninger =="
check_remote_prereqs
echo "OK: docker + compose ser tilgjengelig ut."
echo

if ! ask_yes_no "Fortsette med installasjon?" "y" "INSTALL_CONFIRM"; then
  echo "Avbrutt."
  exit 0
fi

echo "== Oppretter mapper på server =="
ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p '${REMOTE_INFRA_DIR}' '${REMOTE_AGENT_DIR}' '${REMOTE_SCRIPTS_DIR}'"

echo "== Sikrer skrivetilgang på remote mapper/.env =="
PERM_CHECK_STATUS=0
PERM_CHECK_OUTPUT="$(
  ssh "${SERVER_USER}@${SERVER_HOST}" "
    set -e
    need_fix=0

    if [ ! -w '${REMOTE_ROOT}' ] || [ ! -w '${REMOTE_INFRA_DIR}' ] || [ ! -w '${REMOTE_AGENT_DIR}' ] || [ ! -w '${REMOTE_SCRIPTS_DIR}' ]; then
      need_fix=1
    fi
    if [ -e '${REMOTE_INFRA_DIR}/.env' ] && [ ! -w '${REMOTE_INFRA_DIR}/.env' ]; then
      need_fix=1
    fi

    if [ \"\$need_fix\" -eq 0 ]; then
      exit 0
    fi

    if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
      sudo chown -R '${SERVER_USER}:${SERVER_USER}' '${REMOTE_ROOT}'
      if [ -e '${REMOTE_INFRA_DIR}/.env' ]; then
        sudo chmod u+rw '${REMOTE_INFRA_DIR}/.env' || true
      fi
      exit 0
    fi

    echo '__PERM_NEEDS_MANUAL__'
    exit 42
  " 2>&1
)" || PERM_CHECK_STATUS=$?

if [ "$PERM_CHECK_STATUS" -eq 42 ] || [[ "$PERM_CHECK_OUTPUT" == *"__PERM_NEEDS_MANUAL__"* ]]; then
  echo "Mangler passordfri sudo i ikke-interaktiv SSH for automatisk rettighetsfiks."
  echo "Kjør dette manuelt på serveren som root/admin, og kjør scriptet på nytt:"
  echo "  sudo chown -R ${SERVER_USER}:${SERVER_USER} ${REMOTE_ROOT}"
  echo "  sudo chmod u+rw ${REMOTE_INFRA_DIR}/.env 2>/dev/null || true"
  exit 1
fi

if [ "$PERM_CHECK_STATUS" -ne 0 ]; then
  echo "Kunne ikke verifisere/fikse remote rettigheter."
  if [ -n "$PERM_CHECK_OUTPUT" ]; then
    echo "$PERM_CHECK_OUTPUT"
  fi
  exit 1
fi

echo "== Synker infrastructure =="
rsync -az --delete \
  --omit-dir-times --no-times --no-perms --no-owner --no-group \
  --exclude ".env" \
  --exclude ".DS_Store" \
  "${BUNDLE_INFRA_DIR}/" \
  "${SERVER_USER}@${SERVER_HOST}:${REMOTE_INFRA_DIR}/"

echo "== Synker agent =="
rsync -az --delete \
  --omit-dir-times --no-times --no-perms --no-owner --no-group \
  --exclude "node_modules" \
  --exclude ".git" \
  --exclude ".DS_Store" \
  "${BUNDLE_AGENT_DIR}/" \
  "${SERVER_USER}@${SERVER_HOST}:${REMOTE_AGENT_DIR}/"

echo "== Synker scripts =="
rsync -az \
  --omit-dir-times --no-times --no-perms --no-owner --no-group \
  "${BUNDLE_SCRIPTS_DIR}/cleanup-agent-server.sh" \
  "${BUNDLE_SCRIPTS_DIR}/cleanup-agent-server-smart.sh" \
  "${BUNDLE_SCRIPTS_DIR}/cleanup-agent-server-remote.sh" \
  "${BUNDLE_SCRIPTS_DIR}/install-agent-cleanup-timer-remote.sh" \
  "${BUNDLE_SCRIPTS_DIR}/configure-docker-registry-mirror.sh" \
  "${BUNDLE_SCRIPTS_DIR}/sync-agent.sh" \
  "${SERVER_USER}@${SERVER_HOST}:${REMOTE_SCRIPTS_DIR}/"

echo "== Docker Hub-speil (daemon.json) =="
REGISTRY_MIRROR_OK=0
if ssh -tt "${SERVER_USER}@${SERVER_HOST}" "set -e
  chmod +x '${REMOTE_SCRIPTS_DIR}/configure-docker-registry-mirror.sh'
  sudo bash '${REMOTE_SCRIPTS_DIR}/configure-docker-registry-mirror.sh'
  if sudo systemd-run --collect --wait=false /usr/bin/systemctl restart docker; then
    echo '[server] restart-jobb satt i kø.'
  else
    sudo systemctl restart docker
  fi
"; then
  REGISTRY_MIRROR_OK=1
else
  echo "" >&2
  echo "FEIL: Klarte ikke sette registry-mirror / restarte Docker på host." >&2
fi
stty sane 2>/dev/null || true

if [[ "$REGISTRY_MIRROR_OK" -eq 1 ]]; then
  echo "Venter på at Docker blir aktiv igjen (hvert 2. s, maks ~3 min) …"
  _docker_up=0
  for _i in $(seq 1 90); do
    sleep 2
    if ssh -o ConnectTimeout=8 "${SERVER_USER}@${SERVER_HOST}" "systemctl is-active docker >/dev/null 2>&1"; then
      echo "Docker er aktiv igjen."
      _docker_up=1
      break
    fi
  done
  if [[ "$_docker_up" -ne 1 ]]; then
    echo "ADVARSEL: Docker ble ikke aktiv innen tidsavbrudd." >&2
    REGISTRY_MIRROR_OK=0
  fi
fi

echo "== Laster opp generated .env =="
rsync -az --omit-dir-times --no-times --no-perms --no-owner --no-group "$TMP_ENV" "${SERVER_USER}@${SERVER_HOST}:${REMOTE_INFRA_DIR}/.env"

echo "== Starter stack (docker compose) =="
ssh "${SERVER_USER}@${SERVER_HOST}" "docker network create webserverpanel-net >/dev/null 2>&1 || true && cd '${REMOTE_INFRA_DIR}' && docker compose up -d --build"

echo "== Oppretter agent route i Traefik dynamic volume =="
ssh "${SERVER_USER}@${SERVER_HOST}" "docker run --rm -v webserverpanel_traefik-dynamic:/dynamic alpine sh -c 'cat > /dynamic/agent.yml << \"EOF\"
http:
  routers:
    agent:
      rule: Host(\`${AGENT_HOST}\`)
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
      service: agent
  services:
    agent:
      loadBalancer:
        servers:
          - url: http://agent:2080
EOF'"

echo "== Verifiserer tjenester =="
ssh "${SERVER_USER}@${SERVER_HOST}" "cd '${REMOTE_INFRA_DIR}' && docker compose ps"

if ask_yes_no "Installere daglig auto-cleanup timer nå?" "y" "INSTALL_CLEANUP_TIMER"; then
  echo "== Installerer agent-cleanup timer =="
  if ! NODE_PACKAGE_ROOT="$NODE_PACKAGE_ROOT" SERVER_HOST="$SERVER_HOST" SERVER_USER="$SERVER_USER" REMOTE_ROOT="$REMOTE_ROOT" \
    "${BUNDLE_SCRIPTS_DIR}/install-agent-cleanup-timer-remote.sh"; then
    echo "Advarsel: klarte ikke installere cleanup-timer automatisk."
    echo "Kjør manuelt senere:"
    echo "  SERVER_HOST=${SERVER_HOST} SERVER_USER=${SERVER_USER} REMOTE_ROOT=${REMOTE_ROOT} ${BUNDLE_SCRIPTS_DIR}/install-agent-cleanup-timer-remote.sh"
  fi
fi

echo
echo "Ferdig."
echo "Agent health URL: https://${AGENT_HOST}/health"
echo "Sett i dashboard .env.local:"
echo "  AGENT_URL=https://${AGENT_HOST}"
echo "  AGENT_SECRET=${AGENT_SECRET}"
