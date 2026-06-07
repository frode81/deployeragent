#!/usr/bin/env bash

set -euo pipefail

NODE_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/fetch-bundle.sh
source "${NODE_PACKAGE_ROOT}/scripts/lib/fetch-bundle.sh"

SERVER_HOST="${SERVER_HOST:-204.168.157.12}"
SERVER_USER="${SERVER_USER:-deploy}"
REMOTE_ROOT="${REMOTE_ROOT:-/home/deploy/skybygger}"
REMOTE_AGENT_DIR="${REMOTE_ROOT}/agent"
REMOTE_INFRA_DIR="${REMOTE_ROOT}/infrastructure"

resolve_node_bundle

echo "==> Synker agent-kode til ${SERVER_USER}@${SERVER_HOST}:${REMOTE_AGENT_DIR}"
rsync -az --delete \
  --exclude "node_modules" \
  --exclude ".git" \
  "${BUNDLE_AGENT_DIR}/" \
  "${SERVER_USER}@${SERVER_HOST}:${REMOTE_AGENT_DIR}/"

echo "==> Bygger og restarter agent-container på server"
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "cd '${REMOTE_INFRA_DIR}' && docker compose build agent && docker compose up -d --force-recreate agent"

echo "==> Ferdig"
