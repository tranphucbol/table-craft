import { functionSpecs, type FunctionSpec } from "@table-craft/plugin-api/sql";

/**
 * Members of the UTL_ supplied packages for bytes, encodings, fuzzy matching and character sets,
 * summarised in our own words from https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/
 * (one page per package, such as UTL_RAW.html).
 */
export const UTL_FUNCTIONS: readonly FunctionSpec[] = [
  ...functionSpecs("misc", [
    ["UTL_RAW.BIT_AND", "a, b -> raw", "The bitwise AND of two RAW values."],
    ["UTL_RAW.BIT_COMPLEMENT", "r -> raw", "Every bit of a RAW value flipped."],
    ["UTL_RAW.BIT_OR", "a, b -> raw", "The bitwise OR of two RAW values."],
    ["UTL_RAW.BIT_XOR", "a, b -> raw", "The bitwise XOR of two RAW values."],
    [
      "UTL_RAW.CAST_FROM_BINARY_INTEGER",
      "n, endianness? -> raw",
      "A PLS_INTEGER as four bytes in big, little or machine order.",
    ],
    ["UTL_RAW.CAST_FROM_NUMBER", "n -> raw", "A NUMBER's internal bytes."],
    [
      "UTL_RAW.CAST_TO_BINARY_INTEGER",
      "r, endianness? -> number",
      "Four bytes read as a PLS_INTEGER in big, little or machine order.",
    ],
    ["UTL_RAW.CAST_TO_NUMBER", "r -> number", "A NUMBER's internal bytes read back."],
    ["UTL_RAW.CAST_TO_NVARCHAR2", "r -> string", "Bytes read as text in the national character set, unchanged."],
    ["UTL_RAW.CAST_TO_RAW", "text -> raw", "Text's bytes as RAW, unchanged."],
    ["UTL_RAW.CAST_TO_VARCHAR2", "r -> string", "Bytes read as text in the database character set, unchanged."],
    [
      "UTL_RAW.COMPARE",
      "a, b, pad? -> number",
      "0 when two RAW values match, else where the first difference is, from 1.",
    ],
    ["UTL_RAW.CONCAT", "r... -> raw", "Up to twelve RAW values joined."],
    ["UTL_RAW.CONVERT", "r, to_charset, from_charset -> raw", "Text bytes converted between two character sets."],
    ["UTL_RAW.LENGTH", "r -> number", "How many bytes a RAW value has."],
    ["UTL_RAW.REVERSE", "r -> raw", "A RAW value's bytes in reverse order."],
    ["UTL_RAW.SUBSTR", "r, position, length? -> raw", "Part of a RAW value from a byte position."],
    [
      "UTL_RAW.TRANSLATE",
      "r, from_set, to_set -> raw",
      "Each byte of from_set replaced by the one at its place in to_set.",
    ],
    ["UTL_RAW.XRANGE", "start?, end? -> raw", "Every byte value from start to end."],
  ]),
  ...functionSpecs("misc", [
    ["UTL_ENCODE.BASE64_DECODE", "r -> raw", "Base-64 bytes decoded."],
    [
      "UTL_ENCODE.BASE64_ENCODE",
      "r -> raw",
      "Bytes encoded in base 64, as RAW; wrap with UTL_RAW.CAST_TO_VARCHAR2 for text.",
    ],
    ["UTL_ENCODE.MIMEHEADER_DECODE", "text -> string", "A MIME header value decoded."],
    [
      "UTL_ENCODE.MIMEHEADER_ENCODE",
      "text, charset?, encoding? -> string",
      "Text encoded for a MIME header, in base 64 or quoted-printable.",
    ],
    ["UTL_ENCODE.QUOTED_PRINTABLE_DECODE", "r -> raw", "Quoted-printable bytes decoded."],
    ["UTL_ENCODE.QUOTED_PRINTABLE_ENCODE", "r -> raw", "Bytes encoded as quoted-printable."],
    ["UTL_ENCODE.TEXT_DECODE", "text, charset?, encoding? -> string", "Text decoded from base 64 or quoted-printable."],
    ["UTL_ENCODE.TEXT_ENCODE", "text, charset?, encoding? -> string", "Text encoded in base 64 or quoted-printable."],
    ["UTL_ENCODE.UUDECODE", "r -> raw", "Uuencoded bytes decoded."],
    ["UTL_ENCODE.UUENCODE", "r, type?, filename?, permission? -> raw", "Bytes uuencoded."],
  ]),
  ...functionSpecs("string", [
    ["UTL_MATCH.EDIT_DISTANCE", "a, b -> number", "The Levenshtein distance between two strings."],
    [
      "UTL_MATCH.EDIT_DISTANCE_SIMILARITY",
      "a, b -> number",
      "How alike two strings are by edit distance, from 0 to 100.",
    ],
    ["UTL_MATCH.JARO_WINKLER", "a, b -> number", "The Jaro-Winkler similarity of two strings, from 0 to 1."],
    [
      "UTL_MATCH.JARO_WINKLER_SIMILARITY",
      "a, b -> number",
      "The Jaro-Winkler similarity of two strings, from 0 to 100.",
    ],
  ]),
  ...functionSpecs("string", [
    [
      "UTL_I18N.ESCAPE_REFERENCE",
      "text, charset? -> string",
      "Characters outside a character set written as XML or HTML references.",
    ],
    [
      "UTL_I18N.GET_DEFAULT_CHARSET",
      "language, context?, windows? -> string",
      "The usual character set for a language, for mail or web content.",
    ],
    [
      "UTL_I18N.MAP_CHARSET",
      "charset, context?, flag? -> string",
      "A character set name mapped between Oracle and IANA naming.",
    ],
    ["UTL_I18N.RAW_TO_CHAR", "data, charset? -> string", "Bytes in a character set read as database text."],
    ["UTL_I18N.STRING_TO_RAW", "text, charset? -> raw", "Text encoded in a character set, as RAW."],
    ["UTL_I18N.TRANSLITERATE", "text, name -> string", "Text converted between Japanese scripts, such as kana forms."],
    ["UTL_I18N.UNESCAPE_REFERENCE", "text -> string", "XML or HTML character references read back into characters."],
    [
      "UTL_I18N.VALIDATE_CHARACTER_ENCODING",
      "text -> number",
      "Where text first breaks its character encoding; 0 when it is valid.",
    ],
  ]),
];
