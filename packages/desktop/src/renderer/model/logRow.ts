import type { LogRecord } from "@table-craft/desktop/log/record.js";

/** A row shows this much of each field; the selected record's details show it whole. */
export const LOG_ROW_FIELD_CHARS = 160;
const ELLIPSIS = "…";
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["ts", "level", "process", "scope", "msg"]);

function short(text: string): string {
  const line = text.replace(/\s+/g, " ");
  return line.length > LOG_ROW_FIELD_CHARS ? `${line.slice(0, LOG_ROW_FIELD_CHARS)}${ELLIPSIS}` : line;
}

/** The fields after the message, as `key=value`, the error reduced to its message. */
export function fieldsText(record: LogRecord): string {
  return Object.entries(record)
    .filter(([key]) => !ENVELOPE_KEYS.has(key))
    .map(([key, value]) =>
      key === "err" && typeof value === "object" && value !== null && "message" in value
        ? `err=${short(String(value.message))}`
        : `${key}=${short(typeof value === "string" ? value : JSON.stringify(value))}`,
    )
    .join(" ");
}

/** The scopes present, plus the one the filter names so the menu can show it before its first record. */
export function scopeOptions(present: readonly string[], chosen: string): readonly string[] {
  return chosen === "" || present.includes(chosen) ? present : [...present, chosen].sort();
}
