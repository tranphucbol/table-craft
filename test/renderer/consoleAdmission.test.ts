import { describe, expect, it, vi } from "vitest";
import type {
  ClassifiedStatement,
  CommandAdmission,
  ExecutedStatement,
  OpenedSession,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { createConsolesStore } from "@table-craft/desktop/renderer/state/consoles.js";
import {
  ADMISSION_FAILED,
  ADMISSION_REJECTED,
  ADMIN_LEASES_ACTION,
  installConsoleIntentRouter,
  intentAction,
  MANAGED_ALONE,
  MANAGED_INTENT_ACTION,
  MANAGED_INTENT_INSPECTION_PREFIX,
  MANAGED_OPENED,
  MANAGER_UNAVAILABLE,
  routeConsoleIntent,
  WATCH_START_ACTION,
  type ConsoleIntentRoute,
} from "@table-craft/desktop/renderer/state/consoleAdmission.js";
import { createExecutionsStore } from "@table-craft/desktop/renderer/state/executions.js";
import {
  MANAGED_INTENT_ACTION_ID,
  MANAGED_INTENT_INSPECTION_PREFIX as DES13_PREFIX,
  managedIntentOf,
} from "@table-craft/desktop/renderer/keyAdmin/consoleIntents.js";
import { ADMIN_ACTION_IDS } from "@table-craft/desktop/renderer/keyAdmin/actions.js";
import { WATCH_ACTION_IDS } from "@table-craft/desktop/renderer/watch/actions.js";
import type { HistoryEntry } from "@table-craft/desktop/preload/bridge.js";

const SECRET = "hunter2";
const SESSION_ID = "s1";
const EXECUTE: CommandAdmission = { admit: "execute", safeLabel: "" };
const REJECT: CommandAdmission = { admit: "reject", safeLabel: "" };
const WATCH_REQUEST = {
  database: 0,
  range: { kind: "prefix", prefix: { text: "/app", hex: null } },
  from: { kind: "now" },
} as const;

/** A command console's verdict for each line, as an etcd-like plugin answers it. */
function verdictOf(command: string): CommandAdmission {
  if (command.startsWith("private")) return { admit: "omitHistory", safeLabel: "auth token" };
  if (command.includes(SECRET) || command.includes(":")) return REJECT;
  if (command === "user add alice") {
    return {
      admit: "managed",
      intent: "credentials",
      arguments: { kind: "credentials", change: "createUser", user: "alice" },
      safeLabel: "user add",
    };
  }
  if (command === "user passwd alice") {
    return {
      admit: "managed",
      intent: "credentials",
      arguments: { kind: "credentials", change: "changePassword", user: "alice" },
      safeLabel: "user passwd",
    };
  }
  if (command.startsWith("watch")) {
    return {
      admit: "managed",
      intent: "watch",
      arguments: { kind: "watch", request: WATCH_REQUEST },
      safeLabel: "watch",
    };
  }
  return EXECUTE;
}

function lines(text: string, destructive: string | null = null): ClassifiedStatement[] {
  const statements: ClassifiedStatement[] = [];
  let from = 0;
  for (const line of text.split("\n")) {
    const sql = line.trim();
    if (sql !== "") statements.push({ from, to: from + line.length, sql, kind: "read", destructive, parameters: [] });
    from += line.length + 1;
  }
  return statements;
}

function executed(handle: string, sql: string): ExecutedStatement {
  return {
    handle,
    columns: [{ name: "value", type: "string" }],
    typeClasses: ["text"],
    rowCount: 1,
    complete: true,
    cursorOpen: false,
    rowsAffected: null,
    firstWindow: { offset: 0, rows: [[sql]] },
    transactionOpen: false,
  };
}

interface EngineOptions {
  readonly capabilities?: OpenedSession["capabilities"];
  readonly admit?: (commands: readonly string[]) => Promise<unknown>;
  readonly failExecute?: boolean;
  readonly destructive?: string;
}

function fakeEngine(options: EngineOptions = {}) {
  const ran: string[] = [];
  const asked: string[][] = [];
  const released: string[] = [];
  let handles = 0;
  const call = vi.fn((type: string, params: Record<string, unknown>): Promise<unknown> => {
    switch (type) {
      case "session.open": {
        const opened: OpenedSession = {
          sessionId: SESSION_ID,
          pluginName: "fake",
          capabilities: options.capabilities ?? ["commands", "keyValue"],
          serverVersion: "3.6",
          serverBrand: null,
          serverTimeout: null,
          cancelReach: null,
          namespace: null,
        };
        return Promise.resolve(opened);
      }
      case "script.split":
        return Promise.resolve(lines(String(params.text), options.destructive ?? null));
      case "commands.admit": {
        const commands = params.commands as readonly string[];
        asked.push([...commands]);
        return options.admit === undefined ? Promise.resolve(commands.map(verdictOf)) : options.admit(commands);
      }
      case "statement.execute": {
        const sql = String(params.sql);
        ran.push(sql);
        if (options.failExecute === true) {
          return Promise.reject(
            new EngineRequestError({ code: "statementFailed", message: `failed: ${sql}`, hint: "", position: 0 }),
          );
        }
        return Promise.resolve(executed(`h${String(++handles)}`, sql));
      }
      case "result.release":
        released.push(String(params.handle));
        return Promise.resolve(null);
      default:
        return Promise.resolve(null);
    }
  });
  return { client: { call } as unknown as EngineClient, call, ran, asked, released };
}

interface OpenOptions extends EngineOptions {
  readonly route?: (route: ConsoleIntentRoute) => boolean;
  readonly confirm?: (statements: readonly ClassifiedStatement[], datasourceId: string) => Promise<boolean>;
}

async function opened(sql: string, options: OpenOptions = {}) {
  const engine = fakeEngine(options);
  const recorded: HistoryEntry[] = [];
  const executions = createExecutionsStore();
  const started = vi.spyOn(executions.getState(), "start");
  const route = vi.fn(options.route ?? (() => true));
  let now = 0;
  const store = createConsolesStore({
    connect: () => Promise.resolve(engine.client),
    now: () => (now += 5),
    clock: () => 0,
    executions: executions.getState(),
    record: (entry) => recorded.push(entry),
    routeIntent: route,
    ...(options.confirm === undefined ? {} : { confirmDestructive: options.confirm }),
  });
  await store.getState().open("c1", "etcd", { sql });
  const session = () => {
    const current = store.getState().consoles.c1;
    if (current === undefined) throw new Error("console c1 is gone");
    return current;
  };
  /** Everything the console kept that a user or a log could later read. */
  const kept = () =>
    JSON.stringify({
      output: session().output,
      error: session().error,
      results: session().results.map((tab) => tab.sql),
      marks: session().errorMarks,
      recorded,
      services: executions.getState(),
    });
  return { ...engine, store, recorded, executions, started, route, session, kept };
}

describe("console admission", () => {
  it.each([`user add alice ${SECRET}`, `user add alice:${SECRET}`, `user passwd alice ${SECRET}`])(
    "givenPlaintextCredential_whenRun_thenNothingRunsOrIsRecorded %#",
    async (text) => {
      const { store, ran, recorded, started, route, session, kept } = await opened(text);

      await store.getState().run("c1", "all");

      expect(ran).toEqual([]);
      expect(recorded).toEqual([]);
      expect(started).not.toHaveBeenCalled();
      expect(route).not.toHaveBeenCalled();
      expect(session().error).toEqual(ADMISSION_REJECTED);
      expect(session().output.map((entry) => entry.sql)).toEqual([""]);
      expect(kept()).not.toContain(SECRET);
      expect(kept()).not.toContain("alice");
      expect(session().lastRun?.outcome).toBe("failed");
      expect(session().sql).toBe("");
      expect(session().privacyReset).toBe(1);
    },
  );

  it("givenCredentialAmongOthers_whenRunAll_thenWholeRunRefused", async () => {
    const { store, ran, recorded, started, kept } = await opened(`get /a\nuser add bob ${SECRET}\nget /b`);

    await store.getState().run("c1", "all");

    expect(ran).toEqual([]);
    expect(recorded).toEqual([]);
    expect(started).not.toHaveBeenCalled();
    expect(kept()).not.toContain(SECRET);
  });

  it.each([
    ["user add alice", "createUser"],
    ["user passwd alice", "changePassword"],
  ] as const)("givenUserNameOnly_whenRun_thenCredentialManagerOpensWithTrustedName %#", async (text, change) => {
    const { store, ran, recorded, started, route, session } = await opened(text);

    await store.getState().run("c1", "all");

    expect(route).toHaveBeenCalledWith({
      datasourceId: "etcd",
      intent: "credentials",
      arguments: { kind: "credentials", change, user: "alice" },
    });
    expect(ran).toEqual([]);
    expect(recorded).toEqual([]);
    expect(started).not.toHaveBeenCalled();
    expect(session().output.map((entry) => [entry.sql, entry.message])).toEqual([
      [text.startsWith("user add") ? "user add" : "user passwd", MANAGED_OPENED],
    ]);
  });

  it("givenWatch_whenRun_thenWatchManagerOpensAndNoExecutionIsHeld", async () => {
    const { store, ran, started, route, session } = await opened("watch /app --prefix");

    await store.getState().run("c1", "caret");

    expect(route).toHaveBeenCalledWith({
      datasourceId: "etcd",
      intent: "watch",
      arguments: { kind: "watch", request: WATCH_REQUEST },
    });
    expect(ran).toEqual([]);
    expect(started).not.toHaveBeenCalled();
    expect(session().status).toBe("ready");
  });

  it("givenNoManagerAction_whenManagedRun_thenFailsClosed", async () => {
    const { store, ran, recorded, session } = await opened("watch /app", { route: () => false });

    await store.getState().run("c1", "all");

    expect(ran).toEqual([]);
    expect(recorded).toEqual([]);
    expect(session().error).toEqual(MANAGER_UNAVAILABLE);
  });

  it("givenManagedAmongOthers_whenRunAll_thenNothingRuns", async () => {
    const { store, ran, route, session } = await opened("get /a\nwatch /app");

    await store.getState().run("c1", "all");

    expect(ran).toEqual([]);
    expect(route).not.toHaveBeenCalled();
    expect(session().error).toEqual(MANAGED_ALONE);
  });

  it.each([
    [
      "engine error",
      () => Promise.reject(new EngineRequestError({ code: "invalidRequest", message: SECRET, hint: "" })),
    ],
    ["wrong count", () => Promise.resolve([])],
    ["malformed answer", () => Promise.resolve([{ admit: "sure" }])],
    ["managed without intent", () => Promise.resolve([{ admit: "managed", safeLabel: "" }])],
    ["not an array", () => Promise.resolve(null)],
  ])("givenAdmissionFails_%s_whenRun_thenFailsClosed", async (_name, admit) => {
    const { store, ran, recorded, started, session, kept } = await opened("get /a", { admit });

    await store.getState().run("c1", "all");

    expect(ran).toEqual([]);
    expect(recorded).toEqual([]);
    expect(started).not.toHaveBeenCalled();
    expect(session().error).toEqual(ADMISSION_FAILED);
    expect(kept()).not.toContain(SECRET);
  });

  it("givenTextEditedWhileAdmitting_whenRun_thenOnlyTheAskedSnapshotRuns", async () => {
    let edit = (): void => undefined;
    const { store, ran, asked, recorded, kept } = await opened("get /a", {
      admit: (commands) => {
        edit();
        return Promise.resolve(commands.map(verdictOf));
      },
    });
    edit = () => store.getState().setSql("c1", `user add alice ${SECRET}`);

    await store.getState().run("c1", "all");

    expect(asked).toEqual([["get /a"]]);
    expect(ran).toEqual(["get /a"]);
    expect(recorded.map((entry) => entry.sql)).toEqual(["get /a"]);
    expect(kept()).not.toContain(SECRET);
  });

  it("givenTextEditedAfterARun_whenRerun_thenNewTextIsAdmittedAgain", async () => {
    const { store, ran, asked, session } = await opened("get /a");
    await store.getState().run("c1", "all");
    store.getState().setSql("c1", `user add alice ${SECRET}`);

    await store.getState().run("c1", "all");

    expect(asked).toEqual([["get /a"], [`user add alice ${SECRET}`]]);
    expect(ran).toEqual(["get /a"]);
    expect(session().error).toEqual(ADMISSION_REJECTED);
  });

  it("givenResultTab_whenRunAgainAndRefused_thenNothingRuns", async () => {
    let refuse = false;
    const { store, ran, session } = await opened("get /a", {
      admit: (commands) => Promise.resolve(commands.map((command) => (refuse ? REJECT : verdictOf(command)))),
    });
    await store.getState().run("c1", "all");
    const [tab] = session().results;
    refuse = true;

    await store.getState().rerun("c1", tab?.id ?? "");

    expect(ran).toEqual(["get /a"]);
    expect(session().error).toEqual(ADMISSION_REJECTED);
  });

  it("givenOmitHistory_whenRun_thenRunsWithoutTextInHistoryServicesOrResults", async () => {
    const { store, ran, recorded, executions, released, session, kept } = await opened(`private ${SECRET}`);

    await store.getState().run("c1", "all");

    expect(ran).toEqual([`private ${SECRET}`]);
    expect(recorded).toEqual([]);
    expect(session().results).toEqual([]);
    expect(released).toEqual(["h1"]);
    expect(JSON.stringify(executions.getState())).toContain("auth token");
    expect(kept()).not.toContain(SECRET);
  });

  it("givenOmitHistoryFails_whenRun_thenServerMessageAndMarkAreDropped", async () => {
    const { store, recorded, session, kept } = await opened(`private ${SECRET}`, { failExecute: true });

    await store.getState().run("c1", "all");

    expect(recorded).toEqual([]);
    expect(session().errorMarks).toEqual([]);
    expect(kept()).not.toContain(SECRET);
  });

  it("givenDestructiveOmitHistory_whenConfirmed_thenDialogShowsOnlyTheSafeLabel", async () => {
    const confirm = vi.fn((_statements: readonly ClassifiedStatement[], _id: string) => Promise.resolve(true));
    const { store, ran, kept } = await opened(`private ${SECRET}\nsecond line`, {
      destructive: "deletes keys",
      confirm,
    });

    await store.getState().run("c1", "all");

    const asked = confirm.mock.calls[0]?.[0] ?? [];
    expect(asked.map((statement) => statement.sql)).toEqual(["auth token", "second line"]);
    expect(asked[0]?.parameters).toEqual([]);
    expect(JSON.stringify(asked)).not.toContain(SECRET);
    expect(JSON.stringify(asked)).not.toContain("private");
    expect(ran).toEqual([`private ${SECRET}`, "second line"]);
    expect(kept()).not.toContain(SECRET);
  });

  it("givenDestructiveOmitHistory_whenDeclined_thenNothingRunsOrShowsText", async () => {
    const confirm = vi.fn(() => Promise.resolve(false));
    const { store, ran, kept } = await opened(`private ${SECRET}`, { destructive: "deletes keys", confirm });

    await store.getState().run("c1", "all");

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(confirm.mock.calls)).not.toContain(SECRET);
    expect(ran).toEqual([]);
    expect(kept()).not.toContain(SECRET);
  });

  it("givenSqlConsole_whenRun_thenNoAdmissionIsAsked", async () => {
    const { store, ran, asked } = await opened("SELECT 1", { capabilities: ["sql"] });

    await store.getState().run("c1", "all");

    expect(asked).toEqual([]);
    expect(ran).toEqual(["SELECT 1"]);
  });
});

