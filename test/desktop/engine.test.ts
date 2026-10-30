import { describe, expect, it } from "vitest";
import {
  PluginError,
  TlsSettingsError,
  z,
  type DatasourcePlugin,
  type Routine,
  type Session,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine, probeDatasource } from "@table-craft/desktop/engine/engine.js";
import { createLifetime } from "@table-craft/desktop/engine/lifetime.js";
import type {
  ClassifiedStatement,
  DescribedCatalog,
  EngineResponse,
  ExecutedStatement,
  Explainability,
  ExplainedStatement,
  FormatOptions,
  FoundMatch,
  Namespace,
  ResultState,
  ResultWindow,
  RoutineCall,
  SelectionAggregates,
  TransactionState,
  ViewState,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS, RESULT_WINDOW_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { fakeManifest, SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const SQLITE_DIRECTORY = "plugins/sqlite";
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: SQLITE_DIRECTORY,
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};
const DATASOURCE = {
  id: "scratch",
  pluginId: "sqlite",
  config: { path: ":memory:" },
  readOnly: false,
  keepAliveSeconds: 0,
};
const ROWS_1200 = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200) SELECT i FROM n";

const CANCELLABLE_ID = "cancellable";
const VERSION = /^\d+\.\d+/;
const FORMAT_OPTIONS: FormatOptions = {
  style: "aligned",
  keywordCase: "upper",
  indentWidth: 2,
  linesBetweenStatements: 1,
  alignAliases: true,
};

/** Its one statement runs until cancelled; enough to drive `statement.cancel` without a database. */
function cancellablePlugin(): { plugin: DatasourcePlugin; cancels: () => number } {
  let cancels = 0;
  let stop: (() => void) | null = null;
  const session: Session = {
    execute: () =>
      new Promise((_resolve, reject) => {
        stop = () => reject(new PluginError("cancelled", "cancelled by the test"));
      }),
    cancel: () => {
      cancels += 1;
      stop?.();
      stop = null;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
    serverVersion: null,
  };
  const plugin: DatasourcePlugin = {
    id: CANCELLABLE_ID,
    capabilities: ["sql", "cancel"],
    connectionSchema: z.object({}),
    connect: () => Promise.resolve(session),
  };
  return { plugin, cancels: () => cancels };
}

function connectedToCancellable(plugin: DatasourcePlugin) {
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/cancellable",
    manifest: fakeManifest({ id: CANCELLABLE_ID, name: "Cancellable", capabilities: ["sql", "cancel"] }),
    plugin,
  };
  return createEngine({
    datasource: { id: "c", pluginId: CANCELLABLE_ID, config: {}, readOnly: false, keepAliveSeconds: 0 },
    plugins: [loaded],
  }).connect();
}

