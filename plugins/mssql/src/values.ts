import { toBytesValue, toWireInteger, type Column, type WireValue } from "@table-craft/plugin-api";
import * as valueParserModule from "tedious/lib/value-parser.js";
import type { Metadata } from "tedious/lib/metadata-parser.js";

/**
 * tedious turns `decimal`, `numeric` and `money` into JavaScript numbers, losing digits past 15,
 * and every date and time type into a `Date`, losing the seventh fractional digit and the offset
 * of a `datetimeoffset`. TableCraft shows what the server stored (decision 124), so the plugin
 * wraps tedious's value reader: it lets tedious find where the value ends, then reads those bytes
 * again into exact text. The reader is a CommonJS export that tedious's token parsers look up on
 * every call, so replacing the property reaches them.
 */
interface ReadResult {
  value: unknown;
  offset: number;
}
type ReadValue = (buf: Buffer, offset: number, metadata: Metadata, options: unknown) => ReadResult;
interface ValueParser {
  readValue: ReadValue;
}

const DECIMAL_TYPES = new Set(["Decimal", "DecimalN", "Numeric", "NumericN"]);
const MONEY_SCALE = 4;
const MONEY_LOW_BYTES = 4;
/** Days from 0001-01-01 (`date`, `datetime2`, `datetimeoffset`) and from 1900-01-01 (`datetime`) to 1970-01-01. */
const DAYS_BEFORE_EPOCH = 719_162;
const DAYS_1900_BEFORE_EPOCH = 25_567;
const MS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;
/** `datetime` counts three-hundredths of a second; the server shows it with three decimals. */
const DATETIME_TICKS_PER_SECOND = 300;
const DATETIME_SCALE = 3;
const DATE_BYTES = 3;
const OFFSET_BYTES = 2;
const SMALL_BYTES = 4;
const TIMESTAMP_USER_TYPE = 80;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function scaled(magnitude: bigint, negative: boolean, scale: number): string {
  const digits = magnitude.toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return negative && magnitude !== 0n ? `-${whole}` : whole;
}

function decimalText(buf: Buffer, offset: number, scale: number): string {
  const length = buf.readUInt8(offset);
  const negative = buf.readUInt8(offset + 1) === 0;
  let magnitude = 0n;
  for (let index = length - 1; index >= 1; index -= 1)
    magnitude = (magnitude << 8n) | BigInt(buf.readUInt8(offset + 1 + index));
  return scaled(magnitude, negative, scale);
}

function moneyText(buf: Buffer, offset: number, bytes: number): string {
  const value =
    bytes === SMALL_BYTES
      ? BigInt(buf.readInt32LE(offset))
      : (BigInt(buf.readInt32LE(offset)) << 32n) | BigInt(buf.readUInt32LE(offset + MONEY_LOW_BYTES));
  return scaled(value < 0n ? -value : value, value < 0n, MONEY_SCALE);
}

function dateText(days: number, daysBeforeEpoch: number): string {
  return new Date((days - daysBeforeEpoch) * MS_PER_DAY).toISOString().slice(0, 10);
}

function clockText(seconds: number, fraction: string): string {
  const time = `${pad(Math.floor(seconds / 3600), 2)}:${pad(Math.floor(seconds / 60) % 60, 2)}:${pad(seconds % 60, 2)}`;
  return fraction === "" ? time : `${time}.${fraction}`;
}

/** A time of day in units of 10^-scale seconds, as the server shows it. */
function timeText(units: number, scale: number): { seconds: number; fraction: string } {
  const perSecond = 10 ** scale;
  return { seconds: Math.floor(units / perSecond), fraction: scale === 0 ? "" : pad(units % perSecond, scale) };
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const size = Math.abs(minutes);
  return `${sign}${pad(Math.floor(size / 60), 2)}:${pad(size % 60, 2)}`;
}

function legacyDateTimeText(buf: Buffer, offset: number, bytes: number): string {
  if (bytes === SMALL_BYTES) {
    const minutes = buf.readUInt16LE(offset + 2);
    return `${dateText(buf.readUInt16LE(offset), DAYS_1900_BEFORE_EPOCH)} ${clockText(minutes * 60, "")}`;
  }
  const ticks = buf.readUInt32LE(offset + 4);
  const thousandths = Math.round((ticks * 10 ** DATETIME_SCALE) / DATETIME_TICKS_PER_SECOND);
  const time = timeText(thousandths, DATETIME_SCALE);
  return `${dateText(buf.readInt32LE(offset), DAYS_1900_BEFORE_EPOCH)} ${clockText(time.seconds, time.fraction)}`;
}

