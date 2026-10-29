import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { READ_ONLY_REASON, TRANSACTION_REASON } from "@table-craft/desktop/mcp/access.js";
import { APPROVAL_REFUSALS } from "@table-craft/desktop/mcp/approvals.js";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import { TOOL_DEFINITIONS } from "@table-craft/desktop/mcp/tools.js";
import { AGENT_CALLER, agentHarness, textOf, waitingApproval } from "../support/mcpHarness.js";

const SHOP: AgentDatasource = { id: "shop", name: "Shop", pluginId: "sqlite", comment: null, access: "ask" };
const READ_ONLY_SHOP: AgentDatasource = { ...SHOP, access: "read" };
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

    const answer = await harness.tools.call("list_datasources", {}, AGENT_CALLER);

    expect(answer.outcome).toBe("ok");
    expect(answer.result.structuredContent).toEqual({
      datasources: [{ id: "shop", name: "Shop", plugin: "sqlite", access: "ask", comment: null }],
    });
  });

  it("givenDatasourceOff_whenQueried_thenRefusedWithoutConnecting", async () => {
    const harness = agentHarness([{ ...SHOP, access: "off" }]);

    const answer = await harness.tools.call("run_query", { datasource: "shop", sql: "SELECT 1" }, AGENT_CALLER);

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

    const tables = await harness.tools.call("list_tables", { datasource: "shop", schema: "main" }, AGENT_CALLER);

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

    const answer = await harness.tools.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }, AGENT_CALLER);

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

    const running = harness.tools.call("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }, AGENT_CALLER);
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
