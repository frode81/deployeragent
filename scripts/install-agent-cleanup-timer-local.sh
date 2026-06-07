#!/usr/bin/env bash
# Installer cleanup-timer på samme maskin (ingen SSH).

set -euo pipefail

REMOTE_ROOT="${REMOTE_ROOT:-/home/deploy/skybygger}"
SERVER_USER="${SERVER_USER:-deploy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Installerer cleanup-timer lokalt"
chmod +x "${SCRIPT_DIR}/cleanup-agent-server.sh" \
  "${SCRIPT_DIR}/cleanup-agent-server-smart.sh" \
  "${SCRIPT_DIR}/cleanup-agent-server-remote.sh" \
  "${SCRIPT_DIR}/install-agent-cleanup-timer-local.sh" 2>/dev/null || true

SYSTEMD_DIR="${SCRIPT_DIR}/systemd"
if [ ! -f "${SYSTEMD_DIR}/agent-cleanup.service" ]; then
  echo "FEIL: mangler ${SYSTEMD_DIR}/agent-cleanup.service" >&2
  echo "Kjør install på nytt, eller kopier scripts/systemd/ manuelt." >&2
  exit 1
fi

sed "s|/home/deploy/skybygger|${REMOTE_ROOT}|g; s|^User=deploy|User=${SERVER_USER}|" \
  "${SYSTEMD_DIR}/agent-cleanup.service" >/tmp/agent-cleanup.service

if [ "$(id -u)" -eq 0 ]; then
  install -m 0644 /tmp/agent-cleanup.service /etc/systemd/system/agent-cleanup.service
  install -m 0644 "${SYSTEMD_DIR}/agent-cleanup.timer" /etc/systemd/system/agent-cleanup.timer
  systemctl daemon-reload
  systemctl enable --now agent-cleanup.timer
  systemctl status --no-pager agent-cleanup.timer
else
  sudo install -m 0644 /tmp/agent-cleanup.service /etc/systemd/system/agent-cleanup.service
  sudo install -m 0644 "${SYSTEMD_DIR}/agent-cleanup.timer" /etc/systemd/system/agent-cleanup.timer
  sudo systemctl daemon-reload
  sudo systemctl enable --now agent-cleanup.timer
  sudo systemctl status --no-pager agent-cleanup.timer
fi

echo "==> Ferdig. Timer er aktiv."
