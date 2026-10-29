import { describe, expect, it } from "vitest";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import { agentHarness } from "../support/mcpHarness.js";

const SHOP: AgentDatasource = { id: "shop", name: "Shop", pluginId: "sqlite", comment: null, access: "read" };
const QUERY = { datasource: "shop", sql: "SELECT name FROM customers" };

function sentOf(harness: ReturnType<typeof agentHarness>, type: string) {
  return harness.requests.filter((request) => request.type === type);
}

describe("agent statement timeout", () => {
  it("givenDatasourceOverride_whenRunQuery_thenItsTimeoutSent", async () => {
    const harness = agentHarness([{ ...SHOP, timeoutSeconds: 15 }]);
    harness.setTimeoutSeconds(90);

    await harness.call("run_query", QUERY);

    expect(sentOf(harness, "statement.execute")).toMatchObject([{ timeoutSeconds: 15 }]);
  });

  it("givenNoOverride_whenRunQuery_thenSettingSent", async () => {
    const harness = agentHarness([SHOP]);
    harness.setTimeoutSeconds(90);

    await harness.call("run_query", QUERY);
    await harness.call("explain", QUERY);

    expect(sentOf(harness, "statement.execute")).toMatchObject([{ timeoutSeconds: 90 }]);
    expect(sentOf(harness, "statement.explain")).toMatchObject([{ timeoutSeconds: 90 }]);
  });

  it("givenRunQuery_whenSent_thenServerEnforced", async () => {
    const harness = agentHarness([SHOP]);

    await harness.call("run_query", QUERY);
    await harness.call("explain", QUERY);

    expect(sentOf(harness, "statement.execute")).toMatchObject([{ serverEnforced: true }]);
    expect(sentOf(harness, "statement.explain")).toMatchObject([{ serverEnforced: true }]);
  });
});
