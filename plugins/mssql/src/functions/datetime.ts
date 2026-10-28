import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { SQL_SERVER_2022, SQL_SERVER_2025 } from "./ranges.js";

/**
 * Date and time functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/date-and-time-data-types-and-functions-transact-sql.
 * `datepart` is a keyword such as `day` or `hour`, not a string.
 */
export const DATETIME_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("datetime", [
  ["@@DATEFIRST", "= integer", "Which day starts the week for this session, 7 for Sunday."],
  ["CURRENT_DATE", "= date", "Today's date on the server.", SQL_SERVER_2025],
  ["CURRENT_TIMESTAMP", "= datetime", "The server's date and time now; the standard name for GETDATE."],
  ["CURRENT_TIMEZONE", "-> string", "The server's or the database's time zone.", SQL_SERVER_2022],
  ["CURRENT_TIMEZONE_ID", "-> string", "The Windows id of the server's time zone.", SQL_SERVER_2022],
  [
    "DATE_BUCKET",
    "datepart, number, date, origin? -> datetime",
    "The start of the fixed-width bucket the date falls in.",
    SQL_SERVER_2022,
  ],
  ["DATEADD", "datepart, number, date -> datetime", "A date moved by a number of date parts."],
  ["DATEDIFF", "datepart, startdate, enddate -> integer", "How many date-part boundaries lie between two dates."],
  ["DATEDIFF_BIG", "datepart, startdate, enddate -> bigint", "DATEDIFF as a bigint, for spans int cannot hold."],
  ["DATEFROMPARTS", "year, month, day -> date", "A date from its parts."],
  ["DATENAME", "datepart, date -> string", "One part of a date as text, such as the month's name."],
  ["DATEPART", "datepart, date -> integer", "One part of a date as a number."],
  [
    "DATETIME2FROMPARTS",
    "year, month, day, hour, minute, seconds, fractions, precision -> datetime2",
    "A datetime2 from its parts.",
  ],
  [
    "DATETIMEFROMPARTS",
    "year, month, day, hour, minute, seconds, milliseconds -> datetime",
    "A datetime from its parts.",
  ],
  [
    "DATETIMEOFFSETFROMPARTS",
    "year, month, day, hour, minute, seconds, fractions, hour_offset, minute_offset, precision -> datetimeoffset",
    "A datetimeoffset from its parts.",
  ],
  ["DATETRUNC", "datepart, date -> datetime", "The date cut down to the start of the date part.", SQL_SERVER_2022],
  ["DAY", "date -> integer", "The day of the month."],
  ["EOMONTH", "date, months? -> date", "The last day of the date's month, or of a month that many later."],
  ["GETDATE", "-> datetime", "The server's local date and time now."],
  ["GETUTCDATE", "-> datetime", "The UTC date and time now."],
  ["ISDATE", "expression -> integer", "1 when the text reads as a date or time, else 0."],
  ["MONTH", "date -> integer", "The month, from 1 to 12."],
  ["SMALLDATETIMEFROMPARTS", "year, month, day, hour, minute -> smalldatetime", "A smalldatetime from its parts."],
  ["SWITCHOFFSET", "datetimeoffset, offset -> datetimeoffset", "The same instant shown in another time zone offset."],
  ["SYSDATETIME", "-> datetime2", "The server's local date and time now, to 100 nanoseconds."],
  ["SYSDATETIMEOFFSET", "-> datetimeoffset", "The server's date and time now with its offset."],
  ["SYSUTCDATETIME", "-> datetime2", "The UTC date and time now, to 100 nanoseconds."],
  ["TIMEFROMPARTS", "hour, minute, seconds, fractions, precision -> time", "A time from its parts."],
  ["TODATETIMEOFFSET", "date, offset -> datetimeoffset", "A local date and time given a time zone offset."],
  ["YEAR", "date -> integer", "The year."],
]);
