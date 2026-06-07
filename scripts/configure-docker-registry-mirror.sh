#!/usr/bin/env bash
#
# Setter Docker Hub-speilet som anbefalt av Devtron (Google Container Registry-speil):
#   {"registry-mirrors": ["https://mirror.gcr.io"]}
# Se: https://devtron.ai/blog/dodging-docker-hub-rate-limits-the-ultimate-cheat-code-for-your-ci-cd-pipeline/
#
# Oppførsel:
# - Mangler eller tom /etc/docker/daemon.json → skrives effektivt over med overnevnte speil (JSON kan være pretty-printed).
# - Finnes annen gyldig JSON → bevarer øvrige nøkler; registry-mirrors sammenslås med https://mirror.gcr.io først
#   (speil sjekkes i rekkefølge, jf. bloggen).
#
# Krever root (sudo).

set -euo pipefail

# Eksakt speil-URL som i artikkelen (med https://).
MIRROR="https://mirror.gcr.io"
DAEMON_JSON="/etc/docker/daemon.json"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Kjør med sudo: sudo $0" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FEIL: python3 mangler. Installer f.eks.: sudo apt-get install -y python3-minimal" >&2
  exit 1
fi

mkdir -p /etc/docker

if [[ -f "$DAEMON_JSON" ]]; then
  cp -a "$DAEMON_JSON" "${DAEMON_JSON}.bak.$(date +%Y%m%d%H%M%S)"
fi

export DAEMON_JSON MIRROR
python3 <<'PY'
import json, os, pathlib, sys

path = pathlib.Path(os.environ["DAEMON_JSON"])
mirror = os.environ["MIRROR"]


def is_gcr_mirror(u: str) -> bool:
    s = str(u).strip().rstrip("/")
    return s in (
        "mirror.gcr.io",
        "http://mirror.gcr.io",
        "https://mirror.gcr.io",
    )


def merge_mirrors(existing: list) -> list:
    rest = [m for m in existing if not is_gcr_mirror(m)]
    return [mirror] + rest


data: dict = {}

if path.exists() and path.read_text().strip():
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        print(
            f"FEIL: {path} er ikke gyldig JSON ({e}). "
            "Fiks eller flytt fila, kjør scriptet på nytt.",
            file=sys.stderr,
        )
        sys.exit(1)
    raw = data.get("registry-mirrors") or []
    if not isinstance(raw, list):
        print("FEIL: registry-mirrors er ikke en liste — fiks daemon.json manuelt.", file=sys.stderr)
        sys.exit(1)
    merged = merge_mirrors(raw)
    if merged == raw and raw and raw[0] == mirror:
        print(f"Allerede konfigurert med {mirror} først i registry-mirrors — ingen endring.")
        sys.exit(0)
    data["registry-mirrors"] = merged
else:
    # Tom eller manglende fil: samme innhold som i bloggen (pretty-print for lesbarhet).
    data = {"registry-mirrors": [mirror]}

path.write_text(json.dumps(data, indent=2) + "\n")
print(f"Lagret {path} med registry-mirrors der {mirror!r} er først (jf. Devtron-bloggen).")
PY
