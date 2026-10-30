import { describe, expect, it } from "vitest";
import { agentEvent, callLine, resultLine } from "./opencode.js";

describe("README OpenCode transcript", () => {
  it("givenCodeModeScript_whenCallLineBuilt_thenEachMcpCallShowsItsArgument", () => {
    const code =
      'const t = await tools.tablecraft.describe_table({datasource:"shop", table:"products"});\n' +
      'return await tools.tablecraft.run_query({datasource:"shop", sql:"UPDATE products SET stock = 50"});';

    expect(callLine("execute", { code })).toBe(
      "tablecraft.describe_table products · tablecraft.run_query UPDATE products SET stock = 50",
    );
    expect(callLine("glob", { pattern: "**/*" })).toBe("glob");
  });

  it("givenToolAnswers_whenResultLineBuilt_thenTheyAreSummarised", () => {
    expect(resultLine('{"rowsAffected": 4, "messages": []}')).toBe("4 rows affected");
    expect(resultLine('{"columns": [], "rows": [[1], [2]]}')).toBe("2 rows");
    expect(resultLine('{"s": {"tables": [{"name": "a"}, {"name": "b"}]}, "d": {"rows": []}}')).toBe("a, b · 0 rows");
    expect(resultLine("Unknown tool\nmore")).toBe("Unknown tool");
  });

  it("givenJsonEvents_whenParsed_thenToolsAndTextAreKept", () => {
    const tool = JSON.stringify({
      type: "tool_use",
      part: { tool: "execute", state: { status: "completed", input: { code: "x" }, output: "{}" } },
    });
    const reply = JSON.stringify({ type: "text", part: { text: "Ran `UPDATE`.\n\n| id |\n|----|" } });

    expect(agentEvent(tool)).toEqual({
      kind: "tool",
      tool: "execute",
      input: { code: "x" },
      output: "{}",
      failed: false,
    });
    expect(agentEvent(reply)).toEqual({ kind: "text", text: "Ran UPDATE." });
    expect(agentEvent(JSON.stringify({ type: "step_start" }))).toBeNull();
  });
});
