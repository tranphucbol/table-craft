import { describe, expect, it, vi } from "vitest";
import type {
  ClassifiedStatement,
  CurrentNamespace,
  ExecutedStatement,
  OnErrorChoice,
  OpenedSession,
  ServerMessage,
  StatementParameter,
  TransactionMode,
  TransactionState,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { executedText, namespaceLabel, serviceState } from "@table-craft/desktop/renderer/model/format.js";
import {
  createConsolesStore,
  OUTPUT_TAB,
  type ConsoleSession,
  type ParametersRequest,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { createExecutionsStore } from "@table-craft/desktop/renderer/state/executions.js";
import { createHistoryClient } from "@table-craft/desktop/renderer/state/history.js";
import type { HistoryEntry } from "@table-craft/desktop/preload/bridge.js";

const SESSION_ID = "s1";
const ANSWER_AFTER_MS = 10_000;

const LEADING_COMMENTS = /^(?:\s|--[^\n]*(?:\n|$))*/;

/**
 * Splits on `;`, starts a statement after leading `--` comments as the real splitter does, and
 * classifies by the first word, enough to drive the store the way a plugin would.
 */
function split(text: string): ClassifiedStatement[] {
  const statements: ClassifiedStatement[] = [];
  let start = 0;
  for (const piece of text.split(";")) {
    const lead = LEADING_COMMENTS.exec(piece)?.[0].length ?? 0;
    const sql = piece.slice(lead).trim();
    if (sql !== "") {
      const from = start + lead;
      const verb = sql.split(/\s+/)[0]?.toUpperCase() ?? "";
      const kind =
        verb === "SELECT"
          ? "read"
          : verb === "CREATE" || verb === "DROP"
            ? "ddl"
            : verb === "BEGIN" || verb === "COMMIT" || verb === "ROLLBACK"
              ? "transaction"
              : "write";
      const destructive =
        verb === "DROP" ? "DROP TABLE" : verb === "DELETE" && !/\bWHERE\b/i.test(sql) ? "DELETE without WHERE" : null;
      statements.push({ from, to: from + sql.length, sql, kind, destructive, parameters: fakeParameters(sql) });
    }
    start += piece.length + 1;
  }
  return statements;
}

const FAKE_PARAMETER = /:[A-Za-z_]\w*|\?/g;

/** `:name` and `?` anywhere, enough for the store; real detection is the plugin's. */
function fakeParameters(sql: string): StatementParameter[] {
  let positional = 0;
  return [...sql.matchAll(FAKE_PARAMETER)].map((match) => {
    const from = match.index;
    const to = from + match[0].length;
    return match[0] === "?"
      ? { name: `?${String(++positional)}`, from, to, style: "positional" as const }
      : { name: match[0], from, to, style: "named" as const };
  });
}

/** An engine with one session: `FAIL` in a statement fails it; BEGIN, COMMIT, ROLLBACK and manual mode move its transaction. */
/** What the fake server says about any statement containing `WARN`. */
const WARNINGS: readonly ServerMessage[] = [
  { level: "warning", code: "1815", text: "use_index(test.i) is inapplicable" },
  { level: "notice", code: "1003", text: "rewritten" },
];

function fakeEngine() {
  const executed: string[] = [];
  const bound: unknown[] = [];
  const released: string[] = [];
  let mode: TransactionMode = "auto";
  let open = false;
  const flaked = new Set<string>();
  let handles = 0;
  let namespace: CurrentNamespace = ["shop"];
  const state = (): TransactionState => ({ mode, transactionOpen: open, namespace });
  const call = vi.fn((type: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "session.open": {
        const opened: OpenedSession = {
          sessionId: SESSION_ID,
          pluginName: "fake",
          capabilities: ["sql", "transactions"],
          serverVersion: "1",
          serverBrand: null,
          namespace,
          serverTimeout: null,
        };
        return Promise.resolve(opened);
      }
      case "script.split":
        return Promise.resolve(split(String(params.text)));
      case "statement.execute": {
        const sql = String(params.sql);
        executed.push(sql);
        bound.push(params.parameters);
        if (sql.includes("LOST")) {
          open = false;
          return Promise.reject(
            new EngineRequestError({ code: "connectionLost", message: "The connection was lost.", hint: "Run again." }),
          );
        }
        if (sql.includes("TUNNEL")) {
          open = false;
          return Promise.reject(
            new EngineRequestError({ code: "sshTunnelLost", message: "The SSH tunnel closed.", hint: "Run again." }),
          );
        }
        if (sql.includes("FLAKY") && !flaked.has(sql)) {
          flaked.add(sql);
          return Promise.reject(
            new EngineRequestError({ code: "statementTimedOut", message: "timed out", hint: "Run it again." }),
          );
        }
        if (sql.includes("FAIL")) {
          return Promise.reject(
            new EngineRequestError({
              code: "statementFailed",
              message: "syntax error",
              hint: "Fix the SQL.",
              position: sql.indexOf("FAIL"),
            }),
          );
        }
        const verb = sql.split(/\s+/)[0]?.toUpperCase();
        const uses = verb === "USE";
        if (uses) namespace = sql.includes("ELSEWHERE") ? ["shop"] : [sql.split(/\s+/)[1] ?? ""];
        if (verb === "BEGIN") open = true;
        else if (verb === "COMMIT" || verb === "ROLLBACK") open = false;
        else if (mode === "manual") open = true;
        const reads = verb === "SELECT";
        const result: ExecutedStatement = {
          handle: `h${String(++handles)}`,
          columns: reads ? [{ name: "n", type: "int4" }] : [],
          typeClasses: reads ? ["integer"] : [],
          rowCount: reads ? 1 : 0,
          complete: true,
          cursorOpen: false,
          rowsAffected: reads ? null : 1,
          firstWindow: { offset: 0, rows: reads ? [[sql]] : [] },
          transactionOpen: open,
          ...(uses ? { namespace } : {}),
          ...(sql.includes("WARN") ? { messages: WARNINGS } : {}),
          ...(sql.includes("RECONNECT") ? { reconnected: { namespace: ["public"], namespaceLost: true } } : {}),
        };
        return Promise.resolve(result);
      }
      case "namespace.switchStatement": {
        const path = params.path as readonly string[];
        return Promise.resolve({ sql: `USE ${path.join(".")}`, transactional: path.length > 1 });
      }
      case "sql.format":
        return Promise.resolve(String(params.text).replace(/\s+(FROM|WHERE)\b/g, "\n$1"));
      case "transaction.setMode":
        mode = params.mode as TransactionMode;
        return Promise.resolve(state());
      case "transaction.commit":
      case "transaction.rollback":
        open = false;
        return Promise.resolve(state());
      case "result.release":
        released.push(String(params.handle));
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
  const client = { call } as unknown as EngineClient;
  /** Moves the session's namespace behind the console's back, as a rolled-back `SET LOCAL` does. */
  const moveNamespace = (path: CurrentNamespace) => {
    namespace = path;
  };
  return { client, call, executed, bound, released, moveNamespace };
}

function harness(
  options: {
    confirm?: boolean;
    record?: (entry: HistoryEntry) => void;
    values?: Readonly<Record<string, string | null>> | null;
    statementTimeout?: number;
    onError?: OnErrorChoice;
  } = {},
) {
  const engine = fakeEngine();
  const confirmDestructive = vi.fn((_statements: readonly ClassifiedStatement[]) =>
    Promise.resolve(options.confirm ?? true),
  );
  const askParameters = vi.fn((_request: ParametersRequest) =>
    Promise.resolve(options.values === undefined ? {} : options.values),
  );
  const onDdl = vi.fn();
  const recorded: HistoryEntry[] = [];
  const executions = createExecutionsStore();
  let now = 0;
  const store = createConsolesStore({
    connect: () => Promise.resolve(engine.client),
    now: () => (now += 5),
    clock: () => 0,
    confirmDestructive,
    askParameters,
    onDdl,
    executions: executions.getState(),
    record: options.record ?? ((entry) => recorded.push(entry)),
    statementTimeout: () => options.statementTimeout ?? 0,
    onError: () => options.onError ?? "stop",
  });
  const session = () => {
    const current = store.getState().consoles.c1;
    if (current === undefined) throw new Error("console c1 is gone");
    return current;
  };
  const messages = () => session().output.map((entry) => entry.message);
  return { ...engine, store, confirmDestructive, askParameters, onDdl, session, messages, recorded, executions };
}

async function opened(sql: string, options: Parameters<typeof harness>[0] = {}) {
  const context = harness(options);
  await context.store.getState().open("c1", "pg", { sql });
  return context;
}

describe("console runs", () => {
  it("givenSecondStatementFails_whenBatchRuns_thenThirdSkippedAndLogged", async () => {
    const { store, executed, session, messages } = await opened("SELECT 1;\nSELECT FAIL;\nSELECT 3;");

    await store.getState().run("c1", "all");

    expect(executed).toEqual(["SELECT 1", "SELECT FAIL"]);
    expect(messages()).toEqual(["1 row retrieved in 5 ms", "syntax error", "1 statement skipped after the error."]);
    expect(session().output.map((entry) => entry.tone)).toEqual(["success", "error", "warning"]);
    expect(session().results.map((result) => result.title)).toEqual(["Result 1"]);
    expect(session().activeResult).toBe(OUTPUT_TAB);
    expect(session().lastRun?.outcome).toBe("failed");
    expect(session().status).toBe("ready");
  });

  it("givenDestructiveConfirmOpen_whenStatusRead_thenWaitingForConfirmation", async () => {
    const engine = fakeEngine();
    let now = 0;
    const asked: (ConsoleSession | undefined)[] = [];
    const store = createConsolesStore({
      connect: () => Promise.resolve(engine.client),
      now: () => now,
      clock: () => 0,
      confirmDestructive: () => {
        asked.push(store.getState().consoles.c1);
        now += ANSWER_AFTER_MS;
        return Promise.resolve(true);
      },
    });
    await store.getState().open("c1", "pg", { sql: "DROP TABLE t" });

    await store.getState().run("c1", "all");

    expect(asked.map((session) => session?.status)).toEqual(["confirming"]);
    expect(asked.map((session) => (session === undefined ? null : serviceState(session)))).toEqual(["waiting"]);
    // The time spent answering is not the run's.
    expect(store.getState().consoles.c1?.lastRun).toEqual({ durationMs: 0, outcome: "succeeded" });
  });

  it("givenDestructiveStatementCancelled_whenBatchRuns_thenNothingRuns", async () => {
    const { store, executed, confirmDestructive, messages, session } = await opened(
      "SELECT 1;\nDELETE FROM orders;\nDROP TABLE t;",
      { confirm: false },
    );

    await store.getState().run("c1", "all");

    expect(executed).toEqual([]);
    expect(confirmDestructive.mock.calls[0]?.[0].map((statement) => statement.destructive)).toEqual([
      "DELETE without WHERE",
      "DROP TABLE",
    ]);
    expect(messages()).toEqual(["Cancelled; nothing ran."]);
    expect(session().lastRun?.outcome).toBe("cancelled");
  });

  it("givenDestructiveStatementConfirmed_whenBatchRuns_thenAllRun", async () => {
    const { store, executed } = await opened("DELETE FROM orders;\nSELECT 1;");

    await store.getState().run("c1", "all");

    expect(executed).toEqual(["DELETE FROM orders", "SELECT 1"]);
  });

  it("givenCaretInSecondStatement_whenRun_thenOnlyItRunsAndIsFlashed", async () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    const { store, executed, session } = await opened(sql);
    const caret = sql.indexOf("2");
    store.getState().setSelection("c1", { from: caret, to: caret });

    await store.getState().run("c1", "caret");

    expect(executed).toEqual(["SELECT 2"]);
    expect(session().flash).toMatchObject({ from: sql.indexOf("SELECT 2"), to: sql.indexOf("SELECT 2") + 8 });
  });

  it("givenSelectionInsideStatement_whenRun_thenSelectedTextRunsAtItsOffset", async () => {
    const sql = "SELECT 1 + 2 AS n;";
    const { store, executed, session } = await opened(sql);
    store.getState().setSelection("c1", { from: 0, to: "SELECT 1".length });

    await store.getState().run("c1", "caret");

    expect(executed).toEqual(["SELECT 1"]);
    expect(session().flash).toMatchObject({ from: 0, to: 8 });
  });

  it("givenSelectionFromCommentIntoStatement_whenRun_thenOnlySelectedPartRuns", async () => {
    const sql = "-- totals\nSELECT 1 + 2 AS n;";
    const { store, executed, session } = await opened(sql);
    const from = sql.indexOf("SELECT 1");
    store.getState().setSelection("c1", { from: 0, to: from + "SELECT 1".length });

    await store.getState().run("c1", "caret");

    expect(executed).toEqual(["SELECT 1"]);
    expect(session().flash).toMatchObject({ from, to: from + "SELECT 1".length });
  });

  it("givenSelectionAcrossTwoStatementsPartly_whenRun_thenSelectedPiecesRunAtTheirOffsets", async () => {
    const sql = "SELECT 1 AS a;\nSELECT 2 AS b;";
    const { store, executed, session } = await opened(sql);
    const second = sql.indexOf("SELECT 2");
    store.getState().setSelection("c1", { from: 0, to: second + "SELECT 2".length });

    await store.getState().run("c1", "caret");

    expect(executed).toEqual(["SELECT 1 AS a", "SELECT 2"]);
    expect(session().flash).toMatchObject({ from: second, to: second + "SELECT 2".length });
  });

  it("givenSelectionOfOnlyWhitespace_whenRun_thenOutputSaysNothingToRun", async () => {
    const sql = "SELECT 1;\n\n\nSELECT 2;";
    const { store, executed, messages } = await opened(sql);
    const from = sql.indexOf("\n\n");
    store.getState().setSelection("c1", { from, to: from + 2 });

    await store.getState().run("c1", "caret");

    expect(executed).toEqual([]);
    expect(messages()).toEqual(["Nothing to run"]);
  });

  it("givenEmptyConsole_whenRun_thenOutputSaysNothingToRun", async () => {
    const { store, executed, messages } = await opened("  \n;\n");
    await store.getState().run("c1", "caret");

    expect(executed).toEqual([]);
    expect(messages()).toEqual(["Nothing to run"]);
  });

  it("givenPinnedResult_whenRunAgain_thenPinnedKeptOthersReplacedAndReleased", async () => {
    const { store, session, released } = await opened("SELECT 1;\nSELECT 2;");
    await store.getState().run("c1", "all");
    const [first, second] = session().results;
    store.getState().togglePin("c1", first?.id ?? "");

    await store.getState().run("c1", "all");

    expect(session().results.map((result) => [result.title, result.pinned])).toEqual([
      ["Result 1", true],
      ["Result 2", false],
      ["Result 3", false],
    ]);
    expect(session().results[0]?.id).toBe(first?.id);
    expect(released).toEqual([second?.kind === "rows" ? second.handle : null]);
    expect(session().activeResult).toBe(session().results[2]?.id);
  });

  it("givenDdlInAutoMode_whenRun_thenCatalogRefreshed", async () => {
    const { store, onDdl } = await opened("CREATE TABLE t (id int);");

    await store.getState().run("c1", "all");

    expect(onDdl).toHaveBeenCalledWith("pg");
  });

  it("givenDdlInManualMode_whenCommitted_thenCatalogRefreshedOnlyAfterCommit", async () => {
    const { store, onDdl, session, messages } = await opened("CREATE TABLE t (id int);");
    expect(await store.getState().setTransactionMode("c1", "manual")).toBe(true);

    await store.getState().run("c1", "all");
    expect(session().transactionOpen).toBe(true);
    expect(onDdl).not.toHaveBeenCalled();

    expect(await store.getState().commit("c1")).toBe(true);
    expect(session().transactionOpen).toBe(false);
    expect(onDdl).toHaveBeenCalledWith("pg");
    expect(messages().at(-1)).toBe("Committed");
  });

  it("givenDdlInManualMode_whenRolledBack_thenCatalogNotRefreshed", async () => {
    const { store, onDdl } = await opened("CREATE TABLE t (id int);");
    await store.getState().setTransactionMode("c1", "manual");
    await store.getState().run("c1", "all");

    await store.getState().rollback("c1");

    expect(onDdl).not.toHaveBeenCalled();
  });

  it("givenAutoMode_whenExplicitBegin_thenTransactionOpenUntilCommitStatement", async () => {
    const { store, session } = await opened("BEGIN;\nINSERT INTO t VALUES (1);");
    await store.getState().run("c1", "all");
    expect(session().transactionOpen).toBe(true);

    store.getState().setSql("c1", "COMMIT;");
    await store.getState().run("c1", "all");

    expect(session().transactionOpen).toBe(false);
  });

  it("givenManualModeBeforeConnecting_whenSessionOpens_thenModeApplied", async () => {
    const { store, call, session } = harness();
    await store.getState().open("c1", "pg", { sql: "INSERT INTO t VALUES (1);", connect: false });
    await store.getState().setTransactionMode("c1", "manual");

    await store.getState().run("c1", "all");

    expect(call).toHaveBeenCalledWith("transaction.setMode", { sessionId: SESSION_ID, mode: "manual" });
    expect(session().transactionOpen).toBe(true);
  });

  it("givenOpenTransaction_whenDetached_thenOutputWarnsAndNotOpen", async () => {
    const { store, session, messages } = await opened("BEGIN;");
    await store.getState().run("c1", "all");

    store.getState().detach("pg", null);

    expect(session().transactionOpen).toBe(false);
    expect(session().status).toBe("disconnected");
    expect(messages().at(-1)).toBe("The session closed; its open transaction was rolled back.");
  });
});

describe("console connection health", () => {
  it("givenReconnectedReply_whenRun_thenOutputSaysSoAndNamespaceIsTheNewSessions", async () => {
    const { store, session, messages } = await opened("USE archive;\nSELECT RECONNECT;");

    await store.getState().run("c1", "all");

    expect(messages().slice(1)).toEqual([
      "Reconnected: the connection had been lost. The new session starts in public; the USE or search path set earlier no longer applies.",
      "1 row retrieved in 5 ms",
    ]);
    expect(session().namespace).toEqual(["public"]);
  });

  it("givenOpenTransaction_whenConnectionLost_thenTransactionClosed", async () => {
    const { store, session, messages } = await opened("BEGIN;\nSELECT LOST;");

    await store.getState().run("c1", "all");

    expect(messages().at(-1)).toBe("The connection was lost.");
    expect(session().transactionOpen).toBe(false);
  });

  it("givenOpenTransaction_whenSshTunnelLost_thenTransactionClosed", async () => {
    const { store, session, messages } = await opened("BEGIN;\nSELECT TUNNEL;");

    await store.getState().run("c1", "all");

    expect(messages().at(-1)).toBe("The SSH tunnel closed.");
    expect(session().transactionOpen).toBe(false);
  });

  it("givenStatementTimeout_whenRun_thenSentWithTheStatement", async () => {
    const { store, call } = await opened("SELECT 1;", { statementTimeout: 30 });

    await store.getState().run("c1", "all");

    expect(call).toHaveBeenCalledWith("statement.execute", expect.objectContaining({ timeoutSeconds: 30 }));
  });

  it("givenNoStatementTimeout_whenRun_thenNoneSent", async () => {
    const { store, call } = await opened("SELECT 1;");

    await store.getState().run("c1", "all");

    const params = call.mock.calls.find(([type]) => type === "statement.execute")?.[1];
    expect(params).not.toHaveProperty("timeoutSeconds");
  });
});

describe("console namespace", () => {
  it("givenSessionOpened_whenNamespaceReported_thenConsoleRecordsIt", async () => {
    const { session } = await opened("SELECT 1;");

    expect(session().namespace).toEqual(["shop"]);
  });

  it("givenUseExecuted_whenNamespaceReported_thenConsoleUpdates", async () => {
    const { store, session } = await opened("USE archive;\nSELECT 1;");

    await store.getState().run("c1", "all");

    expect(session().namespace).toEqual(["archive"]);
  });

  it("givenStatementWithoutNamespace_whenExecuted_thenKept", async () => {
    const { store, session, moveNamespace } = await opened("SELECT 1;");
    moveNamespace(["elsewhere"]);

    await store.getState().run("c1", "all");

    expect(session().namespace).toEqual(["shop"]);
  });

  it("givenFailedUse_whenExecuted_thenNamespaceUnchanged", async () => {
    const { store, session } = await opened("USE FAIL;");

    await store.getState().run("c1", "all");

    expect(session().namespace).toEqual(["shop"]);
  });

  it("givenRollbackWithNamespace_whenTransacted_thenConsoleUpdates", async () => {
    const { store, session, moveNamespace } = await opened("BEGIN;");
    await store.getState().run("c1", "all");
    moveNamespace(["reverted"]);

    await store.getState().rollback("c1");

    expect(session().namespace).toEqual(["reverted"]);
  });

  it("givenNamespace_whenDetached_thenForgotten", async () => {
    const { store, session } = await opened("USE archive;");
    await store.getState().run("c1", "all");

    store.getState().detach("pg", null);

    expect(session().namespace).toBeNull();
  });

  it("givenReconnect_whenSessionReopens_thenNamespaceIsTheNewSessions", async () => {
    const { store, session, moveNamespace } = await opened("USE archive;");
    await store.getState().run("c1", "all");
    store.getState().detach("pg", null);
    moveNamespace(["shop"]);

    store.getState().setSql("c1", "SELECT 1;");
    await store.getState().run("c1", "all");

    expect(session().namespace).toEqual(["shop"]);
  });

  it("givenSwitch_whenRun_thenStatementLoggedNamespacePatchedResultsKept", async () => {
    const { store, session, executed } = await opened("SELECT 1;");
    await store.getState().run("c1", "all");
    const flash = session().flash;

    await store.getState().switchNamespace("c1", ["archive"]);

    expect(executed).toEqual(["SELECT 1", "USE archive"]);
    expect(session().output.at(-1)).toMatchObject({ sql: "USE archive", tone: "success" });
    expect(session().namespace).toEqual(["archive"]);
    expect(session().results.map((result) => result.title)).toEqual(["Result 1"]);
    expect(session().flash).toEqual(flash);
    expect(session().status).toBe("ready");
  });

  it("givenSwitchInOpenTransaction_whenTransactional_thenOutputSaysRollbackUndoes", async () => {
    const { store, messages } = await opened("BEGIN;");
    await store.getState().run("c1", "all");

    await store.getState().switchNamespace("c1", ["shop", "archive"]);

    expect(messages().at(-1)).toBe("Switched inside the open transaction; a rollback switches back.");
  });

  it("givenSwitchLandingElsewhere_whenRun_thenWarns", async () => {
    const { store, session } = await opened("SELECT 1;");

    await store.getState().switchNamespace("c1", ["ELSEWHERE"]);

    expect(session().output.at(-1)).toMatchObject({
      message: "The session is in shop, not ELSEWHERE.",
      tone: "warning",
    });
  });

  it("givenNoSession_whenSwitched_thenOpensFirst", async () => {
    const context = harness();
    await context.store.getState().open("c1", "pg", { sql: "", connect: false });

    await context.store.getState().switchNamespace("c1", ["archive"]);

    expect(context.call.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["session.open", "namespace.switchStatement", "statement.execute"]),
    );
    expect(context.session().namespace).toEqual(["archive"]);
  });

  it("givenFailingSwitch_whenRun_thenErrorLoggedNamespaceUnchanged", async () => {
    const { store, session } = await opened("SELECT 1;");

    await store.getState().switchNamespace("c1", ["FAIL"]);

    expect(session().namespace).toEqual(["shop"]);
    expect(session().error?.message).toBe("syntax error");
    expect(session().activeResult).toBe(OUTPUT_TAB);
  });

  it("givenSchemaPath_whenLabelled_thenSchemaWithFullPathAsTitle", () => {
    expect(namespaceLabel(["table_craft", "archive"])).toEqual({ text: "archive", title: "table_craft.archive" });
  });

  it("givenNoNamespace_whenLabelled_thenHidden", () => {
    expect(namespaceLabel(null)).toBeNull();
    expect(namespaceLabel([])).toBeNull();
  });
});

describe("output lines", () => {
  const NO_ROWS = { columns: [], rowCount: 0, complete: true } as const;

  it("givenDdlWithDriversZeroAffected_whenFormatted_thenCompletedNotZeroRows", () => {
    expect(executedText({ ...NO_ROWS, rowsAffected: 0 }, 44, "ddl")).toBe("completed in 44 ms");
  });

  it("givenWrite_whenFormatted_thenRowsAffected", () => {
    expect(executedText({ ...NO_ROWS, rowsAffected: 1 }, 12, "write")).toBe("1 row affected in 12 ms");
  });

  it("givenCompleteRead_whenFormatted_thenRowsRetrieved", () => {
    expect(executedText({ columns: [{}], rowCount: 3, complete: true, rowsAffected: null }, 38, "read")).toBe(
      "3 rows retrieved in 38 ms",
    );
  });

  it("givenFirstPageOfMore_whenFormatted_thenCountWithPlus", () => {
    expect(executedText({ columns: [{}], rowCount: 500, complete: false, rowsAffected: null }, 38, "read")).toBe(
      "500+ rows retrieved in 38 ms",
    );
  });
});

describe("console history and executions", () => {
  it("givenScriptWithFailingSecondStatement_whenRun_thenFirstTwoRecordedThirdSkipped", async () => {
    const { store, recorded, executions } = await opened("SELECT 1;\nSELECT FAIL;\nSELECT 3;");

    await store.getState().run("c1", "all");

    expect(recorded).toEqual([
      {
        datasourceId: "pg",
        sql: "SELECT 1",
        startedAt: 0,
        durationMs: 5,
        outcome: "success",
        rowCount: 1,
        message: null,
        source: "console",
      },
      {
        datasourceId: "pg",
        sql: "SELECT FAIL",
        startedAt: 0,
        durationMs: 5,
        outcome: "error",
        rowCount: null,
        message: "syntax error",
        source: "console",
      },
    ]);
    expect(executions.getState().byTab.c1?.map((execution) => [execution.label, execution.outcome])).toEqual([
      ["SELECT FAIL", "error"],
      ["SELECT 1", "success"],
    ]);
  });

  it("givenStatementWithWarnings_whenRun_thenOutputLinesExecutionAndHistoryCount", async () => {
    const { store, recorded, executions, session } = await opened("SELECT 'WARN';");

    await store.getState().run("c1", "all");

    expect(session().output.map((entry) => [entry.message, entry.tone])).toEqual([
      ["1 row retrieved in 5 ms", "success"],
      ["Warning 1815: use_index(test.i) is inapplicable", "warning"],
      ["Note 1003: rewritten", "info"],
    ]);
    expect(recorded.map((entry) => [entry.outcome, entry.warnings])).toEqual([["success", 1]]);
    expect(executions.getState().byTab.c1?.[0]?.messages).toEqual(WARNINGS);
    const [tab] = session().results;
    expect(tab?.kind === "rows" ? tab.messages : undefined).toEqual(WARNINGS);
  });

  it("givenQuietStatement_whenRun_thenNoWarningsRecorded", async () => {
    const { store, recorded } = await opened("SELECT 1;");

    await store.getState().run("c1", "all");

    expect(recorded[0]).not.toHaveProperty("warnings");
  });

  it("givenWrite_whenRun_thenRowsAffectedRecorded", async () => {
    const { store, recorded } = await opened("UPDATE orders SET n = 1 WHERE id = 1;");

    await store.getState().run("c1", "all");

    expect(recorded.map((entry) => [entry.sql, entry.rowCount])).toEqual([["UPDATE orders SET n = 1 WHERE id = 1", 1]]);
  });

  it("givenDestructiveDeclined_whenRun_thenNothingRecorded", async () => {
    const { store, recorded, executions } = await opened("SELECT 1;\nDROP TABLE t;", { confirm: false });

    await store.getState().run("c1", "all");

    expect(recorded).toEqual([]);
    expect(executions.getState().byTab.c1 ?? []).toEqual([]);
  });

  it("givenEmptyConsole_whenRun_thenNothingRecorded", async () => {
    const { store, recorded } = await opened("  ");

    await store.getState().run("c1", "all");

    expect(recorded).toEqual([]);
  });

  it("givenEnvironmentDatasource_whenRun_thenNothingRecorded", async () => {
    const historyRecord = vi.fn(() => Promise.resolve({ ok: true as const, value: null }));
    const client = createHistoryClient({
      bridge: () => ({ historyRecord, historySearch: vi.fn(), historyClear: vi.fn() }),
      isEphemeral: (datasourceId) => datasourceId === "pg",
      log: vi.fn(),
    });
    const { store } = await opened("SELECT 1;", { record: client.record });

    await store.getState().run("c1", "all");

    expect(historyRecord).not.toHaveBeenCalled();
  });

  it("givenHistoryWriteFails_whenRun_thenRunSucceeds", async () => {
    const log = vi.fn();
    const client = createHistoryClient({
      bridge: () => ({
        historyRecord: vi.fn(() => Promise.reject(new Error("disk full"))),
        historySearch: vi.fn(),
        historyClear: vi.fn(),
      }),
      isEphemeral: () => false,
      log,
    });
    const { store, session, executed } = await opened("SELECT 1;\nSELECT 2;", { record: client.record });

    await store.getState().run("c1", "all");
    await Promise.resolve();

    expect(executed).toEqual(["SELECT 1", "SELECT 2"]);
    expect(session().lastRun?.outcome).toBe("succeeded");
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("givenText_whenInserted_thenOneShotUntilAcknowledged", async () => {
    const { store, session } = await opened("SELECT 1;");

    store.getState().insert("c1", "SELECT 2;");
    const insertion = session().insertion;
    store.getState().inserted("c1", insertion?.seq ?? -1);

    expect(insertion?.text).toBe("SELECT 2;");
    expect(session().insertion).toBeNull();
  });
});

describe("query parameters", () => {
  it("givenParameters_whenRun_thenPromptsAndSendsValues", async () => {
    const { store, executed, bound, askParameters, recorded } = await opened(
      "SELECT * FROM t WHERE id = :id;\nSELECT ?, ?;\nSELECT ? AND :id;",
      { values: { ":id": "7", "?1": "a", "?2": null, "?3": "c" } },
    );

    await store.getState().run("c1", "all");

    expect(askParameters.mock.calls[0]?.[0].prompt.names).toEqual([":id", "?1", "?2", "?3"]);
    expect(executed).toHaveLength(3);
    expect(bound).toEqual([{ ":id": "7" }, { "?1": "a", "?2": null }, { "?1": "c", ":id": "7" }]);
    expect(recorded.map((entry) => entry.parameters)).toEqual(bound);
    expect(store.getState().consoles.c1?.parameterValues).toEqual({ ":id": "7", "?1": "a", "?2": null, "?3": "c" });
  });

  it("givenRememberedValues_whenRunAgain_thenPromptPrefilled", async () => {
    const { store, askParameters } = await opened("SELECT :id", { values: { ":id": "7" } });

    await store.getState().run("c1", "all");
    await store.getState().run("c1", "all");

    expect(askParameters.mock.calls[1]?.[0].initial).toEqual({ ":id": "7" });
  });

  it("givenPromptCancelled_whenRun_thenNothingRuns", async () => {
    const { store, executed, messages, session, recorded } = await opened("SELECT :id", { values: null });

    await store.getState().run("c1", "all");

    expect(executed).toEqual([]);
    expect(recorded).toEqual([]);
    expect(messages()).toEqual(["Cancelled; nothing ran."]);
    expect(session().lastRun?.outcome).toBe("cancelled");
  });

  it("givenDestructiveDeclined_whenRun_thenParametersNeverAsked", async () => {
    const { store, askParameters } = await opened("DELETE FROM t WHERE id = :id; DROP TABLE t", { confirm: false });

    await store.getState().run("c1", "all");

    expect(askParameters).not.toHaveBeenCalled();
  });

  it("givenNoParameters_whenRun_thenNeitherAskedNorSent", async () => {
    const { store, askParameters, bound } = await opened("SELECT 1");

    await store.getState().run("c1", "all");

    expect(askParameters).not.toHaveBeenCalled();
    expect(bound).toEqual([undefined]);
  });

  it("givenDetectionOff_whenRun_thenRunsVerbatim", async () => {
    const settings = useSettings.getState().settings;
    useSettings.setState({ settings: { ...settings, console: { ...settings.console, parameters: false } } });
    try {
      const { store, askParameters, bound, executed } = await opened("SELECT :id");

      await store.getState().run("c1", "all");

      expect(askParameters).not.toHaveBeenCalled();
      expect(executed).toEqual(["SELECT :id"]);
      expect(bound).toEqual([undefined]);
    } finally {
      useSettings.setState({ settings });
    }
  });

  it("givenPresetValues_whenRun_thenNoPromptAndBound", async () => {
    const { store, askParameters, bound, recorded } = await opened("SELECT f(:amount, :rate);");

    await store.getState().run("c1", "all", { ":amount": "100", ":rate": null });

    expect(askParameters).not.toHaveBeenCalled();
    expect(bound).toEqual([{ ":amount": "100", ":rate": null }]);
    expect(recorded.map((entry) => entry.parameters)).toEqual(bound);
    expect(store.getState().consoles.c1?.parameterValues).toEqual({ ":amount": "100", ":rate": null });
  });

  it("givenPresetValuesWithDetectionOff_whenRun_thenBound", async () => {
    const settings = useSettings.getState().settings;
    useSettings.setState({ settings: { ...settings, console: { ...settings.console, parameters: false } } });
    try {
      const { store, askParameters, bound } = await opened("SELECT f(:amount);");

      await store.getState().run("c1", "all", { ":amount": "100" });

      expect(askParameters).not.toHaveBeenCalled();
      expect(bound).toEqual([{ ":amount": "100" }]);
    } finally {
      useSettings.setState({ settings });
    }
  });

  it("givenPresetMissingAName_whenRun_thenPromptPrefilled", async () => {
    const { store, askParameters } = await opened("SELECT :a, :b", { values: { ":a": "1", ":b": "2" } });

    await store.getState().run("c1", "all", { ":a": "1" });

    expect(askParameters.mock.calls[0]?.[0].initial).toEqual({ ":a": "1" });
  });

  it("givenResultWithParameters_whenRerun_thenPromptsAndSendsValues", async () => {
    const { store, bound, askParameters, session } = await opened("SELECT :id", { values: { ":id": "7" } });
    await store.getState().run("c1", "all");
    const resultId = session().results[0]?.id ?? "";

    await store.getState().rerun("c1", resultId);

    expect(askParameters).toHaveBeenCalledTimes(2);
    expect(bound).toEqual([{ ":id": "7" }, { ":id": "7" }]);
  });

  it("givenHistoryValues_whenInserted_thenRememberedForTheNextPrompt", async () => {
    const { store } = await opened("");

    store.getState().insert("c1", "SELECT :id", { ":id": "42" });

    expect(store.getState().consoles.c1?.parameterValues).toEqual({ ":id": "42" });
  });
});

describe("reformat", () => {
  it("givenNoSelection_whenReformatted_thenWholeConsoleReplacedCaretOnToken", async () => {
    const { store } = await opened("SELECT a FROM t WHERE b");
    store.getState().setSelection("c1", { from: 9, to: 9 });

    await store.getState().reformat("c1");

    const replacement = store.getState().consoles.c1?.replacement;
    expect(replacement).toMatchObject({ from: 0, to: 23, text: "SELECT a\nFROM t\nWHERE b" });
    expect(replacement?.selection).toEqual({ from: 9, to: 9 });
  });

  it("givenSelection_whenReformatted_thenOnlySelectionReplaced", async () => {
    const { store } = await opened("SELECT 1;\nSELECT a FROM t;");
    store.getState().setSelection("c1", { from: 10, to: 25 });

    await store.getState().reformat("c1");

    expect(store.getState().consoles.c1?.replacement).toMatchObject({
      from: 10,
      to: 25,
      before: "SELECT a FROM t",
      text: "SELECT a\nFROM t",
      selection: { from: 10, to: 25 },
    });
  });

  it("givenFormatFails_whenReformatted_thenTextKeptAndOutputSaysWhy", async () => {
    const { store, call, messages } = await opened("SELECT (");
    call.mockImplementationOnce(() =>
      Promise.reject(new EngineRequestError({ code: "formatFailed", message: "Parse error at line 1", hint: "h" })),
    );

    await store.getState().reformat("c1");

    expect(store.getState().consoles.c1?.replacement).toBeNull();
    expect(messages()).toEqual(["Could not reformat: Parse error at line 1"]);
  });

  it("givenReplacementApplied_whenAcknowledged_thenCleared", async () => {
    const { store } = await opened("SELECT a FROM t");
    await store.getState().reformat("c1");
    const seq = store.getState().consoles.c1?.replacement?.seq ?? -1;

    store.getState().replaced("c1", seq);

    expect(store.getState().consoles.c1?.replacement).toBeNull();
  });
});

describe("errors in a run", () => {
  async function questioned(context: Awaited<ReturnType<typeof opened>>) {
    await vi.waitFor(() => {
      expect(context.session().question).not.toBeNull();
    });
    return context.session();
  }

  it("givenFailingStatement_whenRun_thenMarkCoversTheTokenAtThePosition", async () => {
    const sql = "SELECT 1;\nSELECT FAIL;";
    const { store, session } = await opened(sql);

    await store.getState().run("c1", "all");

    const statementFrom = sql.indexOf("SELECT FAIL");
    expect(session().errorMarks).toEqual([
      {
        from: sql.indexOf("FAIL"),
        to: sql.indexOf("FAIL") + "FAIL".length,
        statementFrom,
        statementTo: statementFrom + "SELECT FAIL".length,
        message: "syntax error",
        hint: "Fix the SQL.",
      },
    ]);
  });

  it("givenMarkedStatement_whenRunAgain_thenOneMarkNotTwo", async () => {
    const { store, session } = await opened("SELECT FAIL;");

    await store.getState().run("c1", "all");
    await store.getState().run("c1", "all");

    expect(session().errorMarks).toHaveLength(1);
  });

  it("givenContinue_whenTwoFail_thenEveryStatementRunsAndTheSummaryCountsThem", async () => {
    const { store, executed, session, messages } = await opened("SELECT FAIL;\nSELECT 2;\nSELECT FAIL 3;\nSELECT 4;", {
      onError: "continue",
    });

    await store.getState().run("c1", "all");

    expect(executed).toEqual(["SELECT FAIL", "SELECT 2", "SELECT FAIL 3", "SELECT 4"]);
    expect(messages().at(-1)).toBe("4 run, 2 failed.");
    expect(session().errorMarks).toHaveLength(2);
    expect(session().lastRun?.outcome).toBe("failed");
    expect(session().activeResult).toBe(OUTPUT_TAB);
  });

  it("givenStop_whenFirstFails_thenTheOldBehaviour", async () => {
    const { store, executed, messages } = await opened("SELECT FAIL;\nSELECT 2;", { onError: "stop" });

    await store.getState().run("c1", "all");

    expect(executed).toEqual(["SELECT FAIL"]);
    expect(messages()).toEqual(["syntax error", "1 statement skipped after the error."]);
  });

  it("givenAsk_whenSkip_thenTheRunGoesOn", async () => {
    const context = await opened("SELECT FAIL;\nSELECT 2;\nSELECT 3;", { onError: "ask" });
    const running = context.store.getState().run("c1", "all");

    const asking = await questioned(context);
    context.store.getState().answerError("c1", "skip");
    await running;

    expect(asking.status).toBe("confirming");
    expect(serviceState(asking)).toBe("asking");
    expect(asking.question).toMatchObject({
      number: 1,
      total: 3,
      sql: "SELECT FAIL",
      error: { code: "statementFailed" },
    });
    expect(context.executed).toEqual(["SELECT FAIL", "SELECT 2", "SELECT 3"]);
    expect(context.session()).toMatchObject({ question: null, status: "ready" });
    expect(context.messages().at(-1)).toBe("3 run, 1 failed.");
  });

  it("givenAsk_whenSkipAll_thenAsksOnceForTwoFailures", async () => {
    const context = await opened("SELECT FAIL;\nSELECT FAIL 2;\nSELECT 3;", { onError: "ask" });
    const running = context.store.getState().run("c1", "all");

    await questioned(context);
    context.store.getState().answerError("c1", "skipAll");
    await running;

    expect(context.executed).toEqual(["SELECT FAIL", "SELECT FAIL 2", "SELECT 3"]);
    expect(context.messages().at(-1)).toBe("3 run, 2 failed.");
  });

  it("givenAsk_whenStop_thenTheRestIsSkipped", async () => {
    const context = await opened("SELECT FAIL;\nSELECT 2;\nSELECT 3;", { onError: "ask" });
    const running = context.store.getState().run("c1", "all");

    await questioned(context);
    context.store.getState().answerError("c1", "stop");
    await running;

    expect(context.executed).toEqual(["SELECT FAIL"]);
    expect(context.messages().at(-1)).toBe("2 statements skipped after the error.");
    expect(context.session().lastRun?.outcome).toBe("failed");
  });

  it("givenAsk_whenRetrySucceeds_thenTheRunSucceeds", async () => {
    const context = await opened("SELECT FLAKY;\nSELECT 2;", { onError: "ask" });
    const running = context.store.getState().run("c1", "all");

    await questioned(context);
    context.store.getState().answerError("c1", "retry");
    await running;

    expect(context.executed).toEqual(["SELECT FLAKY", "SELECT FLAKY", "SELECT 2"]);
    expect(context.session().lastRun?.outcome).toBe("succeeded");
  });

  it("givenAsking_whenCancelled_thenStops", async () => {
    const context = await opened("SELECT FAIL;\nSELECT 2;", { onError: "ask" });
    const running = context.store.getState().run("c1", "all");

    await questioned(context);
    await context.store.getState().cancel("c1");
    await running;

    expect(context.executed).toEqual(["SELECT FAIL"]);
    expect(context.session().question).toBeNull();
  });

  it("givenAsk_whenOnlyTheLastStatementFails_thenNothingIsAsked", async () => {
    const context = await opened("SELECT 1;\nSELECT FAIL;", { onError: "ask" });

    await context.store.getState().run("c1", "all");

    expect(context.session()).toMatchObject({ question: null, lastRun: { outcome: "failed" } });
    expect(context.messages().at(-1)).toBe("syntax error");
  });

  it("givenContinue_whenTheConnectionIsLost_thenTheRunStopsAnyway", async () => {
    const { store, executed } = await opened("SELECT LOST;\nSELECT 2;", { onError: "continue" });

    await store.getState().run("c1", "all");

    expect(executed).toEqual(["SELECT LOST"]);
  });

  it("givenOpenTransaction_whenContinuingPastFailures_thenWarnsOnce", async () => {
    const { store, messages } = await opened("BEGIN;\nSELECT FAIL;\nSELECT FAIL 2;\nSELECT 4;", {
      onError: "continue",
    });

    await store.getState().run("c1", "all");

    expect(messages().filter((message) => message.includes("inside a transaction"))).toHaveLength(1);
  });

  it("givenMarks_whenGotoError_thenCaretVisitsEachAndWraps", async () => {
    const sql = "SELECT FAIL;\nSELECT 2;\nSELECT FAIL 3;";
    const { store, session } = await opened(sql, { onError: "continue" });
    await store.getState().run("c1", "all");
    const first = sql.indexOf("FAIL");
    const second = sql.lastIndexOf("FAIL");
    store.getState().setSelection("c1", { from: 0, to: 0 });

    const landed = [true, true, true].map(() => {
      store.getState().gotoError("c1", false);
      return session().selection.from;
    });
    store.getState().gotoError("c1", true);

    expect(landed).toEqual([first, second, first]);
    expect(session().selection.from).toBe(second);
    expect(session().jump).toMatchObject({ from: second, to: second + "FAIL".length });
  });

  it("givenNoMarks_whenGotoError_thenFalse", async () => {
    const { store } = await opened("SELECT 1;");

    expect(store.getState().gotoError("c1", false)).toBe(false);
    expect(store.getState().showError("c1")).toBe(false);
  });

  it("givenShownErrorHasAMark_whenShowError_thenCaretOnIt", async () => {
    const sql = "SELECT 1;\nSELECT FAIL;";
    const { store, session } = await opened(sql);
    await store.getState().run("c1", "all");

    expect(store.getState().showError("c1")).toBe(true);
    expect(session().selection.from).toBe(sql.indexOf("FAIL"));
  });
});
