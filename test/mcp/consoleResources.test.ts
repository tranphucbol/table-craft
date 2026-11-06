import { describe, expect, it } from "vitest";
import { RpcError } from "@table-craft/desktop/mcp/jsonrpc.js";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import {
  getPrompt,
  listPrompts,
  listResources,
  parseResourceUri,
  readResource,
  RESOURCE_NOT_FOUND,
  resourceUri,
} from "@table-craft/desktop/mcp/resources.js";
import { lineColumn, releaseConsoles } from "@table-craft/desktop/mcp/consoleTools.js";
import { FAKE_WINDOW_ID } from "../support/fakeWindow.js";
import { agentCaller, agentHarness, textOf } from "../support/mcpHarness.js";

const SHOP: AgentDatasource = { id: "shop", name: "Shop", pluginId: "sqlite", comment: null, access: "read" };
const HIDDEN: AgentDatasource = { ...SHOP, id: "hidden", name: "Hidden", access: "off" };
const CONSOLE_SQL = "SELECT 1;\nSELECT name FROM customers";

function contentText(answer: unknown): string {
  return (answer as { contents: { text: string }[] }).contents.map((content) => content.text).join("\n");
}

describe("MCP console tools", () => {
  it("givenOffsetOnSecondLine_whenLocated_thenOneBasedLineAndColumn", () => {
    expect(lineColumn(CONSOLE_SQL, 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn(CONSOLE_SQL, CONSOLE_SQL.indexOf("name"))).toEqual({ line: 2, column: 8 });
  });

  it("givenDeleteWithoutWhere_whenChecked_thenProblemCarriesLineAndColumn", async () => {
    const harness = agentHarness([SHOP]);

    const clean = await harness.call("check_sql", { datasource: "shop", sql: "SELECT name FROM customers" });
    const flagged = await harness.call("check_sql", { datasource: "shop", sql: "SELECT 1;\nDELETE FROM customers" });

    expect(textOf(clean)).toBe("No problems found.");
    expect(flagged.isError).not.toBe(true);
    expect(textOf(flagged)).toMatch(/^- 2:1 warning: .*\(SqlWithoutWhere\)$/);
  });

  it("givenWindowOpen_whenOpenInConsole_thenAnswersHandleAndRevision", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_in_console", { datasource: "shop", sql: "DELETE FROM customers" });

    expect(textOf(answer)).toContain("The user reviews and runs it");
    expect(answer.structuredContent).toEqual({
      console: "c1",
      title: "console",
      datasource: "shop",
      schema: null,
      revision: 0,
      focused: false,
    });
    expect(harness.window.requests[0]).toMatchObject({
      target: "focused",
      request: { kind: "open", handle: "c1", client: "Claude Code", sql: "DELETE FROM customers", focus: false },
    });
    expect(harness.history).toEqual([]);
  });

  it("givenSchemaTitleAndFocus_whenOpenInConsole_thenAllReachTheWindow", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_in_console", {
      datasource: "shop",
      sql: "SELECT 1",
      schema: "main",
      title: "orders",
      focus: true,
    });

    expect(answer.structuredContent).toMatchObject({ title: "orders", schema: "main", focused: true });
    expect(textOf(answer)).toContain("The console works in main.");
  });

  it("givenUnknownSchemaAndFocusOff_whenOpenInConsole_thenOpensAndSaysSo", async () => {
    const harness = agentHarness([SHOP]);
    harness.setAllowFocus(false);

    const answer = await harness.call("open_in_console", {
      datasource: "shop",
      sql: "SELECT 1",
      schema: "nope",
      focus: true,
    });

    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toMatchObject({ schema: null, focused: false });
    expect(textOf(answer)).toContain("Schema nope was not found");
    expect(textOf(answer)).toContain("does not let agents bring TableCraft forward");
    expect(harness.window.requests[0]?.request).toMatchObject({ focus: false });
  });

  it("givenNoWindow_whenOpenInConsole_thenRefused", async () => {
    const harness = agentHarness([SHOP]);
    harness.setWindows(false);

    const answer = await harness.tools.call("open_in_console", { datasource: "shop", sql: "SELECT 1" }, agentCaller());

    expect(answer.outcome).toBe("refused");
    expect(answer.result.isError).toBe(true);
  });

  it("givenSilentWindow_whenOpenInConsole_thenRefusedAfterTimeout", async () => {
    const harness = agentHarness([SHOP]);
    harness.window.silent = true;

    const answer = await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1" });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("did not answer");
    expect(harness.owners.ofSession("mcp-1")).toEqual([]);
  });

  it("givenOwnConsole_whenEditConsole_thenApplied", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT id FROM orders" });

    const answer = await harness.call("edit_console", {
      console: "c1",
      edits: [{ oldText: "id", newText: "id, total" }],
    });

    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toMatchObject({ console: "c1", revision: 1 });
    expect(harness.window.view("c1")?.sql).toBe("SELECT id, total FROM orders");
    expect(harness.window.requests[1]?.target).toEqual({ window: FAKE_WINDOW_ID });
  });

  it("givenOtherSessionsConsole_whenEditConsole_thenRefusedAsUnknown", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1" });

    const answer = await harness.call(
      "edit_console",
      { console: "c1", text: "DROP TABLE orders", revision: 0 },
      agentCaller("mcp-2"),
    );

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("No console c1 of yours is open");
    expect(harness.window.view("c1")?.sql).toBe("SELECT 1");
  });

  it("givenUserTyped_whenWholeReplaceWithOldRevision_thenRefusedStale", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1" });
    harness.window.typeAsUser("c1", "SELECT 2");

    const answer = await harness.call("edit_console", { console: "c1", text: "SELECT 3", revision: 0 });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("The user changed the console since that revision");
    expect(harness.window.view("c1")?.sql).toBe("SELECT 2");
  });

  it("givenUserTyped_whenFindReplaceStillMatches_thenApplied", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT id FROM orders" });
    harness.window.typeAsUser("c1", "SELECT id FROM orders WHERE total > 5");

    const answer = await harness.call("edit_console", { console: "c1", edits: [{ oldText: "id", newText: "*" }] });

    expect(answer.isError).not.toBe(true);
    expect(harness.window.view("c1")?.sql).toBe("SELECT * FROM orders WHERE total > 5");
    expect(answer.structuredContent).toMatchObject({ revision: 2 });
  });

  it("givenEditMatchingTwice_whenEditConsole_thenRefusedWithCount", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "a = 1 OR a = 1" });

    const answer = await harness.call("edit_console", { console: "c1", edits: [{ oldText: "a = 1", newText: "b" }] });

    expect(textOf(answer)).toContain("Edit 1: oldText matches 2 times");
  });

  it("givenClosedTab_whenEditConsole_thenRefusedAndHandleDropped", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1" });
    harness.window.closeTab("c1");

    const answer = await harness.call("edit_console", { console: "c1", edits: [{ oldText: "1", newText: "2" }] });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("No console c1 of yours is open");
    expect(harness.owners.ofSession("mcp-1")).toEqual([]);
  });

  it("givenDatasourceTurnedOff_whenReadConsole_thenRefused", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1" });
    harness.setDatasources([{ ...SHOP, access: "off" }]);

    const answer = await harness.call("read_console", { console: "c1" });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).not.toContain("SELECT 1");
  });

  it("givenOwnConsole_whenReadConsole_thenTextSelectionAndRevision", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1", title: "probe" });

    const answer = await harness.call("read_console", { console: "c1" });

    expect(answer.structuredContent).toEqual({
      console: "c1",
      title: "probe",
      datasource: "shop",
      schema: null,
      revision: 0,
      sql: "SELECT 1",
      selection: { from: 8, to: 8, text: "" },
    });
  });

  it("givenTwoSessions_whenListConsoles_thenEachSeesOnlyItsOwn", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1" });
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 2" }, agentCaller("mcp-2"));

    const first = await harness.call("list_consoles", {});
    const second = await harness.call("list_consoles", {}, agentCaller("mcp-2"));

    expect(first.structuredContent).toMatchObject({ consoles: [{ console: "c1" }] });
    expect(second.structuredContent).toMatchObject({ consoles: [{ console: "c2", active: true }] });
  });

  it("givenSessionEnds_whenReleased_thenWindowToldToClearMarker", async () => {
    const harness = agentHarness([SHOP]);
    await harness.call("open_in_console", { datasource: "shop", sql: "SELECT 1" });

    releaseConsoles(harness.context, harness.owners.endSession("mcp-1"));

    expect(harness.window.requests.at(-1)).toEqual({
      target: { window: FAKE_WINDOW_ID },
      request: { kind: "release", handles: ["c1"] },
    });
    expect(harness.owners.ofSession("mcp-1")).toEqual([]);
  });

  it("givenFocusedConsoleOnExposedDatasource_whenContextAsked_thenSelectionAndTextShared", async () => {
    const harness = agentHarness([SHOP]);
    const from = CONSOLE_SQL.indexOf("SELECT name");
    harness.setActiveConsole({
      datasourceId: "shop",
      sql: CONSOLE_SQL,
      selectionFrom: from,
      selectionTo: CONSOLE_SQL.length,
      namespace: ["main"],
    });

    const answer = await harness.call("get_active_context", {});

    expect(answer.structuredContent).toEqual({
      datasource: "shop",
      schema: "main",
      sql: CONSOLE_SQL,
      selection: { from, to: CONSOLE_SQL.length, text: "SELECT name FROM customers" },
    });
  });

  it("givenFocusedConsoleOnHiddenDatasource_whenContextAsked_thenRefusedWithoutItsText", async () => {
    const harness = agentHarness([SHOP, HIDDEN]);
    harness.setActiveConsole({
      datasourceId: "hidden",
      sql: "SELECT secret FROM vault",
      selectionFrom: 0,
      selectionTo: 0,
      namespace: null,
    });

    const answer = await harness.call("get_active_context", {});

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).not.toContain("secret");
  });

  it("givenSqlDatasource_whenScanningKeys_thenRefusedAsNotKeyValue", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("scan_keys", { datasource: "shop" });

    expect(answer.isError).toBe(true);
  });
});

