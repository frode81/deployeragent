#!/usr/bin/env bash
# Felles hjelpefunksjoner for node-installasjon.

_tty_in() {
  if [ -r /dev/tty ] 2>/dev/null; then
    echo "/dev/tty"
  else
    echo "/dev/stdin"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Mangler kommando: $1" >&2
    exit 1
  }
}

prompt() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local value
  local tty_in
  tty_in="$(_tty_in)"
  if [ -n "$default_value" ]; then
    read -r -p "${label} [${default_value}]: " value <"$tty_in"
    value="${value:-$default_value}"
  else
    read -r -p "${label}: " value <"$tty_in"
  fi
  printf -v "$var_name" '%s' "$value"
}

prompt_secret() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  local value
  local tty_in
  tty_in="$(_tty_in)"
  if [ -n "$default_value" ]; then
    read -r -s -p "${label} [skjult, Enter for default]: " value <"$tty_in"
    echo
    value="${value:-$default_value}"
  else
    read -r -s -p "${label}: " value <"$tty_in"
    echo
  fi
  printf -v "$var_name" '%s' "$value"
}

prompt_or_env() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  if [ -n "${!var_name:-}" ]; then
    return 0
  fi
  if [ -n "$default_value" ]; then
    prompt "$var_name" "$label" "$default_value"
  else
    prompt "$var_name" "$label"
  fi
}

prompt_secret_or_env() {
  local var_name="$1"
  local label="$2"
  local default_value="${3:-}"
  if [ -n "${!var_name:-}" ]; then
    return 0
  fi
  prompt_secret "$var_name" "$label" "$default_value"
}

ask_yes_no() {
  local label="$1"
  local default_value="${2:-y}"
  local env_name="${3:-}"
  if [ -n "$env_name" ] && [ -n "${!env_name:-}" ]; then
    case "${!env_name}" in
      [Yy]|[Yy][Ee][Ss]|1|true) return 0 ;;
      *) return 1 ;;
    esac
  fi
  local raw answer
  local tty_in
  tty_in="$(_tty_in)"
  read -r -p "${label} [y/n, default ${default_value}]: " raw <"$tty_in"
  answer="${raw:-$default_value}"
  [[ "$answer" =~ ^[Yy]$ ]]
}

print_remote_prereq_help() {
  cat <<'EOF'
Manglende forutsetninger på server. Kjør disse kommandoene på serveren:

# 1) Installer Docker + compose-plugin (Ubuntu)
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 2) Gi brukeren docker-tilgang (erstatt deploy ved behov)
sudo usermod -aG docker deploy
newgrp docker

# 3) Verifiser
docker --version
docker compose version
EOF
}

check_remote_prereqs() {
  local out
  if ! out="$(ssh -o BatchMode=yes "${SERVER_USER}@${SERVER_HOST}" 'set -e; command -v docker >/dev/null 2>&1 || echo "__MISSING_DOCKER__"; docker compose version >/dev/null 2>&1 || echo "__MISSING_COMPOSE__"; groups' 2>/dev/null)"; then
    echo "Klarte ikke koble til ${SERVER_USER}@${SERVER_HOST} via SSH." >&2
    echo "Sjekk SSH-tilgang først (ssh ${SERVER_USER}@${SERVER_HOST})." >&2
    exit 1
  fi

  local missing=false
  if grep -q "__MISSING_DOCKER__" <<<"$out"; then
    echo "Forutsetning mangler: docker er ikke installert på serveren."
    missing=true
  fi
  if grep -q "__MISSING_COMPOSE__" <<<"$out"; then
    echo "Forutsetning mangler: docker compose-plugin er ikke tilgjengelig."
    missing=true
  fi
  if ! grep -qw "docker" <<<"$out"; then
    echo "Advarsel: bruker ${SERVER_USER} ser ikke ut til å være i docker-gruppen."
    echo "Kjør bootstrap på nytt eller: sudo usermod -aG docker ${SERVER_USER}"
  fi

  if [ "$missing" = true ]; then
    echo
    echo "Kjør install-scriptet uten INSTALL_SKIP_BOOTSTRAP for automatisk oppsett,"
    echo "eller installer manuelt:"
    print_remote_prereq_help
    echo
    exit 1
  fi
}
