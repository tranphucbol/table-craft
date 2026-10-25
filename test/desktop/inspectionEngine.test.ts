import { describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import type { InspectionRequest, Problem, SqlLanguage } from "@table-craft/plugin-api";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type { EngineResponse } from "@table-craft/desktop/engine/protocol.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const TEXT = "DELETE FROM customers";
/** One past `MAX_INSPECTION_TEXT` in `engine/requests.ts`. */
const OVERSIZED_TEXT = "x".repeat(200_001);

const WITHOUT_WHERE: Problem = {
  from: 0,
  to: "DELETE".length,
  severity: "warning",
  inspection: "SqlWithoutWhere",
  message: "Unsafe query: 'Delete' statement without 'where' clears all data in the table",
  fixes: [],
};

function sqliteLanguage(): SqlLanguage {
  const language = sqlite.language;
  if (language === undefined) throw new Error("The SQLite plugin has no language.");
  return language;
}

function loaded(language: SqlLanguage | undefined): PluginLoadResult {
  const { language: _ignored, ...rest } = sqlite;
  return {
    status: "loaded",
    directory: "plugins/sqlite",
    manifest: SQLITE_MANIFEST,
    plugin: language === undefined ? rest : { ...rest, language },
  };
}

function withoutInspect(): PluginLoadResult {
  const language: SqlLanguage = { ...sqliteLanguage() };
  delete language.inspect;
  return loaded(language);
}

/** SQLite whose `inspect` reports `WITHOUT_WHERE` and records what it was asked with. */
function recording(seen: { request?: InspectionRequest; current?: readonly string[] | null }): PluginLoadResult {
  return loaded({
    ...sqliteLanguage(),
    inspect: (request, catalog) => {
      seen.request = request;
      seen.current = catalog.current;
      return Promise.resolve([WITHOUT_WHERE]);
    },
  });
}

function connection(plugin: PluginLoadResult) {
  return createEngine({
    datasource: {
      id: "seeded",
      pluginId: "sqlite",
      config: { path: seededSqliteFile() },
      readOnly: false,
      keepAliveSeconds: 0,
    },
    plugins: [plugin],
  }).connect();
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

describe("engine inspection", () => {
  it("givenPluginWithoutInspect_whenInspecting_thenNoProblems", async () => {
    const engine = connection(withoutInspect());

    const problems = resultOf<readonly Problem[]>(
      await engine.handle({ id: 1, type: "inspection.inspect", text: TEXT }),
    );

    expect(problems).toEqual([]);
  });

  it("givenPluginWithoutLanguage_whenInspecting_thenNoProblems", async () => {
    const engine = connection(loaded(undefined));

    const problems = resultOf<readonly Problem[]>(
      await engine.handle({ id: 1, type: "inspection.inspect", text: TEXT }),
    );

    expect(problems).toEqual([]);
  });

  it("givenPluginInspect_whenInspecting_thenProblemsPassThrough", async () => {
    const seen: { request?: InspectionRequest } = {};
    const engine = connection(recording(seen));

    const problems = resultOf<readonly Problem[]>(
      await engine.handle({ id: 1, type: "inspection.inspect", text: TEXT }),
    );

    expect(problems).toEqual([WITHOUT_WHERE]);
    expect(seen.request).toEqual({ text: TEXT });
  });

  it("givenCurrent_whenInspecting_thenCatalogCarriesIt", async () => {
    const seen: { current?: readonly string[] | null } = {};
    const engine = connection(recording(seen));

    await engine.handle({ id: 1, type: "inspection.inspect", text: TEXT, current: ["main"] });

    expect(seen.current).toEqual(["main"]);
  });

  it("givenDisabled_whenInspecting_thenForwardedToPlugin", async () => {
    const seen: { request?: InspectionRequest } = {};
    const engine = connection(recording(seen));

    await engine.handle({ id: 1, type: "inspection.inspect", text: TEXT, disabled: ["SqlWithoutWhere"] });

    expect(seen.request).toEqual({ text: TEXT, disabled: ["SqlWithoutWhere"] });
  });

  it("givenInspectThrows_whenInspecting_thenNoProblems", async () => {
    const engine = connection(
      loaded({ ...sqliteLanguage(), inspect: () => Promise.reject(new Error("inspector bug")) }),
    );

    const problems = resultOf<readonly Problem[]>(
      await engine.handle({ id: 1, type: "inspection.inspect", text: TEXT }),
    );

    expect(problems).toEqual([]);
  });

  it("givenTextPastTheCap_whenInspecting_thenInvalidRequest", async () => {
    const engine = connection(recording({}));

    const response = await engine.handle({ id: 1, type: "inspection.inspect", text: OVERSIZED_TEXT });

    expect(response.type).toBe("engine.error");
  });
});
