/**
 * A result tab's column widths and hidden columns (plan 007 decision 8). Indices are the result's
 * column indices; the grid draws the visible ones in result order, since columns never reorder.
 */

/** `auto` sizes to the first page's text (capped by a token), `px` is a drag, `fit` a double-click. */
export type ColumnWidth =
  | { readonly kind: "auto" }
  | { readonly kind: "px"; readonly px: number }
  | { readonly kind: "fit"; readonly chars: number };

export interface ColumnLayout {
  readonly widths: readonly ColumnWidth[];
  readonly hidden: readonly boolean[];
  /** Records drawn as columns and columns as rows (plan 043); the selection keeps record coordinates. */
  readonly transposed?: boolean;
}

export const MIN_COLUMN_WIDTH_PX = 40;
const AUTO: ColumnWidth = { kind: "auto" };
const CELL_BORDER = "1px";

export function initialLayout(columnCount: number): ColumnLayout {
  return {
    widths: Array.from({ length: columnCount }, () => AUTO),
    hidden: Array.from({ length: columnCount }, () => false),
  };
}

function withWidth(layout: ColumnLayout, column: number, width: ColumnWidth): ColumnLayout {
  if (column < 0 || column >= layout.widths.length) return layout;
  return { ...layout, widths: layout.widths.map((current, index) => (index === column ? width : current)) };
}

/** A drag to `px`, never narrower than `MIN_COLUMN_WIDTH_PX`. */
export function resizedTo(layout: ColumnLayout, column: number, px: number): ColumnLayout {
  return withWidth(layout, column, { kind: "px", px: Math.max(MIN_COLUMN_WIDTH_PX, Math.round(px)) });
}

/** A double-click on the edge: as wide as the loaded text, past the auto cap. */
export function fittedTo(layout: ColumnLayout, column: number, chars: number): ColumnLayout {
  return withWidth(layout, column, { kind: "fit", chars });
}

/** Hides `column`, unless it is the last one showing: a grid with no columns has nothing to show again from. */
export function hiddenColumn(layout: ColumnLayout, column: number): ColumnLayout {
  if (column < 0 || column >= layout.hidden.length || layout.hidden[column] === true) return layout;
  if (visibleColumns(layout).length <= 1) return layout;
  return { ...layout, hidden: layout.hidden.map((hidden, index) => hidden || index === column) };
}

export function allShown(layout: ColumnLayout): ColumnLayout {
  if (!layout.hidden.includes(true)) return layout;
  return { ...layout, hidden: layout.hidden.map(() => false) };
}

/** The column indices the grid draws, copies and exports, in result order. */
export function visibleColumns(layout: ColumnLayout): readonly number[] {
  return layout.hidden.flatMap((hidden, index) => (hidden ? [] : [index]));
}

/**
 * Keeps widths and hidden columns across a rerun when the columns are the same, else starts over;
 * a transposed view stays transposed either way.
 */
export function carriedLayout(layout: ColumnLayout, before: readonly string[], after: readonly string[]): ColumnLayout {
  const same = before.length === after.length && before.every((name, index) => name === after[index]);
  if (same) return layout;
  const fresh = initialLayout(after.length);
  return layout.transposed === true ? { ...fresh, transposed: true } : fresh;
}

function charsTrack(chars: number): string {
  return `calc(${chars}ch + 2 * var(--spacing-cell) + ${CELL_BORDER})`;
}

/** The CSS grid track for one column; `autoChars` is its first-page width in characters. */
export function columnTrack(width: ColumnWidth, autoChars: number): string {
  switch (width.kind) {
    case "auto":
      return `min(var(--spacing-column-max), ${charsTrack(autoChars)})`;
    case "fit":
      return charsTrack(width.chars);
    case "px":
      return `${width.px}px`;
  }
}

/** The track list for the visible columns. */
export function columnTemplate(layout: ColumnLayout, autoChars: readonly number[]): string {
  return visibleColumns(layout)
    .map((column) => columnTrack(layout.widths[column] ?? AUTO, autoChars[column] ?? 0))
    .join(" ");
}
