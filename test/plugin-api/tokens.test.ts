import { describe, expect, it } from "vitest";
import { significantTokens, type SqlDialectOptions } from "@table-craft/plugin-api/sql/tokens.js";

const TSQL: SqlDialectOptions = { bracketIdentifiers: true, nationalStrings: true };
const ORACLE: SqlDialectOptions = { qQuotes: true, nationalStrings: true };

function lexed(text: string, options: SqlDialectOptions): [string, string][] {
  return significantTokens(text, options).map((token) => [token.kind, text.slice(token.from, token.to)]);
}

describe("lexer: decision 100 options", () => {
  it("givenNationalString_whenLexed_thenString", () => {
    expect(lexed("SELECT N'a''b', n'c'", TSQL)).toEqual([
      ["word", "SELECT"],
      ["string", "N'a''b'"],
      ["symbol", ","],
      ["string", "n'c'"],
    ]);
    expect(lexed("SELECT N'a'", {})).toEqual([
      ["word", "SELECT"],
      ["word", "N"],
      ["string", "'a'"],
    ]);
  });

  it("givenBracketIdentifier_whenLexed_thenQuotedWithDoubledClose", () => {
    expect(lexed("[a]]b] [c", TSQL)).toEqual([
      ["quoted", "[a]]b]"],
      ["quoted", "[c"],
    ]);
  });

  it("givenQQuotes_whenLexed_thenOneStringPerDelimiterPair", () => {
    expect(lexed("q'(a')b)' Q'<x>' nq'#y#' q' z'", ORACLE)).toEqual([
      ["string", "q'(a')b)'"],
      ["string", "Q'<x>'"],
      ["string", "nq'#y#'"],
      ["word", "q"],
      ["string", "' z'"],
    ]);
  });
});
