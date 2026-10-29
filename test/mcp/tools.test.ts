import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ASK_READS_REASON, READ_ONLY_REASON, TRANSACTION_REASON } from "@table-craft/desktop/mcp/access.js";
import { APPROVAL_REFUSALS } from "@table-craft/desktop/mcp/approvals.js";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import { createMcpServer } from "@table-craft/desktop/mcp/server.js";
import { TOOL_DEFINITIONS } from "@table-craft/desktop/mcp/tools.js";
import type { McpActivityView } from "@table-craft/desktop/settings/mcp.js";
import { agentCaller, agentHarness, textOf, waitingApproval, type AgentHarness } from "../support/mcpHarness.js";

const SHOP: AgentDatasource = { id: "shop", name: "Shop", pluginId: "sqlite", comment: null, access: "ask" };
const READ_ONLY_SHOP: AgentDatasource = { ...SHOP, access: "read" };
const ASK_READS_SHOP: AgentDatasource = { ...SHOP, access: "askReads" };
const SELECT_NAMES = "SELECT name FROM customers ORDER BY id";

function sessionModes(requests: readonly { readonly type: string }[]): boolean[] {
  return requests
    .filter((request) => request.type === "session.open")
    .map((request) => (request as unknown as { readonly readOnly: boolean }).readOnly);
}
const RENAME_CUSTOMER = "UPDATE customers SET name = 'Ada King' WHERE id = 1";

function customerName(path: string): string {
  const database = new DatabaseSync(path);
  try {
    return (database.prepare("SELECT name FROM customers WHERE id = 1").get() as { name: string }).name;
  } finally {
    database.close();
  }
}

