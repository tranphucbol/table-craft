import { describe, expect, it } from "vitest";
import {
  PluginError,
  type Capability,
  type DatasourcePlugin,
  type ServerSession,
  type SessionTarget,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import {
  RESULT_FETCH_ALL_CAP,
  RESULT_PAGE_ROWS,
  type EngineResponse,
  type OpenedSession,
  type SessionsListing,
} from "@table-craft/desktop/engine/protocol.js";
import { createLogger, type LogRecord } from "@table-craft/desktop/log/record.js";
import { fakeManifest, SQLITE_MANIFEST } from "../support/manifests.js";

const PLUGIN_ID = "monitored";
const CAPABILITIES: readonly Capability[] = ["sql", "schemaTree", "sessions"];
const FOREIGN_ID = "900";
const KILL_TEXT = "SELECT pg_terminate_backend(900) -- the statement nobody may log";
const SECRET_QUERY = "SELECT 'a query nobody may log'";
const HELD_SQL = "SELECT 'held'";

function row(id: string, overrides: Partial<ServerSession> = {}): ServerSession {
  return {
    id,
    instance: null,
    state: "idle",
    rawState: "idle",
    user: "someone",
    database: "main",
    client: null,
    application: null,
    queryMs: null,
    transactionMs: null,
    waitEvent: null,
    blockedBy: null,
    query: SECRET_QUERY,
    system: false,
    cancel: `SELECT pg_cancel_backend(${id})`,
    terminate: KILL_TEXT,
    ...overrides,
  };
}

const OWN_INSTANCE = "10.0.0.1:10080";
const OTHER_INSTANCE = "10.0.0.2:10080";

/** SQLite with a pretend server: every connection gets a server id, and the monitor lists them all plus a stranger. */
function monitoredEngine(
  options: {
    readOnly?: boolean;
    failStop?: string;
    instance?: string;
    /** Answers the instance through `findServerInstance` instead of `serverInstance`. */
    lookup?: boolean;
    /** Holds `HELD_SQL` until it settles. */
    held?: Promise<void>;
  } = {},
) {
  const live = new Set<string>();
  const stopped: { readonly stop: string; readonly target: SessionTarget }[] = [];
  const lookups: string[] = [];
  let next = 100;
  const plugin: DatasourcePlugin = {
    ...sqlite,
    id: PLUGIN_ID,
    capabilities: CAPABILITIES,
    connect: async (config, connectOptions) => {
      const session = await sqlite.connect(config, connectOptions);
      const serverSessionId = String(next++);
      live.add(serverSessionId);
      const stop = (name: string) => (target: SessionTarget) => {
        if (options.failStop !== undefined) return Promise.reject(new PluginError("statementFailed", options.failStop));
        stopped.push({ stop: name, target });
        return Promise.resolve();
      };
      return {
        execute: async (sql, params) => {
          if (sql === HELD_SQL) await options.held;
          return session.execute(sql, params);
        },
        ...(session.introspector === undefined ? {} : { introspector: session.introspector }),
        sessions: {
          list: () =>
            Promise.resolve({
              sessions: [
                ...[...live].map((id) => row(id, { instance: options.instance ?? null })),
                ...(options.instance === undefined ? [] : [...live].map((id) => row(id, { instance: OTHER_INSTANCE }))),
                row(FOREIGN_ID),
              ],
              notes: ["a note"],
            }),
          cancelSession: stop("cancel"),
          terminateSession: stop("terminate"),
        },
        serverSessionId,
        ...(options.instance === undefined
          ? {}
          : options.lookup === true
            ? {
                findServerInstance: () => {
                  lookups.push(serverSessionId);
                  return Promise.resolve(options.instance ?? null);
                },
              }
            : { serverInstance: options.instance }),
        serverVersion: session.serverVersion,
        close: async () => {
          live.delete(serverSessionId);
          await session.close();
        },
      };
    },
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/monitored",
    manifest: fakeManifest({ id: PLUGIN_ID, name: "Monitored", capabilities: [...CAPABILITIES] }),
    plugin,
  };
  const records: LogRecord[] = [];
  const connection = createEngine({
    datasource: {
      id: "prod",
      pluginId: PLUGIN_ID,
      config: { path: ":memory:" },
      readOnly: options.readOnly ?? false,
      keepAliveSeconds: 0,
    },
    plugins: [loaded],
    log: createLogger({ process: "engine", scope: "engine", sink: (record) => records.push(record) }),
  }).connect();
  return { connection, stopped, records, lookups };
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

function errorOf(response: EngineResponse) {
  if (response.type !== "engine.error") throw new Error(`expected an engine error, got ${response.type}`);
  return response.error;
}

describe("engine server sessions", () => {
  it("givenOwnConsole_whenList_thenTaggedWithItsSessionId", async () => {
    const { connection } = monitoredEngine();
    const { sessionId } = resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" }));

    const listing = resultOf<SessionsListing>(await connection.handle({ id: 2, type: "sessions.list" }));

    expect(listing.notes).toEqual(["a note"]);
    const own = listing.sessions.filter((session) => session.own);
    expect(own.map((session) => session.ownSessionId).sort()).toEqual([null, sessionId]);
    expect(listing.sessions.find((session) => session.id === FOREIGN_ID)).toMatchObject({
      own: false,
      ownSessionId: null,
    });
  });

  it("givenSameIdOnAnotherServer_whenList_thenOnlyOwnServersRowTagged", async () => {
    const { connection } = monitoredEngine({ instance: OWN_INSTANCE });
    const { sessionId } = resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" }));

    const listing = resultOf<SessionsListing>(await connection.handle({ id: 2, type: "sessions.list" }));

    const tagged = listing.sessions.filter((session) => session.ownSessionId === sessionId);
    expect(tagged.map((session) => session.instance)).toEqual([OWN_INSTANCE]);
    expect(listing.sessions.filter((session) => session.instance === OTHER_INSTANCE && session.own)).toEqual([]);
  });

  it("givenSameIdOnAnotherServer_whenListWithLookup_thenOnlyOwnServersRowTagged", async () => {
    const { connection, lookups } = monitoredEngine({ instance: OWN_INSTANCE, lookup: true });
    const { sessionId } = resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" }));

    const listing = resultOf<SessionsListing>(await connection.handle({ id: 2, type: "sessions.list" }));
    resultOf<SessionsListing>(await connection.handle({ id: 3, type: "sessions.list" }));

    const tagged = listing.sessions.filter((session) => session.ownSessionId === sessionId);
    expect(tagged.map((session) => session.instance)).toEqual([OWN_INSTANCE]);
    expect(listing.sessions.filter((session) => session.instance === OTHER_INSTANCE && session.own)).toEqual([]);
    expect(lookups).toHaveLength(2);
    expect(new Set(lookups).size).toBe(2);
  });

  it("givenUniqueIds_whenList_thenNoLookup", async () => {
    const { connection, lookups } = monitoredEngine({ lookup: true });
    resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" }));

    resultOf<SessionsListing>(await connection.handle({ id: 2, type: "sessions.list" }));

    expect(lookups).toEqual([]);
  });

  it("givenRunningConsole_whenListWithRepeatedId_thenNoLookupOnIt", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { connection, lookups } = monitoredEngine({ instance: OWN_INSTANCE, lookup: true, held });
    const { sessionId } = resultOf<OpenedSession>(await connection.handle({ id: 1, type: "session.open" }));
    const running = connection.handle({
      id: 2,
      type: "statement.execute",
      pageRows: RESULT_PAGE_ROWS,
      fetchAllCap: RESULT_FETCH_ALL_CAP,
      sessionId,
      sql: HELD_SQL,
    });

    const listing = resultOf<SessionsListing>(await connection.handle({ id: 3, type: "sessions.list" }));
    release();
    await running;

    expect(lookups).toHaveLength(1);
    expect(listing.sessions.filter((session) => session.ownSessionId === sessionId)).toHaveLength(2);
  });

  it("givenTerminate_whenRun_thenPluginGetsTarget", async () => {
    const { connection, stopped } = monitoredEngine();

    resultOf(
      await connection.handle({ id: 1, type: "sessions.terminate", target: { id: FOREIGN_ID, instance: null } }),
    );
    resultOf(await connection.handle({ id: 2, type: "sessions.cancel", target: { id: FOREIGN_ID, instance: "a:1" } }));

    expect(stopped).toEqual([
      { stop: "terminate", target: { id: FOREIGN_ID, instance: null } },
      { stop: "cancel", target: { id: FOREIGN_ID, instance: "a:1" } },
    ]);
  });

  it("givenReadOnlyDatasource_whenTerminate_thenInvalidRequest", async () => {
    const { connection, stopped } = monitoredEngine({ readOnly: true });

    const error = errorOf(
      await connection.handle({ id: 1, type: "sessions.terminate", target: { id: FOREIGN_ID, instance: null } }),
    );

    expect(error).toMatchObject({ code: "invalidRequest", hint: expect.stringContaining("Read-only") as unknown });
    expect(stopped).toEqual([]);
    expect(resultOf<SessionsListing>(await connection.handle({ id: 2, type: "sessions.list" })).sessions).not.toEqual(
      [],
    );
  });

  it("givenRefusedTerminate_whenRun_thenStatementFailedWithHint", async () => {
    const { connection } = monitoredEngine({
      failStop: "Could not terminate session 900: it is no longer on the server.",
    });

    const error = errorOf(
      await connection.handle({ id: 1, type: "sessions.terminate", target: { id: FOREIGN_ID, instance: null } }),
    );

    expect(error).toMatchObject({ code: "statementFailed", message: expect.stringContaining("no longer") as unknown });
  });

  it("givenSqlite_whenList_thenInvalidRequest", async () => {
    const connection = createEngine({
      datasource: { id: "s", pluginId: "sqlite", config: { path: ":memory:" }, readOnly: false, keepAliveSeconds: 0 },
      plugins: [{ status: "loaded", directory: "plugins/sqlite", manifest: SQLITE_MANIFEST, plugin: sqlite }],
    }).connect();

    expect(errorOf(await connection.handle({ id: 1, type: "sessions.list" }))).toMatchObject({
      code: "invalidRequest",
      message: expect.stringContaining("sessions capability") as unknown,
    });
    expect(
      errorOf(await connection.handle({ id: 2, type: "sessions.cancel", target: { id: "1", instance: null } })).code,
    ).toBe("invalidRequest");
  });

  it("givenTerminate_whenLogged_thenNoSqlText", async () => {
    const { connection, records } = monitoredEngine();
    await connection.handle({ id: 1, type: "sessions.list" });

    await connection.handle({ id: 2, type: "sessions.terminate", target: { id: FOREIGN_ID, instance: null } });

    expect(records.find((record) => record.msg === "terminated session")).toMatchObject({
      level: "info",
      scope: "sessions",
      requestId: 2,
      serverSession: FOREIGN_ID,
      datasourceId: "prod",
    });
    const logged = JSON.stringify(records);
    expect(logged).not.toContain("nobody may log");
    expect(logged).not.toContain("pg_terminate_backend");
  });
});
