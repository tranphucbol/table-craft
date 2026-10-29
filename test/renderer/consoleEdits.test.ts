import { describe, expect, it, vi } from "vitest";
import type {
  ClassifiedStatement,
  ColumnMeta,
  ExecutedStatement,
  OpenedSession,
  ResultEditable,
  TransactionMode,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { EMPTY_BUFFER, pendingCount } from "@table-craft/desktop/renderer/model/editBuffer.js";
import { selectCell } from "@table-craft/desktop/renderer/model/gridSelection.js";
import { editsOf, isConsoleEditable, pendingResults } from "@table-craft/desktop/renderer/state/consoleEdits.js";
import {
  activeResultOf,
  createConsolesStore,
  type PendingEditsAnswer,
  type PendingEditsRequest,
} from "@table-craft/desktop/renderer/state/consoles.js";

const SESSION_ID = "s1";
const ID = "c1";

function meta(name: string, position: number): ColumnMeta {
  return { name, position, type: "int4", nullable: false, default: null, comment: null, autoIncrement: false };
}

/** One session; a SELECT reads two rows (id, label), and `JOIN` or `total` in it tells `result.editable` what to say. */
function fakeEngine(options: { reject?: boolean } = {}) {
  const executed: string[] = [];
  const submitted: Record<string, unknown>[] = [];
  let mode: TransactionMode = "auto";
  let open = false;
  let handles = 0;
  const sqlOf = new Map<string, string>();
  const call = vi.fn((type: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "session.open": {
        const opened: OpenedSession = {
          sessionId: SESSION_ID,
          pluginName: "fake",
          capabilities: ["sql", "transactions"],
          serverVersion: "1",
          serverBrand: null,
          namespace: ["shop"],
          serverTimeout: null,
          cancelReach: null,
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
        const sql = String(params.sql);
        executed.push(sql);
        const handle = `h${String(++handles)}`;
        sqlOf.set(handle, sql);
        const result: ExecutedStatement = {
          handle,
          columns: [
            { name: "id", type: "int4" },
            { name: "label", type: "text" },
          ],
          typeClasses: ["integer", "text"],
          rowCount: 2,
          complete: true,
          cursorOpen: false,
          rowsAffected: null,
          firstWindow: {
            offset: 0,
            rows: [
              [1, "first"],
              [2, "second"],
            ],
          },
          transactionOpen: open,
        };
        return Promise.resolve(result);
      }
      case "result.editable": {
        const sql = sqlOf.get(String(params.handle)) ?? "";
        const columns = [meta("id", 1), meta("label", 2)];
        const answer: ResultEditable = sql.includes("JOIN")
          ? { editable: { readOnly: "the result joins two or more tables" }, columns, readOnlyColumns: [true, true] }
          : { editable: { identity: ["id"] }, columns, readOnlyColumns: [false, sql.includes("total")] };
        return Promise.resolve(answer);
      }
      case "edits.preview":
        return Promise.resolve(["UPDATE t SET label = 'x' WHERE id = 1"]);
      case "edits.submit": {
        submitted.push(params);
        if (options.reject === true) {
          return Promise.reject(
            new EngineRequestError({
              code: "editRejected",
              message: "Statement 1 changed 0 rows.",
              hint: "Re-run the query.",
            }),
          );
        }
        if (mode === "manual") open = true;
        return Promise.resolve({
          statements: ["UPDATE t SET label = 'x' WHERE id = 1"],
          rowsAffected: 1,
          transactionOpen: open,
        });
      }
      case "transaction.setMode":
        mode = params.mode as TransactionMode;
        return Promise.resolve({ mode, transactionOpen: open, namespace: ["shop"] });
      case "namespace.switchStatement":
        return Promise.resolve({ sql: "USE archive", transactional: false });
      default:
        return Promise.resolve(null);
    }
  });
  return { client: { call } as unknown as EngineClient, call, executed, submitted };
}

async function ran(sql: string, options: { reject?: boolean; answer?: PendingEditsAnswer | null } = {}) {
  const engine = fakeEngine(options);
  const askPendingEdits = vi.fn((_request: PendingEditsRequest) => Promise.resolve(options.answer ?? null));
  let now = 0;
  const store = createConsolesStore({
    connect: () => Promise.resolve(engine.client),
    now: () => (now += 5),
    clock: () => 0,
    askPendingEdits,
  });
  await store.getState().open(ID, "pg", { sql });
  await store.getState().run(ID, "caret");
  const session = () => {
    const current = store.getState().consoles[ID];
    if (current === undefined) throw new Error("console c1 is gone");
    return current;
  };
  const result = () => {
    const shown = activeResultOf(session());
    if (shown === null) throw new Error("no result shown");
    return shown;
  };
  await store.getState().checkEditable(ID, result().id);
  const edit = (row: number, column: number, text: string) => {
    store.getState().select(ID, result().id, selectCell({ row, column }));
    store.getState().beginEdit(ID, result().id, { row, column }, text);
    store.getState().commitEdit(ID, result().id);
  };
  const pending = () => pendingCount(editsOf(session(), result())?.buffer ?? EMPTY_BUFFER);
  return { ...engine, store, session, result, edit, pending, askPendingEdits };
}

describe("console result edits", () => {
  it("givenSingleTableSelect_whenChecked_thenEditableAndAnEditIsPending", async () => {
    const { session, result, edit, pending } = await ran("SELECT * FROM t");

    expect(isConsoleEditable(session(), result())).toBe(true);
    edit(0, 1, "x");

    expect(pending()).toBe(1);
    expect(pendingResults(session())).toEqual([result().id]);
  });

  it("givenJoin_whenChecked_thenReadOnlyAndEditsRefused", async () => {
    const { session, result, edit, pending } = await ran("SELECT * FROM t JOIN u ON u.id = t.id");

    expect(isConsoleEditable(session(), result())).toBe(false);
    expect(editsOf(session(), result())?.editable).toEqual({ readOnly: "the result joins two or more tables" });
    edit(0, 1, "x");
    expect(pending()).toBe(0);
  });

  it("givenExpressionColumn_whenEdited_thenThatCellTakesNoEdit", async () => {
    const { edit, pending } = await ran("SELECT id, upper(label) AS total FROM t");

    edit(0, 1, "x");
    edit(0, 0, "7");

    expect(pending()).toBe(1);
  });

  it("givenPendingEdits_whenSubmitted_thenSentOnTheConsoleSessionAndTheQueryRunsAgain", async () => {
    const { store, session, result, edit, pending, submitted, executed } = await ran("SELECT * FROM t");
    edit(0, 1, "x");
    const before = result().handle;

    expect(await store.getState().submitEdits(ID, result().id)).toBe(true);

    expect(submitted).toEqual([
      {
        sessionId: SESSION_ID,
        handle: before,
        edits: [{ kind: "update", row: 0, values: [{ column: 1, value: { kind: "text", text: "x" } }] }],
      },
    ]);
    expect(executed).toEqual(["SELECT * FROM t", "SELECT * FROM t"]);
    expect(result().handle).not.toBe(before);
    expect(pending()).toBe(0);
    expect(session().output.map((entry) => entry.message)).toContain("Submitted 1 statement");
    expect(session().transactionOpen).toBe(false);
  });

  it("givenManualConsole_whenSubmitted_thenTheTransactionStaysOpen", async () => {
    const { store, session, result, edit } = await ran("SELECT * FROM t");
    await store.getState().setTransactionMode(ID, "manual");
    edit(0, 1, "x");

    await store.getState().submitEdits(ID, result().id);

    expect(session().transactionOpen).toBe(true);
    expect(session().output.map((entry) => entry.message)).toContain(
      "Submitted 1 statement; they stay in the open transaction",
    );
  });

  it("givenRowChangedElsewhere_whenSubmitted_thenEditsStayWithTheReason", async () => {
    const { store, session, result, edit, pending, executed } = await ran("SELECT * FROM t", { reject: true });
    edit(0, 1, "x");

    expect(await store.getState().submitEdits(ID, result().id)).toBe(false);

    expect(pending()).toBe(1);
    expect(editsOf(session(), result())?.error?.code).toBe("editRejected");
    expect(executed).toEqual(["SELECT * FROM t"]);
    expect(session().status).toBe("ready");
  });

  it("givenPendingEdits_whenRunCancelledAtTheQuestion_thenNothingRuns", async () => {
    const { store, edit, pending, executed, askPendingEdits } = await ran("SELECT * FROM t", { answer: null });
    edit(0, 1, "x");

    await store.getState().run(ID, "caret");

    expect(askPendingEdits).toHaveBeenCalledWith({ changes: 1, verb: "run" });
    expect(executed).toEqual(["SELECT * FROM t"]);
    expect(pending()).toBe(1);
  });

  it("givenPendingEdits_whenSwitchCancelledAtTheQuestion_thenNothingRuns", async () => {
    const { store, edit, pending, executed, askPendingEdits } = await ran("SELECT * FROM t", { answer: null });
    edit(0, 1, "x");

    await store.getState().switchNamespace(ID, ["archive"]);

    expect(askPendingEdits).toHaveBeenCalledWith({ changes: 1, verb: "switch namespace" });
    expect(executed).toEqual(["SELECT * FROM t"]);
    expect(pending()).toBe(1);
  });

  it("givenPendingEdits_whenSwitchDiscarded_thenSwitchesAndKeepsTheResult", async () => {
    const { store, session, edit, executed } = await ran("SELECT * FROM t", { answer: "discard" });
    edit(0, 1, "x");

    await store.getState().switchNamespace(ID, ["archive"]);

    expect(executed).toEqual(["SELECT * FROM t", "USE archive"]);
    expect(pendingResults(session())).toEqual([]);
    expect(session().results[0]?.title).toBe("Result 1");
  });

  it("givenPendingEdits_whenRunAndDiscarded_thenTheRunReplacesTheResult", async () => {
    const { store, session, edit, executed } = await ran("SELECT * FROM t", { answer: "discard" });
    edit(0, 1, "x");

    await store.getState().run(ID, "caret");

    expect(executed).toEqual(["SELECT * FROM t", "SELECT * FROM t"]);
    expect(pendingResults(session())).toEqual([]);
  });

  it("givenPendingEdits_whenSortedAndCancelled_thenTheOrderStays", async () => {
    const { store, result, edit, call } = await ran("SELECT * FROM t", { answer: null });
    edit(0, 1, "x");

    await store.getState().sort(ID, result().id, [{ column: 0, direction: "desc" }]);

    expect(call.mock.calls.some(([type]) => type === "result.sort")).toBe(false);
    expect(result().sort).toEqual([]);
  });
});
