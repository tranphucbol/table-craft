import type { ErrorPosition } from "@table-craft/plugin-api";

/** `near "frm": syntax error`, `no such column: nme`, `no such table: main.ordrs`. */
const NAMED_TOKEN = /^(?:near "([\s\S]+)": syntax error|no such (?:column|table): (\S+))$/;
const INCOMPLETE_INPUT = "incomplete input";
const WORD = /^\w+$/;

function occurrences(sql: string, token: string): number[] {
  const found: number[] = [];
  const word = WORD.test(token);
  for (let at = sql.indexOf(token); at !== -1; at = sql.indexOf(token, at + 1)) {
    const before = sql[at - 1] ?? " ";
    const after = sql[at + token.length] ?? " ";
    if (!word || (!/\w/.test(before) && !/\w/.test(after))) found.push(at);
  }
  return found;
}

/**
 * SQLite names the token it stopped at but gives no offset, so the token is pointed at only when
 * it occurs exactly once in the statement; a guess between two places would mislead. A qualified
 * table name (`main.t`) is looked for as written and, failing that, without its schema.
 */
export function sqliteErrorPosition(sql: string, message: string): ErrorPosition | undefined {
  if (message === INCOMPLETE_INPUT) return { offset: sql.trimEnd().length };
  const match = NAMED_TOKEN.exec(message);
  const token = match?.[1] ?? match?.[2];
  if (token === undefined) return undefined;
  const candidates =
    token.includes(".") && match?.[2] !== undefined ? [token, token.slice(token.indexOf(".") + 1)] : [token];
  for (const candidate of candidates) {
    const found = occurrences(sql, candidate);
    if (found.length === 1) return { offset: found[0] ?? 0 };
    if (found.length > 1) return undefined;
  }
  return undefined;
}
