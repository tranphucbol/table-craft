import type { ErrorPosition } from "@table-craft/plugin-api";

/**
 * PostgreSQL's `position` field: a 1-based index in characters (code points) into the statement
 * it received, as a decimal string. `internalPosition` points into a query the server generated
 * (a function body), not into the user's text, so it is ignored.
 */
export function serverErrorPosition(sql: string, cause: unknown): ErrorPosition | undefined {
  const raw = (cause as { position?: unknown } | null)?.position;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const characters = Number(raw);
  if (!Number.isInteger(characters) || characters < 1) return undefined;
  let offset = 0;
  for (let seen = 1; seen < characters && offset < sql.length; seen += 1) {
    offset += (sql.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  }
  return { offset };
}
