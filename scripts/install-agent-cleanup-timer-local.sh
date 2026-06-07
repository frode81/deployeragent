#!/usr/bin/env bash
# Installer cleanup-timer på samme maskin (ingen SSH).

set -euo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/deploy/skybygger}"
SERVER_USER="${SERVER_USER:-deploy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "==> Installerer cleanup-timer lokalt"
chmod +x "${SCRIPT_DIR}/cleanup-agent-server.sh" \
  "${SCRIPT_DIR}/cleanup-agent-server-smart.sh" \
  "${SCRIPT_DIR}/cleanup-agent-server-remote.sh"

sed "s|/home/deploy/skybygger|${REMOTE_ROOT}|g; s|^User=deploy|User=${SERVER_USER}|" \
  "${NODE_SCRIPTS_DIR}/systemd/agent-cleanup.service" >/tmp/agent-cleanup.service

if [ "$(id -u)" -eq 0 ]; then
  install -m 0644 /tmp/agent-cleanup.service /etc/systemd/system/agent-cleanup.service
  install -m 0644 "${NODE_SCRIPTS_DIR}/systemd/agent-cleanup.timer" /etc/systemd/system/agent-cleanup.timer
  systemctl daemon-reload
  systemctl enable --now agent-cleanup.timer
  systemctl status --no-pager agent-cleanup.timer
else
  sudo install -m 0644 /tmp/agent-cleanup.service /etc/systemd/system/agent-cleanup.service
  sudo install -m 0644 "${NODE_SCRIPTS_DIR}/systemd/agent-cleanup.timer" /etc/systemd/system/agent-cleanup.timer
  sudo systemctl daemon-reload
  sudo systemctl enable --now agent-cleanup.timer
  sudo systemctl status --no-pager agent-cleanup.timer
fi

echo "==> Ferdig. Timer er aktiv."
