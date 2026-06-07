import Dockerode from "dockerode";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const docker = new Dockerode({ socketPath: "/var/run/docker.sock" });

/** Lokalt Docker-image-repo for bygg (slug tagges med prosjekt-id). */
export const IMAGE_REPO_PREFIX = "webserverpanel";

/** Docker-label for containere som deploy-plattformen styrer (infra rydding / listing). */
export const MANAGED_CONTAINER_LABEL = "webserverpanel.managed";

export const NETWORK_NAME = "webserverpanel-net";
export const REGISTRY = process.env.REGISTRY_HOST ?? "localhost:5000";
const TRAEFIK_CONTAINER_NAME = process.env.TRAEFIK_CONTAINER_NAME ?? "traefik";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULT_PIDS_LIMIT = envInt("APP_PIDS_LIMIT", 256);
const DEFAULT_NOFILE_SOFT = envInt("APP_NOFILE_SOFT", 4096);
const DEFAULT_NOFILE_HARD = envInt("APP_NOFILE_HARD", 8192);
const DEFAULT_NPROC_SOFT = envInt("APP_NPROC_SOFT", 512);
const DEFAULT_NPROC_HARD = envInt("APP_NPROC_HARD", 1024);
const DEFAULT_BLKIO_WEIGHT = Math.max(10, Math.min(1000, envInt("APP_BLKIO_WEIGHT", 500)));
const DEFAULT_LOG_MAX_SIZE = process.env.APP_LOG_MAX_SIZE ?? "10m";
const DEFAULT_LOG_MAX_FILE = String(envInt("APP_LOG_MAX_FILE", 5));
const DEFAULT_RESTART_MAX_RETRIES = envInt("APP_RESTART_MAX_RETRIES", 5);
const DEFAULT_FS_QUOTA_MB = envInt("APP_FS_QUOTA_MB", 2048);

export async function ensureNetwork(name = NETWORK_NAME) {
  const networks = await docker.listNetworks({ filters: { name: [name] } });
  if (networks.length === 0) {
    await docker.createNetwork({ Name: name, Driver: "bridge" });
  }
}

async function ensureContainerAttachedToNetwork(containerName: string, networkName: string): Promise<boolean> {
  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    const current = info.NetworkSettings?.Networks ?? {};
    if (current[networkName]) return true;
    const net = docker.getNetwork(networkName);
    await net.connect({ Container: containerName });
    return true;
  } catch {
    return false;
  }
}

