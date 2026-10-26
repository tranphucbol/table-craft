import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type {
  CellBytes,
  EngineResponse,
  ExecutedStatement,
  RowEdit,
  StagedBytes,
  TableQuery,
} from "@table-craft/desktop/engine/protocol.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};
const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const TYPE_PROBE = "type_probe";
const PAYLOAD = 7;
const FLAG = 5;
const FILE_BYTES = 100;
const LIMIT = 1024;

type Connection = ReturnType<ReturnType<typeof createEngine>["connect"]>;

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

function errorOf(response: EngineResponse) {
  if (response.type !== "engine.error") throw new Error("expected an engine error");
  return response.error;
}

function scratchFile(name: string, contents?: Uint8Array): string {
  const path = join(mkdtempSync(join(tmpdir(), "table-craft-bytes-")), name);
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

function fileBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 256);
}

async function opened() {
  const connection = createEngine({
    datasource: {
      id: "seeded",
      pluginId: "sqlite",
      config: { path: seededSqliteFile() },
      readOnly: false,
      keepAliveSeconds: 0,
    },
    plugins: [LOADED_SQLITE],
  }).connect();
  const { sessionId } = resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" }));
  return { connection, sessionId };
}

async function probe(connection: Connection, sessionId: string): Promise<TableQuery> {
  return resultOf<TableQuery>(
    await connection.handle({
      id: 2,
      type: "table.query",
      ...PAGING,
      sessionId,
      path: ["main"],
      relation: TYPE_PROBE,
      where: "",
      orderBy: "id",
    }),
  );
}

async function load(connection: Connection, handle: string, path: string, maxBytes = LIMIT): Promise<EngineResponse> {
  return connection.handle({ id: 3, type: "result.loadBytes", handle, path, maxBytes });
}

describe("engine binary cells", () => {
  it("givenBlob_whenSaveToFile_thenFullBytesWritten", async () => {
    const { connection, sessionId } = await opened();
    const before = await probe(connection, sessionId);
    const staged = resultOf<StagedBytes>(
      await load(connection, before.statement.handle, scratchFile("in.bin", fileBytes(FILE_BYTES))),
    );
    const edits: RowEdit[] = [
      { kind: "update", row: 0, values: [{ column: PAYLOAD, value: { kind: "bytes", ...staged } }] },
    ];
    resultOf(
      await connection.handle({ id: 4, type: "edits.submit", sessionId, handle: before.statement.handle, edits }),
    );
    const after = await probe(connection, sessionId);
    const target = scratchFile("out.bin");

    const written = resultOf<number>(
      await connection.handle({
        id: 5,
        type: "result.saveBytes",
        handle: after.statement.handle,
        row: 0,
        column: PAYLOAD,
        path: target,
        maxBytes: LIMIT,
      }),
    );

    expect(staged.length).toBe(FILE_BYTES);
    expect(after.statement.firstWindow.rows[0]?.[PAYLOAD]).toMatchObject({ kind: "bytes", length: FILE_BYTES });
    expect(written).toBe(FILE_BYTES);
    expect([...readFileSync(target)]).toEqual([...fileBytes(FILE_BYTES)]);
  });

  it("givenStagedFile_whenPreviewed_thenClippedLiteralAndSubmitWritesEveryByte", async () => {
    const { connection, sessionId } = await opened();
    const table = await probe(connection, sessionId);
    const staged = resultOf<StagedBytes>(
      await load(connection, table.statement.handle, scratchFile("in.bin", fileBytes(FILE_BYTES))),
    );
    const edits: RowEdit[] = [
      {
        kind: "update",
        row: 1,
        values: [
          { column: PAYLOAD, value: { kind: "bytes", ...staged } },
          { column: FLAG, value: { kind: "boolean", value: true } },
        ],
      },
    ];

    const [statement] = resultOf<string[]>(
      await connection.handle({ id: 6, type: "edits.preview", handle: table.statement.handle, edits }),
    );

    expect(statement).toContain(`of ${String(FILE_BYTES)} bytes`);
    expect(statement).toContain('"flag" = TRUE');
  });

  it("givenOversizeFile_whenLoad_thenRefused", async () => {
    const { connection, sessionId } = await opened();
    const table = await probe(connection, sessionId);

    const error = errorOf(await load(connection, table.statement.handle, scratchFile("big.bin", fileBytes(64)), 32));

    expect(error.code).toBe("invalidRequest");
    expect(error.hint).toContain("BLOB file limit");
  });

  it("givenReleasedResult_whenStagedBytesSubmitted_thenRefusedToLoadAgain", async () => {
    const { connection, sessionId } = await opened();
    const table = await probe(connection, sessionId);
    const staged = resultOf<StagedBytes>(
      await load(connection, table.statement.handle, scratchFile("in.bin", fileBytes(8))),
    );
    const fresh = await probe(connection, sessionId);
    const edits: RowEdit[] = [
      { kind: "update", row: 0, values: [{ column: PAYLOAD, value: { kind: "bytes", ...staged } }] },
    ];

    const error = errorOf(
      await connection.handle({ id: 7, type: "edits.preview", handle: fresh.statement.handle, edits }),
    );

    expect(error.hint).toBe("Load the file again.");
  });

  it("givenConsoleResultWithoutTable_whenClippedCellBytes_thenRefusedWithHint", async () => {
    const { connection, sessionId } = await opened();
    const executed = resultOf<ExecutedStatement>(
      await connection.handle({
        id: 8,
        type: "statement.execute",
        ...PAGING,
        sessionId,
        sql: "SELECT randomblob(64) AS blob",
      }),
    );
    const { handle } = executed;

    const error = errorOf(
      await connection.handle({ id: 9, type: "result.cellBytes", handle, row: 0, column: 0, maxBytes: LIMIT }),
    );
    const small = resultOf<CellBytes>(
      await connection.handle({
        id: 10,
        type: "result.cellBytes",
        handle: (await probe(connection, sessionId)).statement.handle,
        row: 0,
        column: PAYLOAD,
        maxBytes: LIMIT,
      }),
    );

    expect(error.hint).toContain("Open the table");
    expect(small).toEqual({ kind: "bytes", preview: "deadbeef", length: 4 });
  });
});
