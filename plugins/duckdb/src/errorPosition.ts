import type { ErrorPosition } from "@table-craft/plugin-api";

/** `LINE 2: FROM ordrs` and, under it, carets under the token DuckDB stopped at. */
const LINE_AND_CARET = /\nLINE (\d+): (.*)\n( *)\^+\s*$/u;
const PREFIX_WIDTH = (line: string): number => `LINE ${line}: `.length;
/** DuckDB shortens a long line to a window around the error and marks the cut with `...`. */
const SHORTENED = "...";

/**
 * Where DuckDB's caret points, as a line and column of `sql`. Nothing when the message has no
 * caret, or when DuckDB shortened the line: the shown text then no longer lines up with `sql`.
 */
export function duckdbErrorPosition(sql: string, message: string): ErrorPosition | undefined {
  const match = LINE_AND_CARET.exec(message);
  if (match === null) return undefined;
  const [, lineText = "", shown = "", padding = ""] = match;
  if (shown.startsWith(SHORTENED)) return undefined;
  const line = Number(lineText);
  const written = sql.split("\n")[line - 1];
  const kept = shown.endsWith(SHORTENED) ? shown.slice(0, -SHORTENED.length) : shown;
  if (written === undefined || !written.startsWith(kept)) {
    return undefined;
  }
  const column = padding.length - PREFIX_WIDTH(lineText) + 1;
  return column < 1 ? undefined : { line, column };
}
