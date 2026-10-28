import type { CompletionItem, SqlLanguage } from "@table-craft/plugin-api";
import { isAvailable } from "@table-craft/plugin-api/sql";
import mysql from "@table-craft/plugin-mysql";
import { MYSQL_FUNCTIONS } from "@table-craft/plugin-mysql/functions";
import { serverIdentity } from "@table-craft/plugin-mysql/server";
import { describe, expect, it } from "vitest";
import { fakeCatalog, fixtureRelations, PUBLIC } from "../support/completionCatalog.js";

const MYSQL_8_4 = "8.4.3";
const MYSQL_5_7 = "5.7.44-log";
const TIDB_4 = "5.7.25-TiDB-v4.0.14";
const TIDB_7_5 = "8.0.11-TiDB-v7.5.1";

/** Absent from TiDB 4.0.14: missing from its manual and answering "does not exist" there. */
const NOT_IN_TIDB_4 = ["LOAD_FILE", "SOUNDEX", "UUID_SHORT", "JSON_TABLE", "REGEXP_LIKE", "CHARSET", "GET_LOCK"];

const language: SqlLanguage = (() => {
  if (mysql.language === undefined) throw new Error("The MySQL plugin has no language.");
  return mysql.language;
})();

function namesOn(version: string | null): Set<string> {
  const server = version === null ? null : serverIdentity(version);
  return new Set(MYSQL_FUNCTIONS.filter((spec) => isAvailable(spec, server)).map((spec) => spec.name));
}

async function functionsOffered(text: string, version: string | null): Promise<CompletionItem[]> {
  const catalog = fakeCatalog(fixtureRelations(), undefined, version);
  const result = await language.complete({ text, offset: text.length }, catalog);
  return result.items.filter((item) => item.kind === "function");
}

describe("mysql function list", () => {
  it("givenEverySpec_whenRead_thenSummaryAndSignature", () => {
    for (const spec of MYSQL_FUNCTIONS) {
      expect(spec.summary.length, spec.name).toBeGreaterThan(0);
      expect(spec.signatures.length, spec.name).toBeGreaterThan(0);
      expect(spec.name, spec.name).toBe(spec.name.toUpperCase());
    }
  });

  it("givenTheList_whenNamesCounted_thenNoNameTwice", () => {
    const names = MYSQL_FUNCTIONS.map((spec) => spec.name);
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });

  it("givenMysql84_whenFiltered_thenNoRemovedFunctions", () => {
    const names = namesOn(MYSQL_8_4);
    for (const removed of ["PASSWORD", "ENCRYPT", "DES_ENCRYPT", "ENCODE", "DECODE"])
      expect(names).not.toContain(removed);
    for (const tidbOnly of ["TIDB_VERSION", "TIDB_PARSE_TSO", "TRANSLATE"]) expect(names).not.toContain(tidbOnly);
    expect(names).toContain("JSON_TABLE");
    expect(names).toContain("REGEXP_LIKE");
  });

  it("givenMysql57_whenFiltered_thenNoEightZeroFunctions", () => {
    const names = namesOn(MYSQL_5_7);
    expect(names).not.toContain("JSON_TABLE");
    expect(names).not.toContain("REGEXP_LIKE");
    expect(names).not.toContain("ROW_NUMBER");
    expect(names).toContain("PASSWORD");
    expect(names).toContain("JSON_ARRAYAGG");
  });

  it("givenTidb4_whenFiltered_thenTidbFunctionsAndNoUnsupported", () => {
    const names = namesOn(TIDB_4);
    expect(names).toContain("TIDB_PARSE_TSO");
    expect(names).toContain("TIDB_VERSION");
    expect(names).toContain("ROW_NUMBER");
    expect(names).not.toContain("TIDB_CURRENT_TSO");
    expect(names).not.toContain("ST_ASTEXT");
    for (const unsupported of NOT_IN_TIDB_4) expect(names).not.toContain(unsupported);
  });

  it("givenTidb75_whenFiltered_thenLaterTidbFunctions", () => {
    const names = namesOn(TIDB_7_5);
    expect(names).toContain("TIDB_CURRENT_TSO");
    expect(names).toContain("REGEXP_LIKE");
    expect(names).not.toContain("TIDB_MVCC_INFO");
    expect(names).not.toContain("JSON_TABLE");
  });

  it("givenUnknownServer_whenFiltered_thenUnionOfFlavours", () => {
    const names = namesOn(null);
    for (const name of ["PASSWORD", "JSON_TABLE", "TIDB_PARSE_TSO", "TIDB_MVCC_INFO", "ST_ASTEXT"]) {
      expect(names).toContain(name);
    }
    expect(names.size).toBe(MYSQL_FUNCTIONS.length);
  });
});

describe("mysql server identity", () => {
  it("givenMysqlVersion_whenRead_thenMysqlTriple", () => {
    expect(serverIdentity("8.4.3")).toEqual({ flavour: "mysql", version: [8, 4, 3] });
    expect(serverIdentity("5.7.44-log")).toEqual({ flavour: "mysql", version: [5, 7, 44] });
  });

  it("givenTidbVersion_whenRead_thenTidbRelease", () => {
    expect(serverIdentity(TIDB_4)).toEqual({ flavour: "tidb", version: [4, 0, 14] });
    expect(serverIdentity("8.0.11-TiDB-v7.5")).toEqual({ flavour: "tidb", version: [7, 5] });
  });

  it("givenUnreadableVersion_whenRead_thenNull", () => {
    expect(serverIdentity("unknown")).toBeNull();
  });
});

