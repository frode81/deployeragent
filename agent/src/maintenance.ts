import { readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { docker, pruneDanglingImages } from "./docker.js";
import { isTrackedBuildWorkDir } from "./build-workdir-tracker.js";

const WORK_DIR = process.env.WORK_DIR ?? "/tmp/builds";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Mapper i WORK_DIR som ser ut som deploy-arbeidskatalog (nanoid-lignende id). */
const DEPLOY_DIR_NAME_RE = /^[a-zA-Z0-9_-]{8,24}$/;

/** Slett foreldreløse byggmapper eldre enn dette (ms). 0 = deaktiver. */
const ORPHAN_DIR_MAX_AGE_MS = Math.max(0, envInt("DEPLOY_ORPHAN_WORK_DIR_MAX_AGE_MS", 48 * 60 * 60 * 1000));

/** Intervall for lett image-opprydding (ms). 0 = deaktiver periodisk kjøring. */
export const DEPLOY_MAINTENANCE_INTERVAL_MS = Math.max(
  0,
  envInt("DEPLOY_MAINTENANCE_INTERVAL_MS", 30 * 60 * 1000)
);

/** Kall docker build cache prune med dette intervallet (ms). 0 = aldri. */
const BUILDER_PRUNE_INTERVAL_MS = Math.max(0, envInt("DEPLOY_BUILDER_PRUNE_INTERVAL_MS", 24 * 60 * 60 * 1000));

let lastBuilderPrune = 0;

function logLine(msg: string) {
  console.log(`[vedlikehold] ${msg}`);
}

/**
 * Fjerner gamle kataloger under WORK_DIR (typisk etter krasj før `finally`).
 * Hopper over aktive deploy-mapper og navn som ikke matcher deploy-id-mønster.
 */
export function pruneOrphanBuildWorkDirs(): number {
  if (ORPHAN_DIR_MAX_AGE_MS <= 0) return 0;
  const now = Date.now();
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(WORK_DIR);
  } catch {
    return 0;
  }

  for (const name of entries) {
    if (!DEPLOY_DIR_NAME_RE.test(name)) continue;
    const full = join(WORK_DIR, name);
    if (isTrackedBuildWorkDir(full)) continue;
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs < ORPHAN_DIR_MAX_AGE_MS) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export async function runDeployMaintenanceCycle() {
  const orphan = pruneOrphanBuildWorkDirs();
  if (orphan > 0) {
    logLine(`fjernet ${orphan} foreldreløs(e) byggmappe(r) under ${WORK_DIR}`);
  }

  try {
    const pr = await pruneDanglingImages();
    const reclaimed = pr && typeof pr === "object" && "SpaceReclaimed" in pr ? (pr as { SpaceReclaimed?: number }).SpaceReclaimed : undefined;
    if (reclaimed != null && reclaimed > 0) {
      logLine(`image prune (dangling): frigjort ${reclaimed} byte`);
    }
  } catch {
    /* ignore */
  }

  const now = Date.now();
  if (BUILDER_PRUNE_INTERVAL_MS > 0 && now - lastBuilderPrune >= BUILDER_PRUNE_INTERVAL_MS) {
    lastBuilderPrune = now;
    try {
      const r = await docker.pruneBuilder();
      if (r?.SpaceReclaimed && r.SpaceReclaimed > 0) {
        logLine(`build cache prune: frigjort ${r.SpaceReclaimed} byte`);
      }
    } catch (err) {
      logLine(`build cache prune feilet: ${String(err)}`);
    }
  }
}
