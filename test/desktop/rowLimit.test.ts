import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginError, type DatasourcePlugin, type Session } from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import type { EngineConnection } from "@table-craft/desktop/engine/engine.js";
import type { EngineResponse, ExecutedStatement, ResultState } from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { failedInLimit, positionBefore } from "@table-craft/desktop/engine/failures.js";
import { exportHarness, openSession, resultOf, startExport, type ExportHarness } from "../support/engineExports.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const TOTAL_ROWS = 1_200;
const ROWS = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${TOTAL_ROWS}) SELECT i FROM n`;
const SMALL_CAP = 1_000;
const LIMIT_OF = /LIMIT (\d+)$/;

/** SQLite with every statement it was handed recorded, so a test sees the text the server got. */
function recordingSqlite(sent: string[]): DatasourcePlugin {
  return {
    ...sqlite,
    connect: async (config, options) => {
      const session = (await sqlite.connect(config as { path: string }, options)) as Session;
      return new Proxy(session, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property === "execute") {
            return (sql: string, ...rest: unknown[]) => {
              sent.push(sql);
              return (target.execute as (...args: unknown[]) => unknown).call(target, sql, ...rest);
            };
          }
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
}

function limitOf(sql: string | undefined): number | null {
  const match = LIMIT_OF.exec(sql ?? "");
  return match === null ? null : Number(match[1]);
}

describe("row limit in the SQL", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  function open(path = ":memory:"): ExportHarness & { readonly sent: string[] } {
    const sent: string[] = [];
    const loaded: PluginLoadResult = {
      status: "loaded",
      directory: "plugins/sqlite",
      manifest: SQLITE_MANIFEST,
      plugin: recordingSqlite(sent),
    };
    const harness = exportHarness(
      { id: "limit", pluginId: "sqlite", config: { path }, readOnly: false, keepAliveSeconds: 0 },
      [loaded],
    );
    cleanup.push(() => harness.close());
    return { ...harness, sent };
  }

  function run(connection: EngineConnection, sessionId: string, sql: string, extra: Record<string, unknown> = {}) {
    return connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql, ...extra });
  }

  async function executed(connection: EngineConnection, sessionId: string, sql: string, extra = {}) {
    return resultOf<ExecutedStatement>(await run(connection, sessionId, sql, extra));
  }

  function fetchMore(connection: EngineConnection, handle: string, all: boolean, paging = PAGING) {
    return connection.handle({ id: 3, type: "result.fetchMore", handle, all, ...paging });
  }

  it("givenPlainSelect_whenRun_thenServerSawPagePlusOneAndCursorClosed", async () => {
    const { connection, sent } = open();
    const sessionId = await openSession(connection);

    const result = await executed(connection, sessionId, ROWS);

    expect(limitOf(sent.at(-1))).toBe(RESULT_PAGE_ROWS + 1);
    expect(result).toMatchObject({ rowCount: RESULT_PAGE_ROWS, complete: false, cursorOpen: false, refetch: true });
  });

  it("givenSmallSelect_whenRun_thenCompleteWithoutRefetch", async () => {
    const { connection } = open();
    const sessionId = await openSession(connection);

    const result = await executed(connection, sessionId, "SELECT 1 AS a");

    expect(result).toMatchObject({ rowCount: 1, complete: true, cursorOpen: false });
    expect(result).not.toHaveProperty("refetch");
  });

  it("givenLimitInSqlOff_whenRun_thenTextUntouchedAndCursorOpen", async () => {
    const { connection, sent } = open();
    const sessionId = await openSession(connection);

    const result = await executed(connection, sessionId, ROWS, { limitInSql: false });

    expect(sent.at(-1)).toBe(ROWS);
    expect(result).toMatchObject({ rowCount: RESULT_PAGE_ROWS, cursorOpen: true });
    expect(result).not.toHaveProperty("refetch");
  });

  it("givenOwnLimit_whenRun_thenTextUntouched", async () => {
    const { connection, sent } = open();
    const sessionId = await openSession(connection);
    const own = `${ROWS} LIMIT 700`;

    const result = await executed(connection, sessionId, own);

    expect(sent.at(-1)).toBe(own);
    expect(result.cursorOpen).toBe(true);
  });

  it("givenRefetchResult_whenNextPage_thenRunAgainWithLargerLimitAndRowsReplaced", async () => {
    const { connection, sent } = open();
    const sessionId = await openSession(connection);
    const { handle } = await executed(connection, sessionId, ROWS);

    const state = resultOf<ResultState>(await fetchMore(connection, handle, false));
    const window = resultOf<{ rows: unknown[][] }>(
      await connection.handle({ id: 4, type: "result.window", handle, offset: RESULT_PAGE_ROWS * 2 - 1, limit: 1 }),
    );

    expect(limitOf(sent.at(-1))).toBe(RESULT_PAGE_ROWS * 2 + 1);
    expect(state).toMatchObject({ rowCount: RESULT_PAGE_ROWS * 2, complete: false, refetch: true });
    expect(window.rows[0]).toEqual([RESULT_PAGE_ROWS * 2]);
  });

  it("givenRefetchResult_whenFetchAll_thenOneRunReadsToTheEnd", async () => {
    const { connection, sent } = open();
    const sessionId = await openSession(connection);
    const { handle } = await executed(connection, sessionId, ROWS);
    const before = sent.length;

    const state = resultOf<ResultState>(await fetchMore(connection, handle, true));

    expect(sent.length - before).toBe(1);
    expect(limitOf(sent.at(-1))).toBe(RESULT_FETCH_ALL_CAP + 1);
    expect(state).toMatchObject({ rowCount: TOTAL_ROWS, complete: true, cursorOpen: false });
    expect(state).not.toHaveProperty("refetch");
  });

  it("givenSmallCap_whenFetchAll_thenStopsAtTheCap", async () => {
    const { connection } = open();
    const sessionId = await openSession(connection);
    const { handle } = await executed(connection, sessionId, ROWS);

    const state = resultOf<ResultState>(
      await fetchMore(connection, handle, true, { pageRows: RESULT_PAGE_ROWS, fetchAllCap: SMALL_CAP }),
    );

    expect(state).toMatchObject({ rowCount: SMALL_CAP, complete: false, cursorOpen: false });
  });

  it("givenAll_whenRun_thenFirstRunAsksForTheCap", async () => {
    const { connection, sent } = open();
    const sessionId = await openSession(connection);

    const result = await executed(connection, sessionId, ROWS, { all: true });

    expect(limitOf(sent.at(-1))).toBe(RESULT_FETCH_ALL_CAP + 1);
    expect(result).toMatchObject({ rowCount: TOTAL_ROWS, complete: true });
  });

  it("givenTableChangedColumns_whenFetchMore_thenResultChangedAndRowsKept", async () => {
    const { connection } = open();
    const sessionId = await openSession(connection);
    await executed(connection, sessionId, `CREATE TABLE t AS ${ROWS}`);
    const { handle } = await executed(connection, sessionId, "SELECT * FROM t");
    await executed(connection, sessionId, "ALTER TABLE t ADD COLUMN extra TEXT");

    const response: EngineResponse = await fetchMore(connection, handle, false);
    const last = resultOf<{ rows: unknown[][] }>(
      await connection.handle({ id: 5, type: "result.window", handle, offset: RESULT_PAGE_ROWS - 1, limit: 2 }),
    );

    expect(response.type).toBe("engine.error");
    if (response.type === "engine.error") expect(response.error.code).toBe("resultChanged");
    expect(last.rows).toEqual([[RESULT_PAGE_ROWS]]);
  });

  it("givenRefetchResultOnPrivateDatabase_whenExported_thenEveryRowFromItsSession", async () => {
    const directory = await mkdtemp(join(tmpdir(), "table-craft-limit-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "rows.csv");
    const { connection, finished, sent } = open();
    const sessionId = await openSession(connection);
    const { handle } = await executed(connection, sessionId, ROWS);

    const task = await startExport(connection, {
      source: { kind: "result", handle, columns: [0] },
      format: "csv",
      path,
    });
    const done = await finished(task.taskId);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");

    expect(task).toMatchObject({ origin: "session", retryable: false, drains: null });
    expect(sent.at(-1)).toBe(ROWS);
    expect(done).toMatchObject({ state: "done", rows: TOTAL_ROWS });
    expect(lines.at(-1)).toBe(String(TOTAL_ROWS));
  });

  it("givenSyntaxErrorAfterTheLimit_whenMappedBack_thenPositionMovesByItsLength", () => {
    const rewrite = { sql: "SELECT 1 LIMIT 501", inserted: { offset: 8, length: 10 } };

    expect(positionBefore(rewrite, 3)).toBe(3);
    expect(positionBefore(rewrite, 12)).toBeUndefined();
    expect(positionBefore(rewrite, 18)).toBe(8);
  });

  it("givenUnfinishedSelect_whenTheLimitIsBlamed_thenRunAsWrittenAndItsOwnErrorReported", async () => {
    const { connection, sent } = open();
    const sessionId = await openSession(connection);
    const unfinished = "SELECT 1 AS a WHERE 1 >";

    const response = await run(connection, sessionId, unfinished);

    expect(sent.slice(-2)).toEqual([`${unfinished} LIMIT ${String(RESULT_PAGE_ROWS + 1)}`, unfinished]);
    expect(response.type).toBe("engine.error");
    if (response.type === "engine.error") expect(response.error.message).not.toContain("LIMIT");
  });

  it("givenLimitBlamedByPositionOrMessage_whenChecked_thenOnlyThoseRunAgain", () => {
    const rewrite = { sql: "SELECT 1 LIMIT 501", inserted: { offset: 8, length: 10 } };

    expect(failedInLimit(rewrite, new PluginError("statementFailed", "near", { position: { offset: 10 } }))).toBe(true);
    expect(failedInLimit(rewrite, new PluginError("statementFailed", "near", { position: { offset: 3 } }))).toBe(false);
    expect(failedInLimit(rewrite, new Error("near 'LIMIT 501' at line 1"))).toBe(true);
    expect(failedInLimit(rewrite, new Error("no such column: b"))).toBe(false);
  });
});
