import { describe, expect, it } from "vitest";
import {
  PluginError,
  type CancelReach,
  type Capability,
  type DatasourcePlugin,
  type Row,
  type Session,
  type TransactionMode,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type { EngineResponse, ExecutedStatement, TransactionState } from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { createLogger, type LogRecord } from "@table-craft/desktop/log/record.js";
import { fakeManifest } from "../support/manifests.js";

const PLUGIN_ID = "slowclose";
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const CAPABILITIES: readonly Capability[] = ["sql", "cancel", "transactions", "currentNamespace"];
const CANCEL_REACH: CancelReach = { method: "test cancel", reaches: "statement" };
const MANY_ROWS = RESULT_PAGE_ROWS * 4;
const SLOW_CLOSE_MS = 100;
/** The engine's `CURSOR_CLOSE_GRACE_MS` with room for a loaded host. */
const GRACE_LIMIT_MS = 8_000;
const GRACE_TEST_TIMEOUT_MS = 15_000;
const BUSY_MESSAGE = "Another statement is still running in this session.";

interface Controls {
  /** How the next abandoned result closes: after a delay, or never. */
  close: "slow" | "never";
  /** The next execute rejects `sessionBusy` though nothing runs, as a plugin bug would. */
  busyOnce: boolean;
}

/**
 * A server plugin whose abandoned results take time to close, like MySQL reading the rest of a
 * result off the wire: until the close finishes, the session refuses another statement.
 */
function slowClosePlugin() {
  const controls: Controls = { close: "slow", busyOnce: false };
  const executed: string[] = [];
  let connects = 0;
  const plugin: DatasourcePlugin = {
    ...sqlite,
    id: PLUGIN_ID,
    capabilities: CAPABILITIES,
    connect: () => {
      connects += 1;
      let busy = false;
      let mode: TransactionMode = "auto";
      let open = false;
      let waiting: ((cause: Error) => void) | null = null;
      async function* rows(count: number): AsyncGenerator<Row> {
        let done = false;
        try {
          for (let index = 0; index < count; index += 1) yield [index];
          done = true;
        } finally {
          if (!done) {
            await new Promise<void>((resolve) => {
              if (controls.close === "slow") setTimeout(resolve, SLOW_CLOSE_MS);
            });
          }
          busy = false;
        }
      }
      const session: Session = {
        execute: (sql) => {
          if (controls.busyOnce) {
            controls.busyOnce = false;
            return Promise.reject(new PluginError("sessionBusy", BUSY_MESSAGE));
          }
          if (busy) return Promise.reject(new PluginError("sessionBusy", BUSY_MESSAGE));
          executed.push(sql);
          if (mode === "manual") open = true;
          if (sql === "SLEEP") {
            busy = true;
            return new Promise((_, reject) => {
              waiting = (cause) => {
                busy = false;
                reject(cause);
              };
            });
          }
          busy = true;
          return Promise.resolve({
            columns: [{ name: "n", type: "integer" }],
            rows: rows(sql === "MANY" ? MANY_ROWS : 1),
            rowsAffected: null,
          });
        },
        services: {
          cancel: {
            cancel: () => {
              waiting?.(new PluginError("cancelled", "The statement was cancelled."));
              waiting = null;
              return Promise.resolve();
            },
            reach: CANCEL_REACH,
          },
          transactions: {
            setMode: (next) => {
              mode = next;
              return Promise.resolve();
            },
            commit: () => {
              if (busy) return Promise.reject(new PluginError("sessionBusy", BUSY_MESSAGE));
              open = false;
              return Promise.resolve();
            },
            rollback: () => {
              open = false;
              return Promise.resolve();
            },
            get mode() {
              return mode;
            },
            get open() {
              return open;
            },
          },
          currentNamespace: {
            current: () =>
              busy ? Promise.reject(new PluginError("sessionBusy", BUSY_MESSAGE)) : Promise.resolve(["main"]),
          },
        },
        close: () => Promise.resolve(),
        serverVersion: "1",
      };
      return Promise.resolve(session);
    },
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/slowclose",
    manifest: fakeManifest({ id: PLUGIN_ID, name: "Slow close", capabilities: [...CAPABILITIES] }),
    plugin,
  };
  const records: LogRecord[] = [];
  const datasource = {
    id: "s",
    pluginId: PLUGIN_ID,
    config: { path: ":memory:" },
    readOnly: false,
    keepAliveSeconds: 0,
  };
  const connection = createEngine({
    datasource,
    plugins: [loaded],
    log: createLogger({ process: "engine", scope: "engine", sink: (record) => records.push(record) }),
  }).connect();
  return { connection, controls, executed, records, connects: () => connects };
}

type Connection = ReturnType<typeof slowClosePlugin>["connection"];

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

async function open(connection: Connection): Promise<string> {
  return resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
}

function execute(connection: Connection, sessionId: string, sql: string) {
  return connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql });
}

