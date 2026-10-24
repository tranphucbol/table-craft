import { describe, expect, it } from "vitest";
import type { Capability, ListedSession, SessionsListing } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import type { AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  SESSIONS_ACTION_IDS,
  SESSIONS_ACTIONS,
  terminateRequest,
} from "@table-craft/desktop/renderer/actions/sessionsActions.js";
import { openSessionsIn } from "@table-craft/desktop/renderer/actions/sessionsCommands.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { sessionsTabLabel } from "@table-craft/desktop/renderer/model/format.js";
import {
  NO_FILTERS,
  sessionDuration,
  sessionKey,
  sessionTone,
  visibleSessions,
} from "@table-craft/desktop/renderer/model/sessionsView.js";
import { DISCONNECTED } from "@table-craft/desktop/renderer/state/datasources.js";
import { createSessionsStore, type SessionsTab } from "@table-craft/desktop/renderer/state/sessions.js";
import { activeTab, createTabsStore } from "@table-craft/desktop/renderer/state/tabs.js";
import { view } from "./datasourceViews.js";
import { IDLE_CONTEXT } from "./support.js";

function session(overrides: Partial<ListedSession> & Pick<ListedSession, "id">): ListedSession {
  return {
    instance: null,
    state: "active",
    rawState: "active",
    user: "app",
    database: "shop",
    client: "10.0.0.7",
    application: "psql",
    queryMs: 1_200,
    transactionMs: null,
    waitEvent: null,
    blockedBy: [],
    query: "SELECT 1",
    system: false,
    cancel: `SELECT pg_cancel_backend(${overrides.id})`,
    terminate: `SELECT pg_terminate_backend(${overrides.id})`,
    ownSessionId: null,
    own: false,
    ...overrides,
  };
}

const ACTIVE = session({ id: "101", query: "SELECT pg_sleep(60)" });
const IDLE = session({ id: "102", state: "idle", rawState: "idle", query: "COMMIT", queryMs: null });
const IN_TRANSACTION = session({ id: "103", state: "idleInTransaction", rawState: "idle in transaction" });
const BLOCKED = session({ id: "104", state: "blocked", user: "billing", blockedBy: ["103"], query: "UPDATE orders" });
const SYSTEM = session({ id: "105", state: "other", system: true, cancel: null, terminate: null, query: null });
const OWN = session({ id: "106", ownSessionId: "s7", own: true });
const ALL: readonly ListedSession[] = [ACTIVE, IDLE, IN_TRANSACTION, BLOCKED, SYSTEM, OWN];
const LISTING: SessionsListing = { sessions: ALL, notes: [] };

function ids(sessions: readonly ListedSession[]): string[] {
  return sessions.map((row) => row.id);
}

describe("sessions view model", () => {
  it("givenHideIdle_whenFiltered_thenIdleGone", () => {
    expect(ids(visibleSessions(ALL, { ...NO_FILTERS, hideIdle: true }))).toEqual(["101", "103", "104", "105", "106"]);
  });

  it("givenHideSystem_whenFiltered_thenBackgroundProcessesGone", () => {
    expect(ids(visibleSessions(ALL, { ...NO_FILTERS, hideSystem: true }))).not.toContain("105");
  });

  it("givenBlockedOnly_whenFiltered_thenOnlyBlocked", () => {
    expect(ids(visibleSessions(ALL, { ...NO_FILTERS, blockedOnly: true }))).toEqual(["104"]);
  });

  it("givenSearch_whenFiltered_thenMatchesQueryOrUser", () => {
    expect(ids(visibleSessions(ALL, { ...NO_FILTERS, search: "PG_SLEEP" }))).toEqual(["101"]);
    expect(ids(visibleSessions(ALL, { ...NO_FILTERS, search: " billing " }))).toEqual(["104"]);
  });

  it("givenIdleInTransaction_whenToned_thenWarning", () => {
    expect(sessionTone(IN_TRANSACTION)).toBe("warning");
    expect(sessionTone(ACTIVE)).toBeNull();
  });

  it("givenBlocked_whenToned_thenDanger", () => {
    expect(sessionTone(BLOCKED)).toBe("danger");
    expect(sessionTone(session({ id: "9", state: "active", blockedBy: ["1"] }))).toBe("danger");
  });

  it("givenDurations_whenFormatted_thenLargestTwoUnits", () => {
    expect([null, 850, 42_000, 185_000, 7_440_000, 262_800_000].map(sessionDuration)).toEqual([
      "—",
      "850 ms",
      "42 s",
      "3 min 5 s",
      "2 h 4 min",
      "3 d 1 h",
    ]);
  });

  it("givenTidbRows_whenKeyed_thenInstanceSeparatesEqualIds", () => {
    expect(sessionKey({ id: "7", instance: "a:10080" })).not.toBe(sessionKey({ id: "7", instance: "b:10080" }));
  });

  it("givenDatasourceName_whenLabelled_thenSessionsDotName", () => {
    expect(sessionsTabLabel("Sessions", "pg")).toBe("Sessions · pg");
  });
});

