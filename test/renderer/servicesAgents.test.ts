import { describe, expect, it } from "vitest";
import { agentGroups } from "@table-craft/desktop/renderer/model/mcp.js";
import { AGENTS_ROW_KEY, movedInTree, serviceRows } from "@table-craft/desktop/renderer/model/servicesTree.js";
import { stoppedStatus, type McpRunView, type McpStatus } from "@table-craft/desktop/settings/mcp.js";

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
      ["agentClient", "agent:mcp-1", 1],
      ["agentDatasource", "agent:mcp-1:shop", 2],
      ["agentRun", "agentRun:run-1", 3],
      ["agentClient", "agent:mcp-2", 1],
    ]);
  });

  it("givenAgentsCollapsed_whenRowsBuilt_thenOnlyTheNode", () => {
    const rows = serviceRows([], new Set([AGENTS_ROW_KEY]), [], [], [], [], agentGroups(STATUS));

    expect(rows.map((row) => row.kind)).toEqual(["agents"]);
  });

  it("givenRunSelected_whenArrowLeft_thenParentDatasourceSelected", () => {
    const rows = serviceRows([], new Set(), [], [], [], [], agentGroups(STATUS));

    expect(movedInTree(rows, "agentRun:run-1", new Set(), "ArrowLeft")?.selected).toBe("agent:mcp-1:shop");
    expect(movedInTree(rows, AGENTS_ROW_KEY, new Set([AGENTS_ROW_KEY]), "ArrowLeft")?.selected).toBe(AGENTS_ROW_KEY);
  });
});
