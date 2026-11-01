import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import type { ExportTask } from "@table-craft/desktop/engine/protocol.js";
import {
  execute,
  exportHarness,
  openSession,
  resultOf,
  startExport as start,
  STALL_SECONDS,
  type ExportHarness,
} from "../support/engineExports.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};
const ROWS_1200 = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200) SELECT i FROM n";
const ENDLESS = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i, hex(randomblob(64)) FROM n";

function harness(path: string): ExportHarness {
  return exportHarness({ id: "export", pluginId: "sqlite", config: { path }, readOnly: false, keepAliveSeconds: 0 }, [
    LOADED_SQLITE,
  ]);
}

describe("engine exports", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function folder(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "table-craft-export-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    return directory;
  }

  function open(path: string): ExportHarness {
    const opened = harness(path);
    cleanup.push(() => opened.close());
    return opened;
  }

  it("givenReadResult_whenExportStarted_thenRerunOnOwnSessionAndConsoleFree", async () => {
    const directory = await folder();
    const path = join(directory, "rows.csv");
    const { connection, finished } = open(seededSqliteFile());
    const sessionId = await openSession(connection);
    const { handle, cursorOpen } = await execute(connection, sessionId, ROWS_1200);

    const task = await start(connection, { source: { kind: "result", handle, columns: [0] }, format: "csv", path });
    const console = await execute(connection, sessionId, "SELECT 1");
    const done = await finished(task.taskId);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");

    expect(cursorOpen).toBe(true);
    expect(task).toMatchObject({ origin: "rerun", state: "running", retryable: true, drains: null });
    expect(console.rowCount).toBe(1);
    expect(done).toMatchObject({ state: "done", rows: 1200, error: null });
    expect(done.bytes).toBe((await readFile(path)).byteLength);
    expect(lines).toHaveLength(1201);
    expect(lines.at(-1)).toBe("1200");
    expect(await readdir(directory)).toEqual(["rows.csv"]);
  });

  it("givenPrivateDatabaseWithOpenCursor_whenExported_thenCursorDrainedAndFileComplete", async () => {
    const directory = await folder();
    const path = join(directory, "rows.tsv");
    const { connection, finished } = open(":memory:");
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, ROWS_1200);

    const task = await start(connection, { source: { kind: "result", handle, columns: [0] }, format: "tsv", path });
    const done = await finished(task.taskId);
    const state = resultOf<{ cursorOpen: boolean }>(
      await connection.handle({ id: 4, type: "result.stopFetch", handle }),
    );

    expect(task).toMatchObject({ origin: "cursor", retryable: false, drains: handle });
    expect(done).toMatchObject({ state: "done", rows: 1200 });
    expect((await readFile(path, "utf8")).trimEnd().split("\n")).toHaveLength(1201);
    expect(state.cursorOpen).toBe(false);
  });

  it("givenExhaustedResult_whenExported_thenFromMemory", async () => {
    const directory = await folder();
    const path = join(directory, "one.json");
    const { connection, finished } = open(":memory:");
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, "SELECT 1 AS a, 'x' AS b");

    const task = await start(connection, { source: { kind: "result", handle, columns: [1] }, format: "json", path });
    const done = await finished(task.taskId);

    expect(task).toMatchObject({ origin: "memory", estimate: 1, retryable: false });
    expect(done).toMatchObject({ state: "done", rows: 1 });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual([{ b: "x" }]);
  });

  it("givenFilteredReadResult_whenExportedShownOnly_thenShownRowsFromMemory", async () => {
    const directory = await folder();
    const path = join(directory, "shown.csv");
    const { connection, finished } = open(seededSqliteFile());
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, ROWS_1200);
    await connection.handle({
      id: 4,
      type: "result.view",
      handle,
      spec: {
        find: { text: "7", caseSensitive: false, regex: false, wholeCell: true },
        rowsOnly: true,
        filters: [],
        columns: [0],
        formats: { groupDigits: false },
      },
    });

    const task = await start(connection, {
      source: { kind: "result", handle, columns: [0], shownOnly: true },
      format: "csv",
      path,
    });
    const done = await finished(task.taskId);

    expect(task).toMatchObject({ origin: "memory", estimate: 1, retryable: false });
    expect(done).toMatchObject({ state: "done", rows: 1 });
    expect(await readFile(path, "utf8")).toBe("i\n7\n");
  });

  it("givenTableSource_whenExported_thenColumnSubset", async () => {
    const directory = await folder();
    const path = join(directory, "edit_probe.sql");
    const { connection, finished } = open(seededSqliteFile());

    const task = await start(connection, {
      source: { kind: "table", path: ["main"], relation: "edit_probe", columns: ["label", "qty"] },
      format: "sqlInsert",
      path,
    });
    const done = await finished(task.taskId);

    expect(task).toMatchObject({ origin: "table", retryable: true });
    expect(done).toMatchObject({ state: "done", rows: 2 });
    expect(await readFile(path, "utf8")).toBe(
      `INSERT INTO "main"."edit_probe" ("label", "qty") VALUES ('first', 1);\n` +
        `INSERT INTO "main"."edit_probe" ("label", "qty") VALUES ('second', 2);\n`,
    );
  });

  it("givenTask_whenCancelled_thenCancelledEventAndNoFile", async () => {
    const directory = await folder();
    const path = join(directory, "endless.csv");
    const { connection, finished } = open(seededSqliteFile());
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, ENDLESS);

    const task = await start(connection, { source: { kind: "result", handle, columns: [0, 1] }, format: "csv", path });
    await connection.handle({ id: 5, type: "export.cancel", taskId: task.taskId });
    const done = await finished(task.taskId);

    expect(done).toMatchObject({ state: "cancelled", error: { code: "cancelled", reason: "cancelled" } });
    expect(await readdir(directory)).toEqual([]);
  });

  it("givenMissingFolder_whenExported_thenFailedWithFileReason", async () => {
    const directory = await folder();
    const { connection, finished } = open(":memory:");
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, "SELECT 1");

    const task = await start(connection, {
      source: { kind: "result", handle, columns: [0] },
      format: "csv",
      path: join(directory, "missing", "rows.csv"),
    });
    const done = await finished(task.taskId);

    expect(done).toMatchObject({ state: "failed", error: { code: "exportFailed", reason: "file" } });
  });

  it("givenRelativePath_whenExported_thenInvalidRequest", async () => {
    const { connection } = open(":memory:");
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, "SELECT 1");

    const response = await connection.handle({
      id: 6,
      type: "export.start",
      source: { kind: "result", handle, columns: [0] },
      format: "csv",
      path: "relative.csv",
      stallSeconds: STALL_SECONDS,
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
  });

  it("givenMemoryTask_whenRetried_thenInvalidRequest", async () => {
    const directory = await folder();
    const { connection, finished } = open(":memory:");
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, "SELECT 1");
    const task = await start(connection, {
      source: { kind: "result", handle, columns: [0] },
      format: "csv",
      path: join(directory, "one.csv"),
    });
    await finished(task.taskId);

    const response = await connection.handle({
      id: 7,
      type: "export.retry",
      taskId: task.taskId,
      stallSeconds: STALL_SECONDS,
    });

    expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
  });

  it("givenFinishedTableTask_whenRetried_thenNewTaskAndListHoldsBoth", async () => {
    const directory = await folder();
    const path = join(directory, "probe.xlsx");
    const { connection, finished } = open(seededSqliteFile());
    const task = await start(connection, {
      source: { kind: "table", path: ["main"], relation: "edit_probe", columns: ["id", "label"] },
      format: "xlsx",
      path,
    });
    await finished(task.taskId);
    const firstEnded = Date.now();

    const again = resultOf<ExportTask>(
      await connection.handle({ id: 8, type: "export.retry", taskId: task.taskId, stallSeconds: STALL_SECONDS }),
    );
    const done = await finished(again.taskId);
    const listed = resultOf<ExportTask[]>(await connection.handle({ id: 9, type: "export.list" }));

    expect(again.taskId).not.toBe(task.taskId);
    expect(done).toMatchObject({ state: "done", rows: 2, sheets: 1 });
    expect(listed.map((entry) => entry.taskId)).toEqual([task.taskId, again.taskId]);
    expect(again.startedAt).toBeGreaterThanOrEqual(firstEnded);
  });

  it("givenStart_whenTask_thenStartedAtFromClockAndKeptToTheEnd", async () => {
    const directory = await folder();
    const { connection, finished } = open(":memory:");
    const sessionId = await openSession(connection);
    const { handle } = await execute(connection, sessionId, "SELECT 1");
    const before = Date.now();

    const task = await start(connection, {
      source: { kind: "result", handle, columns: [0] },
      format: "csv",
      path: join(directory, "one.csv"),
    });
    const done = await finished(task.taskId);

    expect(task.startedAt).toBeGreaterThanOrEqual(before);
    expect(task.startedAt).toBeLessThanOrEqual(Date.now());
    expect(done.startedAt).toBe(task.startedAt);
  });
});
