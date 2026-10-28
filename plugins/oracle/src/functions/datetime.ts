import { functionSpecs, type FunctionEntry, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { FROM_23 } from "./ranges.js";

const LEVELS = ["YEAR", "QUARTER", "MONTH", "WEEK", "DAY"] as const;
const PERIODS = ["YEAR", "QUARTER", "MONTH", "WEEK"] as const;
const PARTS = [
  ["DAY", "WEEK"],
  ["DAY", "MONTH"],
  ["DAY", "QUARTER"],
  ["DAY", "YEAR"],
  ["WEEK", "YEAR"],
  ["MONTH", "QUARTER"],
  ["MONTH", "YEAR"],
  ["QUARTER", "YEAR"],
] as const;
/** Only the retail calendar numbers weeks within months and quarters. */
const RETAIL_PARTS = [...PARTS, ["WEEK", "MONTH"], ["WEEK", "QUARTER"]] as const;
/** Where the calendar can count by position as well as by date, as `index_by` chooses. */
const INDEXED = new Set(["DAY_OF_WEEK", "MONTH_OF_YEAR"]);

interface Calendar {
  readonly prefix: "CALENDAR" | "FISCAL" | "RETAIL";
  readonly noun: string;
  /** The extra argument every function of this calendar takes after the date's own. */
  readonly extra: string;
  readonly parts: readonly (readonly [string, string])[];
}

const CALENDARS: readonly Calendar[] = [
  { prefix: "CALENDAR", noun: "Gregorian calendar", extra: "", parts: PARTS },
  { prefix: "FISCAL", noun: "fiscal calendar", extra: ", fiscal_year_start?", parts: PARTS },
  { prefix: "RETAIL", noun: "4-5-4 retail calendar", extra: ", is_restated?", parts: RETAIL_PARTS },
];

function lower(word: string): string {
  return word.toLowerCase();
}

/**
 * The calendar, fiscal and retail families of 23ai: one function per level, period and part, so
 * they are spelled out from the reference's patterns, checked against `V$SQLFN_METADATA` on 23.26.
 */
function calendarEntries({ prefix, noun, extra, parts }: Calendar): FunctionEntry[] {
  // Retail functions take an NLS parameter only where they format text.
  const nls = prefix === "RETAIL" ? "" : ", nlsparam?";
  return [
    ...LEVELS.map((level): FunctionEntry => [
      `${prefix}_${level}`,
      `dtexpr, format?${extra}, nlsparam? -> string`,
      `The ${lower(level)} of the ${noun} a date falls in, as text that names it.`,
      FROM_23,
    ]),
    ...LEVELS.map((level): FunctionEntry => [
      `${prefix}_ADD_${level}S`,
      `dtexpr, periods${extra}${nls} -> date`,
      `The date moved by some ${lower(level)}s of the ${noun}; back when periods is negative.`,
      FROM_23,
    ]),
    ...PERIODS.flatMap((period): FunctionEntry[] =>
      (["START", "END"] as const).map((edge) => [
        `${prefix}_${period}_${edge}_DATE`,
        `dtexpr${extra}${nls} -> date`,
        `The first or last day of the ${noun} ${lower(period)} a date falls in.`,
        FROM_23,
      ]),
    ),
    ...parts.map(([part, whole]): FunctionEntry => {
      const name = `${part}_OF_${whole}`;
      const index = INDEXED.has(name) && (prefix !== "CALENDAR" || part === "DAY") ? ", index_by?" : "";
      return [
        `${prefix}_${name}`,
        `dtexpr${index}${extra}${nls} -> number`,
        `Which ${lower(part)} of its ${lower(whole)} in the ${noun} a date falls on, from 1.`,
        FROM_23,
      ];
    }),
    [
      `${prefix}_YEAR_NUMBER`,
      `dtexpr${extra}${nls} -> number`,
      `The number of the ${noun} year a date falls in.`,
      FROM_23,
    ],
  ];
}

/**
 * Datetime and calendar functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html,
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Single-Row-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/CALENDAR.html.
 */
export const DATETIME_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("datetime", [
  ["ADD_MONTHS", "date, months -> date", "The date some months later, kept at month end when it was on one."],
  ...CALENDARS.flatMap(calendarEntries),
  [
    "CALENDAR_SINCE",
    "dtexpr, nlsparam? -> string",
    "How long ago or ahead of now a date is, in words such as '3 days ago'.",
    FROM_23,
  ],
  ["CURRENT_DATE", "= date", "The current date and time in the session's time zone, written without parentheses."],
  [
    "CURRENT_TIMESTAMP",
    "= timestamp",
    "The current timestamp with the session's time zone, written without parentheses; a precision may follow in them.",
  ],
  [
    "DATEADD",
    "unit, amount, datetime -> date",
    "A date or timestamp moved by some units such as DAY or MONTH.",
    FROM_23,
  ],
  [
    "DATEDIFF",
    "unit, start, end -> number",
    "How many unit boundaries lie between two datetimes; negative when end comes first.",
    FROM_23,
  ],
  [
    "RETAIL_DAY_EXISTS",
    "dtexpr, is_restated -> boolean",
    "Whether a day exists in the retail calendar; in a RESTATED one, the dropped 53rd week's days do not.",
    FROM_23,
  ],
  ["DBTIMEZONE", "= string", "The database's time zone, written without parentheses."],
  [
    "EXTRACT",
    ["unit FROM datetime -> number", "xml, xpath, namespace? -> xmltype"],
    "One field, such as YEAR or HOUR, of a date, timestamp or interval; given XML, the nodes an XPath selects (deprecated).",
  ],
  [
    "FROM_TZ",
    "timestamp, zone -> timestamp",
    "A timestamp read as local time in a time zone, giving a TIMESTAMP WITH TIME ZONE.",
  ],
  ["LAST_DAY", "date -> date", "The last day of the date's month, at the same time of day."],
  [
    "LOCALTIMESTAMP",
    "= timestamp",
    "The current timestamp in the session's time zone, without a zone, written without parentheses.",
  ],
  [
    "MONTHS_BETWEEN",
    "date1, date2 -> number",
    "How many months date1 is after date2, fractional unless both fall on the same day or month ends.",
  ],
  [
    "NEW_TIME",
    "date, from_zone, to_zone -> date",
    "A date converted between two of the North American zone abbreviations such as 'EST'.",
  ],
  ["NEXT_DAY", "date, weekday -> date", "The first named weekday after the date."],
  ["NUMTODSINTERVAL", "n, unit -> interval", "A number of DAY, HOUR, MINUTE or SECOND as an INTERVAL DAY TO SECOND."],
  ["NUMTOYMINTERVAL", "n, unit -> interval", "A number of YEAR or MONTH as an INTERVAL YEAR TO MONTH."],
  [
    "ORA_DST_AFFECTED",
    "datetime -> number",
    "1 when a time zone file upgrade changes the TIMESTAMP WITH TIME ZONE value, else 0; for use during the upgrade.",
  ],
  [
    "ORA_DST_CONVERT",
    "datetime, on_overlap?, on_gap? -> timestamp",
    "A TIMESTAMP WITH TIME ZONE value adjusted for a time zone file upgrade, with chosen handling of errors.",
  ],
  [
    "ORA_DST_ERROR",
    "datetime -> number",
    "Whether a TIMESTAMP WITH TIME ZONE value falls in a gap or overlap after a time zone file upgrade.",
  ],
  ["SCN_TO_TIMESTAMP", "scn -> timestamp", "Roughly when a system change number was reached."],
  ["SESSIONTIMEZONE", "= string", "The session's time zone, written without parentheses."],
  ["SYS_EXTRACT_UTC", "datetime -> timestamp", "A datetime with a time zone converted to UTC."],
  ["SYSDATE", "= date", "The database server's current date and time, written without parentheses."],
  [
    "SYSTIMESTAMP",
    "= timestamp",
    "The database server's current timestamp with its time zone, written without parentheses.",
  ],
  [
    "TIME_BUCKET",
    "datetime, stride, origin, START|END? -> date",
    "The start, or end, of the fixed-width bucket, counted from an origin, that a datetime falls in.",
    FROM_23,
  ],
  ["TIMESTAMP_TO_SCN", "timestamp -> number", "The system change number current at roughly that time."],
  ["TIMESTAMPDIFF", "unit, start, end -> number", "Another name for DATEDIFF.", FROM_23],
  [
    "TZ_OFFSET",
    "zone -> string",
    "The offset from UTC of a zone name, an offset, SESSIONTIMEZONE or DBTIMEZONE, as '+hh:mi'.",
  ],
]);
