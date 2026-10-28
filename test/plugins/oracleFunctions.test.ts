import type { CompletionItem, SqlLanguage } from "@table-craft/plugin-api";
import { isAvailable } from "@table-craft/plugin-api/sql";
import oracle from "@table-craft/plugin-oracle";
import { ORACLE_FUNCTIONS, ORACLE_PACKAGE_FUNCTIONS, ORACLE_SQL_FUNCTIONS } from "@table-craft/plugin-oracle/functions";
import { MANUAL_INDEX, NOT_OFFERED } from "@table-craft/plugin-oracle/manualIndex";
import { serverIdentity } from "@table-craft/plugin-oracle/server";
import { describe, expect, it } from "vitest";
import { fakeCatalog, fixtureRelations, PUBLIC } from "../support/completionCatalog.js";

const ORACLE_19 = "19.3.0.0.0";
const ORACLE_21 = "21.3.0.0.0";
const ORACLE_23 = "23.26.3.0.0";

const language: SqlLanguage = (() => {
  if (oracle.language === undefined) throw new Error("The Oracle plugin has no language.");
  return oracle.language;
})();

function namesOn(version: string | null): Set<string> {
  const server = version === null ? null : serverIdentity(version);
  return new Set(ORACLE_FUNCTIONS.filter((spec) => isAvailable(spec, server)).map((spec) => spec.name));
}

async function completed(text: string, version: string | null = ORACLE_23): Promise<readonly CompletionItem[]> {
  const catalog = fakeCatalog(fixtureRelations(), PUBLIC, version);
  const result = await language.complete({ text, offset: text.length }, catalog);
  return result.items;
}

async function functionsOffered(text: string, version: string | null = ORACLE_23): Promise<CompletionItem[]> {
  return (await completed(text, version)).filter((item) => item.kind === "function");
}

async function signatureOn(marked: string, version: string | null = ORACLE_23) {
  const offset = marked.indexOf("|");
  const catalog = fakeCatalog(fixtureRelations(), PUBLIC, version);
  const help = await language.signatureAt?.({ text: marked.replace("|", ""), offset }, catalog);
  const parameters = help?.signatures[0]?.parameters ?? [];
  return { help, active: parameters[help?.argument ?? -1]?.name };
}

describe("oracle function list", () => {
  it("givenEverySpec_whenRead_thenSummaryAndSignature", () => {
    for (const spec of ORACLE_FUNCTIONS) {
      expect(spec.summary.length, spec.name).toBeGreaterThan(0);
      expect(spec.signatures.length, spec.name).toBeGreaterThan(0);
      expect(spec.name, spec.name).toBe(spec.name.toUpperCase());
    }
  });

  it("givenSqlFunctions_whenNamesCounted_thenNoNameTwice", () => {
    const names = ORACLE_SQL_FUNCTIONS.map((spec) => spec.name);
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });

  it("givenManualIndex_whenChecked_thenEveryNameOfferedOrExcused", () => {
    const offered = new Set(ORACLE_SQL_FUNCTIONS.map((spec) => spec.name));
    const unaccounted = MANUAL_INDEX.filter((name) => !offered.has(name) && NOT_OFFERED[name] === undefined);
    expect(unaccounted).toEqual([]);
    for (const [name, reason] of Object.entries(NOT_OFFERED)) {
      expect(MANUAL_INDEX, name).toContain(name);
      expect(offered.has(name), name).toBe(false);
      expect(reason.length, name).toBeGreaterThan(0);
    }
  });

  it("givenSqlFunctions_whenChecked_thenEachNamedByTheManual", () => {
    const index = new Set(MANUAL_INDEX);
    expect(ORACLE_SQL_FUNCTIONS.map((spec) => spec.name).filter((name) => !index.has(name))).toEqual([]);
  });

  it("givenPackageFunctions_whenRead_thenEachPackageDotMember", () => {
    for (const spec of ORACLE_PACKAGE_FUNCTIONS) expect(spec.name).toMatch(/^(DBMS|UTL)_[A-Z_0-9]+\.[A-Z_0-9]+$/);
  });

  it("givenOracle19_whenFiltered_thenNoLaterFunctions", () => {
    const names = namesOn(ORACLE_19);
    for (const later of ["JSON_SCALAR", "BIT_AND_AGG", "TO_BOOLEAN", "VECTOR_DISTANCE", "UUID"]) {
      expect(names).not.toContain(later);
    }
    expect(names).toContain("XMLROOT");
    expect(names).toContain("JSON_TRANSFORM");
  });

  it("givenOracle21_whenFiltered_thenTwentyOneAndNoTwentyThree", () => {
    const names = namesOn(ORACLE_21);
    expect(names).toContain("JSON_SCALAR");
    expect(names).toContain("CHECKSUM");
    expect(names).not.toContain("TO_BOOLEAN");
  });

  it("givenOracle23_whenFiltered_thenNoXmlroot", () => {
    const names = namesOn(ORACLE_23);
    expect(names).not.toContain("XMLROOT");
    expect(names).toContain("TO_BOOLEAN");
  });

  it("givenUnknownServer_whenFiltered_thenEveryFunction", () => {
    expect(namesOn(null).size).toBe(new Set(ORACLE_FUNCTIONS.map((spec) => spec.name)).size);
  });
});

