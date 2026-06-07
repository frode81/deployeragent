#!/usr/bin/env bash
# Bootstrap av fersk Ubuntu-server: deploy-bruker, Docker, mapper, SSH-nøkler.

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
    echo "Sjekk at du har nøkkelbasert innlogging (ssh ${bootstrap_user}@${host})." >&2
    exit 1
  fi

  ssh -tt "${bootstrap_user}@${host}" "DEPLOY_USER=$(printf '%q' "$deploy_user") REMOTE_ROOT=$(printf '%q' "$remote_root") bash -s" <<'REMOTE_BOOTSTRAP'
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:?}"
REMOTE_ROOT="${REMOTE_ROOT:?}"

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
  if ! $SUDO -n true >/dev/null 2>&1; then
    echo "Bootstrap krever root eller passordfri sudo for $(whoami)."
    exit 1
  fi
fi

echo "[bootstrap] Sjekker deploy-bruker …"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "[bootstrap] Oppretter bruker ${DEPLOY_USER}"
  $SUDO useradd -m -s /bin/bash "$DEPLOY_USER"
else
  echo "[bootstrap] Bruker ${DEPLOY_USER} finnes allerede"
fi

$SUDO usermod -aG sudo "$DEPLOY_USER" 2>/dev/null || true

echo "[bootstrap] Sjekker Docker …"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "[bootstrap] Installerer Docker (Ubuntu) …"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -qq
  $SUDO apt-get install -y ca-certificates curl gnupg lsb-release
  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  if [ ! -f /etc/apt/sources.list.d/docker.list ]; then
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
      | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
  fi
  $SUDO apt-get update -qq
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  $SUDO systemctl enable --now docker
else
  echo "[bootstrap] Docker er allerede installert"
fi

echo "[bootstrap] Gir ${DEPLOY_USER} tilgang til docker-gruppen …"
$SUDO usermod -aG docker "$DEPLOY_USER"

echo "[bootstrap] Oppretter mapper …"
$SUDO mkdir -p "${REMOTE_ROOT}/infrastructure" "${REMOTE_ROOT}/agent" "${REMOTE_ROOT}/scripts"
$SUDO chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${REMOTE_ROOT}"

echo "[bootstrap] Kopierer SSH-nøkler til ${DEPLOY_USER} (hvis mangler) …"
DEPLOY_HOME="$($SUDO getent passwd "$DEPLOY_USER" | cut -d: -f6)"
BOOTSTRAP_HOME="${HOME}"
AUTH_SRC=""
if [ -f "${BOOTSTRAP_HOME}/.ssh/authorized_keys" ]; then
  AUTH_SRC="${BOOTSTRAP_HOME}/.ssh/authorized_keys"
elif [ -f /root/.ssh/authorized_keys ] && [ "$(id -u)" -eq 0 ]; then
  AUTH_SRC="/root/.ssh/authorized_keys"
fi

if [ -n "$AUTH_SRC" ]; then
  if ! $SUDO test -s "${DEPLOY_HOME}/.ssh/authorized_keys" 2>/dev/null; then
    $SUDO mkdir -p "${DEPLOY_HOME}/.ssh"
    $SUDO cp "$AUTH_SRC" "${DEPLOY_HOME}/.ssh/authorized_keys"
    $SUDO chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh"
    $SUDO chmod 700 "${DEPLOY_HOME}/.ssh"
    $SUDO chmod 600 "${DEPLOY_HOME}/.ssh/authorized_keys"
    echo "[bootstrap] SSH-nøkler kopiert"
  else
    echo "[bootstrap] SSH-nøkler for ${DEPLOY_USER} finnes allerede"
  fi
else
  echo "[bootstrap] Ingen authorized_keys å kopiere — sett opp SSH for ${DEPLOY_USER} manuelt"
fi

echo "[bootstrap] Verifiserer …"
docker --version
docker compose version
echo "[bootstrap] Ferdig"
REMOTE_BOOTSTRAP

  stty sane 2>/dev/null || true

  echo "Venter på at ${deploy_user} får docker-gruppetilgang (gruppeendring kan ta et øyeblikk) …"
  sleep 2

  if ! remote_probe_deploy_ready "$deploy_user" "$host"; then
    echo "Advarsel: ${deploy_user} har ikke docker-tilgang ennå etter bootstrap." >&2
    echo "Prøv å logge ut/inn på serveren, eller kjør: sudo usermod -aG docker ${deploy_user}" >&2
    echo "Tester likevel videre …"
  fi
}

ensure_remote_ready() {
  local bootstrap_user="$1"
  local deploy_user="$2"
  local remote_root="$3"
  local host="$4"

  if [ "${INSTALL_SKIP_BOOTSTRAP:-}" = "y" ] || [ "${INSTALL_SKIP_BOOTSTRAP:-}" = "1" ]; then
    echo "Hopper over bootstrap (INSTALL_SKIP_BOOTSTRAP)."
    check_remote_prereqs
    return 0
  fi

  if remote_probe_deploy_ready "$deploy_user" "$host"; then
    echo "OK: ${deploy_user}@${host} har Docker og docker-gruppe — bootstrap hoppes over."
    return 0
  fi

  echo "Server trenger bootstrap (deploy-bruker og/eller Docker)."
  if [ "$bootstrap_user" = "$deploy_user" ]; then
    echo "Kjører bootstrap som ${bootstrap_user} …"
    run_remote_bootstrap "$bootstrap_user" "$deploy_user" "$remote_root" "$host"
    return 0
  fi

  if remote_probe_ssh "$bootstrap_user" "$host"; then
    run_remote_bootstrap "$bootstrap_user" "$deploy_user" "$remote_root" "$host"
    return 0
  fi

  echo "Klarte ikke koble til ${deploy_user}@${host} (mangler Docker) eller ${bootstrap_user}@${host} (bootstrap)." >&2
  echo "Sjekk SSH-nøkler. På fersk server: ssh ${bootstrap_user}@${host}" >&2
  exit 1
}
