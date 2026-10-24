import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginLoadResult } from "@table-craft/core";
import sqlite from "@table-craft/plugin-sqlite";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS, type EngineEvent } from "@table-craft/desktop/engine/protocol.js";
import { connectionTarget, messageFields } from "@table-craft/desktop/engine/requestLog.js";
import { createLogger, type LogRecord } from "@table-craft/desktop/log/record.js";
import { SQLITE_MANIFEST } from "../support/manifests.js";

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const LOADED_SQLITE: PluginLoadResult = {
  status: "loaded",
  directory: "plugins/sqlite",
  manifest: SQLITE_MANIFEST,
  plugin: sqlite,
};
const SECRET_TEXT = "SELECT 'a row value nobody may log' AS v";

async function loggedSession(emit: (event: EngineEvent) => void = () => undefined) {
  const records: LogRecord[] = [];
  const connection = createEngine(
    {
      datasource: {
        id: "scratch",
        pluginId: "sqlite",
        config: { path: ":memory:" },
        readOnly: false,
        keepAliveSeconds: 0,
      },
      plugins: [LOADED_SQLITE],
      log: createLogger({ process: "engine", scope: "engine", sink: (record) => records.push(record) }),
    },
    () => 0,
  ).connect(emit);
  const opened = (await connection.handle({ id: 1, type: "session.open" })) as { result: { sessionId: string } };
  return { connection, records, sessionId: opened.result.sessionId };
}

describe("engine request log", () => {
  it("givenServerMessages_whenLogged_thenCountAndCodesWithoutText", () => {
    const fields = messageFields([
      { level: "warning", code: "1292", text: "Truncated incorrect INTEGER value: 'secret'" },
      { level: "warning", code: "1292", text: "Truncated incorrect INTEGER value: 'other'" },
      { level: "info", code: null, text: "1 more server message is not shown." },
    ]);

    expect(fields).toEqual({ messageCount: 3, messageCodes: ["1292"] });
    expect(messageFields([])).toEqual({});
  });

  it("givenStatement_whenExecuted_thenLoggedWithoutText", async () => {
    const { connection, records, sessionId } = await loggedSession();

    await connection.handle({ id: 7, type: "statement.execute", sessionId, sql: SECRET_TEXT, ...PAGING });

    const finished = records.find((record) => record.msg === "statement finished");
    expect(finished).toMatchObject({
      level: "info",
      scope: "query",
      requestId: 7,
      kind: "read",
      rowCount: 1,
      elapsedMs: 0,
    });
    expect(records.find((record) => record.msg === "connected")).toMatchObject({
      scope: "connection",
      path: ":memory:",
    });
    expect(JSON.stringify(records)).not.toContain("row value");
    expect(records.filter((record) => record.level === "debug").map((record) => record.type)).toEqual([
      "session.open",
      "statement.execute",
    ]);
  });

  it("givenFailedRequest_whenHandled_thenWarnWithRequestIdAndCause", async () => {
    const { connection, records, sessionId } = await loggedSession();

    await connection.handle({ id: 9, type: "statement.execute", sessionId, sql: "SELEC nonsense", ...PAGING });

    const failed = records.find((record) => record.msg === "statement failed");
    expect(failed).toMatchObject({ level: "warn", requestId: 9, code: "statementFailed" });
    expect(failed?.err?.cause?.message).toContain("syntax error");
    expect(JSON.stringify(failed)).not.toContain('nonsense"');
  });

  it("givenObjectChange_whenRefused_thenLoggedWithKindAndNameOnly", async () => {
    const { connection, records } = await loggedSession();
    const change = {
      kind: "drop",
      path: ["main"],
      object: { kind: "table", name: "orders" },
      cascade: false,
    } as const;

    await connection.handle({ id: 11, type: "objects.apply", change, statements: [SECRET_TEXT] });

    const failed = records.find((record) => record.msg === "object change failed");
    expect(failed).toMatchObject({
      level: "warn",
      scope: "objects",
      requestId: 11,
      change: "drop",
      objectKind: "table",
      object: "orders",
    });
    expect(JSON.stringify(records)).not.toContain("row value");
  });

  it("givenExport_whenItEnds_thenStartAndFinishLoggedWithoutPathOrRows", async () => {
    const folder = await mkdtemp(join(tmpdir(), "table-craft-export-log-"));
    let ended = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const { connection, records, sessionId } = await loggedSession((event) => {
      if (event.type === "export.done") ended();
    });
    try {
      const executed = (await connection.handle({
        id: 2,
        type: "statement.execute",
        sessionId,
        sql: SECRET_TEXT,
        ...PAGING,
      })) as { result: { handle: string } };
      await connection.handle({
        id: 3,
        type: "export.start",
        source: { kind: "result", handle: executed.result.handle, columns: [0] },
        format: "csv",
        path: join(folder, "secret-name.csv"),
        stallSeconds: 120,
      });
      await done;

      expect(records.find((record) => record.msg === "export started")).toMatchObject({
        scope: "export",
        requestId: 3,
        format: "csv",
        origin: "memory",
      });
      expect(records.find((record) => record.msg === "export finished")).toMatchObject({
        level: "info",
        scope: "export",
        rows: 1,
      });
      expect(JSON.stringify(records)).not.toContain("row value");
      expect(JSON.stringify(records)).not.toContain("secret-name");
    } finally {
      await connection.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("givenManifestFields_whenTarget_thenSecretsAndUserDropped", () => {
    const target = connectionTarget(
      [
        { key: "host", label: "Host", kind: "text" },
        { key: "user", label: "User", kind: "text" },
        { key: "password", label: "Password", kind: "password", secret: true },
        { key: "token", label: "Token", kind: "text", secret: true },
      ],
      { host: "db", user: "admin", password: "pw", token: "t" },
    );

    expect(target).toEqual({ host: "db" });
  });
});
