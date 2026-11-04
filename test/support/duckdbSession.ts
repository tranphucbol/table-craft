import type { ParameterValue, Row } from "@table-craft/plugin-api";
import duckdb from "@table-craft/plugin-duckdb";

export type DuckdbSession = Awaited<ReturnType<typeof duckdb.connect>>;

export interface DuckdbOptions {
  readonly readOnly?: boolean;
  readonly readOnlyFile?: boolean;
}

/** A DuckDB session on `path` with no extension downloads, as every test wants. */
export function openDuckdb(path: string, options: DuckdbOptions = {}): Promise<DuckdbSession> {
  return duckdb.connect(
    { path, readOnlyFile: options.readOnlyFile ?? false, downloadExtensions: false },
    { readOnly: options.readOnly ?? false },
  );
}

/** Every row `sql` returns. */
export async function rowsOf(session: DuckdbSession, sql: string, params?: readonly ParameterValue[]): Promise<Row[]> {
  const result = await session.execute(sql, params);
  const rows: Row[] = [];
  for await (const row of result.rows) rows.push(row);
  return rows;
}
