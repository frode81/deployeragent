# webserverpanel-node

Selvstendig installasjonspakke for **Webserver Panel**-noder (Traefik, agent, Postgres, Redis, registry).

Denne mappen kan publiseres som eget GitHub-repo. Ved installasjon på ny server hentes `agent/`, `infrastructure/` og scripts derfra — du trenger ikke hele dashboard-monorepoet lokalt.

## Hurtigstart (fra lokal maskin)

```bash
curl -fsSL https://raw.githubusercontent.com/webserverpanel/webserverpanel-node/main/install.sh | bash
```

Interaktivt script spør om server-IP, domene, secrets osv., og setter opp noden via SSH.

### Ikke-interaktivt

```bash
export SERVER_HOST=203.0.113.10
export SERVER_USER=deploy
export REMOTE_ROOT=/home/deploy/skybygger
export BASE_DOMAIN=apps.ditt-domene.no
export ACME_EMAIL=deg@ditt-domene.no
export AGENT_SECRET="$(openssl rand -hex 32)"
export INSTALL_CONFIRM=y
export INSTALL_CLEANUP_TIMER=y

curl -fsSL https://raw.githubusercontent.com/webserverpanel/webserverpanel-node/main/install.sh | bash
```

## Fra monorepo (utvikling)

```bash
# Fra deployer-roten — bruker ../agent og ../infrastructure automatisk
./node/scripts/install-node.sh

# Eller eksplisitt fra GitHub (teste remote-pakke)
NODE_INSTALL_SOURCE=github ./node/scripts/install-node.sh
```

## Publisere til GitHub

Fra deployer-monorepo:

```bash
./node/scripts/prepare-standalone.sh
cd node
git init
git add .
git commit -m "Initial node installer release"
git remote add origin git@github.com:webserverpanel/webserverpanel-node.git
git push -u origin main
```

`prepare-standalone.sh` kopierer `agent/` og `infrastructure/` inn i `node/` før push.

## Oppdatere agent på eksisterende node

```bash
SERVER_HOST=203.0.113.10 ./node/scripts/sync-agent.sh
```

## Miljøvariabler

| Variabel | Beskrivelse |
|----------|-------------|
| `NODE_INSTALL_REPO` | GitHub-repo URL (default: webserverpanel/webserverpanel-node) |
| `NODE_INSTALL_REF` | Branch/tag (default: `main`) |
| `NODE_INSTALL_SOURCE` | `auto`, `monorepo`, `standalone`, `github` |
| `SERVER_HOST` | Server IP/host |
| `SERVER_USER` | SSH-bruker (default: `deploy`) |
| `REMOTE_ROOT` | Rotmappe på server (default: `/home/deploy/skybygger`) |
| `INSTALL_CONFIRM` | `y`/`n` — hopp over bekreftelse |
| `INSTALL_CLEANUP_TIMER` | `y`/`n` — installer systemd cleanup-timer |

Se [infrastructure/README.md](infrastructure/README.md) (etter `prepare-standalone.sh`) for full driftsdokumentasjon.

## Mappestruktur på server

```
/home/deploy/skybygger/
├── infrastructure/   # docker-compose + .env
├── agent/            # agent-kilde (bygges til container)
└── scripts/          # vedlikehold
```

## Dashboard

Etter install: registrer noden i dashboard med `AGENT_URL` og `AGENT_SECRET` som scriptet skriver ut.
