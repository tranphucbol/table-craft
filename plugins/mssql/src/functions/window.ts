import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";

/**
 * Ranking and analytic functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/ranking-functions-transact-sql and
 * .../analytic-functions-transact-sql. Each takes an OVER clause.
 */
export const WINDOW_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("window", [
  ["CUME_DIST", "-> float", "The share of the partition's rows ordered at or before this one."],
  ["DENSE_RANK", "-> bigint", "The row's rank in the partition, with no gaps after ties."],
  ["FIRST_VALUE", "expression -> any", "The value at the first row of the frame."],
  ["LAG", "expression, offset?, default? -> any", "The value from a row before this one, one by default."],
  ["LAST_VALUE", "expression -> any", "The value at the last row of the frame."],
  ["LEAD", "expression, offset?, default? -> any", "The value from a row after this one, one by default."],
  ["NTILE", "groups -> bigint", "Which of that many equal groups the row falls in."],
  [
    "PERCENTILE_CONT",
    "fraction -> float",
    "An interpolated percentile of the partition; WITHIN GROUP names the ordering.",
  ],
  [
    "PERCENTILE_DISC",
    "fraction -> any",
    "The first value at or past a percentile of the partition; WITHIN GROUP names the ordering.",
  ],
  ["PERCENT_RANK", "-> float", "The row's relative rank in the partition, from 0 to 1."],
  ["RANK", "-> bigint", "The row's rank in the partition, leaving gaps after ties."],
  ["ROW_NUMBER", "-> bigint", "The row's position in the partition, from 1."],
]);
