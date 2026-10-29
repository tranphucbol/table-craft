import { describe, expect, it } from "vitest";
import { createRuns } from "@table-craft/desktop/mcp/activity.js";
import { APPROVAL_REFUSALS, createApprovals } from "@table-craft/desktop/mcp/approvals.js";
import type { AgentEngine, AgentEngines, SessionMode } from "@table-craft/desktop/mcp/engines.js";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import { createTools } from "@table-craft/desktop/mcp/tools.js";
import type { ToolContext } from "@table-craft/desktop/mcp/toolKit.js";
import { agentCaller, textOf, waitingApproval } from "../support/mcpHarness.js";

const CACHE: AgentDatasource = { id: "cache", name: "Cache", pluginId: "redis", comment: null, access: "askReads" };
const KEY = "user:1";
const CURRENT_DATABASE = 3;
const USER_THINKS_MS = 20_000;

const DETAILS = { key: { text: KEY, hex: null }, type: "string", typeName: "string", ttlMs: null, length: 3 };

/** A Redis engine that answers the keyspace calls the key tools make, recording each session mode. */
function keyEngine() {
  const modes: SessionMode[] = [];
  const calls: string[] = [];
  const answers: Readonly<Record<string, unknown>> = {
    "keyspace.databases": { databases: [{ index: CURRENT_DATABASE, current: true }] },
    "keyspace.scan": { keys: [{ text: KEY, hex: null }], cursor: null },
    "keyspace.describe": [DETAILS],
    "keyspace.open": { details: DETAILS, statement: null, value: "Ada" },
    "session.open": { sessionId: "s-1" },
  };
  const engine: AgentEngine = {
    call: ((type: string) => {
      calls.push(type);
      return Promise.resolve(answers[type]);
    }) as AgentEngine["call"],
    capabilities: () => Promise.resolve(["keyValue"]),
    withSession: (mode, use) => {
      modes.push(mode);
      return use("s-1");
    },
    cancel: () => Promise.resolve(),
  };
  return { engine, modes, calls };
}

function keyHarness(datasource: AgentDatasource = CACHE) {
  const fake = keyEngine();
  const approvals = createApprovals({ onChange: () => undefined, now: () => 0 });
  approvals.setWindows(true);
  const engines: AgentEngines = {
    engine: () => Promise.resolve(fake.engine),
    drop: () => undefined,
    closeAll: () => undefined,
  };
  let clock = 0;
  const context: ToolContext = {
    datasources: () => [datasource],
    engines,
    approvals,
    record: () => undefined,
    rowCap: () => 100,
    timeoutSeconds: () => 120,
    now: () => (clock += 1),
    runs: createRuns(
      () => undefined,
      () => clock,
    ),
    consoles: { open: () => true, active: () => Promise.resolve(null) },
  };
  const tools = createTools(context);
  return {
    ...fake,
    approvals,
    advance: (ms: number) => (clock += ms),
    call: (name: "get_key" | "scan_keys", args: unknown, caller = agentCaller()) => tools.call(name, args, caller),
  };
}

describe("MCP key tools", () => {
  it("givenAskReads_whenGetKey_thenAsksWithKeySubject", async () => {
    const harness = keyHarness();

    const running = harness.call("get_key", { datasource: "cache", key: KEY, reason: "Check the profile" });
    const approvalId = await waitingApproval(harness.approvals);
    const [view] = harness.approvals.pending();
    expect(harness.calls).not.toContain("keyspace.open");
    harness.approvals.answer(approvalId, "allowOnce");
    const answer = await running;

    expect(view).toMatchObject({
      kind: "read",
      subject: "key",
      sql: KEY,
      database: CURRENT_DATABASE,
      reason: "Check the profile",
      allowable: true,
      destructive: null,
    });
    expect(answer.outcome).toBe("ok");
    expect(textOf(answer.result)).toContain("Ada");
    expect(harness.modes).toEqual(["read"]);

    const again = harness.call("get_key", { datasource: "cache", key: KEY, database: 0 });
    harness.approvals.answer(await waitingApproval(harness.approvals), "deny");
    const denied = await again;
    expect(denied.outcome).toBe("denied");
    expect(textOf(denied.result)).toBe(APPROVAL_REFUSALS.denied);
    expect(harness.calls.filter((type) => type === "keyspace.open")).toHaveLength(1);
  });

  it("givenAskReads_whenScanKeys_thenNoApproval", async () => {
    const harness = keyHarness();

    const answer = await harness.call("scan_keys", { datasource: "cache" });

    expect(answer.outcome).toBe("ok");
    expect(textOf(answer.result)).toContain(`- ${KEY} (string, no expiry)`);
    expect(harness.approvals.pending()).toEqual([]);
  });

  it("givenGetKeyAskBeforeReads_whenAllowedLate_thenWaitIsLeftOut", async () => {
    const harness = keyHarness();
    const caller = agentCaller();

    const running = harness.call("get_key", { datasource: "cache", key: KEY }, caller);
    const approvalId = await waitingApproval(harness.approvals);
    harness.advance(USER_THINKS_MS);
    harness.approvals.answer(approvalId, "allowOnce");
    const answer = await running;

    expect(answer.outcome).toBe("ok");
    expect(caller.waits.ms()).toBeGreaterThanOrEqual(USER_THINKS_MS);
  });

  it("givenReadAccess_whenGetKey_thenRunsWithoutAsking", async () => {
    const harness = keyHarness({ ...CACHE, access: "read" });

    const answer = await harness.call("get_key", { datasource: "cache", key: KEY });

    expect(answer.outcome).toBe("ok");
    expect(harness.approvals.pending()).toEqual([]);
  });
});
