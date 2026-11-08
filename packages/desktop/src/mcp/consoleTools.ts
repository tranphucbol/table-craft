import type { Problem } from "@table-craft/desktop/engine/protocol.js";
import { NOT_EXPOSED_REASON } from "@table-craft/desktop/mcp/access.js";
import { byWindow, type OwnedConsole } from "@table-craft/desktop/mcp/consoleOwners.js";
import {
  engineWith,
  exposedDatasource,
  textResult,
  ToolFailure,
  type Caller,
  type ToolContext,
  type ToolResult,
  type UiReply,
} from "@table-craft/desktop/mcp/toolKit.js";
import type {
  AgentEdit,
  AgentEditRefusal,
  McpConsoleView,
  McpSchemaOutcome,
} from "@table-craft/desktop/settings/mcp.js";

const NO_WINDOW = "TableCraft has no window open to show the console in.";
const SILENT_WINDOW = "TableCraft's window did not answer; try again.";
const NO_CONSOLE = "No console is focused in TableCraft.";
const HIDDEN_CONSOLE = "The focused console is on a datasource not exposed to agents, so TableCraft does not share it.";
const FOCUS_OFF = "The user does not let agents bring TableCraft forward, so the window stayed where it was.";
const SCHEMA_NOTES: Readonly<Record<McpSchemaOutcome, (schema: string) => string>> = {
  applied: (schema) => `The console works in ${schema}.`,
  unsupported: () => "This datasource cannot switch schema; qualify names in the text.",
  unknown: (schema) => `Schema ${schema} was not found; the console uses the default.`,
};
const EDIT_REFUSALS: Readonly<Record<AgentEditRefusal, (index: string, matches: number) => string>> = {
  notFound: (index) => `Edit ${index}: oldText not found; call read_console for the current text. Nothing changed.`,
  ambiguous: (index, matches) =>
    `Edit ${index}: oldText matches ${String(matches)} times; include more surrounding text. Nothing changed.`,
  stale: () =>
    "The user changed the console since that revision; read it with read_console and retry. Nothing changed.",
  selectNotFound: (_index, matches) =>
    `select must occur exactly once in the result; it occurs ${String(matches)} times. Nothing changed.`,
};

function notYours(handle: string): string {
  return `No console ${handle} of yours is open. Call list_consoles for the ones that are, or open one with open_in_console.`;
}

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

export interface OpenInConsoleArgs {
  readonly datasource: string;
  readonly sql: string;
  readonly schema?: string | undefined;
  readonly title?: string | undefined;
  readonly focus?: boolean | undefined;
}

/** The answer a window gave, or the refusal the agent reads when there is none. */
export function answered(reply: UiReply): Extract<UiReply, { status: "answered" }> {
  if (reply.status === "gone") throw new ToolFailure(NO_WINDOW, "refused");
  if (reply.status === "silent") throw new ToolFailure(SILENT_WINDOW);
  return reply;
}

/** Whether the window may be brought forward, and what the agent is told when it may not. */
export function focusOf(context: ToolContext, asked: boolean | undefined): { focus: boolean; note: string | null } {
  if (asked !== true) return { focus: false, note: null };
  return context.allowFocus() ? { focus: true, note: null } : { focus: false, note: FOCUS_OFF };
}

function consoleFacts(view: McpConsoleView): Readonly<Record<string, unknown>> {
  return {
    console: view.handle,
    title: view.title,
    datasource: view.datasourceId,
    schema: view.namespace === null ? null : view.namespace.join("."),
    revision: view.revision,
  };
}

/**
 * Puts the text in a new console for the user and answers the handle the calling session owns it
 * by; it never runs it (decisions 127, 161).
 */
export async function openInConsole(
  context: ToolContext,
  caller: Caller,
  args: OpenInConsoleArgs,
): Promise<ToolResult> {
  const datasource = exposedDatasource(context, args.datasource);
  const handle = context.owners.next();
  const { focus, note } = focusOf(context, args.focus);
  const reply = answered(
    await context.windows.ask("focused", {
      kind: "open",
      handle,
      client: caller.clientName,
      datasourceId: datasource.id,
      sql: args.sql,
      schema: args.schema ?? null,
      title: args.title ?? null,
      focus,
    }),
  );
  if (reply.answer.kind !== "opened") throw new ToolFailure(SILENT_WINDOW);
  const view = reply.answer.console;
  context.owners.claim({ handle, sessionId: caller.sessionId, window: reply.window, datasourceId: datasource.id });
  const notes = [
    reply.answer.schema === null ? null : SCHEMA_NOTES[reply.answer.schema](args.schema ?? ""),
    note,
  ].filter((line) => line !== null);
  return textResult(
    [
      `Opened console ${handle} (${view.title}) on ${datasource.name} at revision ${String(view.revision)}. The user reviews and runs it; change it with edit_console rather than opening another.`,
      ...notes,
    ].join("\n"),
    { ...consoleFacts(view), focused: focus },
  );
}