async function findTraefikContainerNames(): Promise<string[]> {
  const preferred = TRAEFIK_CONTAINER_NAME.trim();
  const all = await docker.listContainers({ all: true });
  const picked = new Set<string>();

  for (const c of all) {
    const name = c.Names?.[0]?.replace(/^\//, "") ?? "";
    const labels = c.Labels ?? {};
    const composeService = labels["com.docker.compose.service"];
    const image = c.Image?.toLowerCase() ?? "";

    if (preferred && (name === preferred || c.Names?.some((n) => n.replace(/^\//, "") === preferred))) {
      picked.add(name);
      continue;
    }
    if (composeService === "traefik") {
      picked.add(name);
      continue;
    }
    if (name.includes("traefik") || image.startsWith("traefik:")) {
      picked.add(name);
    }
  }

  return Array.from(picked).filter(Boolean);
}

const MIRROR_GCR = "mirror.gcr.io";

/**
 * Mapper Docker Hub–referanser til Google pull-through (`mirror.gcr.io`).
 * Offisielle images uten slash: `nginx:alpine` → `mirror.gcr.io/library/nginx:alpine`.
 * Bruker-/org-repo: `baserow/baserow:2` → `mirror.gcr.io/baserow/baserow:2`.
 * Andre registre (første path-segment inneholder `.` eller `:`) returneres uendret.
 *
 * Fjerner ALL intern whitespace fra referansen (linjeskift, tab, mellomrom) slik at
 * paste-feil fra DB/UI ikke sender en ugyldig referanse til Docker API.
 */
export function toMirrorGcrPullRef(imageRef: string): string {
  const original = imageRef.replace(/\s+/g, "").trim();
  if (!original) return original;
  const oLower = original.toLowerCase();
  if (oLower.startsWith(`${MIRROR_GCR}/`)) return original;

  if (original.startsWith("/") || original.startsWith(".")) {
    return original;
  }

  let path = original;
  for (const p of ["docker.io/", "index.docker.io/", "registry-1.docker.io/"]) {
    if (oLower.startsWith(p)) {
      path = original.slice(p.length);
      break;
    }
  }

  const slash = path.indexOf("/");
  if (slash === -1) {
    return `${MIRROR_GCR}/library/${path}`;
  }

  const first = path.slice(0, slash);
  if (first.includes(".") || first.includes(":")) {
    return original;
  }

  return `${MIRROR_GCR}/${path}`;
}

/** Sanitiserer en image-referanse: fjerner all intern whitespace. Brukes ved validering. */
export function sanitizeImageRef(imageRef: string): string {
  return imageRef.replace(/\s+/g, "").trim();
}

/**
 * Enkel syntaks-sjekk for en Docker image-referanse.
 * Returnerer en feilmelding (string) hvis referansen er ugyldig, ellers null.
 * Sjekker at referansen:
 *  - Ikke er tom
 *  - Ikke starter med `/` (tegn på at det er en sti, ikke et image-navn)
 *  - Inneholder tag (`:`) eller digest (`@sha256:`)
 *  - Ikke inneholder åpenbart ugyldige tegn (mellomrom, `..`, `//`)
 */
export function validateImageRef(imageRef: string): string | null {
  const s = imageRef.trim();
  if (!s) return "image-referanse er tom";
  if (s.startsWith("/") || s.startsWith(".")) {
    return (
      `«${s.slice(0, 60)}» ser ut som en sti eller volum-spec, ikke et Docker-image. ` +
      "Bruk formatet image:tag, f.eks. nocodb/nocodb:latest."
    );
  }
  if (!s.includes(":") && !s.includes("@")) {
    return `«${s}» mangler tag eller digest (f.eks. nocodb/nocodb:latest).`;
  }
  if (/[\s]/.test(s)) {
    return `image-referansen inneholder mellomrom: «${s}».`;
  }
  if (s.includes("//") || s.includes("..")) {
    return `image-referansen inneholder ugyldig sekvens (// eller ..): «${s}».`;
  }
  return null;
}

export async function pullImage(
  imageRef: string,
  onLog: (line: string) => void,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (err?: Error | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (err) reject(err);
      else resolve();
    };

    docker.pull(imageRef, (err: Error | null, stream: NodeJS.ReadableStream | undefined) => {
      if (err) return finish(err);
      if (!stream) return finish(new Error("Ingen stream fra docker pull"));

      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          try {
            (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
          } catch {
            /* ignore */
          }
          finish(new Error(`docker pull timeout etter ${timeoutMs} ms`));
        }, timeoutMs);
      }

      docker.modem.followProgress(
        stream,
        (err2: Error | null) => finish(err2 ?? undefined),
        (event: { status?: string; id?: string; error?: string; progress?: string }) => {
          if (event.status) {
            const tail = [event.id, event.progress].filter(Boolean).join(" ");
            onLog(tail ? `${event.status} ${tail}` : event.status);
          }
          if (event.error) onLog(`ERROR: ${event.error}`);
        }
      );
    });
  });
}

/** Tagger lokalt image slik at det matcher plattformens navn for prune/kjøring. */
export async function tagImageForDeploy(
  sourceRef: string,
  slug: string,
  deployId: string,
  onLog: (line: string) => void
): Promise<string> {
  const repo = `${IMAGE_REPO_PREFIX}/${slug}`;
  const tag = deployId;
  return new Promise((resolve, reject) => {
    docker.getImage(sourceRef).tag({ repo, tag }, (err: Error | null) => {
      if (err) {
        reject(err);
        return;
      }
      const full = `${repo}:${tag}`;
      onLog(`Tagget som ${full}`);
      resolve(full);
    });
  });
}

