import type { Row, TypeClass, WireValue } from "@table-craft/plugin-api";
import { compareValues } from "./compare.js";

/** What the selected cells of a result add up to (plan 043). */
export interface SelectionAggregates {
  /** Every selected cell, NULL included. */
  readonly cells: number;
  /** Distinct non-NULL values. */
  readonly distinct: number;
  /** `numeric` when every selected column is a number class, `temporal` when every one is a date class. */
  readonly kind: "numeric" | "temporal" | "other";
  /** Decimal text; exact unless a float took part. Null when not numeric or nothing to add. */
  readonly sum: string | null;
  readonly avg: string | null;
  /** The smallest and largest non-NULL value, for numeric and temporal selections. */
  readonly min: WireValue;
  readonly max: WireValue;
}

const NUMERIC_KINDS: ReadonlySet<TypeClass> = new Set(["integer", "float", "decimal"]);
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?$/u;
/** Digits an exact average carries past the inputs' own scale before trailing zeros are trimmed. */
const AVERAGE_EXTRA_SCALE = 6;
const TEN = 10n;

/** A decimal as an integer count of `10^-scale` units. */
interface Scaled {
  readonly units: bigint;
  readonly scale: number;
}

function parseScaled(text: string): Scaled | null {
  const match = DECIMAL_TEXT.exec(text.trim());
  if (match === null) return null;
  const whole = match[2] ?? "";
  const fraction = match[3] ?? "";
  if (whole === "" && fraction === "") return null;
  const magnitude = BigInt(`${whole}${fraction}` === "" ? "0" : `${whole}${fraction}`);
  return { units: match[1] === "-" ? -magnitude : magnitude, scale: fraction.length };
}

function rescale(value: Scaled, scale: number): bigint {
  return value.units * TEN ** BigInt(scale - value.scale);
}

function scaledText(value: Scaled): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  const whole = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale).replace(/0+$/u, "");
  const text = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative && text !== "0" ? `-${text}` : text;
}

/** `dividend / divisor` to `scale` digits, half away from zero. */
function divide(dividend: Scaled, divisor: number, scale: number): Scaled {
  const units = rescale(dividend, scale + 1) / BigInt(divisor);
  const rounded = (units + (units < 0n ? -5n : 5n)) / TEN;
  return { units: rounded, scale };
}

/** The exact decimal a numeric wire value holds; null for a float or anything not a number. */
function exactOf(value: Exclude<WireValue, null>): Scaled | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && Number.isSafeInteger(value) ? { units: BigInt(value), scale: 0 } : null;
  }
  if (typeof value === "string") return parseScaled(value);
  if (typeof value === "object" && value.kind === "bigint") return parseScaled(value.value);
  return null;
}

function numberOf(value: Exclude<WireValue, null>): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseScaled(value) === null ? null : Number(value);
  if (typeof value === "object" && value.kind === "bigint") return Number(value.value);
  return null;
}

function keyOf(value: Exclude<WireValue, null>): string {
  return typeof value === "object" ? JSON.stringify(value) : `${typeof value}:${String(value)}`;
}

/**
 * Count, distinct values, and for an all-numeric or all-temporal selection the sum, average, minimum
 * and maximum of `rows` already projected to the selected columns, whose classes are `classes`.
 * Integers and decimals add exactly in `BigInt`, so `NUMERIC(38,4)` never rounds through a double;
 * a float column, or a value no decimal reads, falls back to doubles.
 */
export function aggregateCells(rows: readonly Row[], classes: readonly TypeClass[]): SelectionAggregates {
  const numeric = classes.length > 0 && classes.every((kind) => NUMERIC_KINDS.has(kind));
  const temporal = classes.length > 0 && classes.every((kind) => kind === "temporal");
  const comparing: TypeClass = numeric ? "decimal" : "temporal";
  const distinct = new Set<string>();
  let cells = 0;
  let present = 0;
  let exact = numeric && !classes.includes("float");
  let summable = numeric;
  let sum: Scaled = { units: 0n, scale: 0 };
  let approximate = 0;
  let min: WireValue = null;
  let max: WireValue = null;
  for (const row of rows) {
    for (const value of row) {
      cells += 1;
      if (value === null) continue;
      present += 1;
      distinct.add(keyOf(value));
      if (!numeric && !temporal) continue;
      if (min === null || compareValues(value, min, comparing) < 0) min = value;
      if (max === null || compareValues(value, max, comparing) > 0) max = value;
      if (!summable) continue;
      const asNumber = numberOf(value);
      if (asNumber === null) {
        summable = false;
        continue;
      }
      approximate += asNumber;
      const scaled = exact ? exactOf(value) : null;
      if (scaled === null) {
        exact = false;
        continue;
      }
      const scale = Math.max(sum.scale, scaled.scale);
      sum = { units: rescale(sum, scale) + rescale(scaled, scale), scale };
    }
  }
  const kind = numeric ? "numeric" : temporal ? "temporal" : "other";
  const added = summable && present > 0;
  let total: string | null = null;
  let average: string | null = null;
  if (added && exact) {
    total = scaledText(sum);
    average = scaledText(divide(sum, present, sum.scale + AVERAGE_EXTRA_SCALE));
  } else if (added) {
    total = String(approximate);
    average = String(approximate / present);
  }
  return { cells, distinct: distinct.size, kind, sum: total, avg: average, min, max };
}
