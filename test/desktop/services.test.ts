import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { CSV_FORMAT, type PluginLoadResult } from "@table-craft/core";
import type { Capability, DatasourcePlugin, KeepAlive, Session } from "@table-craft/plugin-api";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import type { EngineResponse } from "@table-craft/desktop/engine/protocol.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";
import { hasService, serviceOf } from "@table-craft/desktop/engine/services.js";
import { exportHarness, type ExportHarness } from "../support/engineExports.js";
import { languageFor } from "../support/declaredServices.js";
import { fakeManifest, SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENGINE_FIXTURE = "packages/desktop/src/engine/fixture.ts";
const CORE_FIXTURE = "packages/core/src/fixture.ts";
const GATE_FIXTURE = "packages/desktop/src/engine/services.ts";
const READS_SERVICES =
  "export const cancelOf = (session: { services: { cancel?: unknown } }) => session.services.cancel;\n";
const RESTRICTED_SYNTAX = "no-restricted-syntax";
const PING: KeepAlive = { ping: () => Promise.resolve() };
const SESSION_BASE = {
  execute: () => Promise.reject(new Error("unused")),
  close: () => Promise.resolve(),
  serverVersion: null,
};
const sqlite: DatasourcePlugin = sqlitePlugin;
const WITHOUT_BULK_INSERT_ID = "no-bulk-insert";
const WITHOUT_BULK_INSERT: readonly Capability[] = sqlite.capabilities.filter(
  (capability) => capability !== "bulkInsert",
);

function session(services: Session["services"]): Session {
  return { ...SESSION_BASE, services };
}

function failure(response: EngineResponse): { code: string; message: string } {
  if (response.type !== "engine.error") throw new Error("expected an engine error");
  return response.error;
}

async function lintGate(filePath: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: REPOSITORY_ROOT,
    overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
    ruleFilter: ({ ruleId }) => ruleId === RESTRICTED_SYNTAX,
  });
  const [result] = await eslint.lintText(READS_SERVICES, { filePath });
  return (result?.messages ?? []).map((message) => message.message);
}

/** SQLite with `bulkInsert` dropped from its capabilities, its language and its sessions. */
function withoutBulkInsert(): PluginLoadResult {
  const plugin: DatasourcePlugin = {
    ...sqlite,
    id: WITHOUT_BULK_INSERT_ID,
    capabilities: WITHOUT_BULK_INSERT,
    language: languageFor(sqlitePlugin.language, WITHOUT_BULK_INSERT),
    connect: async (config, options) => {
      const opened = await sqlite.connect(config, options);
      const { bulkInsert: _dropped, ...services } = opened.services;
      return { ...opened, execute: opened.execute.bind(opened), close: opened.close.bind(opened), services };
    },
  };
  return {
    status: "loaded",
    directory: "plugins/no-bulk-insert",
    manifest: fakeManifest({
      id: WITHOUT_BULK_INSERT_ID,
      name: "No bulk insert",
      capabilities: [...WITHOUT_BULK_INSERT],
    }),
    plugin,
  };
}

describe("the engine's service gate", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  function harness(pluginId: string, loaded: PluginLoadResult): ExportHarness {
    const opened = exportHarness(
      { id: "gate", pluginId, config: { path: seededSqliteFile() }, readOnly: false, keepAliveSeconds: 0 },
      [loaded],
    );
    cleanup.push(() => opened.close());
    return opened;
  }

  it("givenServicePresent_whenServiceOf_thenTypedService", () => {
    const found = serviceOf(session({ keepAlive: PING }), "keepAlive");

    expectTypeOf(found).toEqualTypeOf<KeepAlive>();
    expect(found).toBe(PING);
  });

  it("givenServiceAbsent_whenServiceOf_thenNotDeclaredNamingCapability", () => {
    const absent = session({});

    expect(() => serviceOf(absent, "keepAlive")).toThrow(EngineFailure);
    expect(() => serviceOf(absent, "keepAlive")).toThrow(
      "This datasource's plugin does not declare the keepAlive capability.",
    );
  });

  it("givenServiceAbsent_whenHasService_thenFalse", () => {
    expect(hasService(session({}), "keepAlive")).toBe(false);
    expect(hasService(session({ keepAlive: PING }), "keepAlive")).toBe(true);
  });

  it("givenPluginWithoutNodes_whenServerNodesRequested_thenNotDeclaredNodes", async () => {
    const loaded: PluginLoadResult = {
      status: "loaded",
      directory: "plugins/sqlite",
      manifest: SQLITE_MANIFEST,
      plugin: sqlite,
    };
    const engine = harness("sqlite", loaded);

    const response = await engine.connection.handle({ id: 1, type: "server.nodes" });

    expect(failure(response)).toMatchObject({
      code: "invalidRequest",
      message: "This datasource's plugin does not declare the nodes capability.",
    });
  });

  it("givenBulkInsertSession_whenImportStarts_thenNoPlainError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "table-craft-gate-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, "people.csv");
    await writeFile(source, "id,name,email\n10,Ten,ten@example.com\n");
    const engine = harness(WITHOUT_BULK_INSERT_ID, withoutBulkInsert());

    const response = await engine.connection.handle({
      id: 2,
      type: "import.start",
      stallSeconds: 60,
      file: source,
      format: CSV_FORMAT,
      target: { kind: "table", path: ["main"], relation: "customers", mapping: [{ column: "id", field: 0 }] },
      transaction: { mode: "all" },
      errors: { mode: "stop" },
    });

    expect(failure(response)).toMatchObject({
      code: "invalidRequest",
      message: "This datasource's plugin does not declare the bulkInsert capability.",
    });
  });

  it("givenEngineSourceReadingServices_whenLinted_thenFenceReports", async () => {
    const rule = "Reach a capability's service through engine/services.ts (decision 155).";

    expect(await lintGate(ENGINE_FIXTURE)).toEqual([rule]);
    expect(await lintGate(CORE_FIXTURE)).toEqual([rule]);
    expect(await lintGate(GATE_FIXTURE)).toEqual([]);
  });
});
