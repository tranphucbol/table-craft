import { functionSpecs, SQL_FUNCTIONS, type FunctionSpec } from "@table-craft/plugin-api/sql";

/** The shared functions plus a few PostgreSQL ones, in our own words; the full list is a later plan. */
export const POSTGRES_FUNCTIONS: readonly FunctionSpec[] = [
  ...SQL_FUNCTIONS,
  ...functionSpecs("aggregate", [
    ["ARRAY_AGG", "expr -> array", "Collects the group's values into an array."],
    [
      "STRING_AGG",
      "expr, delimiter -> text",
      "Joins the group's values into one string with a delimiter between them.",
    ],
  ]),
  ...functionSpecs("datetime", [["NOW", "-> timestamptz", "The start time of the current transaction."]]),
  ...functionSpecs("string", [["TO_CHAR", "value, format -> text", "Formats a date, time or number as text."]]),
];
