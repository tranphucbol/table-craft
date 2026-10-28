import {
  classifyTokens,
  namespaceSlotAt,
  namespaceSwitcher,
  namespaceTarget,
  quoteIdentifierWith,
  type SqlDialectOptions,
} from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";

const MYSQL: SqlDialectOptions = { backslashEscapes: true, hashComments: true, namespaceStatements: ["use"] };
const POSTGRES: SqlDialectOptions = {
  dollarQuotes: true,
  nestedBlockComments: true,
  namespaceStatements: ["searchPath"],
};
const ORACLE: SqlDialectOptions = {
  batchSeparator: "slash",
  qQuotes: true,
  namespaceStatements: ["alterSessionSchema"],
};

function candidates(sql: string, dialect: SqlDialectOptions): readonly (readonly [string, boolean])[] | null {
  const target = namespaceTarget(sql, dialect);
  return target === null ? null : target.candidates.map((candidate) => [candidate.name, candidate.quoted] as const);
}

describe("namespaceTarget", () => {
  it("givenUseStatement_whenUseFormEnabled_thenTargetsDatabase", () => {
    expect(namespaceTarget("USE archive", MYSQL)).toEqual({
      kind: "database",
      candidates: [{ name: "archive", quoted: false, from: 4, to: 11 }],
    });
    expect(candidates("  use   Archive ;", MYSQL)).toEqual([["Archive", false]]);
    expect(candidates("/* c */ USE archive -- here", MYSQL)).toEqual([["archive", false]]);
  });

  it("givenBacktickedUse_whenParsed_thenCandidateQuoted", () => {
    expect(candidates("USE `My Db`", MYSQL)).toEqual([["My Db", true]]);
    expect(candidates("USE `a``b`", MYSQL)).toEqual([["a`b", true]]);
  });

  it("givenUseWithoutName_whenParsed_thenNull", () => {
    expect(namespaceTarget("USE", MYSQL)).toBeNull();
    expect(namespaceTarget("USE a b", MYSQL)).toBeNull();
  });

  it("givenSearchPathList_whenParsed_thenCandidatesInOrder", () => {
    expect(namespaceTarget("SET search_path TO archive, public", POSTGRES)?.kind).toBe("schema");
    expect(candidates("SET search_path TO archive, public", POSTGRES)).toEqual([
      ["archive", false],
      ["public", false],
    ]);
    expect(candidates('set SESSION search_path = "Archive", public', POSTGRES)).toEqual([
      ["Archive", true],
      ["public", false],
    ]);
    expect(candidates("SET LOCAL SEARCH_PATH TO archive", POSTGRES)).toEqual([["archive", false]]);
  });

  it("givenSearchPathLiteral_whenParsed_thenCandidateQuoted", () => {
    expect(candidates("SET search_path TO 'archive', '$user'", POSTGRES)).toEqual([
      ["archive", true],
      ["$user", true],
    ]);
    expect(candidates("SET search_path TO 'it''s'", POSTGRES)).toEqual([["it's", true]]);
  });

  it("givenSetSchema_whenParsed_thenTargetsSchema", () => {
    expect(namespaceTarget("SET SCHEMA 'archive'", POSTGRES)).toEqual({
      kind: "schema",
      candidates: [{ name: "archive", quoted: true, from: 11, to: 20 }],
    });
    expect(candidates("SET SESSION SCHEMA archive", POSTGRES)).toEqual([["archive", false]]);
  });

  it("givenDefaultOrReset_whenParsed_thenNoCandidates", () => {
    for (const sql of ["SET search_path TO DEFAULT", "SET search_path = default", "RESET search_path", "RESET ALL"]) {
      expect(namespaceTarget(sql, POSTGRES), sql).toEqual({ kind: "schema", candidates: [] });
    }
  });

  it("givenFormNotEnabled_whenParsed_thenNull", () => {
    expect(namespaceTarget("SET search_path TO archive", MYSQL)).toBeNull();
    expect(namespaceTarget("USE archive", POSTGRES)).toBeNull();
    expect(namespaceTarget("USE archive", {})).toBeNull();
  });

  it("givenOtherStatement_whenParsed_thenNull", () => {
    for (const sql of ["SET work_mem TO '64MB'", "RESET work_mem", "SELECT 1", "SET search_path", "", "SET"]) {
      expect(namespaceTarget(sql, POSTGRES), sql).toBeNull();
    }
    expect(namespaceTarget("SET NAMES utf8mb4", MYSQL)).toBeNull();
  });
});

