import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { MYSQL_ONLY, since } from "./ranges.js";

/**
 * Information functions, summarised in our own words from
 * https://dev.mysql.com/doc/refman/8.4/en/information-functions.html,
 * https://dev.mysql.com/doc/refman/5.7/en/information-functions.html,
 * https://docs.pingcap.com/tidb/v4.0/information-functions and
 * https://docs.pingcap.com/tidb/stable/information-functions.
 */
export const INFO_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("information", [
  ["BENCHMARK", "count, expr -> integer", "Evaluates an expression many times to time it; always 0."],
  ["CHARSET", "str -> string", "The character set of the string.", MYSQL_ONLY],
  ["COERCIBILITY", "str -> integer", "How strongly the string's collation wins a comparison."],
  ["COLLATION", "str -> string", "The collation of the string."],
  ["CONNECTION_ID", "-> integer", "The id of this connection."],
  ["CURRENT_ROLE", "-> string", "The roles active in this session.", since("8.0")],
  ["CURRENT_USER", "-> string", "The account the server checked this session's privileges against."],
  ["DATABASE", "-> string", "The current database, or null when none is chosen."],
  ["FOUND_ROWS", "-> integer", "How many rows the last SELECT with SQL_CALC_FOUND_ROWS would have found."],
  ["ICU_VERSION", "-> string", "The version of the regular expression library.", since("8.0.4", false)],
  ["LAST_INSERT_ID", "expr? -> integer", "The first AUTO_INCREMENT value this session's last insert generated."],
  ["ROLES_GRAPHML", "-> string", "The role graph as a GraphML document.", since("8.0", false)],
  ["ROW_COUNT", "-> integer", "How many rows the last statement changed."],
  ["SCHEMA", "-> string", "Another name for DATABASE."],
  ["SESSION_USER", "-> string", "Another name for USER."],
  ["SYSTEM_USER", "-> string", "Another name for USER."],
  ["USER", "-> string", "The user and host the client connected as."],
  ["VERSION", "-> string", "The server's version string."],
]);