function connected() {
  return createEngine({ datasource: DATASOURCE, plugins: [LOADED_SQLITE] }).connect();
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

async function openSession(connection: ReturnType<typeof connected>): Promise<string> {
  return resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
}

describe("engine", () => {
  it("givenOpenSession_whenSelectOneExecuted_thenRespondsWithColumnsAndFirstWindow", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELECT 1 AS one, 'two' AS two",
    });

    expect(response.id).toBe(2);
    const executed = resultOf<ExecutedStatement>(response);
    expect(executed.columns.map((column) => column.name)).toEqual(["one", "two"]);
    expect(executed.rowCount).toBe(1);
    expect(executed.firstWindow).toEqual({ offset: 0, rows: [[1, "two"]] });
  });

  it("givenResultOf1200Rows_whenWindowRequestedAt1000_thenReturns200Rows", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle, firstWindow } = resultOf<ExecutedStatement>(
      await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql: ROWS_1200 }),
    );
    expect(firstWindow.rows).toHaveLength(RESULT_WINDOW_ROWS);
    await connection.handle({ id: 3, type: "result.fetchMore", ...PAGING, handle, all: true });

    const window = resultOf<ResultWindow>(
      await connection.handle({ id: 3, type: "result.window", handle, offset: 1000, limit: RESULT_WINDOW_ROWS }),
    );

    expect(window.rows).toHaveLength(200);
    expect(window.rows[0]).toEqual([1001]);
  });

  it("givenReleasedHandle_whenWindowRequested_thenUnknownHandleError", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle } = resultOf<ExecutedStatement>(
      await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql: "SELECT 1" }),
    );
    await connection.handle({ id: 3, type: "result.release", handle });

    const response = await connection.handle({ id: 4, type: "result.window", handle, offset: 0, limit: 1 });

    expect(response).toMatchObject({ id: 4, type: "engine.error", error: { code: "unknownHandle" } });
  });

  it("givenHandleFromAnotherConnection_whenWindowRequested_thenUnknownHandleError", async () => {
    const engine = createEngine({ datasource: DATASOURCE, plugins: [LOADED_SQLITE] });
    const owner = engine.connect();
    const sessionId = resultOf<{ sessionId: string }>(await owner.handle({ id: 1, type: "session.open" })).sessionId;
    const { handle } = resultOf<ExecutedStatement>(
      await owner.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql: "SELECT 1" }),
    );

    const response = await engine.connect().handle({ id: 1, type: "result.window", handle, offset: 0, limit: 1 });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "unknownHandle" } });
  });

  it("givenInvalidSql_whenExecuted_thenStatementFailedWithHint", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELEC 1",
    });

    expect(response).toMatchObject({ id: 2, type: "engine.error", error: { code: "statementFailed" } });
    if (response.type === "engine.error") expect(response.error.hint).not.toBe("");
  });

  it("givenSyntaxError_whenExecuted_thenErrorCarriesOffsetIntoTheSentSql", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const sql = "SELECT 1\nFROM t ORDER x";

    const response = await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql });

    expect(response).toMatchObject({ type: "engine.error", error: { position: sql.indexOf("x") } });
  });

  it("givenBoundParametersRewroteTheSql_whenItFails_thenNoPosition", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELECT :v ORDER x",
      parameters: { ":v": "1" },
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "statementFailed" } });
    expect(response.type === "engine.error" && response.error.position).toBeUndefined();
  });

  it("givenUnknownSession_whenExecuted_thenUnknownSessionError", async () => {
    const response = await connected().handle({
      id: 7,
      type: "statement.execute",
      ...PAGING,
      sessionId: "nope",
      sql: "SELECT 1",
    });

    expect(response).toMatchObject({ id: 7, type: "engine.error", error: { code: "unknownSession" } });
  });

  it("givenMalformedRequest_whenHandled_thenInvalidRequestErrorKeepsTheId", async () => {
    const response = await connected().handle({ id: 9, type: "result.window", handle: "result-1" });

    expect(response).toMatchObject({ id: 9, type: "engine.error", error: { code: "invalidRequest" } });
  });

  it("givenUnavailablePlugin_whenSessionOpened_thenPluginUnavailableError", async () => {
    const connection = createEngine({
      datasource: DATASOURCE,
      plugins: [
        { status: "unavailable", directory: SQLITE_DIRECTORY, manifest: LOADED_SQLITE.manifest, reason: "broken" },
      ],
    }).connect();

    const response = await connection.handle({ id: 1, type: "session.open" });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "pluginUnavailable" } });
  });

  it("givenClosedConnection_whenItsHandleRequestedAgain_thenConnectionClosedError", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle } = resultOf<ExecutedStatement>(
      await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql: "SELECT 1" }),
    );

    await connection.close();
    const response = await connection.handle({ id: 3, type: "result.window", handle, offset: 0, limit: 1 });

    expect(response).toMatchObject({
      id: 3,
      type: "engine.error",
      error: { code: "connectionLost", message: "This engine connection has closed." },
    });
  });

  it("givenSessionOpened_whenAnswered_thenCarriesPluginNameAndCapabilities", async () => {
    const response = await connected().handle({ id: 1, type: "session.open" });

    expect(resultOf(response)).toMatchObject({
      pluginName: "SQLite",
      capabilities: ["sql", "schemaTree", "transactions", "ddl", "explain", "bulkInsert", "objects"],
    });
  });

  it("givenSessionOpened_whenAnswered_thenCarriesServerVersion", async () => {
    const response = await connected().handle({ id: 1, type: "session.open" });

    expect(resultOf<{ serverVersion: string }>(response).serverVersion).toMatch(VERSION);
  });

  it("givenReadOnlyDatasource_whenWriting_thenStatementFailedWithReadOnlyHint", async () => {
    const connection = createEngine({
      datasource: { ...DATASOURCE, readOnly: true, keepAliveSeconds: 0 },
      plugins: [LOADED_SQLITE],
    }).connect();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "CREATE TABLE t (n INTEGER)",
    });

    expect(response).toMatchObject({
      type: "engine.error",
      error: { code: "statementFailed", hint: expect.stringMatching(/read-only/) as unknown },
    });
  });

  it("givenReadOnlyOpen_whenWritingOnWritableDatasource_thenServerRefuses", async () => {
    const connection = connected();
    const opened = resultOf<{ sessionId: string }>(
      await connection.handle({ id: 1, type: "session.open", readOnly: true }),
    );

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId: opened.sessionId,
      sql: "CREATE TABLE agent_probe (n INTEGER)",
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "statementFailed" } });
  });

  it("givenReadOnlyFalse_whenDatasourceReadOnly_thenSessionStaysReadOnly", async () => {
    const connection = createEngine({
      datasource: { ...DATASOURCE, readOnly: true, keepAliveSeconds: 0 },
      plugins: [LOADED_SQLITE],
    }).connect();
    const opened = resultOf<{ sessionId: string }>(
      await connection.handle({ id: 1, type: "session.open", readOnly: false }),
    );

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId: opened.sessionId,
      sql: "CREATE TABLE agent_probe (n INTEGER)",
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "statementFailed" } });
  });

  it("givenUnreachableDatabase_whenSessionOpened_thenConnectionFailedError", async () => {
    const connection = createEngine({
      datasource: { ...DATASOURCE, config: { path: "/nonexistent-table-craft-directory/db.sqlite" } },
      plugins: [LOADED_SQLITE],
    }).connect();

    const response = await connection.handle({ id: 1, type: "session.open" });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "connectionFailed" } });
  });

  it("givenCancelRequest_whenEngineHasNoCancelCapability_thenInvalidRequestError", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({ id: 2, type: "statement.cancel", sessionId });

    expect(response).toMatchObject({ id: 2, type: "engine.error", error: { code: "invalidRequest" } });
  });

  it("givenRunningStatement_whenCancelled_thenExecuteFailsWithCancelled", async () => {
    const { plugin, cancels } = cancellablePlugin();
    const connection = connectedToCancellable(plugin);
    const sessionId = await openSession(connection);
    const running = connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELECT forever()",
    });

    const cancelled = await connection.handle({ id: 3, type: "statement.cancel", sessionId });

    expect(cancelled).toEqual({ id: 3, type: "statement.cancel", result: null });
    expect(await running).toMatchObject({ id: 2, type: "engine.error", error: { code: "cancelled" } });
    expect(cancels()).toBe(1);
  });

  it("givenOpenSession_whenClosed_thenItsHandlesAreReleased", async () => {
    const connection = connected();
    const closing = await openSession(connection);
    const kept = await openSession(connection);
    const { handle: closedHandle } = resultOf<ExecutedStatement>(
      await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId: closing, sql: "SELECT 1" }),
    );
    const { handle: keptHandle } = resultOf<ExecutedStatement>(
      await connection.handle({ id: 3, type: "statement.execute", ...PAGING, sessionId: kept, sql: "SELECT 2" }),
    );

    const closed = await connection.handle({ id: 4, type: "session.close", sessionId: closing });

    expect(closed).toEqual({ id: 4, type: "session.close", result: null });
    expect(
      await connection.handle({ id: 5, type: "result.window", handle: closedHandle, offset: 0, limit: 1 }),
    ).toMatchObject({ type: "engine.error", error: { code: "unknownHandle" } });
    expect(
      resultOf<ResultWindow>(
        await connection.handle({ id: 6, type: "result.window", handle: keptHandle, offset: 0, limit: 1 }),
      ).rows,
    ).toEqual([[2]]);
  });

  it("givenClosedSession_whenExecuted_thenUnknownSessionError", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    await connection.handle({ id: 2, type: "session.close", sessionId });

    const response = await connection.handle({
      id: 3,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELECT 1",
    });

    expect(response).toMatchObject({ id: 3, type: "engine.error", error: { code: "unknownSession" } });
  });

  it("givenIdleSession_whenCancelled_thenAnswersNullWithoutCallingThePlugin", async () => {
    const { plugin, cancels } = cancellablePlugin();
    const connection = connectedToCancellable(plugin);
    const sessionId = await openSession(connection);

    const response = await connection.handle({ id: 2, type: "statement.cancel", sessionId });

    expect(response).toEqual({ id: 2, type: "statement.cancel", result: null });
    expect(cancels()).toBe(0);
  });
});

