# Webserver Panel — installasjon av ny node

**Relatert dokumentasjon:** [Arkitektur](../docs/architecture.md) · [Sikkerhet](../docs/security.md) · [Agent API](../agent/README.md)

Denne guiden setter opp en helt ny node for `Webserver Panel` med:

- Traefik + TLS (Let's Encrypt)
- Build agent
- Postgres + Redis + registry
- vedlikeholdsscript (sync/cleanup) og automatisk opprydding

Hurtigvalg: du kan kjøre interaktiv installasjon med:

```bash
# Fra GitHub (anbefalt — trenger ikke hele monorepoet)
curl -fsSL https://raw.githubusercontent.com/webserverpanel/webserverpanel-node/main/install.sh | bash

# Fra monorepo (utvikling)
./node/scripts/install-node.sh
```

Se [node/README.md](../node/README.md) for full dokumentasjon av node-installasjonspakken.

> Denne README-en beskriver node-oppsett (`infrastructure` + `agent`). Selve Next.js-appen kan kjøre separat.

---

## 1) Forutsetninger

- Ubuntu 22.04/24.04
- Minimum 2 vCPU, 4 GB RAM, 40+ GB disk
- DNS:
  - `*.apps.ditt-domene.no` -> serverens offentlige IP
  - `agent.apps.ditt-domene.no` -> samme IP
- Porter åpne: `80` og `443`

---

## 2) Installer Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg lsb-release

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
| sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Verifiser:

```bash
docker --version
docker compose version
```

---

## 3) Opprett bruker og mappe

```bash
sudo useradd -m -s /bin/bash deploy || true
sudo usermod -aG docker deploy
sudo su - deploy

mkdir -p /home/deploy/skybygger/{infrastructure,agent,scripts}
```

---

## 4) Kopier filer fra lokal maskin

Fra lokal repo-rot:

```bash
scp -r infrastructure deploy@DIN_SERVER_IP:/home/deploy/skybygger/
scp -r agent deploy@DIN_SERVER_IP:/home/deploy/skybygger/
```

---

## 5) Konfigurer `infrastructure/.env`

På server:

```bash
cd /home/deploy/skybygger/infrastructure
cp .env.example .env
nano .env
```

Sett minst:

- `BASE_DOMAIN=apps.ditt-domene.no`
- `ACME_EMAIL=deg@ditt-domene.no`
- `AGENT_SECRET=<samme hemmelighet som dashboard bruker>`
- `PG_ADMIN_PASSWORD=<sterkt passord>`
- `REDIS_PASSWORD=<sterkt passord>`

Valgfritt (anbefalt hardening i agent):

- `APP_PIDS_LIMIT=256`
- `APP_NOFILE_SOFT=4096`
- `APP_NOFILE_HARD=8192`
- `APP_NPROC_SOFT=512`
- `APP_NPROC_HARD=1024`
- `APP_BLKIO_WEIGHT=500` (10-1000)
- `APP_LOG_MAX_SIZE=10m`
- `APP_LOG_MAX_FILE=5`
- `APP_FS_QUOTA_MB=2048` (storage-driver avhengig; ignoreres automatisk hvis ikke støttet)
- `APP_RESTART_MAX_RETRIES=5`
- `TRAEFIK_CONTAINER_NAME=traefik` (hvis Traefik-containeren har annet navn)
- `APP_WATCHDOG_ENABLED=true`
- `APP_WATCHDOG_INTERVAL_MS=60000`
- `APP_WATCHDOG_CPU_PERCENT_THRESHOLD=95`
- `APP_WATCHDOG_CPU_CONSECUTIVE_SAMPLES=10`
- `APP_WATCHDOG_UNHEALTHY_CONSECUTIVE_SAMPLES=3`
- `APP_WATCHDOG_COOLDOWN_MS=600000`

Nettverksisolasjon (ny standard): app-containere legges i tenant-nettverk per bruker
(`webserverpanel-tenant-<tenantId>`). For HTTP-apps kobler agenten Traefik-containeren
automatisk til riktig tenant-nettverk.

---

## 6) Opprett nettverk og start stack

```bash
docker network create webserverpanel-net || true
cd /home/deploy/skybygger/infrastructure
docker compose up -d --build
```

Sjekk:

```bash
docker compose ps
docker compose logs --tail 80 traefik
docker compose logs --tail 80 agent
```

---

## 7) Aktiver agent-route i Traefik (fil-provider)

Traefik leser routes fra volumet `webserverpanel_traefik-dynamic`.

```bash
docker run --rm -v webserverpanel_traefik-dynamic:/dynamic alpine sh -c 'cat > /dynamic/agent.yml << "EOF"
http:
  routers:
    agent:
      rule: Host(`agent.apps.ditt-domene.no`)
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
      service: agent
  services:
    agent:
      loadBalancer:
        servers:
          - url: http://agent:2080
EOF'
```

Test:

```bash
curl -i https://agent.apps.ditt-domene.no/health
```

Forventet: `200` + JSON fra agent.

---

## 8) Koble dashboardet til agent-node

I Next.js-appen (`.env.local`):

```env
AGENT_URL=https://agent.apps.ditt-domene.no
AGENT_SECRET=<samme verdi som infrastructure/.env>
```

---

## 9) Daglig drift: script i repo

Fra repo-roten lokalt har du nå:

- `scripts/sync-agent.sh`  
  Synker `agent/` til server + rebuild/restart av agent.
- `scripts/cleanup-agent-server.sh`  
  Lokal/remote cleanup (dry-run som default).
- `scripts/cleanup-agent-server-remote.sh`  
  Kjør cleanup over SSH.
- `scripts/cleanup-agent-server-smart.sh`  
  Threshold-basert cleanup (f.eks. aggressiv ved >=80% disk).
- `scripts/install-agent-cleanup-timer-remote.sh`  
  Installerer systemd service/timer på server.

### Eksempler

Sync agent-endringer:

```bash
./scripts/sync-agent.sh
```

Remote cleanup (dry-run):

```bash
./scripts/cleanup-agent-server-remote.sh
```

Remote cleanup (apply):

```bash
./scripts/cleanup-agent-server-remote.sh --yes
```

---

## 10) Automatisk opprydding (anbefalt)

Installer systemd-timer (daglig kjøring, threshold-basert):

```bash
./scripts/install-agent-cleanup-timer-remote.sh
```

Verifiser på server:

```bash
ssh deploy@DIN_SERVER_IP "systemctl status --no-pager agent-cleanup.timer"
ssh deploy@DIN_SERVER_IP "systemctl list-timers --all | rg agent-cleanup"
```

---

## 11) Feilsøking

Traefik/HTTPS:

```bash
cd /home/deploy/skybygger/infrastructure
docker compose logs -f traefik
```

Agent:

```bash
cd /home/deploy/skybygger/infrastructure
docker compose logs -f agent
```

Sjekk dynamiske routes:

```bash
DYNAMIC_DIR=$(docker volume inspect webserverpanel_traefik-dynamic --format '{{ .Mountpoint }}')
ls -la "$DYNAMIC_DIR"
```

Sjekk diskbruk:

```bash
docker system df
df -h
```

---

## 12) Oppgradering av node

Synk oppdateringer fra lokal repo og rebuild:

```bash
scp -r infrastructure deploy@DIN_SERVER_IP:/home/deploy/skybygger/
scp -r agent deploy@DIN_SERVER_IP:/home/deploy/skybygger/

ssh deploy@DIN_SERVER_IP "cd /home/deploy/skybygger/infrastructure && docker compose up -d --build"
```

Kun agent:

```bash
./scripts/sync-agent.sh
```
