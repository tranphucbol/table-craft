import type { CompletionItem, SqlLanguage } from "@table-craft/plugin-api";
import { isAvailable } from "@table-craft/plugin-api/sql";
import mssql from "@table-craft/plugin-mssql";
import { MANUAL_INDEX, MSSQL_FUNCTIONS, NOT_OFFERED } from "@table-craft/plugin-mssql/functions";
import { serverIdentity, serverVersionOf } from "@table-craft/plugin-mssql/server";
import { describe, expect, it } from "vitest";
import { fakeCatalog, fixtureRelations, PUBLIC } from "../support/completionCatalog.js";

const SQL_SERVER_2017 = "14.0.3456.2";
const SQL_SERVER_2019 = "15.0.4355.3";
const SQL_SERVER_2022 = "16.0.4135.4";
const SQL_SERVER_2025 = "17.0.1000.7";
const AZURE = serverVersionOf("12.0.2000.8", 5);

/** Names that change shape across releases, one spec per range. */
const RESHAPED = new Set(["LTRIM", "RTRIM", "TRIM"]);

const language: SqlLanguage = (() => {
  if (mssql.language === undefined) throw new Error("The SQL Server plugin has no language.");
  return mssql.language;
})();

function namesOn(version: string | null): Set<string> {
  const server = version === null ? null : serverIdentity(version);
  return new Set(MSSQL_FUNCTIONS.filter((spec) => isAvailable(spec, server)).map((spec) => spec.name));
}

async function offered(text: string, version: string | null): Promise<readonly CompletionItem[]> {
  const catalog = fakeCatalog(fixtureRelations(), undefined, version);
  return (await language.complete({ text, offset: text.length }, catalog)).items;
}

async function functionsOffered(text: string, version: string | null): Promise<CompletionItem[]> {
  return (await offered(text, version)).filter((item) => item.kind === "function");
}

async function signatureOn(marked: string) {
  const offset = marked.indexOf("|");
  const catalog = fakeCatalog(fixtureRelations(), undefined, SQL_SERVER_2022);
  const help = await language.signatureAt?.({ text: marked.replace("|", ""), offset }, catalog);
  const parameters = help?.signatures[0]?.parameters ?? [];
  return { help, active: parameters[help?.argument ?? -1]?.name };
}

describe("mssql function list", () => {
  it("givenEverySpec_whenRead_thenSummaryAndSignature", () => {
    for (const spec of MSSQL_FUNCTIONS) {
      expect(spec.summary.length, spec.name).toBeGreaterThan(0);
      expect(spec.signatures.length, spec.name).toBeGreaterThan(0);
      expect(spec.name, spec.name).toBe(spec.name.toUpperCase());
    }
  });

  it("givenTheList_whenNamesCounted_thenNoNameTwiceOnOneServer", () => {
    for (const version of [SQL_SERVER_2017, SQL_SERVER_2019, SQL_SERVER_2022, SQL_SERVER_2025, AZURE]) {
      const server = serverIdentity(version);
      const names = MSSQL_FUNCTIONS.filter((spec) => isAvailable(spec, server)).map((spec) => spec.name);
      expect(
        names.filter((name, at) => names.indexOf(name) !== at),
        version,
      ).toEqual([]);
    }
    const names = MSSQL_FUNCTIONS.map((spec) => spec.name);
    expect(names.filter((name, at) => names.indexOf(name) !== at && !RESHAPED.has(name))).toEqual([]);
  });

  it("givenManualIndex_whenChecked_thenEveryNameOfferedOrExcused", () => {
    const specs = new Set(MSSQL_FUNCTIONS.map((spec) => spec.name));
    const indexed = new Set(Object.values(MANUAL_INDEX).flat());
    const unaccounted = [...indexed].filter((name) => !specs.has(name) && !(name in NOT_OFFERED));
    expect(unaccounted).toEqual([]);
    expect(Object.keys(NOT_OFFERED).filter((name) => specs.has(name))).toEqual([]);
    expect(Object.keys(NOT_OFFERED).filter((name) => !indexed.has(name))).toEqual([]);
    expect([...specs].filter((name) => !indexed.has(name))).toEqual([]);
  });

  it("givenSqlServer2019_whenFiltered_thenNoTwentyTwoFunctions", () => {
    const names = namesOn(SQL_SERVER_2019);
    for (const later of ["GREATEST", "LEAST", "DATETRUNC", "GENERATE_SERIES", "JSON_OBJECT", "REGEXP_LIKE"])
      expect(names).not.toContain(later);
    expect(names).toContain("APPROX_COUNT_DISTINCT");
    expect(names).not.toContain("FILEPROPERTYEX");
  });

  it("givenSqlServer2017_whenFiltered_thenNoApproxCountDistinct", () => {
    expect(namesOn(SQL_SERVER_2017)).not.toContain("APPROX_COUNT_DISTINCT");
  });

  it("givenSqlServer2025_whenFiltered_thenRegexAndVectors", () => {
    const names = namesOn(SQL_SERVER_2025);
    for (const name of ["REGEXP_LIKE", "VECTOR_DISTANCE", "PRODUCT", "CURRENT_DATE", "GREATEST"])
      expect(names).toContain(name);
  });

  it("givenAzure_whenFiltered_thenLatestButNoOpenQuery", () => {
    const names = namesOn(AZURE);
    for (const name of ["GREATEST", "REGEXP_LIKE", "FILEPROPERTYEX"]) expect(names).toContain(name);
    for (const name of ["OPENQUERY", "OPENDATASOURCE", "@@CPU_BUSY", "FILE_ID"]) expect(names).not.toContain(name);
  });

  it("givenUnknownServer_whenFiltered_thenEverything", () => {
    expect(namesOn(null).size).toBe(new Set(MSSQL_FUNCTIONS.map((spec) => spec.name)).size);
  });

  it("givenNiladicFunctions_whenRead_thenBare", () => {
    const bare = new Set(MSSQL_FUNCTIONS.filter((spec) => spec.bare === true).map((spec) => spec.name));
    for (const name of ["CURRENT_TIMESTAMP", "CURRENT_USER", "SESSION_USER", "SYSTEM_USER", "USER"])
      expect(bare).toContain(name);
    for (const spec of MSSQL_FUNCTIONS.filter((candidate) => candidate.name.startsWith("@@")))
      expect(spec.bare, spec.name).toBe(true);
  });
});

