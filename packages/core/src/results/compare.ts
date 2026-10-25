import type { Column, TypeClass, WireValue } from "@table-craft/plugin-api";

export type { TypeClass };

const TYPE_CLASSES: ReadonlyMap<string, TypeClass> = new Map<string, TypeClass>([
  ...(
    [
      "int",
      "int2",
      "int4",
      "int8",
      "integer",
      "smallint",
      "bigint",
      "tinyint",
      "mediumint",
      "serial",
      "bigserial",
      "smallserial",
      "year",
      "oid",
    ] as const
  ).map((name) => [name, "integer"] as const),
  ...(
    ["float", "float4", "float8", "double", "double precision", "real", "binary_float", "binary_double"] as const
  ).map((name) => [name, "float"] as const),
  ...(["numeric", "decimal", "number", "money", "smallmoney"] as const).map((name) => [name, "decimal"] as const),
  ...(["bool", "boolean"] as const).map((name) => [name, "boolean"] as const),
  ...(
    [
      "date",
      "time",
      "timetz",
      "timestamp",
      "timestamptz",
      "timestamp with time zone",
      "datetime",
      "datetime2",
      "datetimeoffset",
      "smalldatetime",
      "interval",
    ] as const
  ).map((name) => [name, "temporal"] as const),
  ...(["json", "jsonb"] as const).map((name) => [name, "json"] as const),
  ...(
    ["bytea", "blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary", "bit", "raw", "image"] as const
  ).map((name) => [name, "bytes"] as const),
  ...(["varchar2", "nvarchar2", "nchar", "nvarchar", "ntext", "clob", "nclob", "uniqueidentifier", "xml"] as const).map(
    (name) => [name, "text"] as const,
  ),
]);

/** Drops a length or precision suffix and an `unsigned`, so `DECIMAL(20,4) UNSIGNED` reads as `decimal`. */
function baseTypeName(columnType: string): string {
  const name = columnType
    .toLowerCase()
    .replace(/\(.*\)/u, "")
    .replace(/\bunsigned\b/u, "");
  return name.trim().replace(/\s+/gu, " ");
}

export function typeClass(columnType: string | null): TypeClass {
  if (columnType === null) return "text";
  return TYPE_CLASSES.get(baseTypeName(columnType)) ?? "text";
}

/** The class the plugin names on the column, else the one its type name reads as. */
export function columnTypeClass(column: Pick<Column, "type" | "typeClass">): TypeClass {
  return column.typeClass ?? typeClass(column.type);
}

/**
 * The class of a column whose plugin reports no type, read from its first non-NULL value. SQLite
 * reports none for an expression such as `n + 1`, which would otherwise draw as left-aligned text.
 */
export function inferredTypeClass(values: Iterable<WireValue>): TypeClass {
  for (const value of values) {
    if (value === null) continue;
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "float";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "string") return "text";
    switch (value.kind) {
      case "bigint":
        return "integer";
      case "json":
        return "json";
      case "date":
        return "temporal";
      case "bytes":
        return "bytes";
    }
  }
  return "text";
}

const NUMERIC_CLASSES: ReadonlySet<TypeClass> = new Set(["integer", "float", "decimal"]);
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?$/u;

interface Decimal {
  readonly negative: boolean;
  readonly whole: string;
  readonly fraction: string;
}

function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL_TEXT.exec(text.trim());
  if (match === null) return null;
  const whole = (match[2] ?? "").replace(/^0+/u, "");
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  if ((match[2] ?? "") === "" && (match[3] ?? "") === "") return null;
  const zero = whole === "" && fraction === "";
  return { negative: match[1] === "-" && !zero, whole, fraction };
}

function compareMagnitude(a: Decimal, b: Decimal): number {
  if (a.whole.length !== b.whole.length) return a.whole.length - b.whole.length;
  if (a.whole !== b.whole) return a.whole < b.whole ? -1 : 1;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const left = a.fraction.padEnd(length, "0");
  const right = b.fraction.padEnd(length, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Compares decimal text digit by digit, so `NUMERIC(38)` values never round through a double. */
function compareDecimals(a: Decimal, b: Decimal): number {
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const magnitude = compareMagnitude(a, b);
  return a.negative ? -magnitude : magnitude;
}

type SortValue =
  | { readonly rank: 0; readonly number: number; readonly decimal: Decimal | null }
  | { readonly rank: 1; readonly flag: boolean }
  | { readonly rank: 2; readonly text: string }
  | { readonly rank: 3; readonly hex: string; readonly length: number };

function numberValue(value: number): SortValue {
  return { rank: 0, number: value, decimal: Number.isFinite(value) ? parseDecimal(String(value)) : null };
}

function sortValueOf(value: Exclude<WireValue, null>, numeric: boolean): SortValue {
  if (typeof value === "number") return numberValue(value);
  if (typeof value === "boolean") return { rank: 1, flag: value };
  if (typeof value === "string") {
    const decimal = numeric ? parseDecimal(value) : null;
    return decimal === null ? { rank: 2, text: value } : { rank: 0, number: Number(value), decimal };
  }
  switch (value.kind) {
    case "bigint":
      return { rank: 0, number: Number(value.value), decimal: parseDecimal(value.value) };
    case "json":
      return { rank: 2, text: value.text };
    case "date":
      return { rank: 2, text: value.iso };
    case "bytes":
      return { rank: 3, hex: value.preview, length: value.length };
  }
}

/** Unicode code point order; `<` on strings compares UTF-16 units, which misplaces astral characters. */
export function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const difference = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
}

function compareSortValues(a: SortValue, b: SortValue): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  switch (a.rank) {
    case 0: {
      const other = b as typeof a;
      if (a.decimal !== null && other.decimal !== null) return compareDecimals(a.decimal, other.decimal);
      return a.number === other.number ? 0 : a.number < other.number ? -1 : 1;
    }
    case 1:
      return Number(a.flag) - Number((b as typeof a).flag);
    case 2:
      return compareCodePoints(a.text, (b as typeof a).text);
    case 3: {
      const other = b as typeof a;
      return a.hex === other.hex ? a.length - other.length : a.hex < other.hex ? -1 : 1;
    }
  }
}

/**
 * Orders two values of one column, NULL after everything else. Mixed kinds, which SQLite allows,
 * fall back to SQLite's own order: numbers, then text, then bytes (decision 017 keeps decimals as
 * text, so a numeric column's strings are compared as numbers here).
 */
export function compareValues(a: WireValue, b: WireValue, kind: TypeClass): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  const numeric = NUMERIC_CLASSES.has(kind);
  return compareSortValues(sortValueOf(a, numeric), sortValueOf(b, numeric));
}
