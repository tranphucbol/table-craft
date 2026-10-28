import type { CellInput } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { visibleColumns } from "@table-craft/desktop/renderer/model/columnLayout.js";
import {
  bufferRowAt,
  gridRowCount,
  pendingCount,
  type BufferCell,
} from "@table-craft/desktop/renderer/model/editBuffer.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import { rectOf, selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import type { CellEditor, EditTarget } from "@table-craft/desktop/renderer/model/resultEdits.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { editsOf, editTargetOf, isConsoleEditable } from "@table-craft/desktop/renderer/state/consoleEdits.js";
import { activeResultOf, useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { shownHeld } from "@table-craft/desktop/renderer/state/resultTab.js";
import { isEditable, useTables } from "@table-craft/desktop/renderer/state/tables.js";
import {
  isKeyEditable,
  keyEditTarget,
  pendingKeyCount,
  useKeyTabs,
} from "@table-craft/desktop/renderer/state/keyTabs.js";

const SQL_TERMINATOR = ";";

/**
 * What the grid's edit actions work on (plan 026): a table tab's rows or the active console's
 * shown result. Both run the same commands, so editing either feels the same.
 */
export interface EditSurface {
  readonly target: EditTarget;
  readonly editable: boolean;
  readonly editing: CellEditor | null;
  readonly panel: CellEditor | null;
  readonly pending: number;
  /** The preview dialog's sentence for `statements` statements. */
  readonly submitsAs: (statements: number) => string;
  /** What the preview shows after each statement: `;` for SQL, nothing for commands. */
  readonly terminator: string;
  readonly beginEdit: (cell: BufferCell, text?: string) => void;
  readonly commitEdit: () => void;
  readonly setCells: (cells: readonly BufferCell[], input: CellInput) => void;
  readonly addRow: () => void;
  readonly duplicateRows: (rows: readonly number[]) => void;
  readonly deleteRows: (rows: readonly number[]) => void;
  readonly revert: (cells: readonly BufferCell[]) => void;
  readonly revertAll: () => void;
  readonly applyPanel: () => void;
  readonly preview: () => Promise<readonly string[] | null>;
  readonly submit: () => Promise<boolean>;
  /** Selects the grid's last row, where Add Row and Duplicate put theirs, and gives the grid focus. */
  readonly selectLastRow: () => void;
}

function statementsText(statements: number): string {
  return `${formatCount(statements)} ${statements === 1 ? "statement" : "statements"}`;
}

function tableSurface(id: string): EditSurface | null {
  const store = useTables.getState;
  const session = store().tables[id];
  if (session === undefined) return null;
  return {
    target: session,
    editable: isEditable(session),
    editing: session.editing,
    panel: session.panel,
    pending: pendingCount(session.buffer),
    terminator: SQL_TERMINATOR,
    submitsAs: (statements) => `Submit runs ${statementsText(statements)} in one transaction.`,
    beginEdit: (cell, text) => store().beginEdit(id, cell, text),
    commitEdit: () => void store().commitEdit(id),
    setCells: (cells, input) => store().setCells(id, cells, input),
    addRow: () => store().addRow(id),
    duplicateRows: (rows) => store().duplicateRows(id, rows),
    deleteRows: (rows) => store().deleteRows(id, rows),
    revert: (cells) => store().revert(id, cells),
    revertAll: () => store().revertAll(id),
    applyPanel: () => void store().applyPanel(id),
    preview: () => store().preview(id),
    submit: () => store().submit(id),
    selectLastRow: () => {
      const latest = store().tables[id];
      const result = latest?.result;
      if (latest === undefined || result == null) return;
      const row = gridRowCount(latest.buffer, shownHeld(result)) - 1;
      store().select(id, result.id, selectCell({ row, column: result.selection?.focus.column ?? 0 }));
      focusRegion("grid");
    },
  };
}

function commandsText(commands: number): string {
  return `${formatCount(commands)} ${commands === 1 ? "command" : "commands"}`;
}

function keySubmitsAs(commands: number): string {
  return `Submit runs ${commandsText(commands)} atomically; it cannot be undone.`;
}

function consoleSurface(id: string): EditSurface | null {
  const store = useConsoles.getState;
  const session = store().consoles[id];
  const result = session === undefined ? null : activeResultOf(session);
  if (session === undefined || result === null) return null;
  const edits = editsOf(session, result);
  if (edits === null) return null;
  const resultId = result.id;
  return {
    target: editTargetOf(result, edits),
    editable: isConsoleEditable(session, result),
    editing: edits.editing,
    panel: edits.panel,
    pending: pendingCount(edits.buffer),
    ...(edits.key === undefined
      ? {
          terminator: SQL_TERMINATOR,
          submitsAs: (statements: number) =>
            session.txMode === "auto"
              ? `Submit runs ${statementsText(statements)} in one transaction and commits it.`
              : `Submit runs ${statementsText(statements)} in the console's transaction; they stay uncommitted until you commit.`,
        }
      : { terminator: "", submitsAs: keySubmitsAs }),
    beginEdit: (cell, text) => store().beginEdit(id, resultId, cell, text),
    commitEdit: () => void store().commitEdit(id, resultId),
    setCells: (cells, input) => store().setCells(id, resultId, cells, input),
    addRow: () => store().addRow(id, resultId),
    duplicateRows: (rows) => store().duplicateRows(id, resultId, rows),
    deleteRows: (rows) => store().deleteRows(id, resultId, rows),
    revert: (cells) => store().revertEdits(id, resultId, cells),
    revertAll: () => store().revertAllEdits(id, resultId),
    applyPanel: () => void store().applyPanel(id, resultId),
    preview: () => store().previewEdits(id, resultId),
    submit: () => store().submitEdits(id, resultId),
    selectLastRow: () => {
      const latest = store().consoles[id];
      const shown = latest === undefined ? null : activeResultOf(latest);
      const buffer = editsOf(latest, shown)?.buffer;
      if (shown === null || buffer === undefined) return;
      const row = gridRowCount(buffer, shownHeld(shown)) - 1;
      store().select(id, shown.id, selectCell({ row, column: shown.selection?.focus.column ?? 0 }));
      focusRegion("grid");
    },
  };
}

/** A key tab (plan 058 decision 16): its rows, its string value, or the Recreate it holds. */
function keySurface(id: string, datasourceReadOnly: boolean): EditSurface | null {
  const store = useKeyTabs.getState;
  const tab = store().tabs[id];
  if (tab === undefined) return null;
  const recreating = tab.recreating && !datasourceReadOnly && tab.status === "ready";
  return {
    target: keyEditTarget(tab),
    editable: recreating || isKeyEditable(tab, datasourceReadOnly),
    editing: tab.editing,
    panel: tab.panel,
    pending: pendingKeyCount(tab),
    submitsAs: keySubmitsAs,
    terminator: "",
    beginEdit: (cell, text) => store().beginEdit(id, cell, text),
    commitEdit: () => void store().commitEdit(id),
    setCells: (cells, input) => store().setCells(id, cells, input),
    addRow: () => store().addRow(id),
    duplicateRows: (rows) => store().duplicateRows(id, rows),
    deleteRows: (rows) => store().deleteRows(id, rows),
    revert: (cells) => store().revert(id, cells),
    revertAll: () => store().revertAll(id),
    applyPanel: () => void store().applyPanel(id),
    preview: () => store().preview(id),
    submit: () => store().submit(id),
    selectLastRow: () => {
      const latest = store().tabs[id];
      const result = latest?.result;
      if (latest === undefined || result == null) return;
      const row = gridRowCount(latest.buffer, shownHeld(result)) - 1;
      store().select(id, result.id, selectCell({ row, column: result.selection?.focus.column ?? 0 }));
      focusRegion("grid");
    },
  };
}

/** The active tab's edit surface: its table, its key, or its console's shown result once asked about. */
export function editSurfaceOf(context: ActionContext): EditSurface | null {
  const tab = context.activeTab;
  if (tab?.kind === "table" && context.table !== null) return tableSurface(tab.id);
  if (tab?.kind === "key" && context.keyTab !== null) {
    return keySurface(tab.id, context.datasource?.view.readOnly === true);
  }
  if (tab?.kind === "console" && context.console !== null) return consoleSurface(tab.id);
  return null;
}

/** The active surface when it takes edits now. */
export function editableSurfaceOf(context: ActionContext): EditSurface | null {
  const surface = editSurfaceOf(context);
  return surface?.editable === true ? surface : null;
}

/** The selected cells as grid rows and result columns. */
export function selectedCells(target: EditTarget): readonly BufferCell[] {
  const result = target.result;
  if (result?.selection == null) return [];
  const rect = rectOf(result.selection);
  const visible = visibleColumns(result.layout);
  const cells: BufferCell[] = [];
  for (let row = rect.top; row <= rect.bottom; row++) {
    for (let position = rect.left; position <= rect.right; position++) {
      const column = visible[position];
      if (column !== undefined) cells.push({ row, column });
    }
  }
  return cells;
}

/** The grid rows the selection spans. */
export function selectedRows(target: EditTarget): readonly number[] {
  const selection = target.result?.selection;
  if (selection == null) return [];
  const rect = rectOf(selection);
  return Array.from({ length: rect.bottom - rect.top + 1 }, (_, index) => rect.top + index);
}

/** The selected rows the engine holds, by result row: values that are not pending in the buffer. */
export function heldRows(target: EditTarget): readonly number[] {
  const held = target.result === null ? 0 : shownHeld(target.result);
  return selectedRows(target).flatMap((index) => {
    const row = bufferRowAt(target.buffer, held, index);
    return row?.kind === "held" ? [row.row] : [];
  });
}

/** The focused cell's result column. */
export function focusedColumn(target: EditTarget): number | null {
  const result = target.result;
  if (result?.selection == null) return null;
  return visibleColumns(result.layout)[result.selection.focus.column] ?? null;
}

/** Whether the surface takes edits on its selection: something selected and no cell editor open. */
export function hasEditableSelection(context: ActionContext): boolean {
  const surface = editableSurfaceOf(context);
  return surface !== null && surface.target.result?.selection != null && surface.editing === null;
}
