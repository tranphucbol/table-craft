import { create } from "zustand";
import type {
  EngineError,
  ExportEvent,
  ExportFormat,
  ExportSource,
  ExportTask,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";

/** One background export as Services lists it (decision 040), never saved. */
export interface ExportEntry {
  readonly datasourceId: string;
  readonly task: ExportTask;
  /** When this window first heard the task end, by its own clock; null while it runs. */
  readonly finishedAt: number | null;
}

export interface ExportRequest {
  readonly source: ExportSource;
  readonly format: ExportFormat;
  readonly path: string;
}

export interface ExportsState {
  /** Oldest first. */
  readonly entries: readonly ExportEntry[];
  /** Tasks asked to stop whose final event has not come yet. */
  readonly cancelling: ReadonlySet<string>;
  /** Failed tasks the user has seen in the popover, so the chip lets them go. */
  readonly seen: ReadonlySet<string>;
  readonly popoverOpen: boolean;
  readonly setPopover: (open: boolean) => void;
  readonly markSeen: (taskIds: readonly string[]) => void;
  /** Rejects when the engine refuses the request; a task that fails later reports through events. */
  readonly start: (datasourceId: string, request: ExportRequest) => Promise<ExportTask>;
  readonly received: (datasourceId: string, event: ExportEvent) => void;
  /**
   * The datasource's engine went away, which stops its exports and removes their partial files:
   * cancelled after a Disconnect (`error` null), failed when the engine exited.
   */
  readonly detached: (datasourceId: string, error: EngineError | null) => void;
  readonly cancel: (taskId: string) => Promise<void>;
  readonly retry: (taskId: string) => Promise<ExportTask | null>;
  /** Drops a finished task from the list; a running one stays. */
  readonly dismiss: (taskId: string) => void;
  /** Resolves with the task once it is done, failed or cancelled. */
  readonly finished: (taskId: string) => Promise<ExportTask>;
}

export interface ExportsDependencies {
  readonly client: (datasourceId: string) => Promise<EngineClient>;
  /** `data.exportStallSeconds`, read when a task starts. */
  readonly stallSeconds: () => number;
  /** The clock `finishedAt` reads; `Date.now` when absent. */
  readonly now?: () => number;
}

const STOPPED_TEXT = "The export stopped and no file was written.";
const RETRY_HINT = "Connect again, then export again.";
const TRAILING_PERIOD = /\.$/;

export function isRunning(entry: ExportEntry): boolean {
  return entry.task.state === "running";
}

function without(set: ReadonlySet<string>, taskId: string): ReadonlySet<string> {
  if (!set.has(taskId)) return set;
  const next = new Set(set);
  next.delete(taskId);
  return next;
}

export function createExportsStore(dependencies: ExportsDependencies) {
  const waiting = new Map<string, ((task: ExportTask) => void)[]>();
  const now = dependencies.now ?? Date.now;

  return create<ExportsState>()((set, get) => {
    function entryOf(taskId: string): ExportEntry | undefined {
      return get().entries.find((entry) => entry.task.taskId === taskId);
    }

    /** Events can overtake the answer that started a task, so whichever comes first adds it. */
    function upsert(datasourceId: string, task: ExportTask): void {
      const current = entryOf(task.taskId);
      // A late progress event must not undo a final state.
      if (current !== undefined && current.task.state !== "running" && task.state === "running") return;
      const finishedAt = task.state === "running" ? null : (current?.finishedAt ?? now());
      const entry: ExportEntry = { datasourceId, task, finishedAt };
      const entries =
        current === undefined
          ? [...get().entries, entry]
          : get().entries.map((existing) => (existing.task.taskId === task.taskId ? entry : existing));
      set(task.state === "running" ? { entries } : { entries, cancelling: without(get().cancelling, task.taskId) });
      if (task.state === "running") return;
      const resolvers = waiting.get(task.taskId) ?? [];
      waiting.delete(task.taskId);
      for (const resolve of resolvers) resolve(task);
    }

    async function begin(
      datasourceId: string,
      call: (client: EngineClient) => Promise<ExportTask>,
    ): Promise<ExportTask> {
      const task = await call(await dependencies.client(datasourceId));
      upsert(datasourceId, task);
      return task;
    }

    return {
      entries: [],
      cancelling: new Set(),
      seen: new Set(),
      popoverOpen: false,
      setPopover: (popoverOpen) => set({ popoverOpen }),
      markSeen(taskIds) {
        const seen = get().seen;
        if (taskIds.every((taskId) => seen.has(taskId))) return;
        set({ seen: new Set([...seen, ...taskIds]) });
      },
      start: (datasourceId, request) =>
        begin(datasourceId, (client) =>
          client.call("export.start", { ...request, stallSeconds: dependencies.stallSeconds() }),
        ),
      received(datasourceId, event) {
        upsert(datasourceId, event.task);
      },
      detached(datasourceId, error) {
        for (const entry of get().entries) {
          if (entry.datasourceId !== datasourceId || !isRunning(entry)) continue;
          upsert(datasourceId, {
            ...entry.task,
            state: error === null ? "cancelled" : "failed",
            error: {
              code: error === null ? "cancelled" : "exportFailed",
              reason: error === null ? "cancelled" : "source",
              message:
                error === null
                  ? `Disconnected while exporting. ${STOPPED_TEXT}`
                  : `${error.message.replace(TRAILING_PERIOD, "")}. ${STOPPED_TEXT}`,
              hint: error === null ? RETRY_HINT : error.hint,
            },
          });
        }
      },
      async cancel(taskId) {
        const entry = entryOf(taskId);
        if (entry === undefined || !isRunning(entry)) return;
        set({ cancelling: new Set([...get().cancelling, taskId]) });
        try {
          const client = await dependencies.client(entry.datasourceId);
          await client.call("export.cancel", { taskId });
        } catch (cause) {
          set({ cancelling: without(get().cancelling, taskId) });
          throw cause;
        }
      },
      async retry(taskId) {
        const entry = entryOf(taskId);
        if (entry === undefined || isRunning(entry) || !entry.task.retryable) return null;
        return begin(entry.datasourceId, (client) =>
          client.call("export.retry", { taskId, stallSeconds: dependencies.stallSeconds() }),
        );
      },
      dismiss(taskId) {
        const entry = entryOf(taskId);
        if (entry === undefined || isRunning(entry)) return;
        set({ entries: get().entries.filter((existing) => existing !== entry) });
      },
      finished(taskId) {
        const entry = entryOf(taskId);
        if (entry !== undefined && !isRunning(entry)) return Promise.resolve(entry.task);
        return new Promise((resolve) => {
          waiting.set(taskId, [...(waiting.get(taskId) ?? []), resolve]);
        });
      },
    };
  });
}

export type ExportsStore = ReturnType<typeof createExportsStore>;

/** What a result's owner needs to start an export and hear it end. */
export type ExportStarter = Pick<ExportsState, "start" | "finished">;

export const NO_EXPORTS: ExportStarter = {
  start: () => Promise.reject(new Error("Exports are not wired in this store.")),
  finished: () => new Promise<ExportTask>(() => undefined),
};

export const useExports = createExportsStore({
  client: (datasourceId) => useDatasources.getState().connect(datasourceId),
  stallSeconds: () => useSettings.getState().settings.data.exportStallSeconds,
});
