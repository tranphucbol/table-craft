import type { ErrorPosition } from "@table-craft/plugin-api";

const UTF8 = new TextEncoder();

/**
 * node-oracledb's `offset`: where in the statement the server stopped parsing, counted in bytes
 * of the statement as sent (UTF-8) from 0. The server reports 0 for errors that point nowhere (a
 * constraint, a division by zero), so 0 is taken for "no position" rather than for the first
 * character.
 */
export function serverErrorPosition(sql: string, cause: unknown): ErrorPosition | undefined {
  const raw = (cause as { offset?: unknown } | null)?.offset;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return undefined;
  let offset = 0;
  let bytes = 0;
  while (bytes < raw && offset < sql.length) {
    const character = String.fromCodePoint(sql.codePointAt(offset) ?? 0);
    bytes += UTF8.encode(character).length;
    offset += character.length;
  }
  return { offset };
}
