import { MCP_ACTIVITY_LIMIT, type McpActivityView, type McpRunView } from "@table-craft/desktop/settings/mcp.js";

/** A target longer than this is cut in the status, which every window receives on each call. */
export const ACTIVITY_TARGET_CHARS = 500;
const ELLIPSIS = "…";

export interface Activity {
  add(entry: Omit<McpActivityView, "id">): void;
  list(): readonly McpActivityView[];
}

function cut(text: string | null): string | null {
  if (text === null || text.length <= ACTIVITY_TARGET_CHARS) return text;
  return `${text.slice(0, ACTIVITY_TARGET_CHARS)}${ELLIPSIS}`;
}

export function createActivity(onChange: () => void, limit = MCP_ACTIVITY_LIMIT): Activity {
  let entries: McpActivityView[] = [];
  let next = 0;
  return {
    add(entry) {
      next += 1;
      entries = [{ ...entry, id: next, target: cut(entry.target), message: cut(entry.message) }, ...entries].slice(
        0,
        limit,
      );
      onChange();
    },
    list: () => entries,
  };
}

export interface Runs {
  /** Tracks `work` while it runs; `cancel` is how the Services tree stops it, null when it cannot. */
  track<T>(
    run: Omit<McpRunView, "id" | "startedAt" | "cancellable">,
    cancel: (() => Promise<void>) | null,
    work: () => Promise<T>,
  ): Promise<T>;
  /** False when the run has finished already or cannot be cancelled. */
  cancel(id: string): Promise<boolean>;
  list(): readonly McpRunView[];
}

export function createRuns(onChange: () => void, now: () => number): Runs {
  const runs = new Map<string, { readonly view: McpRunView; readonly cancel: (() => Promise<void>) | null }>();
  let next = 0;
  return {
    async track(run, cancel, work) {
      next += 1;
      const id = `run-${String(next)}`;
      runs.set(id, {
        view: { ...run, sql: cut(run.sql) ?? "", id, startedAt: now(), cancellable: cancel !== null },
        cancel,
      });
      onChange();
      try {
        return await work();
      } finally {
        runs.delete(id);
        onChange();
      }
    },
    async cancel(id) {
      const run = runs.get(id);
      if (run === undefined || run.cancel === null) return false;
      await run.cancel();
      return true;
    },
    list: () => [...runs.values()].map((run) => run.view),
  };
}
