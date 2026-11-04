import type { DuckDBDataChunk, DuckDBValueConverter, Json } from "@duckdb/node-api";
import {
  toBytesValue,
  toWireInteger,
  type Column,
  type Row,
  type TypeClass,
  type WireValue,
} from "@table-craft/plugin-api";

/**
 * `DuckDBTypeId` values from `@duckdb/node-api`. Its enum is a runtime object, and importing it
 * would load the native binding when the plugin loads (decision 156), so the ids are copied here.
 */
export const TYPE_ID = {
  BOOLEAN: 1,
  TINYINT: 2,
  SMALLINT: 3,
  INTEGER: 4,
  BIGINT: 5,
  UTINYINT: 6,
  USMALLINT: 7,
  UINTEGER: 8,
  UBIGINT: 9,
  FLOAT: 10,
  DOUBLE: 11,
  TIMESTAMP: 12,
  DATE: 13,
  TIME: 14,
  INTERVAL: 15,
  HUGEINT: 16,
  VARCHAR: 17,
  BLOB: 18,
  DECIMAL: 19,
  TIMESTAMP_S: 20,
  TIMESTAMP_MS: 21,
  TIMESTAMP_NS: 22,
  ENUM: 23,
  LIST: 24,
  STRUCT: 25,
  MAP: 26,
  UUID: 27,
  UNION: 28,
  BIT: 29,
  TIME_TZ: 30,
  TIMESTAMP_TZ: 31,
  UHUGEINT: 32,
  ARRAY: 33,
  BIGNUM: 35,
  TIME_NS: 39,
  GEOMETRY: 40,
  VARIANT: 41,
  TIMESTAMP_TZ_NS: 42,
} as const;

const JSON_ALIAS = "JSON";

const INTEGER_TYPES: ReadonlySet<number> = new Set([
  TYPE_ID.TINYINT,
  TYPE_ID.SMALLINT,
  TYPE_ID.INTEGER,
  TYPE_ID.BIGINT,
  TYPE_ID.UTINYINT,
  TYPE_ID.USMALLINT,
  TYPE_ID.UINTEGER,
  TYPE_ID.UBIGINT,
  TYPE_ID.HUGEINT,
  TYPE_ID.UHUGEINT,
  TYPE_ID.BIGNUM,
]);

/** Wider than 64 bits: always the exact `bigint` kind, never a number that happens to fit. */
const WIDE_INTEGER_TYPES: ReadonlySet<number> = new Set([TYPE_ID.HUGEINT, TYPE_ID.UHUGEINT, TYPE_ID.BIGNUM]);

const TEMPORAL_TYPES: ReadonlySet<number> = new Set([
  TYPE_ID.DATE,
  TYPE_ID.TIME,
  TYPE_ID.TIME_NS,
  TYPE_ID.TIME_TZ,
  TYPE_ID.TIMESTAMP,
  TYPE_ID.TIMESTAMP_S,
  TYPE_ID.TIMESTAMP_MS,
  TYPE_ID.TIMESTAMP_NS,
  TYPE_ID.TIMESTAMP_TZ,
  TYPE_ID.TIMESTAMP_TZ_NS,
]);

/** Values the grid shows as JSON documents: DuckDB's own text for them is not JSON. */
const NESTED_TYPES: ReadonlySet<number> = new Set([
  TYPE_ID.LIST,
  TYPE_ID.ARRAY,
  TYPE_ID.STRUCT,
  TYPE_ID.MAP,
  TYPE_ID.UNION,
  TYPE_ID.VARIANT,
]);

/** What a result column's type says about its values. */
export interface ColumnType {
  /** A `DuckDBTypeId`, compared against `TYPE_ID`. */
  readonly typeId: number;
  readonly alias?: string;
  toString(): string;
}

/** Every value node-api returns that is not a primitive prints DuckDB's own text. */
function textOf(value: object): string {
  return (value as { toString(): string }).toString();
}

function isJsonAlias(type: ColumnType): boolean {
  return type.alias?.toUpperCase() === JSON_ALIAS;
}

/** Whether the column's values are read through the JSON converter instead of one by one. */
export function isNested(type: ColumnType): boolean {
  return NESTED_TYPES.has(type.typeId);
}

export function typeClassOf(type: ColumnType): TypeClass {
  if (isJsonAlias(type) || isNested(type)) return "json";
  if (INTEGER_TYPES.has(type.typeId)) return "integer";
  if (TEMPORAL_TYPES.has(type.typeId)) return "temporal";
  switch (type.typeId) {
    case TYPE_ID.BOOLEAN:
      return "boolean";
    case TYPE_ID.FLOAT:
    case TYPE_ID.DOUBLE:
      return "float";
    case TYPE_ID.DECIMAL:
      return "decimal";
    case TYPE_ID.BLOB:
      return "bytes";
    default:
      return "text";
  }
}

/** The type name DuckDB writes, with `JSON` in place of the `VARCHAR` it is stored as. */
export function typeNameOf(type: ColumnType): string {
  return isJsonAlias(type) ? JSON_ALIAS : type.toString();
}

export function columnFor(name: string, type: ColumnType): Column {
  return { name, type: typeNameOf(type), typeClass: typeClassOf(type) };
}

function hasBytes(value: object): value is { readonly bytes: Uint8Array } {
  return "bytes" in value && value.bytes instanceof Uint8Array;
}

/** One value as `getColumnValues` returns it, as it crosses the wire (decision 017). */
export function cellFor(type: ColumnType, value: unknown, fullBytes: boolean): WireValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
    case "number":
      return value;
    case "bigint":
      return WIDE_INTEGER_TYPES.has(type.typeId) ? { kind: "bigint", value: value.toString() } : toWireInteger(value);
    case "string":
      return isJsonAlias(type) ? { kind: "json", text: value } : value;
    case "object":
      return hasBytes(value) ? toBytesValue(value.bytes, { fullBytes }) : textOf(value);
    default:
      return null;
  }
}

function nestedCell(value: Json | null): WireValue {
  return value === null ? null : { kind: "json", text: JSON.stringify(value) };
}

/** The rows of one chunk; nested columns go through `json`, `JsonDuckDBValueConverter`. */
export function rowsOf(
  chunk: DuckDBDataChunk,
  types: readonly ColumnType[],
  json: DuckDBValueConverter<Json>,
  fullBytes: boolean,
): Row[] {
  const columns = types.map((type, index): readonly WireValue[] =>
    isNested(type)
      ? chunk.convertColumnValues(index, json).map(nestedCell)
      : chunk.getColumnValues(index).map((value) => cellFor(type, value, fullBytes)),
  );
  const rows: Row[] = [];
  for (let row = 0; row < chunk.rowCount; row += 1) rows.push(columns.map((column) => column[row] ?? null));
  return rows;
}
