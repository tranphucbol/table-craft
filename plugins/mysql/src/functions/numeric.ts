import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";

/**
 * Numeric functions, summarised in our own words from
 * https://dev.mysql.com/doc/refman/8.4/en/mathematical-functions.html,
 * https://dev.mysql.com/doc/refman/5.7/en/mathematical-functions.html and
 * https://docs.pingcap.com/tidb/v4.0/numeric-functions-and-operators.
 */
export const NUMERIC_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("numeric", [
  ["ABS", "x -> number", "The value without its sign."],
  ["ACOS", "x -> double", "The arc cosine in radians; null outside -1 to 1."],
  ["ASIN", "x -> double", "The arc sine in radians; null outside -1 to 1."],
  ["ATAN", ["x -> double", "y, x -> double"], "The arc tangent in radians; with two arguments, of y / x by quadrant."],
  ["ATAN2", "y, x -> double", "The arc tangent of y / x, using both signs to pick the quadrant."],
  ["CEIL", "x -> number", "The smallest whole number not below x."],
  ["CEILING", "x -> number", "Another name for CEIL."],
  ["CONV", "n, from_base, to_base -> string", "Rewrites a number from one base to another, bases 2 to 36."],
  ["COS", "x -> double", "The cosine of an angle in radians."],
  ["COT", "x -> double", "The cotangent of an angle in radians."],
  ["CRC32", "str -> integer", "A 32-bit cyclic redundancy check of the string."],
  ["DEGREES", "x -> double", "Radians turned into degrees."],
  ["EXP", "x -> double", "e raised to the power x."],
  ["FLOOR", "x -> number", "The largest whole number not above x."],
  ["LN", "x -> double", "The natural logarithm."],
  ["LOG", ["x -> double", "base, x -> double"], "The natural logarithm, or the logarithm in a given base."],
  ["LOG10", "x -> double", "The base-10 logarithm."],
  ["LOG2", "x -> double", "The base-2 logarithm."],
  ["MOD", "n, m -> number", "The remainder of n divided by m."],
  ["PI", "-> double", "The number π."],
  ["POW", "x, y -> double", "x raised to the power y."],
  ["POWER", "x, y -> double", "Another name for POW."],
  ["RADIANS", "x -> double", "Degrees turned into radians."],
  ["RAND", "seed? -> double", "A random number from 0 up to 1; a seed repeats the sequence."],
  ["ROUND", "x, decimals? -> number", "Rounds to a number of decimal places, none by default."],
  ["SIGN", "x -> integer", "-1, 0 or 1 by the sign of x."],
  ["SIN", "x -> double", "The sine of an angle in radians."],
  ["SQRT", "x -> double", "The square root; null for a negative number."],
  ["TAN", "x -> double", "The tangent of an angle in radians."],
  ["TRUNCATE", "x, decimals -> number", "Cuts a number to a number of decimal places without rounding."],
]);
