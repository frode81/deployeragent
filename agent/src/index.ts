import express from "express";
import { execSync } from "child_process";
import { statSync, rmSync, createReadStream } from "fs";
import { basename } from "path";
import { startDeploy, getDeployment, destroyApp } from "./deploy.js";
import { getDeployQueueStats } from "./deploy-queue.js";
import { getEmitter, readLogs } from "./logs.js";
import {
  docker,
  getContainerStatus,
  MANAGED_CONTAINER_LABEL,
  sanitizeImageRef,
  validateImageRef,
  deployDataVolumeName,
  getDockerVolumeBytes,
} from "./docker.js";
import { getInfraStatus } from "./infra.js";
import {
  getDbCredentials,
  listBackups,
  backupDir,
  resolveBackupFilePath,
  pruneExcessBackups,
  getDatabaseDiskBytesForSlug,
  deleteBackupFile,
  inspectAppDatabase,
} from "./database.js";
import {
  DEPLOY_MAINTENANCE_INTERVAL_MS,
  runDeployMaintenanceCycle,
} from "./maintenance.js";
import { assertAgentSecretConfigured, verifyAgentToken } from "./agent-auth.js";

const PG_HOST = process.env.PG_HOST ?? "postgres";
const PG_PORT = process.env.PG_PORT ?? "5432";

const PORT = parseInt(process.env.PORT ?? "2080");
const AGENT_SECRET = process.env.AGENT_SECRET;
const WATCHDOG_ENABLED = (process.env.APP_WATCHDOG_ENABLED ?? "true") !== "false";
const WATCHDOG_INTERVAL_MS = Math.max(15_000, parseInt(process.env.APP_WATCHDOG_INTERVAL_MS ?? "60000", 10));
const WATCHDOG_CPU_PERCENT_THRESHOLD = Math.max(
  1,
  Math.min(100, parseInt(process.env.APP_WATCHDOG_CPU_PERCENT_THRESHOLD ?? "95", 10))
);
const WATCHDOG_CPU_CONSECUTIVE_SAMPLES = Math.max(
  2,
  parseInt(process.env.APP_WATCHDOG_CPU_CONSECUTIVE_SAMPLES ?? "10", 10)
);
const WATCHDOG_UNHEALTHY_CONSECUTIVE_SAMPLES = Math.max(
  2,
  parseInt(process.env.APP_WATCHDOG_UNHEALTHY_CONSECUTIVE_SAMPLES ?? "3", 10)
);
const WATCHDOG_COOLDOWN_MS = Math.max(
  60_000,
  parseInt(process.env.APP_WATCHDOG_COOLDOWN_MS ?? "600000", 10)
);

const highCpuCounters = new Map<string, number>();
const unhealthyCounters = new Map<string, number>();
const watchdogCooldownUntil = new Map<string, number>();
let watchdogRunning = false;

async function getContainerCpuPercent(containerName: string): Promise<number | null> {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
      container.stats({ stream: false }, (err: Error | null, data: unknown) => {
        if (err) reject(err);
        else resolve(data as Record<string, unknown>);
      });
    });

    type CpuStats = { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
    const cpu = raw.cpu_stats as CpuStats;
    const precpu = raw.precpu_stats as CpuStats;
    const cpuDelta = cpu.cpu_usage.total_usage - precpu.cpu_usage.total_usage;
    const systemDelta = cpu.system_cpu_usage - precpu.system_cpu_usage;
    const numCpus = cpu.online_cpus ?? 1;
    const cpuAbsolute = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus : 0;
    const nanoCpus = (info.HostConfig as { NanoCpus?: number }).NanoCpus ?? 0;
    const allocatedCpus = nanoCpus > 0 ? nanoCpus / 1_000_000_000 : numCpus;
    return Math.min(Math.round((cpuAbsolute / allocatedCpus) * 100 * 10) / 10, 100);
  } catch {
    return null;
  }
}

