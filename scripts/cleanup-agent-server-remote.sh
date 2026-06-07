#!/usr/bin/env bash

set -euo pipefail

# Kjører cleanup-script på agent-server over SSH.
# Standard: dry-run.
#
# Eksempler:
#   ./scripts/cleanup-agent-server-remote.sh
#   ./scripts/cleanup-agent-server-remote.sh --yes
#   SERVER_HOST=1.2.3.4 SERVER_USER=deploy ./scripts/cleanup-agent-server-remote.sh --yes

SERVER_HOST="${SERVER_HOST:-204.168.157.12}"
SERVER_USER="${SERVER_USER:-deploy}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/deploy/skybygger}"
REMOTE_SCRIPT="${REMOTE_ROOT}/scripts/cleanup-agent-server.sh"

LOCAL_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cleanup-agent-server.sh"

echo "==> Laster opp cleanup-script til ${SERVER_USER}@${SERVER_HOST}:${REMOTE_SCRIPT}"
ssh "${SERVER_USER}@${SERVER_HOST}" "mkdir -p '${REMOTE_ROOT}/scripts'"
rsync -az "${LOCAL_SCRIPT}" "${SERVER_USER}@${SERVER_HOST}:${REMOTE_SCRIPT}"

echo "==> Kjører remote cleanup via SSH"
ssh -t "${SERVER_USER}@${SERVER_HOST}" "bash '${REMOTE_SCRIPT}' $*"
