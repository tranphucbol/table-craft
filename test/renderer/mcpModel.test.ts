import { describe, expect, it } from "vitest";
import {
  AGENT_CALLS_PER_DATASOURCE,
  CALL_EXECUTION_OUTCOMES,
  activityClients,
  activityConsoleRequest,
  agentGroups,
  connectedFor,
  countdown,
  filteredActivity,
  mcpChip,
  mcpStatusText,
} from "@table-craft/desktop/renderer/model/mcp.js";
import {
  effectiveAccess,
  mcpClientConfig,
  stoppedStatus,
  tokenHint,
  type McpActivityView,
  type McpApprovalView,
  type McpStatus,
} from "@table-craft/desktop/settings/mcp.js";

const RUNNING: McpStatus = { ...stoppedStatus(47_820), state: "running" };
const CLIENT = { id: "s1", name: "Claude Code", version: "2.1", connectedAt: 0, lastCall: null };
const APPROVAL: McpApprovalView = {
  id: "approval-1",
  clientName: "Claude Code",
  datasourceId: "shop",
  datasourceName: "Shop",
  sql: "UPDATE orders SET total = 0",
  kind: "write",
  subject: "statement",
  database: null,
  destructive: "no WHERE",
  reason: null,
  deadline: 0,
  allowable: false,
};

describe("MCP status chip", () => {
  it("givenServerOff_whenChipped_thenGreyChip", () => {
    expect(mcpChip(stoppedStatus(47_820))).toMatchObject({ tone: "off", label: "MCP" });
    expect(mcpStatusText(stoppedStatus(47_820))).toBe("Off");
  });

  it("givenRunningWithClients_whenChipped_thenGreenWithTheCount", () => {
    const status = { ...RUNNING, clients: [CLIENT, { ...CLIENT, id: "s2" }] };

    expect(mcpChip(status)).toEqual({
      tone: "running",
      label: "MCP 2",
      tooltip: "MCP server running on port 47820 · 2 clients",
    });
    expect(mcpStatusText(status)).toBe("Running · 2 clients connected");
  });

  it("givenWriteWaiting_whenChipped_thenAmberAskingForAClick", () => {
    expect(mcpChip({ ...RUNNING, approvals: [APPROVAL] })).toEqual({
      tone: "waiting",
      label: "MCP · 1 waiting",
      tooltip: "An agent wants to change data. Click to answer.",
    });
  });

  it("givenReadsWaiting_whenChipped_thenTheTooltipSaysRead", () => {
    const read = { ...APPROVAL, id: "a2", kind: "read" as const };

    expect(mcpChip({ ...RUNNING, approvals: [read] }).tooltip).toBe("An agent wants to read data. Click to answer.");
    expect(mcpChip({ ...RUNNING, approvals: [read, APPROVAL] })).toMatchObject({
      label: "MCP · 2 waiting",
      tooltip: "2 agent requests want to read or change data. Click to answer.",
    });
  });

  it("givenPausedOrFailed_whenChipped_thenAmberOrRed", () => {
    expect(mcpChip({ ...RUNNING, paused: true })?.tone).toBe("waiting");
    expect(mcpStatusText({ ...RUNNING, paused: true })).toBe("Paused · no clients connected");
    expect(mcpChip({ ...RUNNING, state: "failed", message: "Port 47820 is in use." })).toEqual({
      tone: "failed",
      label: "MCP",
      tooltip: "Port 47820 is in use.",
    });
  });

  it("givenDeadline_whenCountedDown_thenMinutesAndSecondsNeverNegative", () => {
    expect(countdown(42_000, 0)).toBe("0:42");
    expect(countdown(60_000, 0)).toBe("1:00");
    expect(countdown(0, 5_000)).toBe("0:00");
  });
});

describe("MCP shared settings", () => {
  it("givenReadOnlyDatasource_whenAccessAsk_thenEffectiveAccessIsRead", () => {
    expect(effectiveAccess({ agentAccess: "ask", readOnly: true })).toBe("read");
    expect(effectiveAccess({ agentAccess: "ask", readOnly: false })).toBe("ask");
    expect(effectiveAccess({ readOnly: false })).toBe("off");
  });

  it("givenReadOnlyDatasource_whenAskReads_thenStaysAskReads", () => {
    expect(effectiveAccess({ agentAccess: "askReads", readOnly: true })).toBe("askReads");
    expect(effectiveAccess({ agentAccess: "askReads", readOnly: false })).toBe("askReads");
  });

  it("givenEachClient_whenConfigShown_thenPlaceholderUnlessTokenGiven", () => {
    expect(mcpClientConfig("claudeCode", 47_820)).toBe(
      'claude mcp add --transport http tablecraft http://127.0.0.1:47820/mcp --header "Authorization: Bearer ${TABLECRAFT_TOKEN}"',
    );
    expect(JSON.parse(mcpClientConfig("openCode", 48_000, "tc_abc"))).toEqual({
      mcp: {
        tablecraft: {
          type: "remote",
          url: "http://127.0.0.1:48000/mcp",
          headers: { Authorization: "Bearer tc_abc" },
        },
      },
    });
    expect(JSON.parse(mcpClientConfig("cursor", 47_820))).toEqual({
      mcpServers: {
        tablecraft: { url: "http://127.0.0.1:47820/mcp", headers: { Authorization: "Bearer ${TABLECRAFT_TOKEN}" } },
      },
    });
  });
});

