#!/usr/bin/env bash

set -euo pipefail

NODE_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVER_HOST="${SERVER_HOST:-204.168.157.12}"
SERVER_USER="${SERVER_USER:-deploy}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/deploy/skybygger}"

echo "==> Synker cleanup scripts til server"
rsync -az \
  "${SCRIPT_DIR}/cleanup-agent-server.sh" \
  "${SCRIPT_DIR}/cleanup-agent-server-smart.sh" \
  "${SCRIPT_DIR}/cleanup-agent-server-remote.sh" \
  "${SERVER_USER}@${SERVER_HOST}:${REMOTE_ROOT}/scripts/"

echo "==> Synker systemd unit-filer til temp"
rsync -az \
  "${SCRIPT_DIR}/systemd/agent-cleanup.service" \
  "${SCRIPT_DIR}/systemd/agent-cleanup.timer" \
  "${SERVER_USER}@${SERVER_HOST}:/tmp/"

echo "==> Installerer timer på server (krever sudo-passord)"
ssh -t "${SERVER_USER}@${SERVER_HOST}" "sudo install -m 0644 /tmp/agent-cleanup.service /etc/systemd/system/agent-cleanup.service && sudo install -m 0644 /tmp/agent-cleanup.timer /etc/systemd/system/agent-cleanup.timer && sudo systemctl daemon-reload && sudo systemctl enable --now agent-cleanup.timer && sudo systemctl status --no-pager agent-cleanup.timer"

echo "==> Ferdig. Timer er aktiv."
