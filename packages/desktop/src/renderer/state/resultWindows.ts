import {
  RESULT_WINDOW_ROWS,
  type EngineError,
  type ExportFormat,
  type ExportTask,
  type ExtractorKind,
  type FoundMatch,
  type ResultState,
  type RowRange,
  type CellBytes,
  type SelectionAggregates,
  type StagedBytes,
  type ServerMessage,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { widerChars } from "@table-craft/desktop/renderer/grid/widths.js";
import type { ExportStarter } from "@table-craft/desktop/renderer/state/exports.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import {
  findsCells,
  shownRowCount,
  viewSpecOf,
  withMatches,
  withWindow,
  type ResultSearch,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { currentFormats } from "@table-craft/desktop/renderer/state/settings.js";

const UNEXPECTED_HINT = "Restart the app; if it happens again, report it.";

export function toError(cause: unknown): EngineError {
  if (cause instanceof EngineRequestError) {
    const { code, message, hint, position, keyConflict } = cause;
    return {
      code,
      message,
      hint,
      ...(position === undefined ? {} : { position }),
      ...(keyConflict === undefined ? {} : { keyConflict }),
    };
  }
  return { code: "internal", message: cause instanceof Error ? cause.message : String(cause), hint: UNEXPECTED_HINT };
}

/** How a store that owns result tabs lets the shared window logic reach them. */
export interface ResultOwner {
  readonly client: (ownerId: string) => EngineClient | undefined;
  readonly result: (ownerId: string, resultId: string) => ResultTab | undefined;
  readonly update: (ownerId: string, resultId: string, change: (result: ResultTab) => ResultTab) => void;
  /** A request about `result` failed; `window` when it was a scroll's window load. */
  readonly failed: (ownerId: string, result: ResultTab, error: EngineError, window: boolean) => void;
  /**
   * Fetching grew the result to `rowCount` rows, so Services can say so; `arrived` holds the
   * server's messages when this fetch read the last row and the statement left some.
   */
  readonly fetched: (
    ownerId: string,
    resultId: string,
    rowCount: number,
    arrived: readonly ServerMessage[] | undefined,
  ) => void;
  /** The datasource an owner's session is on, for an export of its result. */
  readonly datasourceOf: (ownerId: string) => string | undefined;
  readonly exports: ExportStarter;
}

/** Whether Fetch Next Page and Fetch All can run on the tab. */
export function canFetch(result: ResultTab): boolean {
  return result.cursorOpen && !result.stale && result.fetching === null;
}

/**
 * Windows, fetching, copy and export for result tabs held in the engine (plan 007), shared by
 * consoles and table tabs so both page and evict the same way.
 */
export function createResultWindows(owner: ResultOwner) {
  /** Window requests in flight per result tab. */
  const requested = new Map<string, Set<number>>();
  /** Bumped when a tab's loaded windows stop matching the engine's order; older answers are dropped. */
  const generations = new Map<string, number>();
  /** The latest view request per result tab; an answer to an earlier one is dropped. */
  const viewRequests = new Map<string, number>();

  function nextViewRequest(resultId: string): number {
    const request = (viewRequests.get(resultId) ?? 0) + 1;
    viewRequests.set(resultId, request);
    return request;
  }

  /** Loaded windows no longer match the engine's order: drop them, and any answer still on its way. */
  function invalidate(resultId: string): void {
    generations.set(resultId, (generations.get(resultId) ?? 0) + 1);
    requested.delete(resultId);
  }

  function forget(resultId: string): void {
    requested.delete(resultId);
    generations.delete(resultId);
    viewRequests.delete(resultId);
  }

  /** `result` after the engine reported `state`; rows that moved are fetched again as they show. */
  function withState(result: ResultTab, state: ResultState): ResultTab {
    if (state.rowCount === result.rowCount) return { ...result, ...state };
    invalidate(result.id);
    const windows =
      result.sort.length > 0
        ? {}
        : Object.fromEntries(Object.entries(result.windows).filter(([, rows]) => rows.length === RESULT_WINDOW_ROWS));
    return { ...result, ...state, windows };
  }

  function ensureWindow(ownerId: string, resultId: string, offset: number): void {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || result.stale) return;
    if (offset in result.windows && (!findsCells(result) || offset in result.matches)) return;
    if (offset >= shownRowCount(result)) return;
    const inFlight = requested.get(resultId) ?? new Set<number>();
    requested.set(resultId, inFlight);
    if (inFlight.has(offset)) return;
    inFlight.add(offset);
    const generation = generations.get(resultId) ?? 0;
    client
      .call("result.window", { handle: result.handle, offset, limit: RESULT_WINDOW_ROWS })
      .then((window) => {
        if ((generations.get(resultId) ?? 0) !== generation) return;
        owner.update(ownerId, resultId, (latest) => {
          const windows = withWindow(latest.windows, window.offset, window.rows);
          return {
            ...latest,
            windows,
            matches: withMatches(latest.matches, windows, window.offset, window.matches ?? []),
            autoChars: widerChars(latest.autoChars, window.rows, latest.typeClasses, currentFormats()),
          };
        });
      })
      .catch((cause: unknown) => {
        if ((generations.get(resultId) ?? 0) === generation) owner.failed(ownerId, result, toError(cause), true);
      })
      .finally(() => inFlight.delete(offset));
  }

  async function fetchMore(ownerId: string, resultId: string, all: boolean): Promise<void> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || !canFetch(result)) return;
    owner.update(ownerId, resultId, (latest) => ({ ...latest, fetching: all ? "all" : "page" }));
    try {
      const state = await client.call("result.fetchMore", { handle: result.handle, all, ...result.paging });
      const arrived = owner.result(ownerId, resultId)?.messages === undefined ? state.messages : undefined;
      owner.update(ownerId, resultId, (latest) => withState(latest, state));
      owner.fetched(ownerId, resultId, state.rowCount, arrived);
      await refreshView(ownerId, resultId);
    } catch (cause) {
      owner.failed(ownerId, result, toError(cause), false);
      owner.update(ownerId, resultId, (latest) => ({ ...latest, cursorOpen: false }));
    } finally {
      owner.update(ownerId, resultId, (latest) => ({ ...latest, fetching: null }));
    }
  }

  async function stopFetch(ownerId: string, resultId: string): Promise<void> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || (result.fetching !== "page" && result.fetching !== "all")) {
      return;
    }
    try {
      await client.call("result.stopFetch", { handle: result.handle });
    } catch (cause) {
      owner.failed(ownerId, result, toError(cause), false);
    }
  }

  async function extract(
    ownerId: string,
    resultId: string,
    extractor: ExtractorKind,
    rows: readonly RowRange[],
    columns: readonly number[],
  ): Promise<string | null> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || result.stale) return null;
    try {
      return await client.call("result.extract", {
        handle: result.handle,
        extractor,
        rows: [...rows],
        columns: [...columns],
      });
    } catch (cause) {
      owner.failed(ownerId, result, toError(cause), false);
      return null;
    }
  }

  /** What the selected cells add up to; null when the engine refused, which the status line omits. */
  async function aggregate(
    ownerId: string,
    resultId: string,
    rows: readonly RowRange[],
    columns: readonly number[],
  ): Promise<SelectionAggregates | null> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || result.stale) return null;
    return client
      .call("result.aggregate", { handle: result.handle, rows: [...rows], columns: [...columns] })
      .catch(() => null);
  }

  /** Every byte of a held cell, for the value panel's image preview; null when the engine refused. */
  async function cellBytes(
    ownerId: string,
    resultId: string,
    row: number,
    column: number,
    maxBytes: number,
  ): Promise<CellBytes | null> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || result.stale) return null;
    return client.call("result.cellBytes", { handle: result.handle, row, column, maxBytes }).catch(() => null);
  }

  /** Writes a held cell's bytes to `path` (plan 043); the length written, or null when it failed. */
  async function saveBytes(
    ownerId: string,
    resultId: string,
    cell: { readonly row: number; readonly column: number },
    path: string,
    maxBytes: number,
  ): Promise<number | null> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || result.stale) return null;
    try {
      return await client.call("result.saveBytes", { handle: result.handle, ...cell, path, maxBytes });
    } catch (cause) {
      owner.failed(ownerId, result, toError(cause), false);
      return null;
    }
  }

  /** Reads the file at `path` into the engine for this result's edits; null when it failed. */
  async function loadBytes(
    ownerId: string,
    resultId: string,
    path: string,
    maxBytes: number,
  ): Promise<StagedBytes | null> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || result.stale) return null;
    try {
      return await client.call("result.loadBytes", { handle: result.handle, path, maxBytes });
    } catch (cause) {
      owner.failed(ownerId, result, toError(cause), false);
      return null;
    }
  }

  /**
   * Starts a background export of the result (decision 040), or with `shownOnly` of the rows the
   * grid shows, in its order (plan 023); null when it could not start. Only
   * an export that drains the console's own cursor keeps the grid busy, until its task ends.
   */
  async function exportTo(
    ownerId: string,
    resultId: string,
    format: ExportFormat,
    path: string,
    columns: readonly number[],
    shownOnly = false,
  ): Promise<ExportTask | null> {
    const result = owner.result(ownerId, resultId);
    const datasourceId = owner.datasourceOf(ownerId);
    if (result === undefined || datasourceId === undefined || result.stale || result.fetching !== null) return null;
    try {
      const task = await owner.exports.start(datasourceId, {
        source: { kind: "result", handle: result.handle, columns: [...columns], ...(shownOnly ? { shownOnly } : {}) },
        format,
        path,
      });
      if (task.origin === "cursor") {
        owner.update(ownerId, resultId, (latest) => ({ ...latest, fetching: "export" }));
        void owner.exports.finished(task.taskId).then(() => {
          owner.update(ownerId, resultId, (latest) => ({ ...latest, fetching: null, cursorOpen: false }));
        });
      }
      return task;
    } catch (cause) {
      owner.failed(ownerId, result, toError(cause), false);
      return null;
    }
  }

  /** The match `match` selected and scrolled to, as the find bar's current one. */
  function onMatch(result: ResultTab, match: FoundMatch | null): ResultTab {
    const search = { ...result.search, current: match };
    if (match === null) return { ...result, search };
    const column = visibleColumns(result.layout).indexOf(match.column);
    return { ...result, search, selection: selectCell({ row: match.row, column: Math.max(column, 0) }) };
  }

  /**
   * Sends the tab's find query and chips to the engine, which computes the view (decision 050).
   * Rows the view hides or brings back reload as they show; with no row hidden before or after,
   * the loaded rows stay and only their matches reload. A live query then goes to its first match.
   */
  async function applyView(ownerId: string, resultId: string): Promise<void> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result === undefined || client === undefined || result.stale) return;
    const spec = viewSpecOf(result, currentFormats());
    if (spec === null && result.view === null) return;
    const request = nextViewRequest(resultId);
    try {
      const view = await client.call("result.view", { handle: result.handle, spec });
      if (viewRequests.get(resultId) !== request) return;
      invalidate(resultId);
      owner.update(ownerId, resultId, (latest) => {
        const moved = latest.view?.filtered === true || view.filtered;
        return {
          ...latest,
          view: spec === null ? null : view,
          windows: moved ? {} : latest.windows,
          matches: {},
          selection: moved ? null : latest.selection,
          search: { ...latest.search, current: null },
        };
      });
      const shown = owner.result(ownerId, resultId);
      if (shown === undefined || !findsCells(shown)) return;
      // The grid asks for windows as they change; kept windows only lost their matches.
      for (const offset of Object.keys(shown.windows)) ensureWindow(ownerId, resultId, Number(offset));
      if (view.matches === 0) return;
      const first = await client.call("result.findMatch", { handle: shown.handle, from: null, backward: false });
      if (viewRequests.get(resultId) !== request) return;
      owner.update(ownerId, resultId, (latest) => onMatch(latest, first));
    } catch (cause) {
      if (viewRequests.get(resultId) === request) owner.failed(ownerId, result, toError(cause), false);
    }
  }

  /** The search state changed: keep it on the tab and recompute the view when what it asks for did. */
  async function search(
    ownerId: string,
    resultId: string,
    change: (search: ResultSearch) => ResultSearch,
  ): Promise<void> {
    const before = owner.result(ownerId, resultId);
    if (before === undefined) return;
    const formats = currentFormats();
    const spec = JSON.stringify(viewSpecOf(before, formats));
    owner.update(ownerId, resultId, (latest) => ({ ...latest, search: change(latest.search) }));
    const after = owner.result(ownerId, resultId);
    if (after !== undefined && JSON.stringify(viewSpecOf(after, formats)) !== spec) {
      await applyView(ownerId, resultId);
    }
  }

  /** After fetching or sorting changed the held rows, asks the engine for the view over them. */
  async function refreshView(ownerId: string, resultId: string): Promise<void> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result?.view == null || client === undefined || result.stale) return;
    const request = nextViewRequest(resultId);
    try {
      const view = await client.call("result.viewState", { handle: result.handle });
      if (viewRequests.get(resultId) !== request) return;
      owner.update(ownerId, resultId, (latest) => ({ ...latest, view }));
    } catch (cause) {
      if (viewRequests.get(resultId) === request) owner.failed(ownerId, result, toError(cause), false);
    }
  }

  /** Moves the find bar to the next match after the focused cell, or before it when `backward`. */
  async function findNext(ownerId: string, resultId: string, backward: boolean): Promise<void> {
    const result = owner.result(ownerId, resultId);
    const client = owner.client(ownerId);
    if (result?.view == null || client === undefined || result.stale || !findsCells(result)) return;
    const focus = result.selection?.focus;
    const column = focus === undefined ? undefined : visibleColumns(result.layout)[focus.column];
    const from =
      focus === undefined || column === undefined ? (result.search.current ?? null) : { row: focus.row, column };
    try {
      const match = await client.call("result.findMatch", { handle: result.handle, from, backward });
      owner.update(ownerId, resultId, (latest) => onMatch(latest, match));
    } catch (cause) {
      owner.failed(ownerId, result, toError(cause), false);
    }
  }

  return {
    invalidate,
    forget,
    withState,
    ensureWindow,
    fetchMore,
    stopFetch,
    extract,
    aggregate,
    cellBytes,
    saveBytes,
    loadBytes,
    exportTo,
    applyView,
    search,
    refreshView,
    findNext,
  };
}

export type ResultWindows = ReturnType<typeof createResultWindows>;
