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
set -euo pipefail

: "${NODE_INSTALL_REPO:=https://github.com/frode81/deployeragent.git}"
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

echo "== Henter deployeragent fra GitHub =="
echo "Repo: ${NODE_INSTALL_REPO} @ ${NODE_INSTALL_REF}"
git clone --depth 1 --branch "$NODE_INSTALL_REF" "$NODE_INSTALL_REPO" "${TMPDIR}/bundle"

exec bash "${TMPDIR}/bundle/scripts/install-node.sh" "$@"