describe("MCP tools", () => {
  it("givenToolDefinitions_whenListed_thenEveryToolHasAnObjectSchemaWithoutDialect", () => {
    expect(TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      "list_datasources",
      "list_schemas",
      "list_tables",
      "describe_table",
      "get_ddl",
      "run_query",
      "fetch_rows",
      "close_result",
      "explain",
      "format_sql",
      "check_sql",
      "scan_keys",
      "get_key",
      "open_in_console",
      "get_active_context",
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).not.toHaveProperty("$schema");
    }
    expect(TOOL_DEFINITIONS.find((tool) => tool.name === "run_query")?.annotations.readOnlyHint).toBe(false);
  });

  it("givenOneDatasourceOff_whenListingDatasources_thenOnlyExposedOnesAreNamed", async () => {
    const harness = agentHarness([SHOP, { ...SHOP, id: "hidden", name: "Hidden", access: "off" }]);

    const answer = await harness.tools.call("list_datasources", {}, agentCaller());

    expect(answer.outcome).toBe("ok");
    expect(answer.result.structuredContent).toEqual({
      datasources: [{ id: "shop", name: "Shop", plugin: "sqlite", access: "ask", comment: null }],
    });
  });

  it("givenDatasourceOff_whenQueried_thenRefusedWithoutConnecting", async () => {
    const harness = agentHarness([{ ...SHOP, access: "off" }]);

    const answer = await harness.tools.call("run_query", { datasource: "shop", sql: "SELECT 1" }, agentCaller());

    expect(answer.outcome).toBe("refused");
    expect(answer.result.isError).toBe(true);
    expect(textOf(answer.result)).toContain("No datasource");
  });

  it("givenSeededSqlite_whenExploringCatalog_thenSchemasTablesAndColumnsAreDescribed", async () => {
    const harness = agentHarness([SHOP]);

    const schemas = await harness.call("list_schemas", { datasource: "shop" });
    const tables = await harness.call("list_tables", { datasource: "shop", schema: "main" });
    const described = await harness.call("describe_table", { datasource: "shop", schema: "main", table: "orders" });
    const ddl = await harness.call("get_ddl", { datasource: "shop", schema: "main", table: "customers" });

    expect(textOf(schemas)).toContain("- main");
    expect(textOf(tables)).toContain("- customers (table, 3 columns)");
    expect(textOf(described)).toContain("customer_id INTEGER NOT NULL");
    expect(textOf(described)).toMatch(/FOREIGN KEY .*\(customer_id\) REFERENCES main\.customers \(id\)/);
    expect(textOf(ddl)).toContain("CREATE TABLE customers");
  });

  it("givenShownNamespacesWithoutMain_whenListingSchemas_thenMainIsHidden", async () => {
    const harness = agentHarness([{ ...SHOP, schemas: ["elsewhere"] }]);

    const tables = await harness.tools.call("list_tables", { datasource: "shop", schema: "main" }, agentCaller());

    expect(tables.result.isError).toBe(true);
    expect(textOf(tables.result)).toContain('No schema "main" is shown');
  });

  it("givenMoreRowsThanTheCap_whenQueried_thenPreviewIsCappedAndFetchRowsPages", async () => {
    const harness = agentHarness([SHOP]);
    harness.setRowCap(2);

    const first = await harness.call("run_query", { datasource: "shop", sql: "SELECT id FROM orders ORDER BY id" });
    const handle = first.structuredContent?.handle as string;
    const next = await harness.call("fetch_rows", { handle, offset: 2 });
    const closed = await harness.call("close_result", { handle });
    const gone = await harness.call("fetch_rows", { handle, offset: 0 });

    expect(first.structuredContent?.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(textOf(first)).toContain("Rows 1–2 of 3.");
    expect(textOf(first)).toContain(`fetch_rows with handle "${handle}" and offset 2`);
    expect(next.structuredContent?.rows).toEqual([{ id: 3 }]);
    expect(textOf(closed)).toBe(`Closed ${handle}.`);
    expect(gone.isError).toBe(true);
    expect(harness.history).toMatchObject([
      { datasourceId: "shop", sql: "SELECT id FROM orders ORDER BY id", outcome: "success", rowCount: 3 },
    ]);
  });

  it("givenRowsWithinTheCap_whenQueried_thenNoHandleIsKept", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("run_query", { datasource: "shop", sql: "SELECT name FROM customers" });

    expect(answer.structuredContent).toMatchObject({ handle: null, rowCount: 2, complete: true });
    expect(textOf(answer)).toContain("| Ada Lovelace |");
  });

  it("givenTwoStatements_whenQueried_thenRefusedBeforeRunning", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("run_query", { datasource: "shop", sql: "SELECT 1; SELECT 2" });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("this text holds 2");
  });

  it("givenReadAccess_whenWriting_thenRefusedAndRecordedCancelled", async () => {
    const harness = agentHarness([READ_ONLY_SHOP]);

    const answer = await harness.tools.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }, agentCaller());

    expect(answer.outcome).toBe("refused");
    expect(textOf(answer.result)).toBe(READ_ONLY_REASON);
    expect(customerName(harness.path)).toBe("Ada Lovelace");
    expect(harness.history).toMatchObject([{ outcome: "cancelled", message: READ_ONLY_REASON }]);
  });

  it("givenTransactionStatement_whenQueried_thenRefused", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("run_query", { datasource: "shop", sql: "BEGIN" });

    expect(textOf(answer)).toBe(TRANSACTION_REASON);
  });

  it("givenAskAccess_whenUserAllowsOnce_thenWriteRunsAndTheNextOneAsksAgain", async () => {
    const harness = agentHarness([SHOP]);

    const running = harness.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER, reason: "Fix the name" });
    const approvalId = await waitingApproval(harness.approvals);
    const [view] = harness.approvals.pending();
    harness.approvals.answer(approvalId, "allowOnce");
    const answer = await running;

    expect(view).toMatchObject({ kind: "write", reason: "Fix the name", datasourceName: "Shop", allowable: true });
    expect(textOf(answer)).toBe("1 row affected.");
    expect(customerName(harness.path)).toBe("Ada King");
    const again = harness.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER });
    harness.approvals.answer(await waitingApproval(harness.approvals), "deny");
    expect(textOf(await again)).toBe(APPROVAL_REFUSALS.denied);
  });

  it("givenAllowKind_whenTheSameKindRunsAgain_thenItDoesNotAsk", async () => {
    const harness = agentHarness([SHOP]);

    const first = harness.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER });
    harness.approvals.answer(await waitingApproval(harness.approvals), "allowKind");
    await first;
    const second = await harness.call("run_query", {
      datasource: "shop",
      sql: "UPDATE customers SET name = 'Grace B. Hopper' WHERE id = 2",
    });

    expect(textOf(second)).toBe("1 row affected.");
    expect(harness.approvals.pending()).toEqual([]);
  });

  it("givenUserDenies_whenWriting_thenNothingChangesAndHistorySaysCancelled", async () => {
    const harness = agentHarness([SHOP]);

    const running = harness.tools.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }, agentCaller());
    harness.approvals.answer(await waitingApproval(harness.approvals), "deny");
    const answer = await running;

    expect(answer.outcome).toBe("denied");
    expect(customerName(harness.path)).toBe("Ada Lovelace");
    expect(harness.history).toMatchObject([{ outcome: "cancelled", message: APPROVAL_REFUSALS.denied }]);
  });

  it("givenDdl_whenAsked_thenTheKindCannotBeAllowedForTheSession", async () => {
    const harness = agentHarness([SHOP]);

    const running = harness.call("run_query", { datasource: "shop", sql: "DROP TABLE no_key_probe" });
    const approvalId = await waitingApproval(harness.approvals);
    const [view] = harness.approvals.pending();
    harness.approvals.answer(approvalId, "deny");
    await running;

    expect(view).toMatchObject({ kind: "ddl", allowable: false });
  });

  it("givenNoWindowOpen_whenWriting_thenDeniedAtOnce", async () => {
    const harness = agentHarness([SHOP]);
    harness.approvals.setWindows(false);

    const answer = await harness.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER });

    expect(textOf(answer)).toBe(APPROVAL_REFUSALS.noWindow);
  });

  it("givenReadOnlyDatasource_whenClassifierIsFooled_thenTheReadOnlySessionStillRefuses", async () => {
    const harness = agentHarness([SHOP], { readOnly: true });

    const running = harness.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER });
    harness.approvals.answer(await waitingApproval(harness.approvals), "allowOnce");
    const answer = await running;

    expect(answer.isError).toBe(true);
    expect(customerName(harness.path)).toBe("Ada Lovelace");
  });

  it("givenAskReads_whenSelectAllowedOnce_thenRunsOnReadSessionAndNextAsks", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);

    const running = harness.call("run_query", { datasource: "shop", sql: SELECT_NAMES, reason: "Check the names" });
    const approvalId = await waitingApproval(harness.approvals);
    const [view] = harness.approvals.pending();
    harness.approvals.answer(approvalId, "allowOnce");
    const answer = await running;

    expect(view).toMatchObject({
      kind: "read",
      subject: "statement",
      sql: SELECT_NAMES,
      reason: "Check the names",
      allowable: true,
      destructive: null,
    });
    expect(textOf(answer)).toContain("| Ada Lovelace |");
    expect(sessionModes(harness.requests)).toEqual([true]);
    const again = harness.call("run_query", { datasource: "shop", sql: SELECT_NAMES });
    harness.approvals.answer(await waitingApproval(harness.approvals), "deny");
    expect(textOf(await again)).toBe(APPROVAL_REFUSALS.denied);
  });

  it("givenAskReads_whenSelectDenied_thenRefusedAndRecordedCancelled", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);

    const running = harness.tools.call("run_query", { datasource: "shop", sql: SELECT_NAMES }, agentCaller());
    harness.approvals.answer(await waitingApproval(harness.approvals), "deny");
    const answer = await running;

    expect(answer.outcome).toBe("denied");
    expect(textOf(answer.result)).toBe(APPROVAL_REFUSALS.denied);
    expect(harness.requests.map((request) => request.type)).not.toContain("statement.execute");
    expect(harness.history).toMatchObject([
      { sql: SELECT_NAMES, outcome: "cancelled", message: APPROVAL_REFUSALS.denied },
    ]);
  });

  it("givenAskReads_whenUpdate_thenRefusedWithoutAsking", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);

    const answer = await harness.tools.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }, agentCaller());

    expect(answer.outcome).toBe("refused");
    expect(textOf(answer.result)).toBe(ASK_READS_REASON);
    expect(harness.approvals.pending()).toEqual([]);
    expect(customerName(harness.path)).toBe("Ada Lovelace");
    expect(harness.history).toMatchObject([{ outcome: "cancelled", message: ASK_READS_REASON }]);
  });

  it("givenAskReads_whenListTablesDescribeExplain_thenNoApproval", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);

    const datasources = await harness.call("list_datasources", {});
    const tables = await harness.call("list_tables", { datasource: "shop", schema: "main" });
    const described = await harness.call("describe_table", { datasource: "shop", schema: "main", table: "orders" });
    const ddl = await harness.call("get_ddl", { datasource: "shop", schema: "main", table: "customers" });
    const plan = await harness.call("explain", { datasource: "shop", sql: "SELECT * FROM orders WHERE id = 1" });

    expect(datasources.structuredContent).toMatchObject({ datasources: [{ id: "shop", access: "askReads" }] });
    expect(textOf(datasources)).toContain("Ask before reads");
    expect(textOf(tables)).toContain("- customers (table, 3 columns)");
    expect(textOf(described)).toContain("customer_id INTEGER NOT NULL");
    expect(textOf(ddl)).toContain("CREATE TABLE customers");
    expect(textOf(plan)).toContain("Raw:");
    expect(harness.approvals.pending()).toEqual([]);
    expect(harness.requests.map((request) => request.type)).not.toContain("statement.execute");
  });

  it("givenAskReadsReadGranted_whenFetchRows_thenNotAsked", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);
    harness.setRowCap(2);

    const first = harness.call("run_query", { datasource: "shop", sql: "SELECT id FROM orders ORDER BY id" });
    harness.approvals.answer(await waitingApproval(harness.approvals), "allowOnce");
    const handle = (await first).structuredContent?.handle as string;
    const next = await harness.call("fetch_rows", { handle, offset: 2 });

    expect(next.structuredContent?.rows).toEqual([{ id: 3 }]);
    expect(harness.approvals.pending()).toEqual([]);
  });

  it("givenAskReadsAllowKind_whenSelectAgain_thenNotAsked", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);

    const first = harness.call("run_query", { datasource: "shop", sql: SELECT_NAMES });
    harness.approvals.answer(await waitingApproval(harness.approvals), "allowKind");
    await first;
    const second = await harness.call("run_query", { datasource: "shop", sql: "SELECT id FROM orders" });

    expect(second.isError).toBeUndefined();
    expect(harness.approvals.pending()).toEqual([]);
  });

  it("givenAskReads_whenNoWindow_thenReadDenied", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);
    harness.approvals.setWindows(false);

    const answer = await harness.tools.call("run_query", { datasource: "shop", sql: SELECT_NAMES }, agentCaller());

    expect(answer.outcome).toBe("denied");
    expect(textOf(answer.result)).toBe(APPROVAL_REFUSALS.noWindow);
  });

  it("givenSelect_whenExplainedAndFormatted_thenPlanAndUppercaseSqlComeBack", async () => {
    const harness = agentHarness([SHOP]);

    const plan = await harness.call("explain", { datasource: "shop", sql: "SELECT * FROM orders WHERE id = 1" });
    const formatted = await harness.call("format_sql", { datasource: "shop", sql: "select id from orders" });

    expect(plan.isError).toBeUndefined();
    expect(textOf(plan)).toContain("Raw:");
    expect(textOf(formatted)).toContain("SELECT");
  });

  it("givenUnknownArgument_whenCalled_thenInvalidArgumentsError", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("list_schemas", { datasource: "shop", extra: true });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("Invalid arguments");
  });
});

