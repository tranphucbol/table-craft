import { create } from "zustand";
import type { ServerMessage } from "@table-craft/desktop/engine/protocol.js";

const NO_MESSAGES: readonly ServerMessage[] = [];

/** Executions kept per open tab; the oldest goes past it (plan 011, decision 11). */
export const EXECUTIONS_PER_SESSION = 50;

export type ExecutionOutcome = "running" | "success" | "error" | "cancelled";

/** One thing a console or table tab sent to its session, as Services lists it; never saved. */
export interface Execution {
  readonly id: number;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  /** Null while running. */
  readonly durationMs: number | null;
  readonly outcome: ExecutionOutcome;
  /** A console statement's first line, or what a table did: `Load rows`, `Count rows`, `Submit 2 statements`. */
  readonly label: string;
  /** The text sent, when there is one to copy or reopen. */
  readonly sql: string | null;
  readonly rowCount: number | null;
  readonly message: string | null;
  /** What the server said about the statement (decision 066); empty until its result is complete. */
  readonly messages: readonly ServerMessage[];
}

export interface ExecutionStart {
  readonly label: string;
  readonly sql: string | null;
  readonly startedAt: number;
}

export interface ExecutionEnd {
  readonly durationMs: number;
  readonly outcome: Exclude<ExecutionOutcome, "running">;
  readonly rowCount: number | null;
  readonly message: string | null;
  readonly messages?: readonly ServerMessage[];
  /** What only the answer tells: a table load's SQL, how many statements a submit ran. */
  readonly label?: string;
  readonly sql?: string | null;
}

/** What a session reports to: the executions store, or nothing in a test that does not look. */
export interface ExecutionReporter {
  /** Answers the id `finish` takes. */
  readonly start: (tabId: string, start: ExecutionStart) => number;
  readonly finish: (tabId: string, executionId: number, end: ExecutionEnd) => void;
  /**
   * Fetch Next Page or Fetch All grew the result the execution produced to `rowCount` rows, and
   * brought the server's `messages` when it read the last row.
   */
  readonly recount: (tabId: string, executionId: number, rowCount: number, messages?: readonly ServerMessage[]) => void;
}

/** A reporter for a store built without Services. */
export const NO_EXECUTION_REPORTER: ExecutionReporter = {
  start: () => 0,
  finish: () => undefined,
  recount: () => undefined,
};

export interface ExecutionsState extends ExecutionReporter {
  /** Newest first, by tab id. */
  readonly byTab: Readonly<Record<string, readonly Execution[]>>;
  /** Clear Executions: the tab stays, its list empties. */
  readonly clear: (tabId: string) => void;
  /** The tab closed: its executions go with it. */
  readonly drop: (tabId: string) => void;
}

export const NO_EXECUTIONS: readonly Execution[] = [];

export function createExecutionsStore(limit = EXECUTIONS_PER_SESSION) {
  let ids = 0;
  return create<ExecutionsState>()((set, get) => ({
    byTab: {},

    start(tabId, start) {
      const id = ++ids;
      const execution: Execution = {
        id,
        ...start,
        durationMs: null,
        outcome: "running",
        rowCount: null,
        message: null,
        messages: NO_MESSAGES,
      };
      const kept = get().byTab[tabId] ?? NO_EXECUTIONS;
      set({ byTab: { ...get().byTab, [tabId]: [execution, ...kept].slice(0, limit) } });
      return id;
    },

    finish(tabId, executionId, end) {
      const kept = get().byTab[tabId];
      if (kept === undefined || !kept.some((execution) => execution.id === executionId)) return;
      set({
        byTab: {
          ...get().byTab,
          [tabId]: kept.map((execution) => (execution.id === executionId ? { ...execution, ...end } : execution)),
        },
      });
    },

    recount(tabId, executionId, rowCount, messages) {
      const kept = get().byTab[tabId];
      if (kept === undefined || !kept.some((execution) => execution.id === executionId)) return;
      const change = messages === undefined ? { rowCount } : { rowCount, messages };
      set({
        byTab: {
          ...get().byTab,
          [tabId]: kept.map((execution) => (execution.id === executionId ? { ...execution, ...change } : execution)),
        },
      });
    },

    clear(tabId) {
      if (get().byTab[tabId] === undefined) return;
      set({ byTab: { ...get().byTab, [tabId]: NO_EXECUTIONS } });
    },

    drop(tabId) {
      if (get().byTab[tabId] === undefined) return;
      const { [tabId]: _dropped, ...rest } = get().byTab;
      set({ byTab: rest });
    },
  }));
}

export type ExecutionsStore = ReturnType<typeof createExecutionsStore>;

export const useExecutions = createExecutionsStore();