describe("oracle server identity", () => {
  it("givenVersionString_whenRead_thenOracleTriple", () => {
    expect(serverIdentity(ORACLE_23)).toEqual({ flavour: "oracle", version: [23, 26, 3] });
    expect(serverIdentity("19.0.0.0.0")).toEqual({ flavour: "oracle", version: [19, 0, 0] });
  });

  it("givenUnreadableVersion_whenRead_thenNull", () => {
    expect(serverIdentity("unknown")).toBeNull();
  });
});

describe("oracle function completion", () => {
  it("givenOracle19_whenCompleteJson_thenNoJsonScalar", async () => {
    const labels = (await functionsOffered("SELECT json_", ORACLE_19)).map((item) => item.label);
    expect(labels).toContain("json_value");
    expect(labels).not.toContain("json_scalar");
  });

  it("givenOracle23_whenCompleteTo_thenToBoolean", async () => {
    const labels = (await functionsOffered("SELECT to_", ORACLE_23)).map((item) => item.label);
    expect(labels).toContain("to_boolean");
    expect((await functionsOffered("SELECT to_", ORACLE_19)).map((item) => item.label)).not.toContain("to_boolean");
  });

  it("givenSysdate_whenAccepted_thenNoParentheses", async () => {
    const sysdate = (await functionsOffered("SELECT sysd")).find((item) => item.label === "sysdate");
    expect(sysdate?.apply).toBe("sysdate");
  });

  it("givenExtractYearFrom_whenHint_thenDateBold", async () => {
    expect((await signatureOn("SELECT extract(YEAR FROM |) FROM DUAL")).active).toBe("datetime");
    expect((await signatureOn("SELECT extract(YEAR|) FROM DUAL")).active).toBe("unit");
  });

  it("givenKeywordLedCalls_whenHint_thenParameterAfterTheKeyword", async () => {
    expect((await signatureOn("SELECT cast(total AS |)")).active).toBe("type");
    expect((await signatureOn("SELECT trim(LEADING '0' FROM |)")).help?.argument).toBe(1);
    expect((await signatureOn("SELECT json_value(doc, '$.a' RETURNING |)")).help?.argument).toBe(2);
  });

  it("givenDbmsOutputDot_whenComplete_thenPutLine", async () => {
    const labels = (await completed("BEGIN dbms_output.")).map((item) => item.label.toLowerCase());
    expect(labels).toContain("put_line");
    expect((await functionsOffered("SELECT put_l")).map((item) => item.label)).not.toContain("put_line");
  });

  it("givenDbmsLobSubstrCall_whenHint_thenSecondArgument", async () => {
    const { help, active } = await signatureOn("SELECT dbms_lob.substr(doc, |) FROM DUAL");
    expect(help?.argument).toBe(1);
    expect(active).toBe("amount");
  });

  it("givenColumnPrefix_whenComplete_thenColumnAboveFunctions", async () => {
    const catalog = fakeCatalog(fixtureRelations(), PUBLIC, ORACLE_23);
    const text = "SELECT c FROM orders";
    const { items } = await language.complete({ text, offset: "SELECT c".length }, catalog);
    const column = items.find((item) => item.kind === "column" && item.label.toLowerCase() === "customer_id");
    const ceil = items.find((item) => item.label === "ceil");
    expect(column).toBeDefined();
    expect(column?.boost).toBeGreaterThan(ceil?.boost ?? Number.POSITIVE_INFINITY);
  });
});