const USER_THINKS_MS = 20_000;
const WORKING_TIME_BOUND_MS = 1_000;

/** The MCP server over the harness's tools, so a test reads what Services and Agent Activity get. */
function served(harness: AgentHarness) {
  const calls: Omit<McpActivityView, "id">[] = [];
  const server = createMcpServer({
    tools: harness.tools,
    resources: { list: () => ({ resources: [] }), read: () => Promise.resolve({}) },
    admit: () => Promise.resolve(null),
    onCall: (entry) => calls.push(entry),
    serverVersion: "1.0.0",
    paused: () => false,
    now: harness.context.now,
    newSessionId: () => "mcp-1",
    onChange: () => undefined,
    onEnded: () => undefined,
  });
  let id = 0;
  const rpc = (sessionId: string | null, method: string, params: unknown) =>
    server.handle(sessionId, JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method, params }));
  const session = rpc(null, "initialize", { clientInfo: { name: "Claude Code" } }).then(
    (reply) => reply.sessionId ?? "",
  );
  return {
    calls,
    call: async (name: string, args: unknown) => rpc(await session, "tools/call", { name, arguments: args }),
  };
}

/** Starts a call, lets the user take USER_THINKS_MS to give `answer`, and waits for it to end. */
async function answeredLate(
  harness: AgentHarness,
  running: Promise<unknown>,
  answer: Parameters<AgentHarness["approvals"]["answer"]>[1],
): Promise<void> {
  const approvalId = await waitingApproval(harness.approvals);
  harness.advance(USER_THINKS_MS);
  harness.approvals.answer(approvalId, answer);
  await running;
}

