import type { SignatureHelp } from "@table-craft/plugin-api";
import {
  functionSpecs,
  quoteIdentifierWith,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  sqlCompleter,
} from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";
import { fakeCatalog, PUBLIC } from "../support/completionCatalog.js";

const FUNCTIONS = [
  ...SQL_FUNCTIONS,
  ...functionSpecs("string", [
    ["CONCAT", "str... -> string", "Joins the strings."],
    ["LEFT", "str, len -> string", "The first characters."],
  ]),
  ...functionSpecs("misc", [["VALUES", "column -> value", "The value an upsert would have inserted."]]),
  ...functionSpecs("datetime", [
    ["NOW", "-> datetime", "The current time."],
    ["OLD_ONLY", "-> integer", "Exists only before 8.0.", { mysql: "<8.0" }],
  ]),
];

const mysql = sqlCompleter({
  dialect: { backslashEscapes: true, hashComments: true },
  identifierFolding: "none",
  plainIdentifier: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  quoteIdentifier: quoteIdentifierWith("`"),
  keywords: [...SQL_KEYWORDS, "LEFT", "VALUES"],
  functions: FUNCTIONS,
  server: (version) => {
    const [major = 0, minor = 0] = version.split(".").map(Number);
    return { flavour: "mysql", version: [major, minor] };
  },
});

const CARET = "|";

function signature(marked: string, serverVersion: string | null = null): Promise<SignatureHelp | null> {
  const offset = marked.indexOf(CARET);
  return mysql.signatureAt({ text: marked.replace(CARET, ""), offset }, fakeCatalog(undefined, PUBLIC, serverVersion));
}

describe("sqlCompleter.signatureAt", () => {
  it("givenOpenCall_whenAsking_thenFirstArgumentAndSpan", async () => {
    const help = await signature("SELECT upper(|");

    expect(help).toMatchObject({ name: "upper", argument: 0, from: 7, to: 13 });
    expect(help?.summary).toBe("The string in upper case.");
    expect(help?.signatures[0]?.parameters.map((parameter) => parameter.name)).toEqual(["str"]);
  });

  it("givenClosedCall_whenAsking_thenSpanEndsAtTheCloseParen", async () => {
    expect(await signature("SELECT substr(name, |2) FROM t")).toMatchObject({
      name: "substr",
      argument: 1,
      from: 7,
      to: 22,
    });
  });

  it("givenNestedCall_whenCaretInInnerArgs_thenInnerSignature", async () => {
    expect(await signature("SELECT upper(concat(a, |))")).toMatchObject({ name: "concat", argument: 1 });
    expect(await signature("SELECT upper(concat(a, b), |)")).toMatchObject({ name: "upper", argument: 1 });
  });

  it("givenCommasInStringsCommentsAndQuotedNames_whenAsking_thenNotCounted", async () => {
    expect(await signature("SELECT concat('a,b', `x,y`, /* , */ |")).toMatchObject({ argument: 2 });
    expect(await signature("SELECT concat(a, # , \n|")).toMatchObject({ argument: 1 });
  });

  it("givenCaretInStringOrComment_whenAsking_thenNull", async () => {
    expect(await signature("SELECT upper('a|")).toBeNull();
    expect(await signature("SELECT upper(/* a| */")).toBeNull();
  });

  it("givenGroupingParentheses_whenAsking_thenLookedThrough", async () => {
    expect(await signature("SELECT substr(name, (1 + |")).toMatchObject({ name: "substr", argument: 1 });
  });

  it("givenSubqueryInsideCall_whenAsking_thenNull", async () => {
    expect(await signature("SELECT upper((SELECT |")).toBeNull();
  });

  it("givenOverloads_whenAsking_thenEverySignature", async () => {
    const help = await signature("SELECT count(|");

    expect(help?.signatures.map((overload) => overload.parameters.map((parameter) => parameter.name))).toEqual([
      ["*"],
      ["expr"],
    ]);
  });

  it("givenNoCall_whenAsking_thenNull", async () => {
    expect(await signature("SELECT name|")).toBeNull();
    expect(await signature("SELECT upper(name) |")).toBeNull();
  });

  it("givenNonFunctionNameBeforeParen_whenAsking_thenNull", async () => {
    expect(await signature("SELECT * FROM t WHERE id IN (|")).toBeNull();
    expect(await signature("INSERT INTO t (a) VALUES (|")).toBeNull();
    expect(await signature("CREATE TABLE t (|")).toBeNull();
    expect(await signature("CREATE TABLE upper (|")).toBeNull();
    expect(await signature("SELECT unknown_fn(|")).toBeNull();
    expect(await signature("SELECT t.upper(|")).toBeNull();
  });

  it("givenKeywordNamedFunction_whenOperandFits_thenACall", async () => {
    expect(await signature("SELECT left(name, |")).toMatchObject({ name: "left", argument: 1 });
    expect(await signature("INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = values(|")).toMatchObject({
      name: "values",
    });
  });

  it("givenServerVersion_whenFunctionOutOfRange_thenNull", async () => {
    expect(await signature("SELECT old_only(|", "8.4.0")).toBeNull();
    expect(await signature("SELECT old_only(|", "5.7.44")).toMatchObject({ name: "old_only" });
  });

  it("givenSecondStatement_whenAsking_thenOffsetsInTheWholeText", async () => {
    expect(await signature("SELECT 1;\nSELECT upper(|")).toMatchObject({ name: "upper", from: 17 });
  });

  it("givenScope_whenAsking_thenOffsetsInTheFilterText", async () => {
    const help = await mysql.signatureAt(
      { text: "upper(name) = ", offset: 6, scope: { path: PUBLIC, relation: "orders" } },
      fakeCatalog(),
    );

    expect(help).toMatchObject({ name: "upper", argument: 0, from: 0, to: 11 });
  });
});
