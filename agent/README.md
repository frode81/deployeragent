# Build agent — API og drift

HTTP-tjeneste som kjører på hver **node** (standard port `2080`). Dashboard kaller agent for deploy, logger, livssyklus og database.

- **Installasjon:** [infrastructure/README.md](../infrastructure/README.md)
- **Arkitektur:** [docs/architecture.md](../docs/architecture.md)
- **Sikkerhet:** [docs/security.md](../docs/security.md)

## Autentisering

```http
x-agent-token: <AGENT_SECRET>
Content-Type: application/json
```

Hvis `AGENT_SECRET` ikke er satt, kjører agent **uten auth** (kun lokal utvikling).

## Health og infra

### `GET /health`

Ingen body. Svar:

```json
{
  "ok": true,
  "time": "2026-05-16T12:00:00.000Z",
  "deployQueue": {
    "activeSlots": 0,
    "waiting": 0,
    "maxConcurrent": 2,
    "maxQueued": 100
  }
}
```

### `GET /infra`

Node-status: CPU/minne/disk, managed containere, sertifikater, Traefik-ruter, programvareversjoner.

## Deploy

### `POST /deployments`

Starter asynkron deploy. Svar **`202`** med `{ "id": "<deployId>" }`.

**Body (repo-deploy):**

| Felt | Påkrevd | Beskrivelse |
|------|---------|-------------|
| `projectId` | ja | Dashboard deployment/prosjekt-referanse |
| `name` | ja | App-slug (container `app-<name>`) |
| `tenantId` | nei | Bruker-ID for tenant-nettverk (fallback: `name`) |
| `repo`, `branch`, `token` | ja* | GitHub clone (* ikke ved `prebuiltImage`) |
| `prebuiltImage` | nei | Docker image-ref (katalog) |
| `envVars` | nei | `Record<string, string>` |
| `buildCmd`, `startCmd` | nei | Overstyr Nixpacks |
| `services` | nei | f.eks. `["POSTGRES","REDIS"]` |
| `memoryMb`, `cpuMillis` | nei | Container-grenser |
| `maxDbConnections`, `maxDbSizeMb` | nei | Postgres per app |
| `maxTotalDbSizeMb`, `tenantDatabaseSlugs` | nei | Total DB-kvote på noden |
| `appPort` | nei | Lytteport (standard 3000) |
| `exposeProtocol` | nei | `HTTP` \| `TCP` \| `UDP` |
| `customDomain` | nei | Eget domene (HTTP) |
| `imageVolumeMounts` | nei | `{ sourceName, containerPath, readOnly? }[]` |
| `maxImageVolumeMb` | nei | Summert volum-kvote |

**Feil:** `400` manglende/ugyldige felter, `500` deploy-feil.

### `GET /deployments/:id`

```json
{
  "id": "abc123",
  "projectId": "...",
  "status": "queued|cloning|building|deploying|live|failed",
  "url": "https://my-app.apps.example.com",
  "exposeProtocol": "HTTP",
  "publishedHostPort": 41234,
  "error": "valgfri ved failed",
  "envVarsSet": { "DATABASE_URL": "..." },
  "startedAt": "...",
  "finishedAt": "..."
}
```

### `GET /deployments/:id/logs`

**SSE** (`text/event-stream`). Sender eksisterende logglinjer, deretter live `data: ...` events. Avsluttes med:

```
event: done
data: {"status":"live","url":"...","envVarsSet":{},"exposeProtocol":"HTTP","publishedHostPort":null}
```

## App (runtime)

`:name` = prosjekt-slug (uten `app-`-prefiks i URL; container heter `app-<name>`).

| Metode | Sti | Beskrivelse |
|--------|-----|-------------|
| `GET` | `/apps/:name/status` | `{ "status": "running\|stopped\|not_found" }` |
| `POST` | `/apps/:name/start` \| `stop` \| `restart` | `{ "ok": true, "action", "status", "noop"? }` |
| `DELETE` | `/apps/:name` | Stopper og fjerner app, Traefik-rute og tilhørende Docker-volum (`wsp-v-<slug>-*`) |
| `GET` | `/apps/:name/logs?tail=300` | SSE runtime-logger |
| `GET` | `/apps/:name/stats` | CPU/minne-prosent |
| `POST` | `/apps/:name/exec` | Body: `{ "command": "...", "timeout": 30 }` → `{ "output", "exitCode" }` |

### Database

| Metode | Sti | Beskrivelse |
|--------|-----|-------------|
| `GET` | `/apps/:name/db` | `dbName`, `dbUser`, `connectionUrl`, `sizeBytes` |
| `GET` | `/apps/:name/db/inspect` | Skjema/tabeller (read-only) |
| `POST` | `/apps/:name/db/backup` | `pg_dump` → fil på agent |
| `GET` | `/apps/:name/db/backups` | Liste backups |
| `GET` | `/apps/:name/db/backups/:filename` | Last ned `.sql` |
| `DELETE` | `/apps/:name/db/backups/:filename` | Slett backup |

### Volum

`GET /apps/:name/volumes?sources=vol1,vol2`

```json
{
  "volumes": [
    { "sourceName": "data", "dockerName": "wsp-v-myapp-data", "sizeBytes": 123456 }
  ],
  "totalBytes": 123456
}
```

## Feilsvar

De fleste endepunkter returnerer:

```json
{ "error": "beskrivelse" }
```

med passende HTTP-status (`400`, `401`, `404`, `500`).

## Miljøvariabler (utvalg)

| Variabel | Standard | Beskrivelse |
|----------|----------|-------------|
| `PORT` | `2080` | HTTP-port |
| `AGENT_SECRET` | — | API-token |
| `BASE_DOMAIN` | `apps.webserverpanel.com` | Subdomene for apper |
| `WORK_DIR` | `/tmp/builds` | Git clone / bygg |
| `DATA_DIR` | `/data/deployments` | Deploy-state, backups |
| `DEPLOY_MAX_CONCURRENT` | `2` | Parallelle deploy |
| `DEPLOY_PREBUILT_IMAGE_ALLOWLIST` | tom | Image-prefiks allowlist |
| `APP_WATCHDOG_ENABLED` | `true` | CPU/unhealthy-overvåking |

Full liste: [infrastructure/.env.example](../infrastructure/.env.example).

## Utvikling lokalt

```bash
cd agent
npm install
npm run dev   # eller build + start
```

Krever Docker socket. Sett `AGENT_SECRET` i miljø hvis dashboard skal koble til.

## Dashboard-klient

TypeScript-klient: `src/lib/agent.ts` (`triggerDeploy`, `getDeploymentStatus`, osv.). Per-prosjekt target: `projectAgentTarget()` med `AgentServer.url` / `secret`.
