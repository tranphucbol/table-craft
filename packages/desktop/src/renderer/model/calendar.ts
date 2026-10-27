/** An ISO weekday: Monday is 1, Sunday 7. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** One square of a month's grid. */
export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  readonly day: string;
  readonly inMonth: boolean;
  readonly today: boolean;
}

export const DAYS_PER_WEEK = 7;
const GRID_WEEKS = 6;
const GRID_DAYS = DAYS_PER_WEEK * GRID_WEEKS;
const ISO_MONDAY: Weekday = 1;
const ISO_SUNDAY = 7;
export const MONTHS_PER_YEAR = 12;
const MS_PER_DAY = 86_400_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const FIRST_OF_MONTH = "-01";

interface LocaleWithWeekInfo {
  readonly getWeekInfo?: () => { readonly firstDay: number };
  readonly weekInfo?: { readonly firstDay: number };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

// Days are `YYYY-MM-DD` strings and their arithmetic runs in UTC, so no zone or DST shift moves one.
function utcOf(day: string): Date {
  const match = DAY_PATTERN.exec(day);
  if (match === null) throw new RangeError(`Not a YYYY-MM-DD day: ${day}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function dayOfUtc(date: Date): string {
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function isoWeekday(date: Date): Weekday {
  return (date.getUTCDay() === 0 ? ISO_SUNDAY : date.getUTCDay()) as Weekday;
}

/** The local calendar day of a moment. */
export function dayOf(moment: Date): string {
  return `${pad(moment.getFullYear(), 4)}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/** The `YYYY-MM` month a day falls in. */
export function monthOf(day: string): string {
  return day.slice(0, "YYYY-MM".length);
}

export function shiftDay(day: string, by: number): string {
  return dayOfUtc(new Date(utcOf(day).getTime() + by * MS_PER_DAY));
}

/** The same day `by` months on, clamped to that month's last day: Jan 31 + 1 is Feb 28 or 29. */
export function shiftMonth(day: string, by: number): string {
  const date = utcOf(day);
  const months = date.getUTCFullYear() * MONTHS_PER_YEAR + date.getUTCMonth() + by;
  const year = Math.floor(months / MONTHS_PER_YEAR);
  const month = months - year * MONTHS_PER_YEAR;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return dayOfUtc(new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay))));
}

/** How many days `day` sits after the week's first day. */
function offsetInWeek(day: string, firstDay: Weekday): number {
  return (isoWeekday(utcOf(day)) - firstDay + DAYS_PER_WEEK) % DAYS_PER_WEEK;
}

export function weekStart(day: string, firstDay: Weekday): string {
  return shiftDay(day, -offsetInWeek(day, firstDay));
}

export function weekEnd(day: string, firstDay: Weekday): string {
  return shiftDay(weekStart(day, firstDay), DAYS_PER_WEEK - 1);
}

/** Six whole weeks covering `month`, starting on the week's first day: always 42 days. */
export function monthGrid(month: string, firstDay: Weekday, today: string): readonly CalendarDay[] {
  const start = weekStart(`${month}${FIRST_OF_MONTH}`, firstDay);
  return Array.from({ length: GRID_DAYS }, (_, index) => {
    const day = shiftDay(start, index);
    return { day, inMonth: monthOf(day) === month, today: day === today };
  });
}

/** The locale's first day of the week, Monday when the runtime cannot tell. */
export function firstDayOfWeek(locale: string): Weekday {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & LocaleWithWeekInfo;
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;
    return firstDay !== undefined && firstDay >= ISO_MONDAY && firstDay <= ISO_SUNDAY
      ? (firstDay as Weekday)
      : ISO_MONDAY;
  } catch {
    return ISO_MONDAY;
  }
}

/** The weekday headings in the locale's narrow form, starting on `firstDay`. */
export function weekdayInitials(locale: string, firstDay: Weekday): readonly string[] {
  const format = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
  // 2024-01-01 is a Monday.
  const monday = "2024-01-01";
  return Array.from({ length: DAYS_PER_WEEK }, (_, index) =>
    format.format(utcOf(shiftDay(monday, firstDay - ISO_MONDAY + index))),
  );
}

/** `February 2026` in the locale's words. */
export function monthTitle(month: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    utcOf(`${month}${FIRST_OF_MONTH}`),
  );
}

/** A time segment stepped by `by`, wrapping within `0 … size - 1`. */
export function wrapSegment(value: number, by: number, size: number): number {
  return (((value + by) % size) + size) % size;
}