function engine(listing: SessionsListing = LISTING) {
  const calls: string[] = [];
  const client = {
    call(type: string): Promise<unknown> {
      calls.push(type);
      return Promise.resolve(type === "sessions.list" ? listing : null);
    },
    fail: () => undefined,
    onEvent: () => () => undefined,
  };
  return { client: client as EngineClient, calls };
}

function stores(listing?: SessionsListing) {
  const { client, calls } = engine(listing);
  return { tabs: createTabsStore(), sessions: createSessionsStore({ connect: () => Promise.resolve(client) }), calls };
}

describe("Sessions tab", () => {
  it("givenDatasource_whenShowSessions_thenTabListsItsSessions", async () => {
    const { tabs, sessions } = stores();

    await openSessionsIn({ tabs, sessions }, "pg");

    const tab = activeTab(tabs.getState());
    expect(tab).toMatchObject({ kind: "sessions", title: "Sessions" });
    expect(sessions.getState().tabs[tab?.id ?? ""]).toMatchObject({
      datasourceId: "pg",
      listing: LISTING,
      selected: null,
    });
  });

  it("givenSessionsTabOpen_whenShownAgain_thenFocusesAndRefreshesIt", async () => {
    const { tabs, sessions, calls } = stores();
    await openSessionsIn({ tabs, sessions }, "pg");

    await openSessionsIn({ tabs, sessions }, "pg");

    expect(tabs.getState().tabs).toHaveLength(1);
    expect(calls).toEqual(["sessions.list", "sessions.list"]);
  });

  it("givenExecution_whenShowInSessions_thenRowSelected", async () => {
    const { tabs, sessions } = stores();

    await openSessionsIn({ tabs, sessions }, "pg", "s7");

    const id = activeTab(tabs.getState())?.id ?? "";
    expect(sessions.getState().tabs[id]?.selected).toBe(sessionKey(OWN));
  });

  it("givenSelectedRow_whenTerminated_thenStatusSaysSoAndListsAgain", async () => {
    const { tabs, sessions, calls } = stores();
    await openSessionsIn({ tabs, sessions }, "pg");
    const id = activeTab(tabs.getState())?.id ?? "";

    expect(await sessions.getState().stop(id, BLOCKED, "terminate")).toBe(true);

    expect(calls).toEqual(["sessions.list", "sessions.terminate", "sessions.list"]);
    expect(sessions.getState().tabs[id]?.status).toBe("Terminated session 104.");
  });
});

const ACTIONS = new Map<string, AnyAction>(SESSIONS_ACTIONS.map((action) => [action.id, action]));

function action(id: string): AnyAction {
  const found = ACTIONS.get(id);
  if (found === undefined) throw new Error(`no action ${id}`);
  return found;
}

function enabled(id: string, context: ActionContext): boolean {
  const found = action(id);
  return (found.available?.(context) ?? true) && (found.when?.(context) ?? true);
}

