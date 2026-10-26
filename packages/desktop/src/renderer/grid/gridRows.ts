import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import type { CellInput, WireValue } from "@table-craft/desktop/engine/protocol.js";
import { GRID_ACTION_IDS } from "@table-craft/desktop/renderer/actions/gridActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { EditMark, GridEdits, GridHost } from "@table-craft/desktop/renderer/grid/GridCells.js";
import { bufferRowAt, type EditBuffer } from "@table-craft/desktop/renderer/model/editBuffer.js";
import {
  contains,
  extendTo,
  rectOf,
  selectCell,
  type Cell,
  type GridSelection,
} from "@table-craft/desktop/renderer/model/gridSelection.js";
import { rowAt, shownHeld, type ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";

const PRINTABLE_KEY_LENGTH = 1;

export interface RowsProps {
  readonly ownerId: string;
  readonly result: ResultTab;
  /** Result column indices in drawing order. */
  readonly visible: readonly number[];
  readonly host: () => GridHost;
  readonly edits: GridEdits | undefined;
}

/** A row's values and pending inputs as the grid draws them. */
export interface DrawnRow {
  readonly values: readonly WireValue[] | undefined;
  readonly pending: (column: number) => CellInput | undefined;
  readonly mark: EditMark | null;
}

/** Grid row `index`: a shown row's window values, with the buffer's edits named by its held row. */
export function drawnRow(result: ResultTab, buffer: EditBuffer | undefined, index: number): DrawnRow {
  const values = rowAt(result.windows, index);
  if (buffer === undefined) return { values, pending: () => undefined, mark: null };
  const row = bufferRowAt(buffer, shownHeld(result), index);
  if (row?.kind === "inserted") {
    const inserted = buffer.inserts.find((each) => each.id === row.id);
    return { values: [], pending: (column) => inserted?.values[column], mark: "inserted" };
  }
  if (row === null) return { values, pending: () => undefined, mark: null };
  const updates = buffer.updates.get(row.row);
  return {
    values,
    pending: (column) => updates?.get(column),
    mark: buffer.deletes.has(row.row) ? "deleted" : null,
  };
}

/** The loaded windows' matched cells as `row * columnCount + column` keys. */
export function matchKeys(matches: ResultTab["matches"], width: number): ReadonlySet<number> {
  const keys = new Set<number>();
  for (const pairs of Object.values(matches)) {
    for (let index = 0; index + 1 < pairs.length; index += 2) {
      keys.add((pairs[index] as number) * width + (pairs[index + 1] as number));
    }
  }
  return keys;
}

export function cellOf(target: EventTarget): Cell | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest("[data-row][data-col]");
  if (element === null) return null;
  return { row: Number(element.getAttribute("data-row")), column: Number(element.getAttribute("data-col")) };
}

/** F2 opens the editor on the focused cell; a printable key opens it with that text (plan 008). */
export function beganEdit(
  event: KeyboardEvent<HTMLDivElement>,
  edits: GridEdits | undefined,
  selection: GridSelection | null,
): boolean {
  if (edits === undefined || selection === null) return false;
  if (event.key === "F2") {
    event.preventDefault();
    edits.begin();
    return true;
  }
  if (event.key.length === PRINTABLE_KEY_LENGTH && event.key !== " ") {
    event.preventDefault();
    edits.begin(event.key);
    return true;
  }
  return false;
}

/** Click, Shift-click and drag select cells; a double-click edits, or shows the value panel. */
export function useCellPointer(
  selection: GridSelection | null,
  select: (selection: GridSelection | null) => void,
  edits: GridEdits | undefined,
) {
  const dragging = useRef(false);

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  return {
    onMouseDown(event: MouseEvent<HTMLDivElement>): void {
      if (event.button !== 0) return;
      const cell = cellOf(event.target);
      if (cell === null) return;
      dragging.current = true;
      select(event.shiftKey && selection !== null ? extendTo(selection, cell) : selectCell(cell));
    },
    onMouseOver(event: MouseEvent<HTMLDivElement>): void {
      if (!dragging.current || (event.buttons & 1) === 0) return;
      const cell = cellOf(event.target);
      if (cell === null || selection === null) return;
      if (cell.row !== selection.focus.row || cell.column !== selection.focus.column) select(extendTo(selection, cell));
    },
    onContextMenu(event: MouseEvent<HTMLDivElement>): void {
      const cell = cellOf(event.target);
      if (cell === null) return;
      const rect = selection === null ? null : rectOf(selection);
      if (rect === null || !contains(rect, cell.row, cell.column)) select(selectCell(cell));
    },
    onDoubleClick(event: MouseEvent<HTMLDivElement>): void {
      if (cellOf(event.target) === null) return;
      if (edits !== undefined) edits.begin();
      else if (!useLayout.getState().layout.valuePanel) invoke(GRID_ACTION_IDS.toggleValuePanel);
    },
  };
}
