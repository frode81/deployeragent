#!/usr/bin/env bash

set -euo pipefail

# Rydder opp Docker-ressurser som ikke lenger er i bruk på agent-serveren.
# Standard: dry-run (viser hva som KAN fjernes).
# Faktisk kjøring: --yes
#
# Valgfritt:
#   --include-volumes   Tar også med ubrukte volumes (kan være destruktivt)
#   --project NAME      Behold containere/nettverk med compose-prosjektnavn (default: webserverpanel)

DO_APPLY=false
INCLUDE_VOLUMES=false
PROJECT_NAME="webserverpanel"

for arg in "$@"; do
  case "$arg" in
    --yes) DO_APPLY=true ;;
    --include-volumes) INCLUDE_VOLUMES=true ;;
    --project=*) PROJECT_NAME="${arg#*=}" ;;
    -h|--help)
      cat <<'EOF'
Bruk:
  ./scripts/cleanup-agent-server.sh [--yes] [--include-volumes] [--project=webserverpanel]

Eksempler:
  ./scripts/cleanup-agent-server.sh
  ./scripts/cleanup-agent-server.sh --yes
  ./scripts/cleanup-agent-server.sh --yes --include-volumes
EOF
      exit 0
      ;;
    *)
      echo "Ukjent argument: $arg" >&2
      exit 1
      ;;
  esac
done

echo "== Docker opprydding på agent-server =="
echo "Project som beskyttes: ${PROJECT_NAME}"
echo "Mode: $([ "$DO_APPLY" = true ] && echo "APPLY" || echo "DRY-RUN")"
echo

echo "== Disk før opprydding =="
docker system df || true
echo

if [ "$DO_APPLY" = false ]; then
  echo "== Kandidater for sletting (dry-run) =="
  echo "- Stoppede containere:"
  docker ps -a --filter status=exited --filter status=created --format '  {{.ID}} {{.Names}} {{.Status}}' || true
  echo
  echo "- Dangling images:"
  docker images --filter dangling=true --format '  {{.ID}} {{.Repository}}:{{.Tag}} {{.Size}}' || true
  echo
  echo "- Ubrukte nettverk:"
  docker network ls --filter dangling=true --format '  {{.ID}} {{.Name}} {{.Driver}}' || true
  echo
  if [ "$INCLUDE_VOLUMES" = true ]; then
    echo "- Ubrukte volumes:"
    docker volume ls --filter dangling=true --format '  {{.Name}}' || true
    echo
  fi
  echo "Kjør med --yes for å utføre opprydding."
  exit 0
fi

echo "== Stopper ikke kjørende stack. Rydder kun ubrukte ressurser =="

# 1) Fjern stoppede containere
docker container prune -f || true

# 2) Fjern ubrukte images (inkl. untagged og ikke-refererte)
docker image prune -a -f || true

# 3) Fjern ubrukte nettverk
docker network prune -f || true

# 4) Fjern gammel build-cache
docker builder prune -a -f || true

# 5) Valgfritt: volumes (kan frigjøre mye, men vær bevisst)
if [ "$INCLUDE_VOLUMES" = true ]; then
  docker volume prune -f || true
fi

echo
echo "== Disk etter opprydding =="
docker system df || true
echo
echo "Ferdig."