/** The seeded fixture, through a plugin that counts the sessions it opens and closes. */
function countingSqlite(brokenSessions = 0): {
  engine: ReturnType<typeof createEngine>;
  opened: () => number;
  closed: () => number;
} {
  let opened = 0;
  let closed = 0;
  const plugin: DatasourcePlugin = {
    ...sqlite,
    connect: async (config, options) => {
      opened += 1;
      const session = await sqlite.connect(config, options);
      const lost = (): never => {
        throw new PluginError("introspectionFailed", "Client has encountered a connection error and is not queryable");
      };
      return {
        execute: (sql) => session.execute(sql),
        introspector:
          opened <= brokenSessions && session.introspector !== undefined
            ? { ...session.introspector, namespaces: lost, describe: lost }
            : session.introspector,
        serverVersion: session.serverVersion,
        close: () => {
          closed += 1;
          return session.close();
        },
      };
    },
  };
  const engine = createEngine({
    datasource: {
      id: "seeded",
      pluginId: "sqlite",
      config: { path: seededSqliteFile() },
      readOnly: false,
      keepAliveSeconds: 0,
    },
    plugins: [{ status: "loaded", directory: SQLITE_DIRECTORY, manifest: SQLITE_MANIFEST, plugin }],
  });
  return { engine, opened: () => opened, closed: () => closed };
}

