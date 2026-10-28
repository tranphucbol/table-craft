import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { SQL_SERVER_2019, SQL_SERVER_2022, SQL_SERVER_2025 } from "./ranges.js";

/**
 * Aggregate functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/aggregate-functions-transact-sql.
 * STRING_AGG is in `string.ts`, JSON_ARRAYAGG and JSON_OBJECTAGG in `json.ts`.
 */
export const AGGREGATE_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("aggregate", [
  [
    "APPROX_COUNT_DISTINCT",
    "expression -> bigint",
    "About how many distinct non-null values the group has, faster than COUNT(DISTINCT).",
    SQL_SERVER_2019,
  ],
  [
    "APPROX_PERCENTILE_CONT",
    "fraction -> float",
    "An approximate interpolated percentile; WITHIN GROUP names the ordering.",
    SQL_SERVER_2022,
  ],
  [
    "APPROX_PERCENTILE_DISC",
    "fraction -> any",
    "An approximate percentile taken from the values; WITHIN GROUP names the ordering.",
    SQL_SERVER_2022,
  ],
  ["AVG", ["expression -> number", "DISTINCT expression -> number"], "The mean of the group's non-null values."],
  ["CHECKSUM_AGG", "expression -> integer", "A checksum of the group's values, to spot changes."],
  [
    "COUNT",
    ["* -> integer", "expression -> integer", "DISTINCT expression -> integer"],
    "How many rows the group has, how many give a non-null value, or how many distinct ones.",
  ],
  ["COUNT_BIG", ["* -> bigint", "expression -> bigint", "DISTINCT expression -> bigint"], "COUNT as a bigint."],
  ["GROUPING", "column -> integer", "1 when a ROLLUP, CUBE or GROUPING SETS row stands for all values of the column."],
  ["GROUPING_ID", "column... -> integer", "A bit for each column that GROUPING would answer 1 for."],
  ["MAX", "expression -> any", "The group's largest value."],
  ["MIN", "expression -> any", "The group's smallest value."],
  ["PRODUCT", "expression -> number", "The group's values multiplied together.", SQL_SERVER_2025],
  ["STDEV", "expression -> float", "The sample standard deviation of the group's values."],
  ["STDEVP", "expression -> float", "The population standard deviation of the group's values."],
  ["SUM", ["expression -> number", "DISTINCT expression -> number"], "The total of the group's values."],
  ["VAR", "expression -> float", "The sample variance of the group's values."],
  ["VARP", "expression -> float", "The population variance of the group's values."],
]);
