import {
  defaultKeyword,
  defaultValuesInsert,
  quoteIdentifierWith,
  sqlLiteral,
  type SqlLiteralOptions,
} from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";

const STANDARD: SqlLiteralOptions = { backslashEscapes: false, bytes: (hex) => `'\\x${hex}'::bytea` };
const MYSQL: SqlLiteralOptions = { backslashEscapes: true, bytes: (hex) => `X'${hex}'` };

describe("sql literals", () => {
  it("givenQuoteInsideName_whenQuoted_thenDoubled", () => {
    expect(quoteIdentifierWith('"')('a"b')).toBe('"a""b"');
    expect(quoteIdentifierWith("`")("a`b")).toBe("`a``b`");
  });

  it("givenBracketQuote_whenNameHasBracket_thenDoubled", () => {
    expect(quoteIdentifierWith("[")("a]b[c")).toBe("[a]]b[c]");
  });

  it("givenNationalText_whenLiteral_thenNPrefixOnlyBeyondAscii", () => {
    const national: SqlLiteralOptions = { ...STANDARD, nationalText: true };
    expect(sqlLiteral("thành phố", national)).toBe("N'thành phố'");
    expect(sqlLiteral("plain", national)).toBe("'plain'");
    expect(sqlLiteral({ kind: "json", text: '{"a": "€"}' }, national)).toBe(`N'{"a": "€"}'`);
    expect(sqlLiteral("thành phố", STANDARD)).toBe("'thành phố'");
  });

  it("givenQuoteAndBackslash_whenStandardLiteral_thenOnlyQuoteDoubled", () => {
    expect(sqlLiteral("it's \\n", STANDARD)).toBe("'it''s \\n'");
  });

  it("givenQuoteAndBackslash_whenMysqlLiteral_thenBackslashEscaped", () => {
    expect(sqlLiteral("it's \\\n", MYSQL)).toBe("'it\\'s \\\\\\n'");
  });

  it("givenTaggedValues_whenLiteral_thenDialectSpelling", () => {
    expect(sqlLiteral(null, STANDARD)).toBe("NULL");
    expect(sqlLiteral(true, STANDARD)).toBe("TRUE");
    expect(sqlLiteral(1.5, STANDARD)).toBe("1.5");
    expect(sqlLiteral({ kind: "bigint", value: "9007199254740993" }, STANDARD)).toBe("9007199254740993");
    expect(sqlLiteral({ kind: "json", text: '{"a": 1}' }, STANDARD)).toBe(`'{"a": 1}'`);
    expect(sqlLiteral({ kind: "bytes", preview: "dead", length: 2 }, STANDARD)).toBe("'\\xdead'::bytea");
    expect(sqlLiteral({ kind: "bytes", preview: "dead", length: 2 }, MYSQL)).toBe("X'dead'");
  });

  it("givenBytesLongerThanPreview_whenLiteral_thenClippedWithComment", () => {
    expect(sqlLiteral({ kind: "bytes", preview: "dead", length: 2048 }, MYSQL)).toBe("X'dead' /* 2 of 2048 bytes */");
  });

  it("givenQualifiedTable_whenDefaultValuesInsert_thenStandardForm", () => {
    expect(defaultValuesInsert('"public"."t"')).toBe('INSERT INTO "public"."t" DEFAULT VALUES');
    expect(defaultKeyword()).toBe("DEFAULT");
  });
});
