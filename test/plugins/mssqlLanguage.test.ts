import { isPluginError, type SqlLanguage } from "@table-craft/plugin-api";
import mssql from "@table-craft/plugin-mssql";
import { describe, expect, it } from "vitest";
import { fakeCatalog } from "../support/completionCatalog.js";

const language: SqlLanguage = (() => {
  if (mssql.language === undefined) throw new Error("The SQL Server plugin has no language.");
  return mssql.language;
})();

/** Nothing listens here: a connect that reaches the network fails differently. */
const UNUSED_PORT = 9;

describe("mssql language", () => {
  it("givenGoSeparatedScript_whenSplit_thenBatchesAndRepeat", () => {
    const spans = language.split("SELECT 1\nGO\nINSERT INTO t VALUES (1)\nGO 3\nSELECT 2");
    expect(spans.map((span) => [span.sql, span.repeat])).toEqual([
      ["SELECT 1", undefined],
      ["INSERT INTO t VALUES (1)", 3],
      ["SELECT 2", undefined],
    ]);
  });

  it("givenBracketsAndNationalText_whenSplit_thenSemicolonsInsideKept", () => {
    expect(language.split("SELECT 1 AS [a;b]; SELECT N'x;y'").map((span) => span.sql)).toEqual([
      "SELECT 1 AS [a;b]",
      "SELECT N'x;y'",
    ]);
  });

  it("givenOddName_whenQuoted_thenBracketsDoubled", () => {
    expect(language.quoteIdentifier("odd ]name")).toBe("[odd ]]name]");
  });

  it("givenLiterals_whenWritten_thenBitsAndUnicodeText", () => {
    expect(language.literal(true, "bit")).toBe("1");
    expect(language.literal("héllo", "nvarchar(10)")).toBe("N'héllo'");
  });

  it("givenUse_whenClassified_thenSetsNamespace", () => {
    expect(language.classify("USE [sales]").setsNamespace).toBe(true);
    expect(language.namespaceSwitch?.statement(["sales"])).toBe("USE [sales]");
  });

  it("givenSavepoint_whenWritten_thenSaveTransactionAndNoRelease", () => {
    const savepoint = language.savepoint?.("edits");
    expect(savepoint?.set).toContain("SAVE TRANSACTION [edits]");
    expect(savepoint?.rollback).toContain("ROLLBACK TRANSACTION [edits]");
    expect(savepoint?.release.trimStart().startsWith("--")).toBe(true);
  });

  it("givenTempTableAndVariable_whenInspected_thenNoUnknownRelation", async () => {
    const catalog = fakeCatalog();
    const problems = async (text: string) => (await language.inspect?.({ text }, catalog)) ?? [];
    expect(await problems("SELECT * FROM missing_table")).not.toEqual([]);
    expect(await problems("SELECT * FROM #scratch")).toEqual([]);
    expect(await problems("SELECT * FROM @t")).toEqual([]);
  });
});

describe("mssql connect", () => {
  it("givenNamedInstanceOverTunnel_whenConnect_thenHintToUsePort", async () => {
    const config = mssql.connectionSchema.parse({ host: "127.0.0.1", port: UNUSED_PORT, instance: "SQLEXPRESS" });
    const failure = await mssql.connect(config, { readOnly: false, serverName: "db.internal" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isPluginError(failure) && failure.code).toBe("connectionFailed");
    expect(String((failure as Error).message)).toMatch(/port/);
  });
});