describe("mssql server identity", () => {
  it("givenProductVersion_whenRead_thenMssqlRelease", () => {
    expect(serverIdentity(SQL_SERVER_2022)).toEqual({ flavour: "mssql", version: [16, 0, 4135] });
  });

  it("givenAzureEdition_whenRead_thenAzure", () => {
    expect(AZURE).toBe("Azure SQL 12.0.2000.8");
    expect(serverIdentity(AZURE)?.flavour).toBe("azure");
    expect(serverVersionOf("16.0.1000.6", 8)).toMatch(/^Azure SQL /);
  });

  it("givenUnreadableVersion_whenRead_thenNull", () => {
    expect(serverIdentity("unknown")).toBeNull();
  });
});

describe("mssql function completion", () => {
  it("givenSqlServer2019_whenCompleteGre_thenNoGreatest", async () => {
    const labels = (await functionsOffered("SELECT gre", SQL_SERVER_2019)).map((item) => item.label);
    expect(labels).not.toContain("greatest");
  });

  it("givenSqlServer2022_whenCompleteGre_thenGreatest", async () => {
    const items = await functionsOffered("SELECT gre", SQL_SERVER_2022);
    expect(items.find((item) => item.label === "greatest")).toMatchObject({ apply: "greatest()" });
  });

  it("givenAzure_whenComplete_thenLatestButNoOpenQuery", async () => {
    expect((await functionsOffered("SELECT gre", AZURE)).map((item) => item.label)).toContain("greatest");
    expect((await functionsOffered("SELECT * FROM openq", AZURE)).map((item) => item.label)).not.toContain("openquery");
  });

  it("givenCurrentTimestamp_whenAccepted_thenNoParentheses", async () => {
    const item = (await functionsOffered("SELECT current_ti", SQL_SERVER_2022)).find(
      (candidate) => candidate.label === "current_timestamp",
    );
    expect(item?.apply).toBe("current_timestamp");
  });

  it("givenAtAtPrefix_whenComplete_thenGlobals", async () => {
    for (const text of ["SELECT @@", "SELECT @@ver", "SELECT @"]) {
      const items = await functionsOffered(text, SQL_SERVER_2022);
      const version = items.find((item) => item.label === "@@version");
      expect(version, text).toMatchObject({ apply: "@@version" });
    }
    const [first] = (await offered("SELECT @@ver", SQL_SERVER_2022)).filter((item) => item.label === "@@version");
    expect(first?.kind).toBe("function");
  });

  it("givenCastAs_whenHint_thenTypeBold", async () => {
    expect((await signatureOn("SELECT cast(total AS |) FROM orders")).active).toBe("data_type");
    expect((await signatureOn("SELECT try_cast(total AS |) FROM orders")).active).toBe("data_type");
    expect((await signatureOn("SELECT parse('1' AS int USING |)")).active).toBe("culture");
    expect((await signatureOn("SELECT convert(int, |)")).active).toBe("expression");
    expect((await signatureOn("SELECT dateadd(day, 1, |)")).active).toBe("date");
  });

  it("givenTrimFrom_whenHint_thenStringBold", async () => {
    expect((await signatureOn("SELECT trim('x' FROM |)")).help?.argument).toBe(1);
    expect((await signatureOn("SELECT trim(LEADING 'x' FROM |)")).help?.argument).toBe(1);
  });

  it("givenColumnPrefix_whenComplete_thenColumnAboveFunctions", async () => {
    const catalog = fakeCatalog(fixtureRelations(), PUBLIC, SQL_SERVER_2022);
    const text = "SELECT c FROM orders";
    const { items } = await language.complete({ text, offset: "SELECT c".length }, catalog);
    const column = items.find((item) => item.kind === "column" && item.label === "customer_id");
    const ceiling = items.find((item) => item.label === "ceiling");
    expect(column).toBeDefined();
    expect(column?.boost).toBeGreaterThan(ceiling?.boost ?? Number.POSITIVE_INFINITY);
  });

  it("givenDateadd_whenCompleting_thenSignature", async () => {
    const item = (await functionsOffered("SELECT datea", SQL_SERVER_2022)).find((entry) => entry.label === "dateadd");
    expect(item?.detail).toBe("(datepart, number, date) → datetime");
  });
});
