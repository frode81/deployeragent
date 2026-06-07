/** Mapper under WORK_DIR som tilhører pågående deploy (ikke slettes av vedlikehold). */
const active = new Set<string>();

export function trackBuildWorkDir(dir: string) {
  active.add(dir);
}

export function untrackBuildWorkDir(dir: string) {
  active.delete(dir);
}

export function isTrackedBuildWorkDir(dir: string) {
  return active.has(dir);
}
