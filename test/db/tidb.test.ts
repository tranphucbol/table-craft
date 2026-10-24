import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import type { PlanNode, Session } from "@table-craft/plugin-api";
import { createEngine, type EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type {
  DatasourceConfig,
  EngineResponse,
  ExecutedStatement,
  Namespace,
  SwitchStatement,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { TIDB_CONFIG, TIDB_DATABASE, tidbScratchDatabase } from "../support/databases.js";
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
const SAGA_TABLE = "order_events_202601";
const SAGA_INDEX = "order_events_app_id";

async function withSagaContext(session: Session): Promise<void> {
  const run = async (sql: string) => {
    for await (const _row of (await session.execute(sql)).rows) {
      // Drained so the session is free for the next statement.
    }
  };
  await run(`DROP TABLE IF EXISTS ${SAGA_TABLE}`);
  await run(
    `CREATE TABLE ${SAGA_TABLE} (id BIGINT PRIMARY KEY, app_id INT NOT NULL, state VARCHAR(16), KEY ${SAGA_INDEX} (app_id))`,
  );
  await run(`INSERT INTO ${SAGA_TABLE} VALUES (1, 10, 'new'), (2, 20, 'done'), (3, 10, 'done')`);
}

describe("tidb 4", () => {
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
    await withSagaContext(session);

    const result = await session.execute(`SELECT /*+ USE_INDEX(${SAGA_INDEX}) */ * FROM ${SAGA_TABLE} LIMIT 10`);
    for await (const _row of result.rows) {
      // Messages are complete once the rows are.
    }

    expect(result.messages).toEqual([
      {
        level: "warning",
        code: "1815",
        text: `use_index(${TIDB_DATABASE}.${SAGA_INDEX}) is inapplicable, check whether the table(${TIDB_DATABASE}.${SAGA_INDEX}) exists`,
      },
    ]);
  });

  it.each([
    ["a plain comment", `SELECT /*USE_INDEX(${SAGA_INDEX})*/ * FROM ${SAGA_TABLE} LIMIT 10`, "TableFullScan", false],
    [
      "a hint without its table",
      `SELECT /*+ USE_INDEX(${SAGA_INDEX}) */ * FROM ${SAGA_TABLE} LIMIT 10`,
      "TableFullScan",
      true,
    ],
    [
      "a hint naming its table",
      `SELECT /*+ USE_INDEX(${SAGA_TABLE}, ${SAGA_INDEX}) */ * FROM ${SAGA_TABLE} LIMIT 10`,
      "IndexFullScan",
      false,
    ],
    ["an index clause", `SELECT * FROM ${SAGA_TABLE} USE INDEX (${SAGA_INDEX}) LIMIT 10`, "IndexFullScan", false],
  ])("givenIndexChosenBy %s_whenExplained_thenTreeShowsTheScan", async (_how, sql, scan, warned) => {
    const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
    cleanup.push(() => session.close());
    await withSagaContext(session);

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
    await withSagaContext(session);

    const plan = await session.explain?.(
      `SELECT /*+ USE_INDEX(${SAGA_TABLE}, ${SAGA_INDEX}) */ * FROM ${SAGA_TABLE} WHERE app_id = 10`,
      { analyze: true },
    );

    expect(plan?.analyzed).toBe(true);
    expect(plan?.roots[0]?.operation).toMatch(/^IndexLookUp_/);
    expect(plan?.roots[0]?.actualRows).toBe(2);
    expect(plan?.roots[0]?.children[0]?.target).toBe(`table:${SAGA_TABLE}, index:${SAGA_INDEX}(app_id)`);
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
});
