import { describe, expect, it, vi } from "vitest";
import type {
  ExecutedStatement,
  KeyDetails,
  KeyName,
  OpenedKey,
  OpenedSession,
  Row,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { addRow, deleteRows, EMPTY_BUFFER, setCell } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { keyChangesOf, recreateChanges, stringChanges } from "@table-craft/desktop/renderer/model/keyChanges.js";
import { parseExpiry } from "@table-craft/desktop/renderer/model/keyExpiry.js";
import { KEY_DELETES_ROW_KEY, serviceRows } from "@table-craft/desktop/renderer/model/servicesTree.js";
import {
  createKeyDeletesStore,
  KEY_DELETE_BATCH,
  keyDeleteText,
  type KeyDeleteTask,
} from "@table-craft/desktop/renderer/state/keyDeletes.js";
import { createKeyTabsStore, pendingKeyCount } from "@table-craft/desktop/renderer/state/keyTabs.js";

const HASH_COLUMNS = ["field", "value", "ttl"];
const HASH_ROWS: Row[] = [
  ["name", "Ann", null],
  ["email", "ann@example.com", null],
];
const held = (rows: readonly Row[]) => (row: number) => rows[row];
const text = (value: string) => ({ text: value, hex: null });

describe("key changes", () => {
  it("givenHashEdits_whenChanges_thenDeletesUpdatesThenInserts", () => {
    let buffer = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 1, { kind: "text", text: "Bo" });
    buffer = deleteRows(buffer, [{ kind: "held", row: 1 }]);
    buffer = addRow(buffer, HASH_COLUMNS.length);
    buffer = setCell(buffer, { kind: "inserted", id: 1 }, 0, { kind: "text", text: "city" });
    buffer = setCell(buffer, { kind: "inserted", id: 1 }, 1, { kind: "text", text: "Hue" });
    expect(keyChangesOf("hash", HASH_COLUMNS, buffer, held(HASH_ROWS))).toEqual({
      changes: [
        { kind: "deleteField", field: text("email"), original: text("ann@example.com") },
        { kind: "setField", field: text("name"), value: text("Bo"), original: text("Ann") },
        { kind: "setField", field: text("city"), value: text("Hue"), original: null },
      ],
    });
  });

  it("givenRenamedHashField_whenChanges_thenDeleteAndSet", () => {
    const buffer = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 0, { kind: "text", text: "full_name" });
    expect(keyChangesOf("hash", HASH_COLUMNS, buffer, held(HASH_ROWS))).toEqual({
      changes: [
        { kind: "deleteField", field: text("name"), original: text("Ann") },
        { kind: "setField", field: text("full_name"), value: text("Ann"), original: null },
      ],
    });
  });

  it("givenListDelete_whenChanges_thenIndexWithOriginal", () => {
    const rows: Row[] = [
      [0, "a"],
      [1, "b"],
    ];
    const buffer = deleteRows(EMPTY_BUFFER, [{ kind: "held", row: 1 }]);
    expect(keyChangesOf("list", ["#", "value"], buffer, held(rows))).toEqual({
      changes: [{ kind: "deleteIndex", index: 1, original: text("b") }],
    });
  });

  it("givenZsetScoreNotANumber_whenChanges_thenProblem", () => {
    const rows: Row[] = [[0, "ann", 120]];
    const buffer = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 2, { kind: "text", text: "lots" });
    expect(keyChangesOf("zset", ["#", "member", "score"], buffer, held(rows))).toEqual({
      problem: "Score lots is not a number.",
    });
  });

  it("givenStreamEntryEdited_whenChanges_thenProblem", () => {
    const rows: Row[] = [["1-0", "login"]];
    const buffer = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 1, { kind: "text", text: "logout" });
    expect(keyChangesOf("stream", ["id", "event"], buffer, held(rows))).toMatchObject({
      problem: expect.stringContaining("Stream entries cannot change") as unknown,
    });
  });

  it("givenPartlyReadBytes_whenChanged_thenProblem", () => {
    const rows: Row[] = [["blob", { kind: "bytes", preview: "ff", length: 4 }, null]];
    const buffer = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 1, { kind: "text", text: "x" });
    expect(keyChangesOf("hash", HASH_COLUMNS, buffer, held(rows))).toEqual({
      problem: "A value read only in part cannot be changed; reload the key.",
    });
  });

  it("givenMissingKey_whenRecreate_thenEveryRowInserted", () => {
    expect(recreateChanges("hash", HASH_COLUMNS, HASH_ROWS, null)).toEqual({
      changes: [
        { kind: "setField", field: text("name"), value: text("Ann"), original: null },
        { kind: "setField", field: text("email"), value: text("ann@example.com"), original: null },
      ],
    });
    expect(recreateChanges("string", [], [], "hello")).toEqual({
      changes: [{ kind: "setString", value: text("hello"), original: null }],
    });
  });

  it("givenStringEdit_whenChanges_thenGuardedByTheReadValue", () => {
    expect(stringChanges(text("new"), "old")).toEqual({
      changes: [{ kind: "setString", value: text("new"), original: text("old") }],
    });
  });

  it("givenGetResultRowEdited_whenChanges_thenSetStringGuardedByTheRow", () => {
    const buffer = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 0, { kind: "text", text: "new" });
    expect(keyChangesOf("string", ["value"], buffer, held([["old"]]))).toEqual({
      changes: [{ kind: "setString", value: text("new"), original: text("old") }],
    });
  });

  it("givenZrangeWithScoresRowEdited_whenChanges_thenSetScore", () => {
    const buffer = setCell(EMPTY_BUFFER, { kind: "held", row: 0 }, 1, { kind: "text", text: "150" });
    expect(keyChangesOf("zset", ["member", "score"], buffer, held([["ann", 120]]))).toEqual({
      changes: [{ kind: "setScore", member: text("ann"), score: 150, original: 120 }],
    });
  });
});

