import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { submitEdits } from "@table-craft/core";
import { PluginError } from "@table-craft/plugin-api";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { seededDuckdbFiles, type DuckdbFixtureFiles } from "../support/duckdbFixture.js";
import { openDuckdb, rowsOf, type DuckdbSession } from "../support/duckdbSession.js";

const DRIVER = pathToFileURL(
  createRequire(new URL("../../plugins/duckdb/package.json", import.meta.url)).resolve("@duckdb/node-api"),
).href;
/** Opens the file read-write in another process, says so, and holds it until stdin closes. */
const HOLDER = `
const { DuckDBInstance } = await import(process.argv[1]);
try {
  const instance = await DuckDBInstance.create(process.argv[2]);
  await instance.connect();
  process.stdout.write("ready\\n");
  if (process.argv[3] !== "hold") process.exit(0);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
} catch (error) {
  process.stdout.write("failed " + error.message + "\\n");
  process.exit(0);
}`;
const SLOW_QUERY = "SELECT count(*) FROM range(100000000000) a WHERE a.range = -1";
const SETTLE_MS = 100;

function otherProcess(path: string, hold: boolean): { child: ChildProcess; answer: Promise<string> } {
  const child = spawn(process.execPath, ["--input-type=module", "-e", HOLDER, DRIVER, path, hold ? "hold" : "once"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const answer = new Promise<string>((resolve) => {
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("\n")) resolve(text.trim());
    });
  });
  return { child, answer };
}

function updateRow(session: DuckdbSession, id: number): Promise<unknown> {
  return rowsOf(session, `UPDATE customers SET name = 'changed' WHERE id = ${String(id)}`);
}