describe("classifyTokens namespace statements", () => {
  it("givenNamespaceStatement_whenClassified_thenSetsNamespace", () => {
    expect(classifyTokens("USE archive", MYSQL)).toEqual({ kind: "other", destructive: null, setsNamespace: true });
    expect(classifyTokens("SET search_path TO archive", POSTGRES).setsNamespace).toBe(true);
    expect(classifyTokens("RESET ALL", POSTGRES).setsNamespace).toBe(true);
    expect(classifyTokens("SET work_mem TO '64MB'", POSTGRES)).toEqual({ kind: "other", destructive: null });
    expect(classifyTokens("USE archive")).toEqual({ kind: "other", destructive: null });
  });
});

/** `text` with `|` marking the caret. */
function slotAt(marked: string, dialect: SqlDialectOptions) {
  const offset = marked.indexOf("|");
  return namespaceSlotAt(marked.replace("|", ""), offset, dialect);
}

describe("namespaceSlotAt", () => {
  it("givenUseAndSpace_whenSlotRead_thenDatabaseSlotAtCaret", () => {
    expect(slotAt("USE |", MYSQL)).toEqual({ kind: "database", from: 4, to: 4, quote: null, listed: [] });
    expect(slotAt("SELECT 1;\nuse |", MYSQL)).toMatchObject({ kind: "database", from: 14, to: 14 });
  });

  it("givenUsePartialWord_whenSlotRead_thenFromWordStart", () => {
    expect(slotAt("USE arc|", MYSQL)).toEqual({ kind: "database", from: 4, to: 7, quote: null, listed: [] });
    expect(slotAt("USE arc|;\nSELECT 1", MYSQL)).toMatchObject({ from: 4, to: 7 });
  });

  it("givenUseOpenBacktick_whenSlotRead_thenInsideQuote", () => {
    expect(slotAt("USE `arc|", MYSQL)).toEqual({
      kind: "database",
      from: 5,
      to: 8,
      quote: { char: "`", closed: false },
      listed: [],
    });
    expect(slotAt("USE `ar|c`", MYSQL)).toMatchObject({ quote: { char: "`", closed: true } });
  });

  it("givenUseFinishedName_whenSlotRead_thenNull", () => {
    expect(slotAt("USE `archive`|", MYSQL)).toBeNull();
    expect(slotAt("USE archive |", MYSQL)).toBeNull();
    expect(slotAt("USE|", MYSQL)).toBeNull();
    expect(slotAt("USE 'archive|", MYSQL)).toBeNull();
    expect(slotAt("USE -- here |", MYSQL)).toBeNull();
  });

  it("givenSearchPathSecondElement_whenSlotRead_thenListsFirst", () => {
    const slot = slotAt("SET search_path TO archive, |", POSTGRES);

    expect(slot).toMatchObject({ kind: "schema", from: 28, to: 28, quote: null });
    expect(slot?.listed.map((name) => name.name)).toEqual(["archive"]);
    expect(slotAt("set local search_path = pub|", POSTGRES)).toMatchObject({ kind: "schema", from: 24, listed: [] });
    expect(slotAt("SET search_path TO archive |", POSTGRES)).toBeNull();
    expect(slotAt("SET search_path |", POSTGRES)).toBeNull();
  });

  it("givenSearchPathStringElement_whenSlotRead_thenInsideString", () => {
    expect(slotAt("SET search_path TO 'arc|", POSTGRES)).toMatchObject({
      from: 20,
      to: 23,
      quote: { char: "'", closed: false },
    });
    expect(slotAt("SET search_path TO E'arc|", POSTGRES)).toBeNull();
  });

  it("givenSetSchema_whenSlotRead_thenSchemaSlot", () => {
    expect(slotAt("SET SCHEMA |", POSTGRES)).toMatchObject({ kind: "schema", from: 11, listed: [] });
    expect(slotAt('SET SESSION SCHEMA "ar|', POSTGRES)).toMatchObject({ quote: { char: '"', closed: false } });
    expect(slotAt("SET SCHEMA archive, |", POSTGRES)).toBeNull();
  });

  it("givenDialectWithoutForms_whenSlotRead_thenNull", () => {
    expect(slotAt("USE |", {})).toBeNull();
    expect(slotAt("USE |", POSTGRES)).toBeNull();
    expect(slotAt("SET search_path TO |", MYSQL)).toBeNull();
  });

  it("givenSelect_whenSlotRead_thenNull", () => {
    expect(slotAt("SELECT * FROM |", MYSQL)).toBeNull();
    expect(slotAt("SET work_mem TO |", POSTGRES)).toBeNull();
  });
});