describe("key expiry", () => {
  const NOW = Date.parse("2026-10-25T00:00:00Z");

  it.each([
    ["", { expiry: null }],
    ["3600", { expiry: { inMs: 3_600_000 } }],
    ["2026-12-31T23:00:00Z", { expiry: { at: "2026-12-31T23:00:00.000Z" } }],
    ["0", { problem: "A TTL takes at least 1 second." }],
    ["2026-01-01T00:00:00Z", { problem: "2026-01-01T00:00:00Z has passed; pick a moment ahead." }],
  ])("givenTyped_%s_whenParsed_thenExpiryOrProblem", (typed, expected) => {
    expect(parseExpiry(typed, NOW)).toEqual(expected);
  });

  it("givenGarbage_whenParsed_thenHint", () => {
    expect(parseExpiry("soon", NOW)).toMatchObject({ problem: expect.stringContaining("Type seconds") as unknown });
  });
});

describe("key deletions", () => {
  const keys = (count: number): KeyName[] => Array.from({ length: count }, (_, index) => text(`page:${String(index)}`));

  it("givenFolderKeys_whenDeleted_thenBatchesAndProgress", async () => {
    const call = vi.fn((_type: string, params: { keys: readonly KeyName[] }) => Promise.resolve(params.keys.length));
    const removed = vi.fn();
    const store = createKeyDeletesStore({
      connect: () => Promise.resolve({ call } as unknown as EngineClient),
      removed,
    });
    const task = await store.getState().start("cache", 0, "page:", keys(KEY_DELETE_BATCH + 1));
    expect(task).toMatchObject({ state: "completed", total: 501, deleted: 501 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(removed).toHaveBeenCalledTimes(2);
    expect(keyDeleteText(task)).toBe("501 of 501");
  });

  it("givenCancel_whenBetweenBatches_thenStopsAndKeepsCount", async () => {
    const store = createKeyDeletesStore({
      connect: () =>
        Promise.resolve({
          call: (_type: string, params: { keys: readonly KeyName[] }) => {
            store.getState().cancel("key-delete-0");
            return Promise.resolve(params.keys.length);
          },
        } as unknown as EngineClient),
    });
    const task = await store.getState().start("cache", 0, "page:", keys(KEY_DELETE_BATCH * 3));
    expect(task).toMatchObject({ state: "cancelled", deleted: KEY_DELETE_BATCH });
    store.getState().dismiss(task.taskId);
    expect(store.getState().tasks).toEqual([]);
  });

  it("givenTasks_whenServiceRows_thenKeyDeletionsNewestFirst", () => {
    const task = (taskId: string): KeyDeleteTask => ({
      taskId,
      datasourceId: "cache",
      database: 0,
      prefix: "page:",
      state: "completed",
      total: 1,
      deleted: 1,
      error: null,
    });
    const rows = serviceRows([], new Set(), [], [], [], [task("a"), task("b")]);
    expect(rows.map((row) => row.key)).toEqual([KEY_DELETES_ROW_KEY, "keyDelete:b", "keyDelete:a"]);
    expect(serviceRows([], new Set([KEY_DELETES_ROW_KEY]), [], [], [], [task("a")])).toHaveLength(1);
  });
});

describe("key tab edits", () => {
  const KEY = text("user:42:profile");
  const DETAILS: KeyDetails = {
    key: KEY,
    type: "hash",
    typeName: "hash",
    ttlMs: null,
    length: 2,
    memoryBytes: null,
    encoding: null,
    idleSeconds: null,
  };

  function editEngine(apply: () => Promise<unknown>) {
    const call = vi.fn((type: string): Promise<unknown> => {
      if (type === "session.open") {
        const opened: OpenedSession = {
          sessionId: "s1",
          pluginName: "Redis",
          capabilities: ["commands", "keyValue"],
          serverVersion: "7.4.1",
          serverBrand: null,
          namespace: null,
        };
        return Promise.resolve(opened);
      }
      if (type === "keyspace.open") {
        const statement: ExecutedStatement = {
          handle: "h1",
          columns: HASH_COLUMNS.slice(0, 2).map((name) => ({ name, type: "string" })),
          typeClasses: ["text", "text"],
          rowCount: 2,
          complete: true,
          cursorOpen: false,
          rowsAffected: null,
          firstWindow: { offset: 0, rows: HASH_ROWS.map((row) => row.slice(0, 2)) },
          transactionOpen: false,
        };
        const opened: OpenedKey = { details: DETAILS, statement, value: null, readOnly: null };
        return Promise.resolve(opened);
      }
      if (type === "keyspace.apply") return apply();
      return Promise.resolve(null);
    });
    return { client: { call } as unknown as EngineClient, call };
  }

  async function editedTab(apply: () => Promise<unknown>) {
    const engine = editEngine(apply);
    const store = createKeyTabsStore({ connect: () => Promise.resolve(engine.client) });
    await store.getState().open("key-0", { datasourceId: "cache", database: 0, key: KEY });
    store.getState().setCells("key-0", [{ row: 0, column: 1 }], { kind: "text", text: "Bo" });
    return { store, engine };
  }

  it("givenEditedField_whenSubmitted_thenGuardedApplyAndReread", async () => {
    const { store, engine } = await editedTab(() => Promise.resolve({ commands: ["HSET user:42:profile name Bo"] }));
    const pending = store.getState().tabs["key-0"];
    expect(pending !== undefined && pendingKeyCount(pending)).toBe(1);
    expect(await store.getState().submit("key-0")).toBe(true);
    expect(engine.call).toHaveBeenCalledWith("keyspace.apply", {
      database: 0,
      key: KEY,
      changes: [{ kind: "setField", field: text("name"), value: text("Bo"), original: text("Ann") }],
      options: { type: "hash", guard: true },
    });
    const tab = store.getState().tabs["key-0"];
    expect(tab).toMatchObject({ status: "ready", conflict: null, notice: "Submitted as one MULTI" });
    expect(tab !== undefined && pendingKeyCount(tab)).toBe(0);
    expect(engine.call.mock.calls.filter(([type]) => type === "keyspace.open")).toHaveLength(2);
  });

  it("givenConflict_whenSubmitted_thenEditsKeptAndOverwriteUnguarded", async () => {
    let answers = 0;
    const { store, engine } = await editedTab(() =>
      answers++ === 0
        ? Promise.reject(
            new EngineRequestError({
              code: "conflict",
              message: 'user:42:profile changed since it was read: field "name" is now "Cy".',
              hint: "",
            }),
          )
        : Promise.resolve({ commands: [] }),
    );
    expect(await store.getState().submit("key-0")).toBe(false);
    const tab = store.getState().tabs["key-0"];
    expect(tab?.conflict?.code).toBe("conflict");
    expect(tab !== undefined && pendingKeyCount(tab)).toBe(1);
    expect(await store.getState().submit("key-0", false)).toBe(true);
    expect(store.getState().tabs["key-0"]?.conflict).toBeNull();
    expect(engine.call).toHaveBeenCalledWith(
      "keyspace.apply",
      expect.objectContaining({ options: { type: "hash", guard: false } }) as unknown,
    );
  });
});
