#!/usr/bin/env bash
#
# Kopierer agent/ inn i node/ slik at mappen kan publiseres som eget GitHub-repo.
# Kjør fra monorepo-roten: ./node/scripts/prepare-standalone.sh
#
set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_ROOT="${MONOREPO_ROOT}/node"
AGENT_SRC="${MONOREPO_ROOT}/agent"
INFRA_SRC="${MONOREPO_ROOT}/infrastructure"

echo "== Forbereder standalone node-pakke =="

if [ ! -d "$AGENT_SRC" ]; then
  echo "Mangler ${AGENT_SRC}" >&2
  exit 1
fi

echo "Synker agent/ -> node/agent/"
rsync -a --delete \
  --exclude "node_modules" \
  --exclude ".git" \
  --exclude "dist" \
  --exclude ".DS_Store" \
  "${AGENT_SRC}/" "${NODE_ROOT}/agent/"

echo "Synker infrastructure/ -> node/infrastructure/"
rsync -a --delete \
  --exclude ".env" \
  --exclude ".DS_Store" \
  "${INFRA_SRC}/" "${NODE_ROOT}/infrastructure/"

echo
echo "Ferdig. node/ er klar til å publiseres som eget repo:"
echo "  cd node && git init && git add . && git commit -m 'Release node installer'"
echo "  git remote add origin ${NODE_INSTALL_REPO:-https://github.com/frode81/deployeragent.git}"
echo "  git push -u origin main"
