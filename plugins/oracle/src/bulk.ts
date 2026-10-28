import type { Column, InferredColumn, InsertRow } from "@table-craft/plugin-api";

/** How the exporter writes bytes (`cellText`): `0x` and lower-case hex. */
const EXPORTED_BYTES = /^0x([0-9a-fA-F]*)$/u;
const BINARY_TYPE = /^(?:BLOB|RAW|LONG RAW)\b/i;
/** `NUMBER(1)`, the column an import makes for a boolean and the usual Oracle flag. */
const FLAG_TYPE = /^NUMBER\(1(?:,\s*0)?\)$/i;
const FLAGS: ReadonlyMap<string, string> = new Map([
  ["true", "1"],
  ["false", "0"],
]);
const NUMBER_MAX_PRECISION = 38;

/**
 * Text is `CLOB`: the inferred column carries no length, and `VARCHAR2` stops at 4000 bytes
 * under the default `MAX_STRING_SIZE`, which a later row could pass.
 */
export const ORACLE_IMPORT_TYPES = {
  boolean: "NUMBER(1)",
  integer: "NUMBER(10)",
  bigint: "NUMBER(19)",
  double: "BINARY_DOUBLE",
  date: "DATE",
  timestamp: "TIMESTAMP",
  text: "CLOB",
} as const;

/** `NUMBER(p, s)` sized from the sample, capped at Oracle's 38 digits. */
export function oracleDecimal(column: InferredColumn): string {
  const precision = Math.min(column.integerDigits + column.scale, NUMBER_MAX_PRECISION);
  return `NUMBER(${String(Math.max(precision, 1))}, ${String(Math.min(column.scale, precision))})`;
}

/** What `executeMany` binds for one cell: bytes for a binary column, 1 or 0 for a flag. */
function bound(value: string, column: Column | undefined): string | Buffer {
  const type = column?.type ?? "";
  if (BINARY_TYPE.test(type)) {
    const hex = EXPORTED_BYTES.exec(value);
    if (hex !== null) return Buffer.from(hex[1] ?? "", "hex");
  }
  if (FLAG_TYPE.test(type)) return FLAGS.get(value.toLowerCase()) ?? value;
  return value;
}

export function boundRow(row: InsertRow, columns: readonly Column[]): (string | Buffer | null)[] {
  return row.map((value, index) => (value === null ? null : bound(value, columns[index])));
}

/** `INSERT INTO t (a, b) VALUES (:1, :2)` for `executeMany`. */
export function insertStatement(table: string, columns: readonly string[]): string {
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `:${String(index + 1)}`).join(", ")})`;
}