describe("engine catalog", () => {
  it("givenSchemaTreeDatasource_whenNamespacesRequested_thenMainIsCurrent", async () => {
    const { engine } = countingSqlite();

    const namespaces = resultOf<Namespace[]>(await engine.connect().handle({ id: 1, type: "catalog.namespaces" }));

    expect(namespaces.filter((namespace) => namespace.current).map((namespace) => namespace.path)).toEqual([["main"]]);
  });

  it("givenTwoConnections_whenBothDescribe_thenOneIntrospectionSessionAndOneRead", async () => {
    const { engine, opened } = countingSqlite();
    const [first, second] = [engine.connect(), engine.connect()];

    const [left, right] = await Promise.all([
      first.handle({ id: 1, type: "catalog.describe", path: ["main"] }),
      second.handle({ id: 1, type: "catalog.describe", path: ["main"] }),
    ]);

    expect(opened()).toBe(1);
    expect(resultOf<DescribedCatalog>(left).introspectedAt).toBe(resultOf<DescribedCatalog>(right).introspectedAt);
    expect(resultOf<DescribedCatalog>(left).catalog.relations.map((relation) => relation.name)).toContain("orders");
  });

  it("givenIntrospectionLinkDropped_whenDescribed_thenFreshSessionAnswers", async () => {
    const { engine, opened, closed } = countingSqlite(1);

    const response = await engine.connect().handle({ id: 1, type: "catalog.describe", path: ["main"] });

    expect(resultOf<DescribedCatalog>(response).catalog.relations.map((relation) => relation.name)).toContain("orders");
    expect([opened(), closed()]).toEqual([2, 1]);
  });

  it("givenUnknownNamespace_whenDescribed_thenIntrospectionFailedWithHint", async () => {
    const { engine } = countingSqlite();

    const response = await engine.connect().handle({ id: 4, type: "catalog.describe", path: ["nowhere"] });

    expect(response).toMatchObject({ id: 4, type: "engine.error", error: { code: "introspectionFailed" } });
    expect(response.type === "engine.error" && response.error.hint).toMatch(/Synchronize/);
  });

  it("givenQualifiedNameRequest_whenAnswered_thenPluginQuotes", async () => {
    const { engine } = countingSqlite();

    const response = await engine
      .connect()
      .handle({ id: 5, type: "catalog.qualifiedName", path: ["main"], name: "orders" });

    expect(resultOf<string>(response)).toBe('"main"."orders"');
  });

  it("givenIntrospectionSession_whenEngineClosed_thenItIsClosed", async () => {
    const { engine, opened, closed } = countingSqlite();
    await engine.connect().handle({ id: 1, type: "catalog.namespaces" });

    await engine.close();

    expect([opened(), closed()]).toEqual([1, 1]);
  });

  it("givenEmptyPath_whenDescribed_thenInvalidRequest", async () => {
    const { engine } = countingSqlite();

    const response = await engine.connect().handle({ id: 6, type: "catalog.describe", path: [] });

    expect(response).toMatchObject({ id: 6, type: "engine.error", error: { code: "invalidRequest" } });
  });

  it("givenDdlDatasource_whenDefinitionRequested_thenReadsTheDatabaseEveryTime", async () => {
    const { engine } = countingSqlite();
    const connection = engine.connect();
    const first = resultOf<string>(
      await connection.handle({ id: 7, type: "catalog.definition", path: ["main"], name: "orders" }),
    );
    const sessionId = await openSession(connection);
    await connection.handle({
      id: 8,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "CREATE INDEX orders_total_idx ON orders (total)",
    });

    const second = resultOf<string>(
      await connection.handle({ id: 9, type: "catalog.definition", path: ["main"], name: "orders" }),
    );

    expect(first).toMatch(/^CREATE TABLE orders \(/);
    expect(first).toContain("CREATE INDEX orders_placed_at_idx ON orders (placed_at);");
    expect(second).toContain("CREATE INDEX orders_total_idx ON orders (total);");
  });

  it("givenUnknownRelation_whenDefinitionRequested_thenDefinitionNotFoundWithSynchronizeHint", async () => {
    const { engine } = countingSqlite();

    const response = await engine
      .connect()
      .handle({ id: 10, type: "catalog.definition", path: ["main"], name: "gone" });

    expect(response).toMatchObject({ id: 10, type: "engine.error", error: { code: "definitionNotFound" } });
    expect(response.type === "engine.error" && response.error.hint).toMatch(/Synchronize/);
  });

  it("givenGenerateRequest_whenAnswered_thenPluginWritesTheStatementFromTheCatalog", async () => {
    const { engine } = countingSqlite();
    const connection = engine.connect();

    const select = await connection.handle({
      id: 11,
      type: "sql.generate",
      path: ["main"],
      name: "orders",
      statement: "select",
    });
    const create = await connection.handle({
      id: 12,
      type: "sql.generate",
      path: ["main"],
      name: "customer_totals",
      statement: "create",
    });

    expect(resultOf<string>(select)).toBe('SELECT id, customer_id, total, placed_at\nFROM "main"."orders";');
    expect(resultOf<string>(create)).toMatch(/^CREATE VIEW customer_totals AS/);
  });

  it("givenUnknownStatement_whenGenerating_thenInvalidRequest", async () => {
    const { engine } = countingSqlite();

    const response = await engine
      .connect()
      .handle({ id: 13, type: "sql.generate", path: ["main"], name: "orders", statement: "delete" });

    expect(response).toMatchObject({ id: 13, type: "engine.error", error: { code: "invalidRequest" } });
  });
});

describe("engine routine.call", () => {
  const ROUTINE: Routine = {
    name: "calc_fee",
    kind: "function",
    signature: "amount numeric",
    parameters: [{ name: "amount", type: "numeric", mode: "in", hasDefault: false }],
    returns: "numeric",
  };

  /** SQLite with one described routine and a language that writes what it was handed. */
  function routineEngine(): ReturnType<typeof createEngine> {
    const language = sqlite.language;
    if (language === undefined) throw new Error("sqlite declares sql");
    const plugin: DatasourcePlugin = {
      ...sqlite,
      capabilities: [...sqlite.capabilities, "routineCall"],
      language: {
        ...language,
        routineCall: (routine, qualified, args) => {
          if (args.length !== routine.parameters.length) throw new PluginError("statementFailed", "wrong count");
          return {
            sql: `SELECT ${qualified}(:amount);`,
            params: { ":amount": args[0]?.kind === "value" ? args[0].value : null },
          };
        },
      },
      connect: async (config, options) => {
        const session = await sqlite.connect(config, options);
        const introspector = session.introspector;
        if (introspector === undefined) throw new Error("sqlite declares schemaTree");
        return {
          ...session,
          execute: (sql, params, executeOptions) => session.execute(sql, params, executeOptions),
          close: () => session.close(),
          introspector: {
            ...introspector,
            describe: async (path) => ({ ...(await introspector.describe(path)), routines: [ROUTINE] }),
          },
        };
      },
    };
    return createEngine({
      datasource: {
        id: "routines",
        pluginId: "sqlite",
        config: { path: seededSqliteFile() },
        readOnly: false,
        keepAliveSeconds: 0,
      },
      plugins: [{ status: "loaded", directory: SQLITE_DIRECTORY, manifest: SQLITE_MANIFEST, plugin }],
    });
  }

  it("givenRoutine_whenRoutineCall_thenPluginSqlFromCache", async () => {
    const response = await routineEngine()
      .connect()
      .handle({
        id: 1,
        type: "routine.call",
        path: ["main"],
        name: "calc_fee",
        kind: "function",
        signature: "amount numeric",
        args: [{ kind: "value", value: "5" }],
      });

    expect(resultOf<RoutineCall>(response)).toEqual({
      sql: 'SELECT "main"."calc_fee"(:amount);',
      params: { ":amount": "5" },
    });
  });

  it("givenUnknownRoutine_whenRoutineCall_thenInvalidRequest", async () => {
    const response = await routineEngine()
      .connect()
      .handle({
        id: 2,
        type: "routine.call",
        path: ["main"],
        name: "calc_fee",
        kind: "procedure",
        signature: "",
        args: [],
      });

    expect(response).toMatchObject({ id: 2, type: "engine.error", error: { code: "invalidRequest" } });
    expect(response.type === "engine.error" && response.error.hint).toMatch(/Synchronize/);
  });

  it("givenArgumentsThatDoNotFit_whenRoutineCall_thenStatementFailed", async () => {
    const response = await routineEngine()
      .connect()
      .handle({
        id: 3,
        type: "routine.call",
        path: ["main"],
        name: "calc_fee",
        kind: "function",
        signature: "amount numeric",
        args: [],
      });

    expect(response).toMatchObject({ id: 3, type: "engine.error", error: { code: "statementFailed" } });
  });

  it("givenPluginWithoutRoutineCall_whenRoutineCall_thenInvalidRequest", async () => {
    const { engine } = countingSqlite();

    const response = await engine
      .connect()
      .handle({ id: 4, type: "routine.call", path: ["main"], name: "f", kind: "function", signature: "", args: [] });

    expect(response).toMatchObject({ id: 4, type: "engine.error", error: { code: "invalidRequest" } });
  });
});

describe("probeDatasource", () => {
  it("givenReachableDatabase_whenProbed_thenSucceedsWithVersionAndElapsed", async () => {
    const ticks = [100, 138];
    const result = await probeDatasource(
      { datasource: DATASOURCE, plugins: [LOADED_SQLITE] },
      () => ticks.shift() ?? 0,
    );

    expect(result).toMatchObject({ ok: true, pluginName: "SQLite", elapsedMs: 38 });
    expect(result.ok && result.serverVersion).toMatch(VERSION);
  });

  it("givenTlsSession_whenProbed_thenReportsProtocolAndCipher", async () => {
    const tls = { protocol: "TLSv1.3", cipher: "TLS_AES_256_GCM_SHA384" };
    const encrypted: DatasourcePlugin = {
      ...sqlite,
      connect: async (config, options) => {
        const session = await sqlite.connect(config, options);
        return {
          execute: (sql, params) => session.execute(sql, params),
          serverVersion: "1",
          tls,
          close: () => session.close(),
        };
      },
    };

    const result = await probeDatasource({
      datasource: DATASOURCE,
      plugins: [{ ...LOADED_SQLITE, plugin: encrypted }],
    });

    expect(result).toMatchObject({ ok: true, tls });
  });

  it("givenSessionWithoutTlsReport_whenProbed_thenNoTlsLine", async () => {
    const result = await probeDatasource({ datasource: DATASOURCE, plugins: [LOADED_SQLITE] });

    expect(result).not.toHaveProperty("tls");
  });

  it("givenUnreachableDatabase_whenProbed_thenFailsWithConnectionFailedAndHint", async () => {
    const result = await probeDatasource({
      datasource: { ...DATASOURCE, config: { path: "/nonexistent-table-craft-directory/db.sqlite" } },
      plugins: [LOADED_SQLITE],
    });

    expect(result).toMatchObject({ ok: false, error: { code: "connectionFailed" } });
    expect(!result.ok && result.error.hint).toMatch(/\S/);
  });

  it("givenTlsSettingsFailure_whenProbed_thenHintPointsAtSslSettings", async () => {
    const refused: DatasourcePlugin = {
      ...sqlite,
      connect: () => Promise.reject(new TlsSettingsError("The server certificate is not signed by the CA in /ca.pem.")),
    };

    const result = await probeDatasource({ datasource: DATASOURCE, plugins: [{ ...LOADED_SQLITE, plugin: refused }] });

    expect(result).toMatchObject({ ok: false, error: { code: "connectionFailed" } });
    expect(!result.ok && result.error.hint).toContain("SSL settings");
  });
});

describe("createLifetime", () => {
  it("givenLastPortClosed_whenEngineIdle_thenEngineExits", () => {
    let exits = 0;
    const lifetime = createLifetime(() => {
      exits += 1;
    });
    lifetime.attached();
    lifetime.attached();

    lifetime.detached();
    expect(exits).toBe(0);
    lifetime.detached();

    expect(exits).toBe(1);
  });

  it("givenNoPortEverAttached_whenDetachedReported_thenEngineStays", () => {
    let exits = 0;
    createLifetime(() => {
      exits += 1;
    }).detached();

    expect(exits).toBe(0);
  });
});

describe("engine scripts and transactions", () => {
  async function execute(connection: ReturnType<typeof connected>, sessionId: string, sql: string) {
    return resultOf<ExecutedStatement>(
      await connection.handle({ id: 3, type: "statement.execute", ...PAGING, sessionId, sql }),
    );
  }

  it("givenScript_whenSplitWithoutSession_thenClassifiedStatements", async () => {
    const text = "SELECT 1;\nDELETE FROM t;";

    const response = await connected().handle({ id: 1, type: "script.split", text });

    expect(resultOf<ClassifiedStatement[]>(response)).toEqual([
      { from: 0, to: 8, sql: "SELECT 1", kind: "read", destructive: null, parameters: [] },
      {
        from: 10,
        to: 23,
        sql: "DELETE FROM t",
        kind: "write",
        destructive: "DELETE without WHERE",
        parameters: [],
      },
    ]);
  });

  it("givenParameters_whenSplit_thenEachStatementListsItsPlaceholders", async () => {
    const response = await connected().handle({ id: 1, type: "script.split", text: "SELECT :a, '?';\nSELECT ?" });

    expect(resultOf<ClassifiedStatement[]>(response).map((statement) => statement.parameters)).toEqual([
      [{ name: ":a", from: 7, to: 9, style: "named" }],
      [{ name: "?1", from: 7, to: 8, style: "positional" }],
    ]);
  });

  it("givenParameterValues_whenExecuted_thenBoundNotSpliced", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const value = "x'); DROP TABLE t; --";

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELECT :v AS v, :v || ? AS w",
      parameters: { ":v": value, "?1": null },
    });

    expect(resultOf<ExecutedStatement>(response).firstWindow.rows).toEqual([[value, null]]);
  });

  it("givenMissingParameterValue_whenExecuted_thenStatementFailedNamingIt", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELECT :v",
      parameters: {},
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "statementFailed" } });
    expect(response.type === "engine.error" && response.error.message).toMatch(/:v/);
  });

  it("givenNoParameterValues_whenExecuted_thenRunsVerbatim", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "SELECT :v",
    });

    expect(resultOf<ExecutedStatement>(response).firstWindow.rows).toEqual([[null]]);
  });

  it("givenText_whenFormatRequested_thenPluginLaysItOut", async () => {
    const response = await connected().handle({
      id: 1,
      type: "sql.format",
      text: "select a, b from t",
      options: FORMAT_OPTIONS,
    });

    expect(resultOf<string>(response)).toBe("SELECT a,\n       b\nFROM t");
  });

  it("givenStandardStyle_whenFormatRequested_thenSqlFormatterLayout", async () => {
    const response = await connected().handle({
      id: 1,
      type: "sql.format",
      text: "select a from t",
      options: { ...FORMAT_OPTIONS, style: "standard" },
    });

    expect(resultOf<string>(response)).toBe("SELECT\n  a\nFROM\n  t");
  });

  it("givenUnreadableText_whenFormatRequested_thenFormatFailedWithOneLineReason", async () => {
    const response = await connected().handle({
      id: 1,
      type: "sql.format",
      text: "select ((",
      options: FORMAT_OPTIONS,
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "formatFailed" } });
    expect(response.type === "engine.error" && response.error.message).not.toContain("\n");
  });

  it("givenTransactionRequest_whenPluginLacksTransactions_thenInvalidRequestError", async () => {
    const connection = connectedToCancellable(cancellablePlugin().plugin);
    const sessionId = await openSession(connection);

    const response = await connection.handle({ id: 2, type: "transaction.commit", sessionId });

    expect(response).toMatchObject({ id: 2, type: "engine.error", error: { code: "invalidRequest" } });
  });

  it("givenManualMode_whenInsertThenRollback_thenRowGoneAndNotOpen", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    await execute(connection, sessionId, "CREATE TABLE t (n INTEGER)");

    const mode = await connection.handle({ id: 2, type: "transaction.setMode", sessionId, mode: "manual" });
    const inserted = await execute(connection, sessionId, "INSERT INTO t VALUES (1)");
    const rolledBack = await connection.handle({ id: 4, type: "transaction.rollback", sessionId });
    const counted = await execute(connection, sessionId, "SELECT count(*) AS n FROM t");

    expect(resultOf<TransactionState>(mode)).toEqual({ mode: "manual", transactionOpen: false });
    expect(inserted.transactionOpen).toBe(true);
    expect(resultOf<TransactionState>(rolledBack)).toEqual({ mode: "manual", transactionOpen: false });
    expect(counted.firstWindow.rows).toEqual([[0]]);
  });

  it("givenAutoMode_whenExplicitBegin_thenExecutedStatementCarriesTransactionOpen", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const begun = await execute(connection, sessionId, "BEGIN");
    const selected = await execute(connection, sessionId, "SELECT 1");
    const committed = await execute(connection, sessionId, "COMMIT");

    expect([begun, selected, committed].map((executed) => executed.transactionOpen)).toEqual([true, true, false]);
  });

  it("givenOpenTransaction_whenSwitchedToAuto_thenStatementFailedAndStillOpen", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    await connection.handle({ id: 2, type: "transaction.setMode", sessionId, mode: "manual" });
    await execute(connection, sessionId, "SELECT 1");

    const response = await connection.handle({ id: 4, type: "transaction.setMode", sessionId, mode: "auto" });
    const committed = await connection.handle({ id: 5, type: "transaction.commit", sessionId });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "statementFailed" } });
    expect(resultOf<TransactionState>(committed)).toEqual({ mode: "manual", transactionOpen: false });
  });
});

