import { describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type {
  EngineResponse,
  ExecutedStatement,
  ResultEditable,
  RowEdit,
  SubmittedEdits,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { languageFor } from "../support/declaredServices.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const MAIN = ["main"];

type Connection = ReturnType<ReturnType<typeof createEngine>["connect"]>;

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

const WITHOUT_SAVEPOINTS = sqlite.capabilities.filter((capability) => capability !== "savepoints");
const LOADED_WITHOUT_SAVEPOINTS: PluginLoadResult = {
  ...LOADED_SQLITE,
  manifest: { ...SQLITE_MANIFEST, capabilities: WITHOUT_SAVEPOINTS },
  plugin: { ...sqlite, capabilities: WITHOUT_SAVEPOINTS, language: languageFor(sqlite.language, WITHOUT_SAVEPOINTS) },
};

async function opened(readOnly = false, loaded = LOADED_SQLITE) {
  const engine = createEngine({
    datasource: {
      id: "seeded",
      pluginId: "sqlite",
      config: { path: seededSqliteFile() },
      readOnly,
      keepAliveSeconds: 0,
    },
    plugins: [loaded],
  });
  const connection = engine.connect();
  const sessionId = resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
  return { connection, sessionId };
}

async function run(connection: Connection, sessionId: string, sql: string): Promise<ExecutedStatement> {
  return resultOf<ExecutedStatement>(
    await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql }),
  );
}

async function editable(connection: Connection, handle: string): Promise<ResultEditable> {
  return resultOf<ResultEditable>(await connection.handle({ id: 3, type: "result.editable", handle, current: MAIN }));
}

async function submit(connection: Connection, sessionId: string, handle: string, edits: RowEdit[]) {
  return connection.handle({ id: 4, type: "edits.submit", sessionId, handle, edits });
}

async function transactionMode(connection: Connection, sessionId: string, mode: "auto" | "manual") {
  resultOf(await connection.handle({ id: 5, type: "transaction.setMode", sessionId, mode }));
}

