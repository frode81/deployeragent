import { spawn } from "child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { nanoid } from "nanoid";
import { appendLog, getEmitter, cleanupEmitter } from "./logs.js";
import {
  buildImage,
  runContainer,
  removeContainer,
  removeDockerVolumesForSlug,
  pruneStaleDeployImages,
  pruneDanglingImages,
  pullImage,
  tagImageForDeploy,
  IMAGE_REPO_PREFIX,
  deployDataVolumeName,
  getImageVolumesBytesForSlug,
  toMirrorGcrPullRef,
  sanitizeImageRef,
  type ContainerExposeProtocol,
} from "./docker.js";
import {
  provisionDatabase,
  getDatabaseDiskBytesForSlug,
  getTotalDatabaseDiskBytesForSlugs,
} from "./database.js";
import { writeTraefikConfig, removeTraefikConfig } from "./traefik.js";
import { acquireDeploySlot, releaseDeploySlot } from "./deploy-queue.js";
import { trackBuildWorkDir, untrackBuildWorkDir } from "./build-workdir-tracker.js";

const WORK_DIR = process.env.WORK_DIR ?? "/tmp/builds";
const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "apps.webserverpanel.com";
const FALLBACK_APP_PORT = parseInt(process.env.APP_PORT ?? "3000");
const ACME_PATH = process.env.ACME_PATH ?? "/traefik-data/acme.json";
const TLS_DIAGNOSTIC_MAX_WAIT_MS = Math.max(
  5_000,
  parseInt(process.env.TLS_DIAGNOSTIC_MAX_WAIT_MS ?? "45000", 10)
);
const TLS_DIAGNOSTIC_STEP_MS = Math.max(
  1000,
  parseInt(process.env.TLS_DIAGNOSTIC_STEP_MS ?? "5000", 10)
);

/** Minimum 60 s — git clone mot GitHub kan være treg ved stor historikk (vi bruker --depth 1). */
const DEPLOY_CLONE_TIMEOUT_MS = Math.max(
  60_000,
  parseInt(process.env.DEPLOY_CLONE_TIMEOUT_MS ?? "600000", 10)
);
/** Minimum 120 s — store npm-install / Nixpacks kan ta tid. */
const DEPLOY_BUILD_TIMEOUT_MS = Math.max(
  120_000,
  parseInt(process.env.DEPLOY_BUILD_TIMEOUT_MS ?? "1800000", 10)
);
const DEPLOY_PRUNE_ON_FAILURE = (process.env.DEPLOY_PRUNE_ON_FAILURE ?? "1") !== "0";
const MAX_IMAGE_VOLUME_MOUNTS = Math.max(0, Math.min(32, parseInt(process.env.DEPLOY_MAX_IMAGE_VOLUMES ?? "16", 10)));

export type DeployStatus = "queued" | "cloning" | "building" | "deploying" | "live" | "failed";

function normalizeExposeProtocol(raw: unknown): ContainerExposeProtocol {
  const s = String(raw ?? "HTTP").toUpperCase();
  if (s === "TCP" || s === "UDP") return s;
  return "HTTP";
}

function clampListenPort(raw: unknown): number {
  const p = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (!Number.isFinite(p) || p < 1 || p > 65535) return FALLBACK_APP_PORT;
  return p;
}

interface DeploymentState {
  id: string;
  projectId: string;
  status: DeployStatus;
  url?: string;
  exposeProtocol?: ContainerExposeProtocol;
  publishedHostPort?: number;
  error?: string;
  envVarsSet?: Record<string, string>;
  startedAt: Date;
  finishedAt?: Date;
}

const deployments = new Map<string, DeploymentState>();

export function getDeployment(id: string): DeploymentState | undefined {
  return deployments.get(id);
}

