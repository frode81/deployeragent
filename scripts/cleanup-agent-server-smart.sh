#!/usr/bin/env bash

set -euo pipefail

# Smart opprydding:
# - Kjør trygg opprydding alltid
# - Kjør ekstra opprydding (volumes) kun hvis diskbruk >= terskel
#
# Parametre:
#   --yes                 Utfør opprydding (uten denne blir det dry-run)
#   --threshold=80        Terskel i prosent for aggressiv opprydding
#   --path=/              Disk-path som måles
#   --force-volumes       Tving volumes-opprydding uansett terskel (krever --yes)

DO_APPLY=false
THRESHOLD=80
CHECK_PATH="/"
FORCE_VOLUMES=false

for arg in "$@"; do
  case "$arg" in
    --yes) DO_APPLY=true ;;
    --threshold=*) THRESHOLD="${arg#*=}" ;;
    --path=*) CHECK_PATH="${arg#*=}" ;;
    --force-volumes) FORCE_VOLUMES=true ;;
    -h|--help)
      cat <<'EOF'
Bruk:
  ./scripts/cleanup-agent-server-smart.sh [--yes] [--threshold=80] [--path=/] [--force-volumes]

Eksempler:
  ./scripts/cleanup-agent-server-smart.sh
  ./scripts/cleanup-agent-server-smart.sh --yes
  ./scripts/cleanup-agent-server-smart.sh --yes --threshold=85
EOF
      exit 0
      ;;
    *)
      echo "Ukjent argument: $arg" >&2
      exit 1
      ;;
  esac
done

if ! [[ "$THRESHOLD" =~ ^[0-9]+$ ]] || [ "$THRESHOLD" -lt 1 ] || [ "$THRESHOLD" -gt 99 ]; then
  echo "Ugyldig threshold: $THRESHOLD (forventet 1-99)" >&2
  exit 1
fi

DISK_PCT="$(df -P "$CHECK_PATH" | awk 'NR==2 {gsub("%","",$5); print $5}')"
if ! [[ "$DISK_PCT" =~ ^[0-9]+$ ]]; then
  echo "Klarte ikke lese diskbruk for $CHECK_PATH" >&2
  exit 1
fi

echo "== Smart cleanup =="
echo "Path: $CHECK_PATH"
echo "Diskbruk nå: ${DISK_PCT}%"
echo "Terskel: ${THRESHOLD}%"
echo

if [ "$DO_APPLY" = false ]; then
  echo "Dry-run:"
  echo "- Standard opprydding: ville kjørt"
  if [ "$DISK_PCT" -ge "$THRESHOLD" ] || [ "$FORCE_VOLUMES" = true ]; then
    echo "- Aggressiv opprydding: volumes ville blitt tatt med"
  else
    echo "- Aggressiv opprydding: volumes ville IKKE blitt tatt med"
  fi
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_SCRIPT="${SCRIPT_DIR}/cleanup-agent-server.sh"

if [ ! -x "$BASE_SCRIPT" ]; then
  echo "Fant ikke kjørbart cleanup-script: $BASE_SCRIPT" >&2
  exit 1
fi

if [ "$FORCE_VOLUMES" = true ] || [ "$DISK_PCT" -ge "$THRESHOLD" ]; then
  echo "Kjører aggressiv opprydding (inkl. volumes)..."
  exec "$BASE_SCRIPT" --yes --include-volumes
else
  echo "Kjører standard opprydding..."
  exec "$BASE_SCRIPT" --yes
fi

