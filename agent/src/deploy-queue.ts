function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Maks antall deploy som kjører clone/bygg/deploy samtidig på denne agenten. */
export const DEPLOY_MAX_CONCURRENT = Math.max(1, envInt("DEPLOY_MAX_CONCURRENT", 2));

/** Maks antall deploy som *venter* på slot. 0 = ubegrenset (kun anbefalt internt). */
const DEPLOY_MAX_QUEUED = Math.max(0, envInt("DEPLOY_MAX_QUEUED", 100));

/**
 * Maks tid å vente på ledig slot (ms). 0 = ingen ekstra grense utover kølengde.
 * Når denne utløper fjernes forespørselen fra køen og deploy feiler.
 */
const DEPLOY_QUEUE_SLOT_WAIT_MS = Math.max(0, envInt("DEPLOY_QUEUE_SLOT_WAIT_MS", 0));

interface Queued {
  resolve: () => void;
  reject: (e: Error) => void;
  waitTimer?: NodeJS.Timeout;
}

let activeSlots = 0;
const queue: Queued[] = [];

export function getDeployQueueStats() {
  return {
    activeSlots,
    waiting: queue.length,
    maxConcurrent: DEPLOY_MAX_CONCURRENT,
    maxQueued: DEPLOY_MAX_QUEUED,
  };
}

export async function acquireDeploySlot(log: (msg: string) => void): Promise<void> {
  if (activeSlots < DEPLOY_MAX_CONCURRENT) {
    activeSlots += 1;
    if (activeSlots > 1 || queue.length > 0) {
      log(`Byggkapasitet: ${activeSlots}/${DEPLOY_MAX_CONCURRENT} slot(er) i bruk.`);
    }
    return;
  }

  if (DEPLOY_MAX_QUEUED > 0 && queue.length >= DEPLOY_MAX_QUEUED) {
    throw new Error(
      `Deploy-kø er full (maks ${DEPLOY_MAX_QUEUED} ventende). Prøv igjen senere.`
    );
  }

  log(
    `Venter på ledig byggkapasitet (${queue.length + 1}. i køen, maks ${DEPLOY_MAX_CONCURRENT} samtidige deploy)…`
  );

  await new Promise<void>((resolve, reject) => {
    const w: Queued = {
      resolve: () => {
        if (w.waitTimer) clearTimeout(w.waitTimer);
        activeSlots += 1;
        log("Fikk plass i bygg-kø — fortsetter.");
        resolve();
      },
      reject: (e: Error) => {
        if (w.waitTimer) clearTimeout(w.waitTimer);
        reject(e);
      },
    };

    if (DEPLOY_QUEUE_SLOT_WAIT_MS > 0) {
      w.waitTimer = setTimeout(() => {
        const idx = queue.indexOf(w);
        if (idx >= 0) queue.splice(idx, 1);
        w.reject(
          new Error(
            `Tidsavbrudd i deploy-kø (${Math.round(DEPLOY_QUEUE_SLOT_WAIT_MS / 1000)} s). Prøv igjen senere.`
          )
        );
      }, DEPLOY_QUEUE_SLOT_WAIT_MS);
    }

    queue.push(w);
  });
}

export function releaseDeploySlot() {
  if (queue.length > 0) {
    const next = queue.shift()!;
    next.resolve();
  } else {
    activeSlots = Math.max(0, activeSlots - 1);
  }
}
