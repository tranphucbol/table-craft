import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { SQL_SERVER_2022 } from "./ranges.js";

/**
 * Mathematical and bit manipulation functions, summarised in our own words from
 * https://learn.microsoft.com/en-us/sql/t-sql/functions/mathematical-functions-transact-sql and
 * .../bit-manipulation-functions-overview.
 */
export const NUMERIC_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("numeric", [
  ["ABS", "number -> number", "The number without its sign."],
  ["ACOS", "number -> float", "The angle, in radians, whose cosine is the number."],
  ["ASIN", "number -> float", "The angle, in radians, whose sine is the number."],
  ["ATAN", "number -> float", "The angle, in radians, whose tangent is the number."],
  ["ATN2", "y, x -> float", "The angle, in radians, between the x axis and the point (x, y)."],
  ["CEILING", "number -> number", "The smallest whole number not below the number."],
  ["COS", "radians -> float", "The cosine of an angle."],
  ["COT", "radians -> float", "The cotangent of an angle."],
  ["DEGREES", "radians -> number", "An angle in radians converted to degrees."],
  ["EXP", "number -> float", "e raised to the number."],
  ["FLOOR", "number -> number", "The largest whole number not above the number."],
  ["LOG", "number, base? -> float", "The natural logarithm, or the logarithm in the base given."],
  ["LOG10", "number -> float", "The base-10 logarithm."],
  ["PI", "-> float", "The constant pi."],
  ["POWER", "number, exponent -> number", "A number raised to a power."],
  ["RADIANS", "degrees -> number", "An angle in degrees converted to radians."],
  ["RAND", "seed? -> float", "A pseudo-random number from 0 up to 1."],
  ["ROUND", "number, length, truncate? -> number", "A number rounded, or cut when the third argument is not 0."],
  ["SIGN", "number -> number", "-1, 0 or 1 by the number's sign."],
  ["SIN", "radians -> float", "The sine of an angle."],
  ["SQRT", "number -> float", "The square root."],
  ["SQUARE", "number -> float", "The number times itself."],
  ["TAN", "radians -> float", "The tangent of an angle."],
  ["LEFT_SHIFT", "value, shift -> integer", "The value's bits moved left.", SQL_SERVER_2022],
  ["RIGHT_SHIFT", "value, shift -> integer", "The value's bits moved right.", SQL_SERVER_2022],
  ["BIT_COUNT", "value -> integer", "How many bits of the value are set.", SQL_SERVER_2022],
  ["GET_BIT", "value, offset -> bit", "One bit of the value, counting from the lowest.", SQL_SERVER_2022],
  [
    "SET_BIT",
    "value, offset, bit? -> integer",
    "The value with one bit set, or cleared when the third argument is 0.",
    SQL_SERVER_2022,
  ],
]);