async function runAppWatchdogCycle() {
  if (watchdogRunning) return;
  watchdogRunning = true;
  const now = Date.now();
  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: [`${MANAGED_CONTAINER_LABEL}=true`] },
    });

    for (const c of containers) {
      const containerName = c.Names?.[0]?.replace(/^\//, "") ?? "";
      if (!containerName.startsWith("app-")) continue;
      if (c.State !== "running") {
        highCpuCounters.delete(containerName);
        unhealthyCounters.delete(containerName);
        continue;
      }

      if ((watchdogCooldownUntil.get(containerName) ?? 0) > now) {
        continue;
      }

      const container = docker.getContainer(containerName);
      const info = await container.inspect().catch(() => null);
      if (!info?.State?.Running) continue;

      const healthStatus = info.State.Health?.Status;
      if (healthStatus === "unhealthy") {
        const unhealthyCount = (unhealthyCounters.get(containerName) ?? 0) + 1;
        unhealthyCounters.set(containerName, unhealthyCount);
        if (unhealthyCount >= WATCHDOG_UNHEALTHY_CONSECUTIVE_SAMPLES) {
          console.warn(`[watchdog] ${containerName} er unhealthy (${unhealthyCount} prøver). Restarter container.`);
          await container.restart().catch(() => undefined);
          unhealthyCounters.set(containerName, 0);
          highCpuCounters.set(containerName, 0);
          watchdogCooldownUntil.set(containerName, now + WATCHDOG_COOLDOWN_MS);
          continue;
        }
      } else {
        unhealthyCounters.set(containerName, 0);
      }

      const cpuPercent = await getContainerCpuPercent(containerName);
      if (cpuPercent == null) continue;
      if (cpuPercent >= WATCHDOG_CPU_PERCENT_THRESHOLD) {
        const highCount = (highCpuCounters.get(containerName) ?? 0) + 1;
        highCpuCounters.set(containerName, highCount);
        if (highCount >= WATCHDOG_CPU_CONSECUTIVE_SAMPLES) {
          console.warn(
            `[watchdog] ${containerName} høy CPU over tid (${cpuPercent}% >= ${WATCHDOG_CPU_PERCENT_THRESHOLD}%). Stopper container.`
          );
          await container.stop({ t: 10 }).catch(() => undefined);
          highCpuCounters.set(containerName, 0);
          unhealthyCounters.set(containerName, 0);
          watchdogCooldownUntil.set(containerName, now + WATCHDOG_COOLDOWN_MS);
        }
      } else {
        highCpuCounters.set(containerName, 0);
      }
    }
  } catch (err) {
    console.warn(`[watchdog] syklus feilet: ${String(err)}`);
  } finally {
    watchdogRunning = false;
  }
}

/** SSE `done`-payload til dashbordet (matcher DeploymentState fra deploy.ts). */
function sseDeploymentDone(dep: {
  status: string;
  url?: string;
  envVarsSet?: Record<string, string>;
  exposeProtocol?: string;
  publishedHostPort?: number;
}) {
  return JSON.stringify({
    status: dep.status,
    url: dep.url,
    envVarsSet: dep.envVarsSet,
    exposeProtocol: dep.exposeProtocol,
    publishedHostPort: dep.publishedHostPort,
  });
}

const app = express();
app.use(express.json());

// ── Auth ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (!verifyAgentToken(req.headers["x-agent-token"])) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

// ── Health ────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    deployQueue: getDeployQueueStats(),
  });
});

