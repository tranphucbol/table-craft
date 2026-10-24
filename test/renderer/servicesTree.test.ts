import { describe, expect, it } from "vitest";
import {
  movedInTree,
  serviceRows,
  servicesTree,
  type ServicesInput,
} from "@table-craft/desktop/renderer/model/servicesTree.js";
import { closedConsoleNames } from "@table-craft/desktop/renderer/state/consoleFiles.js";
import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import type { Execution } from "@table-craft/desktop/renderer/state/executions.js";
import type { TableSession } from "@table-craft/desktop/renderer/state/tables.js";
import { view } from "./datasourceViews.js";

function consoleOn(datasourceId: string, overrides: Partial<ConsoleSession> = {}): ConsoleSession {
  return { datasourceId, status: "ready", lastRun: null, ...overrides } as unknown as ConsoleSession;
}

function tableOn(datasourceId: string, status: TableSession["status"] = "ready"): TableSession {
  return { datasourceId, status } as unknown as TableSession;
}

function execution(id: number, overrides: Partial<Execution> = {}): Execution {
  return {
    id,
    startedAt: 0,
    durationMs: 4,
    outcome: "success",
    label: `SELECT ${String(id)}`,
    sql: `SELECT ${String(id)}`,
    rowCount: 1,
    message: null,
    messages: [],
    ...overrides,
  };
}

const INPUT: ServicesInput = {
  tabs: [
    { id: "c1", kind: "console", title: "console" },
    { id: "t1", kind: "table", title: "orders" },
    { id: "c2", kind: "console", title: "console" },
    { id: "d1", kind: "ddl", title: "orders" },
    { id: "c3", kind: "console", title: "console_1" },
  ],
  consoles: {
    c1: consoleOn("pg", { lastRun: { durationMs: 12, outcome: "succeeded" } }),
    c2: consoleOn("lite", { status: "running" }),
    c3: consoleOn("pg"),
  },
  tables: { t1: tableOn("pg", "loading") },
  executions: {
    c1: [execution(2), execution(1)],
    t1: [execution(3, { label: "Load rows", durationMs: null, outcome: "running" }), execution(4, { durationMs: 30 })],
  },
  datasources: [view({ id: "lite", name: "lite", pluginId: "sqlite" }), view({ id: "pg", name: "pg" })],
};

describe("services tree", () => {
  it("givenConsoleAndTableTabs_whenBuildingServicesTree_thenGroupedByDatasource", () => {
    const tree = servicesTree(INPUT);

    expect(tree.map((datasource) => [datasource.name, datasource.sessions.map((session) => session.tabId)])).toEqual([
      ["pg", ["c1", "t1", "c3"]],
      ["lite", ["c2"]],
    ]);
    const [pg, lite] = tree;
    expect(pg?.sessions.map((session) => [session.kind, session.state, session.lastDurationMs])).toEqual([
      ["console", "idle", 12],
      ["table", "running", 30],
      ["console", "idle", null],
    ]);
    expect(pg?.sessions[0]?.executions.map((found) => found.id)).toEqual([2, 1]);
    expect(lite?.sessions[0]?.state).toBe("running");
  });

  it("givenNoConsoleOrTableTab_whenBuildingServicesTree_thenEmpty", () => {
    expect(servicesTree({ ...INPUT, tabs: [{ id: "d1", kind: "ddl", title: "orders" }] })).toEqual([]);
  });

  it("givenCollapsedSession_whenListingRows_thenItsExecutionsHidden", () => {
    const rows = serviceRows(servicesTree(INPUT), new Set(["session:c1"]));

    expect(rows.map((row) => row.key)).toEqual([
      "datasource:pg",
      "session:c1",
      "session:t1",
      "execution:t1:3",
      "execution:t1:4",
      "session:c3",
      "datasource:lite",
      "session:c2",
    ]);
  });

  it("givenExpandedSession_whenArrowLeftTwice_thenCollapsesThenMovesToDatasource", () => {
    const rows = serviceRows(servicesTree(INPUT), new Set());

    const collapsedOnce = movedInTree(rows, "session:c1", new Set(), "ArrowLeft");
    expect(collapsedOnce?.collapsed.has("session:c1")).toBe(true);
    const shown = serviceRows(servicesTree(INPUT), collapsedOnce?.collapsed ?? new Set());
    expect(movedInTree(shown, "session:c1", collapsedOnce?.collapsed ?? new Set(), "ArrowLeft")?.selected).toBe(
      "datasource:pg",
    );
  });

  it("givenNothingSelected_whenArrowDown_thenFirstRow", () => {
    const rows = serviceRows(servicesTree(INPUT), new Set());

    expect(movedInTree(rows, null, new Set(), "ArrowDown")?.selected).toBe("datasource:pg");
    expect(movedInTree(rows, null, new Set(), "x")).toBeNull();
  });
});

describe("closed consoles", () => {
  it("givenOpenConsole_whenListingClosed_thenExcluded", () => {
    expect(closedConsoleNames(["console_2", "console", "console_1"], ["console"])).toEqual(["console_1", "console_2"]);
  });
});
