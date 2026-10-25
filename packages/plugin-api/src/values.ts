/** Bytes shown of a binary value; the rest stays in the database (decision 009). */
export const BYTES_PREVIEW_LENGTH = 32;

export interface BigIntValue {
  readonly kind: "bigint";
  readonly value: string;
}

export interface BytesValue {
  readonly kind: "bytes";
  /**
   * Lower-case hex of the first `BYTES_PREVIEW_LENGTH` bytes, or of every byte when the statement
   * ran with `ExecuteOptions.fullBytes`; the value is complete exactly when `preview.length` is
   * twice `length`.
   */
  readonly preview: string;
  readonly length: number;
}

export interface JsonValue {
  readonly kind: "json";
  readonly text: string;
}

export interface DateValue {
  readonly kind: "date";
  readonly iso: string;
}

/**
 * One cell as it crosses a process boundary. Anything structured clone would mangle, or that is
 * too large to ship whole, is tagged.
 */
export type WireValue = null | boolean | number | string | BigIntValue | BytesValue | JsonValue | DateValue;

/**
 * What a column's values are. The grid sorts, aligns and draws its header glyph by this. The host
 * reads it from the type name unless the plugin names it on the `Column` (decision 101).
 */
export type TypeClass = "integer" | "float" | "decimal" | "boolean" | "temporal" | "json" | "bytes" | "text";

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const BYTE_VALUES = 256;
const HEX_DIGITS = Array.from({ length: BYTE_VALUES }, (_, byte) =>
  byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
);

function toHex(bytes: Uint8Array): string {
  const digits: string[] = new Array<string>(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 1) digits[index] = HEX_DIGITS[bytes[index] ?? 0] ?? "";
  return digits.join("");
}

export interface WireValueOptions {
  /** Ship every byte of a binary value instead of the preview (`ExecuteOptions.fullBytes`). */
  readonly fullBytes?: boolean;
}

/** A binary value as it crosses the wire: the preview, or every byte with `fullBytes`. */
export function toBytesValue(bytes: Uint8Array, options: WireValueOptions = {}): BytesValue {
  const shown = options.fullBytes === true ? bytes : bytes.subarray(0, BYTES_PREVIEW_LENGTH);
  return { kind: "bytes", preview: toHex(shown), length: bytes.byteLength };
}

/** A 64-bit integer as a number when it is exact in a double, tagged otherwise. */
export function toWireInteger(value: bigint | string): number | BigIntValue {
  const exact = BigInt(value);
  if (exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(exact);
  return { kind: "bigint", value: exact.toString() };
}

/** Converts what a JavaScript driver typically returns into a `WireValue`. */
export function toWireValue(value: unknown, options: WireValueOptions = {}): WireValue {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return value;
    case "bigint":
      return { kind: "bigint", value: value.toString() };
    default:
      break;
  }
  if (value instanceof Uint8Array) return toBytesValue(value, options);
  if (value instanceof Date) return { kind: "date", iso: value.toISOString() };
  return { kind: "json", text: JSON.stringify(value) };
}
