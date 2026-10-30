import type { CellInput, ColumnMeta, EditableIdentity, TypeClass } from "@table-craft/desktop/engine/protocol.js";
import { formatCell } from "@table-craft/desktop/renderer/grid/format.js";
import {
  addRow,
  bufferRowAt,
  deleteRows,
  duplicateRows,
  gridRowCount,
  inputOf,
  pendingInput,
  revertCells,
  setCell,
  type BufferCell,
  type EditBuffer,
} from "@table-craft/desktop/renderer/model/editBuffer.js";
import { clampSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { rowAt, shownHeld, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";

/** The cell being edited in place: its grid row, result column and the text typed so far. */
export interface CellEditor extends BufferCell {
  readonly text: string;
  /** The text the editor opened with; committing it unchanged writes nothing. */
  readonly initial: string;
}

/**
 * A result the grid edits: a table tab's rows or an editable console result (plan 026). Both go
 * through these functions, so a console edit behaves as the table editor's does.
 */
export interface EditTarget {
  readonly result: ResultTab | null;
  readonly buffer: EditBuffer;
  readonly editable: EditableIdentity | null;
  /** The catalog's view of the result's columns, matched by name. */
  readonly columns: readonly ColumnMeta[];
  /** Result columns no edit may write, such as a console result's expressions; absent when none. */
  readonly readOnlyColumns?: readonly boolean[];
}

export function identityOf(target: EditTarget): readonly string[] {
  return target.editable !== null && "identity" in target.editable ? target.editable.identity : [];
}

export function isReadOnlyColumn(target: EditTarget, column: number): boolean {
  return target.readOnlyColumns?.[column] === true;
}

/** Whether a cell takes a new value: a live, not deleted row and a column the result can write. */
export function canWriteCell(target: EditTarget, cell: BufferCell): boolean {
  const result = target.result;
  if (result === null || isReadOnlyColumn(target, cell.column)) return false;
  const row = bufferRowAt(target.buffer, shownHeld(result), cell.row);
  return row !== null && !(row.kind === "held" && target.buffer.deletes.has(row.row));
}

/**
 * Whether a cell takes a typed edit. Bytes arrive as a preview only, so there is nothing whole to
 * edit as text (plan 008 decision 9); a file loads into them instead (plan 043).
 */
export function canEditCell(target: EditTarget, cell: BufferCell): boolean {
  return target.result?.typeClasses[cell.column] !== "bytes" && canWriteCell(target, cell);
}

/** The text a cell shows and edits from: its pending input, else its value; null and default edit as empty. */
export function editCellText(target: EditTarget, cell: BufferCell): string {
  const result = target.result;
  if (result === null) return "";
  const row = bufferRowAt(target.buffer, shownHeld(result), cell.row);
  if (row === null) return "";
  const pending = pendingInput(target.buffer, row, cell.column);
  if (pending?.kind === "boolean") return String(pending.value);
  if (pending !== undefined) return pending.kind === "text" ? pending.text : "";
  if (row.kind === "inserted") return "";
  const value = rowAt(result.windows, cell.row)?.[cell.column];
  return value === undefined || value === null ? "" : formatCell(value);
}

const TRUE_TEXTS: ReadonlySet<string> = new Set(["true", "t", "1", "yes", "on"]);
const FALSE_TEXTS: ReadonlySet<string> = new Set(["false", "f", "0", "no", "off"]);

/** The boolean a cell's text reads as, as PostgreSQL reads one; null when it reads as neither. */
export function booleanOfText(text: string): boolean | null {
  const word = text.trim().toLowerCase();
  if (TRUE_TEXTS.has(word)) return true;
  return FALSE_TEXTS.has(word) ? false : null;
}

/**
 * What a cell editor's text writes. A boolean column takes a boolean literal, which every dialect
 * spells, and an empty editor as NULL; a text literal such as `'true'` is not a boolean in SQLite.
 */
export function committedInput(typeClass: TypeClass | undefined, text: string): CellInput {
  if (typeClass !== "boolean") return { kind: "text", text };
  if (text.trim() === "") return { kind: "null" };
  const value = booleanOfText(text);
  return value === null ? { kind: "text", text } : { kind: "boolean", value };
}

/** The value Toggle Boolean writes: the opposite of the cell's, and true for NULL. */
export function toggledBoolean(target: EditTarget, cell: BufferCell): boolean {
  return booleanOfText(editCellText(target, cell)) !== true;
}

/** The editor opened on `cell`, or null when the cell takes no edit. */
export function editorAt(target: EditTarget, cell: BufferCell, text?: string): CellEditor | null {
  if (!canEditCell(target, cell)) return null;
  const initial = editCellText(target, cell);
  return { ...cell, text: text ?? initial, initial };
}

export function withCells(target: EditTarget, cells: readonly BufferCell[], input: CellInput): EditBuffer {
  const result = target.result;
  if (result === null) return target.buffer;
  return cells.reduce((buffer, cell) => {
    if (isReadOnlyColumn(target, cell.column)) return buffer;
    const row = bufferRowAt(buffer, shownHeld(result), cell.row);
    return row === null ? buffer : setCell(buffer, row, cell.column, input);
  }, target.buffer);
}

export function withAddedRow(target: EditTarget): EditBuffer {
  return addRow(target.buffer, target.result?.columns.length ?? 0);
}

/**
 * Copies of `rows` appended; identity columns with a default, auto-increment ones and read-only
 * ones take their default, so the copy gets a key of its own and writes only what it may.
 */
export function withDuplicates(target: EditTarget, rows: readonly number[]): EditBuffer {
  const { result, buffer } = target;
  if (result === null) return buffer;
  const sources = rows.flatMap((index) => {
    const row = bufferRowAt(buffer, shownHeld(result), index);
    if (row === null) return [];
    if (row.kind === "inserted") return [buffer.inserts.find((inserted) => inserted.id === row.id)?.values ?? []];
    const values = rowAt(result.windows, index);
    if (values === undefined) return [];
    return [result.columns.map((_, column) => pendingInput(buffer, row, column) ?? inputOf(values[column]))];
  });
  const identity = identityOf(target);
  const defaulted = result.columns.map((column, index) => {
    const meta = target.columns.find((each) => each.name === column.name);
    return (
      isReadOnlyColumn(target, index) ||
      meta?.autoIncrement === true ||
      (identity.includes(column.name) && meta?.default != null)
    );
  });
  return duplicateRows(buffer, sources, defaulted);
}

export function withDeletes(target: EditTarget, rows: readonly number[]): EditBuffer {
  const result = target.result;
  if (result === null) return target.buffer;
  const named = rows.flatMap((index) => {
    const row = bufferRowAt(target.buffer, shownHeld(result), index);
    return row === null ? [] : [row];
  });
  return deleteRows(target.buffer, named);
}

export function withReverted(target: EditTarget, cells: readonly BufferCell[]): EditBuffer {
  const result = target.result;
  return result === null ? target.buffer : revertCells(target.buffer, shownHeld(result), cells);
}

export function submitLabel(statements: number): string {
  return `Submit ${String(statements)} ${statements === 1 ? "statement" : "statements"}`;
}

/** A submit as one script that runs as it ran: each statement ends in `;`, one per line. */
export function submittedScript(statements: readonly string[]): string {
  return statements
    .map((statement) => statement.trimEnd())
    .map((statement) => (statement.endsWith(";") ? statement : `${statement};`))
    .join("\n");
}

/** The notice after a submit. */
export function submittedText(statements: number): string {
  return `Submitted ${String(statements)} ${statements === 1 ? "statement" : "statements"}`;
}

/** A whole-key result's submit as the Services tree names it (decision 119). */
export function submitCommandsLabel(commands: number): string {
  return `Submit ${String(commands)} ${commands === 1 ? "command" : "commands"}`;
}

/** A whole-key result's atomic submit. */
export function submittedCommandsText(commands: number): string {
  return `Submitted ${String(commands)} ${commands === 1 ? "command" : "commands"} atomically`;
}

/** The result with its selection kept inside the rows and columns `buffer` draws. */
export function clampedTo(result: ResultTab, buffer: EditBuffer): ResultTab {
  const rows = gridRowCount(buffer, shownHeld(result));
  const columns = result.layout.hidden.filter((hidden) => !hidden).length;
  const selection = clampSelection(result.selection, { rows, columns });
  return selection === result.selection ? result : { ...result, selection };
}
