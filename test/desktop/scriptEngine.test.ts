import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import type { EngineResponse, ScriptEvent, ScriptTask } from "@table-craft/desktop/engine/protocol.js";
import { execute, exportHarness, openSession, resultOf, type ExportHarness } from "../support/engineExports.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};
const FINAL = new Set(["script.done", "script.failed", "script.cancelled"]);
const POLL_MS = 5;

describe("engine scripts", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function file(name: string, text: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "table-craft-script-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, name);
    await writeFile(path, text);
    return path;
  }

  function open(readOnly = false): ExportHarness {
    const opened = exportHarness(
      { id: "script", pluginId: "sqlite", config: { path: seededSqliteFile() }, readOnly, keepAliveSeconds: 0 },
      [LOADED_SQLITE],
    );
    cleanup.push(() => opened.close());
    return opened;
  }

  async function finished(harness: ExportHarness, taskId: string): Promise<ScriptTask> {
    for (;;) {
      const event = harness.events.find(
        (candidate): candidate is ScriptEvent => candidate.task.taskId === taskId && FINAL.has(candidate.type),
      );
      if (event !== undefined) return event.task;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async function run(harness: ExportHarness, files: readonly string[]): Promise<EngineResponse> {
    return harness.connection.handle({ id: 7, type: "script.run", files, namespace: null });
  }

  it("givenScriptFile_whenRun_thenEveryStatementAppliedOnItsOwnSession", async () => {
    const harness = open();
    const path = await file(
      "seed.sql",
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);\n" +
        "INSERT INTO notes (body) VALUES ('a;b');\n" +
        "INSERT INTO notes (body) VALUES ('c');\n",
    );

    const task = resultOf<ScriptTask>(await run(harness, [path]));
    const done = await finished(harness, task.taskId);

    expect(done).toMatchObject({ state: "done", statements: 3, files: [path] });
    const sessionId = await openSession(harness.connection);
    const result = await execute(harness.connection, sessionId, "SELECT body FROM notes ORDER BY id");
    expect(result.firstWindow.rows).toEqual([["a;b"], ["c"]]);
  });

  it("givenStatementFails_whenRun_thenStopsThereWithLineAndColumn", async () => {
    const harness = open();
    const path = await file(
      "broken.sql",
      "CREATE TABLE kept (id INTEGER);\n\n   INSERT INTO nowhere VALUES (1);\nCREATE TABLE never (id INTEGER);\n",
    );

    const done = await finished(harness, resultOf<ScriptTask>(await run(harness, [path])).taskId);

    expect(done.state).toBe("failed");
    expect(done.statements).toBe(1);
    expect(done.error).toMatchObject({ code: "statementFailed", file: path, line: 3, column: 4 });
    expect(done.error?.message).toContain("nowhere");
    const sessionId = await openSession(harness.connection);
    const tables = await execute(
      harness.connection,
      sessionId,
      "SELECT name FROM sqlite_master WHERE name IN ('kept', 'never') ORDER BY name",
    );
    expect(tables.firstWindow.rows).toEqual([["kept"]]);
  });

  it("givenRelativeOrMissingFile_whenRun_thenRefusedBeforeATask", async () => {
    const harness = open();

    const relative = await run(harness, ["seed.sql"]);
    const missing = await run(harness, [join(tmpdir(), "table-craft-no-such-script.sql")]);

    expect(relative).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
    expect(missing).toMatchObject({ type: "engine.error", error: { code: "scriptFailed" } });
  });
});