describe("engine explain", () => {
  it("givenStatements_whenExplainableAskedWithoutSession_thenPluginVerdicts", async () => {
    const connection = connected();

    const select = await connection.handle({ id: 1, type: "sql.explainable", sql: "SELECT 1", analyze: false });
    const ddl = await connection.handle({
      id: 2,
      type: "sql.explainable",
      sql: "CREATE TABLE t (n int)",
      analyze: false,
    });
    const analyse = await connection.handle({ id: 3, type: "sql.explainable", sql: "SELECT 1", analyze: true });

    expect(resultOf<Explainability>(select)).toEqual({ ok: true, writes: false });
    const refused = resultOf<Explainability>(ddl);
    expect(refused.ok ? null : refused.reason).toContain("CREATE");
    expect(resultOf<Explainability>(analyse)).toMatchObject({ ok: false });
  });

  it("givenOpenCursor_whenExplained_thenPlanAndTheCursorClosed", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle, cursorOpen } = resultOf<ExecutedStatement>(
      await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql: ROWS_1200 }),
    );

    const response = await connection.handle({
      id: 3,
      type: "statement.explain",
      sessionId,
      sql: ROWS_1200,
      analyze: false,
    });
    const fetched = await connection.handle({ id: 4, type: "result.fetchMore", ...PAGING, handle, all: false });

    const explained = resultOf<ExplainedStatement>(response);
    expect(cursorOpen).toBe(true);
    expect(explained.plan.statement).toBe(`EXPLAIN QUERY PLAN ${ROWS_1200}`);
    expect(explained.plan.roots.length).toBeGreaterThan(0);
    expect(explained.transactionOpen).toBe(false);
    expect(resultOf<ResultState>(fetched).cursorOpen).toBe(false);
  });

  it("givenDdl_whenExplained_thenExplainUnsupportedWithTheReason", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.explain",
      sessionId,
      sql: "CREATE TABLE t (n int)",
      analyze: false,
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "explainUnsupported" } });
    expect(response.type === "engine.error" ? response.error.message : null).toContain("CREATE");
  });

  it("givenPluginWithoutExplainAnalyze_whenAnalysed_thenInvalidRequest", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const response = await connection.handle({
      id: 2,
      type: "statement.explain",
      sessionId,
      sql: "SELECT 1",
      analyze: true,
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
  });
});