export async function getActiveContext(context: ToolContext): Promise<ToolResult> {
  const reply = await context.windows.ask("focused", { kind: "activeContext" });
  const active = reply.status === "answered" && reply.answer.kind === "context" ? reply.answer.context : null;
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

/** The caller's console by handle, on a datasource still exposed; refused alike for unknown and foreign handles. */
function ownConsole(context: ToolContext, caller: Caller, handle: string): OwnedConsole {
  const owned = context.owners.find(caller.sessionId, handle);
  if (owned === null) throw new ToolFailure(notYours(handle), "refused");
  const datasource = context.datasources().find((candidate) => candidate.id === owned.datasourceId);
  if (datasource === undefined || datasource.access === "off") throw new ToolFailure(NOT_EXPOSED_REASON, "refused");
  return owned;
}

/** The window's answer about an owned console; a closed window or tab drops the handle. */
async function askOwner(
  context: ToolContext,
  owned: OwnedConsole,
  request: Parameters<ToolContext["windows"]["ask"]>[1],
): Promise<Extract<UiReply, { status: "answered" }>> {
  const reply = await context.windows.ask({ window: owned.window }, request);
  if (reply.status === "silent") throw new ToolFailure(SILENT_WINDOW);
  if (reply.status === "gone") {
    context.owners.drop(owned.handle);
    throw new ToolFailure(notYours(owned.handle), "refused");
  }
  return reply;
}

export interface EditConsoleArgs {
  readonly console: string;
  readonly edit: AgentEdit;
  readonly select?: string | undefined;
  readonly focus?: boolean | undefined;
}

/** Changes a console the caller opened, as one undo step in the user's editor (decision 161). */
export async function editConsole(context: ToolContext, caller: Caller, args: EditConsoleArgs): Promise<ToolResult> {
  const owned = ownConsole(context, caller, args.console);
  const { focus, note } = focusOf(context, args.focus);
  const reply = await askOwner(context, owned, {
    kind: "edit",
    handle: owned.handle,
    edit: args.edit,
    select: args.select ?? null,
    focus,
  });
  if (reply.answer.kind !== "edited") throw new ToolFailure(SILENT_WINDOW);
  const { console: view, refusal } = reply.answer;
  if (view === null) {
    context.owners.drop(owned.handle);
    throw new ToolFailure(notYours(owned.handle), "refused");
  }
  if (refusal !== null) {
    const index = refusal.index === null ? "" : String(refusal.index + 1);
    throw new ToolFailure(EDIT_REFUSALS[refusal.reason](index, refusal.matches));
  }
  return textResult(
    [
      `Changed console ${view.handle}; it is at revision ${String(view.revision)}.`,
      ...(note === null ? [] : [note]),
    ].join("\n"),
    { ...consoleFacts(view), focused: focus },
  );
}

/** The text, selection and revision of a console the caller opened, as the user left it. */
export async function readConsole(context: ToolContext, caller: Caller, handle: string): Promise<ToolResult> {
  const owned = ownConsole(context, caller, handle);
  const reply = await askOwner(context, owned, { kind: "read", handles: [handle] });
  const view = reply.answer.kind === "consoles" ? reply.answer.consoles.find((found) => found.handle === handle) : null;
  if (view === undefined || view === null) {
    context.owners.drop(handle);
    throw new ToolFailure(notYours(handle), "refused");
  }
  const selection = view.sql.slice(view.selectionFrom, view.selectionTo);
  return textResult(
    [
      `Console ${view.handle} (${view.title}) on ${view.datasourceId}, revision ${String(view.revision)}.`,
      ...(view.namespace === null ? [] : [`Schema: ${view.namespace.join(".")}`]),
      ...(selection === "" ? [] : ["Selection:", selection]),
      "Console:",
      view.sql,
    ].join("\n"),
    {
      ...consoleFacts(view),
      sql: view.sql,
      selection: { from: view.selectionFrom, to: view.selectionTo, text: selection },
    },
  );
}

/** The calling session's own open consoles; never the user's (decision 127). */
export async function listConsoles(context: ToolContext, caller: Caller): Promise<ToolResult> {
  const exposed = new Set(
    context
      .datasources()
      .filter((datasource) => datasource.access !== "off")
      .map((datasource) => datasource.id),
  );
  const owned = context.owners.ofSession(caller.sessionId).filter((entry) => exposed.has(entry.datasourceId));
  const views: McpConsoleView[] = [];
  for (const [window, handles] of byWindow(owned)) {
    const reply = await context.windows.ask({ window }, { kind: "read", handles });
    if (reply.status === "silent") continue;
    const found = reply.status === "answered" && reply.answer.kind === "consoles" ? reply.answer.consoles : [];
    for (const handle of handles) if (!found.some((view) => view.handle === handle)) context.owners.drop(handle);
    views.push(...found);
  }
  if (views.length === 0)
    return textResult("You have no console open in TableCraft. Open one with open_in_console.", { consoles: [] });
  const consoles = views.map((view) => ({ ...consoleFacts(view), active: view.active }));
  const lines = views.map(
    (view) =>
      `- ${view.handle}: ${view.title} on ${view.datasourceId}, revision ${String(view.revision)}${view.active ? " (the user's active tab)" : ""}`,
  );
  return textResult(lines.join("\n"), { consoles });
}

/** Lets the windows clear the agent marker of consoles nobody owns any more; the consoles stay. */
export function releaseConsoles(context: ToolContext, consoles: readonly OwnedConsole[]): void {
  for (const [window, handles] of byWindow(consoles))
    void context.windows.ask({ window }, { kind: "release", handles });
}
