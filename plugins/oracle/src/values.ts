import oracledb from "oracledb";
import {
  toBytesValue,
  toWireInteger,
  toWireValue,
  type Column,
  type TypeClass,
  type WireValue,
} from "@table-craft/plugin-api";

/**
 * Session settings that make the server's text of a date, a timestamp and a number the ISO-like,
 * locale-free text the grid shows and an import writes back (decision 017).
 */
export const SESSION_FORMATS = [
  "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
  "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF'",
  "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM'",
  "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'",
];

/** `NUMBER` without precision and scale reports scale -127; `FLOAT(b)` reports a precision with it. */
const UNCONSTRAINED_SCALE = -127;
const INTEGRAL = /^-?\d+$/;
const BARE_FRACTION = /^(-?)\./;
/** An all-zero or zero-ending fraction the `FF` format element pads to its precision. */
const PADDED_FRACTION = /\.(\d*?)0+(?=$|\s)/;

type Metadata = oracledb.Metadata<unknown[]>;

/**
 * Numbers arrive as the server's exact text and LOBs arrive whole. Thin mode decodes dates and
 * timestamps into a `Date` itself (asking for a string only formats that `Date`), so they are
 * printed from it below.
 */
export function fetchTypeHandler(metadata: Metadata): oracledb.FetchTypeResponse | undefined {
  switch (metadata.dbType) {
    case oracledb.DB_TYPE_NUMBER:
    case oracledb.DB_TYPE_CLOB:
    case oracledb.DB_TYPE_NCLOB:
      return { type: oracledb.STRING };
    case oracledb.DB_TYPE_BLOB:
      return { type: oracledb.BUFFER };
    default:
      return undefined;
  }
}

type Cell = (value: unknown, fullBytes: boolean) => WireValue;

const DATE_DIGITS = 2;
const YEAR_DIGITS = 4;
const MILLISECOND_DIGITS = 3;

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function pad(value: number, digits = DATE_DIGITS): string {
  return String(value).padStart(digits, "0");
}

function clock(parts: readonly number[]): string {
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0, millisecond = 0] = parts;
  const fraction = millisecond === 0 ? "" : `.${pad(millisecond, MILLISECOND_DIGITS)}`.replace(/0+$/, "");
  return `${pad(year, YEAR_DIGITS)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}${fraction}`;
}

/**
 * `DATE` and `TIMESTAMP` come back as a local `Date` built from the stored fields, so the local
 * fields give them back; the driver keeps milliseconds of the fraction.
 */
const localTime: Cell = (value) =>
  value instanceof Date
    ? clock([
        value.getFullYear(),
        value.getMonth() + 1,
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
      ])
    : trimmedFraction(value);

/** A zoned timestamp is an instant to the driver, which drops the zone; it reads in UTC. */
const instant: Cell = (value) =>
  value instanceof Date
    ? `${clock([
        value.getUTCFullYear(),
        value.getUTCMonth() + 1,
        value.getUTCDate(),
        value.getUTCHours(),
        value.getUTCMinutes(),
        value.getUTCSeconds(),
        value.getUTCMilliseconds(),
      ])} +00:00`
    : trimmedFraction(value);

const NANOSECOND_DIGITS = 9;

interface IntervalFields {
  readonly years?: number;
  readonly months?: number;
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly fseconds?: number;
}

/** Oracle's own interval literals: `Y-M` and `D HH:MI:SS.FF`, negative as a whole. */
const interval: Cell = (value) => {
  if (typeof value !== "object" || value === null) return toWireValue(value);
  const fields = value as IntervalFields;
  if (fields.years !== undefined || fields.months !== undefined) {
    const years = fields.years ?? 0;
    const months = fields.months ?? 0;
    const sign = years < 0 || months < 0 ? "-" : "";
    return `${sign}${String(Math.abs(years))}-${String(Math.abs(months))}`;
  }
  const parts = [fields.days, fields.hours, fields.minutes, fields.seconds, fields.fseconds].map((part) => part ?? 0);
  const [days = 0, hours = 0, minutes = 0, seconds = 0, nanoseconds = 0] = parts;
  const sign = parts.some((part) => part < 0) ? "-" : "";
  const fraction = nanoseconds === 0 ? "" : `.${pad(Math.abs(nanoseconds), NANOSECOND_DIGITS)}`.replace(/0+$/, "");
  return `${sign}${String(Math.abs(days))} ${pad(Math.abs(hours))}:${pad(Math.abs(minutes))}:${pad(Math.abs(seconds))}${fraction}`;
};

