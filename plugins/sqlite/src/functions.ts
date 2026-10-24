import { functionSpecs, SQL_FUNCTIONS, type FunctionSpec } from "@table-craft/plugin-api/sql";

/** The shared functions plus a few SQLite ones, in our own words; the full list is a later plan. */
export const SQLITE_FUNCTIONS: readonly FunctionSpec[] = [
  ...SQL_FUNCTIONS,
  ...functionSpecs("datetime", [
    ["DATE", "time?, modifier... -> text", "The date part as YYYY-MM-DD, after applying any modifiers."],
    ["DATETIME", "time?, modifier... -> text", "Date and time as YYYY-MM-DD HH:MM:SS, after applying any modifiers."],
  ]),
  ...functionSpecs("aggregate", [
    [
      "GROUP_CONCAT",
      "expr, separator? -> text",
      "Joins the group's non-null values, with a comma unless told otherwise.",
    ],
  ]),
  ...functionSpecs("control", [["IFNULL", "value, fallback -> value", "The first argument unless it is null."]]),
  ...functionSpecs("json", [["JSON_EXTRACT", "json, path... -> value", "The value at each path in a JSON text."]]),
];