describe("engine console result editing", () => {
  it("givenSingleTableSelect_whenAskedIfEditable_thenKeyedByItsPrimaryKey", async () => {
    const { connection, sessionId } = await opened();
    const executed = await run(connection, sessionId, "SELECT id, label, qty * 2 AS twice FROM edit_probe ORDER BY id");

    const answer = await editable(connection, executed.handle);

    expect(answer.editable).toEqual({ identity: ["id"] });
    expect(answer.readOnlyColumns).toEqual([false, false, true]);
    expect(answer.columns.map((column) => column.name)).toEqual(["id", "label", "twice"]);
  });

  it("givenJoin_whenAskedIfEditable_thenReadOnlyWithTheReason", async () => {
    const { connection, sessionId } = await opened();
    const executed = await run(
      connection,
      sessionId,
      "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id",
    );

    const answer = await editable(connection, executed.handle);

    expect(answer.editable).toEqual({ readOnly: "the result joins two or more tables" });
    expect(answer.readOnlyColumns).toEqual([true, true]);
  });

  it("givenTableWithoutKey_whenAskedIfEditable_thenReadOnlyForNoKey", async () => {
    const { connection, sessionId } = await opened();
    const executed = await run(connection, sessionId, "SELECT * FROM no_key_probe");

    const answer = await editable(connection, executed.handle);

    expect(answer.editable).toEqual({ readOnly: "the result has no primary key column" });
  });

  it("givenReadOnlyDatasource_whenAskedIfEditable_thenReadOnly", async () => {
    const { connection, sessionId } = await opened(true);
    const executed = await run(connection, sessionId, "SELECT * FROM edit_probe");

    const answer = await editable(connection, executed.handle);

    expect(answer.editable).toEqual({ readOnly: "the datasource is read-only" });
  });

  it("givenEditableResult_whenPreviewed_thenStatementsAgainstTheTable", async () => {
    const { connection, sessionId } = await opened();
    const executed = await run(connection, sessionId, "SELECT id, note FROM edit_probe ORDER BY id");
    await editable(connection, executed.handle);

    const statements = resultOf<string[]>(
      await connection.handle({
        id: 6,
        type: "edits.preview",
        handle: executed.handle,
        edits: [{ kind: "update", row: 1, values: [{ column: 1, value: { kind: "text", text: "x" } }] }],
      }),
    );

    expect(statements).toEqual([`UPDATE "main"."edit_probe" SET "note" = 'x' WHERE "id" = 2`]);
  });

  it("givenAutoCommitConsole_whenSubmitted_thenCommittedAndNoTransactionLeftOpen", async () => {
    const { connection, sessionId } = await opened();
    const executed = await run(connection, sessionId, "SELECT id, label FROM edit_probe ORDER BY id");
    await editable(connection, executed.handle);

    const submitted = resultOf<SubmittedEdits & { transactionOpen: boolean }>(
      await submit(connection, sessionId, executed.handle, [
        { kind: "update", row: 0, values: [{ column: 1, value: { kind: "text", text: "edited" } }] },
      ]),
    );
    const after = await run(connection, sessionId, "SELECT label FROM edit_probe ORDER BY id");

    expect(submitted).toMatchObject({ rowsAffected: 1, transactionOpen: false });
    expect(after.firstWindow.rows.map((row) => row[0])).toEqual(["edited", "second"]);
  });

  it("givenManualConsole_whenSubmitted_thenEditsStayInTheOpenTransactionUntilRolledBack", async () => {
    const { connection, sessionId } = await opened();
    await transactionMode(connection, sessionId, "manual");
    const executed = await run(connection, sessionId, "SELECT id, label FROM edit_probe ORDER BY id");
    await editable(connection, executed.handle);

    const submitted = resultOf<SubmittedEdits & { transactionOpen: boolean }>(
      await submit(connection, sessionId, executed.handle, [{ kind: "delete", row: 1 }]),
    );
    const inside = await run(connection, sessionId, "SELECT count(*) FROM edit_probe");
    resultOf(await connection.handle({ id: 7, type: "transaction.rollback", sessionId }));
    const afterRollback = await run(connection, sessionId, "SELECT count(*) FROM edit_probe");

    expect(submitted.transactionOpen).toBe(true);
    expect(inside.firstWindow.rows).toEqual([[1]]);
    expect(afterRollback.firstWindow.rows).toEqual([[2]]);
  });

  it("givenRowChangedElsewhere_whenSubmitted_thenEditRejected", async () => {
    const { connection, sessionId } = await opened();
    const other = resultOf<{ sessionId: string }>(await connection.handle({ id: 8, type: "session.open" })).sessionId;
    const executed = await run(connection, sessionId, "SELECT id, label FROM edit_probe ORDER BY id");
    await editable(connection, executed.handle);
    await run(connection, other, "DELETE FROM edit_probe WHERE id = 2");

    const response = await submit(connection, sessionId, executed.handle, [
      { kind: "update", row: 1, values: [{ column: 1, value: { kind: "text", text: "lost" } }] },
    ]);

    expect(response).toMatchObject({ type: "engine.error", error: { code: "editRejected", statementIndex: 0 } });
  });

  it("givenNoSavepointsService_whenEditsInOpenTransaction_thenRefusedWithCommitHint", async () => {
    const { connection, sessionId } = await opened(false, LOADED_WITHOUT_SAVEPOINTS);
    await transactionMode(connection, sessionId, "manual");
    const executed = await run(connection, sessionId, "SELECT id, label FROM edit_probe ORDER BY id");
    await editable(connection, executed.handle);

    const response = await submit(connection, sessionId, executed.handle, [{ kind: "delete", row: 1 }]);
    const count = await run(connection, sessionId, "SELECT count(*) FROM edit_probe");

    expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
    expect(response.type === "engine.error" && response.error.hint).toContain("Commit or roll back");
    expect(count.firstWindow.rows).toEqual([[2]]);
  });

  it("givenSavepointsService_whenEditRejected_thenOnlyEditsUndone", async () => {
    const { connection, sessionId } = await opened();
    await transactionMode(connection, sessionId, "manual");
    await run(connection, sessionId, "UPDATE edit_probe SET label = 'kept' WHERE id = 1");
    const executed = await run(connection, sessionId, "SELECT id, label FROM edit_probe ORDER BY id");
    await editable(connection, executed.handle);
    await run(connection, sessionId, "DELETE FROM edit_probe WHERE id = 2");

    const response = await submit(connection, sessionId, executed.handle, [
      { kind: "update", row: 0, values: [{ column: 1, value: { kind: "text", text: "undone" } }] },
      { kind: "update", row: 1, values: [{ column: 1, value: { kind: "text", text: "lost" } }] },
    ]);
    const labels = await run(connection, sessionId, "SELECT label FROM edit_probe ORDER BY id");

    expect(response).toMatchObject({ type: "engine.error", error: { code: "editRejected", statementIndex: 1 } });
    expect(labels.firstWindow.rows).toEqual([["kept"]]);
  });

  it("givenResultNeverAskedIfEditable_whenSubmitted_thenInvalidRequest", async () => {
    const { connection, sessionId } = await opened();
    const executed = await run(connection, sessionId, "SELECT id, label FROM edit_probe");

    const response = await submit(connection, sessionId, executed.handle, [{ kind: "delete", row: 0 }]);

    expect(response).toMatchObject({ type: "engine.error", error: { code: "invalidRequest" } });
  });
});
