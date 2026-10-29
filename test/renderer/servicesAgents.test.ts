import { describe, expect, it } from "vitest";
import { agentGroups } from "@table-craft/desktop/renderer/model/mcp.js";
import {
  AGENTS_ROW_KEY,
  datasourceName,
  movedInTree,
  serviceRows,
} from "@table-craft/desktop/renderer/model/servicesTree.js";
import {
  stoppedStatus,
  type McpActivityView,
  type McpRunView,
  type McpStatus,
} from "@table-craft/desktop/settings/mcp.js";
import { view } from "./datasourceViews.js";

const RUN: McpRunView = {
  id: "run-1",
  clientId: "mcp-1",
  clientName: "Claude Code",
  datasourceId: "shop",
  tool: "run_query",
  sql: "SELECT 1",
  startedAt: 0,
  cancellable: true,
};

const CALL: McpActivityView = {
  id: 7,
  clientId: "mcp-1",
  clientName: "Claude Code",
  tool: "run_query",
  datasourceId: "shop",
  at: 0,
  durationMs: 4,
  outcome: "ok",
  target: "SELECT 2",
  rowCount: 1,
  message: null,
};

const STATUS: McpStatus = {
  ...stoppedStatus(47_820),
  state: "running",
  clients: [
    { id: "mcp-1", name: "Claude Code", version: "2.1", connectedAt: 0, lastCall: null },
    { id: "mcp-2", name: "Cursor", version: "1.0", connectedAt: 0, lastCall: null },
  ],
  running: [RUN],
};

describe("Services tree Agents node", () => {
  it("givenNoClients_whenRowsBuilt_thenNoAgentsNode", () => {
    expect(serviceRows([], new Set(), [], [], [], [], agentGroups(stoppedStatus(47_820)))).toEqual([]);
  });

  it("givenClientRunningStatement_whenRowsBuilt_thenClientDatasourceAndRunNested", () => {
    const rows = serviceRows([], new Set(), [], [], [], [], agentGroups(STATUS));

    expect(rows.map((row) => [row.kind, row.key, row.depth])).toEqual([
      ["agents", AGENTS_ROW_KEY, 0],
      ["agentClient", "agent:Claude Code", 1],
      ["agentDatasource", "agent:Claude Code:shop", 2],
      ["agentRun", "agentRun:run-1", 3],
      ["agentClient", "agent:Cursor", 1],
    ]);
  });

  it("givenFinishedCall_whenRowsBuilt_thenItStaysAfterTheRunningOnes", () => {
    const status: McpStatus = { ...STATUS, activity: [CALL] };

    const rows = serviceRows([], new Set(), [], [], [], [], agentGroups(status));

    expect(rows.filter((row) => row.depth === 3).map((row) => [row.kind, row.key, row.parent])).toEqual([
      ["agentRun", "agentRun:run-1", "agent:Claude Code:shop"],
      ["agentCall", "agentCall:7", "agent:Claude Code:shop"],
    ]);
  });

  it("givenAgentsCollapsed_whenRowsBuilt_thenOnlyTheNode", () => {
    const rows = serviceRows([], new Set([AGENTS_ROW_KEY]), [], [], [], [], agentGroups(STATUS));

    expect(rows.map((row) => row.kind)).toEqual(["agents"]);
  });

  it("givenRunSelected_whenArrowLeft_thenParentDatasourceSelected", () => {
    const rows = serviceRows([], new Set(), [], [], [], [], agentGroups(STATUS));

    expect(movedInTree(rows, "agentRun:run-1", new Set(), "ArrowLeft")?.selected).toBe("agent:Claude Code:shop");
    expect(movedInTree(rows, AGENTS_ROW_KEY, new Set([AGENTS_ROW_KEY]), "ArrowLeft")?.selected).toBe(AGENTS_ROW_KEY);
  });

  it("givenAgentDatasource_whenLabelled_thenUsesDatasourceName", () => {
    const [group] = agentGroups(STATUS)[0]?.datasources ?? [];

    expect(datasourceName([view({ id: "shop", name: "Shop TiDB" })], group?.datasourceId ?? "")).toBe("Shop TiDB");
  });

  it("givenDeletedDatasource_whenLabelled_thenFallsBackToId", () => {
    expect(datasourceName([view({ id: "other", name: "Other" })], "shop")).toBe("shop");
  });
});