function trimmedFraction(value: unknown): WireValue {
  return text(value).replace(PADDED_FRACTION, (_match, digits: string) => (digits === "" ? "" : `.${digits}`));
}

/** Oracle writes a fraction without its leading zero (`-.5`); the wire keeps decimal text as other servers write it. */
function numberText(value: unknown): string {
  return text(value).replace(BARE_FRACTION, "$10.");
}

/** `NUMBER(p, s)` keeps `s` digits after the point, as the column declares, though the server drops trailing zeros. */
function scaled(scale: number): Cell {
  return (value) => {
    const shown = numberText(value);
    const [whole = "", fraction = ""] = shown.split(".");
    return fraction.length >= scale ? shown : `${whole}.${fraction.padEnd(scale, "0")}`;
  };
}

const integer: Cell = (value) => toWireInteger(text(value));
/** An expression's `NUMBER` has no declared scale, so its value decides: a whole number is an integer. */
const anyNumber: Cell = (value) => {
  const shown = numberText(value);
  return INTEGRAL.test(shown) ? toWireInteger(shown) : shown;
};
const json: Cell = (value) => ({ kind: "json", text: typeof value === "string" ? value : JSON.stringify(value) });
const bytes: Cell = (value, fullBytes) =>
  value instanceof Uint8Array ? toBytesValue(value, { fullBytes }) : toWireValue(value);
const plain: Cell = (value) => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return toWireInteger(value);
  if (value instanceof Uint8Array) return toBytesValue(value);
  if (ArrayBuffer.isView(value)) return JSON.stringify(Array.from(value as unknown as ArrayLike<number>));
  return toWireValue(value);
};

function numberCell(metadata: Metadata): Cell {
  const scale = metadata.scale ?? UNCONSTRAINED_SCALE;
  const precision = metadata.precision ?? 0;
  // A PL/SQL variable or bind reports precision 0 whatever its scale: its values may have any.
  if (precision === 0) return anyNumber;
  if (scale === 0) return integer;
  if (scale === UNCONSTRAINED_SCALE) return numberText;
  return scale > 0 ? scaled(scale) : integer;
}

function numberClass(metadata: Metadata): TypeClass {
  const scale = metadata.scale ?? UNCONSTRAINED_SCALE;
  return scale === 0 && (metadata.precision ?? 0) > 0 ? "integer" : "decimal";
}

export interface ColumnReader {
  readonly column: Column;
  readonly cell: Cell;
}

/** How a fetched column is named, classed and read. */
export function columnReader(metadata: Metadata): ColumnReader {
  const type = metadata.dbTypeName ?? null;
  // Thin mode reports no source table or column, so a column's origin is unknown rather than none.
  const column = (typeClass: TypeClass): Column => ({ name: metadata.name, type, typeClass });
  switch (metadata.dbType) {
    case oracledb.DB_TYPE_NUMBER:
      return { column: column(numberClass(metadata)), cell: numberCell(metadata) };
    case oracledb.DB_TYPE_BINARY_FLOAT:
    case oracledb.DB_TYPE_BINARY_DOUBLE:
    case oracledb.DB_TYPE_BINARY_INTEGER:
      return { column: column("float"), cell: plain };
    case oracledb.DB_TYPE_DATE:
    case oracledb.DB_TYPE_TIMESTAMP:
      return { column: column("temporal"), cell: localTime };
    case oracledb.DB_TYPE_TIMESTAMP_TZ:
    case oracledb.DB_TYPE_TIMESTAMP_LTZ:
      return { column: column("temporal"), cell: instant };
    case oracledb.DB_TYPE_INTERVAL_DS:
    case oracledb.DB_TYPE_INTERVAL_YM:
      return { column: column("temporal"), cell: interval };
    case oracledb.DB_TYPE_JSON:
      return { column: column("json"), cell: json };
    case oracledb.DB_TYPE_BOOLEAN:
      return { column: column("boolean"), cell: plain };
    case oracledb.DB_TYPE_BLOB:
    case oracledb.DB_TYPE_RAW:
    case oracledb.DB_TYPE_LONG_RAW:
      return { column: column("bytes"), cell: bytes };
    default:
      return metadata.isJson === true
        ? { column: column("json"), cell: json }
        : { column: column("text"), cell: plain };
  }
}

/** One fetched row as wire values. */
export function wireRow(values: readonly unknown[], readers: readonly ColumnReader[], fullBytes: boolean): WireValue[] {
  return values.map((value, index) =>
    value === null || value === undefined ? null : (readers[index]?.cell ?? plain)(value, fullBytes),
  );
}