function call(id: number, clientName: string, outcome: McpActivityView["outcome"]): McpActivityView {
  return {
    id,
    clientId: clientName,
    clientName,
    tool: "run_query",
    datasourceId: "shop",
    at: id,
    durationMs: 1,
    approvalWaitMs: 0,
    outcome,
    target: "SELECT 1",
    rowCount: 1,
    message: null,
  };
}

describe("MCP round 2 model", () => {
  it("givenPendingClient_whenChipped_thenAmberAndNamesIt", () => {
    const status = { ...RUNNING, pendingClients: [{ name: "Cursor", version: "1", since: 0, deadline: 60_000 }] };

    expect(mcpChip(status)).toMatchObject({ tone: "waiting", label: "MCP · Cursor asks" });
  });

  it("givenActivity_whenFiltered_thenClientAndOutcomeNarrow", () => {
    const entries = [call(3, "Cursor", "denied"), call(2, "Claude Code", "ok"), call(1, "Cursor", "ok")];

    expect(activityClients(entries)).toEqual(["Cursor", "Claude Code"]);
    expect(filteredActivity(entries, { client: "Cursor", outcome: null }).map((entry) => entry.id)).toEqual([3, 1]);
    expect(filteredActivity(entries, { client: null, outcome: "ok" }).map((entry) => entry.id)).toEqual([2, 1]);
  });

  it("givenElapsed_whenConnectedFor_thenMinutesAndHours", () => {
    expect(connectedFor(0, 30_000)).toBe("just now");
    expect(connectedFor(0, 12 * 60_000)).toBe("12 min");
    expect(connectedFor(0, 3 * 3_600_000)).toBe("3 h");
    expect(connectedFor(0, 3 * 3_600_000 + 5 * 60_000)).toBe("3 h 5 min");
  });

  it("givenRuns_whenGrouped_thenClientThenDatasource", () => {
    const run = {
      clientId: "s1",
      clientName: "Claude Code",
      tool: "run_query",
      sql: "SELECT 1",
      startedAt: 0,
      cancellable: true,
    };
    const status: McpStatus = {
      ...RUNNING,
      clients: [CLIENT, { ...CLIENT, id: "s2", name: "Cursor" }],
      running: [
        { ...run, id: "run-1", datasourceId: "shop" },
        { ...run, id: "run-2", datasourceId: "crm" },
        { ...run, id: "run-3", datasourceId: "shop" },
      ],
    };

    expect(agentGroups(status)).toEqual([
      {
        clientName: "Claude Code",
        connected: true,
        datasources: [
          { datasourceId: "shop", runs: [status.running[0], status.running[2]], calls: [] },
          { datasourceId: "crm", runs: [status.running[1]], calls: [] },
        ],
      },
      { clientName: "Cursor", connected: true, datasources: [] },
    ]);
  });

  it("givenFinishedCalls_whenGrouped_thenKeptUnderClientEvenAfterItLeaves", () => {
    const status: McpStatus = {
      ...RUNNING,
      clients: [],
      activity: [
        call(3, "opencode", "ok"),
        { ...call(2, "opencode", "ok"), tool: "list_datasources", datasourceId: null },
        call(1, "opencode", "denied"),
      ],
    };

    expect(agentGroups(status)).toEqual([
      {
        clientName: "opencode",
        connected: false,
        datasources: [{ datasourceId: "shop", runs: [], calls: [status.activity[0], status.activity[2]] }],
      },
    ]);
  });

  it("givenManyCalls_whenGrouped_thenOnlyTheNewestKept", () => {
    const activity = Array.from({ length: AGENT_CALLS_PER_DATASOURCE + 5 }, (_, index) =>
      call(AGENT_CALLS_PER_DATASOURCE + 5 - index, "opencode", "ok"),
    );

    const [group] = agentGroups({ ...RUNNING, activity });

    expect(group?.datasources[0]?.calls).toEqual(activity.slice(0, AGENT_CALLS_PER_DATASOURCE));
  });

  it("givenStatementCall_whenConsoleRequested_thenOnlySqlToolsOpenOne", () => {
    expect(activityConsoleRequest(call(1, "opencode", "ok"))).toEqual({ datasourceId: "shop", sql: "SELECT 1" });
    expect(activityConsoleRequest({ ...call(1, "opencode", "ok"), tool: "describe_table" })).toBeNull();
    expect(CALL_EXECUTION_OUTCOMES.refused).toBe("cancelled");
  });

  it("givenToken_whenHinted_thenOnlyTheLastFourShow", () => {
    expect(tokenHint("tc_abcdefgh3f9a")).toBe("tc_••••3f9a");
  });
});