// ── Infra status ──────────────────────────────────────────────────
app.get("/infra", async (_req, res) => {
  try {
    const status = await getInfraStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /deployments — start a deploy ───────────────────────────
app.post("/deployments", async (req, res) => {
  const {
    projectId,
    tenantId,
    name,
    repo,
    branch,
    token,
    prebuiltImage,
    envVars,
    buildCmd,
    startCmd,
    services,
    maxDbConnections,
    maxDbSizeMb,
    maxTotalDbSizeMb,
    tenantDatabaseSlugs,
    memoryMb,
    cpuMillis,
    appPort,
    exposeProtocol,
    customDomain,
    imageVolumeMounts,
    maxImageVolumeMb,
  } = req.body;

  const prebuilt = typeof prebuiltImage === "string" ? sanitizeImageRef(prebuiltImage) : "";

  if (!projectId || !name) {
    res.status(400).json({ error: "Mangler påkrevde felter: projectId, name" });
    return;
  }

  if (prebuilt) {
    const refError = validateImageRef(prebuilt);
    if (refError) {
      res.status(400).json({ error: `Ugyldig image-referanse: ${refError}` });
      return;
    }
  } else if (!repo || !branch || !token) {
    res.status(400).json({ error: "Mangler påkrevde felter for kilde-deploy: repo, branch, token" });
    return;
  }

  try {
    const id = await startDeploy({
      projectId,
      tenantId,
      name,
      prebuiltImage: prebuilt || undefined,
      repo: prebuilt ? undefined : repo,
      branch: prebuilt ? undefined : branch,
      token: prebuilt ? "" : token,
      envVars: envVars ?? {},
      buildCmd,
      startCmd,
      services: services ?? [],
      maxDbConnections,
      maxDbSizeMb,
      maxTotalDbSizeMb,
      tenantDatabaseSlugs,
      memoryMb,
      cpuMillis,
      appPort,
      exposeProtocol,
      customDomain,
      imageVolumeMounts,
      maxImageVolumeMb,
    });
    res.status(202).json({ id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /deployments/:id — deployment status ──────────────────────
app.get("/deployments/:id", (req, res) => {
  const dep = getDeployment(req.params.id);
  if (!dep) {
    res.status(404).json({ error: "Deployment ikke funnet" });
    return;
  }
  res.json(dep);
});

// ── GET /deployments/:id/logs — SSE log stream ────────────────────
app.get("/deployments/:id/logs", (req, res) => {
  const { id } = req.params;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Send existing logs first
  const existing = readLogs(id);
  if (existing) {
    for (const line of existing.split("\n").filter(Boolean)) {
      res.write(`data: ${line}\n\n`);
    }
  }

  const dep = getDeployment(id);
  if (dep && (dep.status === "live" || dep.status === "failed")) {
    res.write(`event: done\ndata: ${sseDeploymentDone(dep)}\n\n`);
    res.end();
    return;
  }

  // Subscribe to live updates
  const emitter = getEmitter(id);

  const onLog = (line: string) => {
    res.write(`data: ${line}\n\n`);
  };

  const onDone = () => {
    const final = getDeployment(id);
    res.write(
      `event: done\ndata: ${sseDeploymentDone({
        status: final?.status ?? "failed",
        url: final?.url,
        envVarsSet: final?.envVarsSet,
        exposeProtocol: final?.exposeProtocol,
        publishedHostPort: final?.publishedHostPort,
      })}\n\n`
    );
    res.end();
    cleanup();
  };

  emitter.on("log", onLog);
  emitter.once("done", onDone);

  function cleanup() {
    emitter.off("log", onLog);
    emitter.off("done", onDone);
  }

  req.on("close", cleanup);
});

// ── GET /apps/:name/logs — SSE stream of container runtime logs ───
app.get("/apps/:name/logs", async (req, res) => {
  const containerName = `app-${req.params.name}`;
  const tail = parseInt((req.query.tail as string) ?? "300");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const sendLine = (line: string) => res.write(`data: ${line}\n\n`);

  try {
    const container = docker.getContainer(containerName);
    await container.inspect(); // throws if not found

    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    }) as unknown as import("stream").Readable;

    // Docker multiplexes stdout/stderr with an 8-byte header per chunk
    let buffer = Buffer.alloc(0);

    logStream.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const frameSize = buffer.readUInt32BE(4);
        if (buffer.length < 8 + frameSize) break;
        const payload = buffer.slice(8, 8 + frameSize).toString("utf8");
        buffer = buffer.slice(8 + frameSize);
        for (const line of payload.split("\n")) {
          if (line.trim()) sendLine(line);
        }
      }
    });

    logStream.on("end", () => {
      res.write("event: end\ndata: {}\n\n");
      res.end();
    });

    logStream.on("error", (err: Error) => {
      sendLine(`ERROR: ${err.message}`);
      res.end();
    });

    req.on("close", () => {
      try { logStream.destroy(); } catch { /* ignore */ }
    });
  } catch (err) {
    sendLine(`Container "${containerName}" ikke funnet eller ikke kjørende: ${String(err)}`);
    res.write("event: end\ndata: {}\n\n");
    res.end();
  }
});

// ── GET /apps/:name/stats — live CPU/memory usage ────────────────
app.get("/apps/:name/stats", async (req, res) => {
  const containerName = `app-${req.params.name}`;
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();

    const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
      container.stats({ stream: false }, (err: Error | null, data: unknown) => {
        if (err) reject(err);
        else resolve(data as Record<string, unknown>);
      });
    });

    type CpuStats = { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
    type MemStats  = { usage: number; limit: number; stats?: { cache?: number } };

    const cpu     = raw.cpu_stats    as CpuStats;
    const precpu  = raw.precpu_stats as CpuStats;
    const mem     = raw.memory_stats as MemStats;

    const cpuDelta    = cpu.cpu_usage.total_usage - precpu.cpu_usage.total_usage;
    const systemDelta = cpu.system_cpu_usage      - precpu.system_cpu_usage;
    const numCpus     = cpu.online_cpus ?? 1;

    // Absolute CPU usage as fraction of all server CPUs
    const cpuAbsolute = systemDelta > 0 ? cpuDelta / systemDelta * numCpus : 0;

    // Allocated CPU fraction (NanoCpus → fraction of 1 CPU)
    const nanoCpus      = (info.HostConfig as { NanoCpus?: number }).NanoCpus ?? 0;
    const allocatedCpus = nanoCpus > 0 ? nanoCpus / 1_000_000_000 : numCpus;

    // CPU % relative to allocated quota
    const cpuPercent = Math.min(
      Math.round((cpuAbsolute / allocatedCpus) * 100 * 10) / 10,
      100
    );

    // Memory relative to container limit (set by Docker)
    const cache      = mem.stats?.cache ?? 0;
    const memUsed    = Math.max(0, mem.usage - cache);
    const memLimit   = mem.limit;
    const memPercent = memLimit > 0 ? Math.round((memUsed / memLimit) * 100) : 0;

    res.json({
      cpuPercent,
      memUsedMb:  Math.round(memUsed  / (1024 * 1024)),
      memLimitMb: Math.round(memLimit / (1024 * 1024)),
      memPercent,
    });
  } catch (err) {
    res.status(404).json({ error: String(err) });
  }
});

// ── POST /apps/:name/exec — run command in container ─────────────
app.post("/apps/:name/exec", async (req, res) => {
  const containerName = `app-${req.params.name}`;
  const command: string = req.body?.command ?? "";
  const timeout = Math.min(parseInt(req.body?.timeout ?? "30"), 60);

  if (!command.trim()) {
    res.status(400).json({ error: "Ingen kommando oppgitt" });
    return;
  }

  try {
    const container = docker.getContainer(containerName);
    await container.inspect();

    const exec = await container.exec({
      Cmd: ["/bin/sh", "-c", command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({ hijack: true, stdin: false }) as unknown as import("stream").Readable;

    let output = "";
    const timer = setTimeout(() => {
      try { (stream as unknown as { destroy: () => void }).destroy(); } catch { /* ignore */ }
    }, timeout * 1000);

    await new Promise<void>((resolve) => {
      let buf = Buffer.alloc(0);
      stream.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 8) {
          const frameSize = buf.readUInt32BE(4);
          if (buf.length < 8 + frameSize) break;
          output += buf.slice(8, 8 + frameSize).toString("utf8");
          buf = buf.slice(8 + frameSize);
        }
      });
      stream.on("end", resolve);
      stream.on("error", resolve);
      stream.on("close", resolve);
    });

    clearTimeout(timer);

    const inspect = await exec.inspect();
    res.json({ output, exitCode: inspect.ExitCode ?? 0 });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /apps/:name/db — database info ───────────────────────────
app.get("/apps/:name/db", async (req, res) => {
  const creds = getDbCredentials(req.params.name);
  if (!creds) {
    res.status(404).json({ error: "Ingen database funnet for denne appen" });
    return;
  }
  let sizeBytes: number | null = null;
  try {
    sizeBytes = await getDatabaseDiskBytesForSlug(req.params.name);
  } catch {
    /* ignore */
  }
  res.json({
    dbName: creds.dbName,
    dbUser: creds.dbUser,
    connectionUrl: creds.connectionUrl,
    sizeBytes,
  });
});

// ── GET /apps/:name/volumes?sources=a,b — diskbruk for named volum ─
app.get("/apps/:name/volumes", async (req, res) => {
  const slug = req.params.name;
  const sources = String(req.query.sources ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sources.length === 0) {
    res.status(400).json({ error: "Mangler sources (kommaseparert liste)" });
    return;
  }
  try {
    const volumes = await Promise.all(
      sources.map(async (sourceName) => {
        const dockerName = deployDataVolumeName(slug, sourceName);
        const sizeBytes = await getDockerVolumeBytes(dockerName);
        return { sourceName, dockerName, sizeBytes };
      })
    );
    const totalBytes = volumes.reduce((acc, v) => acc + v.sizeBytes, 0);
    res.json({ volumes, totalBytes });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /apps/:name/db/inspect — tabeller & kolonner (read-only) ─
app.get("/apps/:name/db/inspect", async (req, res) => {
  try {
    const data = await inspectAppDatabase(req.params.name);
    if (!data) {
      res.status(404).json({ error: "Ingen database funnet" });
      return;
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /apps/:name/db/backup — create pg_dump backup ───────────
app.post("/apps/:name/db/backup", (req, res) => {
  const slug = req.params.name;
  const creds = getDbCredentials(slug);
  if (!creds) {
    res.status(404).json({ error: "Ingen database funnet for denne appen" });
    return;
  }

  const dir = backupDir(slug);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup-${timestamp}.sql`;
  const filepath = `${dir}/${filename}`;

  try {
    execSync(
      `pg_dump -h ${PG_HOST} -p ${PG_PORT} -U ${creds.dbUser} -d ${creds.dbName} -f ${filepath}`,
      {
        stdio: "pipe",
        env: { ...process.env, PGPASSWORD: creds.password },
      }
    );
    const { size } = statSync(filepath);
    pruneExcessBackups(slug);
    res.json({ filename, size, createdAt: new Date().toISOString() });
  } catch (err) {
    try { rmSync(filepath, { force: true }); } catch { /* ignore */ }
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /apps/:name/db/backups — list backups ────────────────────
app.get("/apps/:name/db/backups", (req, res) => {
  res.json({ backups: listBackups(req.params.name) });
});

// ── GET /apps/:name/db/backups/:filename — last ned backup ───────
app.get("/apps/:name/db/backups/:filename", (req, res) => {
  const path = resolveBackupFilePath(req.params.name, req.params.filename);
  if (!path) {
    res.status(404).json({ error: "Backup ikke funnet" });
    return;
  }
  const name = basename(path);
  res.setHeader("Content-Type", "application/sql; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  createReadStream(path).pipe(res);
});

// ── DELETE /apps/:name/db/backups/:filename — slett backup ───────
app.delete("/apps/:name/db/backups/:filename", (req, res) => {
  const ok = deleteBackupFile(req.params.name, req.params.filename);
  if (!ok) {
    res.status(404).json({ error: "Backup ikke funnet" });
    return;
  }
  res.json({ ok: true });
});

// ── DELETE /apps/:name — stop and remove app ──────────────────────
app.delete("/apps/:name", async (req, res) => {
  try {
    await destroyApp(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /apps/:name/status ────────────────────────────────────────
app.get("/apps/:name/status", async (req, res) => {
  const status = await getContainerStatus(`app-${req.params.name}`);
  res.json({ status });
});

// ── POST /apps/:name/:action — lifecycle controls ────────────────
app.post("/apps/:name/:action", async (req, res) => {
  const containerName = `app-${req.params.name}`;
  const action = req.params.action;

  if (!["start", "stop", "restart"].includes(action)) {
    res.status(400).json({ error: "Ugyldig handling. Bruk start|stop|restart." });
    return;
  }

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const running = info.State?.Running === true;

    // Idempotent behavior for start/stop to avoid noisy 500s
    if (action === "start" && running) {
      const status = await getContainerStatus(containerName);
      res.json({ ok: true, action, status, noop: true });
      return;
    }
    if (action === "stop" && !running) {
      const status = await getContainerStatus(containerName);
      res.json({ ok: true, action, status, noop: true });
      return;
    }

    if (action === "start") await container.start();
    if (action === "stop") await container.stop();
    if (action === "restart") await container.restart();

    const status = await getContainerStatus(containerName);
    res.json({ ok: true, action, status });
  } catch (err) {
    const msg = String(err);
    if (
      (action === "start" && msg.includes("already started")) ||
      (action === "stop" && msg.includes("already stopped"))
    ) {
      const status = await getContainerStatus(containerName);
      res.json({ ok: true, action, status, noop: true });
      return;
    }
    res.status(500).json({ error: msg });
  }
});

assertAgentSecretConfigured();

app.listen(PORT, () => {
  console.log(`[agent] Kjører på http://0.0.0.0:${PORT}`);
  if (!AGENT_SECRET) {
    console.warn("[agent] ADVARSEL: AGENT_SECRET er ikke satt — kun for lokal utvikling.");
  }
  if (DEPLOY_MAINTENANCE_INTERVAL_MS > 0) {
    setInterval(() => {
      void runDeployMaintenanceCycle().catch((e) =>
        console.warn(`[vedlikehold] syklus feilet: ${String(e)}`)
      );
    }, DEPLOY_MAINTENANCE_INTERVAL_MS);
    setTimeout(() => {
      void runDeployMaintenanceCycle().catch(() => undefined);
    }, 120_000);
    console.log(
      `[vedlikehold] periodisk opprydding hver ${Math.round(DEPLOY_MAINTENANCE_INTERVAL_MS / 1000)}s (byggmapper + dangling images + build cache sjelden)`
    );
  } else {
    console.log("[vedlikehold] deaktivert (DEPLOY_MAINTENANCE_INTERVAL_MS=0)");
  }
  if (WATCHDOG_ENABLED) {
    setInterval(() => {
      void runAppWatchdogCycle();
    }, WATCHDOG_INTERVAL_MS);
    console.log(
      `[watchdog] aktiv: interval=${WATCHDOG_INTERVAL_MS}ms, cpu>${WATCHDOG_CPU_PERCENT_THRESHOLD}% x${WATCHDOG_CPU_CONSECUTIVE_SAMPLES}, unhealthy x${WATCHDOG_UNHEALTHY_CONSECUTIVE_SAMPLES}`
    );
  } else {
    console.log("[watchdog] deaktivert (APP_WATCHDOG_ENABLED=false)");
  }
});