describe("mysql function completion", () => {
  it("givenMysql84_whenCompletingPassw_thenNoPassword", async () => {
    const labels = (await functionsOffered("SELECT passw", MYSQL_8_4)).map((item) => item.label);
    expect(labels).not.toContain("password");
  });

  it("givenTidb4_whenCompletingTidb_thenItsFunctionsWithSignatures", async () => {
    const items = await functionsOffered("SELECT tidb_", TIDB_4);
    const parse = items.find((item) => item.label === "tidb_parse_tso");
    expect(parse).toMatchObject({ apply: "tidb_parse_tso()", detail: "(tso) → datetime", caret: 15 });
    expect(items.map((item) => item.label)).toContain("tidb_version");
  });

  it("givenDateFormat_whenCompleting_thenSignatureAndInfo", async () => {
    const items = await functionsOffered("SELECT date_f", MYSQL_8_4);
    const item = items.find((candidate) => candidate.label === "date_format");
    expect(item?.detail).toBe("(date, format) → string");
    expect(item?.info).toContain("date_format(date, format) → string");
  });

  it("givenKeywordNamedFunctions_whenInSelect_thenEachOnceAsFunction", async () => {
    const catalog = fakeCatalog(fixtureRelations(), undefined, MYSQL_8_4);
    const text = "SELECT ";
    const { items } = await language.complete({ text, offset: text.length }, catalog);
    for (const name of ["if", "left", "right", "replace", "insert", "char", "database", "values", "mod", "truncate"]) {
      const matching = items.filter((item) => item.label.toLowerCase() === name);
      expect(
        matching.map((item) => item.kind),
        name,
      ).toEqual(["function"]);
    }
  });

  it("givenKeywordPosition_whenCompleting_thenKeywordKept", async () => {
    const catalog = fakeCatalog(fixtureRelations(), undefined, MYSQL_8_4);
    const text = "SELECT * FROM orders ";
    const { items } = await language.complete({ text, offset: text.length }, catalog);
    expect(items.find((item) => item.label === "LEFT")?.kind).toBe("keyword");
    expect(items.some((item) => item.kind === "function")).toBe(false);
  });

  it("givenColumnPrefix_whenCompleting_thenColumnsAboveFunctions", async () => {
    const catalog = fakeCatalog(fixtureRelations(), PUBLIC, MYSQL_8_4);
    const text = "SELECT c FROM orders";
    const offset = "SELECT c".length;
    const { items } = await language.complete({ text, offset }, catalog);
    const column = items.find((item) => item.kind === "column" && item.label === "customer_id");
    const ceil = items.find((item) => item.label === "ceil");
    expect(column).toBeDefined();
    expect(column?.boost).toBeGreaterThan(ceil?.boost ?? Number.POSITIVE_INFINITY);
  });

  it("givenTidbParseTso_whenAskingSignature_thenItsParameter", async () => {
    const catalog = fakeCatalog(fixtureRelations(), undefined, TIDB_4);
    const text = "SELECT tidb_parse_tso(";
    const help = await language.signatureAt?.({ text, offset: text.length }, catalog);
    expect(help).toMatchObject({ name: "tidb_parse_tso", argument: 0 });
    expect(help?.signatures[0]?.parameters.map((parameter) => parameter.name)).toEqual(["tso"]);
  });

  async function signatureOn(marked: string) {
    const offset = marked.indexOf("|");
    const catalog = fakeCatalog(fixtureRelations(), undefined, MYSQL_8_4);
    const help = await language.signatureAt?.({ text: marked.replace("|", ""), offset }, catalog);
    const parameters = help?.signatures[0]?.parameters ?? [];
    return { help, active: parameters[help?.argument ?? -1]?.name };
  }

  it("givenMysqlExtract_whenHintInDate_thenDateBold", async () => {
    expect((await signatureOn("SELECT extract(YEAR FROM |) FROM orders")).active).toBe("date");
    expect((await signatureOn("SELECT extract(YEAR|) FROM orders")).active).toBe("unit");
  });

  it("givenMysqlKeywordLedCalls_whenAsking_thenParameterAfterTheKeyword", async () => {
    expect((await signatureOn("SELECT cast(total AS |)")).active).toBe("type");
    expect((await signatureOn("SELECT position('a' IN |)")).active).toBe("str");
    expect((await signatureOn("SELECT trim(LEADING '0' FROM |)")).help?.argument).toBe(1);
    expect((await signatureOn("SELECT json_value(doc, '$.a' RETURNING |)")).help?.argument).toBe(2);
    const convert = await signatureOn("SELECT convert(name USING |)");
    expect(convert.help?.signatures[1]?.parameters[convert.help.argument]?.name).toBe("charset");
  });

  it("givenExtract_whenCompleting_thenDetailWithLead", async () => {
    const items = await functionsOffered("SELECT extr", MYSQL_8_4);
    expect(items.find((item) => item.label === "extract")?.detail).toBe("(unit FROM date) → integer");
  });
});
