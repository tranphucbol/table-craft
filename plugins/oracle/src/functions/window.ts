import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";

/**
 * Analytic and ranking functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Analytic-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Analytic-Functions.html.
 */
export const WINDOW_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("window", [
  [
    "CUME_DIST",
    ["-> number", "expr... -> number"],
    "The share of rows ordered at or before this one; with arguments, where a hypothetical row would fall.",
  ],
  [
    "DENSE_RANK",
    ["-> number", "expr... -> number"],
    "The row's rank with no gaps after ties; with arguments, a hypothetical row's rank in the group.",
  ],
  ["FIRST_VALUE", "expr -> any", "The value at the first row of the window frame."],
  ["LAG", "expr, offset?, default? -> any", "The value some rows before this one in the partition's order."],
  ["LAST_VALUE", "expr -> any", "The value at the last row of the window frame."],
  ["LEAD", "expr, offset?, default? -> any", "The value some rows after this one in the partition's order."],
  ["NTH_VALUE", "expr, n -> any", "The value at the nth row of the window frame, counting FROM FIRST or FROM LAST."],
  ["NTILE", "buckets -> number", "Which of n nearly equal groups, in order, the row falls in."],
  [
    "PERCENT_RANK",
    ["-> number", "expr... -> number"],
    "The row's rank minus 1, over the rows minus 1, from 0 to 1; with arguments, for a hypothetical row.",
  ],
  [
    "RANK",
    ["-> number", "expr... -> number"],
    "The row's rank, leaving gaps after ties; with arguments, a hypothetical row's rank in the group.",
  ],
  ["RATIO_TO_REPORT", "expr -> number", "The value's share of the partition's total."],
  ["ROW_NUMBER", "-> number", "Numbers the rows of the partition from 1 in the window's order."],
]);
