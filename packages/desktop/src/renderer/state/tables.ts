import { create } from "zustand";
import type {
  CellInput,
  ColumnMeta,
  EditableIdentity,
  EngineError,
  ExportFormat,
  ExtractorKind,
  ForeignKey,
  ReferencingKey,
  RowRange,
  SelectionAggregates,
  SortKey,
} from "@table-craft/desktop/engine/protocol.js";
import type { HistoryEntry } from "@table-craft/desktop/preload/bridge.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { carriedLayout, type ColumnLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import {
  EMPTY_BUFFER,
  gridRowCount,
  pendingCount,
  toEdits,
  type BufferCell,
  type EditBuffer,
} from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  canEditCell,
  clampedTo,
  editCellText,
  editorAt,
  withAddedRow,
  withCells,
  withDeletes,
  withDuplicates,
  withReverted,
  submitLabel,
  submittedScript,
  submittedText,
  type CellEditor,
  committedInput,
} from "@table-craft/desktop/renderer/model/resultEdits.js";
import { clampSelection, type GridSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { NO_EXPORTS, useExports, type ExportStarter } from "@table-craft/desktop/renderer/state/exports.js";
import {
  NO_EXECUTION_REPORTER,
  useExecutions,
  type ExecutionEnd,
  type ExecutionReporter,
} from "@table-craft/desktop/renderer/state/executions.js";
import { history } from "@table-craft/desktop/renderer/state/history.js";
import {
  resultTabOf,
  searchedColumnsChanged,
  shownHeld,
  type ResultSearch,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { createResultWindows, toError, type ResultWindows } from "@table-craft/desktop/renderer/state/resultWindows.js";
import {
  currentFormats,
  currentPaging,
  serverEnforcedOf,
  statementLimit,
  statementTimeoutOf,
} from "@table-craft/desktop/renderer/state/settings.js";

/** Which table a tab shows: a relation inside a namespace path of a datasource. */
export interface TableTarget {
  readonly datasourceId: string;
  readonly path: readonly string[];
  readonly relation: string;
}

/**
 * A table tab's session. `disconnected` when restored at launch or its engine went away; Reload
 * opens a new session from it and from `failed`.
 */
export type TableStatus = "connecting" | "ready" | "loading" | "submitting" | "failed" | "disconnected";

export type { CellEditor };
export { submittedScript };

/** What the WHERE and ORDER BY bars hold. */
export interface TableClauses {
  readonly where: string;
  readonly orderBy: string;
}

export interface TableSession extends TableTarget {
  readonly sessionId: string | null;
  readonly status: TableStatus;
  /** Why the session, a submit or a count failed; shown above the grid. */
  readonly error: EngineError | null;
  /** The clauses the shown rows were read with. */
  readonly applied: TableClauses;
  /** The bars' text as typed; Enter applies it, Escape reverts it to `applied`. */
  readonly draft: TableClauses;
  /** The database refused the bars' clauses: shown under them while the rows stay (plan 008 decision 5). */
  readonly queryError: EngineError | null;
  readonly editable: EditableIdentity | null;
  /** The catalog's view of each result column. */
  readonly columns: readonly ColumnMeta[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly referencing: readonly ReferencingKey[];
  readonly result: ResultTab | null;
  readonly buffer: EditBuffer;
  readonly editing: CellEditor | null;
  /** Count Rows' answer for `applied.where`, or null until asked. */
  readonly count: number | null;
  /** What the last submit did, for the footer; cleared by the next edit. */
  readonly notice: string | null;
  /** The value panel's text for a cell, while edited there; ⌘↵ writes it to the buffer. */
  readonly panel: CellEditor | null;
}

export interface TablesState {
  readonly tables: Readonly<Record<string, TableSession>>;
  /** Adds a table tab, opening its session and reading its rows unless `connect` is false. */
  readonly open: (id: string, target: TableTarget, options?: OpenTableOptions) => Promise<void>;
  /** Forgets the tab and closes its session, which releases its rows; pending edits are dropped. */
  readonly close: (id: string) => void;
  /** Marks the datasource's tables disconnected; their pending edits can no longer be written. */
  readonly detach: (datasourceId: string, error: EngineError | null) => void;
  readonly setDraft: (id: string, draft: Partial<TableClauses>) => void;
  readonly revertDraft: (id: string) => void;
  /** Reads the rows again with `clauses`, or the bars' draft; a refused clause keeps the rows shown. */
  readonly query: (id: string, clauses?: TableClauses) => Promise<boolean>;
  /** Header sorting: rewrites ORDER BY from `keys` and reads the rows again in the server's order. */
  readonly sortBy: (id: string, keys: readonly SortKey[]) => Promise<boolean>;
  readonly ensureWindow: (id: string, resultId: string, offset: number) => void;
  readonly fetchMore: (id: string, resultId: string, all: boolean) => Promise<void>;
  readonly stopFetch: (id: string, resultId: string) => Promise<void>;
  /** Same shape as a console's; a table result sorts on the server, so this is `sortBy`. */
  readonly sort: (id: string, resultId: string, keys: readonly SortKey[]) => Promise<void>;
  readonly setLayout: (id: string, resultId: string, layout: ColumnLayout) => void;
  readonly select: (id: string, resultId: string, selection: GridSelection | null) => void;
  readonly extract: (
    id: string,
    resultId: string,
    extractor: ExtractorKind,
    rows: readonly RowRange[],
    columns: readonly number[],
  ) => Promise<string | null>;
  /** What the selected cells add up to, or null when the engine refused. */
  readonly aggregate: (
    id: string,
    resultId: string,
    rows: readonly RowRange[],
    columns: readonly number[],
  ) => Promise<SelectionAggregates | null>;
  /** Every byte of a held cell, for an image preview; null when the engine refused. */
  readonly cellBytes: ResultWindows["cellBytes"];
  /** Writes a held cell's bytes to a file main chose (plan 043). */
  readonly saveBytes: ResultWindows["saveBytes"];
  /** Reads a file main chose into the engine for this result's edits (plan 043). */
  readonly loadBytes: ResultWindows["loadBytes"];
  readonly exportTo: (
    id: string,
    resultId: string,
    format: ExportFormat,
    path: string,
    columns: readonly number[],
    shownOnly?: boolean,
  ) => Promise<boolean>;
  /** Changes the result's find bar or local filter chips; the engine recomputes the view (plan 023). */
  readonly search: (id: string, resultId: string, change: (search: ResultSearch) => ResultSearch) => Promise<void>;
  /** Moves the find bar to the next match, or the previous one. */
  readonly findNext: (id: string, resultId: string, backward: boolean) => Promise<void>;
  readonly beginEdit: (id: string, cell: BufferCell, text?: string) => void;
  readonly changeEdit: (id: string, text: string) => void;
  /** Writes the editor's text to the buffer unless unchanged; true when there was an editor. */
  readonly commitEdit: (id: string) => boolean;
  readonly cancelEdit: (id: string) => void;
  /** Keeps the value panel's text for `cell`; null drops it. */
  readonly editPanel: (id: string, cell: BufferCell | null, text?: string) => void;
  /** Writes the value panel's text to the buffer unless unchanged; true when it held a cell. */
  readonly applyPanel: (id: string) => boolean;
  readonly setCells: (id: string, cells: readonly BufferCell[], input: CellInput) => void;
  readonly addRow: (id: string) => void;
  readonly duplicateRows: (id: string, rows: readonly number[]) => void;
  readonly deleteRows: (id: string, rows: readonly number[]) => void;
  readonly revert: (id: string, cells: readonly BufferCell[]) => void;
  readonly revertAll: (id: string) => void;
  /** The statements Submit would run, or null when the engine refused (the error says why). */
  readonly preview: (id: string) => Promise<readonly string[] | null>;
  /** Runs the buffer in one transaction and reads the rows again; false keeps the buffer. */
  readonly submit: (id: string) => Promise<boolean>;
  readonly countRows: (id: string) => Promise<void>;
  /** A WHERE condition matching the values `rows` hold in the result `columns`, written as `names`. */
  readonly condition: (
    id: string,
    rows: readonly number[],
    columns: readonly { readonly column: number; readonly name: string }[],
  ) => Promise<string | null>;
}

export interface OpenTableOptions {
  /** False for a tab restored at launch: it stays disconnected until Reload. */
  readonly connect?: boolean;
  readonly where?: string;
}

export interface TablesDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  /** A monotonic clock for durations; defaults to `performance.now`. */
  readonly now?: () => number;
  /** Wall-clock time an execution started; defaults to `Date.now`. */
  readonly clock?: () => number;
  /** Hears each load, count and submit start and end, for Services (plan 011, decision 11). */
  readonly executions?: ExecutionReporter;
  /** Each submit that ran, for query history (plan 011, decision 6); must not throw. */
  readonly record?: (entry: HistoryEntry) => void;
  /** Starts background exports of a table's rows (decision 040). */
  readonly exports?: ExportStarter;
  /** The statement timeout for the datasource's reads in seconds, 0 for none (decision 054). */
  readonly statementTimeout?: (datasourceId: string) => number;
  /** Whether the datasource has the database enforce that timeout too (decision 129). */
  readonly serverEnforced?: (datasourceId: string) => boolean;
}

const EMPTY_CLAUSES: TableClauses = { where: "", orderBy: "" };
const RESULT_TITLE = "Data";

/** Whether Reload can start from this status; it reconnects from the last two. */
export function canReload(status: TableStatus): boolean {
  return status === "ready" || status === "disconnected" || status === "failed";
}

/** The buffer's pending change count for the tab. */
export function pendingOf(session: TableSession | undefined): number {
  return session === undefined ? 0 : pendingCount(session.buffer);
}

/** Why the tab's rows cannot be edited, or null when they can. */
export function readOnlyReason(session: TableSession): string | null {
  if (session.editable === null) return null;
  return "readOnly" in session.editable ? session.editable.readOnly : null;
}

/**
 * Which bars to mark after the database refused the query. It does not say which clause failed,
 * so every bar that took part is marked; an empty bar cannot be the cause.
 */
export function refusedBars(session: TableSession): { readonly where: boolean; readonly orderBy: boolean } {
  const refused = session.queryError !== null;
  return {
    where: refused && session.draft.where.trim() !== "",
    orderBy: refused && session.draft.orderBy.trim() !== "",
  };
}

export function isEditable(session: TableSession | null | undefined): session is TableSession {
  return (
    session?.editable != null &&
    "identity" in session.editable &&
    session.result !== null &&
    !session.result.stale &&
    session.status === "ready"
  );
}

/** Rows the grid draws: held rows, then inserted ones. */
export function tableRowCount(session: TableSession): number {
  return session.result === null ? 0 : gridRowCount(session.buffer, shownHeld(session.result));
}

/** The text a cell shows and edits from: its pending input, else its value; null and default edit as empty. */
export function cellText(session: TableSession, cell: BufferCell): string {
  return editCellText(session, cell);
}

/** Disconnected until its first read opens a session. */
function newTable(target: TableTarget, where: string): TableSession {
  const clauses = { ...EMPTY_CLAUSES, where };
  return {
    ...target,
    path: [...target.path],
    sessionId: null,
    status: "disconnected",
    error: null,
    applied: clauses,
    draft: clauses,
    queryError: null,
    editable: null,
    columns: [],
    foreignKeys: [],
    referencing: [],
    result: null,
    buffer: EMPTY_BUFFER,
    editing: null,
    count: null,
    notice: null,
    panel: null,
  };
}

export const LOAD_LABEL = "Load rows";
export const COUNT_LABEL = "Count rows";
const SUBMIT_LABEL = "Submit changes";

export function createTablesStore(dependencies: TablesDependencies) {
  const clients = new Map<string, EngineClient>();
  const now = dependencies.now ?? (() => performance.now());
  const clock = dependencies.clock ?? (() => Date.now());
  const executions = dependencies.executions ?? NO_EXECUTION_REPORTER;
  /** The load each result came from, by result id, so fetching more updates its row count. */
  const producedBy = new Map<string, number>();
  let resultIds = 0;

  return create<TablesState>()((set, get) => {
    const windows = createResultWindows({
      client: (id) => clients.get(id),
      result: (id, resultId) => resultOf(id, resultId),
      update: (id, resultId, change) => updateResult(id, resultId, change),
      failed: (id, _result, error) => patch(id, { error }),
      fetched: (id, resultId, rowCount) => {
        const executionId = producedBy.get(resultId);
        if (executionId !== undefined) executions.recount(id, executionId, rowCount);
      },
      datasourceOf: (id) => get().tables[id]?.datasourceId,
      exports: dependencies.exports ?? NO_EXPORTS,
    });

    function patch(id: string, change: Partial<TableSession>): void {
      const current = get().tables[id];
      if (current === undefined) return;
      set({ tables: { ...get().tables, [id]: { ...current, ...change } } });
    }

    /** Services lists the work now and finishes it with what `end` says; `durationMs` is filled in. */
    function started(id: string, label: string, sql: string | null) {
      const begun = now();
      const executionId = executions.start(id, { label, sql, startedAt: clock() });
      const ended = (end: Omit<ExecutionEnd, "durationMs">): number => {
        const durationMs = Math.max(0, Math.round(now() - begun));
        executions.finish(id, executionId, { ...end, durationMs });
        return durationMs;
      };
      return Object.assign(ended, { executionId });
    }

    function failed(error: EngineError): Omit<ExecutionEnd, "durationMs"> {
      const cancelled = error.code === "cancelled";
      return { outcome: cancelled ? "cancelled" : "error", rowCount: null, message: cancelled ? null : error.message };
    }

    function resultOf(id: string, resultId: string): ResultTab | undefined {
      const result = get().tables[id]?.result;
      return result?.id === resultId ? result : undefined;
    }

    function updateResult(id: string, resultId: string, change: (result: ResultTab) => ResultTab): void {
      const result = resultOf(id, resultId);
      if (result !== undefined) patch(id, { result: change(result) });
    }

    function editBuffer(id: string, change: (session: TableSession) => EditBuffer): void {
      const current = get().tables[id];
      if (current === undefined || current.result === null) return;
      const buffer = change(current);
      if (buffer === current.buffer) return;
      patch(id, { buffer, notice: null, result: clampedTo(current.result, buffer) });
    }

    /** The engine closes a session's open cursor when the session runs anything. */
    function cursorClosed(id: string): void {
      const result = get().tables[id]?.result;
      if (result?.cursorOpen === true) patch(id, { result: { ...result, cursorOpen: false } });
    }

    async function openSession(id: string): Promise<boolean> {
      const current = get().tables[id];
      if (current === undefined) return false;
      patch(id, { status: "connecting", error: null });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const opened = await client.call("session.open", {});
        if (get().tables[id] === undefined) {
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

    async function ready(id: string): Promise<{ client: EngineClient; sessionId: string } | null> {
      const before = get().tables[id];
      if (before === undefined || !canReload(before.status)) return null;
      if (before.status !== "ready" && !(await openSession(id))) return null;
      const current = get().tables[id];
      const client = clients.get(id);
      if (current?.sessionId == null || current.status !== "ready" || client === undefined) return null;
      return { client, sessionId: current.sessionId };
    }

    /** The status to settle on after work: a detach while working already said the session is gone. */
    function settled(id: string): TableStatus {
      const status = get().tables[id]?.status;
      return status === "disconnected" || status === "failed" ? status : "ready";
    }

    async function read(id: string, clauses: TableClauses, sort: readonly SortKey[]): Promise<boolean> {
      const session = await ready(id);
      const current = get().tables[id];
      if (session === null || current === undefined) return false;
      const { client, sessionId } = session;
      patch(id, { status: "loading", error: null, draft: clauses });
      const ended = started(id, LOAD_LABEL, null);
      try {
        cursorClosed(id);
        const paging = currentPaging();
        const limit = statementLimit(
          dependencies.statementTimeout?.(current.datasourceId) ?? 0,
          dependencies.serverEnforced?.(current.datasourceId) ?? false,
        );
        const answer = await client.call("table.query", {
          sessionId,
          path: current.path,
          relation: current.relation,
          where: clauses.where,
          orderBy: clauses.orderBy,
          ...paging,
          ...limit,
        });
        ended({ outcome: "success", rowCount: answer.statement.rowCount, message: null, sql: answer.sql });
        const latest = get().tables[id];
        if (latest === undefined) return false;
        const previous = latest.result;
        if (previous !== null) {
          windows.forget(previous.id);
          producedBy.delete(previous.id);
          if (!previous.stale) void client.call("result.release", { handle: previous.handle }).catch(() => undefined);
        }
        const fresh = resultTabOf(
          answer.statement,
          { id: `${id}/data-${String(++resultIds)}`, title: RESULT_TITLE },
          answer.sql,
          paging,
          currentFormats(),
        );
        producedBy.set(fresh.id, ended.executionId);
        const names = (columns: readonly { readonly name: string }[]) => columns.map((column) => column.name);
        const layout =
          previous === null
            ? fresh.layout
            : carriedLayout(previous.layout, names(previous.columns), names(fresh.columns));
        const kept = previous !== null && layout === previous.layout;
        patch(id, {
          applied: clauses,
          draft: clauses,
          queryError: null,
          editable: answer.editable,
          columns: answer.columns,
          foreignKeys: answer.foreignKeys,
          referencing: answer.referencing,
          buffer: EMPTY_BUFFER,
          editing: null,
          panel: null,
          count: latest.applied.where === clauses.where ? latest.count : null,
          result: {
            ...fresh,
            sort,
            layout,
            autoChars: kept ? previous.autoChars : fresh.autoChars,
            search: kept ? { ...previous.search, current: null } : fresh.search,
          },
        });
        if (kept) await windows.applyView(id, fresh.id);
        return true;
      } catch (cause) {
        const error = toError(cause);
        ended(failed(error));
        if (error.code === "statementFailed") patch(id, { queryError: error });
        else patch(id, { error });
        return false;
      } finally {
        patch(id, { status: settled(id) });
      }
    }

    return {
      tables: {},

      async open(id, target, options = {}) {
        const connect = options.connect ?? true;
        set({ tables: { ...get().tables, [id]: newTable(target, options.where ?? "") } });
        if (connect) await read(id, { ...EMPTY_CLAUSES, where: options.where ?? "" }, []);
      },

      close(id) {
        const closing = get().tables[id];
        if (closing === undefined) return;
        const { [id]: _closed, ...rest } = get().tables;
        set({ tables: rest });
        if (closing.result !== null) {
          windows.forget(closing.result.id);
          producedBy.delete(closing.result.id);
        }
        const client = clients.get(id);
        clients.delete(id);
        if (closing.sessionId === null || client === undefined) return;
        void client.call("session.close", { sessionId: closing.sessionId }).catch(() => undefined);
      },

      detach(datasourceId, error) {
        for (const [id, session] of Object.entries(get().tables)) {
          if (session.datasourceId !== datasourceId) continue;
          clients.delete(id);
          if (session.result !== null) windows.invalidate(session.result.id);
          const dropped = pendingCount(session.buffer);
          patch(id, {
            sessionId: null,
            status: error === null ? "disconnected" : "failed",
            error: error ?? session.error,
            buffer: EMPTY_BUFFER,
            editing: null,
            panel: null,
            notice:
              dropped === 0
                ? null
                : `The connection closed; ${String(dropped)} pending ${dropped === 1 ? "change was" : "changes were"} discarded.`,
            result:
              session.result === null ? null : { ...session.result, stale: true, cursorOpen: false, fetching: null },
          });
        }
      },

      setDraft(id, draft) {
        const current = get().tables[id];
        if (current === undefined) return;
        const next = { ...current.draft, ...draft };
        if (next.where === current.draft.where && next.orderBy === current.draft.orderBy) return;
        patch(id, { draft: next });
      },

      revertDraft(id) {
        const current = get().tables[id];
        if (current !== undefined) patch(id, { draft: current.applied, queryError: null });
      },

      async query(id, clauses) {
        const current = get().tables[id];
        if (current === undefined) return false;
        const next = clauses ?? current.draft;
        const sameOrder = next.orderBy === current.applied.orderBy;
        return read(id, next, sameOrder ? (current.result?.sort ?? []) : []);
      },

      async sortBy(id, keys) {
        const current = get().tables[id];
        const client =
          clients.get(id) ?? (current === undefined ? undefined : await dependencies.connect(current.datasourceId));
        if (current === undefined || current.result === null || client === undefined) return false;
        const { columns } = current.result;
        const terms = keys.flatMap((key) => {
          const column = columns[key.column];
          return column === undefined ? [] : [{ name: column.name, direction: key.direction }];
        });
        try {
          const orderBy = await client.call("table.orderBy", { terms });
          return await read(id, { where: current.applied.where, orderBy }, keys);
        } catch (cause) {
          patch(id, { error: toError(cause) });
          return false;
        }
      },

      ensureWindow: windows.ensureWindow,
      fetchMore: windows.fetchMore,
      stopFetch: windows.stopFetch,

      async sort(id, _resultId, keys) {
        await get().sortBy(id, keys);
      },

      setLayout(id, resultId, layout) {
        const session = get().tables[id];
        if (session === undefined) return;
        const before = session.result;
        updateResult(id, resultId, (latest) => {
          const visible = layout.hidden.filter((hidden) => !hidden).length;
          const hiddenChanged = layout.hidden.some((hidden, index) => hidden !== latest.layout.hidden[index]);
          const rows = gridRowCount(session.buffer, shownHeld(latest));
          const selection = hiddenChanged ? null : clampSelection(latest.selection, { rows, columns: visible });
          return { ...latest, layout, selection };
        });
        if (before !== null && searchedColumnsChanged(before.layout, layout)) void windows.applyView(id, resultId);
      },

      async search(id, resultId, change) {
        // An open editor names its cell by shown row, which a new view moves; edits name held rows and stay.
        get().commitEdit(id);
        get().applyPanel(id);
        await windows.search(id, resultId, change);
      },
      findNext: windows.findNext,

      select(id, resultId, selection) {
        updateResult(id, resultId, (latest) => (latest.selection === selection ? latest : { ...latest, selection }));
      },

      extract: windows.extract,
      aggregate: windows.aggregate,
      cellBytes: windows.cellBytes,
      saveBytes: windows.saveBytes,
      loadBytes: windows.loadBytes,

      async exportTo(id, resultId, format, path, columns, shownOnly) {
        const task = await windows.exportTo(id, resultId, format, path, columns, shownOnly);
        return task !== null;
      },

      beginEdit(id, cell, text) {
        const current = get().tables[id];
        if (!isEditable(current)) return;
        const editing = editorAt(current, cell, text);
        if (editing !== null) patch(id, { editing });
      },

      changeEdit(id, text) {
        const editing = get().tables[id]?.editing;
        if (editing != null && editing.text !== text) patch(id, { editing: { ...editing, text } });
      },

      commitEdit(id) {
        const current = get().tables[id];
        const editing = current?.editing;
        if (current === undefined || editing == null) return false;
        patch(id, { editing: null });
        if (editing.text !== editing.initial) {
          get().setCells(id, [editing], committedInput(current.result?.typeClasses[editing.column], editing.text));
        }
        return true;
      },

      cancelEdit(id) {
        if (get().tables[id]?.editing != null) patch(id, { editing: null });
      },

      editPanel(id, cell, text) {
        const current = get().tables[id];
        if (current === undefined) return;
        if (cell === null) {
          if (current.panel !== null) patch(id, { panel: null });
          return;
        }
        if (!isEditable(current) || !canEditCell(current, cell)) return;
        const same = current.panel?.row === cell.row && current.panel.column === cell.column;
        const initial = same ? current.panel.initial : cellText(current, cell);
        patch(id, { panel: { row: cell.row, column: cell.column, text: text ?? initial, initial } });
      },

      applyPanel(id) {
        const current = get().tables[id];
        const panel = current?.panel;
        if (panel == null) return false;
        patch(id, { panel: null });
        if (panel.text !== panel.initial)
          get().setCells(id, [panel], committedInput(current?.result?.typeClasses[panel.column], panel.text));
        return true;
      },

      setCells(id, cells, input) {
        editBuffer(id, (session) => withCells(session, cells, input));
      },

      addRow(id) {
        editBuffer(id, (session) => withAddedRow(session));
      },

      duplicateRows(id, rows) {
        editBuffer(id, (session) => withDuplicates(session, rows));
      },

      deleteRows(id, rows) {
        editBuffer(id, (session) => withDeletes(session, rows));
      },

      revert(id, cells) {
        editBuffer(id, (session) => withReverted(session, cells));
      },

      revertAll(id) {
        editBuffer(id, () => EMPTY_BUFFER);
        patch(id, { editing: null, panel: null });
      },

      async preview(id) {
        const current = get().tables[id];
        const client = clients.get(id);
        if (current?.result == null || client === undefined) return null;
        try {
          return await client.call("edits.preview", { handle: current.result.handle, edits: toEdits(current.buffer) });
        } catch (cause) {
          patch(id, { error: toError(cause) });
          return null;
        }
      },

      async submit(id) {
        get().commitEdit(id);
        const current = get().tables[id];
        const client = clients.get(id);
        if (current?.result == null || current.sessionId === null || client === undefined) return false;
        if (current.status !== "ready" || pendingCount(current.buffer) === 0) return false;
        patch(id, { status: "submitting", error: null });
        const startedAt = clock();
        const ended = started(id, SUBMIT_LABEL, null);
        const { handle } = current.result;
        const edits = toEdits(current.buffer);
        try {
          cursorClosed(id);
          const submitted = await client.call("edits.submit", { sessionId: current.sessionId, handle, edits });
          const sql = submittedScript(submitted.statements);
          const rowCount = submitted.rowsAffected;
          const label = submitLabel(submitted.statements.length);
          const durationMs = ended({ outcome: "success", rowCount, message: null, label, sql });
          dependencies.record?.({
            datasourceId: current.datasourceId,
            sql,
            startedAt,
            durationMs,
            outcome: "success",
            rowCount,
            message: null,
            source: "table",
          });
          patch(id, { status: settled(id), buffer: EMPTY_BUFFER, count: null });
          await get().query(id, current.applied);
          patch(id, { notice: submittedText(submitted.statements.length) });
          return true;
        } catch (cause) {
          const error = toError(cause);
          const end = failed(error);
          // The failure names no statements; the same edits preview to the script that was sent.
          const statements = await client.call("edits.preview", { handle, edits }).catch(() => null);
          if (statements === null) {
            ended(end);
          } else {
            const sql = submittedScript(statements);
            const durationMs = ended({ ...end, label: submitLabel(statements.length), sql });
            dependencies.record?.({
              datasourceId: current.datasourceId,
              sql,
              startedAt,
              durationMs,
              outcome: end.outcome,
              rowCount: null,
              message: end.message,
              source: "table",
            });
          }
          patch(id, { status: settled(id), error });
          return false;
        }
      },

      async countRows(id) {
        const current = get().tables[id];
        if (current === undefined) return;
        const ended = started(id, COUNT_LABEL, null);
        try {
          const client = clients.get(id) ?? (await dependencies.connect(current.datasourceId));
          const count = await client.call("table.count", {
            path: current.path,
            relation: current.relation,
            where: current.applied.where,
          });
          ended({ outcome: "success", rowCount: count, message: null });
          patch(id, { count, error: null });
        } catch (cause) {
          const error = toError(cause);
          ended(failed(error));
          patch(id, { error });
        }
      },

      async condition(id, rows, columns) {
        const current = get().tables[id];
        const client = clients.get(id);
        if (current?.result == null || client === undefined || current.result.stale) return null;
        try {
          return await client.call("table.condition", {
            handle: current.result.handle,
            rows: [...rows],
            columns: [...columns],
          });
        } catch (cause) {
          patch(id, { error: toError(cause) });
          return null;
        }
      },
    };
  });
}

export type TablesStore = ReturnType<typeof createTablesStore>;

export const useTables = createTablesStore({
  connect: (datasourceId) => useDatasources.getState().connect(datasourceId),
  exports: useExports.getState(),
  statementTimeout: (datasourceId) => statementTimeoutOf(datasourceById(useDatasources.getState(), datasourceId)),
  serverEnforced: (datasourceId) => serverEnforcedOf(datasourceById(useDatasources.getState(), datasourceId)),
  executions: {
    start: (tabId, start) => useExecutions.getState().start(tabId, start),
    finish: (tabId, executionId, end) => useExecutions.getState().finish(tabId, executionId, end),
    recount: (tabId, executionId, rowCount) => useExecutions.getState().recount(tabId, executionId, rowCount),
  },
  record: (entry) => history.record(entry),
});

/** The table tabs open on a datasource, by tab id. */
export function tablesOf(tables: TablesState["tables"], datasourceId: string): readonly string[] {
  return Object.entries(tables)
    .filter(([, session]) => session.datasourceId === datasourceId)
    .map(([id]) => id);
}

/** The table tabs holding pending changes, by tab id. */
export function pendingTables(tables: TablesState["tables"]): readonly string[] {
  return Object.entries(tables)
    .filter(([, session]) => pendingCount(session.buffer) > 0)
    .map(([id]) => id);
}
