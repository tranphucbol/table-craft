import type { Column, InferredColumn, InsertRow } from "@table-craft/plugin-api";

export const MSSQL_IMPORT_TYPES = {
  boolean: "bit",
  integer: "int",
  bigint: "bigint",
  double: "float",
  date: "date",
  timestamp: "datetime2",
  text: "nvarchar(max)",
} as const;

/** `decimal`'s widest precision. */
const MAX_PRECISION = 38;

/** Sized from the sample, as wide as SQL Server allows, so a later row's digits still fit. */
export function mssqlDecimal(column: InferredColumn): string {
  const scale = Math.min(column.scale, MAX_PRECISION);
  return `decimal(${String(MAX_PRECISION)}, ${String(scale)})`;
}

/** A request takes at most 2100 parameters (SQL Server's "Maximum capacity specifications"). */
const MAX_PARAMETERS = 2100;
/** `INSERT … VALUES` takes at most 1000 row constructors. */
const MAX_VALUES_ROWS = 1000;
const BINARY_TYPES = new Set(["binary", "varbinary", "image", "rowversion", "timestamp"]);
/** A declared type's length or precision, as in `varbinary(max)`. */
const TYPE_ARGUMENTS = /\(.*$/;

/** Types text converts to that a failed conversion of reaches, checked before the INSERT runs. */
const CHECKED_TYPES = new Set([
  "bigint",
  "int",
  "smallint",
  "tinyint",
  "bit",
  "decimal",
  "numeric",
  "money",
  "smallmoney",
  "float",
  "real",
  "date",
  "time",
  "datetime",
  "datetime2",
  "smalldatetime",
  "datetimeoffset",
  "uniqueidentifier",
]);

function baseType(column: Column | undefined): string {
  return column?.type?.toLowerCase().replace(TYPE_ARGUMENTS, "").trim() ?? "";
}

/** Every value travels as `nvarchar`; the server converts it to the column's type, except bytes. */
function placeholder(column: Column | undefined, index: number): string {
  const name = `@p${String(index)}`;
  // nvarchar never converts to varbinary implicitly; style 1 reads the exporter's `0x…` text.
  return BINARY_TYPES.has(baseType(column)) ? `CONVERT(varbinary(max), ${name}, 1)` : name;
}

/** `RAISERROR`'s argument, a Unicode literal. */
function unicode(text: string): string {
  return `N'${text.replaceAll("'", "''")}'`;
}

/**
 * A failed conversion inside the INSERT would roll back the whole transaction (SQL Server ends it
 * on conversion errors such as 245), so each column's values are tried first and a bad one raises
 * a severity 16 error, which ends only this request.
 */
function conversionGuard(columns: readonly Column[], cellsByColumn: readonly string[][]): string {
  const branches: string[] = [];
  columns.forEach((column, index) => {
    const base = baseType(column);
    const binary = BINARY_TYPES.has(base);
    if (!binary && !CHECKED_TYPES.has(base)) return;
    const type = column.type ?? base;
    const tried = (name: string): string =>
      binary ? `TRY_CONVERT(varbinary(max), ${name}, 1)` : `TRY_CONVERT(${type}, ${name})`;
    const failed = (cellsByColumn[index] ?? []).map((name) => `(${name} IS NOT NULL AND ${tried(name)} IS NULL)`);
    if (failed.length === 0) return;
    branches.push(
      `IF ${failed.join(" OR ")} RAISERROR(N'A value of column %s does not convert to %s.', 16, 1, ` +
        `${unicode(column.name)}, ${unicode(type)})`,
    );
  });
  return branches.join("\nELSE ");
}

export interface InsertChunk {
  readonly sql: string;
  readonly params: readonly (string | null)[];
}

/** The rows as parameterized multi-row INSERTs, each within a request's parameter and row limits. */
export function insertChunks(
  table: string,
  columns: readonly Column[],
  quotedColumns: string,
  rows: readonly InsertRow[],
): InsertChunk[] {
  const perStatement = Math.max(1, Math.min(MAX_VALUES_ROWS, Math.floor((MAX_PARAMETERS - 1) / columns.length)));
  const chunks: InsertChunk[] = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    const slice = rows.slice(start, start + perStatement);
    const params: (string | null)[] = [];
    const cellsByColumn: string[][] = columns.map(() => []);
    const tuples = slice.map((row) => {
      const cells = columns.map((column, index) => {
        params.push(row[index] ?? null);
        cellsByColumn[index]?.push(`@p${String(params.length)}`);
        return placeholder(column, params.length);
      });
      return `(${cells.join(", ")})`;
    });
    const insert = `INSERT INTO ${table} (${quotedColumns}) VALUES ${tuples.join(", ")}`;
    const guard = conversionGuard(columns, cellsByColumn);
    chunks.push({ sql: guard === "" ? insert : `${guard}\nELSE ${insert}`, params });
  }
  return chunks;
}