function sessionsContext(datasource: DatasourceView, selected: ListedSession): ActionContext {
  const tab: SessionsTab = {
    datasourceId: datasource.id,
    listing: LISTING,
    loading: false,
    error: null,
    filters: NO_FILTERS,
    selected: sessionKey(selected),
    autoRefresh: false,
    status: null,
  };
  return {
    ...IDLE_CONTEXT,
    tabs: [{ id: "sessions-0", kind: "sessions", title: "Sessions" }],
    activeTab: { id: "sessions-0", kind: "sessions", title: "Sessions" },
    sessions: tab,
    datasources: [datasource],
    capabilities: ["sql", "schemaTree", "explain", "sessions"],
  };
}

const PG = view({ id: "pg", name: "pg" });

function treeContext(capabilities: readonly Capability[]): ActionContext {
  const datasource = view({ id: "lite", name: "lite", pluginId: "sqlite" });
  return {
    ...IDLE_CONTEXT,
    focus: "database",
    inDatabasePane: true,
    datasources: [datasource],
    datasource: { view: datasource, connection: DISCONNECTED, capabilities },
  };
}

describe("sessions actions", () => {
  it("givenSelectedSession_whenSessionsTab_thenKillEnabled", () => {
    const context = sessionsContext(PG, ACTIVE);

    expect(enabled(SESSIONS_ACTION_IDS.cancel, context)).toBe(true);
    expect(enabled(SESSIONS_ACTION_IDS.terminate, context)).toBe(true);
  });

  it("givenReadOnlyDatasource_whenSessionsTab_thenKillDisabled", () => {
    const context = sessionsContext(view({ id: "pg", name: "pg", readOnly: true }), ACTIVE);

    expect(enabled(SESSIONS_ACTION_IDS.cancel, context)).toBe(false);
    expect(enabled(SESSIONS_ACTION_IDS.terminate, context)).toBe(false);
    expect(enabled(SESSIONS_ACTION_IDS.copySql, context)).toBe(true);
  });

  it("givenSystemProcess_whenSessionsTab_thenKillDisabled", () => {
    const context = sessionsContext(PG, SYSTEM);

    expect(enabled(SESSIONS_ACTION_IDS.cancel, context)).toBe(false);
    expect(enabled(SESSIONS_ACTION_IDS.terminate, context)).toBe(false);
    expect(enabled(SESSIONS_ACTION_IDS.openInConsole, context)).toBe(false);
  });

  it("givenSqlitePlugin_whenMenu_thenShowSessionsHidden", () => {
    expect(action(SESSIONS_ACTION_IDS.show).available?.(treeContext(["sql", "schemaTree"]))).toBe(false);
    expect(enabled(SESSIONS_ACTION_IDS.show, treeContext(["sql", "schemaTree", "sessions"]))).toBe(true);
  });

  it("givenRedDatasource_whenTerminate_thenRequiresTypedPid", () => {
    const red = view({ id: "prod", name: "prod", color: "red" });

    expect(terminateRequest(red, ACTIVE, "SELECT pg_terminate_backend(101)")).toMatchObject({ typed: "101" });
    expect(terminateRequest(PG, ACTIVE, "SELECT pg_terminate_backend(101)")).not.toHaveProperty("typed");
  });

  it("givenTerminate_whenConfirming_thenShowsExactStatement", () => {
    const request = terminateRequest(PG, ACTIVE, "SELECT pg_terminate_backend(101)");

    expect(request).toMatchObject({ kind: "confirm", destructive: true });
    expect(request.items.map((item) => item.label)).toEqual(["SELECT pg_terminate_backend(101)"]);
  });

  it("givenOwnSession_whenTerminate_thenWarns", () => {
    expect(terminateRequest(PG, OWN, "SELECT pg_terminate_backend(106)").message).toContain("TableCraft's own");
    expect(terminateRequest(PG, ACTIVE, "SELECT pg_terminate_backend(101)").message).not.toContain("own");
  });
});
