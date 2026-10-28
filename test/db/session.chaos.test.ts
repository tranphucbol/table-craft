import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import { isPluginError, type DatasourcePlugin, type Session } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import oracle from "@table-craft/plugin-oracle";
import postgres from "@table-craft/plugin-postgres";
import { createEngine, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type { DatasourceConfig, EngineResponse, ExecutedStatement } from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { chaosProxy, type ChaosProxy } from "../support/chaosProxy.js";
import {
  MYSQL_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  databaseEnabled,
  type DatabaseId,
} from "../support/databases.js";
import { MYSQL_MANIFEST, ORACLE_MANIFEST, POSTGRES_MANIFEST } from "../support/manifests.js";

/** Plan 025: a console over a link that resets or goes silent, and a statement that overruns. */

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const KEEPALIVE_SECONDS = 1;
/** The probe's window (5 s) after one keepalive interval, with room for a loaded CI host. */
const IN_FLIGHT_LIMIT_MS = 15_000;
const PING_WAIT_MS = 2_000;
const SOCKET_CLOSE_MS = 200;
const CHAOS_TEST_TIMEOUT_MS = 60_000;

interface Target {
  readonly name: DatabaseId;
  readonly plugin: DatasourcePlugin;
  readonly loaded: PluginLoadResult;
  readonly config: Readonly<Record<string, string | number | boolean>> & { host: string; port: number };
  readonly sleep: string;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    plugin: postgres,
    loaded: { status: "loaded", directory: "plugins/postgres", manifest: POSTGRES_MANIFEST, plugin: postgres },
    config: POSTGRES_CONFIG,
    sleep: "SELECT pg_sleep(30)",
  },
  {
    name: "mysql",
    plugin: mysql,
    loaded: { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql },
    config: MYSQL_CONFIG,
    sleep: "SELECT SLEEP(30)",
  },
  {
    name: "oracle",
    plugin: oracle,
    loaded: { status: "loaded", directory: "plugins/oracle", manifest: ORACLE_MANIFEST, plugin: oracle },
    config: ORACLE_CONFIG,
    sleep: "BEGIN DBMS_SESSION.SLEEP(30); END;",
  },
];

function delay(ms: number): Promise<"waited"> {
  return new Promise((resolve) => setTimeout(() => resolve("waited"), ms));
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

for (const target of TARGETS) {
  describe.skipIf(!databaseEnabled(target.name))(
    `session chaos: ${target.name}`,
    { timeout: CHAOS_TEST_TIMEOUT_MS },
    () => {
      const cleanup: (() => Promise<unknown>)[] = [];
      afterEach(async () => {
        for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
      });

      async function proxied(): Promise<{ proxy: ChaosProxy; config: Target["config"] }> {
        const proxy = await chaosProxy(target.config);
        cleanup.push(() => proxy.close());
        return { proxy, config: { ...target.config, host: proxy.host, port: proxy.port } };
      }

      async function session(config: Target["config"]): Promise<Session> {
        const parsed = target.plugin.connectionSchema.parse(config);
        const opened = await target.plugin.connect(parsed, { readOnly: false, keepAliveInitialDelayMs: 1_000 });
        cleanup.push(() => opened.close());
        return opened;
      }

      function engine(config: Target["config"], keepAliveSeconds: number): EngineConnection {
        const datasource: DatasourceConfig = {
          id: target.name,
          pluginId: target.name,
          config,
          readOnly: false,
          keepAliveSeconds,
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

      function execute(connection: EngineConnection, sessionId: string, sql: string, timeoutSeconds?: number) {
        return connection.handle({
          id: 2,
          type: "statement.execute",
          ...PAGING,
          sessionId,
          sql,
          ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        });
      }

      it("givenReset_whenIdleThenExecute_thenConnectionLost", async () => {
        const { proxy, config } = await proxied();
        const opened = await session(config);
        proxy.reset();
        await delay(SOCKET_CLOSE_MS);

        const failure: unknown = await opened.execute("SELECT 1").then(
          () => null,
          (cause: unknown) => cause,
        );

        expect(isPluginError(failure) && failure.code).toBe("connectionLost");
      });

      it("givenBlackhole_whenPing_thenNeverAnswers", async () => {
        const { proxy, config } = await proxied();
        const opened = await session(config);
        proxy.blackhole();

        const outcome = await Promise.race([opened.ping?.().then(() => "answered"), delay(PING_WAIT_MS)]);

        expect(outcome).toBe("waited");
      });

      it("givenEngine_whenResetUnderIdleConsole_thenNextRunReconnects", async () => {
        const { proxy, config } = await proxied();
        const connection = engine(config, KEEPALIVE_SECONDS);
        const sessionId = await open(connection);
        proxy.reset();
        await delay(SOCKET_CLOSE_MS);

        const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));

        expect(result.reconnected).toBeDefined();
        expect(result.firstWindow.rows).toHaveLength(1);
      });

      it("givenEngine_whenBlackholedInFlight_thenConnectionLostWithinWindow", async () => {
        const { proxy, config } = await proxied();
        const connection = engine(config, KEEPALIVE_SECONDS);
        const sessionId = await open(connection);
        const started = Date.now();
        const pending = execute(connection, sessionId, target.sleep);
        await delay(SOCKET_CLOSE_MS);
        proxy.blackhole();

        const response = await pending;

        expect(response).toMatchObject({ type: "engine.error", error: { code: "connectionLost" } });
        expect(Date.now() - started).toBeLessThan(IN_FLIGHT_LIMIT_MS);
      });

      it("givenTimeout_whenSleep_thenStatementTimedOut", async () => {
        const connection = engine(target.config, 0);
        const sessionId = await open(connection);

        const response = await execute(connection, sessionId, target.sleep, 1);

        expect(response).toMatchObject({ type: "engine.error", error: { code: "statementTimedOut" } });
        const after = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
        expect(after).not.toHaveProperty("reconnected");
      });
    },
  );
}
