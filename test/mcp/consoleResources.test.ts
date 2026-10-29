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
import { lineColumn } from "@table-craft/desktop/mcp/consoleTools.js";
import { agentHarness, textOf } from "../support/mcpHarness.js";

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

  it("givenWindowOpen_whenOpenInConsole_thenTextHandedOverAndNothingRuns", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_in_console", { datasource: "shop", sql: "DELETE FROM customers" });

    expect(textOf(answer)).toContain("The user reviews and runs it.");
    expect(harness.opened).toEqual([{ datasourceId: "shop", sql: "DELETE FROM customers" }]);
    expect(harness.history).toEqual([]);
  });

  it("givenNoWindow_whenOpenInConsole_thenRefused", async () => {
    const harness = agentHarness([SHOP]);
    harness.setWindows(false);

    const answer = await harness.tools.call(
      "open_in_console",
      { datasource: "shop", sql: "SELECT 1" },
      { sessionId: "mcp-1", clientName: "Claude Code" },
    );

    expect(answer.outcome).toBe("refused");
    expect(answer.result.isError).toBe(true);
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
