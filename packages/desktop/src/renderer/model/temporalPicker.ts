import { dayOf } from "@table-craft/desktop/renderer/model/calendar.js";

export type PickerKind = "date" | "datetime" | "time";

export interface PickerTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** What the picker shows: null parts when the cell's text has none. */
export interface PickerValue {
  /** `YYYY-MM-DD`. */
  readonly day: string | null;
  readonly time: PickerTime | null;
}

const DATE_TYPES: ReadonlySet<string> = new Set(["date"]);
const TIME_TYPES: ReadonlySet<string> = new Set(["time", "timetz", "time with time zone", "time without time zone"]);
const DATETIME_TYPES: ReadonlySet<string> = new Set([
  "timestamp",
  "timestamptz",
  "timestamp with time zone",
  "timestamp without time zone",
  "datetime",
  "datetime2",
  "datetimeoffset",
  "smalldatetime",
]);

const DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/u;
const TIME_PATTERN = /(\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?/u;
const DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})([ T])(\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?(.*)$/u;
const ZONE_PATTERN = /([+-]\d{2}(:?\d{2})?|Z)$/u;
const DEFAULT_SEPARATOR = " ";
const MIDNIGHT: PickerTime = { hour: 0, minute: 0, second: 0 };

function baseName(type: string): string {
  return type
    .toLowerCase()
    .replace(/\(.*?\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function timeOf(hour: string | undefined, minute: string | undefined, second: string | undefined): PickerTime {
  return { hour: Number(hour ?? 0), minute: Number(minute ?? 0), second: Number(second ?? 0) };
}

function timeText(time: PickerTime): string {
  return `${pad(time.hour)}:${pad(time.minute)}:${pad(time.second)}`;
}

/** The picker a temporal column's type takes; null for one it cannot pick, such as `interval`. */
export function pickerKindOf(type: string | null): PickerKind | null {
  if (type === null) return null;
  const name = baseName(type);
  if (DATE_TYPES.has(name)) return "date";
  if (TIME_TYPES.has(name)) return "time";
  if (DATETIME_TYPES.has(name)) return "datetime";
  return null;
}

/** The cell's text as the picker's value; a part the text does not read as is null. */
export function pickerValueOf(kind: PickerKind, text: string): PickerValue {
  const trimmed = text.trim();
  if (kind === "date") return { day: DATE_PATTERN.exec(trimmed)?.[1] ?? null, time: null };
  if (kind === "time") {
    const match = TIME_PATTERN.exec(trimmed);
    return { day: null, time: match === null ? null : timeOf(match[1], match[2], match[3]) };
  }
  const match = DATETIME_PATTERN.exec(trimmed);
  if (match !== null) return { day: match[1] ?? null, time: timeOf(match[3], match[4], match[5]) };
  const day = DATE_PATTERN.exec(trimmed)?.[1] ?? null;
  return { day, time: day === null ? null : MIDNIGHT };
}

/** The local moment `now` as a picker value. */
export function pickerValueAt(now: Date): PickerValue {
  return { day: dayOf(now), time: { hour: now.getHours(), minute: now.getMinutes(), second: now.getSeconds() } };
}

/**
 * The text a picked value writes into the cell, in the shape the cell already has: a date-time
 * keeps its separator, fractional seconds and any zone suffix, so `2024-01-15T10:00:00.000Z`
 * stays an instant in UTC with its milliseconds. `keepFraction: false` (Now) drops the fraction.
 * There is no date format setting, so a cell with no text takes the ISO shape the database reads.
 */
export function pickedText(
  kind: PickerKind,
  picked: PickerValue,
  current: string,
  options: { readonly keepFraction: boolean } = { keepFraction: true },
): string {
  const trimmed = current.trim();
  if (kind === "date") return picked.day ?? current;
  if (kind === "time") {
    if (picked.time === null) return current;
    const fraction = options.keepFraction ? (TIME_PATTERN.exec(trimmed)?.[4] ?? "") : "";
    const zone = ZONE_PATTERN.exec(trimmed)?.[1] ?? "";
    return `${timeText(picked.time)}${fraction}${zone}`;
  }
  if (picked.day === null) return current;
  const match = DATETIME_PATTERN.exec(trimmed);
  const separator = match?.[2] ?? DEFAULT_SEPARATOR;
  const fraction = options.keepFraction ? (match?.[6] ?? "") : "";
  const zone = match?.[7] ?? "";
  return `${picked.day}${separator}${timeText(picked.time ?? MIDNIGHT)}${fraction}${zone}`;
}