export interface DeployRequest {
  projectId: string;
  tenantId?: string;
  name: string;
  /** Når satt: hopp over clone/bygg; trekk image og kjør (hybrid app-katalog). */
  prebuiltImage?: string;
  repo?: string;
  branch?: string;
  token?: string;
  envVars: Record<string, string>;
  buildCmd?: string;
  startCmd?: string;
  services: string[];
  memoryMb?: number;
  cpuMillis?: number;
  maxDbConnections?: number;
  maxDbSizeMb?: number;
  /** Summert maks MB for alle tenant-databaser (valgfritt). */
  maxTotalDbSizeMb?: number;
  /** Slug-navn for prosjekter med Postgres på samme agent (for totalsjekk). */
  tenantDatabaseSlugs?: string[];
  /** Prosessens lytteport i container (Docker EXPOSE / PORT env). */
  appPort?: number;
  /** HTTP | TCP | UDP — HTTP bruker Traefik HTTPS; TCP/UDP publiseres på vertsmaskinen. */
  exposeProtocol?: string;
  /** Eget domene for HTTP-routing (valgfritt). */
  customDomain?: string;
  /** Named datavolum (logisk sourceName) → container-sti; agent mapper til stabile Docker-volum per slug. */
  imageVolumeMounts?: { sourceName: string; containerPath: string; readOnly?: boolean }[];
  /** Summert maks MB for alle named volum på denne appen. */
  maxImageVolumeMb?: number;
}

function safeNetworkSuffix(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 48);
}

function tenantNetworkName(tenantId: string | undefined, fallbackSlug: string): string {
  const suffix = safeNetworkSuffix(tenantId?.trim() || fallbackSlug);
  return `webserverpanel-tenant-${suffix}`;
}

function assertPrebuiltImageAllowed(ref: string) {
  const raw = process.env.DEPLOY_PREBUILT_IMAGE_ALLOWLIST?.trim();
  if (!raw) return;
  const prefixes = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lower = ref.toLowerCase();
  const ok = prefixes.some((p) => lower.startsWith(p.toLowerCase()));
  if (!ok) {
    throw new Error(
      `Image «${ref}» er ikke tillatt ifølge DEPLOY_PREBUILT_IMAGE_ALLOWLIST. ` +
        `Tillatte prefiks: ${prefixes.join(", ")}`
    );
  }
}

export async function startDeploy(req: DeployRequest): Promise<string> {
  const id = nanoid(12);
  const state: DeploymentState = {
    id,
    projectId: req.projectId,
    status: "queued",
    startedAt: new Date(),
  };
  deployments.set(id, state);

  // Run async without blocking the HTTP response
  // Note: runDeploy's finally block handles emitting "done" and cleanupEmitter
  runDeploy(id, req, state).catch((err) => {
    if (state.status !== "failed") {
      state.status = "failed";
      state.error = String(err);
      state.finishedAt = new Date();
      appendLog(id, `FATAL: ${String(err)}`);
    }
  });

  return id;
}

async function gitCloneShallow(
  cwd: string,
  branch: string,
  cloneUrl: string,
  timeoutMs: number,
  log: (m: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", "--depth", "1", "--branch", branch, cloneUrl, "."], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`git clone timeout etter ${timeoutMs} ms`));
    }, timeoutMs);

    const onData = (buf: Buffer, kind: "out" | "err") => {
      const s = buf.toString();
      for (const line of s.split("\n")) {
        const u = line.trim();
        if (u) log(kind === "err" ? `[git stderr] ${u}` : `[git] ${u}`);
      }
    };
    child.stdout?.on("data", (b: Buffer) => onData(b, "out"));
    child.stderr?.on("data", (b: Buffer) => onData(b, "err"));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else {
        reject(
          new Error(`git clone feilet (exit ${code}${signal ? `, signal ${signal}` : ""})`)
        );
      }
    });
  });
}

