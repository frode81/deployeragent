#!/usr/bin/env bash
#
# Kjør på serveren (anbefalt):
#
#   curl -fsSL https://raw.githubusercontent.com/frode81/deployeragent/refs/heads/main/install.sh | bash
#
# Eller fra lokal maskin mot annen server (remote/SSH):
#
#   SERVER_HOST=1.2.3.4 INSTALL_MODE=remote \
#     curl -fsSL .../install.sh | bash
#
# Ikke-interaktivt på server:
#
#   BASE_DOMAIN=apps.example.com ACME_EMAIL=you@example.com \
#     AGENT_SECRET=... INSTALL_CONFIRM=y INSTALL_CLEANUP_TIMER=y \
#     curl -fsSL .../install.sh | bash
#
NODE_INSTALL_RAW_URL="${NODE_INSTALL_RAW_URL:-https://raw.githubusercontent.com/frode81/deployeragent/refs/heads/main/install.sh}"

# curl | bash sender scriptet på stdin — da fungerer ikke read/prompt.
# Last ned til fil og kjør på nytt med terminal som stdin.
if [ ! -t 0 ] && [ -z "${NODE_INSTALL_REEXECED:-}" ]; then
  export NODE_INSTALL_REEXECED=1
  _tmp="$(mktemp /tmp/deployeragent-install.XXXXXX.sh)"
  if ! curl -fsSL "$NODE_INSTALL_RAW_URL" -o "$_tmp"; then
    echo "Klarte ikke hente install.sh fra ${NODE_INSTALL_RAW_URL}" >&2
    exit 1
  fi
  chmod +x "$_tmp"
  exec bash "$_tmp" "$@"
fi

set -euo pipefail

: "${NODE_INSTALL_REPO:=https://github.com/frode81/deployeragent.git}"
: "${NODE_INSTALL_REF:=main}"

SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "${SCRIPT_DIR}/scripts/install-node.sh" ]; then
  exec bash "${SCRIPT_DIR}/scripts/install-node.sh" "$@"
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Mangler kommando: $1" >&2
    exit 1
  }
}

require_cmd git
require_cmd bash
require_cmd curl

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "== Henter deployeragent fra GitHub =="
echo "Repo: ${NODE_INSTALL_REPO} @ ${NODE_INSTALL_REF}"
git clone --depth 1 --branch "$NODE_INSTALL_REF" "$NODE_INSTALL_REPO" "${TMPDIR}/bundle"

exec bash "${TMPDIR}/bundle/scripts/install-node.sh" "$@"
