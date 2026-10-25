import { create } from "zustand";
import type {
  EngineError,
  KeyDetails,
  KeyName,
  KeyReadRange,
  KeyType,
  SortKey,
  WireValue,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { carriedLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { clampSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { NO_EXPORTS, useExports, type ExportStarter } from "@table-craft/desktop/renderer/state/exports.js";
import {
  NO_EXECUTION_REPORTER,
  useExecutions,
  type ExecutionReporter,
} from "@table-craft/desktop/renderer/state/executions.js";
import {
  resultTabOf,
  searchedColumnsChanged,
  shownRowCount,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { createResultWindows, toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { currentFormats, currentPaging, statementTimeoutOf } from "@table-craft/desktop/renderer/state/settings.js";

/** Which key a key tab shows (plan 058 decision 14). */
export interface KeyTarget {
  readonly datasourceId: string;
  readonly database: number;
  readonly key: KeyName;
}

export type KeyTabStatus = "connecting" | "ready" | "loading" | "failed" | "disconnected";

/** The filter bar's fields: a MATCH glob for hashes, sets and sorted sets, From and To ids for streams. */
export interface KeyRangeDraft {
  readonly match: string;
  readonly from: string;
  readonly to: string;
}

export const EMPTY_RANGE: KeyRangeDraft = { match: "", from: "", to: "" };

export interface KeyTab extends KeyTarget {
  readonly sessionId: string | null;
  readonly status: KeyTabStatus;
  /** What went wrong reaching the server. */
  readonly error: EngineError | null;
  /** What the server said of the last read, such as a bad MATCH pattern. */
  readonly queryError: EngineError | null;
  /** Null until the first read answers. */
  readonly details: KeyDetails | null;
  /** When `details` was read, by the store's clock: the TTL counts down from it. */
  readonly readAt: number | null;
  /** A string key's value; null for the other types, which show rows. */
  readonly value: WireValue | null;
  /** Why the key opens read-only, such as a RedisJSON document; null when it takes edits. */
  readonly readOnly: string | null;
  readonly result: ResultTab | null;
  readonly applied: KeyRangeDraft;
  readonly draft: KeyRangeDraft;
}

export interface KeyTabsState {
  readonly tabs: Readonly<Record<string, KeyTab>>;
  readonly open: (id: string, target: KeyTarget, options?: { readonly connect?: boolean }) => Promise<void>;
  readonly close: (id: string) => void;
  readonly detach: (datasourceId: string, error: EngineError | null) => void;
  /** Reads the key again with the filter bar's fields; false when it could not. */
  readonly reload: (id: string, range?: KeyRangeDraft) => Promise<boolean>;
  readonly setDraft: (id: string, draft: Partial<KeyRangeDraft>) => void;
  readonly revertDraft: (id: string) => void;
  readonly ensureWindow: (id: string, resultId: string, offset: number) => void;
  readonly fetchMore: (id: string, resultId: string, all: boolean) => Promise<void>;
  readonly stopFetch: (id: string, resultId: string) => Promise<void>;
  readonly sort: (id: string, resultId: string, keys: readonly SortKey[]) => Promise<void>;
  readonly setLayout: KeyTabsHost["setLayout"];
  readonly select: KeyTabsHost["select"];
  readonly extract: KeyTabsHost["extract"];
  readonly exportTo: KeyTabsHost["exportTo"];
  readonly search: KeyTabsHost["search"];
  readonly findNext: KeyTabsHost["findNext"];
}

type ResultWindows = ReturnType<typeof createResultWindows>;

interface KeyTabsHost {
  readonly setLayout: (id: string, resultId: string, layout: ResultTab["layout"]) => void;
  readonly select: (id: string, resultId: string, selection: ResultTab["selection"]) => void;
  readonly extract: ResultWindows["extract"];
  readonly exportTo: (...args: Parameters<ResultWindows["exportTo"]>) => Promise<boolean>;
  readonly search: ResultWindows["search"];
  readonly findNext: ResultWindows["findNext"];
}

export interface KeyTabsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  /** Milliseconds for the TTL countdown; `Date.now` outside tests. */
  readonly clock?: () => number;
  readonly executions?: ExecutionReporter;
  readonly exports?: ExportStarter;
  readonly statementTimeout?: (datasourceId: string) => number;
}

const LOAD_LABEL = "Read key";

/** Which filter fields a key type reads: streams page by id, the scanned types by MATCH. */
export function rangeFields(type: KeyType | null): "match" | "ids" | null {
  if (type === "hash" || type === "set" || type === "zset") return "match";
  if (type === "stream") return "ids";
  return null;
}

/** The read range the filter bar's fields ask for; blank fields read everything. */
export function keyRangeOf(type: KeyType | null, draft: KeyRangeDraft): KeyReadRange {
  const fields = rangeFields(type);
  const match = draft.match.trim();
  const from = draft.from.trim();
  const to = draft.to.trim();
  if (fields === "match") return match === "" ? {} : { match };
  if (fields === "ids") return { ...(from === "" ? {} : { from }), ...(to === "" ? {} : { to }) };
  return {};
}

/** The TTL left now, counted down from when the key was read; null when it does not expire. */
export function remainingTtl(details: KeyDetails | null, readAt: number | null, now: number): number | null {
  if (details?.ttlMs == null || readAt === null) return null;
  return Math.max(0, details.ttlMs - Math.max(0, now - readAt));
}

/** The key is gone: a read answered that no key has the name. */
export function keyMissing(tab: KeyTab): boolean {
  return tab.details !== null && tab.details.type === null;
}

export function canReloadKey(status: KeyTabStatus): boolean {
  return status !== "connecting" && status !== "loading";
}

function newTab(target: KeyTarget): KeyTab {
  return {
    ...target,
    sessionId: null,
    status: "disconnected",
    error: null,
    queryError: null,
    details: null,
    readAt: null,
    value: null,
    readOnly: null,
    result: null,
    applied: EMPTY_RANGE,
    draft: EMPTY_RANGE,
  };
}

export function createKeyTabsStore(dependencies: KeyTabsDependencies) {
  const clients = new Map<string, EngineClient>();
  const clock = dependencies.clock ?? (() => Date.now());
  const executions = dependencies.executions ?? NO_EXECUTION_REPORTER;
  let resultIds = 0;

  return create<KeyTabsState>()((set, get) => {
    const windows = createResultWindows({
      client: (id) => clients.get(id),
      result: (id, resultId) => resultOf(id, resultId),
      update: (id, resultId, change) => updateResult(id, resultId, change),
      failed: (id, _result, error) => patch(id, { error }),
      fetched: () => undefined,
      datasourceOf: (id) => get().tabs[id]?.datasourceId,
      exports: dependencies.exports ?? NO_EXPORTS,
    });

    function patch(id: string, change: Partial<KeyTab>): void {
      const current = get().tabs[id];
      if (current === undefined) return;
      set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    function resultOf(id: string, resultId: string): ResultTab | undefined {
      const result = get().tabs[id]?.result;
      return result?.id === resultId ? result : undefined;
    }

    function updateResult(id: string, resultId: string, change: (result: ResultTab) => ResultTab): void {
      const result = resultOf(id, resultId);
      if (result !== undefined) patch(id, { result: change(result) });
    }

    async function openSession(id: string): Promise<boolean> {
      const current = get().tabs[id];
      if (current === undefined) return false;
      patch(id, { status: "connecting", error: null });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const opened = await client.call("session.open", {});
        if (get().tabs[id] === undefined) {
          void client.call("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
          return false;
        }
        clients.set(id, client);
        patch(id, { sessionId: opened.sessionId, status: "ready", error: null });
        return true;
      } catch (cause) {
        patch(id, { status: "failed", error: toError(cause) });
        return false;
      }
    }

    function settled(id: string): KeyTabStatus {
      const status = get().tabs[id]?.status;
      return status === "disconnected" || status === "failed" ? status : "ready";
    }

    function release(id: string, result: ResultTab | null): void {
      if (result === null) return;
      windows.forget(result.id);
      const client = clients.get(id);
      if (!result.stale) void client?.call("result.release", { handle: result.handle }).catch(() => undefined);
    }

    async function read(id: string, draft: KeyRangeDraft): Promise<boolean> {
      const before = get().tabs[id];
      if (before === undefined || !canReloadKey(before.status)) return false;
      if (before.status !== "ready" && !(await openSession(id))) return false;
      const current = get().tabs[id];
      const client = clients.get(id);
      if (current?.sessionId == null || client === undefined) return false;
      patch(id, { status: "loading", error: null, draft });
      const executionId = executions.start(id, { label: LOAD_LABEL, sql: current.key.text, startedAt: clock() });
      const begun = clock();
      try {
        const paging = currentPaging();
        const timeoutSeconds = dependencies.statementTimeout?.(current.datasourceId) ?? 0;
        const answer = await client.call("keyspace.open", {
          sessionId: current.sessionId,
          database: current.database,
          key: current.key,
          range: keyRangeOf(current.details?.type ?? null, draft),
          ...paging,
          ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}),
        });
        const rowCount = answer.statement?.rowCount ?? null;
        executions.finish(id, executionId, {
          outcome: "success",
          rowCount,
          message: null,
          durationMs: Math.max(0, clock() - begun),
        });
        const latest = get().tabs[id];
        if (latest === undefined) {
          if (answer.statement !== null) {
            void client.call("result.release", { handle: answer.statement.handle }).catch(() => undefined);
          }
          return false;
        }
        const previous = latest.result;
        release(id, previous);
        let result: ResultTab | null = null;
        if (answer.statement !== null) {
          const fresh = resultTabOf(
            answer.statement,
            { id: `${id}/key-${String(++resultIds)}`, title: current.key.text },
            current.key.text,
            paging,
            currentFormats(),
          );
          const names = (columns: readonly { readonly name: string }[]) => columns.map((column) => column.name);
          const layout =
            previous === null
              ? fresh.layout
              : carriedLayout(previous.layout, names(previous.columns), names(fresh.columns));
          result = { ...fresh, layout };
        }
        patch(id, {
          details: answer.details,
          readAt: clock(),
          value: answer.value,
          readOnly: answer.readOnly,
          result,
          applied: draft,
          draft,
          queryError: null,
        });
        return true;
      } catch (cause) {
        const error = toError(cause);
        executions.finish(id, executionId, {
          outcome: error.code === "cancelled" ? "cancelled" : "error",
          rowCount: null,
          message: error.message,
          durationMs: Math.max(0, clock() - begun),
        });
        if (error.code === "statementFailed") patch(id, { queryError: error });
        else patch(id, { error });
        return false;
      } finally {
        patch(id, { status: settled(id) });
      }
    }

    return {
      tabs: {},

      async open(id, target, options = {}) {
        set({ tabs: { ...get().tabs, [id]: newTab(target) } });
        if (options.connect ?? true) await read(id, EMPTY_RANGE);
      },

      close(id) {
        const closing = get().tabs[id];
        if (closing === undefined) return;
        const { [id]: _closed, ...rest } = get().tabs;
        set({ tabs: rest });
        if (closing.result !== null) windows.forget(closing.result.id);
        const client = clients.get(id);
        clients.delete(id);
        if (closing.sessionId === null || client === undefined) return;
        void client.call("session.close", { sessionId: closing.sessionId }).catch(() => undefined);
      },

      detach(datasourceId, error) {
        for (const [id, tab] of Object.entries(get().tabs)) {
          if (tab.datasourceId !== datasourceId) continue;
          clients.delete(id);
          if (tab.result !== null) windows.invalidate(tab.result.id);
          patch(id, {
            sessionId: null,
            status: error === null ? "disconnected" : "failed",
            error: error ?? tab.error,
            result: tab.result === null ? null : { ...tab.result, stale: true, cursorOpen: false, fetching: null },
          });
        }
      },

      reload: (id, range) => {
        const current = get().tabs[id];
        return current === undefined ? Promise.resolve(false) : read(id, range ?? current.draft);
      },

      setDraft(id, draft) {
        const current = get().tabs[id];
        if (current === undefined) return;
        const next = { ...current.draft, ...draft };
        if (next.match === current.draft.match && next.from === current.draft.from && next.to === current.draft.to) {
          return;
        }
        patch(id, { draft: next });
      },

      revertDraft(id) {
        const current = get().tabs[id];
        if (current !== undefined) patch(id, { draft: current.applied, queryError: null });
      },

      ensureWindow: windows.ensureWindow,
      fetchMore: windows.fetchMore,
      stopFetch: windows.stopFetch,

      async sort(id, resultId, keys) {
        const result = resultOf(id, resultId);
        const client = clients.get(id);
        // Sorting is the engine's (decision 009); a closed connection's rows keep their order.
        if (result === undefined || client === undefined || result.stale) return;
        try {
          const state = await client.call("result.sort", { handle: result.handle, keys: [...keys] });
          windows.invalidate(resultId);
          updateResult(id, resultId, (latest) => ({
            ...latest,
            ...state,
            sort: keys,
            windows: {},
            matches: {},
            selection: null,
            search: { ...latest.search, current: null },
          }));
          await windows.refreshView(id, resultId);
        } catch (cause) {
          patch(id, { error: toError(cause) });
        }
      },

      setLayout(id, resultId, layout) {
        const before = resultOf(id, resultId);
        updateResult(id, resultId, (latest) => {
          const visible = layout.hidden.filter((hidden) => !hidden).length;
          const hiddenChanged = layout.hidden.some((hidden, index) => hidden !== latest.layout.hidden[index]);
          const selection = hiddenChanged
            ? null
            : clampSelection(latest.selection, { rows: shownRowCount(latest), columns: visible });
          return { ...latest, layout, selection };
        });
        if (before !== undefined && searchedColumnsChanged(before.layout, layout)) void windows.applyView(id, resultId);
      },

      search: windows.search,
      findNext: windows.findNext,

      select(id, resultId, selection) {
        updateResult(id, resultId, (latest) => (latest.selection === selection ? latest : { ...latest, selection }));
      },

      extract: windows.extract,

      async exportTo(...args) {
        return (await windows.exportTo(...args)) !== null;
      },
    };
  });
}

export type KeyTabsStore = ReturnType<typeof createKeyTabsStore>;

export const useKeyTabs = createKeyTabsStore({
  connect: (datasourceId) => useDatasources.getState().connect(datasourceId),
  exports: useExports.getState(),
  statementTimeout: (datasourceId) => statementTimeoutOf(datasourceById(useDatasources.getState(), datasourceId)),
  executions: {
    start: (tabId, start) => useExecutions.getState().start(tabId, start),
    finish: (tabId, executionId, end) => useExecutions.getState().finish(tabId, executionId, end),
    recount: (tabId, executionId, rowCount) => useExecutions.getState().recount(tabId, executionId, rowCount),
  },
});

/** The key tabs open on a datasource, by tab id. */
export function keyTabsOf(tabs: KeyTabsState["tabs"], datasourceId: string): readonly string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.datasourceId === datasourceId)
    .map(([id]) => id);
}