export async function buildImage(
  contextPath: string,
  imageName: string,
  onLog: (line: string) => void,
  timeoutMs?: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (err?: Error | null) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (err) reject(err);
      else resolve();
    };

    docker.buildImage(
      { context: contextPath, src: ["."] },
      { t: imageName, rm: true },
      (err, stream) => {
        if (err) return finish(err);
        if (!stream) return finish(new Error("No build stream"));

        if (timeoutMs != null && timeoutMs > 0) {
          killTimer = setTimeout(() => {
            try {
              (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
            } catch {
              /* ignore */
            }
            finish(new Error(`Docker build timeout etter ${timeoutMs} ms`));
          }, timeoutMs);
        }

        docker.modem.followProgress(
          stream,
          (err2: Error | null) => {
            finish(err2 ?? undefined);
          },
          (event: { stream?: string; error?: string }) => {
            if (event.stream) onLog(event.stream.trimEnd());
            if (event.error) onLog(`ERROR: ${event.error}`);
          }
        );
      }
    );
  });
}

export type ContainerExposeProtocol = "HTTP" | "TCP" | "UDP";

function slugifyVolumeSegment(s: string): string {
  const t = s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (t || "data").slice(0, 56);
}

/** Stabilt Docker-volumnavn per prosjekt-slug og logisk kilde (fra katalog). */
export function deployDataVolumeName(projectSlug: string, sourceName: string): string {
  const a = slugifyVolumeSegment(projectSlug);
  const b = slugifyVolumeSegment(sourceName);
  return `wsp-v-${a}-${b}`.slice(0, 240);
}

export async function ensureDockerVolume(name: string, onLog: (line: string) => void): Promise<void> {
  try {
    await docker.getVolume(name).inspect();
    onLog(`Datavolum finnes: ${name}`);
  } catch {
    await docker.createVolume({ Name: name });
    onLog(`Opprettet datavolum: ${name}`);
  }
}

