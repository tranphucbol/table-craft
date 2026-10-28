import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";

/**
 * Numeric functions, with the datetime and interval forms of CEIL, FLOOR, ROUND and TRUNC, summarised
 * in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Single-Row-Functions.html.
 */
export const NUMERIC_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("numeric", [
  ["ABS", "n -> number", "The value without its sign."],
  ["ACOS", "n -> number", "The arc cosine, in radians, of a value between -1 and 1."],
  ["ASIN", "n -> number", "The arc sine, in radians, of a value between -1 and 1."],
  ["ATAN", "n -> number", "The arc tangent, in radians."],
  ["ATAN2", "y, x -> number", "The arc tangent of y / x, in radians, with the quadrant taken from both signs."],
  ["BITAND", "a, b -> number", "The bitwise AND of two whole numbers."],
  [
    "CEIL",
    ["n -> number", "datetime, format? -> date", "interval, format? -> interval"],
    "The smallest whole number not below n; from 23ai also a date or interval rounded up to a unit.",
  ],
  ["COS", "n -> number", "The cosine of an angle in radians."],
  ["COSH", "n -> number", "The hyperbolic cosine."],
  ["EXP", "n -> number", "e raised to the power n."],
  [
    "FLOOR",
    ["n -> number", "datetime, format? -> date", "interval, format? -> interval"],
    "The largest whole number not above n; from 23ai also a date or interval rounded down to a unit.",
  ],
  ["LN", "n -> number", "The natural logarithm of a positive value."],
  ["LOG", "base, n -> number", "The logarithm of n in the given base."],
  [
    "MOD",
    "n, divisor -> number",
    "The remainder of n divided by divisor, with the sign of n; n itself when divisor is 0.",
  ],
  ["NANVL", "n, fallback -> number", "fallback when a BINARY_FLOAT or BINARY_DOUBLE value is NaN, else the value."],
  ["POWER", "base, exponent -> number", "base raised to exponent."],
  [
    "REMAINDER",
    "n, divisor -> number",
    "The remainder of n divided by divisor, using the nearest whole quotient rather than the truncated one.",
  ],
  [
    "ROUND",
    ["n, places? -> number", "date, format? -> date", "interval, format? -> interval"],
    "A number rounded to some decimal places (half away from zero), or a date rounded to a unit such as 'MM'.",
  ],
  [
    "ROUND_TIES_TO_EVEN",
    "n, places? -> number",
    "A number rounded to some decimal places, with halves going to the even neighbour.",
  ],
  ["SIGN", "n -> number", "-1, 0 or 1 by the sign of the value."],
  ["SIN", "n -> number", "The sine of an angle in radians."],
  ["SINH", "n -> number", "The hyperbolic sine."],
  ["SQRT", "n -> number", "The square root of a non-negative value."],
  ["TAN", "n -> number", "The tangent of an angle in radians."],
  ["TANH", "n -> number", "The hyperbolic tangent."],
  [
    "TRUNC",
    ["n, places? -> number", "date, format? -> date", "interval, format? -> interval"],
    "A number cut to some decimal places, or a date cut to a unit such as 'MM'; the time of day when no unit is given.",
  ],
  [
    "WIDTH_BUCKET",
    "expr, low, high, buckets -> number",
    "Which of `buckets` equal-width ranges between low and high holds the value; 0 below and buckets + 1 above.",
  ],
]);
