# deployeragent

Selvstendig installasjonspakke for **Webserver Panel**-noder (Traefik, agent, Postgres, Redis, registry).

## Hurtigstart — på serveren

SSH inn på fersk Ubuntu-server som **root**, og kjør:

```bash
curl -fsSL https://raw.githubusercontent.com/frode81/deployeragent/refs/heads/main/install.sh | bash
```

Scriptet gjør alt på serveren:

- Oppretter `deploy`-bruker (hvis mangler)
- Installerer Docker + Compose
- Henter agent/infrastructure fra GitHub
- Starter hele stacken

Du trenger **ikke** egen lokal maskin med rsync/SSH.

### Ikke-interaktivt (på serveren)

```bash
export BASE_DOMAIN=apps.ditt-domene.no
export ACME_EMAIL=deg@ditt-domene.no
export AGENT_SECRET="$(openssl rand -hex 32)"
export INSTALL_CONFIRM=y
export INSTALL_CLEANUP_TIMER=y

curl -fsSL https://raw.githubusercontent.com/frode81/deployeragent/refs/heads/main/install.sh | bash
```

## Alternativ: fra lokal maskin (SSH)

Hvis du vil installere **på en annen server** fra laptop:

```bash
export INSTALL_MODE=remote
export SERVER_HOST=203.0.113.10
export BOOTSTRAP_SSH_USER=root
export SERVER_USER=deploy
export BASE_DOMAIN=apps.ditt-domene.no
export ACME_EMAIL=deg@ditt-domene.no
export INSTALL_CONFIRM=y

curl -fsSL https://raw.githubusercontent.com/frode81/deployeragent/refs/heads/main/install.sh | bash
```

## Fra monorepo (utvikling)

```bash
# På serveren (lokal modus)
./node/scripts/install-node.sh

# Fra laptop mot remote server
INSTALL_MODE=remote SERVER_HOST=1.2.3.4 ./node/scripts/install-node.sh
```

## Publisere til GitHub

```bash
./node/scripts/prepare-standalone.sh
cd node
git add .
git commit -m "Release"
git push origin main
```

## Miljøvariabler

| Variabel | Beskrivelse |
|----------|-------------|
| `INSTALL_MODE` | `local` (default på server) eller `remote` (SSH fra annen maskin) |
| `BASE_DOMAIN` | App-domene (f.eks. `apps.example.com`) |
| `ACME_EMAIL` | E-post for Let's Encrypt |
| `SERVER_USER` | Deploy-bruker (default: `deploy`) |
| `REMOTE_ROOT` | Rotmappe (default: `/home/deploy/skybygger`) |
| `SERVER_HOST` | Kun for `remote`-modus |
| `BOOTSTRAP_SSH_USER` | Kun for `remote` (default: `root`) |
| `INSTALL_CONFIRM` | `y` — hopp over bekreftelse |
| `INSTALL_CLEANUP_TIMER` | `y` — installer systemd cleanup-timer |
| `INSTALL_SKIP_BOOTSTRAP` | `y` — hopp over deploy/Docker-oppsett |

## Mappestruktur på server

```
/home/deploy/skybygger/
├── infrastructure/
├── agent/
└── scripts/
```

Etter install: registrer noden i dashboard med `AGENT_URL` og `AGENT_SECRET`.