describe("MCP tools, the wait for approval", () => {
  it("givenAskBeforeWrites_whenUserAllowsAfter20s_thenCallTimeLeavesOutTheWait", async () => {
    const harness = agentHarness([SHOP]);
    const server = served(harness);

    await answeredLate(harness, server.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }), "allowOnce");

    const [call] = server.calls;
    expect(call?.outcome).toBe("ok");
    expect(call?.approvalWaitMs).toBeGreaterThanOrEqual(USER_THINKS_MS);
    expect(call?.durationMs).toBeLessThan(WORKING_TIME_BOUND_MS);
  });

  it("givenAskBeforeReads_whenUserAllowsAfter20s_thenHistoryDurationLeavesOutTheWait", async () => {
    const harness = agentHarness([ASK_READS_SHOP]);
    const server = served(harness);

    await answeredLate(harness, server.call("run_query", { datasource: "shop", sql: SELECT_NAMES }), "allowOnce");

    expect(harness.history).toMatchObject([{ sql: SELECT_NAMES, outcome: "success" }]);
    expect(harness.history[0]?.durationMs).toBeLessThan(WORKING_TIME_BOUND_MS);
    expect(harness.history[0]?.startedAt).toBeLessThan(USER_THINKS_MS);
  });

  it("givenAllowedForSession_whenSecondWrite_thenApprovalWaitIsZero", async () => {
    const harness = agentHarness([SHOP]);
    const server = served(harness);

    await answeredLate(harness, server.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }), "allowKind");
    await server.call("run_query", { datasource: "shop", sql: "UPDATE customers SET name = 'Grace' WHERE id = 2" });

    expect(server.calls.map((call) => call.outcome)).toEqual(["ok", "ok"]);
    expect(server.calls[0]?.approvalWaitMs).toBeGreaterThanOrEqual(USER_THINKS_MS);
    expect(server.calls[1]?.approvalWaitMs).toBe(0);
  });

  it("givenApprovalDenied_whenCallEnds_thenWaitIsReportedAndDurationNearZero", async () => {
    const harness = agentHarness([SHOP]);
    const server = served(harness);

    await answeredLate(harness, server.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }), "deny");

    const [call] = server.calls;
    expect(call?.outcome).toBe("denied");
    expect(call?.approvalWaitMs).toBeGreaterThanOrEqual(USER_THINKS_MS);
    expect(call?.durationMs).toBeLessThan(WORKING_TIME_BOUND_MS);
    expect(harness.history[0]?.durationMs).toBeLessThan(WORKING_TIME_BOUND_MS);
  });

  it("givenReadAccess_whenQueryRuns_thenApprovalWaitIsZero", async () => {
    const harness = agentHarness([READ_ONLY_SHOP]);
    const server = served(harness);

    await server.call("run_query", { datasource: "shop", sql: SELECT_NAMES });

    expect(server.calls).toMatchObject([{ outcome: "ok", approvalWaitMs: 0 }]);
  });
});
