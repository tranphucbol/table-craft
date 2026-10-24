import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { since, TIDB_AFTER_4 } from "./ranges.js";

/**
 * Aggregate functions, summarised in our own words from
 * https://dev.mysql.com/doc/refman/8.4/en/aggregate-functions.html,
 * https://dev.mysql.com/doc/refman/5.7/en/aggregate-functions.html,
 * https://docs.pingcap.com/tidb/v4.0/aggregate-group-by-functions and
 * https://docs.pingcap.com/tidb/stable/aggregate-group-by-functions.
 */
export const AGGREGATE_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("aggregate", [
  ["AVG", "expr -> number", "The mean of the group's non-null values; DISTINCT averages each value once."],
  ["BIT_AND", "expr -> integer", "The bitwise AND of the group's values."],
  ["BIT_OR", "expr -> integer", "The bitwise OR of the group's values."],
  ["BIT_XOR", "expr -> integer", "The bitwise XOR of the group's values."],
  [
    "COUNT",
    ["* -> integer", "expr -> integer", "DISTINCT expr... -> integer"],
    "How many rows the group has, how many give a non-null value, or how many distinct ones.",
  ],
  [
    "GROUP_CONCAT",
    "expr... -> string",
    "Joins the group's values into one string; ORDER BY sorts them and SEPARATOR replaces the comma.",
  ],
  ["JSON_ARRAYAGG", "expr -> json", "Collects the group's values into a JSON array.", since("5.7.22", TIDB_AFTER_4)],
  [
    "JSON_OBJECTAGG",
    "key, value -> json",
    "Collects the group's key and value pairs into a JSON object.",
    since("5.7.22"),
  ],
  ["MAX", "expr -> value", "The largest value in the group."],
  ["MIN", "expr -> value", "The smallest value in the group."],
  ["STD", "expr -> double", "Another name for STDDEV_POP."],
  ["STDDEV", "expr -> double", "Another name for STDDEV_POP."],
  ["STDDEV_POP", "expr -> double", "The population standard deviation of the group."],
  ["STDDEV_SAMP", "expr -> double", "The sample standard deviation of the group."],
  ["SUM", "expr -> number", "The total of the group's values; DISTINCT adds each value once."],
  ["VAR_POP", "expr -> double", "The population variance of the group."],
  ["VAR_SAMP", "expr -> double", "The sample variance of the group."],
  ["VARIANCE", "expr -> double", "Another name for VAR_POP."],
]);