describe("console intent routing", () => {
  const route = (intent: ConsoleIntentRoute["intent"], args: ConsoleIntentRoute["arguments"]): ConsoleIntentRoute => ({
    datasourceId: "etcd",
    intent,
    arguments: args,
  });

  function host(outcome: "ran" | "disabled" | "unknown" = "ran", secret: Promise<void> = Promise.resolve()) {
    return {
      invoke: vi.fn((_id: string, _args: unknown) => outcome),
      applySecret: vi.fn((_id: string, _user: string, _change: "createUser" | "changePassword") => secret),
      secretFailed: vi.fn(),
    };
  }

  it("givenDes13Exports_whenCompared_thenConstantsMatch", () => {
    expect(MANAGED_INTENT_ACTION).toBe(MANAGED_INTENT_ACTION_ID);
    expect(MANAGED_INTENT_INSPECTION_PREFIX).toBe(DES13_PREFIX);
    expect(WATCH_START_ACTION).toBe(WATCH_ACTION_IDS.start);
    expect(ADMIN_LEASES_ACTION).toBe(ADMIN_ACTION_IDS.leases);
    for (const intent of ["access", "snapshot", "cluster", "admin"] as const) {
      expect(managedIntentOf(`${MANAGED_INTENT_INSPECTION_PREFIX}${intent}`)).toBe(intent);
    }
  });

  it("givenEachIntent_whenRouted_thenTrustedPresetOrManagedIntentAction", () => {
    expect(intentAction(route("watch", { kind: "watch", request: WATCH_REQUEST }))).toEqual({
      kind: "action",
      actionId: WATCH_START_ACTION,
      args: { datasourceId: "etcd", database: 0, range: WATCH_REQUEST.range, from: WATCH_REQUEST.from },
    });
    expect(
      intentAction(route("credentials", { kind: "credentials", change: "changePassword", user: "alice" })),
    ).toEqual({ kind: "secret", datasourceId: "etcd", user: "alice", change: "changePassword" });
    expect(intentAction(route("leaseRevoke", { kind: "leaseRevoke", leaseId: "7" }))).toEqual({
      kind: "action",
      actionId: ADMIN_LEASES_ACTION,
      args: { datasourceId: "etcd", leaseId: "7" },
    });
    expect(intentAction(route("leaseGrant", { kind: "none" }))).toEqual({
      kind: "action",
      actionId: ADMIN_LEASES_ACTION,
      args: { datasourceId: "etcd" },
    });
    for (const intent of ["access", "snapshot", "cluster", "admin"] as const) {
      expect(intentAction(route(intent, { kind: "none" }))).toEqual({
        kind: "action",
        actionId: MANAGED_INTENT_ACTION,
        args: { datasourceId: "etcd", inspection: `${MANAGED_INTENT_INSPECTION_PREFIX}${intent}` },
      });
    }
  });

  it("givenMismatchedArguments_whenRouted_thenNoAction", () => {
    expect(intentAction(route("watch", { kind: "none" }))).toBeNull();
    expect(intentAction(route("credentials", { kind: "none" }))).toBeNull();
    expect(intentAction(route("leaseRevoke", { kind: "keepAlive", leaseId: "7" }))).toBeNull();
    expect(intentAction(route("leaseGrant", { kind: "leaseRevoke", leaseId: "7" }))).toBeNull();
    expect(intentAction(route("access", { kind: "credentials", change: "createUser", user: "a" }))).toBeNull();
  });

  it("givenRouterInstalled_whenRouted_thenInvokesOnlyWhileInstalled", () => {
    const installed = host();
    const watch = route("watch", { kind: "watch", request: WATCH_REQUEST });
    expect(routeConsoleIntent(watch)).toBe(false);

    const uninstall = installConsoleIntentRouter(installed);
    expect(routeConsoleIntent(watch)).toBe(true);
    expect(installed.invoke).toHaveBeenCalledWith(
      WATCH_START_ACTION,
      expect.objectContaining({ datasourceId: "etcd" }),
    );

    uninstall();
    expect(routeConsoleIntent(watch)).toBe(false);
  });

  it("givenActionNotRegistered_whenRouted_thenNotOpened", () => {
    const uninstall = installConsoleIntentRouter(host("unknown"));
    try {
      expect(routeConsoleIntent(route("access", { kind: "none" }))).toBe(false);
    } finally {
      uninstall();
    }
  });

  it("givenSecretPromptFails_whenRouted_thenFixedNoticeOnly", async () => {
    const installed = host("ran", Promise.reject(new Error(SECRET)));
    const uninstall = installConsoleIntentRouter(installed);
    try {
      expect(routeConsoleIntent(route("credentials", { kind: "credentials", change: "createUser", user: "a" }))).toBe(
        true,
      );
      await vi.waitFor(() => expect(installed.secretFailed).toHaveBeenCalledWith());
    } finally {
      uninstall();
    }
  });

  it.each([
    ["user add alice", "createUser"],
    ["user passwd alice", "changePassword"],
  ] as const)(
    "givenUserNameOnlyAndDefaultRouter_whenRun_thenSecretPromptForTrustedNameAndNothingRecorded %#",
    async (text, change) => {
      const installed = host();
      const uninstall = installConsoleIntentRouter(installed);
      try {
        const engine = fakeEngine();
        const recorded: HistoryEntry[] = [];
        const store = createConsolesStore({
          connect: () => Promise.resolve(engine.client),
          now: () => 0,
          record: (entry) => recorded.push(entry),
        });
        await store.getState().open("c1", "etcd", { sql: text });

        await store.getState().run("c1", "all");

        expect(installed.applySecret).toHaveBeenCalledWith("etcd", "alice", change);
        expect(installed.invoke).not.toHaveBeenCalled();
        expect(engine.ran).toEqual([]);
        expect(recorded).toEqual([]);
        const output = store.getState().consoles.c1?.output ?? [];
        expect(JSON.stringify(output)).not.toContain("alice");
        expect(output.map((entry) => entry.message)).toEqual([MANAGED_OPENED]);
      } finally {
        uninstall();
      }
    },
  );
});
