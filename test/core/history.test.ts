import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openQueryHistory, type HistoryEntry, type QueryHistory } from "@table-craft/core";

const PG = "pg";
const MYSQL = "mysql";
const MEMORY = ":memory:";

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    datasourceId: PG,
    sql: "SELECT 1",
    startedAt: 1_000,
    durationMs: 5,
    outcome: "success",
    rowCount: 1,
    message: null,
    source: "console",
    ...overrides,
  };
}

const opened: QueryHistory[] = [];
const directories: string[] = [];

function open(path = MEMORY, options: Parameters<typeof openQueryHistory>[1] = {}): QueryHistory {
  const history = openQueryHistory(path, options);
  opened.push(history);
  return history;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "table-craft-history-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const history of opened.splice(0)) history.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("query history", () => {
  it("givenHistory_whenRecentRuns_thenNoSqlOrMessageNewestFirst", () => {
    const history = open();
    history.record(entry({ startedAt: 1_000, sql: "SELECT secret_column" }));
    history.record(entry({ datasourceId: MYSQL, startedAt: 3_000, outcome: "error", message: "boom", rowCount: null }));
    history.record(entry({ startedAt: 2_000 }));

    const runs = history.recentRuns(2);

    expect(runs).toEqual([
      {
        datasourceId: MYSQL,
        startedAt: 3_000,
        durationMs: 5,
        outcome: "error",
        rowCount: null,
        source: "console",
        warnings: null,
      },
      {
        datasourceId: PG,
        startedAt: 2_000,
        durationMs: 5,
        outcome: "success",
        rowCount: 1,
        source: "console",
        warnings: null,
      },
    ]);
  });

  it("givenStatementsRecorded_whenSearched_thenNewestFirstAndGroupedByText", () => {
    const history = open();
    history.record(entry({ sql: "SELECT 1", startedAt: 1_000, durationMs: 3 }));
    history.record(entry({ sql: "SELECT * FROM orders", startedAt: 2_000 }));
    history.record(
      entry({ sql: "SELECT 1", startedAt: 3_000, durationMs: 9, outcome: "error", rowCount: null, message: "boom" }),
    );

    expect(history.search(PG, "")).toEqual([
      {
        sql: "SELECT 1",
        lastStartedAt: 3_000,
        lastDurationMs: 9,
        lastOutcome: "error",
        lastRowCount: null,
        lastMessage: "boom",
        lastParameters: null,
        lastSource: "console",
        lastClient: null,
        runs: 2,
      },
      {
        sql: "SELECT * FROM orders",
        lastStartedAt: 2_000,
        lastDurationMs: 5,
        lastOutcome: "success",
        lastRowCount: 1,
        lastMessage: null,
        lastParameters: null,
        lastSource: "console",
        lastClient: null,
        runs: 1,
      },
    ]);
  });

  it("givenMixedCase_whenSearched_thenMatchesCaseInsensitively", () => {
    const history = open();
    history.record(entry({ sql: "SELECT * FROM Orders" }));
    history.record(entry({ sql: "SELECT * FROM customers", startedAt: 2_000 }));

    expect(history.search(PG, "oRdErS").map((found) => found.sql)).toEqual(["SELECT * FROM Orders"]);
  });

  it("givenQueryWithPercent_whenSearched_thenMatchesLiterally", () => {
    const history = open();
    history.record(entry({ sql: "SELECT '50%' AS share" }));
    history.record(entry({ sql: "SELECT 50 AS share", startedAt: 2_000 }));
    history.record(entry({ sql: "SELECT a_b FROM t", startedAt: 3_000 }));
    history.record(entry({ sql: "SELECT axb FROM t", startedAt: 4_000 }));

    expect(history.search(PG, "50%").map((found) => found.sql)).toEqual(["SELECT '50%' AS share"]);
    expect(history.search(PG, "a_b").map((found) => found.sql)).toEqual(["SELECT a_b FROM t"]);
  });

  it("givenSearchLimit_whenSearched_thenAnswersAtMostThatMany", () => {
    const history = open();
    for (let index = 0; index < 5; index += 1)
      history.record(entry({ sql: `SELECT ${String(index)}`, startedAt: index }));

    expect(history.search(PG, "", 2).map((found) => found.sql)).toEqual(["SELECT 4", "SELECT 3"]);
  });

  it("givenMoreThanLimit_whenRecorded_thenOldestPruned", () => {
    const history = open(MEMORY, { limit: 3 });
    for (let index = 0; index < 5; index += 1)
      history.record(entry({ sql: `SELECT ${String(index)}`, startedAt: index }));
    history.record(entry({ datasourceId: MYSQL, sql: "SELECT 0", startedAt: 0 }));

    expect(history.search(PG, "").map((found) => found.sql)).toEqual(["SELECT 4", "SELECT 3", "SELECT 2"]);
    expect(history.search(MYSQL, "")).toHaveLength(1);
  });

  it("givenTwoDatasources_whenOneCleared_thenOtherKept", () => {
    const history = open();
    history.record(entry({ datasourceId: PG }));
    history.record(entry({ datasourceId: MYSQL }));

    history.clear(PG);

    expect(history.search(PG, "")).toEqual([]);
    expect(history.search(MYSQL, "")).toHaveLength(1);
  });

  it("givenRecordedToFile_whenReopened_thenStillListed", async () => {
    const path = join(await temporaryDirectory(), "history.sqlite");
    const first = openQueryHistory(path);
    first.record(entry({ sql: "SELECT 42" }));
    first.close();

    const reopened = open(path);

    expect(reopened.recoveredFrom).toBeNull();
    expect(reopened.search(PG, "").map((found) => found.sql)).toEqual(["SELECT 42"]);
  });

  it("givenCorruptFile_whenOpened_thenRenamedAndFresh", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "history.sqlite");
    await writeFile(path, "this is not a database, it is a sentence long enough to fill a header");

    const history = open(path, { now: () => 1234 });
    history.record(entry());

    expect(history.recoveredFrom).toBe(`${path}.corrupt-1234`);
    expect(await readdir(directory)).toContain("history.sqlite.corrupt-1234");
    expect(history.search(PG, "")).toHaveLength(1);
  });

  it("givenSqliteFileOfAnotherSchema_whenOpened_thenRenamedAndFresh", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const directory = await temporaryDirectory();
    const path = join(directory, "history.sqlite");
    const other = new DatabaseSync(path);
    other.exec("CREATE TABLE something (x INTEGER)");
    other.close();

    const history = open(path, { now: () => 99 });

    expect(history.recoveredFrom).toBe(`${path}.corrupt-99`);
    expect(history.search(PG, "")).toEqual([]);
  });

  it("givenParameters_whenRecorded_thenSearchReturnsLastValues", () => {
    const history = open();
    history.record(entry({ sql: "SELECT :id", startedAt: 1_000, parameters: { ":id": "1" } }));
    history.record(entry({ sql: "SELECT :id", startedAt: 2_000, parameters: { ":id": null } }));

    expect(history.search(PG, "").map((found) => found.lastParameters)).toEqual([{ ":id": null }]);
  });

  it("givenVersionOneFile_whenOpened_thenMigratedKeepingRows", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(await temporaryDirectory(), "history.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE entries (
      id INTEGER PRIMARY KEY, datasource_id TEXT NOT NULL, sql TEXT NOT NULL, started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL, row_count INTEGER NULL, message TEXT NULL,
      source TEXT NOT NULL);
    INSERT INTO entries (datasource_id, sql, started_at, duration_ms, outcome, row_count, message, source)
      VALUES ('pg', 'SELECT 1', 1, 2, 'success', 1, NULL, 'console');
    PRAGMA user_version = 1;`);
    old.close();

    const history = open(path);
    history.record(entry({ sql: "SELECT :x", parameters: { ":x": "y" } }));

    expect(history.recoveredFrom).toBeNull();
    expect(history.search(PG, "").map((found) => [found.sql, found.lastParameters])).toEqual([
      ["SELECT :x", { ":x": "y" }],
      ["SELECT 1", null],
    ]);
  });

  it("givenWarnings_whenRecorded_thenRecentRunsCountThem", () => {
    const history = open();
    history.record(entry({ warnings: 2 }));

    expect(history.recentRuns(1).map((run) => run.warnings)).toEqual([2]);
  });

  it("givenVersionTwoFile_whenOpened_thenMigratedKeepingRows", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(await temporaryDirectory(), "history.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE entries (
      id INTEGER PRIMARY KEY, datasource_id TEXT NOT NULL, sql TEXT NOT NULL, started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL, row_count INTEGER NULL, message TEXT NULL,
      source TEXT NOT NULL, parameters TEXT NULL);
    INSERT INTO entries (datasource_id, sql, started_at, duration_ms, outcome, row_count, message, source, parameters)
      VALUES ('pg', 'SELECT 1', 1, 2, 'success', 1, NULL, 'console', NULL);
    PRAGMA user_version = 2;`);
    old.close();

    const history = open(path);
    history.record(entry({ sql: "SELECT 2", startedAt: 5, warnings: 1 }));

    expect(history.recoveredFrom).toBeNull();
    expect(history.recentRuns(2).map((run) => run.warnings)).toEqual([1, null]);
  });

  it("givenVersionThreeFile_whenOpened_thenClientColumnAddedKeepingRows", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const path = join(await temporaryDirectory(), "history.sqlite");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE entries (
      id INTEGER PRIMARY KEY, datasource_id TEXT NOT NULL, sql TEXT NOT NULL, started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL, row_count INTEGER NULL, message TEXT NULL,
      source TEXT NOT NULL, parameters TEXT NULL, warnings INTEGER NULL);
    INSERT INTO entries (datasource_id, sql, started_at, duration_ms, outcome, row_count, message, source, parameters, warnings)
      VALUES ('pg', 'SELECT 1', 1, 2, 'success', 1, NULL, 'console', NULL, NULL);
    PRAGMA user_version = 3;`);
    old.close();

    const history = open(path);
    history.record(entry({ sql: "SELECT 2", startedAt: 5, source: "agent", client: "Claude Code" }));

    expect(history.recoveredFrom).toBeNull();
    expect(history.search(PG, "").map((found) => [found.sql, found.lastSource, found.lastClient])).toEqual([
      ["SELECT 2", "agent", "Claude Code"],
      ["SELECT 1", "console", null],
    ]);
  });
});
