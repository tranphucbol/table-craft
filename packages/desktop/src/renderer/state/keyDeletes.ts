import { create } from "zustand";
import type { EngineError, KeyName } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";

/** Keys one `keyspace.remove` call unlinks (plan 058 decision 17), so Cancel stops within a batch. */
export const KEY_DELETE_BATCH = 500;

export type KeyDeleteState = "running" | "completed" | "cancelled" | "failed";

/** Delete Keys Under Folder as a Services task: the folder, how far it got, and why it stopped. */
export interface KeyDeleteTask {
  readonly taskId: string;
  readonly datasourceId: string;
  readonly database: number;
  /** The folder's prefix, delimiter included: `user:42:`. */
  readonly prefix: string;
  readonly state: KeyDeleteState;
  readonly total: number;
  readonly deleted: number;
  readonly error: EngineError | null;
}

export interface KeyDeletesState {
  /** Oldest first. */
  readonly tasks: readonly KeyDeleteTask[];
  readonly start: (
    datasourceId: string,
    database: number,
    prefix: string,
    keys: readonly KeyName[],
  ) => Promise<KeyDeleteTask>;
  readonly cancel: (taskId: string) => void;
  readonly dismiss: (taskId: string) => void;
}

export interface KeyDeletesDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  /** Told after each batch, so the key tree drops what is gone. */
  readonly removed?: (datasourceId: string, database: number, keys: readonly KeyName[]) => void;
}

export function keyDeleteText(task: KeyDeleteTask): string {
  return `${task.deleted.toLocaleString("en-US")} of ${task.total.toLocaleString("en-US")}`;
}

export function createKeyDeletesStore(dependencies: KeyDeletesDependencies) {
  const cancelled = new Set<string>();
  let started = 0;
  return create<KeyDeletesState>()((set, get) => {
    const patch = (taskId: string, change: Partial<KeyDeleteTask>) =>
      set((state) => ({ tasks: state.tasks.map((task) => (task.taskId === taskId ? { ...task, ...change } : task)) }));
    const taskOf = (taskId: string) => get().tasks.find((task) => task.taskId === taskId);

    return {
      tasks: [],

      async start(datasourceId, database, prefix, keys) {
        const taskId = `key-delete-${String(started++)}`;
        const task: KeyDeleteTask = {
          taskId,
          datasourceId,
          database,
          prefix,
          state: "running",
          total: keys.length,
          deleted: 0,
          error: null,
        };
        set((state) => ({ tasks: [...state.tasks, task] }));
        try {
          const client = await dependencies.connect(datasourceId);
          for (let from = 0; from < keys.length; from += KEY_DELETE_BATCH) {
            if (cancelled.has(taskId)) {
              patch(taskId, { state: "cancelled" });
              return taskOf(taskId) ?? task;
            }
            const batch = keys.slice(from, from + KEY_DELETE_BATCH);
            const removed = await client.call("keyspace.remove", { database, keys: batch });
            dependencies.removed?.(datasourceId, database, batch);
            patch(taskId, { deleted: (taskOf(taskId)?.deleted ?? 0) + removed });
          }
          patch(taskId, { state: "completed" });
        } catch (cause) {
          patch(taskId, { state: "failed", error: toError(cause) });
        } finally {
          cancelled.delete(taskId);
        }
        return taskOf(taskId) ?? task;
      },

      cancel(taskId) {
        if (taskOf(taskId)?.state === "running") cancelled.add(taskId);
      },

      dismiss(taskId) {
        if (taskOf(taskId)?.state === "running") return;
        set((state) => ({ tasks: state.tasks.filter((task) => task.taskId !== taskId) }));
      },
    };
  });
}

export type KeyDeletesStore = ReturnType<typeof createKeyDeletesStore>;

export const useKeyDeletes = createKeyDeletesStore({
  connect: (datasourceId) => useDatasources.getState().connect(datasourceId),
  removed: (datasourceId, database, keys) => useKeys.getState().forget(datasourceId, database, keys),
});