/** Diskbruk for et named Docker-volum (byte), eller 0 hvis volumet ikke finnes. */
export async function getDockerVolumeBytes(volumeName: string): Promise<number> {
  try {
    const vol = await docker.getVolume(volumeName).inspect();
    const mountpoint = vol.Mountpoint;
    if (!mountpoint) return 0;
    const { stdout } = await execFileAsync("du", ["-sb", mountpoint], {
      timeout: 30_000,
      maxBuffer: 256,
    });
    const n = parseInt(String(stdout).trim().split(/\s+/)[0] ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Summert disk for alle named volum tilknyttet én app-slug. */
export async function getImageVolumesBytesForSlug(
  projectSlug: string,
  mounts: { sourceName: string }[]
): Promise<number> {
  let sum = 0;
  for (const m of mounts) {
    const name = deployDataVolumeName(projectSlug, m.sourceName);
    sum += await getDockerVolumeBytes(name);
  }
  return sum;
}

export async function runContainer(opts: {
  name: string;
  image: string;
  domain: string;
  networkName?: string;
  port: number;
  /** HTTP = kun internt nettverk (Traefik); TCP/UDP = publiser til vertsmaskinen med dynamisk verts-port. */
  exposeProtocol?: ContainerExposeProtocol;
  env: Record<string, string>;
  memoryMb?: number;
  cpuMillis?: number;
  /** Named Docker-volum (allerede resolve’te navn) → mount path i container. */
  volumeMounts?: { name: string; target: string; readOnly?: boolean }[];
  onLog: (line: string) => void;
}): Promise<{ containerId: string; publishedHostPort?: number }> {
  const appNetworkName = opts.networkName ?? NETWORK_NAME;
  await ensureNetwork(appNetworkName);

  // Fjern gammel container hvis den finnes (force=true stopper og sletter i ett kall)
  try {
    await docker.getContainer(opts.name).remove({ force: true });
    opts.onLog(`Fjernet gammel container: ${opts.name}`);
  } catch (err) {
    const msg = String(err);
    if (!msg.includes("404") && !msg.toLowerCase().includes("no such container")) {
      opts.onLog(`Advarsel: klarte ikke å fjerne gammel container ${opts.name}: ${msg}`);
    }
  }

  const envArray = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`);

  // Resource limits — convert to Docker units
  const memBytes  = opts.memoryMb  ? opts.memoryMb * 1024 * 1024 : undefined;
  const nanoCpus  = opts.cpuMillis ? opts.cpuMillis * 1_000_000  : undefined;

  if (opts.memoryMb) opts.onLog(`Ressursgrense: minne ${opts.memoryMb} MB, CPU ${opts.cpuMillis ?? 500} millicores`);
  opts.onLog(
    `Hardening: pids=${DEFAULT_PIDS_LIMIT}, nofile=${DEFAULT_NOFILE_SOFT}/${DEFAULT_NOFILE_HARD}, nproc=${DEFAULT_NPROC_SOFT}/${DEFAULT_NPROC_HARD}, blkio=${DEFAULT_BLKIO_WEIGHT}, log=${DEFAULT_LOG_MAX_SIZE}x${DEFAULT_LOG_MAX_FILE}, fs=${DEFAULT_FS_QUOTA_MB}MB`
  );

  const expose = opts.exposeProtocol ?? "HTTP";
  const proto = expose === "UDP" ? "udp" : "tcp";
  const portKey = `${opts.port}/${proto}`;

  const binds: string[] = [];
  if (opts.volumeMounts?.length) {
    for (const m of opts.volumeMounts) {
      await ensureDockerVolume(m.name, opts.onLog);
      binds.push(`${m.name}:${m.target}${m.readOnly ? ":ro" : ""}`);
    }
  }

  const exposedPorts: Record<string, object> =
    expose === "UDP" ? { [`${opts.port}/udp`]: {} } : { [`${opts.port}/tcp`]: {} };

  const portBindings =
    expose === "HTTP"
      ? undefined
      : {
          [portKey]: [{ HostIp: "0.0.0.0", HostPort: "" }],
        };

  const createOptions: Dockerode.ContainerCreateOptions = {
    name: opts.name,
    Image: opts.image,
    Env: envArray,
    ExposedPorts: exposedPorts,
    HostConfig: {
      NetworkMode: appNetworkName,
      // on-failure gir innebygget Docker-backoff og hindrer evig crash-loop
      RestartPolicy: { Name: "on-failure", MaximumRetryCount: DEFAULT_RESTART_MAX_RETRIES },
      ...(memBytes  !== undefined && { Memory: memBytes }),
      ...(nanoCpus  !== undefined && { NanoCpus: nanoCpus }),
      PidsLimit: DEFAULT_PIDS_LIMIT,
      BlkioWeight: DEFAULT_BLKIO_WEIGHT,
      LogConfig: {
        Type: "json-file",
        Config: {
          "max-size": DEFAULT_LOG_MAX_SIZE,
          "max-file": DEFAULT_LOG_MAX_FILE,
        },
      },
      Ulimits: [
        { Name: "nofile", Soft: DEFAULT_NOFILE_SOFT, Hard: DEFAULT_NOFILE_HARD },
        { Name: "nproc", Soft: DEFAULT_NPROC_SOFT, Hard: DEFAULT_NPROC_HARD },
      ],
      // Begrens skrivbart containerlag der storage-driver støtter dette (typisk overlay2/xfs).
      StorageOpt: {
        size: `${DEFAULT_FS_QUOTA_MB}m`,
      },
      ...(portBindings && { PortBindings: portBindings }),
      ...(binds.length > 0 && { Binds: binds }),
    },
    Healthcheck: {
      Test: [
        "CMD-SHELL",
        `if command -v curl >/dev/null 2>&1; then curl -fsS http://127.0.0.1:${opts.port}/ >/dev/null; elif command -v wget >/dev/null 2>&1; then wget -q -O- http://127.0.0.1:${opts.port}/ >/dev/null; elif command -v nc >/dev/null 2>&1; then nc -z 127.0.0.1 ${opts.port}; else exit 0; fi`,
      ],
      Interval: 30_000_000_000,
      Timeout: 5_000_000_000,
      Retries: 3,
      StartPeriod: 40_000_000_000,
    },
    Labels: {
      [MANAGED_CONTAINER_LABEL]: "true",
    },
  };

  let container;
  try {
    container = await docker.createContainer(createOptions);
  } catch (err) {
    const msg = String(err).toLowerCase();
    if (msg.includes("storage-opt") || msg.includes("size")) {
      opts.onLog("Advarsel: storage quota støttes ikke på denne verten, fortsetter uten StorageOpt size.");
      if (createOptions.HostConfig?.StorageOpt) {
        delete createOptions.HostConfig.StorageOpt;
      }
      container = await docker.createContainer(createOptions);
    } else {
      throw err;
    }
  }

  await container.start();

  if (expose === "HTTP") {
    const traefikNames = await findTraefikContainerNames();
    if (traefikNames.length === 0) {
      throw new Error(
        `Fant ingen Traefik-container (TRAEFIK_CONTAINER_NAME=${TRAEFIK_CONTAINER_NAME}). ` +
        "HTTP-routing kan ikke settes opp for tenant-nettverk."
      );
    }
    let attachedCount = 0;
    for (const traefikName of traefikNames) {
      const ok = await ensureContainerAttachedToNetwork(traefikName, appNetworkName);
      if (ok) {
        attachedCount += 1;
        opts.onLog(`Koblet ${traefikName} til nettverk ${appNetworkName} for HTTP-routing.`);
      }
    }
    if (attachedCount === 0) {
      throw new Error(
        `Klarte ikke å koble Traefik til ${appNetworkName}. ` +
        "Sjekk docker-socket tilgang og at Traefik-containeren kjører."
      );
    }
  }

  let publishedHostPort: number | undefined;
  if (expose !== "HTTP") {
    const info = await container.inspect();
    const bindings = info.NetworkSettings?.Ports?.[portKey];
    const hp = bindings?.[0]?.HostPort;
    if (hp) {
      publishedHostPort = parseInt(hp, 10);
      opts.onLog(`Ekstern ${expose}-port: ${publishedHostPort} → container ${opts.port}/${proto}`);
    } else {
      opts.onLog(`Advarsel: fant ikke tildelt verts-port for ${portKey}`);
    }
  }

  opts.onLog(
    expose === "HTTP"
      ? `Container startet: ${opts.name} → https://${opts.domain} (nettverk: ${appNetworkName})`
      : `Container startet: ${opts.name} (${expose})`
  );
  return { containerId: container.id, publishedHostPort };
}

