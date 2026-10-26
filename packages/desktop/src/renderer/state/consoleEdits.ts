import type {
  CellInput,
  ColumnMeta,
  CurrentNamespace,
  EditableIdentity,
  EngineError,
  KeySource,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  EMPTY_BUFFER,
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
  type CellEditor,
  type EditTarget,
  committedInput,
} from "@table-craft/desktop/renderer/model/resultEdits.js";
import { keyChangesOf, type KeyChanges } from "@table-craft/desktop/renderer/model/keyChanges.js";
import { rowAt, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/**
 * What a console result can be edited as (plan 026), for the handle the engine answered about: a
 * re-run gets a new handle and asks again.
 */
export interface ConsoleResultEdits {
  readonly handle: string;
  /** Null until the engine answers. */
  readonly editable: EditableIdentity | null;
  readonly columns: readonly ColumnMeta[];
  readonly readOnlyColumns: readonly boolean[];
  readonly buffer: EditBuffer;
  readonly editing: CellEditor | null;
  readonly panel: CellEditor | null;
  readonly submitting: boolean;
  /** Why the last submit failed; the edits stay so the user can fix or revert them. */
  readonly error: EngineError | null;
  /** The whole key a command result holds; its edits apply to the key (decision 119). */
  readonly key?: KeySource;
}

/** A whole-key result's pending edits as changes to its key, as the key tab makes them (decision 119). */
export function resultKeyChanges(result: ResultTab, key: KeySource, buffer: EditBuffer): KeyChanges {
  const columns = result.columns.map((column) => column.name);
  return keyChangesOf(key.type, columns, buffer, (row) => rowAt(result.windows, row));
}

/** A change the key cannot take, as the error the result shows. */
export function keyProblemError(message: string): EngineError {
  return { code: "statementFailed", message, hint: "" };
}

/** The console fields the edits read and write; a slice of `ConsoleSession`. */
export interface EditableConsole {
  readonly datasourceId: string;
  readonly sessionId: string | null;
  readonly status: string;
  readonly namespace: CurrentNamespace;
  readonly results: readonly { readonly id: string; readonly kind: string }[];
  readonly edits: Readonly<Record<string, ConsoleResultEdits>>;
}

/** The result's edits while they belong to its current handle. */
export function editsOf(
  session: Pick<EditableConsole, "edits"> | undefined,
  result: ResultTab | null | undefined,
): ConsoleResultEdits | null {
  if (session === undefined || result == null) return null;
  const edits = session.edits[result.id];
  return edits?.handle === result.handle ? edits : null;
}

export function editTargetOf(result: ResultTab | null, edits: ConsoleResultEdits | null): EditTarget {
  return {
    result,
    buffer: edits?.buffer ?? EMPTY_BUFFER,
    editable: edits?.editable ?? null,
    columns: edits?.columns ?? [],
    readOnlyColumns: edits?.readOnlyColumns ?? [],
  };
}

/** Whether the grid takes edits on `result` now: keyed, live, and its console idle. */
export function isConsoleEditable(
  session: Pick<EditableConsole, "edits" | "status"> | undefined,
  result: ResultTab | null | undefined,
): boolean {
  const edits = editsOf(session, result);
  return (
    edits?.editable != null &&
    "identity" in edits.editable &&
    result?.stale === false &&
    session?.status === "ready" &&
    !edits.submitting
  );
}

/** The reason the result is read-only, once the engine said so; null while editable or unknown. */
export function consoleReadOnlyReason(edits: ConsoleResultEdits | null): string | null {
  return edits?.editable != null && "readOnly" in edits.editable ? edits.editable.readOnly : null;
}

export function pendingEditsOf(edits: ConsoleResultEdits | null | undefined): number {
  return edits == null ? 0 : pendingCount(edits.buffer);
}

/** The console's result ids holding edits not yet submitted, among `resultIds` when given. */
export function pendingResults(
  session: Pick<EditableConsole, "edits" | "results"> | undefined,
  resultIds?: readonly string[],
): readonly string[] {
  if (session === undefined) return [];
  return session.results
    .filter((result) => resultIds === undefined || resultIds.includes(result.id))
    .filter((result) => pendingEditsOf(session.edits[result.id]) > 0 || session.edits[result.id]?.editing != null)
    .map((result) => result.id);
}

/** The console store's parts the edits need; each looks the console up again, so none goes stale. */
export interface ConsoleEditsHost {
  readonly session: (id: string) => EditableConsole | undefined;
  readonly result: (id: string, resultId: string) => ResultTab | undefined;
  readonly client: (id: string) => EngineClient | undefined;
  readonly setEdits: (id: string, resultId: string, edits: ConsoleResultEdits | null) => void;
  readonly updateResult: (id: string, resultId: string, change: (result: ResultTab) => ResultTab) => void;
  /** Runs the submit on the console's session as a statement: Services, history, Output and the re-run. */
  readonly submit: (
    id: string,
    resultId: string,
    client: EngineClient,
    sessionId: string,
    edits: ConsoleResultEdits,
  ) => Promise<boolean>;
}

function newEdits(handle: string): ConsoleResultEdits {
  return {
    handle,
    editable: null,
    columns: [],
    readOnlyColumns: [],
    buffer: EMPTY_BUFFER,
    editing: null,
    panel: null,
    submitting: false,
    error: null,
  };
}

/** The edit commands of a console's results, shaped as the table editor's (plan 026). */
export function createConsoleEdits(host: ConsoleEditsHost) {
  /** The handles asked about and not yet answered, so a re-render does not ask twice. */
  const asking = new Set<string>();

  function current(id: string, resultId: string) {
    const session = host.session(id);
    const result = host.result(id, resultId);
    const edits = editsOf(session, result);
    return { session, result, edits };
  }

  function update(id: string, resultId: string, change: (edits: ConsoleResultEdits) => ConsoleResultEdits): void {
    const { edits } = current(id, resultId);
    if (edits === null) return;
    const next = change(edits);
    if (next !== edits) host.setEdits(id, resultId, next);
  }

  function editable(id: string, resultId: string): { result: ResultTab; edits: ConsoleResultEdits } | null {
    const { session, result, edits } = current(id, resultId);
    if (result === undefined || edits === null || !isConsoleEditable(session, result)) return null;
    return { result, edits };
  }

  function editBuffer(id: string, resultId: string, change: (target: EditTarget) => EditBuffer): void {
    const { result, edits } = current(id, resultId);
    if (result === undefined || edits === null) return;
    const buffer = change(editTargetOf(result, edits));
    if (buffer === edits.buffer) return;
    host.setEdits(id, resultId, { ...edits, buffer, error: null });
    host.updateResult(id, resultId, (latest) => clampedTo(latest, buffer));
  }

  const commands = {
    /** Asks the engine once per handle whether the result is editable. */
    checkEditable: async (id: string, resultId: string): Promise<void> => {
      const { session, result } = current(id, resultId);
      const client = host.client(id);
      if (session === undefined || result === undefined || result.stale || client === undefined) return;
      const known = session.edits[resultId];
      if (known?.handle === result.handle || asking.has(result.handle)) return;
      asking.add(result.handle);
      host.setEdits(id, resultId, newEdits(result.handle));
      try {
        const answer = await client.call("result.editable", {
          handle: result.handle,
          ...(session.namespace === null ? {} : { current: [...session.namespace] }),
        });
        update(id, resultId, (edits) => ({ ...edits, ...answer }));
      } catch (cause) {
        update(id, resultId, (edits) => ({ ...edits, editable: { readOnly: toError(cause).message } }));
      } finally {
        asking.delete(result.handle);
      }
    },

    beginEdit: (id: string, resultId: string, cell: BufferCell, text?: string): void => {
      const target = editable(id, resultId);
      if (target === null) return;
      const editing = editorAt(editTargetOf(target.result, target.edits), cell, text);
      if (editing !== null) host.setEdits(id, resultId, { ...target.edits, editing });
    },

    changeEdit: (id: string, resultId: string, text: string): void => {
      update(id, resultId, (edits) =>
        edits.editing === null || edits.editing.text === text
          ? edits
          : { ...edits, editing: { ...edits.editing, text } },
      );
    },

    commitEdit: (id: string, resultId: string): boolean => {
      const { result, edits } = current(id, resultId);
      const editing = edits?.editing;
      if (editing == null) return false;
      update(id, resultId, (latest) => ({ ...latest, editing: null }));
      if (editing.text !== editing.initial)
        commands.setCells(id, resultId, [editing], committedInput(result?.typeClasses[editing.column], editing.text));
      return true;
    },

    cancelEdit: (id: string, resultId: string): void => {
      update(id, resultId, (edits) => (edits.editing === null ? edits : { ...edits, editing: null }));
    },

    editPanel: (id: string, resultId: string, cell: BufferCell | null, text?: string): void => {
      if (cell === null) {
        update(id, resultId, (edits) => (edits.panel === null ? edits : { ...edits, panel: null }));
        return;
      }
      const target = editable(id, resultId);
      if (target === null) return;
      const edited = editTargetOf(target.result, target.edits);
      if (!canEditCell(edited, cell)) return;
      const panel = target.edits.panel;
      const same = panel?.row === cell.row && panel.column === cell.column;
      const initial = same ? panel.initial : editCellText(edited, cell);
      host.setEdits(id, resultId, {
        ...target.edits,
        panel: { row: cell.row, column: cell.column, text: text ?? initial, initial },
      });
    },

    applyPanel: (id: string, resultId: string): boolean => {
      const { result, edits } = current(id, resultId);
      const panel = edits?.panel;
      if (panel == null) return false;
      update(id, resultId, (latest) => ({ ...latest, panel: null }));
      if (panel.text !== panel.initial)
        commands.setCells(id, resultId, [panel], committedInput(result?.typeClasses[panel.column], panel.text));
      return true;
    },

    setCells: (id: string, resultId: string, cells: readonly BufferCell[], input: CellInput): void => {
      editBuffer(id, resultId, (target) => withCells(target, cells, input));
    },

    addRow: (id: string, resultId: string): void => {
      editBuffer(id, resultId, (target) => withAddedRow(target));
    },

    duplicateRows: (id: string, resultId: string, rows: readonly number[]): void => {
      editBuffer(id, resultId, (target) => withDuplicates(target, rows));
    },

    deleteRows: (id: string, resultId: string, rows: readonly number[]): void => {
      editBuffer(id, resultId, (target) => withDeletes(target, rows));
    },

    revertEdits: (id: string, resultId: string, cells: readonly BufferCell[]): void => {
      editBuffer(id, resultId, (target) => withReverted(target, cells));
    },

    revertAllEdits: (id: string, resultId: string): void => {
      editBuffer(id, resultId, () => EMPTY_BUFFER);
      update(id, resultId, (edits) => ({ ...edits, editing: null, panel: null, error: null }));
    },

    previewEdits: async (id: string, resultId: string): Promise<readonly string[] | null> => {
      const { result, edits } = current(id, resultId);
      const client = host.client(id);
      if (result === undefined || edits === null || client === undefined) return null;
      try {
        if (edits.key !== undefined) {
          const pending = resultKeyChanges(result, edits.key, edits.buffer);
          if ("problem" in pending) {
            update(id, resultId, (latest) => ({ ...latest, error: keyProblemError(pending.problem) }));
            return null;
          }
          const options = { type: edits.key.type, guard: true };
          return await client.call("keyspace.preview", { key: edits.key.key, changes: pending.changes, options });
        }
        return await client.call("edits.preview", { handle: result.handle, edits: toEdits(edits.buffer) });
      } catch (cause) {
        update(id, resultId, (latest) => ({ ...latest, error: toError(cause) }));
        return null;
      }
    },

    submitEdits: async (id: string, resultId: string): Promise<boolean> => {
      commands.commitEdit(id, resultId);
      commands.applyPanel(id, resultId);
      const target = editable(id, resultId);
      const session = host.session(id);
      const client = host.client(id);
      if (target === null || session?.sessionId == null || client === undefined) return false;
      if (pendingCount(target.edits.buffer) === 0) return false;
      host.setEdits(id, resultId, { ...target.edits, submitting: true, error: null });
      try {
        return await host.submit(id, resultId, client, session.sessionId, target.edits);
      } finally {
        update(id, resultId, (edits) => (edits.submitting ? { ...edits, submitting: false } : edits));
      }
    },
  };
  return commands;
}

export type ConsoleEdits = ReturnType<typeof createConsoleEdits>;
