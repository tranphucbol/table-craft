import { describe, expect, it } from "vitest";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import { agentHarness, textOf } from "../support/mcpHarness.js";

const SHOP: AgentDatasource = { id: "shop", name: "Shop", pluginId: "sqlite", comment: null, access: "read" };

describe("MCP window tools", () => {
  it("givenReadAccess_whenOpenTableWithWhere_thenApplied", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_table", {
      datasource: "shop",
      schema: "main",
      table: "orders",
      where: "customer_id = 1",
      orderBy: "id DESC",
    });

    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toMatchObject({ applied: true, focused: false });
    expect(harness.window.requests[0]).toMatchObject({
      target: "focused",
      request: {
        kind: "openTable",
        path: ["main"],
        table: "orders",
        where: "customer_id = 1",
        orderBy: "id DESC",
        draftOnly: false,
      },
    });
    expect(harness.history).toEqual([]);
  });

  it("givenAskReads_whenOpenTableWithWhere_thenDraftedOnly", async () => {
    const harness = agentHarness([{ ...SHOP, access: "askReads" }]);

    const answer = await harness.call("open_table", {
      datasource: "shop",
      schema: "main",
      table: "orders",
      where: "customer_id = 1",
    });

    expect(answer.structuredContent).toMatchObject({ applied: false });
    expect(textOf(answer)).toContain("the user applies it");
    expect(harness.window.requests[0]?.request).toMatchObject({ draftOnly: true });
  });

  it("givenSecondStatementInWhere_whenOpenTable_thenRefused", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_table", {
      datasource: "shop",
      schema: "main",
      table: "orders",
      where: "1=1; DELETE FROM orders",
    });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("The filter must form one read");
    expect(harness.window.requests).toEqual([]);
  });

  it("givenOffDatasource_whenOpenTable_thenRefused", async () => {
    const harness = agentHarness([{ ...SHOP, access: "off" }]);

    const answer = await harness.call("open_table", { datasource: "shop", schema: "main", table: "orders" });

    expect(answer.isError).toBe(true);
    expect(harness.window.requests).toEqual([]);
  });

  it("givenKnownColumn_whenReveal_thenWindowAskedToSelectIt", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("reveal_in_explorer", {
      datasource: "shop",
      schema: "main",
      table: "customers",
      column: "name",
    });

    expect(answer.structuredContent).toEqual({ found: true, focused: false });
    expect(harness.window.requests[0]?.request).toMatchObject({
      kind: "reveal",
      path: ["main"],
      relation: { name: "customers", kind: "table" },
      column: "name",
    });
  });

  it("givenUnknownTable_whenReveal_thenFoundFalse", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("reveal_in_explorer", { datasource: "shop", schema: "main", table: "nope" });

    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toEqual({ found: false });
    expect(harness.window.requests).toEqual([]);
  });
});