export async function stopContainer(name: string): Promise<void> {
  const container = docker.getContainer(name);
  await container.stop();
}

export async function removeContainer(name: string): Promise<void> {
  try {
    const container = docker.getContainer(name);
    await container.stop().catch(() => {});
    await container.remove();
  } catch {
    // ignore if not found
  }
}

/** Prefiks for alle named volum tilknyttet én app-slug (matcher deployDataVolumeName). */
export function dockerVolumePrefixForSlug(projectSlug: string): string {
  return `wsp-v-${slugifyVolumeSegment(projectSlug)}-`;
}

/** Sletter alle Docker-volum for app-slug (etter at container er fjernet). */
export async function removeDockerVolumesForSlug(projectSlug: string): Promise<string[]> {
  const prefix = dockerVolumePrefixForSlug(projectSlug);
  const removed: string[] = [];
  const { Volumes } = await docker.listVolumes();
  for (const v of Volumes ?? []) {
    const name = v.Name;
    if (!name?.startsWith(prefix)) continue;
    try {
      await docker.getVolume(name).remove();
      removed.push(name);
    } catch {
      // volum i bruk eller allerede borte — fortsett med øvrige
    }
  }
  return removed;
}

export async function getContainerStatus(
  name: string
): Promise<"running" | "stopped" | "not_found"> {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    return info.State.Running ? "running" : "stopped";
  } catch {
    return "not_found";
  }
}

/** Fjerner andre repo-tags enn `keepRepoTag` under `${IMAGE_REPO_PREFIX}/<slug>:…` (typisk gamle deploy-bygg). */
export async function pruneStaleDeployImages(
  slug: string,
  keepRepoTag: string
): Promise<string[]> {
  const removed: string[] = [];
  const prefix = `${IMAGE_REPO_PREFIX}/${slug}:`;
  const summaries = await docker.listImages();
  for (const s of summaries) {
    const tags = s.RepoTags;
    if (!tags?.length) continue;
    for (const tag of tags) {
      if (!tag || tag.includes("<none>")) continue;
      if (tag.startsWith(prefix) && tag !== keepRepoTag) {
        try {
          await docker.getImage(tag).remove();
          removed.push(tag);
        } catch {
          try {
            await docker.getImage(tag).remove({ force: true });
            removed.push(tag);
          } catch {
            /* f.eks. fortsatt referanse — ignorer */
          }
        }
      }
    }
  }
  return removed;
}

/** Fjerner «dangling» images (uten navnetagg). Trygt etter bygg som har laget mellomliggende lag. */
export async function pruneDanglingImages() {
  try {
    return await docker.pruneImages({});
  } catch {
    return undefined;
  }
}