describe("MCP resources and prompts", () => {
  it("givenSegmentsWithSlash_whenUriBuiltAndParsed_thenRoundTrip", () => {
    const uri = resourceUri("shop", "main", "odd/name");
    expect(uri).toBe("tablecraft://shop/main/odd%2Fname");
    expect(parseResourceUri(uri)).toEqual(["shop", "main", "odd/name"]);
    expect(parseResourceUri("https://shop")).toBeNull();
    expect(parseResourceUri("tablecraft://a/b/c/d")).toBeNull();
  });

  it("givenOneDatasourceOff_whenResourcesListed_thenOnlyExposedOnes", () => {
    const harness = agentHarness([SHOP, HIDDEN]);

    expect(listResources(harness.context)).toEqual({
      resources: [
        {
          uri: "tablecraft://shop",
          name: "shop",
          title: "Shop",
          description: "The schemas of Shop (sqlite, Read only).",
          mimeType: "text/plain",
        },
      ],
    });
  });

  it("givenTableUri_whenRead_thenItsColumnsDescribed", async () => {
    const harness = agentHarness([SHOP]);

    const schemas = contentText(await readResource(harness.context, resourceUri("shop")));
    const tables = contentText(await readResource(harness.context, resourceUri("shop", "main")));
    const table = contentText(await readResource(harness.context, resourceUri("shop", "main", "customers")));

    expect(schemas).toContain("main");
    expect(tables).toContain("customers");
    expect(table).toContain("name");
  });

  it("givenHiddenDatasourceUri_whenRead_thenResourceNotFound", async () => {
    const harness = agentHarness([SHOP, HIDDEN]);

    const read = readResource(harness.context, resourceUri("hidden"));

    await expect(read).rejects.toBeInstanceOf(RpcError);
    await expect(read).rejects.toMatchObject({ code: RESOURCE_NOT_FOUND });
  });

  it("givenPrompts_whenListedAndFilled_thenArgumentsReachTheText", () => {
    const listed = listPrompts() as { prompts: { name: string }[] };
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(["explore_datasource", "write_query"]);

    const prompt = getPrompt("write_query", { datasource: "shop", question: "Who ordered most?" }) as {
      messages: { content: { text: string } }[];
    };
    expect(prompt.messages[0]?.content.text).toContain("Who ordered most?");
    expect(() => getPrompt("write_query", { datasource: "shop" })).toThrow(RpcError);
    expect(() => getPrompt("nope", {})).toThrow(RpcError);
  });
});
