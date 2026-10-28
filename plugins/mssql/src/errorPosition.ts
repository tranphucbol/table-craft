import type { ErrorPosition } from "@table-craft/plugin-api";

const FIRST_TEXT = /\S/;

/**
 * SQL Server says only the line of the batch an error is on, from 1. The position is that line's
 * first character that is not blank. An error raised inside a procedure or a trigger (`procName`
 * set) counts lines of that module's body, not of the user's text, so it has none.
 */
export function serverErrorPosition(sql: string, cause: unknown): ErrorPosition | undefined {
  const { lineNumber, procName } = (cause ?? {}) as { lineNumber?: unknown; procName?: unknown };
  if (typeof procName === "string" && procName !== "") return undefined;
  if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) return undefined;
  const line = sql.split("\n")[lineNumber - 1];
  if (line === undefined) return undefined;
  return { line: lineNumber, column: (line.search(FIRST_TEXT) === -1 ? 0 : line.search(FIRST_TEXT)) + 1 };
}
