import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";
import { FROM_23 } from "./ranges.js";

const ON_ERROR = "DEFAULT fallback ON CONVERSION ERROR";

/**
 * Conversion, comparison, NULL-related and encoding functions, summarised in our own words from
 * https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/Single-Row-Functions.html and
 * https://docs.oracle.com/en/database/oracle/oracle-database/23/sqlrf/Single-Row-Functions.html.
 */
export const CONVERSION_FUNCTIONS: readonly FunctionSpec[] = functionSpecs("control", [
  ["BIN_TO_NUM", "bit... -> number", "The number the bits spell, the first being the most significant."],
  [
    "CAST",
    [
      "expr AS type -> type",
      `expr AS type ${ON_ERROR}, format?, nlsparam? -> type`,
      "MULTISET(subquery) AS type -> collection",
    ],
    "A value converted to another type, with a fallback when it cannot be; or a subquery's rows as a collection.",
  ],
  ["CHARTOROWID", "str -> rowid", "A ROWID written as text read back into a ROWID."],
  ["COALESCE", "expr... -> any", "The first argument that is not null."],
  [
    "CONVERT",
    "str, to_charset, from_charset? -> string",
    "A string converted from one character set to another; characters with no match become a replacement.",
  ],
  [
    "DECODE",
    "expr, search, result, more..., default? -> any",
    "The result paired with the first search equal to expr, treating two nulls as equal; default otherwise.",
  ],
  [
    "DUMP",
    "expr, format?, start?, length? -> string",
    "The type code, length and internal bytes of a value, in decimal, octal or hexadecimal.",
  ],
  ["GREATEST", "expr... -> any", "The largest argument, compared in the first one's type; null if any is null."],
  ["HEXTORAW", "hex -> raw", "Hexadecimal text read as a RAW value."],
  ["LEAST", "expr... -> any", "The smallest argument, compared in the first one's type; null if any is null."],
  [
    "LNNVL",
    "condition -> boolean",
    "True when a condition is false or unknown, for use in WHERE where the column may be null.",
  ],
  ["NULLIF", "a, b -> any", "Null when the two are equal, else the first."],
  ["NVL", "expr, fallback -> any", "fallback when expr is null, else expr."],
  ["NVL2", "expr, if_not_null, if_null -> any", "The second argument when expr is not null, else the third."],
  [
    "ORA_HASH",
    "expr, max_bucket?, seed? -> number",
    "A hash bucket number for a value, from 0 to max_bucket, for sampling or partitioning rows.",
  ],
  ["RAWTOHEX", "raw -> string", "A RAW value as hexadecimal text."],
  ["RAWTONHEX", "raw -> string", "A RAW value as hexadecimal text in the national character set."],
  ["ROWIDTOCHAR", "rowid -> string", "A ROWID as 18 characters of text."],
  ["ROWIDTONCHAR", "rowid -> string", "A ROWID as text in the national character set."],
  [
    "STANDARD_HASH",
    "expr, method? -> raw",
    "A SHA1, SHA224, SHA256, SHA384, SHA512 or MD5 digest of a value; SHA1 by default.",
  ],
  [
    "TO_BINARY_DOUBLE",
    ["expr, format?, nlsparam? -> number", `expr ${ON_ERROR}, format?, nlsparam? -> number`],
    "A value as a double-precision float.",
  ],
  [
    "TO_BINARY_FLOAT",
    ["expr, format?, nlsparam? -> number", `expr ${ON_ERROR}, format?, nlsparam? -> number`],
    "A value as a single-precision float.",
  ],
  ["TO_BLOB", ["raw -> blob", "bfile, mime_type? -> blob"], "A RAW value or a BFILE's contents as a BLOB."],
  [
    "TO_BOOLEAN",
    ["expr -> boolean", `expr ${ON_ERROR} -> boolean`],
    "Text such as 'yes' or 'false', or a number, as a BOOLEAN.",
    FROM_23,
  ],
  [
    "TO_CHAR",
    [
      "datetime, format?, nlsparam? -> string",
      "n, format?, nlsparam? -> string",
      "text -> string",
      "lob, charset? -> string",
      "boolean -> string",
    ],
    "A date, number, LOB or boolean as text, in a format model such as 'YYYY-MM-DD' or '999G990D00'.",
  ],
  ["TO_CLOB", ["text -> clob", "lob, charset?, mime_type? -> clob"], "Text, a BLOB or a BFILE's contents as a CLOB."],
  [
    "TO_DATE",
    ["text, format?, nlsparam? -> date", `text ${ON_ERROR}, format?, nlsparam? -> date`],
    "Text read as a DATE through a format model such as 'YYYY-MM-DD HH24:MI:SS'.",
  ],
  [
    "TO_DSINTERVAL",
    ["text -> interval", `text ${ON_ERROR} -> interval`],
    "Text such as '2 10:30:00' or 'P2DT10H30M' as an INTERVAL DAY TO SECOND.",
  ],
  ["TO_LOB", "long_column -> clob", "A LONG or LONG RAW column as a LOB, in INSERT ... SELECT or CREATE TABLE AS."],
  ["TO_MULTI_BYTE", "str -> string", "Single-byte characters swapped for their multibyte equivalents."],
  [
    "TO_NCHAR",
    [
      "datetime, format?, nlsparam? -> string",
      "n, format?, nlsparam? -> string",
      "text -> string",
      "boolean -> string",
    ],
    "TO_CHAR, giving text in the national character set.",
  ],
  ["TO_NCLOB", "text -> clob", "Text or a CLOB as an NCLOB."],
  [
    "TO_NUMBER",
    ["expr, format?, nlsparam? -> number", `expr ${ON_ERROR}, format?, nlsparam? -> number`],
    "Text read as a NUMBER through an optional format model.",
  ],
  ["TO_SINGLE_BYTE", "str -> string", "Multibyte characters swapped for their single-byte equivalents."],
  [
    "TO_TIMESTAMP",
    ["text, format?, nlsparam? -> timestamp", `text ${ON_ERROR}, format?, nlsparam? -> timestamp`],
    "Text read as a TIMESTAMP through a format model.",
  ],
  [
    "TO_TIMESTAMP_TZ",
    ["text, format?, nlsparam? -> timestamp", `text ${ON_ERROR}, format?, nlsparam? -> timestamp`],
    "Text read as a TIMESTAMP WITH TIME ZONE through a format model.",
  ],
  [
    "TO_UTC_TIMESTAMP_TZ",
    "iso_text -> timestamp",
    "An ISO 8601 date or timestamp as a TIMESTAMP WITH TIME ZONE in UTC.",
  ],
  [
    "TO_YMINTERVAL",
    ["text -> interval", `text ${ON_ERROR} -> interval`],
    "Text such as '1-6' or 'P1Y6M' as an INTERVAL YEAR TO MONTH.",
  ],
  [
    "TREAT",
    "expr AS type -> object",
    "An object read as one of its subtypes, or null when it is not one; REF before the type gives a REF.",
  ],
  [
    "VALIDATE_CONVERSION",
    "expr AS type, format?, nlsparam? -> number",
    "1 when the value would convert to the type, 0 when it would fail.",
  ],
  ["VSIZE", "expr -> number", "How many bytes the value takes inside the database."],
]);
