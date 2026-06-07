#!/usr/bin/env bash
# Grunnleggende server-hardening for agent-noder (UFW, sikkerhetsoppdateringer, valgfri SSH).

hardening_enabled() {
  case "${INSTALL_HARDEN:-y}" in
    n|N|0|no|NO|false|FALSE) return 1 ;;
    *) return 0 ;;
  esac
}

ssh_hardening_enabled() {
  case "${INSTALL_HARDEN_SSH:-}" in
    y|Y|1|yes|YES|true|TRUE) return 0 ;;
    *) return 1 ;;
  esac
}

_harden_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  else
    SUDO="sudo"
    if ! $SUDO -n true >/dev/null 2>&1; then
      echo "[harden] Krever root — hardening hoppet over." >&2
      return 1
    fi
  fi
  return 0
}

_configure_ufw() {
  echo "[harden] Konfigurerer UFW (22, 80, 443) …"
  export DEBIAN_FRONTEND=noninteractive
  if ! command -v ufw >/dev/null 2>&1; then
    $SUDO apt-get update -qq
    $SUDO apt-get install -y ufw
  fi

  $SUDO ufw default deny incoming >/dev/null 2>&1 || true
  $SUDO ufw default allow outgoing >/dev/null 2>&1 || true
  $SUDO ufw allow 22/tcp comment 'deployer-ssh' >/dev/null 2>&1 || $SUDO ufw allow 22/tcp >/dev/null
  $SUDO ufw allow 80/tcp comment 'deployer-http' >/dev/null 2>&1 || $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp comment 'deployer-https' >/dev/null 2>&1 || $SUDO ufw allow 443/tcp >/dev/null

  if $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    echo "[harden] UFW er allerede aktiv"
  else
    echo "[harden] Aktiverer UFW …"
    $SUDO ufw --force enable >/dev/null
  fi
  $SUDO ufw status verbose | head -n 20 || true
}

_configure_unattended_upgrades() {
  echo "[harden] Sikkerhetsoppdateringer (unattended-upgrades) …"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get install -y unattended-upgrades apt-listchanges >/dev/null 2>&1 || \
    $SUDO apt-get install -y unattended-upgrades >/dev/null

  if [ -d /etc/apt/apt.conf.d ]; then
    $SUDO tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
  fi

  if [ -f /etc/apt/apt.conf.d/50unattended-upgrades ]; then
    if ! $SUDO grep -q '"${distro_id}:${distro_codename}-security"' /etc/apt/apt.conf.d/50unattended-upgrades 2>/dev/null; then
      echo "[harden] Advarsel: sjekk /etc/apt/apt.conf.d/50unattended-upgrades manuelt." >&2
    fi
  fi
  echo "[harden] unattended-upgrades aktivert"
}

_configure_ssh_hardening() {
  local deploy_user="$1"
  local deploy_home auth_file

  deploy_home="$($SUDO getent passwd "$deploy_user" | cut -d: -f6)"
  auth_file="${deploy_home}/.ssh/authorized_keys"

  if ! $SUDO test -s "$auth_file" 2>/dev/null; then
    echo "[harden] SSH-hardening hoppet over: ${deploy_user} mangler authorized_keys." >&2
    echo "[harden] Sett INSTALL_HARDEN_SSH=y etter at nøkler er på plass." >&2
    return 0
  fi

  echo "[harden] SSH-hardening (drop-in) …"
  $SUDO mkdir -p /etc/ssh/sshd_config.d
  $SUDO tee /etc/ssh/sshd_config.d/99-deployer-hardening.conf >/dev/null <<EOF
# Webserver Panel node-install (${deploy_user})
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF

  if $SUDO sshd -t 2>/dev/null; then
    $SUDO systemctl reload ssh 2>/dev/null || $SUDO systemctl reload sshd 2>/dev/null || true
    echo "[harden] SSH oppdatert — bruk ${deploy_user}@<server> fremover"
  else
    echo "[harden] Advarsel: sshd -t feilet — drop-in fjernes igjen." >&2
    $SUDO rm -f /etc/ssh/sshd_config.d/99-deployer-hardening.conf
  fi
}

# Grunnleggende hardening. Krever root (typisk under curl | bash som root).
harden_server() {
  local deploy_user="${1:-deploy}"

  if ! hardening_enabled; then
    echo "[harden] Hoppet over (INSTALL_HARDEN=n)."
    return 0
  fi

  if ! _harden_sudo; then
    return 0
  fi

  echo "[harden] Starter sikkerhets-hardening …"
  _configure_ufw
  _configure_unattended_upgrades

  if ssh_hardening_enabled; then
    _configure_ssh_hardening "$deploy_user"
  else
    echo "[harden] SSH-hardening ikke aktivert (sett INSTALL_HARDEN_SSH=y for å slå på)."
  fi

  echo "[harden] Ferdig"
}

remote_harden_server() {
  local bootstrap_user="$1"
  local deploy_user="$2"
  local host="$3"

  if ! hardening_enabled; then
    return 0
  fi

  echo "== Sikkerhets-hardening på ${bootstrap_user}@${host} =="
  if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "${bootstrap_user}@${host}" "echo ok" >/dev/null 2>&1; then
    echo "Advarsel: klarte ikke SSH som ${bootstrap_user} — hardening hoppet over." >&2
    return 0
  fi

  ssh -tt "${bootstrap_user}@${host}" "bash -s" <<REMOTE_HARDEN
set -euo pipefail
$(declare -f harden_server hardening_enabled ssh_hardening_enabled _harden_sudo _configure_ufw _configure_unattended_upgrades _configure_ssh_hardening)
INSTALL_HARDEN=${INSTALL_HARDEN:-y}
INSTALL_HARDEN_SSH=${INSTALL_HARDEN_SSH:-}
harden_server $(printf '%q' "$deploy_user")
REMOTE_HARDEN
  stty sane 2>/dev/null || true
}
