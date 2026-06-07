#!/usr/bin/env bash
#
# Bootstrap for node-installasjon. Kan kjøres direkte fra repo eller via curl:
#
#   curl -fsSL https://raw.githubusercontent.com/webserverpanel/webserverpanel-node/main/install.sh | bash
#
# Med miljøvariabler (ikke-interaktivt):
#
#   SERVER_HOST=1.2.3.4 BASE_DOMAIN=apps.example.com AGENT_SECRET=... \
#     INSTALL_CONFIRM=y INSTALL_CLEANUP_TIMER=y \
#     curl -fsSL .../install.sh | bash
#
set -euo pipefail

: "${NODE_INSTALL_REPO:=https://github.com/webserverpanel/webserverpanel-node.git}"
: "${NODE_INSTALL_REF:=main}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "${SCRIPT_DIR}/scripts/install-node.sh" ]; then
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

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "== Henter webserverpanel-node fra GitHub =="
echo "Repo: ${NODE_INSTALL_REPO} @ ${NODE_INSTALL_REF}"
git clone --depth 1 --branch "$NODE_INSTALL_REF" "$NODE_INSTALL_REPO" "${TMPDIR}/bundle"

exec bash "${TMPDIR}/bundle/scripts/install-node.sh" "$@"