async function runDeploy(id: string, req: DeployRequest, state: DeploymentState) {
  const log = (msg: string) => appendLog(id, msg);
  const slug = req.name;
  const buildPath = join(WORK_DIR, id);
  const networkName = tenantNetworkName(req.tenantId, slug);
  const listenPort = clampListenPort(req.appPort ?? FALLBACK_APP_PORT);
  const exposeProtocol = normalizeExposeProtocol(req.exposeProtocol);
  let imageName: string | undefined;

  await acquireDeploySlot(log);
  let trackedBuildDir = false;
  try {
    try {
      const prebuilt = req.prebuiltImage ? sanitizeImageRef(req.prebuiltImage) : undefined;

      // ── Postgres størrelseskontroll (før bygg / image-pull) ────────
      if (req.services.includes("POSTGRES") && req.maxTotalDbSizeMb != null && req.maxTotalDbSizeMb > 0) {
        const slugs = req.tenantDatabaseSlugs?.length
          ? [...new Set(req.tenantDatabaseSlugs)]
          : [slug];
        const sumBytes = await getTotalDatabaseDiskBytesForSlugs(slugs);
        if (sumBytes > req.maxTotalDbSizeMb * 1024 * 1024) {
          const mb = Math.ceil(sumBytes / (1024 * 1024));
          throw new Error(
            `Summert Postgres-bruk for dine apper er ca. ${mb} MB og overstiger plangrensen ${req.maxTotalDbSizeMb} MB (totalt). Slett data i en eller flere databaser eller oppgrader plan før du publiserer igjen.`
          );
        }
      } else if (req.services.includes("POSTGRES") && req.maxDbSizeMb != null && req.maxDbSizeMb > 0) {
        const bytes = await getDatabaseDiskBytesForSlug(slug);
        if (bytes != null && bytes > req.maxDbSizeMb * 1024 * 1024) {
          const mb = Math.ceil(bytes / (1024 * 1024));
          throw new Error(
            `Database er ca. ${mb} MB og overstiger plangrensen ${req.maxDbSizeMb} MB. Slett data eller oppgrader plan før du publiserer igjen.`
          );
        }
      }

      const rawVolMounts = Array.isArray(req.imageVolumeMounts) ? req.imageVolumeMounts : [];
      if (rawVolMounts.length > 0 && req.maxImageVolumeMb != null && req.maxImageVolumeMb > 0) {
        const volSources = rawVolMounts
          .map((m) => ({ sourceName: String(m?.sourceName ?? "").trim() }))
          .filter((m) => m.sourceName);
        const volBytes = await getImageVolumesBytesForSlug(slug, volSources);
        if (volBytes > req.maxImageVolumeMb * 1024 * 1024) {
          const mb = Math.ceil(volBytes / (1024 * 1024));
          throw new Error(
            `Persisterende volum for appen er ca. ${mb} MB og overstiger plangrensen ${req.maxImageVolumeMb} MB. Slett data i volumet eller oppgrader plan før du publiserer igjen.`
          );
        }
      }

      const envVars: Record<string, string> = { PORT: String(listenPort), ...req.envVars };
      if (req.services.includes("POSTGRES") && !envVars["DATABASE_URL"]) {
        log(`Provisjonerer Postgres-database for ${slug}…`);
        const dbUrl = await provisionDatabase(slug, req.maxDbConnections ?? 10);
        envVars["DATABASE_URL"] = dbUrl;
        state.envVarsSet = { DATABASE_URL: dbUrl };
        log(`Database klar: app_${slug}`);
      }

      if (prebuilt) {
        assertPrebuiltImageAllowed(prebuilt);
        const pullRef = toMirrorGcrPullRef(prebuilt);
        state.status = "building";
        log(`Deploy fra ferdig image: ${prebuilt}`);
        if (pullRef !== prebuilt) {
          log(`Pull via ${pullRef}`);
        }
        await pullImage(pullRef, log, DEPLOY_BUILD_TIMEOUT_MS);
        imageName = await tagImageForDeploy(pullRef, slug, id, log);
      } else {
        const repo = req.repo?.trim();
        const branch = req.branch?.trim() || "main";
        const token = req.token?.trim();
        if (!repo || !token) {
          throw new Error("Mangler repo eller GitHub-token for kilde-deploy.");
        }

        trackBuildWorkDir(buildPath);
        trackedBuildDir = true;

        state.status = "cloning";
        log(`Kloner ${repo}@${branch}…`);
        mkdirSync(buildPath, { recursive: true });

        const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
        await gitCloneShallow(buildPath, branch, cloneUrl, DEPLOY_CLONE_TIMEOUT_MS, log);
        log(`Klonet OK`);

        state.status = "building";
        imageName = `${IMAGE_REPO_PREFIX}/${slug}:${id}`;

        const hasDockerfile = existsSync(join(buildPath, "Dockerfile"));

        if (hasDockerfile) {
          log(`Bygger med Dockerfile…`);
          await buildImage(buildPath, imageName, log, DEPLOY_BUILD_TIMEOUT_MS);
        } else {
          log(`Ingen Dockerfile funnet — bygger med Nixpacks…`);
          const nodeForNix = resolveNixpacksNodeVersion(buildPath, envVars);
          log(`Nixpacks Node ${nodeForNix} (engines / Next-versjon eller plattform-standard)`);
          await nixpacksBuild(
            buildPath,
            imageName,
            envVars,
            req.buildCmd,
            req.startCmd,
            log,
            nodeForNix,
            DEPLOY_BUILD_TIMEOUT_MS
          );
        }
        log(`Bilde bygget: ${imageName}`);
      }

      // ── Kjør container ─────────────────────────────────────────
      state.status = "deploying";
      log(`Starter container (${exposeProtocol}, port ${listenPort})…`);

      const domain = (req.customDomain && String(req.customDomain).trim()) || `${slug}.${BASE_DOMAIN}`;
      const containerName = `app-${slug}`;

      const rawVol = Array.isArray(req.imageVolumeMounts) ? req.imageVolumeMounts : [];
      if (rawVol.length > MAX_IMAGE_VOLUME_MOUNTS) {
        throw new Error(
          `For mange volum-monteringer (${rawVol.length}). Maks ${MAX_IMAGE_VOLUME_MOUNTS} støttes.`
        );
      }
      const volumeMounts = rawVol.map((m, idx) => {
        const sourceName = String(m?.sourceName ?? "").trim();
        const containerPath = String(m?.containerPath ?? "").trim();
        if (!sourceName) {
          throw new Error(`imageVolumeMounts[${idx}]: mangler sourceName`);
        }
        if (!containerPath.startsWith("/")) {
          throw new Error(
            `imageVolumeMounts[${idx}]: containerPath må være absolutt sti (starter med /), fikk «${containerPath}»`
          );
        }
        return {
          name: deployDataVolumeName(slug, sourceName),
          target: containerPath,
          readOnly: Boolean(m?.readOnly),
        };
      });

      const { publishedHostPort } = await runContainer({
        name: containerName,
        image: imageName!,
        domain,
        networkName,
        port: listenPort,
        exposeProtocol,
        env: envVars,
        memoryMb:  req.memoryMb,
        cpuMillis: req.cpuMillis,
        volumeMounts,
        onLog: log,
      });

      // ── Traefik (kun HTTP) ────────────────────────────────────
      state.exposeProtocol = exposeProtocol;
      if (exposeProtocol === "HTTP") {
        writeTraefikConfig({ slug, domain, containerName, port: listenPort });
        log(`Traefik-rute registrert: https://${domain}`);
        await logTlsDiagnostics(domain, log);
        state.url = domain;
        state.publishedHostPort = undefined;
      } else {
        removeTraefikConfig(slug);
        log(`Traefik HTTP-rute ikke brukt (${exposeProtocol})`);
        state.url = undefined;
        state.publishedHostPort = publishedHostPort;
      }

      // ── Ferdig ──────────────────────────────────────────────────
      state.status = "live";
      state.finishedAt = new Date();
      if (exposeProtocol === "HTTP") {
        log(`✓ Deploy fullført → https://${domain}`);
      } else {
        log(
          `✓ Deploy fullført → ${exposeProtocol}` +
            (publishedHostPort != null ? ` · ekstern verts-port ${publishedHostPort}` : "")
        );
      }
    } catch (err) {
      state.status = "failed";
      state.error = String(err);
      state.finishedAt = new Date();
      log(`✗ Deploy feilet: ${String(err)}`);
      throw err;
    } finally {
      // Signal SSE listeners that deploy is done (must happen BEFORE cleanupEmitter)
      try {
        getEmitter(id).emit("done");
      } catch {
        /* ignore */
      }
      // Clean up build directory
      try {
        if (existsSync(buildPath)) {
          rmSync(buildPath, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }

      const skipPrune = process.env.SKYBYGGER_SKIP_IMAGE_PRUNE === "1";
      if (state.status === "live" && imageName && !skipPrune) {
        void (async () => {
          try {
            const removed = await pruneStaleDeployImages(slug, imageName!);
            if (removed.length > 0) {
              appendLog(id, `Opprydding: fjernet ${removed.length} tidligere bilde(r) for ${slug}`);
            }
            await pruneDanglingImages();
          } catch {
            /* ikke blokker deploy */
          }
        })();
      } else if (state.status === "failed" && DEPLOY_PRUNE_ON_FAILURE && !skipPrune) {
        void (async () => {
          try {
            await pruneDanglingImages();
            appendLog(id, "Opprydding: kjørte image prune (dangling) etter feilet deploy.");
          } catch {
            /* ignore */
          }
        })();
      }

      cleanupEmitter(id);
    }
  } finally {
    if (trackedBuildDir) {
      untrackBuildWorkDir(buildPath);
    }
    releaseDeploySlot();
  }
}

async function logTlsDiagnostics(domain: string, log: (msg: string) => void) {
  log(
    `TLS/Let's Encrypt: starter verifisering (venter opptil ${Math.round(
      TLS_DIAGNOSTIC_MAX_WAIT_MS / 1000
    )}s ved første utstedelse)...`
  );

  const startedAt = Date.now();
  let iteration = 0;
  let lastHttpsStatus: number | null = null;
  let lastHttpsError: string | null = null;

  while (Date.now() - startedAt < TLS_DIAGNOSTIC_MAX_WAIT_MS) {
    iteration += 1;

    // HTTP bør være oppe tidlig, så vi logger den hver runde.
    try {
      const httpRes = await fetch(`http://${domain}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      const location = httpRes.headers.get("location");
      log(
        `HTTP-sjekk #${iteration}: ${httpRes.status}` +
          (location ? ` (location: ${location})` : "") +
          " — forventet ofte redirect til HTTPS"
      );
    } catch (err) {
      log(`HTTP-sjekk #${iteration}: ikke tilgjengelig ennå (${String(err)})`);
    }

    // HTTPS + ACME-sjekk
    try {
      const httpsRes = await fetch(`https://${domain}`, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      lastHttpsStatus = httpsRes.status;
      lastHttpsError = null;
      log(`HTTPS-sjekk #${iteration}: svarte med ${httpsRes.status}`);
    } catch (err) {
      lastHttpsError = String(err);
      log(`HTTPS-sjekk #${iteration}: venter fortsatt på gyldig sertifikat (${lastHttpsError})`);
    }

    const hasCertInAcme = (() => {
      try {
        if (!existsSync(ACME_PATH)) return false;
        const raw = readFileSync(ACME_PATH, "utf8");
        const acme = JSON.parse(raw) as Record<string, { Certificates?: Array<{ domain?: { main?: string } }> }>;
        for (const resolver of Object.values(acme)) {
          for (const cert of resolver.Certificates ?? []) {
            if (cert.domain?.main?.toLowerCase() === domain.toLowerCase()) return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    })();

    if (hasCertInAcme && lastHttpsStatus !== null && lastHttpsStatus < 500) {
      log("Let's Encrypt-status: sertifikat funnet i ACME-lager og HTTPS svarer.");
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, TLS_DIAGNOSTIC_STEP_MS));
  }

  log(
    "Let's Encrypt-status: sertifikat ikke bekreftet innen ventetiden. " +
      "Deploy er ferdig, men TLS-utstedelse kan fortsatt pågå i bakgrunnen."
  );
}

/** Node-majors som Nixpacks forstår (jmf. nixpacks providers/node). */
function resolveNixpacksNodeVersion(
  contextPath: string,
  envVars: Record<string, string>
): string {
  if (envVars.NIXPACKS_NODE_VERSION?.trim()) {
    return envVars.NIXPACKS_NODE_VERSION.trim();
  }

  const pkgPath = join(contextPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        engines?: { node?: string };
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const engine = pkg.engines?.node;
      if (engine) {
        const majors: number[] = [];
        for (const m of engine.matchAll(/>=\s*(\d+)/g)) {
          majors.push(parseInt(m[1], 10));
        }
        for (const m of engine.matchAll(/\|\|\s*>=\s*(\d+)/g)) {
          majors.push(parseInt(m[1], 10));
        }
        for (const m of engine.matchAll(/\^\s*(\d+)/g)) {
          majors.push(parseInt(m[1], 10));
        }
        const plain = engine.trim().match(/^(\d+)(?:\.|$)/);
        if (plain) majors.push(parseInt(plain[1], 10));
        const geMajor = majors.length ? Math.max(...majors.filter((n) => !Number.isNaN(n))) : null;
        if (geMajor != null) {
          if (geMajor >= 22) return "22";
          if (geMajor >= 20) return "22";
          if (geMajor >= 18) return "18";
        }
      }

      const nextVer = pkg.dependencies?.next ?? pkg.devDependencies?.next;
      if (nextVer) {
        const cleaned = nextVer
          .replace(/^workspace:[^@]*@?/, "")
          .replace(/^file:.*$/, "")
          .replace(/^npm:[^@]*@/, "");
        const major = parseInt(cleaned.replace(/^[\^~>=<]+\s*/, "").split(".")[0], 10);
        if (!Number.isNaN(major)) {
          if (major >= 16) return "22";
          if (major >= 15) return "20";
          if (major >= 14) return "18";
        }
        return "22";
      }
    } catch {
      /* ugyldig JSON */
    }
  }

  return process.env.NIXPACKS_NODE_VERSION?.trim() || "22";
}

async function nixpacksBuild(
  contextPath: string,
  imageName: string,
  env: Record<string, string>,
  buildCmd: string | undefined,
  startCmd: string | undefined,
  onLog: (line: string) => void,
  nodeVersion: string,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["build", contextPath, "--name", imageName];

    const effectiveEnv = { ...env };
    if (!effectiveEnv.NIXPACKS_NODE_VERSION) {
      effectiveEnv.NIXPACKS_NODE_VERSION = nodeVersion;
    }

    for (const [k, v] of Object.entries(effectiveEnv)) {
      args.push("--env", `${k}=${v}`);
    }
    if (buildCmd) {
      args.push("--build-cmd", buildCmd);
    }
    if (startCmd) {
      args.push("--start-cmd", startCmd);
    }

    const proc = spawn("nixpacks", args, { stdio: ["ignore", "pipe", "pipe"] });
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const done = (err?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (err) {
        reject(err);
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`nixpacks avsluttet med kode ${code ?? "ukjent"}`));
    };

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        done(new Error(`nixpacks timeout etter ${timeoutMs} ms`));
      }, timeoutMs);
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").filter(Boolean).forEach(onLog);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      chunk.toString().split("\n").filter(Boolean).forEach(onLog);
    });

    proc.on("close", (code) => {
      done(undefined, code);
    });

    proc.on("error", (err) => {
      done(new Error(`Kan ikke starte nixpacks: ${err.message}. Er nixpacks installert?`));
    });
  });
}

export async function destroyApp(slug: string): Promise<void> {
  await removeContainer(`app-${slug}`);
  removeTraefikConfig(slug);
  await removeDockerVolumesForSlug(slug);
}
