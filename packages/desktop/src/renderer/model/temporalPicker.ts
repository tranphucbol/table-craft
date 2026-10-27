export type PickerKind = "date" | "datetime-local" | "time";

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
const TIME_PATTERN = /(\d{2}:\d{2})(:\d{2})?/u;
const DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})([ T])(\d{2}:\d{2})(:\d{2})?(\.\d+)?(.*)$/u;
const SECONDS = ":00";

function baseName(type: string): string {
  return type
    .toLowerCase()
    .replace(/\(.*?\)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The native picker a temporal column's type takes; null for one it cannot pick, such as `interval`. */
export function pickerKindOf(type: string | null): PickerKind | null {
  if (type === null) return null;
  const name = baseName(type);
  if (DATE_TYPES.has(name)) return "date";
  if (TIME_TYPES.has(name)) return "time";
  if (DATETIME_TYPES.has(name)) return "datetime-local";
  return null;
}

/** The cell's text as the picker's value, or "" when the text does not read as one. */
export function pickerValueOf(kind: PickerKind, text: string): string {
  if (kind === "date") return DATE_PATTERN.exec(text)?.[1] ?? "";
  if (kind === "time") {
    const match = TIME_PATTERN.exec(text);
    return match === null ? "" : `${match[1] ?? ""}${match[2] ?? SECONDS}`;
  }
  const match = DATETIME_PATTERN.exec(text);
  if (match === null) {
    const day = DATE_PATTERN.exec(text)?.[1];
    return day === undefined ? "" : `${day}T00${SECONDS}${SECONDS}`;
  }
  return `${match[1] ?? ""}T${match[3] ?? ""}${match[4] ?? SECONDS}`;
}

function withSeconds(time: string): string {
  return time.length === "00:00".length ? `${time}${SECONDS}` : time;
}

/**
 * The text a picked value writes into the cell, in the shape the cell already has: a date-time
 * keeps its separator and any zone suffix, so `2024-01-15T10:00:00Z` stays an instant in UTC.
 * There is no date format setting, so a cell with no text takes the ISO shape the database reads.
 */
export function pickedText(kind: PickerKind, picked: string, current: string): string {
  if (picked === "") return current;
  if (kind === "date") return picked;
  if (kind === "time") {
    const zone = /([+-]\d{2}(:?\d{2})?|Z)$/u.exec(current.trim())?.[1] ?? "";
    return `${withSeconds(picked)}${zone}`;
  }
  const [day = "", time = ""] = picked.split("T");
  const match = DATETIME_PATTERN.exec(current.trim());
  const separator = match?.[2] ?? " ";
  const zone = match?.[6] ?? "";
  return `${day}${separator}${withSeconds(time)}${zone}`;
}
