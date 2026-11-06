import { relationsOf } from "@table-craft/desktop/mcp/catalogTools.js";
import { answered, focusOf } from "@table-craft/desktop/mcp/consoleTools.js";
import {
  engineWith,
  exposedDatasource,
  textResult,
  ToolFailure,
  type ToolContext,
  type ToolResult,
} from "@table-craft/desktop/mcp/toolKit.js";

const ONE_READ =
  "The filter must form one read: a WHERE condition and an ORDER BY list, with no other statement. Nothing was opened.";

export interface OpenTableArgs {
  readonly datasource: string;
  readonly schema: string;
  readonly table: string;
  readonly where?: string | undefined;
  readonly orderBy?: string | undefined;
  readonly focus?: boolean | undefined;
}

export interface RevealArgs {
  readonly datasource: string;
  readonly schema: string;
  readonly table?: string | undefined;
  readonly column?: string | undefined;
  readonly focus?: boolean | undefined;
}

function noTable(table: string, schema: string): string {
  return `No table or view "${table}" in ${schema}. Call list_tables for the ones there are.`;
}

/**
 * Opens a table in the user's data editor, filtered when asked (decision 161). The rows are read in
 * the user's session and never reach the agent, so the filter must classify as exactly one read;
 * on an ask-before-reads datasource it only fills the bars, and the user reads them.
 */
export async function openTableFor(context: ToolContext, args: OpenTableArgs): Promise<ToolResult> {
  const datasource = exposedDatasource(context, args.datasource);
  await engineWith(context, datasource, ["schemaTree", "sql"]);
  const { engine, path, relations } = await relationsOf(context, args.datasource, args.schema);
  const relation = relations.find((candidate) => candidate.name === args.table);
  if (relation === undefined) throw new ToolFailure(noTable(args.table, args.schema));
  const where = args.where ?? null;
  const orderBy = args.orderBy ?? null;
  const filtered = where !== null || orderBy !== null;
  const draftOnly = filtered && datasource.access === "askReads";
  const qualified = await engine.call("catalog.qualifiedName", { path, name: relation.name });
  if (filtered && !draftOnly) {
    const probe = [
      `SELECT * FROM ${qualified}`,
      ...(where === null ? [] : [`WHERE ${where}`]),
      ...(orderBy === null ? [] : [`ORDER BY ${orderBy}`]),
    ].join("\n");
    const statements = await engine.call("script.split", { text: probe });
    if (statements.length !== 1 || statements[0]?.kind !== "read") throw new ToolFailure(ONE_READ, "refused");
  }
  const { focus, note } = focusOf(context, args.focus);
  answered(
    await context.windows.ask("focused", {
      kind: "openTable",
      datasourceId: datasource.id,
      path,
      table: relation.name,
      where,
      orderBy,
      draftOnly,
      focus,
    }),
  );
  const outcome = !filtered
    ? `Opened ${qualified} in the user's data editor.`
    : draftOnly
      ? `Opened ${qualified} in the user's data editor with the filter in its bars, not applied: on this datasource the user applies it.`
      : `Opened ${qualified} in the user's data editor, filtered.`;
  return textResult(
    [
      `${outcome} The rows stay with the user; read them with run_query if you need them.`,
      ...(note === null ? [] : [note]),
    ].join("\n"),
    { table: qualified, applied: filtered && !draftOnly, focused: focus },
  );
}

/** Selects a schema, table, view or column in the user's Database pane; `found: false` when there is no such object. */
export async function revealInExplorer(context: ToolContext, args: RevealArgs): Promise<ToolResult> {
  const datasource = exposedDatasource(context, args.datasource);
  const { path, relations } = await relationsOf(context, args.datasource, args.schema);
  const relation = args.table === undefined ? null : relations.find((candidate) => candidate.name === args.table);
  const column =
    args.column === undefined || relation === null || relation === undefined
      ? null
      : (relation.columns.find((candidate) => candidate.name === args.column)?.name ?? undefined);
  if (relation === undefined || column === undefined) {
    const missing =
      relation === undefined ? noTable(args.table ?? "", args.schema) : `No column "${args.column ?? ""}".`;
    return textResult(`${missing} Nothing was selected.`, { found: false });
  }
  const { focus, note } = focusOf(context, args.focus);
  answered(
    await context.windows.ask("focused", {
      kind: "reveal",
      datasourceId: datasource.id,
      path,
      relation: relation === null ? null : { name: relation.name, kind: relation.kind },
      column,
      focus,
    }),
  );
  const named = [path.join("."), relation?.name, column].filter((part) => part != null).join(".");
  return textResult([`Selected ${named} in the user's Database pane.`, ...(note === null ? [] : [note])].join("\n"), {
    found: true,
    focused: focus,
  });
}
