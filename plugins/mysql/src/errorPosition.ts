import type { ErrorPosition } from "@table-craft/plugin-api";

/** MySQL and MariaDB: `… for the right syntax to use near 'FROM t' at line 2`. */
const MYSQL_NEAR = /near '([\s\S]*)' at line (\d+)\s*$/;
/** TiDB: `… for the right syntax to use line 2 column 5 near "FROM t" `. */
const TIDB_NEAR = /line (\d+) column (\d+) near "([\s\S]*)"\s*$/;

function lineStart(sql: string, line: number): number | undefined {
  let start = 0;
  for (let current = 1; current < line; current += 1) {
    const end = sql.indexOf("\n", start);
    if (end === -1) return undefined;
    start = end + 1;
  }
  return start;
}

/**
 * Where a syntax error is, from the server's message: MySQL quotes the text from the error on
 * (at most 80 characters) and the line it starts on; TiDB adds a column. The quoted fragment is
 * looked for from the start of that line, since the column TiDB reports is not where the fragment
 * begins; a fragment that is the rest of the statement is matched at its end. An empty fragment
 * means the statement ended too early.
 */
export function syntaxErrorPosition(sql: string, message: string): ErrorPosition | undefined {
  const mysql = MYSQL_NEAR.exec(message);
  const tidb = mysql === null ? TIDB_NEAR.exec(message) : null;
  const near = mysql?.[1] ?? tidb?.[3];
  const lineText = mysql?.[2] ?? tidb?.[1];
  if (near === undefined || lineText === undefined) return undefined;
  const line = Number(lineText);
  const start = lineStart(sql, line);
  if (start === undefined) return undefined;
  const body = sql.trimEnd();
  if (near === "") return { offset: body.length };
  if (body.endsWith(near) && body.length - near.length >= start) {
    return { offset: body.length - near.length };
  }
  const found = sql.indexOf(near, start);
  if (found !== -1) return { offset: found };
  return { line, column: 1 };
}