describe("engine results", () => {
  async function execute(connection: ReturnType<typeof connected>, sessionId: string, sql: string) {
    return resultOf<ExecutedStatement>(
      await connection.handle({ id: 3, type: "statement.execute", ...PAGING, sessionId, sql }),
    );
  }

  async function fetchMore(connection: ReturnType<typeof connected>, handle: string, all = false) {
    return resultOf<ResultState>(await connection.handle({ id: 4, type: "result.fetchMore", ...PAGING, handle, all }));
  }

  it("givenLargeResult_whenExecuted_thenFirstPageOnlyAndCursorOpen", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);

    const executed = await execute(connection, sessionId, ROWS_1200);

    expect(executed).toMatchObject({ rowCount: 500, complete: false, cursorOpen: true, typeClasses: ["integer"] });
    expect(await fetchMore(connection, executed.handle)).toEqual({ rowCount: 1000, complete: false, cursorOpen: true });
    expect(await fetchMore(connection, executed.handle)).toEqual({ rowCount: 1200, complete: true, cursorOpen: false });
  });

  it("givenOpenCursor_whenSessionRunsAnotherStatement_thenCursorClosedRowsKept", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const first = await execute(connection, sessionId, ROWS_1200);

    await execute(connection, sessionId, "SELECT 1");
    const state = await fetchMore(connection, first.handle);
    const window = resultOf<ResultWindow>(
      await connection.handle({ id: 5, type: "result.window", handle: first.handle, offset: 0, limit: 500 }),
    );

    expect(state).toEqual({ rowCount: 500, complete: false, cursorOpen: false });
    expect(window.rows).toHaveLength(500);
  });

  it("givenOpenCursorInManualMode_whenCommitted_thenCursorClosedAndCommitSucceeds", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    await connection.handle({ id: 2, type: "transaction.setMode", sessionId, mode: "manual" });
    const first = await execute(connection, sessionId, ROWS_1200);

    const committed = await connection.handle({ id: 5, type: "transaction.commit", sessionId });

    expect(resultOf<TransactionState>(committed)).toEqual({ mode: "manual", transactionOpen: false });
    expect((await fetchMore(connection, first.handle)).cursorOpen).toBe(false);
  });

  it("givenSortedResult_whenExtractedAsCsv_thenSortedRowsAndChosenColumns", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle } = await execute(
      connection,
      sessionId,
      "SELECT 2 AS id, 'b' AS name UNION ALL SELECT 1, 'a' UNION ALL SELECT 3, 'c'",
    );

    await connection.handle({ id: 5, type: "result.sort", handle, keys: [{ column: 0, direction: "desc" }] });
    const text = await connection.handle({
      id: 6,
      type: "result.extract",
      handle,
      extractor: "csv",
      rows: [{ from: 0, to: 2 }],
      columns: [1],
    });

    expect(resultOf<string>(text)).toBe("name\nc\nb\n");
  });

  it("givenSortedResult_whenAggregated_thenOverShownRowsAndChosenColumns", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle } = await execute(
      connection,
      sessionId,
      "SELECT 2 AS id, 'b' AS name UNION ALL SELECT 1, 'a' UNION ALL SELECT 3, 'c'",
    );

    await connection.handle({ id: 5, type: "result.sort", handle, keys: [{ column: 0, direction: "desc" }] });
    const aggregates = await connection.handle({
      id: 6,
      type: "result.aggregate",
      handle,
      rows: [{ from: 0, to: 2 }],
      columns: [0],
    });

    expect(resultOf<SelectionAggregates>(aggregates)).toMatchObject({ cells: 2, sum: "5", min: 2, max: 3 });
  });

  it("givenSqlInsertExtractor_whenExtracted_thenPluginQuotesNamesAndValues", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, "SELECT 'it''s' AS \"a b\", X'00ff' AS blob");

    const text = await connection.handle({
      id: 6,
      type: "result.extract",
      handle,
      extractor: "sqlInsert",
      rows: [{ from: 0, to: 1 }],
      columns: [0, 1],
    });

    expect(resultOf<string>(text)).toBe(`INSERT INTO MY_TABLE ("a b", "blob") VALUES ('it''s', X'00ff');\n`);
  });

  it("givenLocalFilter_whenWindowedFoundAndExtracted_thenOnlyShownRows", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle } = await execute(
      connection,
      sessionId,
      "SELECT 1 AS id, 'apple' AS name UNION ALL SELECT 2, 'pear' UNION ALL SELECT 3, 'apricot'",
    );

    const view = await connection.handle({
      id: 5,
      type: "result.view",
      handle,
      spec: {
        find: { text: "ap", caseSensitive: false, regex: false, wholeCell: false },
        rowsOnly: true,
        filters: [{ column: 0, op: "notEquals", text: "1" }],
        columns: [0, 1],
        formats: { groupDigits: false },
      },
    });
    const window = await connection.handle({ id: 6, type: "result.window", handle, offset: 0, limit: 500 });
    const found = await connection.handle({ id: 7, type: "result.findMatch", handle, from: null, backward: false });
    const text = await connection.handle({
      id: 8,
      type: "result.extract",
      handle,
      extractor: "csv",
      rows: [{ from: 0, to: 1 }],
      columns: [1],
    });

    expect(resultOf<ViewState>(view)).toEqual({ shown: 1, filtered: true, sources: [2], matches: 1, error: null });
    expect(resultOf<ResultWindow>(window)).toEqual({ offset: 0, rows: [[3, "apricot"]], matches: [0, 1] });
    expect(resultOf<FoundMatch>(found)).toEqual({ index: 0, row: 0, column: 1 });
    expect(resultOf<string>(text)).toBe("apricot");
  });

  it("givenOneCell_whenExtracted_thenBareValueWithoutHeaderOrQuotes", async () => {
    const connection = connected();
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, "SELECT 261023000002437 AS refund_id, 'a,\"b\"' AS note");

    const extracted = async (id: number, column: number) =>
      resultOf<string>(
        await connection.handle({
          id,
          type: "result.extract",
          handle,
          extractor: "csv",
          rows: [{ from: 0, to: 1 }],
          columns: [column],
        }),
      );

    expect(await extracted(5, 0)).toBe("261023000002437");
    expect(await extracted(6, 1)).toBe('a,"b"');
  });
});
