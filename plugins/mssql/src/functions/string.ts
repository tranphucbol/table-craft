import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { BEFORE_2022, SQL_SERVER_2022, SQL_SERVER_2025 } from "./ranges.js";

/**
 * String, fuzzy string matching, regular expression and collation functions, summarised in our own
 * words from https://learn.microsoft.com/en-us/sql/t-sql/functions/string-functions-transact-sql,
 * .../regular-expressions-functions-transact-sql, .../edit-distance-transact-sql and
 * .../collation-functions-collationproperty-transact-sql. A function 2022 extended has one spec per
 * shape, the newer first.
 */
export const STRING_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("string", [
  ["ASCII", "character -> integer", "The code of the first character, in the column's code page."],
  ["BASE64_DECODE", "expression -> varbinary", "Decodes base-64 text into bytes.", SQL_SERVER_2025],
  ["BASE64_ENCODE", "expression, url_safe? -> string", "Encodes bytes as base-64 text.", SQL_SERVER_2025],
  ["CHAR", "code -> string", "The single-byte character with that code."],
  ["CHARINDEX", "find, search, start? -> integer", "Where a string first appears in another, from 1; 0 when absent."],
  ["CONCAT", "value, value... -> string", "Joins its arguments end to end, reading null as an empty string."],
  ["CONCAT_WS", "separator, value, value... -> string", "Joins its arguments with a separator, skipping nulls."],
  ["DIFFERENCE", "left, right -> integer", "How alike two strings sound, from 0 to 4, by their SOUNDEX codes."],
  ["FORMAT", "value, format, culture? -> string", "A number or date written with a .NET format string."],
  ["LEFT", "string, count -> string", "The first characters of a string."],
  ["LEN", "string -> integer", "How many characters a string has, leaving out trailing spaces."],
  ["LOWER", "string -> string", "The string in lower case."],
  [
    "LTRIM",
    "string, characters? -> string",
    "The string without leading spaces or the characters given.",
    SQL_SERVER_2022,
  ],
  ["LTRIM", "string -> string", "The string without leading spaces.", BEFORE_2022],
  ["NCHAR", "code -> string", "The Unicode character with that code point."],
  ["PATINDEX", "pattern, expression -> integer", "Where a LIKE pattern first matches, from 1; 0 when it does not."],
  ["QUOTENAME", "string, quote? -> string", "The string as a delimited identifier, in brackets unless told otherwise."],
  ["REPLACE", "string, find, replacement -> string", "Every occurrence of a string replaced by another."],
  ["REPLICATE", "string, count -> string", "The string repeated a number of times."],
  ["REVERSE", "string -> string", "The string back to front."],
  ["RIGHT", "string, count -> string", "The last characters of a string."],
  [
    "RTRIM",
    "string, characters? -> string",
    "The string without trailing spaces or the characters given.",
    SQL_SERVER_2022,
  ],
  ["RTRIM", "string -> string", "The string without trailing spaces.", BEFORE_2022],
  ["SOUNDEX", "string -> string", "A four-character code for how a string sounds."],
  ["SPACE", "count -> string", "A string of that many spaces."],
  ["STR", "number, length?, decimals? -> string", "A number written as right-aligned text."],
  [
    "STRING_AGG",
    "expression, separator -> string",
    "Joins the group's values with a separator; WITHIN GROUP orders them.",
  ],
  ["STRING_ESCAPE", "text, type -> string", "Escapes special characters for the named format, such as 'json'."],
  [
    "STUFF",
    "string, start, length, replacement -> string",
    "Deletes part of a string and inserts another in its place.",
  ],
  ["SUBSTRING", "expression, start, length -> string", "Part of a string, binary or text value, from 1."],
  [
    "TRANSLATE",
    "string, characters, translations -> string",
    "Replaces each listed character by the one at the same place in the second list.",
  ],
  [
    "TRIM",
    ["string -> string", "characters FROM string -> string", "LEADING|TRAILING|BOTH characters FROM string -> string"],
    "The string without spaces or the characters given at its start, end or both.",
    SQL_SERVER_2022,
  ],
  [
    "TRIM",
    ["string -> string", "characters FROM string -> string"],
    "The string without spaces or the characters given at both ends.",
    BEFORE_2022,
  ],
  ["UNICODE", "character -> integer", "The code point of the first character."],
  ["UNISTR", "text, escape? -> string", "Text with \\XXXX escapes read as Unicode characters.", SQL_SERVER_2025],
  ["UPPER", "string -> string", "The string in upper case."],
  [
    "EDIT_DISTANCE",
    "left, right, maximum? -> integer",
    "How many single-character edits turn one string into the other (Damerau-Levenshtein).",
    SQL_SERVER_2025,
  ],
  [
    "EDIT_DISTANCE_SIMILARITY",
    "left, right -> integer",
    "How alike two strings are by edit distance, from 0 to 100.",
    SQL_SERVER_2025,
  ],
  [
    "JARO_WINKLER_DISTANCE",
    "left, right -> float",
    "The Jaro-Winkler distance between two strings, 0 when equal.",
    SQL_SERVER_2025,
  ],
  [
    "JARO_WINKLER_SIMILARITY",
    "left, right -> integer",
    "How alike two strings are by Jaro-Winkler, from 0 to 100.",
    SQL_SERVER_2025,
  ],
  [
    "REGEXP_LIKE",
    "string, pattern, flags? -> boolean",
    "Whether a regular expression matches the string.",
    SQL_SERVER_2025,
  ],
  [
    "REGEXP_REPLACE",
    "string, pattern, replacement?, start?, occurrence?, flags? -> string",
    "The string with regular expression matches replaced.",
    SQL_SERVER_2025,
  ],
  [
    "REGEXP_SUBSTR",
    "string, pattern, start?, occurrence?, flags?, group? -> string",
    "The text a regular expression matches.",
    SQL_SERVER_2025,
  ],
  [
    "REGEXP_INSTR",
    "string, pattern, start?, occurrence?, return_option?, flags?, group? -> integer",
    "Where a regular expression matches, from 1; 0 when it does not.",
    SQL_SERVER_2025,
  ],
  [
    "REGEXP_COUNT",
    "string, pattern, start?, flags? -> integer",
    "How many times a regular expression matches.",
    SQL_SERVER_2025,
  ],
  [
    "REGEXP_MATCHES",
    "string, pattern, flags? -> table",
    "A row for each regular expression match, with its groups.",
    SQL_SERVER_2025,
  ],
  [
    "REGEXP_SPLIT_TO_TABLE",
    "string, pattern, flags? -> table",
    "A row for each piece of the string between regular expression matches.",
    SQL_SERVER_2025,
  ],
  ["COLLATIONPROPERTY", "collation, property -> any", "A property of a collation, such as its code page."],
  ["TERTIARY_WEIGHTS", "expression -> varbinary", "The tertiary sort weights of a string under a SQL collation."],
]);
