import {
  namespaceTargets,
  openAgentConsole,
  openConsole,
} from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { revealNode } from "@table-craft/desktop/renderer/actions/explorerActions.js";
import { openTable } from "@table-craft/desktop/renderer/actions/tableCommands.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { namespaceNamed } from "@table-craft/desktop/renderer/model/consoleNamespace.js";
import { focusRegion } from "@table-craft/desktop/renderer/shell/focus.js";
import { useConsoles, type ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { activeTab, useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import type {
  McpActiveConsole,
  McpConsoleView,
  McpSchemaOutcome,
  McpUiAnswer,
  McpUiRequest,
} from "@table-craft/desktop/settings/mcp.js";

type RequestOf<Kind extends McpUiRequest["kind"]> = Extract<McpUiRequest, { kind: Kind }>;

function activeConsole(): McpActiveConsole | null {
  const tab = activeTab(useTabs.getState());
  if (tab === null) return null;
  const session = useConsoles.getState().consoles[tab.id];
  if (session === undefined) return null;
  return {
    datasourceId: session.datasourceId,
    sql: session.sql,
    selectionFrom: session.selection.from,
    selectionTo: session.selection.to,
    namespace: session.namespace,
  };
}

function viewOf(id: string, session: ConsoleSession, namespace = session.namespace): McpConsoleView {
  return {
    handle: session.agent?.handle ?? "",
    title: session.name,
    datasourceId: session.datasourceId,
    namespace,
    sql: session.sql,
    selectionFrom: session.selection.from,
    selectionTo: session.selection.to,
    revision: session.revision,
    active: activeTab(useTabs.getState())?.id === id,
  };
}

function agentConsole(handle: string): { readonly id: string; readonly session: ConsoleSession } | null {
  for (const [id, session] of Object.entries(useConsoles.getState().consoles))
    if (session.agent?.handle === handle) return { id, session };
  return null;
}

async function schemaOf(
  datasourceId: string,
  schema: string,
): Promise<{ readonly namespace: readonly string[] | null; readonly outcome: McpSchemaOutcome }> {
  const targets = await namespaceTargets(datasourceId);
  if (targets === null) return { namespace: null, outcome: "unsupported" };
  const namespace = namespaceNamed(targets, schema);
  return { namespace, outcome: namespace === null ? "unknown" : "applied" };
}

async function opened(request: RequestOf<"open">): Promise<McpUiAnswer | null> {
  const { namespace, outcome } =
    request.schema === null ? { namespace: null, outcome: null } : await schemaOf(request.datasourceId, request.schema);
  if (request.handle === null) {
    await openConsole(request.datasourceId, request.sql);
    return { kind: "done" };
  }
  const id = await openAgentConsole(request.datasourceId, {
    sql: request.sql,
    title: request.title,
    namespace,
    agent: { handle: request.handle, client: request.client },
  });
  if (request.focus) focusRegion("editor");
  const session = useConsoles.getState().consoles[id];
  return session === undefined ? null : { kind: "opened", console: viewOf(id, session, namespace), schema: outcome };
}

function edited(request: RequestOf<"edit">): McpUiAnswer {
  const found = agentConsole(request.handle);
  const outcome = found === null ? null : useConsoles.getState().agentEdit(found.id, request.edit, request.select);
  if (found === null || outcome === null) return { kind: "edited", console: null, refusal: null };
  if (outcome.ok && request.focus) {
    useTabs.getState().activate(found.id);
    focusRegion("editor");
  }
  const session = useConsoles.getState().consoles[found.id] ?? found.session;
  const refusal = outcome.ok ? null : { reason: outcome.reason, index: outcome.index, matches: outcome.matches };
  return { kind: "edited", console: viewOf(found.id, session), refusal };
}

function read(handles: readonly string[]): McpUiAnswer {
  const consoles = handles.flatMap((handle) => {
    const found = agentConsole(handle);
    return found === null ? [] : [viewOf(found.id, found.session)];
  });
  return { kind: "consoles", consoles };
}

function tableOpened(request: RequestOf<"openTable">): McpUiAnswer {
  void openTable({
    datasourceId: request.datasourceId,
    path: request.path,
    relation: request.table,
    ...(request.where === null ? {} : { where: request.where }),
    ...(request.orderBy === null ? {} : { orderBy: request.orderBy }),
    draftOnly: request.draftOnly,
  });
  if (request.focus) focusRegion("editor");
  return { kind: "done" };
}

async function answer(request: McpUiRequest): Promise<McpUiAnswer | null> {
  switch (request.kind) {
    case "open":
      return opened(request);
    case "activeContext":
      return { kind: "context", context: activeConsole() };
    case "edit":
      return edited(request);
    case "read":
      return read(request.handles);
    case "release":
      useConsoles.getState().releaseAgent(request.handles);
      return { kind: "done" };
    case "openTable":
      return tableOpened(request);
    case "reveal":
      revealNode(request, request.focus);
      return { kind: "done" };
  }
}

/**
 * Answers the MCP host's window requests (plan 156): opening, reading and editing the consoles an
 * agent owns, the focused console for `get_active_context`, and opening or revealing a table. The
 * host decides what the agent may see and touch; the window only does it and says what happened.
 */
export function installMcpUiRelay(): () => void {
  return bridge().onMcpUiRequest(({ requestId, request }) => {
    void answer(request).then((reply) => {
      if (reply !== null) void bridge().mcpUiAnswer(requestId, reply);
    });
  });
}
