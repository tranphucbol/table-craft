/**
 * `TIMESTAMPTZ` text in the session's `TimeZone`, the way DuckDB prints it. `@duckdb/node-api`
 * prints every instant with the offset the host had when the driver loaded, which ignores
 * `SET TimeZone` and puts summer dates in winter time.
 */

/** Prints a zone-less timestamp, `micros` after the epoch, as DuckDB does: the driver's own text. */
export type LocalTimestampText = (micros: bigint) => string;

/** A `TIMESTAMPTZ` value's text, or null where the driver's own text has to do. */
export type ZonedText = (value: object) => string | null;

const MICROS_PER_MILLI = 1_000n;
const MICROS_PER_SECOND = 1_000_000n;
const MILLIS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
/** `Intl` names years from 1 to 9999 plainly; DuckDB's BC and five-digit years keep the driver's text. */
const FIRST_INSTANT_MS = -62_135_596_800_000;
const LAST_INSTANT_MS = 253_402_300_799_999;
/** `infinity` and `-infinity`, which have no offset. */
const INFINITE_MICROS = 2n ** 63n - 1n;

function partsFormat(timeZone: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return null;
  }
}

/** Seconds east of UTC in `format`'s zone at `epochMs`, to the second as the zone database has it. */
function offsetSeconds(format: Intl.DateTimeFormat, epochMs: number): number {
  const whole = Math.floor(epochMs / MILLIS_PER_SECOND) * MILLIS_PER_SECOND;
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(format.formatToParts(whole).find((candidate) => candidate.type === type)?.value);
  const date = new Date(0);
  date.setUTCFullYear(part("year"), part("month") - 1, part("day"));
  date.setUTCHours(part("hour"), part("minute"), part("second"), 0);
  return (date.getTime() - whole) / MILLIS_PER_SECOND;
}

/** DuckDB's offset suffix: `+07`, `-03:30`; seconds of a local mean time are dropped, as DuckDB does. */
export function offsetText(seconds: number): string {
  const minutes = Math.trunc(Math.abs(seconds) / SECONDS_PER_MINUTE);
  const hours = String(Math.floor(minutes / MINUTES_PER_HOUR)).padStart(2, "0");
  const rest = minutes % MINUTES_PER_HOUR;
  return `${seconds < 0 ? "-" : "+"}${hours}${rest === 0 ? "" : `:${String(rest).padStart(2, "0")}`}`;
}

function microsOf(value: object): bigint | null {
  const micros: unknown = (value as { micros?: unknown }).micros;
  return typeof micros === "bigint" ? micros : null;
}

/** `TIMESTAMPTZ` text in `timeZone`; null for a zone `Intl` does not know, or an instant it cannot place. */
export function zonedText(timeZone: string, local: LocalTimestampText): ZonedText {
  const format = partsFormat(timeZone);
  return (value) => {
    const micros = microsOf(value);
    if (format === null || micros === null || micros === INFINITE_MICROS || micros === -INFINITE_MICROS) return null;
    const epochMs = Number(micros / MICROS_PER_MILLI);
    if (epochMs < FIRST_INSTANT_MS || epochMs > LAST_INSTANT_MS) return null;
    const offset = offsetSeconds(format, epochMs);
    return `${local(micros + BigInt(offset) * MICROS_PER_SECOND)}${offsetText(offset)}`;
  };
}
