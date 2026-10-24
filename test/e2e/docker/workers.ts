/**
 * How many smoke files the headless box runs at once, and which virtual display each worker draws
 * on (decision 096). Pure, so the runner on the host and the Vitest config in the box share it.
 */

export const WORKERS_ENV = "TABLE_CRAFT_SMOKE_WORKERS";
/** Three Electron apps, their engines and the databases fit in 8 GiB without swapping (plan 051). */
export const SMOKE_WORKERS_DEFAULT = 3;
export const SMOKE_WORKERS_MIN_VM_BYTES = 8 * 1024 ** 3;
const GIB = 1024 ** 3;

export interface WorkerChoice {
  readonly workers: number;
  /** Why this many, for the run's log. */
  readonly reason: string;
}

/**
 * `TABLE_CRAFT_SMOKE_WORKERS` when set, else three on a Docker VM of 8 GiB or more and one below;
 * `vmBytes` is `undefined` when Docker did not say.
 */
export function resolveWorkers(given: string | undefined, vmBytes: number | undefined): WorkerChoice {
  if (given !== undefined && given !== "") {
    const workers = Number(given);
    if (!Number.isInteger(workers) || workers < 1) {
      throw new Error(
        `${WORKERS_ENV} must be a whole number of 1 or more, not "${given}"; unset it to choose by memory.`,
      );
    }
    return { workers, reason: `${String(workers)} smoke worker(s), from ${WORKERS_ENV}` };
  }
  const size = vmBytes === undefined ? "an unknown amount of memory" : `${(vmBytes / GIB).toFixed(1)} GiB`;
  if (vmBytes !== undefined && vmBytes >= SMOKE_WORKERS_MIN_VM_BYTES) {
    return {
      workers: SMOKE_WORKERS_DEFAULT,
      reason: `${String(SMOKE_WORKERS_DEFAULT)} smoke workers: the Docker VM has ${size}`,
    };
  }
  return {
    workers: 1,
    reason:
      `1 smoke worker: the Docker VM has ${size}, under 8 GiB. For ${String(SMOKE_WORKERS_DEFAULT)}, give it 8 GiB ` +
      "(OrbStack: `orb config set memory_mib 8192`; Docker Desktop: Settings > Resources > Memory) " +
      `or set ${WORKERS_ENV}.`,
  };
}

/**
 * The X display worker `poolId` draws on: the box starts `:1` to `:workers`, one per worker, so
 * focus, the keyboard and the clipboard (an X selection) stay per worker.
 */
export function displayFor(poolId: string | undefined, workers: number): string {
  const id = Number(poolId ?? "1");
  const index = Number.isInteger(id) && id >= 1 ? ((id - 1) % workers) + 1 : 1;
  return `:${String(index)}`;
}
