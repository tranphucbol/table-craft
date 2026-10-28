import type { SignatureHelp } from "@table-craft/plugin-api";
import {
  functionItem,
  functionSpecs,
  parseSignature,
  quoteIdentifierWith,
  signatureLabel,
  SQL_FUNCTIONS,
  SQL_KEYWORDS,
  sqlCompleter,
} from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";
import { fakeCatalog, fixtureRelations, PUBLIC, relation } from "../support/completionCatalog.js";

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
    ["EXTRACT", "unit FROM date -> integer", "One part of a date."],
    ["SYSDATE", "= date", "The current date, written without parentheses."],
  ]),
  ...functionSpecs("string", [["CHAR", "code... USING charset -> string", "A string from character codes."]]),
  ...functionSpecs("misc", [
    ["DBMS_OUTPUT.PUT_LINE", "line ->", "Writes a line to the output buffer."],
    ["DBMS_LOB.SUBSTR", "lob, amount?, offset? -> string", "Part of a large object."],
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

function spec(name: string) {
  const found = FUNCTIONS.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`The test list has no ${name}.`);
  return found;
}

async function completeAt(marked: string, catalog = fakeCatalog()) {
  const offset = marked.indexOf(CARET);
  return (await mysql.complete({ text: marked.replace(CARET, ""), offset }, catalog)).items;
}

describe("function call shapes", () => {
  it("givenBareSpec_whenItem_thenNameOnlyCaretAtEnd", () => {
    const sysdate = spec("SYSDATE");

    expect(sysdate.bare).toBe(true);
    expect(functionItem(sysdate, 0)).toMatchObject({
      label: "sysdate",
      apply: "sysdate",
      caret: null,
      detail: "→ date",
    });
    expect(functionItem(sysdate, 0).info).toContain("sysdate → date");
  });

  it("givenBareAndCalledSignatures_whenRead_thenThrows", () => {
    expect(() => functionSpecs("misc", [["MIXED", ["= date", "x -> date"], "Both."]])).toThrow(/-> type/);
  });

  it("givenBareSpec_whenCallAt_thenNull", async () => {
    expect(await signature("SELECT sysdate(|")).toBeNull();
  });

  it("givenLeadSignature_whenParsed_thenLeadOnParameter", () => {
    expect(parseSignature("unit FROM date -> integer").parameters).toEqual([
      { name: "unit" },
      { name: "date", lead: "FROM" },
    ]);
    expect(parseSignature("BOTH|LEADING|TRAILING remove FROM str -> string").parameters).toEqual([
      { name: "remove", lead: "BOTH|LEADING|TRAILING" },
      { name: "str", lead: "FROM" },
    ]);
    expect(parseSignature("DATE|TIME, region -> string").parameters).toEqual([
      { name: "DATE|TIME" },
      { name: "region" },
    ]);
    expect(parseSignature("date, INTERVAL expr unit -> date").parameters).toEqual([
      { name: "date" },
      { name: "INTERVAL expr unit" },
    ]);
    expect(signatureLabel(parseSignature("doc, path RETURNING type? -> value"))).toBe(
      "(doc, path [RETURNING type]) → value",
    );
    expect(signatureLabel(parseSignature("unit FROM date -> integer"))).toBe("(unit FROM date) → integer");
  });

  it("givenProcedureSignature_whenLabelled_thenNoArrow", () => {
    expect(signatureLabel(parseSignature("line ->"))).toBe("(line)");
  });

  it("givenExtractYearFrom_whenSignatureAt_thenArgumentOne", async () => {
    expect(await signature("SELECT extract(|")).toMatchObject({ name: "extract", argument: 0 });
    expect(await signature("SELECT extract(YEAR FROM |)")).toMatchObject({ name: "extract", argument: 1 });
    expect(await signature("SELECT extract(year from |)")).toMatchObject({ argument: 1 });
  });

  it("givenCastAsDecimalWithPrecision_whenSignatureAt_thenArgumentOne", async () => {
    expect(await signature("SELECT cast(x AS |)")).toMatchObject({ name: "cast", argument: 1 });
    expect(await signature("SELECT cast(x AS DECIMAL(10, 2)|)")).toMatchObject({ name: "cast", argument: 1 });
  });

  it("givenUnknownWordInCall_whenSignatureAt_thenArgumentUnchanged", async () => {
    expect(await signature("SELECT extract(YEAR_MONTH |")).toMatchObject({ argument: 0 });
    expect(await signature("SELECT substr(name, 1 + LENGTH |")).toMatchObject({ argument: 1 });
  });

  it("givenVariadicBeforeLead_whenCommas_thenStaysOnVariadic", async () => {
    expect(await signature("SELECT char(77, 121, |")).toMatchObject({ argument: 0 });
    expect(await signature("SELECT char(77, 121 USING |")).toMatchObject({ argument: 1 });
  });

  it("givenQualifiedSpec_whenCallAt_thenJoinedName", async () => {
    const text = "BEGIN dbms_output.put_line(|); END";
    expect(await signature(text)).toMatchObject({ name: "dbms_output.put_line", argument: 0, from: 6 });
    expect(await signature("SELECT dbms_lob.substr(doc, |")).toMatchObject({ name: "dbms_lob.substr", argument: 1 });
    expect(await signature("CALL dbms_output.put_line(|")).toMatchObject({ name: "dbms_output.put_line" });
    expect(await signature("SELECT put_line(|")).toBeNull();
    expect(await signature("SELECT other.put_line(|")).toBeNull();
  });

  it("givenQualifiedSpec_whenCompleteAfterPackageDot_thenMembers", async () => {
    const items = await completeAt("SELECT dbms_output.|");

    expect(items.map((item) => item.label)).toEqual(["put_line"]);
    expect(items[0]).toMatchObject({
      kind: "function",
      apply: "put_line()",
      caret: "put_line(".length,
      detail: "(line)",
    });
    expect(items[0]?.info).toContain("dbms_output.put_line(line)");
    expect((await completeAt("SELECT dbms_|")).map((item) => item.label)).not.toContain("dbms_output.put_line");
  });

  it("givenTableNamedLikePackage_whenCompleteAfterDot_thenColumnsFirst", async () => {
    const relations = fixtureRelations();
    relations.set(JSON.stringify(PUBLIC), [
      ...(relations.get(JSON.stringify(PUBLIC)) ?? []),
      relation("dbms_lob", [["id", "integer"]]),
    ]);
    const items = await completeAt("SELECT dbms_lob.| FROM dbms_lob", fakeCatalog(relations));

    expect(items.map((item) => [item.kind, item.label])).toEqual([
      ["column", "id"],
      ["function", "substr"],
    ]);
  });
});

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