describe("DuckDB sessions", () => {
  let files: DuckdbFixtureFiles;
  const open: DuckdbSession[] = [];

  async function session(options: Parameters<typeof openDuckdb>[1] = {}): Promise<DuckdbSession> {
    const opened = await openDuckdb(files.database, options);
    open.push(opened);
    return opened;
  }

  beforeAll(async () => {
    files = await seededDuckdbFiles();
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((opened) => opened.close()));
  });

  it("givenTwoSessionsOnOneFile_whenConnect_thenOneInstanceShared", async () => {
    const first = await session();
    const second = await session();

    await rowsOf(first, "CREATE TABLE shared_probe AS SELECT 1 AS n");
    const rows = await rowsOf(second, "SELECT n FROM shared_probe");

    expect(rows).toEqual([[1]]);
    await rowsOf(first, "DROP TABLE shared_probe");
  });

  it("givenLastSessionClosed_whenAnotherProcessOpens_thenLockReleased", async () => {
    await session();
    await session();
    await Promise.all(open.splice(0).map((opened) => opened.close()));

    const { answer } = otherProcess(files.database, false);

    expect(await answer).toBe("ready");
  });

  it("givenFileHeldByChildProcess_whenConnect_thenConnectionFailedNamesPid", async () => {
    const path = join(files.directory, "held.duckdb");
    const { child, answer } = otherProcess(path, true);
    try {
      expect(await answer).toBe("ready");

      const failure = await openDuckdb(path).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PluginError);
      expect(failure).toMatchObject({ code: "connectionFailed" });
      expect((failure as Error).message).toContain(`(PID ${String(child.pid)})`);
    } finally {
      child.stdin?.end();
    }
  });

  it("givenReadOnlySession_whenInsert_thenRefused", async () => {
    const readOnly = await session({ readOnly: true });

    const failure = await rowsOf(readOnly, "INSERT INTO no_key_probe VALUES ('x')").catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "statementFailed" });
    expect((failure as Error).message).toMatch(/read-only/u);
    expect(readOnly.services.transactions.open).toBe(false);
  });

  it("givenReadOnlyManualMode_whenFirstStatement_thenReadOnlyTransactionOpened", async () => {
    const readOnly = await session({ readOnly: true });
    await readOnly.services.transactions.setMode("manual");

    await rowsOf(readOnly, "SELECT 1");
    const failure = await rowsOf(readOnly, "DELETE FROM no_key_probe").catch((error: unknown) => error);

    expect(readOnly.services.transactions.open).toBe(true);
    expect((failure as Error).message).toMatch(/read-only/u);
    await readOnly.services.transactions.rollback();
    await readOnly.services.transactions.setMode("auto");
  });

  it("givenReadOnlySession_whenUserBegins_thenBeginRunsBare", async () => {
    const readOnly = await session({ readOnly: true });

    await rowsOf(readOnly, "BEGIN TRANSACTION");
    const result = await readOnly.execute("CREATE TEMP TABLE scratch (n INTEGER)");
    await rowsOf(readOnly, "ROLLBACK");

    expect(result.rowsAffected).toBeNull();
    expect(readOnly.services.transactions.open).toBe(false);
  });

  it("givenLongQuery_whenCancel_thenInterruptedAndSessionUsable", async () => {
    const busy = await session();
    const running = busy.execute(SLOW_QUERY).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    await busy.services.cancel.cancel();

    expect(await running).toMatchObject({ code: "cancelled" });
    expect(await rowsOf(busy, "SELECT 42")).toEqual([[42]]);
  });

  it("givenCancelBeforeStatementStarts_whenStatementRuns_thenItIsInterrupted", async () => {
    const busy = await session();
    const running = busy.execute(SLOW_QUERY).catch((error: unknown) => error);

    await busy.services.cancel.cancel();

    expect(await running).toMatchObject({ code: "cancelled" });
  });

  it("givenOpenTransaction_whenInsertRowsFails_thenErrorSaysRollBack", async () => {
    const manual = await session();
    await manual.services.transactions.setMode("manual");
    await rowsOf(manual, "SELECT 1");
    const target = {
      table: '"customers"',
      columns: [
        { name: "id", type: "INTEGER" },
        { name: "name", type: "VARCHAR" },
        { name: "email", type: "VARCHAR" },
      ],
    };

    const failure = await manual.services.bulkInsert
      .insertRows(target, [["1", "Duplicate", "dup@example.com"]])
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "statementFailed" });
    expect((failure as Error).message).toMatch(/roll it back/u);
    await manual.services.transactions.rollback();
    await manual.services.transactions.setMode("auto");
  });

  it("givenTwoTransactionsUpdateOneRow_whenSecondUpdates_thenStatementFailedWithConflict", async () => {
    const first = await session();
    const second = await session();
    await rowsOf(first, "BEGIN TRANSACTION");
    await rowsOf(second, "BEGIN TRANSACTION");
    await updateRow(first, 1);

    const failure = await updateRow(second, 1).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "statementFailed" });
    expect((failure as Error).message).toMatch(/Conflict on update/u);
    await rowsOf(first, "ROLLBACK");
    await rowsOf(second, "ROLLBACK");
  });

  it("givenAbortedTransaction_whenCommit_thenTransactionClosed", async () => {
    const manual = await session();
    await manual.services.transactions.setMode("manual");
    await rowsOf(manual, "INSERT INTO no_key_probe VALUES ('kept?')");
    await rowsOf(manual, "SELECT 1 FROM missing_table").catch(() => undefined);

    await manual.services.transactions.commit();

    expect(manual.services.transactions.open).toBe(false);
    expect(await rowsOf(manual, "SELECT count(*) FROM no_key_probe WHERE label = 'kept?'")).toEqual([[0]]);
    await manual.services.transactions.rollback();
    await manual.services.transactions.setMode("auto");
  });

  it("givenCommitFails_whenCommit_thenStatementFailedAndTransactionClosed", async () => {
    const first = await session();
    const second = await session();
    await first.services.transactions.setMode("manual");
    await second.services.transactions.setMode("manual");
    await rowsOf(first, "INSERT INTO customers (id, name, email) VALUES (900, 'One', 'one@example.com')");
    await rowsOf(second, "INSERT INTO customers (id, name, email) VALUES (900, 'Two', 'two@example.com')");
    await first.services.transactions.commit();

    const failure = await second.services.transactions.commit().catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "statementFailed" });
    expect((failure as Error).message).toMatch(/duplicate key/u);
    expect(second.services.transactions.open).toBe(false);
    await first.services.transactions.setMode("auto");
    await second.services.transactions.setMode("auto");
    await rowsOf(first, "DELETE FROM customers WHERE id = 900");
  });

  it("givenRowChangedInAnOpenConsoleTransaction_whenSubmit_thenRejectedWithConflictAndSessionBackToAuto", async () => {
    const console = await session();
    const editor = await session();
    await rowsOf(console, "BEGIN TRANSACTION");
    await updateRow(console, 2);

    const failure = await submitEdits(editor, ["UPDATE customers SET name = 'editor' WHERE id = 2"]).catch(
      (error: unknown) => error,
    );

    expect((failure as Error).message).toMatch(/^Statement 1 failed: .*Conflict on update/u);
    expect(editor.services.transactions.mode).toBe("auto");
    expect(editor.services.transactions.open).toBe(false);
    await rowsOf(console, "ROLLBACK");
  });
});