async function unfinished(connection: Connection, sessionId: string): Promise<string> {
  const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "MANY"));
  expect(result.cursorOpen).toBe(true);
  return result.handle;
}

function releaseWithoutWaiting(connection: Connection, handle: string): void {
  void connection.handle({ id: 3, type: "result.release", handle });
}

describe("engine cursor close ordering", () => {
  it("givenUnfinishedResult_whenReleasedThenRunAtOnce_thenTheRunWaitsAndSucceeds", async () => {
    const { connection } = slowClosePlugin();
    const sessionId = await open(connection);
    releaseWithoutWaiting(connection, await unfinished(connection, sessionId));

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "ONE"));

    expect(result.firstWindow.rows).toEqual([[0]]);
    expect(result).not.toHaveProperty("reconnected");
  });

  it("givenUnfinishedResult_whenReleasedThenCommit_thenTheCommitWaits", async () => {
    const { connection } = slowClosePlugin();
    const sessionId = await open(connection);
    resultOf(await connection.handle({ id: 4, type: "transaction.setMode", sessionId, mode: "manual" }));
    releaseWithoutWaiting(connection, await unfinished(connection, sessionId));

    const state = resultOf<TransactionState>(await connection.handle({ id: 5, type: "transaction.commit", sessionId }));

    expect(state.transactionOpen).toBe(false);
  });

  it("givenCloseInFlight_whenCancelBeforeTheRunStarts_thenTheRunIsCancelled", async () => {
    const { connection, executed } = slowClosePlugin();
    const sessionId = await open(connection);
    releaseWithoutWaiting(connection, await unfinished(connection, sessionId));

    const pending = execute(connection, sessionId, "ONE");
    await connection.handle({ id: 6, type: "statement.cancel", sessionId });
    const response = await pending;

    expect(response).toMatchObject({ type: "engine.error", error: { code: "cancelled" } });
    expect(executed).toEqual(["MANY"]);
  });

  it(
    "givenCloseNeverSettles_whenRun_thenReconnectsWithinTheGrace",
    async () => {
      const { connection, controls, connects } = slowClosePlugin();
      const sessionId = await open(connection);
      controls.close = "never";
      releaseWithoutWaiting(connection, await unfinished(connection, sessionId));
      const started = Date.now();

      const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "ONE"));

      expect(Date.now() - started).toBeLessThan(GRACE_LIMIT_MS);
      expect(result.reconnected).toMatchObject({ reason: "resultNotClosed" });
      expect(result.firstWindow.rows).toEqual([[0]]);
      expect(connects()).toBe(2);
    },
    GRACE_TEST_TIMEOUT_MS,
  );

  it(
    "givenCloseNeverSettlesInTransaction_whenRun_thenTransactionLost",
    async () => {
      const { connection, controls } = slowClosePlugin();
      const sessionId = await open(connection);
      resultOf(await connection.handle({ id: 4, type: "transaction.setMode", sessionId, mode: "manual" }));
      controls.close = "never";
      releaseWithoutWaiting(connection, await unfinished(connection, sessionId));

      const response = await execute(connection, sessionId, "ONE");

      expect(response).toMatchObject({ type: "engine.error", error: { code: "connectionLost" } });
      const after = resultOf<ExecutedStatement>(await execute(connection, sessionId, "ONE"));
      expect(after.reconnected).toBeDefined();
    },
    GRACE_TEST_TIMEOUT_MS,
  );

  it("givenPluginBusyUnexpectedly_whenRun_thenLoggedAsBugAndRunOnAFreshSession", async () => {
    const { connection, controls, records, executed } = slowClosePlugin();
    const sessionId = await open(connection);
    controls.busyOnce = true;

    const result = resultOf<ExecutedStatement>(await execute(connection, sessionId, "ONE"));

    expect(result.reconnected).toMatchObject({ reason: "sessionBusy" });
    expect(executed).toEqual(["ONE"]);
    expect(records.some((record) => record.level === "error" && record.msg === "session busy")).toBe(true);
  });
});
