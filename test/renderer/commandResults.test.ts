import { describe, expect, it, vi } from "vitest";
import type {
  ClassifiedStatement,
  ColumnMeta,
  ExecutedStatement,
  KeySource,
  OpenedSession,
  ResultEditable,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { EMPTY_BUFFER, pendingCount } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { editsOf, isConsoleEditable } from "@table-craft/desktop/renderer/state/consoleEdits.js";
import { activeResultOf, createConsolesStore } from "@table-craft/desktop/renderer/state/consoles.js";

const SESSION_ID = "s1";
const ID = "c1";
const PROFILE: KeySource = { database: 0, key: { text: "user:42", hex: null }, type: "hash", whole: true };

function meta(name: string, position: number): ColumnMeta {
  return { name, position, type: "string", nullable: true, default: null, comment: null, autoIncrement: false };
}

function executed(handle: string, columns: string[], rows: unknown[][]): ExecutedStatement {
  return {
    handle,
    columns: columns.map((name) => ({ name, type: "string" })),
    typeClasses: columns.map(() => "text"),
    rowCount: rows.length,
    complete: true,
    cursorOpen: false,
    rowsAffected: null,
    firstWindow: { offset: 0, rows: rows as ExecutedStatement["firstWindow"]["rows"] },
    transactionOpen: false,
  };
}

/** A Redis-like session: GET reads a value, INCR answers a number, HGETALL reads `user:42` whole. */
function fakeEngine(options: { conflict?: boolean } = {}) {
  const ran: string[] = [];
  const applied: Record<string, unknown>[] = [];
  let handles = 0;
  const commandOf = new Map<string, string>();
  const call = vi.fn((type: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "session.open": {
        const opened: OpenedSession = {
          sessionId: SESSION_ID,
          pluginName: "fake",
          capabilities: ["commands", "keyValue"],
          serverVersion: "7.4",
          serverBrand: null,
          namespace: ["0"],
          serverTimeout: null,
        };
        return Promise.resolve(opened);
      }
      case "script.split": {
        const sql = String(params.text).trim();
        const statement: ClassifiedStatement = {
          from: 0,
          to: sql.length,
          sql,
          kind: "read",
          destructive: null,
          parameters: [],
        };
        return Promise.resolve(sql === "" ? [] : [statement]);
      }
      case "statement.execute": {
        const command = String(params.sql);
        ran.push(command);
        const handle = `h${String(++handles)}`;
        commandOf.set(handle, command);
        if (command.startsWith("GET"))
          return Promise.resolve({
            ...executed(handle, ["value"], [['{"a":1}']]),
            reply: { value: '{"a":1}', text: '"{\\"a\\":1}"', read: true },
            source: { ...PROFILE, type: "string" },
          });
        if (command.startsWith("INCR"))
          return Promise.resolve({ ...executed(handle, ["value"], [[7]]), reply: { value: 7, text: "(integer) 7" } });
        return Promise.resolve({
          ...executed(handle, ["field", "value"], [["name", "Ann"]]),
          source: PROFILE,
        });
      }
      case "result.editable": {
        const columns = [meta("field", 1), meta("value", 2)];
        const answer: ResultEditable = commandOf.get(String(params.handle))?.startsWith("HGETALL")
          ? { editable: { identity: [] }, columns, readOnlyColumns: [false, false], key: PROFILE }
          : { editable: { readOnly: "the result is not one whole key" }, columns, readOnlyColumns: [true, true] };
        return Promise.resolve(answer);
      }
      case "keyspace.preview":
        return Promise.resolve(["MULTI", 'HSET user:42 name "Bo"', "EXEC"]);
      case "keyspace.apply":
        applied.push(params);
        if (options.conflict === true)
          return Promise.reject(
            new EngineRequestError({ code: "conflict", message: "user:42 changed since it was read.", hint: "" }),
          );
        return Promise.resolve({ commands: ["MULTI", 'HSET user:42 name "Bo"', "EXEC"] });
      default:
        return Promise.resolve(null);
    }
  });
  return { client: { call } as unknown as EngineClient, call, ran, applied };
}

async function ran(command: string, options: { conflict?: boolean } = {}) {
  const engine = fakeEngine(options);
  let now = 0;
  const store = createConsolesStore({
    connect: () => Promise.resolve(engine.client),
    now: () => (now += 5),
    clock: () => 0,
    askPendingEdits: () => Promise.resolve(null),
  });
  await store.getState().open(ID, "redis", { sql: command });
  await store.getState().run(ID, "caret");
  const session = () => {
    const current = store.getState().consoles[ID];
    if (current === undefined) throw new Error("console c1 is gone");
    return current;
  };
  const result = () => activeResultOf(session());
  return { ...engine, store, session, result };
}

describe("command results", () => {
  it("givenGet_whenRun_thenOneRowValueTabAndOutputLine", async () => {
    const { session, result } = await ran("GET user:42");

    expect(result()?.columns.map((column) => column.name)).toEqual(["value"]);
    expect(result()?.source?.type).toBe("string");
    const line = session().output.at(-1);
    expect(line?.message).toMatch(/^→ /);
    expect(line?.key?.key.text).toBe("user:42");
  });

  it("givenIncr_whenShowAsResult_thenOneRowTab", async () => {
    const { store, session, result } = await ran("INCR hits");
    expect(result()).toBeNull();
    const line = session().output.at(-1);
    if (line?.result === undefined) throw new Error("no Show as Result link");

    store.getState().showReply(ID, line.id);
    store.getState().showReply(ID, line.id);

    expect(session().results).toHaveLength(1);
    expect(result()?.handle).toBe("h1");
  });

  it("givenHgetallResult_whenEditValueAndSubmit_thenHsetApplied", async () => {
    const { store, session, result, applied, ran: commands } = await ran("HGETALL user:42");
    const shown = result();
    if (shown === null) throw new Error("no result shown");
    await store.getState().checkEditable(ID, shown.id);
    expect(isConsoleEditable(session(), shown)).toBe(true);
    store.getState().select(ID, shown.id, selectCell({ row: 0, column: 1 }));
    store.getState().beginEdit(ID, shown.id, { row: 0, column: 1 }, "Bo");
    store.getState().commitEdit(ID, shown.id);

    expect(await store.getState().submitEdits(ID, shown.id)).toBe(true);

    expect(applied).toEqual([
      {
        database: 0,
        key: PROFILE.key,
        changes: [
          {
            kind: "setField",
            field: { text: "name", hex: null },
            value: { text: "Bo", hex: null },
            original: { text: "Ann", hex: null },
          },
        ],
        options: { type: "hash", guard: true },
      },
    ]);
    expect(commands).toEqual(["HGETALL user:42", "HGETALL user:42"]);
    expect(session().output.map((entry) => entry.message)).toContain("Submitted 3 commands as one MULTI");
  });

  it("givenChangedHashSinceRead_whenSubmitFromConsole_thenConflict", async () => {
    const { store, session, result } = await ran("HGETALL user:42", { conflict: true });
    const shown = result();
    if (shown === null) throw new Error("no result shown");
    await store.getState().checkEditable(ID, shown.id);
    store.getState().beginEdit(ID, shown.id, { row: 0, column: 1 }, "Bo");
    store.getState().commitEdit(ID, shown.id);

    expect(await store.getState().submitEdits(ID, shown.id)).toBe(false);

    const edits = editsOf(session(), shown);
    expect(edits?.error?.code).toBe("conflict");
    expect(edits?.error?.hint).toContain("Open Key");
    expect(pendingCount(edits?.buffer ?? EMPTY_BUFFER)).toBe(1);
  });
});