describe("namespaceSwitcher", () => {
  it("givenNamespaceSwitcher_whenStatementWritten_thenDialectForm", () => {
    const mysql = namespaceSwitcher("use", quoteIdentifierWith("`"));
    const postgres = namespaceSwitcher("searchPath", quoteIdentifierWith('"'));

    expect(mysql).toMatchObject({ targets: "topLevel", transactional: false });
    expect(mysql.statement(["my `db`"])).toBe("USE `my ``db```");
    expect(postgres).toMatchObject({ targets: "schema", transactional: true });
    expect(postgres.statement(["table_craft", "Archive"])).toBe('SET search_path TO "Archive"');
    expect(() => postgres.statement([])).toThrow(/pick one/);
    expect(classifyTokens(postgres.statement(["x"]), POSTGRES).setsNamespace).toBe(true);
    expect(namespaceTarget(mysql.statement(["a`b"]), MYSQL)?.candidates[0]?.name).toBe("a`b");
  });

  it("givenAlterSessionSwitcher_whenStatementWritten_thenCurrentSchemaForm", () => {
    const oracle = namespaceSwitcher("alterSessionSchema", quoteIdentifierWith('"'));

    expect(oracle).toMatchObject({ targets: "schema", transactional: false });
    expect(oracle.statement(["Archive"])).toBe('ALTER SESSION SET CURRENT_SCHEMA = "Archive"');
    expect(namespaceTarget(oracle.statement(["Archive"]), ORACLE)?.candidates[0]?.name).toBe("Archive");
  });
});

describe("alterSessionSchema form", () => {
  it("givenAlterSessionCurrentSchema_whenParsed_thenTargetsSchema", () => {
    expect(namespaceTarget("ALTER SESSION SET CURRENT_SCHEMA = archive", ORACLE)).toEqual({
      kind: "schema",
      candidates: [{ name: "archive", quoted: false, from: 35, to: 42 }],
    });
    expect(candidates('alter session set current_schema = "Archive"', ORACLE)).toEqual([["Archive", true]]);
    expect(classifyTokens("ALTER SESSION SET CURRENT_SCHEMA = archive", ORACLE).setsNamespace).toBe(true);
  });

  it("givenOtherAlterSession_whenParsed_thenNull", () => {
    for (const sql of [
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY'",
      "ALTER SESSION SET CURRENT_SCHEMA",
      "ALTER SESSION SET CURRENT_SCHEMA = a b",
      "ALTER SESSION SET CURRENT_SCHEMA = 'archive'",
    ]) {
      expect(namespaceTarget(sql, ORACLE), sql).toBeNull();
    }
    expect(namespaceTarget("ALTER SESSION SET CURRENT_SCHEMA = archive", POSTGRES)).toBeNull();
  });

  it("givenAlterSessionAndCaret_whenSlotRead_thenSchemaSlot", () => {
    expect(slotAt("ALTER SESSION SET CURRENT_SCHEMA = |", ORACLE)).toEqual({
      kind: "schema",
      from: 35,
      to: 35,
      quote: null,
      listed: [],
    });
    expect(slotAt("ALTER SESSION SET CURRENT_SCHEMA = arc|", ORACLE)).toMatchObject({ from: 35, to: 38 });
    expect(slotAt("ALTER SESSION SET CURRENT_SCHEMA |", ORACLE)).toBeNull();
    expect(slotAt("ALTER SESSION SET CURRENT_SCHEMA = archive |", ORACLE)).toBeNull();
  });
});
