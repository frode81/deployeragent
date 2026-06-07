#!/usr/bin/env bash
# Løser hvor installasjonspakken (agent + infrastructure + scripts) hentes fra.

# node/scripts/lib -> node/
NODE_PACKAGE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Standard GitHub-repo (publiser innholdet av node/ + agent/ via prepare-standalone.sh)
: "${NODE_INSTALL_REPO:=https://github.com/webserverpanel/webserverpanel-node.git}"
: "${NODE_INSTALL_REF:=main}"
: "${NODE_INSTALL_SOURCE:=auto}"

_BUNDLE_TMPDIR=""
_BUNDLE_CLEANUP=false

cleanup_bundle() {
  if [ "$_BUNDLE_CLEANUP" = true ] && [ -n "$_BUNDLE_TMPDIR" ] && [ -d "$_BUNDLE_TMPDIR" ]; then
    rm -rf "$_BUNDLE_TMPDIR"
  fi
}

is_local_monorepo_bundle() {
  [ -d "${NODE_PACKAGE_ROOT}/../agent" ] && [ -d "${NODE_PACKAGE_ROOT}/../infrastructure" ]
}

is_standalone_bundle() {
  [ -d "${NODE_PACKAGE_ROOT}/agent" ] && [ -d "${NODE_PACKAGE_ROOT}/infrastructure" ]
}

resolve_node_bundle() {
  local source="$NODE_INSTALL_SOURCE"

  if [ "$source" = "auto" ]; then
    if is_standalone_bundle; then
      source="standalone"
    elif is_local_monorepo_bundle; then
      source="monorepo"
    else
      source="github"
    fi
  fi

  case "$source" in
    standalone)
      BUNDLE_ROOT="$NODE_PACKAGE_ROOT"
      BUNDLE_AGENT_DIR="${BUNDLE_ROOT}/agent"
      BUNDLE_INFRA_DIR="${BUNDLE_ROOT}/infrastructure"
      BUNDLE_SCRIPTS_DIR="${BUNDLE_ROOT}/scripts"
      echo "Bruker lokal node-pakke: ${BUNDLE_ROOT}"
      ;;
    monorepo)
      BUNDLE_ROOT="$(cd "${NODE_PACKAGE_ROOT}/.." && pwd)"
      BUNDLE_AGENT_DIR="${BUNDLE_ROOT}/agent"
      BUNDLE_INFRA_DIR="${BUNDLE_ROOT}/infrastructure"
      BUNDLE_SCRIPTS_DIR="${NODE_PACKAGE_ROOT}/scripts"
      echo "Bruker monorepo lokalt: ${BUNDLE_ROOT}"
      ;;
    github)
      require_cmd git
      _BUNDLE_TMPDIR="$(mktemp -d)"
      _BUNDLE_CLEANUP=true
      trap cleanup_bundle EXIT
      echo "Henter node-pakke fra ${NODE_INSTALL_REPO} (${NODE_INSTALL_REF}) …"
      if ! git clone --depth 1 --branch "$NODE_INSTALL_REF" "$NODE_INSTALL_REPO" "$_BUNDLE_TMPDIR/bundle" 2>/dev/null; then
        echo "Klarte ikke clone ${NODE_INSTALL_REPO}. Sjekk NODE_INSTALL_REPO / NODE_INSTALL_REF." >&2
        exit 1
      fi
      BUNDLE_ROOT="${_BUNDLE_TMPDIR}/bundle"
      if [ ! -d "${BUNDLE_ROOT}/agent" ] || [ ! -d "${BUNDLE_ROOT}/infrastructure" ]; then
        echo "Repo mangler agent/ eller infrastructure/. Kjør prepare-standalone.sh før publisering." >&2
        exit 1
      fi
      BUNDLE_AGENT_DIR="${BUNDLE_ROOT}/agent"
      BUNDLE_INFRA_DIR="${BUNDLE_ROOT}/infrastructure"
      BUNDLE_SCRIPTS_DIR="${BUNDLE_ROOT}/scripts"
      echo "Pakke hentet til ${BUNDLE_ROOT}"
      ;;
    *)
      echo "Ukjent NODE_INSTALL_SOURCE: ${source} (forventet auto, standalone, monorepo, github)" >&2
      exit 1
      ;;
  esac

  for dir in "$BUNDLE_AGENT_DIR" "$BUNDLE_INFRA_DIR" "$BUNDLE_SCRIPTS_DIR"; do
    if [ ! -d "$dir" ]; then
      echo "Mangler mappe i pakke: $dir" >&2
      exit 1
    fi
  done
}
