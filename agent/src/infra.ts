import { readFileSync, readdirSync } from "fs";
import { X509Certificate } from "crypto";
import { execSync } from "child_process";
import os from "os";
import { docker, NETWORK_NAME, MANAGED_CONTAINER_LABEL } from "./docker.js";

export interface CertInfo {
  domain: string;
  validTo: string;
  daysLeft: number;
  status: "valid" | "expiring" | "expired" | "pending";
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: "running" | "stopped" | "not_found";
  image: string;
  startedAt: string | null;
  ports: string[];
  networks: string[];
}

export interface SystemStats {
  cpuPercent: number;
  loadAvg: number;
  memTotal: number;
  memUsed: number;
  memPercent: number;
  diskTotal: number;
  diskUsed: number;
  diskPercent: number;
}

export interface InfraStatus {
  agent: "ok";
  uptime: number;
  system: SystemStats;
  containers: ContainerInfo[];
  software: SoftwareInfo[];
  host: HostInfo;
  certs: CertInfo[];
  traefikRoutes: string[];
}

export interface SoftwareInfo {
  name: string;
  version: string;
  source: "runtime" | "container";
}

export interface HostInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  publicIp: string | null;
  updates: {
    manager: "apt" | "dnf" | "yum" | "unknown";
    status: "ok" | "updates_available" | "unknown";
    count: number | null;
    checkedAt: string;
  };
}

const START_TIME = Date.now();
const ACME_PATH = process.env.ACME_PATH ?? "/traefik-data/acme.json";
const DYNAMIC_DIR = process.env.TRAEFIK_DYNAMIC_DIR ?? "/dynamic";
let updatesCache:
  | { manager: "apt" | "dnf" | "yum" | "unknown"; status: "ok" | "updates_available" | "unknown"; count: number | null; checkedAt: number }
  | null = null;
let publicIpCache: { value: string | null; checkedAt: number } | null = null;

export async function getInfraStatus(): Promise<InfraStatus> {
  const [containers, software, host, certs, traefikRoutes] = await Promise.all([
    getManagedContainers(),
    getSoftwareInfo(),
    getHostInfo(),
    getCertStatus(),
    getRegisteredRoutes(),
  ]);

  return {
    agent: "ok",
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    system: getSystemStats(),
    containers,
    software,
    host,
    certs,
    traefikRoutes,
  };
}

function getSystemStats(): SystemStats {
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  const usedMem  = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);

  const loadAvg  = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPercent = Math.round(Math.min((loadAvg[0] / cpuCount) * 100, 100));

  let diskTotal = 0, diskUsed = 0, diskPercent = 0;
  try {
    const df = execSync("df -k /", { timeout: 3000 }).toString().trim().split("\n");
    const parts = df[1].split(/\s+/);
    diskTotal   = parseInt(parts[1]) * 1024;
    diskUsed    = parseInt(parts[2]) * 1024;
    diskPercent = Math.round((diskUsed / diskTotal) * 100);
  } catch { /* ignore */ }

  return {
    cpuPercent,
    loadAvg: Math.round(loadAvg[0] * 100) / 100,
    memTotal: totalMem,
    memUsed:  usedMem,
    memPercent,
    diskTotal,
    diskUsed,
    diskPercent,
  };
}

