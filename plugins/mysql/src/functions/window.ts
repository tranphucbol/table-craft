import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { since } from "./ranges.js";

const MYSQL_WINDOWS = "8.0.2";

/**
 * Window functions, summarised in our own words from
 * https://dev.mysql.com/doc/refman/8.4/en/window-function-descriptions.html and
 * https://docs.pingcap.com/tidb/v4.0/window-functions.
 */
export const WINDOW_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("window", [
  ["CUME_DIST", "-> double", "The share of rows in the partition that sort at or before this one."],
  ["DENSE_RANK", "-> integer", "The row's rank in the partition, without gaps after ties."],
  ["FIRST_VALUE", "expr -> value", "The value at the first row of the frame."],
  ["LAG", "expr, offset?, default? -> value", "The value from a row before this one in the partition, one by default."],
  ["LAST_VALUE", "expr -> value", "The value at the last row of the frame."],
  ["LEAD", "expr, offset?, default? -> value", "The value from a row after this one in the partition, one by default."],
  ["NTH_VALUE", "expr, n -> value", "The value at the n-th row of the frame."],
  ["NTILE", "buckets -> integer", "Which of n roughly equal buckets the row falls in."],
  ["PERCENT_RANK", "-> double", "The row's rank as a share from 0 to 1."],
  ["RANK", "-> integer", "The row's rank in the partition, with gaps after ties."],
  ["ROW_NUMBER", "-> integer", "The row's position in the partition, from 1."],
]).map((spec) => ({ ...spec, available: since(MYSQL_WINDOWS) }));