/** The exact text of a value tedious would read lossily, from its bytes at `offset`; undefined for any other type. */
export function exactText(buf: Buffer, offset: number, metadata: Metadata): string | undefined {
  const type = metadata.type.name;
  const scale = metadata.scale ?? 0;
  if (DECIMAL_TYPES.has(type)) return decimalText(buf, offset, scale);
  switch (type) {
    case "Money":
      return moneyText(buf, offset, 8);
    case "SmallMoney":
      return moneyText(buf, offset, SMALL_BYTES);
    case "MoneyN":
      return moneyText(buf, offset + 1, buf.readUInt8(offset));
    case "DateTime":
      return legacyDateTimeText(buf, offset, 8);
    case "SmallDateTime":
      return legacyDateTimeText(buf, offset, SMALL_BYTES);
    case "DateTimeN":
      return legacyDateTimeText(buf, offset + 1, buf.readUInt8(offset));
    case "Date":
      return dateText(buf.readUIntLE(offset + 1, DATE_BYTES), DAYS_BEFORE_EPOCH);
    case "Time": {
      const time = timeText(buf.readUIntLE(offset + 1, buf.readUInt8(offset)), scale);
      return clockText(time.seconds, time.fraction);
    }
    case "DateTime2": {
      const timeBytes = buf.readUInt8(offset) - DATE_BYTES;
      const time = timeText(buf.readUIntLE(offset + 1, timeBytes), scale);
      const days = buf.readUIntLE(offset + 1 + timeBytes, DATE_BYTES);
      return `${dateText(days, DAYS_BEFORE_EPOCH)} ${clockText(time.seconds, time.fraction)}`;
    }
    case "DateTimeOffset": {
      const timeBytes = buf.readUInt8(offset) - DATE_BYTES - OFFSET_BYTES;
      const time = timeText(buf.readUIntLE(offset + 1, timeBytes), scale);
      const utcDays = buf.readUIntLE(offset + 1 + timeBytes, DATE_BYTES);
      const minutes = buf.readInt16LE(offset + 1 + timeBytes + DATE_BYTES);
      // The server sends UTC; the value it shows is local to its offset.
      const local = time.seconds + minutes * 60;
      const days = utcDays + Math.floor(local / SECONDS_PER_DAY);
      const seconds = ((local % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
      return `${dateText(days, DAYS_BEFORE_EPOCH)} ${clockText(seconds, time.fraction)} ${offsetText(minutes)}`;
    }
    default:
      return undefined;
  }
}

/** The CommonJS exports object: a namespace import of it is a copy under some bundlers, `default` the original. */
function valueParser(): ValueParser {
  const loaded = valueParserModule as unknown as { default?: ValueParser } & ValueParser;
  return loaded.default ?? loaded;
}

let installed = false;

/** Makes tedious read exact text for the types `exactText` knows; idempotent. */
export function installExactValues(): void {
  if (installed) return;
  const parser = valueParser();
  const original = parser.readValue;
  parser.readValue = (buf, offset, metadata, options) => {
    const result = original(buf, offset, metadata, options);
    if (result.value === null) return result;
    const text = exactText(buf, offset, metadata);
    if (text !== undefined) result.value = text;
    return result;
  };
  if (parser.readValue === original) throw new Error("tedious's value reader could not be replaced.");
  installed = true;
}

const INTEGER_TYPES: Readonly<Record<number, string>> = { 1: "tinyint", 2: "smallint", 4: "int", 8: "bigint" };
const FIXED_TYPES: Readonly<Record<string, string>> = {
  TinyInt: "tinyint",
  SmallInt: "smallint",
  Int: "int",
  BigInt: "bigint",
  Bit: "bit",
  BitN: "bit",
  Real: "real",
  Float: "float",
  Decimal: "decimal",
  DecimalN: "decimal",
  Numeric: "numeric",
  NumericN: "numeric",
  Money: "money",
  SmallMoney: "smallmoney",
  DateTime: "datetime",
  SmallDateTime: "smalldatetime",
  Date: "date",
  Time: "time",
  DateTime2: "datetime2",
  DateTimeOffset: "datetimeoffset",
  Char: "char",
  VarChar: "varchar",
  NChar: "nchar",
  NVarChar: "nvarchar",
  Text: "text",
  NText: "ntext",
  Binary: "binary",
  VarBinary: "varbinary",
  Image: "image",
  UniqueIdentifier: "uniqueidentifier",
  Xml: "xml",
  Variant: "sql_variant",
};

/** The SQL Server name of a result column's type, such as `int` or `datetime2`. */
export function typeName(metadata: Metadata): string {
  const type = metadata.type.name;
  const size = metadata.dataLength ?? 0;
  if (type === "IntN") return INTEGER_TYPES[size] ?? "int";
  if (type === "FloatN") return size === SMALL_BYTES ? "real" : "float";
  if (type === "MoneyN") return size === SMALL_BYTES ? "smallmoney" : "money";
  if (type === "DateTimeN") return size === SMALL_BYTES ? "smalldatetime" : "datetime";
  if (type === "Binary" && metadata.userType === TIMESTAMP_USER_TYPE) return "rowversion";
  if (type === "UDT") return metadata.udtInfo?.typeName ?? "udt";
  return FIXED_TYPES[type] ?? type.toLowerCase();
}

export interface ResultColumn {
  readonly colName: string;
}

/** A result column; `bit` is boolean, which the type name alone does not tell the host. */
export function columnOf(metadata: Metadata & ResultColumn): Column {
  const type = typeName(metadata);
  return type === "bit" ? { name: metadata.colName, type, typeClass: "boolean" } : { name: metadata.colName, type };
}

/** One value as tedious read it, after `installExactValues`, on the wire. */
export function wireValue(value: unknown, fullBytes: boolean): WireValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return toWireInteger(value);
  if (Buffer.isBuffer(value)) return toBytesValue(value, { fullBytes });
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace("Z", "");
  return JSON.stringify(value);
}

/** A `bigint` column's value: tedious reads it as text, which may still fit a number. */
export function bigintValue(value: unknown): WireValue {
  return typeof value === "string" ? toWireInteger(value) : wireValue(value, false);
}
