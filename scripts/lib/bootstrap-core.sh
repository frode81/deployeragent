#!/usr/bin/env bash
# Bootstrap på denne maskinen: deploy-bruker, Docker, mapper, SSH-nøkler.

bootstrap_server() {
  local deploy_user="${1:?}"
  local remote_root="${2:?}"

  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  else
    SUDO="sudo"
    if ! $SUDO -n true >/dev/null 2>&1; then
      echo "Bootstrap krever root eller passordfri sudo for $(whoami)." >&2
      exit 1
    fi
  fi

  echo "[bootstrap] Sjekker deploy-bruker …"
  if ! id "$deploy_user" >/dev/null 2>&1; then
    echo "[bootstrap] Oppretter bruker ${deploy_user}"
    $SUDO useradd -m -s /bin/bash "$deploy_user"
  else
    echo "[bootstrap] Bruker ${deploy_user} finnes allerede"
  fi

  $SUDO usermod -aG sudo "$deploy_user" 2>/dev/null || true

  echo "[bootstrap] Sjekker Docker …"
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "[bootstrap] Installerer Docker (Ubuntu) …"
    export DEBIAN_FRONTEND=noninteractive
    $SUDO apt-get update -qq
    $SUDO apt-get install -y ca-certificates curl gnupg lsb-release rsync git
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

  echo "[bootstrap] Gir ${deploy_user} tilgang til docker-gruppen …"
  $SUDO usermod -aG docker "$deploy_user"

  echo "[bootstrap] Oppretter mapper …"
  $SUDO mkdir -p "${remote_root}/infrastructure" "${remote_root}/agent" "${remote_root}/scripts"
  $SUDO chown -R "${deploy_user}:${deploy_user}" "${remote_root}"

  if [ "$(whoami)" != "$deploy_user" ]; then
    echo "[bootstrap] Kopierer SSH-nøkler til ${deploy_user} (hvis mangler) …"
    local deploy_home
    deploy_home="$($SUDO getent passwd "$deploy_user" | cut -d: -f6)"
    local auth_src=""
    if [ -f "${HOME}/.ssh/authorized_keys" ]; then
      auth_src="${HOME}/.ssh/authorized_keys"
    elif [ -f /root/.ssh/authorized_keys ] && [ "$(id -u)" -eq 0 ]; then
      auth_src="/root/.ssh/authorized_keys"
    fi

    if [ -n "$auth_src" ]; then
      if ! $SUDO test -s "${deploy_home}/.ssh/authorized_keys" 2>/dev/null; then
        $SUDO mkdir -p "${deploy_home}/.ssh"
        $SUDO cp "$auth_src" "${deploy_home}/.ssh/authorized_keys"
        $SUDO chown -R "${deploy_user}:${deploy_user}" "${deploy_home}/.ssh"
        $SUDO chmod 700 "${deploy_home}/.ssh"
        $SUDO chmod 600 "${deploy_home}/.ssh/authorized_keys"
        echo "[bootstrap] SSH-nøkler kopiert"
      else
        echo "[bootstrap] SSH-nøkler for ${deploy_user} finnes allerede"
      fi
    else
      echo "[bootstrap] Ingen authorized_keys å kopiere"
    fi
  fi

  echo "[bootstrap] Verifiserer …"
  docker --version
  docker compose version
  echo "[bootstrap] Ferdig"
}

local_deploy_ready() {
  local deploy_user="$1"
  if [ "$(whoami)" = "$deploy_user" ]; then
    command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && groups | grep -qw docker
    return
  fi
  sudo -u "$deploy_user" bash -lc 'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && groups | grep -qw docker' 2>/dev/null
}

ensure_local_ready() {
  local deploy_user="$1"
  local remote_root="$2"

  if [ "${INSTALL_SKIP_BOOTSTRAP:-}" = "y" ] || [ "${INSTALL_SKIP_BOOTSTRAP:-}" = "1" ]; then
    echo "Hopper over bootstrap (INSTALL_SKIP_BOOTSTRAP)."
    return 0
  fi

  if local_deploy_ready "$deploy_user"; then
    echo "OK: ${deploy_user} har Docker og docker-gruppe — bootstrap hoppes over."
    return 0
  fi

  echo "== Bootstrap på denne serveren =="
  bootstrap_server "$deploy_user" "$remote_root"
  sleep 2

  if ! local_deploy_ready "$deploy_user"; then
    echo "Advarsel: ${deploy_user} har kanskje ikke docker-gruppe ennå. Prøver videre …" >&2
  fi
}

run_as_deploy() {
  local deploy_user="$1"
  shift
  local cmd="$*"
  if [ "$(whoami)" = "$deploy_user" ]; then
    bash -lc "$cmd"
  elif [ "$(id -u)" -eq 0 ]; then
    sudo -u "$deploy_user" bash -lc "$cmd"
  else
    sudo -u "$deploy_user" bash -lc "$cmd"
  fi
}

run_as_deploy_docker() {
  local deploy_user="$1"
  shift
  local cmd="$*"
  if [ "$(whoami)" = "$deploy_user" ]; then
    sg docker -c "$cmd"
  elif [ "$(id -u)" -eq 0 ]; then
    sudo -u "$deploy_user" sg docker -c "$cmd"
  else
    sudo -u "$deploy_user" sg docker -c "$cmd"
  fi
}
