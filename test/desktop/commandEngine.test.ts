import { describe, expect, it } from "vitest";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import type { ClassifiedStatement, EngineResponse, ExecutedStatement } from "@table-craft/desktop/engine/protocol.js";
import { NODE_ALL_PRIMARIES, RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS } from "@table-craft/desktop/engine/protocol.js";
import type { CompletionResult, Problem } from "@table-craft/plugin-api";
import { FAKE_COMMANDS_ID, fakeCommandsPlugin } from "../support/fakeCommandsPlugin.js";

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };

function connected() {
  const fake = fakeCommandsPlugin();
  const connection = createEngine({
    datasource: { id: "kv", pluginId: FAKE_COMMANDS_ID, config: {}, readOnly: false, keepAliveSeconds: 0 },
    plugins: [fake.loaded],
  }).connect();
  return { connection, calls: fake.calls };
}

function resultOf<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(`unexpected engine error: ${response.error.message}`);
  return response.result as T;
}

async function openSession(connection: ReturnType<typeof connected>["connection"]): Promise<string> {
  return resultOf<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" })).sessionId;
}

describe("engine over a commands plugin", () => {
  it("givenScript_whenSplit_thenCommandLanguageSpansWithCostlyAndConfirmByName", async () => {
    const { connection } = connected();

    const statements = resultOf<ClassifiedStatement[]>(
      await connection.handle({ id: 1, type: "script.split", text: "# warm up\nKEYS user:*\n\nFLUSHDB\nGET greeting" }),
    );

    expect(statements.map((statement) => statement.sql)).toEqual(["KEYS user:*", "FLUSHDB", "GET greeting"]);
    expect(statements[0]).toMatchObject({
      kind: "read",
      destructive: null,
      costly: "KEYS walks every key",
      parameters: [],
    });
    expect(statements[1]).toMatchObject({ destructive: "FLUSHDB deletes every key", confirmByName: true });
    expect(statements[2]).not.toHaveProperty("costly");
  });

  it("givenCommand_whenExecuted_thenReplyWithoutColumns", async () => {
    const { connection } = connected();
    const sessionId = await openSession(connection);

    const executed = resultOf<ExecutedStatement>(
      await connection.handle({ id: 2, type: "statement.execute", ...PAGING, sessionId, sql: "GET greeting" }),
    );

    expect(executed.reply).toEqual({ value: "hello", text: '"hello"' });
    expect(executed.columns).toEqual([]);
  });

  it("givenNode_whenExecuted_thenPluginAskedToRunThere", async () => {
    const { connection, calls } = connected();
    const sessionId = await openSession(connection);

    await connection.handle({
      id: 2,
      type: "statement.execute",
      ...PAGING,
      sessionId,
      sql: "PING",
      node: NODE_ALL_PRIMARIES,
    });
    await connection.handle({ id: 3, type: "statement.execute", ...PAGING, sessionId, sql: "PING" });

    expect(calls.executed).toEqual([
      { command: "PING", node: NODE_ALL_PRIMARIES },
      { command: "PING", node: undefined },
    ]);
  });

  it("givenText_whenCompleted_thenCommandLanguageAnswersOverAHelperSession", async () => {
    const { connection, calls } = connected();

    const completed = resultOf<CompletionResult>(
      await connection.handle({ id: 1, type: "completion.complete", text: "HG", offset: 2 }),
    );

    expect(completed.items.map((item) => item.label)).toEqual(["HGET"]);
    expect(calls.opened).toBe(1);
  });

  it("givenCostlyCommand_whenInspected_thenProblemWithFix", async () => {
    const { connection } = connected();

    const problems = resultOf<Problem[]>(
      await connection.handle({ id: 1, type: "inspection.inspect", text: "KEYS *" }),
    );

    expect(problems).toMatchObject([{ from: 0, to: 6, fixes: [{ title: "Use SCAN" }] }]);
  });
});
