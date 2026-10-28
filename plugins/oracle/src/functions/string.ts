import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";

/**
 * Character, character set, collation and regular expression functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Single-Row-Functions.html.
 */
export const STRING_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("string", [
  ["ASCII", "char -> number", "The code, in the database character set, of the first character."],
  [
    "ASCIISTR",
    "str -> string",
    "The string in ASCII, with every other character written as \\xxxx, its UTF-16 code unit in hexadecimal.",
  ],
  [
    "CHR",
    ["n -> string", "n USING NCHAR_CS -> string"],
    "The character with the given code in the database or national character set.",
  ],
  ["COLLATION", "expr -> string", "The name of the collation a character expression derives."],
  ["COMPOSE", "str -> string", "The string in Unicode composed normal form (NFC)."],
  ["CONCAT", "a, b -> string", "Joins two strings; || joins more."],
  ["DECOMPOSE", "str, CANONICAL|COMPATIBILITY? -> string", "The string in Unicode decomposed normal form."],
  ["INITCAP", "str -> string", "Every word with its first letter upper case and the rest lower case."],
  [
    "INSTR",
    "str, substr, position?, occurrence? -> number",
    "Where a substring appears, from 1; a negative position searches back from the end. 0 when absent.",
  ],
  ["LENGTH", "str -> number", "How many characters the string has; null, not 0, for an empty string."],
  ["LOWER", "str -> string", "The string in lower case."],
  [
    "LPAD",
    "str, length, pad? -> string",
    "The string padded on the left, with spaces by default, or cut, to a length.",
  ],
  ["LTRIM", "str, set? -> string", "The string with every leading character found in set (spaces by default) removed."],
  ["NCHR", "n -> string", "The character with the given code in the national character set."],
  [
    "NLS_CHARSET_DECL_LEN",
    "bytes, charset_id -> number",
    "How many characters an NCHAR column of the given byte width holds.",
  ],
  ["NLS_CHARSET_ID", "name -> number", "The id of a character set name."],
  ["NLS_CHARSET_NAME", "id -> string", "The name of a character set id."],
  ["NLS_COLLATION_ID", "name -> number", "The id of a collation name."],
  ["NLS_COLLATION_NAME", "id, flag? -> string", "The name of a collation id, in short or long form."],
  ["NLS_INITCAP", "str, nlsparam? -> string", "INITCAP following a linguistic sort's casing rules."],
  ["NLS_LOWER", "str, nlsparam? -> string", "LOWER following a linguistic sort's casing rules."],
  ["NLS_UPPER", "str, nlsparam? -> string", "UPPER following a linguistic sort's casing rules."],
  ["NLSSORT", "str, nlsparam? -> raw", "The sort key of a string under a linguistic sort, for comparing or ordering."],
  [
    "REGEXP_COUNT",
    "str, pattern, position?, match? -> number",
    "How many times a regular expression matches, from a position.",
  ],
  [
    "REGEXP_INSTR",
    "str, pattern, position?, occurrence?, return?, match?, group? -> number",
    "Where a regular expression's nth match starts, or ends after when return is 1.",
  ],
  [
    "REGEXP_REPLACE",
    "str, pattern, replacement?, position?, occurrence?, match? -> string",
    "The string with matches of a regular expression replaced; \\n names a group. Every match when occurrence is 0.",
  ],
  [
    "REGEXP_SUBSTR",
    "str, pattern, position?, occurrence?, match?, group? -> string",
    "The text of a regular expression's nth match, or of one of its groups.",
  ],
  [
    "REPLACE",
    "str, search, replacement? -> string",
    "The string with every occurrence of search replaced, or removed.",
  ],
  [
    "RPAD",
    "str, length, pad? -> string",
    "The string padded on the right, with spaces by default, or cut, to a length.",
  ],
  [
    "RTRIM",
    "str, set? -> string",
    "The string with every trailing character found in set (spaces by default) removed.",
  ],
  ["SOUNDEX", "str -> string", "A four-character code of how an English word sounds, for matching similar names."],
  [
    "SUBSTR",
    "str, position, length? -> string",
    "Part of a string from a position (1 is the first; negative counts from the end); SUBSTRB, SUBSTRC, SUBSTR2 and SUBSTR4 count other units.",
  ],
  [
    "TRANSLATE",
    ["str, from, to -> string", "str USING CHAR_CS|NCHAR_CS -> string"],
    "Replaces each character of from with the one at the same place in to, dropping those without one; or converts text to the database or national character set.",
  ],
  [
    "TRIM",
    ["str -> string", "remove FROM str -> string", "BOTH|LEADING|TRAILING remove? FROM str -> string"],
    "The string with a character removed from its start, end or both; spaces by default.",
  ],
  ["UNISTR", "str -> string", "Reads \\xxxx escapes of UTF-16 code units in a string into the characters they name."],
  ["UPPER", "str -> string", "The string in upper case."],
]);
