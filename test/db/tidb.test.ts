import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import {
  errorPositionOf,
  offsetOfPosition,
  type PlanNode,
  type ServerSession,
  type Session,
  type SessionMonitor,
} from "@table-craft/plugin-api";
import { createEngine, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type {
  DatasourceConfig,
  EngineResponse,
  ExecutedStatement,
  Namespace,
  SwitchStatement,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { databaseEnabled, TIDB_CONFIG, TIDB_DATABASE, tidbScratchDatabase } from "../support/databases.js";
import { MYSQL_MANIFEST } from "../support/manifests.js";
import { tenThousandRows } from "../support/manyRows.js";

/**
 * Plan 027 on TiDB 4, where `KILL QUERY` is a no-op and a connection id is unique to one TiDB
 * server only, so the plugin must never send a kill (decision 058).
 */

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const RUNS_IN_A_ROW = 3;
const SLEEP_SQL = "SELECT SLEEP(30)";
/** Long enough for TiDB to start the sleep, well short of it. */
const STARTED_MS = 500;
/** Cancel must stop the sleep by dropping the session, not wait it out. */
const CANCEL_WITHIN_MS = 5_000;
/** Plan 029: a database name near MySQL's 64-character limit, which the switcher label shows whole. */
const LONG_DATABASE_LENGTH = 62;
const LONG_DATABASE = tidbScratchDatabase(
  "a_database_whose_name_runs_long_enough_to_test_labels",
  LONG_DATABASE_LENGTH,
);

/** How long a listing may take to show what another connection just did. */
const LISTED_WITHIN_MS = 10_000;
const LISTING_POLL_MS = 200;

/** Plan 119: TiDB 4 stops every statement past `max_execution_time` and answers 1317, as a kill does. */
const SERVER_LIMIT_MS = 1_500;
const SLOW_READ_SECONDS = 8;
const SERVER_LIMIT_DEADLINE_MS = 5_000;
const DIGITS =
  "SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9";
const DIGIT_TABLES = 7;

/**
 * A read that works about `seconds` on the shared TiDB 4 and ends by itself: a count over ten
 * million rows per second. `SLEEP` there returns early instead of failing, and `BENCHMARK` ignores
 * both the limit and `KILL TIDB`.
 */
function tidbSlowRead(seconds: number): string {
  const digits = Array.from({ length: DIGIT_TABLES }, (_, index) => `(${DIGITS}) t${String(index)}`);
  const repeats = Array.from({ length: seconds }, (_, index) => `SELECT ${String(index)} AS n`).join(" UNION ALL ");
  return `SELECT COUNT(*) FROM ${digits.join(", ")}, (${repeats}) r`;
}

/**
 * Polls for `session`'s own row, by id and server: the TiDB may be shared, and an id alone can name
 * someone else's connection on another of its servers.
 */
async function listedUntil(
  monitor: SessionMonitor,
  session: Session,
  ready: (row: ServerSession | undefined) => boolean,
): Promise<ServerSession | undefined> {
  const deadline = Date.now() + LISTED_WITHIN_MS;
  for (;;) {
    const row = (await monitor.list()).sessions.find(
      (listed) => listed.id === session.serverSessionId && listed.instance === session.serverInstance,
    );
    if (ready(row)) return row;
    if (Date.now() > deadline)
      throw new Error(`Session ${String(session.serverSessionId)} never got there; last seen ${JSON.stringify(row)}.`);
    await new Promise((resolve) => setTimeout(resolve, LISTING_POLL_MS));
  }
}

const LOADED = { status: "loaded", directory: "plugins/mysql", manifest: MYSQL_MANIFEST, plugin: mysql } as const;

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

interface Driver {
  createConnection(options: unknown): Record<string, unknown>;
}

/** The plugin's own copy of mysql2, which the root workspace does not depend on. */
const driver = createRequire(new URL("../../plugins/mysql/package.json", import.meta.url))("mysql2") as Driver;

/** Every SQL text the plugin sends, on any connection it opens. */
function spySql(): string[] {
  const sent: string[] = [];
  const create = driver.createConnection.bind(driver);
  vi.spyOn(driver, "createConnection").mockImplementation((options) => {
    const connection = create(options);
    for (const method of ["query", "execute"] as const) {
      const original = (connection[method] as (...args: unknown[]) => unknown).bind(connection);
      connection[method] = (...args: unknown[]) => {
        const first = args[0];
        sent.push(typeof first === "string" ? first : String((first as { sql?: unknown }).sql));
        return original(...args);
      };
    }
    return connection;
  });
  return sent;
}

/** The user's table from plan 033, a few rows so the plans stay fast on the emulated image. */
const EVENTS_TABLE = "order_events_202601";
const EVENTS_INDEX = "order_events_shop_id";

async function withOrderEvents(session: Session): Promise<void> {
  const run = async (sql: string) => {
    for await (const _row of (await session.execute(sql)).rows) {
      // Drained so the session is free for the next statement.
    }
  };
  await run(`DROP TABLE IF EXISTS ${EVENTS_TABLE}`);
  await run(
    `CREATE TABLE ${EVENTS_TABLE} (id BIGINT PRIMARY KEY, shop_id INT NOT NULL, state VARCHAR(16), KEY ${EVENTS_INDEX} (shop_id))`,
  );
  await run(`INSERT INTO ${EVENTS_TABLE} VALUES (1, 10, 'new'), (2, 20, 'done'), (3, 10, 'done')`);
}

describe.runIf(databaseEnabled("tidb"))("tidb 4", () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined);
    vi.restoreAllMocks();
  });

  function engine(): EngineConnection {
    const datasource: DatasourceConfig = {
      id: "tidb",
      pluginId: "mysql",
      config: TIDB_CONFIG,
      readOnly: false,
      keepAliveSeconds: 0,
    };
    const created = createEngine({ datasource, plugins: [LOADED] });
    const connection = created.connect();
    cleanup.push(() => created.close());
    cleanup.push(() => connection.close());
    return connection;
  }

  async function open(connection: EngineConnection): Promise<string> {
    return resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
  }

  it("givenUnfinishedResults_whenReleasedThenRun_thenNoKillIsSent", async () => {
    const sent = spySql();
    const connection = engine();
    const sessionId = await open(connection);
    for (let run = 0; run < RUNS_IN_A_ROW; run += 1) {
      const unfinished = resultOf<ExecutedStatement>(
        await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql: tenThousandRows() }),
      );
      expect(unfinished.cursorOpen).toBe(true);
      void connection.handle({ id: 3, type: "result.release", handle: unfinished.handle });

      const response = await connection.handle({
        id: 4,
        type: "statement.execute",
        ...PAGING,
        sessionId,
        sql: "SELECT 1",
      });

      expect(resultOf<ExecutedStatement>(response).firstWindow.rows).toHaveLength(1);
    }
    expect(sent).toContain("SELECT 1");
    expect(sent.filter((sql) => /\bKILL\b/i.test(sql))).toEqual([]);
  });

  it("givenSleepRunning_whenCancel_thenStopsBySessionResetWithoutKill", async () => {
    const sent = spySql();
    const connection = engine();
    const sessionId = await open(connection);
    const started = Date.now();
    const sleeping = connection.handle({ id: 5, type: "statement.execute", ...PAGING, sessionId, sql: SLEEP_SQL });
    await new Promise((resolve) => setTimeout(resolve, STARTED_MS));

    resultOf(await connection.handle({ id: 6, type: "statement.cancel", sessionId }));
    const response = await sleeping;

    expect(Date.now() - started).toBeLessThan(CANCEL_WITHIN_MS);
    expect(response).toMatchObject({ type: "engine.error", error: { code: "cancelled" } });
    expect(response.type === "engine.error" ? response.error.message : "").toMatch(/resetting the session/);
    expect(sent.filter((sql) => /\bKILL\b/i.test(sql))).toEqual([]);

    const next = await connection.handle({ id: 7, type: "statement.execute", ...PAGING, sessionId, sql: "SELECT 1" });

    expect(resultOf<ExecutedStatement>(next).firstWindow.rows).toHaveLength(1);
  });

  it("givenUnknownHintTable_whenExecuted_then1815", async () => {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());
    await withOrderEvents(session);

    const result = await session.execute(`SELECT /*+ USE_INDEX(${EVENTS_INDEX}) */ * FROM ${EVENTS_TABLE} LIMIT 10`);
    for await (const _row of result.rows) {
      // Messages are complete once the rows are.
    }

    expect(result.messages).toEqual([
      {
        level: "warning",
        code: "1815",
        text: `use_index(${TIDB_DATABASE}.${EVENTS_INDEX}) is inapplicable, check whether the table(${TIDB_DATABASE}.${EVENTS_INDEX}) exists`,
      },
    ]);
  });

  it("givenTidbServer_whenSessionOpens_thenServerBrandTidb", async () => {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());

    expect(session.serverBrand).toBe("tidb");
  });

  it("givenReadOnlySession_whenConnected_thenNoReadOnlyTransactionIsSet", async () => {
    const sent = spySql();
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: true });
    cleanup.push(() => session.close());

    const result = await session.execute("SELECT 1 AS one");
    const rows = [];
    for await (const row of result.rows) rows.push(row);

    expect(rows).toEqual([[1]]);
    expect(sent.filter((sql) => /READ\s+ONLY/i.test(sql))).toEqual([]);
  });

  it("givenReadOnlySession_whenWriteOrDdl_thenRefusedBeforeSent", async () => {
    const writer = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => writer.close());
    await withOrderEvents(writer);
    const sent = spySql();
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: true });
    cleanup.push(() => session.close());

    for (const sql of [
      `INSERT INTO ${EVENTS_TABLE} VALUES (4, 30, 'new')`,
      `UPDATE ${EVENTS_TABLE} SET state = 'gone'`,
      `DROP TABLE ${EVENTS_TABLE}`,
    ]) {
      await expect(session.execute(sql)).rejects.toMatchObject({ code: "statementFailed" });
    }
    await expect(
      session.insertRows?.(
        {
          table: EVENTS_TABLE,
          columns: [
            { name: "id", type: "BIGINT" },
            { name: "shop_id", type: "INT" },
            { name: "state", type: "VARCHAR" },
          ],
        },
        [["5", "40", "new"]],
      ),
    ).rejects.toMatchObject({ code: "statementFailed" });

    const result = await session.execute(`SELECT COUNT(*) AS n, MAX(state) AS state FROM ${EVENTS_TABLE}`);
    const rows = [];
    for await (const row of result.rows) rows.push(row);

    expect(rows).toEqual([[3, "new"]]);
    expect(sent.filter((sql) => /\b(INSERT|UPDATE|DROP)\b/i.test(sql))).toEqual([]);
  });

  it("givenTidbSyntaxError_whenExecuted_thenPositionFoundOnItsLine", async () => {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());
    // `dual` takes no alias, so TiDB stops at the misspelt keyword on line 3.
    const sql = "SELECT 1,\n  2\nFROM dual WHER 1 = 1";

    const failure: unknown = await session.execute(sql).then(
      () => undefined,
      (error: unknown) => error,
    );

    const position = errorPositionOf(failure);
    expect(position === undefined ? null : offsetOfPosition(sql, position)).toBe(sql.indexOf("WHER"));
  });

  it.each([
    [
      "a plain comment",
      `SELECT /*USE_INDEX(${EVENTS_INDEX})*/ * FROM ${EVENTS_TABLE} LIMIT 10`,
      "TableFullScan",
      false,
    ],
    [
      "a hint without its table",
      `SELECT /*+ USE_INDEX(${EVENTS_INDEX}) */ * FROM ${EVENTS_TABLE} LIMIT 10`,
      "TableFullScan",
      true,
    ],
    [
      "a hint naming its table",
      `SELECT /*+ USE_INDEX(${EVENTS_TABLE}, ${EVENTS_INDEX}) */ * FROM ${EVENTS_TABLE} LIMIT 10`,
      "IndexFullScan",
      false,
    ],
    ["an index clause", `SELECT * FROM ${EVENTS_TABLE} USE INDEX (${EVENTS_INDEX}) LIMIT 10`, "IndexFullScan", false],
  ])("givenIndexChosenBy %s_whenExplained_thenTreeShowsTheScan", async (_how, sql, scan, warned) => {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());
    await withOrderEvents(session);

    const plan = await session.explain?.(sql, { analyze: false });

    const operations: string[] = [];
    const walk = (nodes: readonly PlanNode[]) => {
      for (const node of nodes) {
        operations.push(node.operation);
        walk(node.children);
      }
    };
    walk(plan?.roots ?? []);
    expect(plan?.statement).toBe(`EXPLAIN ${sql}`);
    expect(operations.some((operation) => operation.startsWith(scan))).toBe(true);
    expect(plan?.messages?.map((message) => message.code)).toEqual(warned ? ["1815"] : []);
  });

  it("givenHintedSelect_whenExplainAnalysed_thenActualRows", async () => {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());
    await withOrderEvents(session);

    const plan = await session.explain?.(
      `SELECT /*+ USE_INDEX(${EVENTS_TABLE}, ${EVENTS_INDEX}) */ * FROM ${EVENTS_TABLE} WHERE shop_id = 10`,
      { analyze: true },
    );

    expect(plan?.analyzed).toBe(true);
    expect(plan?.roots[0]?.operation).toMatch(/^IndexLookUp_/);
    expect(plan?.roots[0]?.actualRows).toBe(2);
    expect(plan?.roots[0]?.children[0]?.target).toBe(`table:${EVENTS_TABLE}, index:${EVENTS_INDEX}(shop_id)`);
  });

  it("givenLongNamedDatabase_whenSwitchedThroughEngine_thenNamespaceIsIt", async () => {
    const connection = engine();
    const sessionId = await open(connection);
    const run = async (sql: string) =>
      resultOf<ExecutedStatement>(
        await connection.handle({ id: 8, type: "statement.execute", ...PAGING, sessionId, sql }),
      );
    await run(`DROP DATABASE IF EXISTS \`${LONG_DATABASE}\``);
    await run(`CREATE DATABASE \`${LONG_DATABASE}\``);
    cleanup.push(() => run(`DROP DATABASE IF EXISTS \`${LONG_DATABASE}\``));

    const targets = resultOf<readonly Namespace[]>(
      await connection.handle({ id: 9, type: "namespace.targets", refresh: true }),
    );
    const { sql } = resultOf<SwitchStatement>(
      await connection.handle({ id: 10, type: "namespace.switchStatement", path: [LONG_DATABASE] }),
    );
    const switched = await run(sql);

    expect(targets.map((target) => target.path)).toContainEqual([LONG_DATABASE]);
    expect(switched.namespace).toEqual([LONG_DATABASE]);
  });

  it("givenTidb4WithoutStoredRoutines_whenDescribed_thenNoRoutines", async () => {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());
    await withOrderEvents(session);

    const described = await session.introspector?.describe([TIDB_DATABASE]);

    expect(described?.relations.map((relation) => relation.name)).toContain(EVENTS_TABLE);
    expect(described?.routines).toEqual([]);
  });

  async function connected(): Promise<Session & { sessions: SessionMonitor }> {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());
    if (session.sessions === undefined) throw new Error("The mysql plugin declares sessions.");
    return session as Session & { sessions: SessionMonitor };
  }

  it("givenSleepOnTidb4_whenList_thenActiveWithoutCancel", async () => {
    const monitor = (await connected()).sessions;
    const sleeper = await connected();
    const sleeping = sleeper.execute(SLEEP_SQL).catch(() => undefined);
    cleanup.push(() => sleeping);
    cleanup.push(() => sleeper.cancel?.() ?? Promise.resolve());

    const row = await listedUntil(monitor, sleeper, (listed) => listed?.state === "active");
    const { notes } = await monitor.list();

    expect(row).toMatchObject({
      query: SLEEP_SQL,
      blockedBy: null,
      cancel: null,
      terminate: `KILL TIDB ${row?.id ?? ""}`,
    });
    expect(sleeper.serverInstance).toEqual(expect.any(String));
    expect(notes.join("\n")).toMatch(/cannot cancel/);
    expect(notes.join("\n")).toMatch(/Blocked by is empty/);
    await expect(monitor.cancelSession({ id: row?.id ?? "", instance: row?.instance ?? null })).rejects.toMatchObject({
      code: "statementFailed",
    });
  });

  it("givenOpenTransactionOnTidb4_whenList_thenIdleInTransactionWithAge", async () => {
    const monitor = (await connected()).sessions;
    const holder = await connected();
    await holder.transactions?.setMode("manual");
    // With autocommit off TiDB opens the transaction at the first read of a stored table.
    for await (const _row of (await holder.execute(`SELECT COUNT(*) FROM ${EVENTS_TABLE}`)).rows) {
      // Drained, so the session sits idle in its transaction.
    }
    cleanup.push(() => holder.transactions?.rollback() ?? Promise.resolve());

    const row = await listedUntil(monitor, holder, (listed) => listed?.state === "idleInTransaction");

    expect(row?.transactionMs).toBeGreaterThanOrEqual(0);
  });

  it("givenSessionOnTidb4_whenTerminate_thenGoneAfterInstanceCheck", async () => {
    const sent = spySql();
    const monitor = (await connected()).sessions;
    const victim = await connected();
    const row = await listedUntil(monitor, victim, (listed) => listed !== undefined);

    await monitor.terminateSession({ id: row?.id ?? "", instance: row?.instance ?? null });
    // TiDB 4 ends an idle connection it was told to kill only when the connection next speaks.
    await expect(victim.execute("SELECT 1")).rejects.toThrow();
    await listedUntil(monitor, victim, (listed) => listed === undefined);

    const check = sent.findIndex((sql) => /CLUSTER_PROCESSLIST WHERE ID = CONNECTION_ID\(\)/.test(sql));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(sent.indexOf(`KILL TIDB ${row?.id ?? ""}`)).toBeGreaterThan(check);
  });

  it("givenUnknownInstance_whenTerminateOnTidb4_thenRejectsWithoutKill", async () => {
    const sent = spySql();
    const monitor = (await connected()).sessions;
    const victim = await connected();

    const refused = monitor.terminateSession({ id: victim.serverSessionId ?? "", instance: "elsewhere:10080" });

    await expect(refused).rejects.toMatchObject({ code: "statementFailed" });
    await expect(refused).rejects.toThrow(/nothing was killed/);
    expect(sent.filter((sql) => /\bKILL\b/i.test(sql))).toEqual([]);
  });

  async function drained(session: Session, sql: string, serverTimeoutMs?: number): Promise<unknown[]> {
    const rows: unknown[] = [];
    const result = await session.execute(sql, [], serverTimeoutMs === undefined ? {} : { serverTimeoutMs });
    for await (const row of result.rows) rows.push(row);
    return rows;
  }

  it("givenTidb4_whenLimited_thenTimedOutBySessionVariableOnly", async () => {
    const sent = spySql();
    const session = await connected();
    const started = Date.now();

    const stopped = drained(session, tidbSlowRead(SLOW_READ_SECONDS), SERVER_LIMIT_MS);

    await expect(stopped).rejects.toMatchObject({ code: "timedOut" });
    await expect(stopped).rejects.toThrow(/TiDB stopped the statement at its 1\.5 s limit \(max_execution_time\)/);
    expect(Date.now() - started).toBeLessThan(SERVER_LIMIT_DEADLINE_MS);
    expect(session.serverTimeout).toEqual({ setting: "max_execution_time", covers: "all", counts: "statement" });
    expect(sent).toContain(`SET SESSION max_execution_time = ${String(SERVER_LIMIT_MS)}`);
    expect(sent.filter((sql) => /\bGLOBAL\b/i.test(sql))).toEqual([]);
    expect(await drained(session, "SELECT @@SESSION.max_execution_time ")).toEqual([["0"]]);
  });

  it("givenTidb4Limited_whenDoSleep_thenStopsAtLimitToo", async () => {
    const session = await connected();
    const started = Date.now();

    await drained(session, `DO SLEEP(${String(SLOW_READ_SECONDS)})`, SERVER_LIMIT_MS);

    expect(Date.now() - started).toBeLessThan(SERVER_LIMIT_DEADLINE_MS);
  });

  it("givenServerEnforced_whenEngineCannotKill_thenServerStops", async () => {
    const monitor = (await connected()).sessions;
    const sleeper = await connected();
    const dropped = { serverSessionId: sleeper.serverSessionId, serverInstance: sleeper.serverInstance } as Session;
    const sleeping = drained(sleeper, SLEEP_SQL, SERVER_LIMIT_MS).catch(() => undefined);
    cleanup.push(() => sleeping);
    await listedUntil(monitor, sleeper, (listed) => listed?.state === "active");

    await sleeper.cancel?.();
    const started = Date.now();
    await listedUntil(monitor, dropped, (listed) => listed === undefined);

    expect(Date.now() - started).toBeLessThan(SERVER_LIMIT_DEADLINE_MS);
  });
});
