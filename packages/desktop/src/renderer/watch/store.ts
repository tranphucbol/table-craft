import { create } from "zustand";
import type {
  KeyTask,
  KeyWatchRequest,
  KeyWatchSummary,
  KeyWatchWindow,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

export const WATCH_WINDOW_COUNT = 500;
export const WATCH_WINDOW_BYTES = 1_048_576;
export const WATCH_RING_BYTES = 67_108_864;
export const WATCH_DEFAULT_RETENTION = 10_000;
const RATE_SAMPLES = 60;
export interface WatchEntry {
  readonly datasourceId: string;
  readonly summary: KeyWatchSummary;
  readonly rows: KeyWatchWindow["rows"];
  readonly retained: KeyWatchWindow["rows"];
  readonly pending: number;
  readonly displayEvicted: number;
  readonly paused: boolean;
  readonly cursor: string | null;
  readonly error: string | null;
  readonly rates: readonly number[];
  readonly readAt: number;
}
interface WatchState {
  readonly entries: Readonly<Record<string, WatchEntry>>;
  readonly activeId: string | null;
  readonly start: (datasourceId: string, request: KeyWatchRequest, retention?: number) => Promise<void>;
  readonly poll: (id: string) => Promise<void>;
  readonly select: (id: string) => void;
  readonly pause: (id: string) => void;
  readonly clear: (id: string) => Promise<void>;
  readonly stop: (id: string, close?: boolean) => Promise<void>;
  readonly detach: (datasourceId: string) => void;
  /** The newest retained-events export per watch, as the engine's task list last reported it. */
  readonly exports: Readonly<Record<string, KeyTask>>;
  readonly exportStart: (id: string, fileGrantId: string) => Promise<void>;
  readonly exportPoll: () => Promise<void>;
  readonly exportCancel: (id: string) => Promise<void>;
}
export function exportRunning(task: KeyTask | undefined): boolean {
  return task?.state === "running";
}
export function appendWatchRows(
  old: KeyWatchWindow["rows"],
  rows: KeyWatchWindow["rows"],
  limit: number,
): KeyWatchWindow["rows"] {
  const seen = new Set(old.map((row) => row.sequence));
  return [...old, ...rows.filter((row) => !seen.has(row.sequence))].slice(-limit);
}
export function createWatchStore(connect: (id: string) => Promise<EngineClient>) {
  const busy = new Set<string>();
  const generations = new Map<string, number>();
  const limits = new Map<string, number>();
  const epochs = new Map<string, number>();
  const exportTasks = new Map<string, { readonly datasourceId: string; readonly watchId: string }>();
  let exportPolling = false;
  return create<WatchState>()((set, get) => {
    const putExport = (watchId: string, task: KeyTask) => set({ exports: { ...get().exports, [watchId]: task } });
    const patch = (id: string, change: Partial<WatchEntry>) => {
      const entry = get().entries[id];
      if (entry !== undefined) set({ entries: { ...get().entries, [id]: { ...entry, ...change } } });
    };
    return {
      entries: {},
      activeId: null,
      exports: {},
      async exportStart(id, fileGrantId) {
        const entry = get().entries[id];
        if (entry === undefined) return;
        if (exportRunning(get().exports[id]))
          throw new Error("This watch is already being exported. Wait for it to finish or cancel it.");
        const task = await (await connect(entry.datasourceId)).call("watch.exportStart", { watchId: id, fileGrantId });
        exportTasks.set(task.taskId, { datasourceId: entry.datasourceId, watchId: id });
        putExport(id, task);
      },
      async exportPoll() {
        if (exportPolling) return;
        const sources = new Set<string>();
        for (const [taskId, owner] of exportTasks)
          if (exportRunning(get().exports[owner.watchId]) && get().exports[owner.watchId]?.taskId === taskId)
            sources.add(owner.datasourceId);
        if (sources.size === 0) return;
        exportPolling = true;
        try {
          for (const source of sources) {
            const tasks = await (await connect(source)).call("watch.exportList", {}).catch(() => null);
            if (tasks === null) continue;
            for (const task of tasks) {
              const owner = exportTasks.get(task.taskId);
              if (owner === undefined || get().exports[owner.watchId]?.taskId !== task.taskId) continue;
              putExport(owner.watchId, task);
              if (!exportRunning(task)) exportTasks.delete(task.taskId);
            }
          }
        } finally {
          exportPolling = false;
        }
      },
      async exportCancel(id) {
        const task = get().exports[id];
        const owner = task === undefined ? undefined : exportTasks.get(task.taskId);
        if (task === undefined || owner === undefined || !exportRunning(task)) return;
        await (await connect(owner.datasourceId)).call("watch.exportCancel", { taskId: task.taskId });
        await get().exportPoll();
      },
      async start(datasourceId, request, retention = WATCH_DEFAULT_RETENTION) {
        const generation = generations.get(datasourceId) ?? 0;
        const client = await connect(datasourceId);
        const summary = await client.call("watch.start", {
          ...request,
          maxEvents: retention,
          maxBytes: WATCH_RING_BYTES,
        });
        if ((generations.get(datasourceId) ?? 0) !== generation) {
          await client.call("watch.stop", { watchId: summary.watchId });
          return;
        }
        limits.set(summary.watchId, retention);
        set({
          activeId: summary.watchId,
          entries: {
            ...get().entries,
            [summary.watchId]: {
              datasourceId,
              summary,
              rows: [],
              retained: [],
              pending: 0,
              displayEvicted: 0,
              paused: false,
              cursor: null,
              error: null,
              rates: [],
              readAt: Date.now(),
            },
          },
        });
        await get().poll(summary.watchId);
      },
      async poll(id) {
        const entry = get().entries[id];
        if (entry === undefined || busy.has(id) || entry.summary.state === "stopped") return;
        busy.add(id);
        const epoch = epochs.get(id) ?? 0;
        try {
          const window = await (
            await connect(entry.datasourceId)
          ).call("watch.window", {
            watchId: id,
            afterSequence: entry.cursor,
            count: WATCH_WINDOW_COUNT,
            maxBytes: WATCH_WINDOW_BYTES,
          });
          const current = get().entries[id];
          if (current === undefined || current.summary.state === "stopped" || (epochs.get(id) ?? 0) !== epoch) return;
          const now = Date.now();
          const rate = window.rows.length / Math.max(1, (now - current.readAt) / 1000);
          const retained = appendWatchRows(current.retained, window.rows, limits.get(id) ?? WATCH_DEFAULT_RETENTION);
          patch(id, {
            summary: {
              ...current.summary,
              state: window.state,
              gap: window.gap,
              completedRevision: window.completedRevision,
              evictedEvents: window.evictedEvents,
            },
            retained,
            rows: current.paused ? current.rows : retained,
            pending: current.paused ? current.pending + window.rows.length : 0,
            displayEvicted:
              current.displayEvicted + Math.max(0, current.retained.length + window.rows.length - retained.length),
            cursor: window.rows.at(-1)?.sequence ?? current.cursor,
            rates: [...current.rates, rate].slice(-RATE_SAMPLES),
            readAt: now,
            error: null,
          });
        } catch (cause) {
          patch(id, { error: cause instanceof Error ? cause.message : String(cause) });
        } finally {
          busy.delete(id);
        }
      },
      select: (id) => set({ activeId: id }),
      pause(id) {
        const entry = get().entries[id];
        if (entry !== undefined) patch(id, { paused: !entry.paused, rows: entry.retained, pending: 0 });
      },
      async clear(id) {
        const entry = get().entries[id];
        if (entry === undefined) return;
        await (await connect(entry.datasourceId)).call("watch.clear", { watchId: id });
        epochs.set(id, (epochs.get(id) ?? 0) + 1);
        patch(id, { rows: [], retained: [], pending: 0 });
      },
      async stop(id, close = false) {
        const entry = get().entries[id];
        if (entry === undefined) return;
        if (entry.summary.state !== "stopped")
          await (await connect(entry.datasourceId)).call("watch.stop", { watchId: id });
        if (!close) {
          patch(id, { summary: { ...entry.summary, state: "stopped" } });
          return;
        }
        const { [id]: _gone, ...entries } = get().entries;
        limits.delete(id);
        set({ entries, activeId: get().activeId === id ? (Object.keys(entries).at(-1) ?? null) : get().activeId });
      },
      detach(datasourceId) {
        generations.set(datasourceId, (generations.get(datasourceId) ?? 0) + 1);
        for (const [taskId, owner] of exportTasks) {
          if (owner.datasourceId !== datasourceId) continue;
          exportTasks.delete(taskId);
          const task = get().exports[owner.watchId];
          if (task?.taskId === taskId && exportRunning(task))
            putExport(owner.watchId, {
              ...task,
              state: "failed",
              outcome: "uncertain",
              error: "Disconnected before the export finished. Check the destination folder before exporting again.",
            });
        }
        for (const [id, entry] of Object.entries(get().entries))
          if (entry.datasourceId === datasourceId)
            patch(id, {
              summary: { ...entry.summary, state: "stopped" },
              error:
                "Disconnected. This watch stopped; start a new watch after reconnecting. Retained events remain available.",
            });
      },
    };
  });
}
export const useWatch = createWatchStore((id) => useDatasources.getState().connect(id));
