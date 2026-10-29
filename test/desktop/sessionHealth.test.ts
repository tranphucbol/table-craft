import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginError,
  type Capability,
  type ConnectOptions,
  type DatasourcePlugin,
  type ExecuteOptions,
  type SqlLanguage,
  type StatementClass,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type {
  EngineResponse,
  ExecutedStatement,
  OpenedSession,
  TransactionState,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { fakeManifest } from "../support/manifests.js";

const PLUGIN_ID = "healthy";
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const USE = /^USE\s+(\w+)$/i;
const SLEEP = /^SLEEP$/i;
/** The fake server's own limit stopping a statement, as a plugin reports it. */
const STOPPED = /^STOPPED$/i;
const STOPPED_MESSAGE = "TestDB stopped the statement at its 1 s limit (statement_limit).";
const SERVER_TIMEOUT = { setting: "statement_limit", covers: "all", counts: "statement" } as const;
const KEEPALIVE_SECONDS = 30;
const KEEPALIVE_MS = KEEPALIVE_SECONDS * 1_000;
const ALL_CAPABILITIES: readonly Capability[] = ["sql", "cancel", "transactions", "currentNamespace", "keepAlive"];

interface Controls {
  /** The next executes reject with `connectionLost`, as a plugin does once it saw the socket close. */
  lostExecutes: number;
  pingFails: boolean;
  /** New connections never answer, as when the route to the server is blackholed. */
  connectsHang: boolean;
}

/**
 * SQLite dressed as a server plugin: it records every connect, answers ping, and runs `SLEEP` until
 * cancelled, so the engine's health checks can be driven without a network.
 */
function healthyPlugin(capabilities: readonly Capability[] = ALL_CAPABILITIES, keepAliveSeconds = KEEPALIVE_SECONDS) {
  const connects: ConnectOptions[] = [];
  const controls: Controls = { lostExecutes: 0, pingFails: false, connectsHang: false };
  const executed: string[] = [];
  /** What each execute was asked, by the session it ran on (1 for the first connect). */
  const options: { readonly session: number; readonly options: ExecuteOptions }[] = [];
  let clock = 0;
  const base = sqlite.language as SqlLanguage;
  const language: SqlLanguage = {
    ...base,
    classify: (sql): StatementClass =>
      USE.test(sql.trim()) ? { kind: "other", destructive: null, setsNamespace: true } : base.classify(sql),
  };
  const plugin: DatasourcePlugin = {
    ...sqlite,
    id: PLUGIN_ID,
    capabilities,
    language,
    connect: async (config, connectOptions) => {
      connects.push(connectOptions);
      if (controls.connectsHang) return new Promise(() => undefined);
      const session = await sqlite.connect(config, connectOptions);
      const sessionNumber = connects.length;
      let current: readonly string[] = ["main"];
      let sleeping: ((cause: unknown) => void) | null = null;
      return {
        execute: (sql, params, executeOptions = {}) => {
          options.push({ session: sessionNumber, options: executeOptions });
          if (controls.lostExecutes > 0) {
            controls.lostExecutes -= 1;
            return Promise.reject(new PluginError("connectionLost", "The connection was lost: gone."));
          }
          executed.push(sql);
          if (STOPPED.test(sql.trim())) return Promise.reject(new PluginError("timedOut", STOPPED_MESSAGE));
          if (SLEEP.test(sql.trim())) {
            return new Promise((_, reject) => {
              sleeping = reject;
            });
          }
          const target = USE.exec(sql.trim())?.[1];
          if (target === undefined) return session.execute(sql, params);
          current = [target];
          return session.execute("SELECT 1 WHERE 0");
        },
        ...(capabilities.includes("cancel")
          ? {
              cancel: () => {
                sleeping?.(new PluginError("cancelled", "cancelled"));
                sleeping = null;
                return Promise.resolve();
              },
            }
          : {}),
        ...(capabilities.includes("keepAlive")
          ? {
              ping: () =>
                controls.pingFails ? Promise.reject(new PluginError("connectionLost", "gone")) : Promise.resolve(),
            }
          : {}),
        ...(session.transactions === undefined ? {} : { transactions: session.transactions }),
        currentNamespace: () => Promise.resolve(current),
        ...(capabilities.includes("serverTimeout") ? { serverTimeout: SERVER_TIMEOUT } : {}),
        serverVersion: session.serverVersion,
        close: () => session.close(),
      };
    },
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/healthy",
    manifest: fakeManifest({ id: PLUGIN_ID, name: "Healthy", capabilities: [...capabilities] }),
    plugin,
  };
  const datasource = { id: "h", pluginId: PLUGIN_ID, config: { path: ":memory:" }, readOnly: false, keepAliveSeconds };
  const connection = createEngine({ datasource, plugins: [loaded] }, () => clock).connect();
  return {
    connection,
    connects,
    controls,
    executed,
    options,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Connection = ReturnType<typeof healthyPlugin>["connection"];

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

async function open(connection: Connection): Promise<string> {
  return resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
}

function execute(
  connection: Connection,
  sessionId: string,
  sql: string,
  timeoutSeconds?: number,
  serverEnforced?: boolean,
) {
  return connection.handle({
    id: 2,
    type: "statement.execute",
    ...PAGING,
    sessionId,
    sql,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(serverEnforced === undefined ? {} : { serverEnforced }),
  });
}

const ENFORCING: readonly Capability[] = [...ALL_CAPABILITIES, "serverTimeout"];

afterEach(() => {
  vi.useRealTimers();
});

describe("engine session health", () => {
  it("givenEveryConnect_whenEngineOpensSessions_thenKeepAliveDelayPassed", async () => {
    const { connection, connects } = healthyPlugin();
    await open(connection);
    await connection.handle({ id: 3, type: "catalog.namespaces", refresh: false });

    expect(connects.length).toBeGreaterThanOrEqual(1);
    for (const options of connects) expect(options.keepAliveInitialDelayMs).toBe(KEEPALIVE_MS);
  });

  it("givenKeepAliveOff_whenConnecting_thenNoDelay", async () => {
    const { connection, connects } = healthyPlugin(ALL_CAPABILITIES, 0);
    await open(connection);

    expect(connects).toEqual([{ readOnly: false }]);
  });

  it("givenExecuteConnectionLost_whenRun_thenReconnectsAndRunsOnce", async () => {
    const { connection, connects, controls, executed } = healthyPlugin();
    const sessionId = await open(connection);
    controls.lostExecutes = 1;

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));

    expect(result.reconnected).toEqual({ namespace: ["main"], namespaceLost: false });
    expect(executed).toEqual(["SELECT 1"]);
    expect(connects).toHaveLength(2);
  });

  it("givenReadOnlyOpen_whenReconnected_thenStillReadOnly", async () => {
    const { connection, connects, controls } = healthyPlugin(ALL_CAPABILITIES, 0);
    const opened = resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open", readOnly: true }));
    controls.lostExecutes = 1;

    resultOf<ExecutedStatement>(await execute(connection, opened.sessionId, "SELECT 1"));

    expect(connects).toEqual([{ readOnly: true }, { readOnly: true }]);
  });

  it("givenIdlePastKeepAlive_whenPingFails_thenReconnectsBeforeSending", async () => {
    const { connection, connects, controls, executed, advance } = healthyPlugin();
    const sessionId = await open(connection);
    advance(KEEPALIVE_MS);
    controls.pingFails = true;

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));

    expect(result.reconnected).toBeDefined();
    expect(executed).toEqual(["SELECT 1"]);
    expect(connects).toHaveLength(2);
  });

  it("givenIdleUnderKeepAlive_whenRun_thenNoPing", async () => {
    const { connection, connects, controls, advance } = healthyPlugin();
    const sessionId = await open(connection);
    advance(KEEPALIVE_MS - 1);
    controls.pingFails = true;

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));

    expect(result).not.toHaveProperty("reconnected");
    expect(connects).toHaveLength(1);
  });

  it("givenSwitchedNamespace_whenReconnected_thenSwitchReplayedOnEveryReconnect", async () => {
    const { connection, controls, executed } = healthyPlugin();
    const sessionId = await open(connection);
    resultOf<ExecutedStatement>(await execute(connection, sessionId, "USE archive"));
    controls.lostExecutes = 1;

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    expect(result.reconnected).toEqual({ namespace: ["archive"], namespaceLost: false });

    controls.lostExecutes = 1;
    const again = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    expect(again.reconnected).toEqual({ namespace: ["archive"], namespaceLost: false });
    expect(executed).toEqual(["USE archive", "USE archive", "SELECT 1", "USE archive", "SELECT 1"]);
  });

  it("givenSwitchReplayFails_whenReconnected_thenNamespaceLostAndOpeningReset", async () => {
    const { connection, controls } = healthyPlugin();
    const sessionId = await open(connection);
    resultOf<ExecutedStatement>(await execute(connection, sessionId, "USE archive"));
    controls.lostExecutes = 2;

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    expect(result.reconnected).toEqual({ namespace: ["main"], namespaceLost: true });

    controls.lostExecutes = 1;
    const again = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    expect(again.reconnected).toEqual({ namespace: ["main"], namespaceLost: false });
  });

  it("givenOpenTransaction_whenLost_thenFailsAndNextRunReconnects", async () => {
    const { connection, controls, executed } = healthyPlugin();
    const sessionId = await open(connection);
    resultOf<TransactionState>(
      await connection.handle({ id: 4, type: "transaction.setMode", sessionId, mode: "manual" }),
    );
    const first = resultOf<ExecutedStatement>(await execute(connection, sessionId, "CREATE TABLE t (a)"));
    expect(first.transactionOpen).toBe(true);
    controls.lostExecutes = 1;

    const failed = await execute(connection, sessionId, "INSERT INTO t VALUES (1)");
    expect(failed).toMatchObject({ type: "engine.error", error: { code: "connectionLost" } });
    expect(failed.type === "engine.error" && failed.error.message).toMatch(/transaction open/);

    const next = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    expect(next.reconnected).toBeDefined();
    expect(executed).not.toContain("INSERT INTO t VALUES (1)");
  });

  it("givenManualMode_whenReconnected_thenManualRestored", async () => {
    const { connection, controls } = healthyPlugin();
    const sessionId = await open(connection);
    resultOf<TransactionState>(
      await connection.handle({ id: 4, type: "transaction.setMode", sessionId, mode: "manual" }),
    );
    controls.lostExecutes = 1;

    resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    const created = resultOf<ExecutedStatement>(await execute(connection, sessionId, "CREATE TABLE t (a)"));

    expect(created.transactionOpen).toBe(true);
  });

  it("givenTimeout_whenStatementOverruns_thenStatementTimedOut", async () => {
    const { connection } = healthyPlugin(ALL_CAPABILITIES, 0);
    const sessionId = await open(connection);

    const response = await execute(connection, sessionId, "SLEEP", 1);

    expect(response).toMatchObject({
      type: "engine.error",
      error: { code: "statementTimedOut", message: "The statement timed out after 1 s and was cancelled." },
    });
    const after = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    expect(after).not.toHaveProperty("reconnected");
  });

  it("givenServerEnforced_whenPluginTimedOut_thenStatementTimedOutWithPluginMessage", async () => {
    const { connection, options } = healthyPlugin(ENFORCING, 0);
    const sessionId = await open(connection);

    const response = await execute(connection, sessionId, "STOPPED", 1, true);

    expect(options.at(-1)?.options).toEqual({ serverTimeoutMs: 1_000 });
    expect(response).toMatchObject({ type: "engine.error", error: { code: "statementTimedOut", message: STOPPED_MESSAGE } });
    expect(response.type === "engine.error" ? response.error.hint : "").toMatch(/raise the statement timeout/);
    resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
  });

  it("givenNoCapability_whenServerEnforced_thenNoServerTimeoutMsSent", async () => {
    const { connection, options } = healthyPlugin(ALL_CAPABILITIES, 0);
    const sessionId = await open(connection);

    resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1", 30, true));

    expect(options.at(-1)?.options).not.toHaveProperty("serverTimeoutMs");
  });

  it("givenReconnect_whenServerEnforced_thenNewSessionGetsLimit", async () => {
    const { connection, controls, options } = healthyPlugin(ENFORCING, 0);
    const sessionId = await open(connection);
    controls.lostExecutes = 1;

    resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1", 30, true));

    expect(options.at(-1)).toEqual({ session: 2, options: { serverTimeoutMs: 30_000 } });
  });

  it("givenTimeout_whenPluginLacksCancel_thenIgnored", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { connection } = healthyPlugin(["sql", "transactions", "currentNamespace"], 0);
    const sessionId = await open(connection);
    let settled = false;

    void execute(connection, sessionId, "SLEEP", 1).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(settled).toBe(false);
  });

  it("givenNamespaceReadAfterStatement_whenTimeoutShort_thenNotCut", async () => {
    const { connection } = healthyPlugin(ALL_CAPABILITIES, 0);
    const sessionId = await open(connection);

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "USE archive", 1));

    expect(result.namespace).toEqual(["archive"]);
  });

  it("givenProbeUnanswered_whenStatementInFlight_thenConnectionLostAndNextRunReconnects", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { connection, controls, connects } = healthyPlugin();
    const sessionId = await open(connection);

    const pending = execute(connection, sessionId, "SLEEP");
    controls.connectsHang = true;
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS + 5_000);
    const response = await pending;

    expect(response).toMatchObject({ type: "engine.error", error: { code: "connectionLost" } });
    expect(response.type === "engine.error" && response.error.message).toMatch(/may have completed/);
    controls.connectsHang = false;
    vi.useRealTimers();
    const next = resultOf<ExecutedStatement>(await execute(connection, sessionId, "SELECT 1"));
    expect(next.reconnected).toBeDefined();
    expect(connects.length).toBe(3);
  });
});
