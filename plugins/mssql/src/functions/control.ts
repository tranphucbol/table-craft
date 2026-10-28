import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { SQL_SERVER_2022 } from "./ranges.js";

/**
 * Conversion, logical and cursor functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/conversion-functions-transact-sql,
 * .../logical-functions-choose-transact-sql and .../cursor-functions-transact-sql.
 */
export const CONTROL_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("control", [
  ["CAST", "expression AS data_type -> any", "The value converted to a data type; an error when it cannot be."],
  [
    "CONVERT",
    "data_type, expression, style? -> any",
    "The value converted to a data type, a style code choosing the date or number format.",
  ],
  [
    "PARSE",
    "string AS data_type USING culture? -> any",
    "Text read as a date, time or number, in a .NET culture such as 'en-US'.",
  ],
  ["TRY_CAST", "expression AS data_type -> any", "CAST, giving null instead of an error."],
  ["TRY_CONVERT", "data_type, expression, style? -> any", "CONVERT, giving null instead of an error."],
  ["TRY_PARSE", "string AS data_type USING culture? -> any", "PARSE, giving null instead of an error."],
  ["CHOOSE", "index, value, value... -> any", "The value at a position in the list, from 1."],
  ["GREATEST", "expression, expression... -> any", "The largest of its arguments, skipping nulls.", SQL_SERVER_2022],
  ["IIF", "condition, true_value, false_value -> any", "One of two values, by whether the condition holds."],
  ["LEAST", "expression, expression... -> any", "The smallest of its arguments, skipping nulls.", SQL_SERVER_2022],
  ["@@CURSOR_ROWS", "= integer", "How many rows the last opened cursor holds; negative while it fills."],
  ["@@FETCH_STATUS", "= integer", "How the last FETCH went: 0 for a row, -1 past the end, -2 for a missing row."],
  ["CURSOR_STATUS", "scope, cursor -> integer", "Whether a cursor is open and has rows."],
]);
