import type { AgentDatasource, AgentHistoryEntry } from "@table-craft/desktop/mcp/messages.js";
import type { AgentEngine, AgentEngines, SessionMode } from "@table-craft/desktop/mcp/engines.js";
import { APPROVAL_REFUSALS, type ApprovalRequest, type Approvals } from "@table-craft/desktop/mcp/approvals.js";
import type { Runs } from "@table-craft/desktop/mcp/activity.js";
import { NOT_EXPOSED_REASON } from "@table-craft/desktop/mcp/access.js";
import type { Capability, StatementLimit } from "@table-craft/desktop/engine/protocol.js";
import type { McpActiveConsole, McpCallOutcome, McpConsoleRequest } from "@table-craft/desktop/settings/mcp.js";

/** Who called a tool: the MCP session and the name its client gave at `initialize`. */
export interface Caller {
  readonly sessionId: string;
  readonly clientName: string;
}

/** The user's windows, as the console tools reach them through main. */
export interface ConsoleBridge {
  /** False when no window is open to show it. */
  open(request: McpConsoleRequest): boolean;
  /** The focused console, or null when none is focused or no window answers in time. */
  active(): Promise<McpActiveConsole | null>;
}

export interface ToolContext {
  readonly datasources: () => readonly AgentDatasource[];
  readonly engines: AgentEngines;
  readonly approvals: Approvals;
  readonly runs: Runs;
  readonly consoles: ConsoleBridge;
  readonly record: (entry: AgentHistoryEntry) => void;
  /** The server-wide row limit; a datasource's own wins (`rowCapOf`). */
  readonly rowCap: () => number;
  /** The server-wide statement timeout in seconds; a datasource's own wins (`timeoutOf`). */
  readonly timeoutSeconds: () => number;
  readonly now: () => number;
}

/** A tool's answer as MCP's `tools/call` returns it. */
export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

/** A tool's answer and what the status chip says about the call. */
export interface ToolAnswer {
  readonly result: ToolResult;
  readonly outcome: McpCallOutcome;
  readonly datasourceId: string | null;
  /** What Agent Activity says the call was about. */
  readonly target: string | null;
  readonly rowCount: number | null;
  readonly message: string | null;
}

/** Ends a tool call with an error the agent reads; `outcome` is what the chip shows for it. */
export class ToolFailure extends Error {
  constructor(
    message: string,
    readonly outcome: Exclude<McpCallOutcome, "ok"> = "error",
  ) {
    super(message);
    this.name = "ToolFailure";
  }
}

export function textResult(text: string, structured?: Readonly<Record<string, unknown>>): ToolResult {
  return { content: [{ type: "text", text }], ...(structured === undefined ? {} : { structuredContent: structured }) };
}

/** The datasource an agent named, by id or else by exact name; refused unless it is exposed. */
export function exposedDatasource(context: ToolContext, named: string): AgentDatasource {
  const all = context.datasources();
  const found =
    all.find((datasource) => datasource.id === named) ?? all.find((datasource) => datasource.name === named);
  if (found === undefined || found.access === "off") {
    throw new ToolFailure(
      `No datasource "${named}" is exposed to agents. Call list_datasources for the ones that are.`,
      "refused",
    );
  }
  return found;
}

/** The engine, once its plugin declares every capability in `needs` and at least one of `oneOf`. */
export async function engineWith(
  context: ToolContext,
  datasource: AgentDatasource,
  needs: readonly Capability[],
  oneOf: readonly Capability[] = [],
): Promise<AgentEngine> {
  if (datasource.access === "off") throw new ToolFailure(NOT_EXPOSED_REASON, "refused");
  const engine = await context.engines.engine(datasource.id);
  const capabilities = await engine.capabilities();
  const missing: string[] = needs.filter((capability) => !capabilities.includes(capability));
  if (oneOf.length > 0 && !oneOf.some((capability) => capabilities.includes(capability))) {
    missing.push(oneOf.join(" or "));
  }
  if (missing.length > 0) {
    throw new ToolFailure(
      `${datasource.name} cannot do this: its plugin lacks the ${missing.join(", ")} capability.`,
      "refused",
    );
  }
  return engine;
}

/** What a tool asks the user about; the caller and datasource fill in the rest. */
export type ApprovalAsk = Omit<ApprovalRequest, "sessionId" | "clientName" | "datasourceId" | "datasourceName">;

/**
 * Returns once the user allows the request, or an earlier "allow this kind" answer covers it; any
 * other outcome ends the call with the refusal the agent reads.
 */
export async function waitForApproval(
  context: ToolContext,
  caller: Caller,
  datasource: AgentDatasource,
  ask: ApprovalAsk,
): Promise<void> {
  const request: ApprovalRequest = {
    sessionId: caller.sessionId,
    clientName: caller.clientName,
    datasourceId: datasource.id,
    datasourceName: datasource.name,
    ...ask,
  };
  if (context.approvals.allowedAlready(request)) return;
  const outcome = await context.approvals.request(request);
  if (outcome !== "allowed")
    throw new ToolFailure(APPROVAL_REFUSALS[outcome], outcome === "handedOff" ? "handedOff" : "denied");
}

/** How the Services tree stops a run in `mode`, or null when the plugin cannot cancel. */
export async function cancelOf(engine: AgentEngine, mode: SessionMode): Promise<(() => Promise<void>) | null> {
  return (await engine.capabilities()).includes("cancel") ? () => engine.cancel(mode) : null;
}

/** Whether the namespace the path starts in is one agents see on this datasource. */
export function shown(datasource: AgentDatasource, path: readonly string[]): boolean {
  const top = path[0];
  return datasource.schemas === undefined || (top !== undefined && datasource.schemas.includes(top));
}

export function rowCapOf(context: ToolContext, datasourceId: string): number {
  return context.datasources().find((datasource) => datasource.id === datasourceId)?.rowCap ?? context.rowCap();
}

/**
 * The limit an agent's statement runs under, which the database enforces too where it can
 * (decision 129): an agent cannot cancel, so its statements never run unlimited.
 */
export function timeoutOf(context: ToolContext, datasourceId: string): StatementLimit {
  const own = context.datasources().find((datasource) => datasource.id === datasourceId)?.timeoutSeconds;
  return { timeoutSeconds: own ?? context.timeoutSeconds(), serverEnforced: true };
}
