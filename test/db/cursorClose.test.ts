import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import { createEngine, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type {
  DatasourceConfig,
  EngineResponse,
  ExecutedStatement,
  TransactionState,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import {
  MYSQL_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  TIDB_CONFIG,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import { MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";
import { oracleRows, tenThousandRows } from "../support/manyRows.js";

/** Plan 027: a console that runs again while its previous result still has rows to send. */

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const RUNS_IN_A_ROW = 3;

interface Target {
  readonly name: DatabaseId;
  readonly pluginId: string;
  readonly loaded: PluginLoadResult;
  readonly config: DatasourceConfig["config"];
  readonly manyRows: string;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    pluginId: "postgres",
    loaded: { status: "loaded", directory: "plugins/postgres", manifest: POSTGRES_MANIFEST, plugin: postgres },
    config: POSTGRES_CONFIG,
    manyRows: tenThousandRows(),
  },
  {
    name: "mysql",
    pluginId: "mysql",
    loaded: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: MYSQL_CONFIG,
    manyRows: tenThousandRows(),
  },
  {
    name: "tidb",
    pluginId: "mysql",
    loaded: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: TIDB_CONFIG,
    manyRows: tenThousandRows(),
  },
  {
    name: "oracle",
    pluginId: "oracle",
    loaded: { status: "loaded", directory: "plugins/oracle", manifest: ORACLE_MANIFEST, plugin: oracle },
    config: ORACLE_CONFIG,
    manyRows: oracleRows(10_000),
  },
];

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

for (const target of TARGETS) {
  describe.skipIf(!databaseEnabled(target.name))(`cursor close ordering: ${target.name}`, () => {
    const cleanup: (() => Promise<unknown>)[] = [];
    afterEach(async () => {
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
    });

    function engine(): EngineConnection {
      const datasource: DatasourceConfig = {
        id: target.name,
        pluginId: target.pluginId,
        config: target.config,
        readOnly: false,
        keepAliveSeconds: 0,
      };
      const created = createEngine({ datasource, plugins: [target.loaded] });
      const connection = created.connect();
      cleanup.push(() => created.close());
      cleanup.push(() => connection.close());
      return connection;
    }

    async function open(connection: EngineConnection): Promise<string> {
      return resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
    }

    async function unfinished(connection: EngineConnection, sessionId: string): Promise<string> {
      const response = await connection.handle({
        id: 2,
        type: "statement.execute",
        ...PAGING,
        sessionId,
        sql: target.manyRows,
      });
      const result = resultOf<ExecutedStatement>(response);
      expect(result).toMatchObject({ rowCount: RESULT_PAGE_ROWS, complete: false, cursorOpen: true });
      return result.handle;
    }

    function releaseWithoutWaiting(connection: EngineConnection, handle: string): void {
      void connection.handle({ id: 3, type: "result.release", handle });
    }

    it("givenUnfinishedResult_whenReleasedThenRunAtOnce_thenTheRunWaitsAndSucceeds", async () => {
      const connection = engine();
      const sessionId = await open(connection);
      for (let run = 0; run < RUNS_IN_A_ROW; run += 1) {
        const handle = await unfinished(connection, sessionId);
        releaseWithoutWaiting(connection, handle);

        const response = await connection.handle({
          id: 4,
          type: "statement.execute",
          ...PAGING,
          sessionId,
          sql: "SELECT 1",
        });

        expect(resultOf<ExecutedStatement>(response).firstWindow.rows).toHaveLength(1);
      }
    });

    it("givenUnfinishedResultInManualMode_whenReleasedThenCommit_thenCommits", async () => {
      const connection = engine();
      const sessionId = await open(connection);
      resultOf(await connection.handle({ id: 5, type: "transaction.setMode", sessionId, mode: "manual" }));
      const handle = await unfinished(connection, sessionId);
      releaseWithoutWaiting(connection, handle);

      const state = resultOf<TransactionState>(
        await connection.handle({ id: 6, type: "transaction.commit", sessionId }),
      );

      expect(state.transactionOpen).toBe(false);
    });

    it("givenUnfinishedResult_whenReleasedThenExplain_thenExplains", async () => {
      const connection = engine();
      const sessionId = await open(connection);
      const handle = await unfinished(connection, sessionId);
      releaseWithoutWaiting(connection, handle);

      const response = await connection.handle({
        id: 7,
        type: "statement.explain",
        sessionId,
        sql: "SELECT 1",
        analyze: false,
      });

      expect(response.type).toBe("statement.explain");
    });
  });
}