async function getManagedContainers(): Promise<ContainerInfo[]> {
  try {
    const all = await docker.listContainers({ all: true });
    const visible = all.filter((c) => {
      const labels = c.Labels ?? {};
      const isManagedNow = labels[MANAGED_CONTAINER_LABEL] === "true";
      const isManagedLegacy = labels["skybygger.managed"] === "true";
      const hasAppPrefix = c.Names?.some((n) => n.replace(/^\//, "").startsWith("app-")) ?? false;
      return isManagedNow || isManagedLegacy || hasAppPrefix;
    });

    return visible
      .map((c) => {
        const ports = (c.Ports ?? []).map((p) => {
          const ip = p.IP && p.IP !== "0.0.0.0" ? `${p.IP}:` : "";
          const pub = p.PublicPort ? `${ip}${p.PublicPort}->` : "";
          return `${pub}${p.PrivatePort}/${p.Type}`;
        });
        const networks = Object.keys(c.NetworkSettings?.Networks ?? {});

        const status: ContainerInfo["status"] = c.State === "running" ? "running" : "stopped";

        return {
          id: c.Id?.slice(0, 12) ?? "ukjent",
          name: c.Names[0]?.replace(/^\//, "") ?? "ukjent",
          status,
          image: c.Image,
          startedAt: c.State === "running" ? new Date(c.Created * 1000).toISOString() : null,
          ports,
          networks,
        };
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "running" ? -1 : 1;
        return a.name.localeCompare(b.name, "nb");
      });
  } catch {
    return [];
  }
}

function getCertStatus(): CertInfo[] {
  try {
    const raw = readFileSync(ACME_PATH, "utf8");
    const acme = JSON.parse(raw) as Record<string, {
      Certificates?: Array<{
        domain: { main: string };
        certificate: string;
      }>;
    }>;

    const certs: CertInfo[] = [];
    const now = Date.now();

    for (const resolver of Object.values(acme)) {
      for (const entry of resolver.Certificates ?? []) {
        const domain = entry.domain.main;
        try {
          const derBuf = Buffer.from(entry.certificate, "base64");
          const x509 = new X509Certificate(derBuf);
          const validTo = new Date(x509.validTo);
          const daysLeft = Math.floor((validTo.getTime() - now) / 86_400_000);

          certs.push({
            domain,
            validTo: validTo.toISOString(),
            daysLeft,
            status: daysLeft < 0 ? "expired" : daysLeft < 14 ? "expiring" : "valid",
          });
        } catch {
          certs.push({ domain, validTo: "", daysLeft: 0, status: "expired" });
        }
      }
    }

    return certs;
  } catch {
    return [];
  }
}

function getRegisteredRoutes(): string[] {
  try {
    const files = readdirSync(DYNAMIC_DIR).filter((f) => f.endsWith(".yml"));
    return files.map((f) => f.replace(".yml", ""));
  } catch {
    return [];
  }
}

function getAgentVersion(): string {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgUrl, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "ukjent";
  } catch {
    return "ukjent";
  }
}

async function getSoftwareInfo(): Promise<SoftwareInfo[]> {
  const out: SoftwareInfo[] = [];

  out.push({ name: "Agent", version: getAgentVersion(), source: "runtime" });
  out.push({ name: "Node.js", version: process.version, source: "runtime" });

  try {
    const dv = await docker.version();
    if (dv.Version) {
      out.push({ name: "Docker Engine", version: dv.Version, source: "runtime" });
    }
  } catch {
    // ignore
  }

  try {
    const all = await docker.listContainers({ all: true });
    const wanted = [
      { match: "traefik", name: "Traefik" },
      { match: "postgres", name: "PostgreSQL" },
      { match: "redis", name: "Redis" },
    ] as const;

    for (const w of wanted) {
      const c = all.find((x) => {
        const n = x.Names?.[0]?.replace(/^\//, "").toLowerCase() ?? "";
        return n.includes(w.match);
      });
      if (!c?.Image) continue;
      out.push({
        name: w.name,
        version: c.Image,
        source: "container",
      });
    }
  } catch {
    // ignore
  }

  return out;
}

function detectOsPrettyName(): string {
  try {
    const raw = readFileSync("/etc/os-release", "utf8");
    const line = raw.split("\n").find((l) => l.startsWith("PRETTY_NAME="));
    if (!line) return `${os.type()} ${os.release()}`;
    return line.replace(/^PRETTY_NAME=/, "").replace(/^"|"$/g, "");
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

function getUpdatesStatus() {
  const now = Date.now();
  if (updatesCache && now - updatesCache.checkedAt < 6 * 60 * 60 * 1000) {
    return updatesCache;
  }

  const checkedAt = now;
  try {
    execSync("command -v apt >/dev/null 2>&1", { timeout: 1500 });
    const out = execSync("bash -lc \"apt list --upgradable 2>/dev/null | sed '1d' | wc -l\"", {
      timeout: 5000,
    })
      .toString()
      .trim();
    const count = Number.parseInt(out, 10);
    updatesCache = {
      manager: "apt",
      status: Number.isFinite(count) && count > 0 ? "updates_available" : "ok",
      count: Number.isFinite(count) ? count : null,
      checkedAt,
    };
    return updatesCache;
  } catch {
    // continue
  }

  try {
    execSync("command -v dnf >/dev/null 2>&1", { timeout: 1500 });
    const out = execSync("bash -lc \"dnf -q check-update || true\"", { timeout: 7000 }).toString();
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("Last metadata expiration check"));
    const count = lines.length > 0 ? lines.length : 0;
    updatesCache = {
      manager: "dnf",
      status: count > 0 ? "updates_available" : "ok",
      count,
      checkedAt,
    };
    return updatesCache;
  } catch {
    // continue
  }

  try {
    execSync("command -v yum >/dev/null 2>&1", { timeout: 1500 });
    const out = execSync("bash -lc \"yum -q check-update || true\"", { timeout: 7000 }).toString();
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    const count = lines.length > 0 ? lines.length : 0;
    updatesCache = {
      manager: "yum",
      status: count > 0 ? "updates_available" : "ok",
      count,
      checkedAt,
    };
    return updatesCache;
  } catch {
    updatesCache = {
      manager: "unknown",
      status: "unknown",
      count: null,
      checkedAt,
    };
    return updatesCache;
  }
}

async function getHostInfo(): Promise<HostInfo> {
  const upd = getUpdatesStatus();
  return {
    hostname: os.hostname(),
    os: detectOsPrettyName(),
    kernel: os.release(),
    arch: os.arch(),
    publicIp: await getPublicIp(),
    updates: {
      manager: upd.manager,
      status: upd.status,
      count: upd.count,
      checkedAt: new Date(upd.checkedAt).toISOString(),
    },
  };
}

async function getPublicIp(): Promise<string | null> {
  const now = Date.now();
  if (publicIpCache && now - publicIpCache.checkedAt < 30 * 60 * 1000) {
    return publicIpCache.value;
  }

  const endpoints = [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://icanhazip.com",
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) continue;
      const text = (await res.text()).trim();
      if (/^[0-9a-fA-F:.]+$/.test(text)) {
        publicIpCache = { value: text, checkedAt: now };
        return text;
      }
    } catch {
      // try next provider
    }
  }

  publicIpCache = { value: null, checkedAt: now };
  return null;
}

export async function getNetworkInfo(): Promise<{ name: string; containers: number }> {
  try {
    const nets = await docker.listNetworks({ filters: { name: [NETWORK_NAME] } });
    const net = nets[0];
    const containers = Object.keys(net?.Containers ?? {}).length;
    return { name: NETWORK_NAME, containers };
  } catch {
    return { name: NETWORK_NAME, containers: 0 };
  }
}
