import { create } from "zustand";
import type { EngineError, ScriptEvent, ScriptTask } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

/** One Run SQL Script task as Services lists it (decision 081), never saved. */
export interface ScriptEntry {
  readonly datasourceId: string;
  readonly task: ScriptTask;
}

export interface ScriptsState {
  /** Oldest first. */
  readonly entries: readonly ScriptEntry[];
  /** Rejects when the engine refuses the request; a task that fails later reports through events. */
  readonly start: (
    datasourceId: string,
    files: readonly string[],
    namespace: readonly string[] | null,
  ) => Promise<ScriptTask>;
  readonly received: (datasourceId: string, event: ScriptEvent) => void;
  /** The datasource's engine went away, and with it the script's connection. */
  readonly detached: (datasourceId: string, error: EngineError | null) => void;
  readonly cancel: (taskId: string) => Promise<void>;
  /** Drops a finished task from the list; a running one stays. */
  readonly dismiss: (taskId: string) => void;
  /** Resolves with the task once it is done, failed or cancelled. */
  readonly finished: (taskId: string) => Promise<ScriptTask>;
}

export interface ScriptsDependencies {
  readonly client: (datasourceId: string) => Promise<EngineClient>;
}

const TRAILING_PERIOD = /\.$/;
const KEPT = "Statements that finished before it stopped stay applied.";
const AGAIN_HINT = "Connect again, then check what ran before running the script again.";

export function isScriptRunning(entry: ScriptEntry): boolean {
  return entry.task.state === "running";
}

export function createScriptsStore(dependencies: ScriptsDependencies) {
  const waiting = new Map<string, ((task: ScriptTask) => void)[]>();

  return create<ScriptsState>()((set, get) => {
    function entryOf(taskId: string): ScriptEntry | undefined {
      return get().entries.find((entry) => entry.task.taskId === taskId);
    }

    /** Events can overtake the answer that started a task, so whichever comes first adds it. */
    function upsert(datasourceId: string, task: ScriptTask): void {
      const current = entryOf(task.taskId);
      // A late progress event must not undo a final state.
      if (current !== undefined && current.task.state !== "running" && task.state === "running") return;
      const entry = { datasourceId, task };
      const entries =
        current === undefined
          ? [...get().entries, entry]
          : get().entries.map((existing) => (existing.task.taskId === task.taskId ? entry : existing));
      set({ entries });
      if (task.state === "running") return;
      const resolvers = waiting.get(task.taskId) ?? [];
      waiting.delete(task.taskId);
      for (const resolve of resolvers) resolve(task);
    }

    return {
      entries: [],
      async start(datasourceId, files, namespace) {
        const client = await dependencies.client(datasourceId);
        const task = await client.call("script.run", { files, namespace });
        upsert(datasourceId, entryOf(task.taskId)?.task ?? task);
        return task;
      },
      received(datasourceId, event) {
        upsert(datasourceId, event.task);
      },
      detached(datasourceId, error) {
        for (const entry of get().entries) {
          if (entry.datasourceId !== datasourceId || !isScriptRunning(entry)) continue;
          const why = error === null ? "Disconnected while running" : error.message.replace(TRAILING_PERIOD, "");
          upsert(datasourceId, {
            ...entry.task,
            state: error === null ? "cancelled" : "failed",
            error: {
              code: error === null ? "cancelled" : "scriptFailed",
              message: `${why}. ${KEPT}`,
              hint: error === null ? AGAIN_HINT : error.hint,
              file: null,
              line: null,
              column: null,
              statement: null,
            },
          });
        }
      },
      async cancel(taskId) {
        const entry = entryOf(taskId);
        if (entry === undefined || !isScriptRunning(entry)) return;
        const client = await dependencies.client(entry.datasourceId);
        await client.call("script.cancel", { taskId });
      },
      dismiss(taskId) {
        const entry = entryOf(taskId);
        if (entry === undefined || isScriptRunning(entry)) return;
        set({ entries: get().entries.filter((existing) => existing !== entry) });
      },
      finished(taskId) {
        const entry = entryOf(taskId);
        if (entry !== undefined && !isScriptRunning(entry)) return Promise.resolve(entry.task);
        return new Promise((resolve) => {
          waiting.set(taskId, [...(waiting.get(taskId) ?? []), resolve]);
        });
      },
    };
  });
}

export type ScriptsStore = ReturnType<typeof createScriptsStore>;

export const useScripts = createScriptsStore({
  client: (datasourceId) => useDatasources.getState().connect(datasourceId),
});
