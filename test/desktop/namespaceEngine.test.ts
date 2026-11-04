import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PluginError,
  type Capability,
  type DatasourcePlugin,
  type SqlLanguage,
  type StatementClass,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type {
  EngineResponse,
  ExecutedStatement,
  OpenedSession,
  TransactionState,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { exportHarness, startExport, type ExportHarness } from "../support/engineExports.js";
import { languageFor, USE_SWITCH } from "../support/declaredServices.js";
import { fakeManifest } from "../support/manifests.js";

const sqlite: DatasourcePlugin = sqlitePlugin;
const PLUGIN_ID = "switching";
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const USE = /^USE\s+(\w+)$/i;
const CAPABILITIES: readonly Capability[] = ["sql", "transactions", "currentNamespace"];
const KNOWN = new Set(["main", "archive"]);
const DATASOURCE = { id: "s", pluginId: PLUGIN_ID, config: { path: ":memory:" }, readOnly: false, keepAliveSeconds: 0 };

/**
 * SQLite with a pretend `USE`: the switch is held in the fake, which counts how often the engine
 * asks for it, so the tests see when the engine reads and what it reports.
 */
function switchingPlugin(options: { failRead?: boolean } = {}) {
  let current: readonly string[] = ["main"];
  let reads = 0;
  const base = sqlite.language as SqlLanguage;
  const language = languageFor(
    {
      ...base,
      classify: (sql): StatementClass =>
        USE.test(sql.trim()) ? { kind: "other", destructive: null, setsNamespace: true } : base.classify(sql),
    },
    CAPABILITIES,
    { currentNamespace: USE_SWITCH },
  );
  const plugin: DatasourcePlugin = {
    ...sqlite,
    id: PLUGIN_ID,
    capabilities: CAPABILITIES,
    language,
    connect: async (config, connectOptions) => {
      const session = await sqlite.connect(config, connectOptions);
      return {
        execute: (sql, params) => {
          const target = USE.exec(sql.trim())?.[1];
          if (target === undefined) return session.execute(sql, params);
          if (!KNOWN.has(target))
            return Promise.reject(new PluginError("statementFailed", `Unknown database '${target}'`));
          current = [target];
          return session.execute("SELECT 1 WHERE 0");
        },
        services: {
          transactions: session.services.transactions,
          currentNamespace: {
            current: () => {
              reads += 1;
              return options.failRead === true
                ? Promise.reject(new PluginError("statementFailed", "gone"))
                : Promise.resolve(current);
            },
          },
        },
        serverVersion: session.serverVersion,
        close: () => session.close(),
      };
    },
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/switching",
    manifest: fakeManifest({
      id: PLUGIN_ID,
      name: "Switching",
      capabilities: ["sql", "transactions", "currentNamespace"],
    }),
    plugin,
  };
  const connection = createEngine({ datasource: DATASOURCE, plugins: [loaded] }).connect();
  return { connection, loaded, reads: () => reads };
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

type Connection = ReturnType<typeof switchingPlugin>["connection"];

async function open(connection: Connection): Promise<OpenedSession> {
  return resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" }));
}

function execute(connection: Connection, sessionId: string, sql: string): Promise<EngineResponse> {
  return connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql });
}

describe("engine current namespace", () => {
  it("givenNamespaceCapability_whenSessionOpens_thenReportsNamespace", async () => {
    const { connection } = switchingPlugin();

    expect((await open(connection)).namespace).toEqual(["main"]);
  });

  it("givenFailingRead_whenSessionOpens_thenNamespaceNull", async () => {
    const { connection } = switchingPlugin({ failRead: true });

    expect((await open(connection)).namespace).toBeNull();
  });

  it("givenUseStatement_whenExecuted_thenReportsNewNamespace", async () => {
    const { connection } = switchingPlugin();
    const { sessionId } = await open(connection);

    const executed = resultOf<ExecutedStatement>(await execute(connection, sessionId, "USE archive"));

    expect(executed.namespace).toEqual(["archive"]);
  });

  it("givenOrdinaryStatement_whenExecuted_thenNoNamespaceRead", async () => {
    const { connection, reads } = switchingPlugin();
    const { sessionId } = await open(connection);
    const before = reads();

    const executed = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));

    expect(executed).not.toHaveProperty("namespace");
    expect(reads()).toBe(before);
  });

  it("givenFailedUse_whenExecuted_thenNoNamespace", async () => {
    const { connection, reads } = switchingPlugin();
    const { sessionId } = await open(connection);
    const before = reads();

    const response = await execute(connection, sessionId, "USE nowhere");

    expect(response).toMatchObject({ type: "engine.error", error: { code: "statementFailed" } });
    expect(reads()).toBe(before);
  });

  it("givenFailingRead_whenUseExecuted_thenStatementSucceedsWithoutNamespace", async () => {
    const { connection } = switchingPlugin({ failRead: true });
    const { sessionId } = await open(connection);

    const executed = resultOf<ExecutedStatement>(await execute(connection, sessionId, "USE archive"));

    expect(executed).not.toHaveProperty("namespace");
  });

  it("givenRollback_whenTransacted_thenReportsNamespace", async () => {
    const { connection } = switchingPlugin();
    const { sessionId } = await open(connection);
    await connection.handle({ id: 3, type: "transaction.setMode", sessionId, mode: "manual" });
    await execute(connection, sessionId, "USE archive");

    const rolledBack = resultOf<TransactionState>(
      await connection.handle({ id: 4, type: "transaction.rollback", sessionId }),
    );

    expect(rolledBack).toEqual({ mode: "manual", transactionOpen: false, namespace: ["archive"] });
  });

  it("givenCommitStatement_whenExecuted_thenReportsNamespace", async () => {
    const { connection } = switchingPlugin();
    const { sessionId } = await open(connection);
    await execute(connection, sessionId, "BEGIN");

    const committed = resultOf<ExecutedStatement>(await execute(connection, sessionId, "COMMIT"));

    expect(committed.namespace).toEqual(["main"]);
  });

  describe("exports", () => {
    const harnesses: ExportHarness[] = [];
    afterEach(async () => {
      for (const harness of harnesses.splice(0)) await harness.close();
    });

    async function exportAfter(statements: readonly string[], failRead = false): Promise<string> {
      const harness = exportHarness(DATASOURCE, [switchingPlugin({ failRead }).loaded]);
      harnesses.push(harness);
      const { sessionId } = await open(harness.connection);
      for (const sql of statements) await execute(harness.connection, sessionId, sql);
      const { handle } = resultOf<ExecutedStatement>(await execute(harness.connection, sessionId, "SELECT 1 AS a"));
      const path = join(await mkdtemp(join(tmpdir(), "table-craft-namespace-")), "a.csv");
      const task = await startExport(harness.connection, {
        source: { kind: "result", handle, columns: [0] },
        format: "csv",
        path,
      });
      await harness.finished(task.taskId);
      await rm(dirname(path), { recursive: true, force: true });
      return task.origin;
    }

    it("givenOpeningNamespace_whenReadExported_thenRerun", async () => {
      expect(await exportAfter([])).toBe("rerun");
    });

    it("givenUseRun_whenReadExported_thenHeldRowsNotARerunElsewhere", async () => {
      expect(await exportAfter(["USE archive"])).toBe("memory");
    });

    it("givenUseBackToOpening_whenReadExported_thenRerun", async () => {
      expect(await exportAfter(["USE archive", "USE main"])).toBe("rerun");
    });

    it("givenUseWhoseReadFails_whenReadExported_thenHeldRows", async () => {
      expect(await exportAfter(["USE archive"], true)).toBe("memory");
    });
  });
});
