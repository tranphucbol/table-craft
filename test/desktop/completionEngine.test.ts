import { describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import type { SqlLanguage } from "@table-craft/plugin-api";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type {
  CompletionResult,
  Declaration,
  EngineResponse,
  SignatureHelp,
} from "@table-craft/desktop/engine/protocol.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};

const SQLITE_VERSION = /^3\.\d+\.\d+/;

/** SQLite whose completion answers with the server version its catalog carries. */
function echoingServerVersion(): PluginLoadResult {
  const language = sqlite.language;
  if (language === undefined) throw new Error("The SQLite plugin has no language.");
  const echo: SqlLanguage = {
    ...language,
    complete: async (request, catalog) => ({
      ...(await language.complete(request, catalog)),
      items: [
        {
          label: String(catalog.server.version),
          kind: "keyword",
          detail: null,
          apply: "",
          boost: 0,
          info: null,
          caret: null,
        },
      ],
    }),
  };
  return {
    status: "loaded",
    directory: "plugins/sqlite",
    manifest: SQLITE_MANIFEST,
    plugin: { ...sqlite, language: echo },
  };
}

function connection(plugin: PluginLoadResult = LOADED_SQLITE) {
  const path = seededSqliteFile();
  return createEngine({
    datasource: { id: "seeded", pluginId: "sqlite", config: { path }, readOnly: false, keepAliveSeconds: 0 },
    plugins: [plugin],
  }).connect();
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

describe("engine completion", () => {
  it("givenSqlite_whenCompleting_thenServerVersionReachesCatalog", async () => {
    const engine = connection(echoingServerVersion());
    const text = "SELECT ";

    const result = resultOf<CompletionResult>(
      await engine.handle({ id: 1, type: "completion.complete", text, offset: text.length }),
    );

    expect(result.items[0]?.label).toMatch(SQLITE_VERSION);
  });

  it("givenCallAtCaret_whenAskingSignature_thenHelp", async () => {
    const engine = connection();
    const text = "SELECT substr(name, ";

    const help = resultOf<SignatureHelp | null>(
      await engine.handle({ id: 1, type: "completion.signature", text, offset: text.length }),
    );

    expect(help).toMatchObject({ name: "substr", argument: 1, from: "SELECT ".length });
  });

  it("givenNoCall_whenAskingSignature_thenNull", async () => {
    const engine = connection();
    const text = "SELECT name FROM ";

    expect(
      resultOf<SignatureHelp | null>(
        await engine.handle({ id: 1, type: "completion.signature", text, offset: text.length }),
      ),
    ).toBeNull();
  });

  it("givenFromClause_whenCompleting_thenOffersSeededTablesWithoutAConsoleSession", async () => {
    const engine = connection();
    const text = "SELECT * FROM ";

    const result = resultOf<CompletionResult>(
      await engine.handle({ id: 1, type: "completion.complete", text, offset: text.length }),
    );

    expect(result.from).toBe(text.length);
    expect(result.items.filter((item) => item.kind === "table").map((item) => item.label)).toEqual(
      expect.arrayContaining(["customers", "orders", "Line Items"]),
    );
  });

  it("givenCurrent_whenCompleting_thenCompletesAgainstIt", async () => {
    const engine = connection();
    const text = "SELECT * FROM ";
    const tables = async (current?: readonly string[]) =>
      resultOf<CompletionResult>(
        await engine.handle({
          id: 1,
          type: "completion.complete",
          text,
          offset: text.length,
          ...(current === undefined ? {} : { current }),
        }),
      ).items.filter((item) => item.kind === "table");

    expect((await tables(["main"])).map((item) => item.label)).toContain("orders");
    expect(await tables(["nowhere"])).toEqual([]);
  });

  it("givenScopeParam_whenCompletingWhereBar_thenOffersTableColumns", async () => {
    const engine = connection();

    const result = resultOf<CompletionResult>(
      await engine.handle({
        id: 1,
        type: "completion.complete",
        text: "cust",
        offset: 4,
        scope: { path: ["main"], relation: "orders" },
      }),
    );

    expect(result.from).toBe(0);
    expect(result.items).toContainEqual(expect.objectContaining({ label: "customer_id", kind: "column" }));
  });

  it("givenAliasReference_whenResolving_thenReturnsDeclarationSpan", async () => {
    const engine = connection();
    const text = "SELECT o.total FROM orders o";

    const declaration = resultOf<Declaration | null>(
      await engine.handle({ id: 1, type: "navigation.resolve", text, offset: 7 }),
    );

    expect(declaration).toEqual({ kind: "alias", from: 20, to: 28 });
  });

  it("givenRelationReference_whenResolving_thenReturnsPathAndRelation", async () => {
    const engine = connection();
    const text = "SELECT * FROM customers";

    const declaration = resultOf<Declaration | null>(
      await engine.handle({ id: 1, type: "navigation.resolve", text, offset: 16 }),
    );

    expect(declaration).toEqual({ kind: "relation", path: ["main"], relation: "customers" });
  });

  it("givenOffsetPastText_whenCompleting_thenInvalidRequest", async () => {
    const engine = connection();

    const response = await engine.handle({ id: 1, type: "completion.complete", text: "SEL", offset: 9 });

    expect(response.type).toBe("engine.error");
    expect(response.type === "engine.error" && response.error.code).toBe("invalidRequest");
  });
});
