import type { Problem } from "@table-craft/desktop/engine/protocol.js";
import {
  engineWith,
  exposedDatasource,
  textResult,
  ToolFailure,
  type ToolContext,
  type ToolResult,
} from "@table-craft/desktop/mcp/toolKit.js";

const NO_WINDOW = "TableCraft has no window open to show the console in.";
const NO_CONSOLE = "No console is focused in TableCraft.";
const HIDDEN_CONSOLE = "The focused console is on a datasource not exposed to agents, so TableCraft does not share it.";

/** 1-based line and column of `offset`, as an editor shows them. */
export function lineColumn(text: string, offset: number): { readonly line: number; readonly column: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function problemLine(sql: string, problem: Problem): string {
  const { line, column } = lineColumn(sql, problem.from);
  return `- ${String(line)}:${String(column)} ${problem.severity}: ${problem.message} (${problem.inspection})`;
}

export async function checkSql(context: ToolContext, named: string, sql: string): Promise<ToolResult> {
  const datasource = exposedDatasource(context, named);
  const engine = await engineWith(context, datasource, [], ["sql", "commands"]);
  const problems = await engine.call("inspection.inspect", { text: sql });
  return textResult(
    problems.length === 0 ? "No problems found." : problems.map((problem) => problemLine(sql, problem)).join("\n"),
    {
      problems: problems.map((problem) => ({
        ...lineColumn(sql, problem.from),
        from: problem.from,
        to: problem.to,
        severity: problem.severity,
        inspection: problem.inspection,
        message: problem.message,
      })),
    },
  );
}

/** Puts the text in a new console for the user; it never runs it (decision 127). */
export function openInConsole(context: ToolContext, named: string, sql: string): ToolResult {
  const datasource = exposedDatasource(context, named);
  if (!context.consoles.open({ datasourceId: datasource.id, sql })) throw new ToolFailure(NO_WINDOW, "refused");
  return textResult(`Opened a console on ${datasource.name} with the text. The user reviews and runs it.`);
}

export async function getActiveContext(context: ToolContext): Promise<ToolResult> {
  const active = await context.consoles.active();
  if (active === null) throw new ToolFailure(NO_CONSOLE);
  const datasource = context.datasources().find((candidate) => candidate.id === active.datasourceId);
  if (datasource === undefined || datasource.access === "off") throw new ToolFailure(HIDDEN_CONSOLE, "refused");
  const selection = active.sql.slice(active.selectionFrom, active.selectionTo);
  const namespace = active.namespace === null ? null : active.namespace.join(".");
  const text = [
    `Datasource: ${datasource.id} (${datasource.name})`,
    ...(namespace === null ? [] : [`Schema: ${namespace}`]),
    ...(selection === "" ? [] : ["Selection:", selection]),
    "Console:",
    active.sql,
  ].join("\n");
  return textResult(text, {
    datasource: datasource.id,
    schema: namespace,
    sql: active.sql,
    selection: { from: active.selectionFrom, to: active.selectionTo, text: selection },
  });
}
