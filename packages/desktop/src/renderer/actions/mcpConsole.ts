import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import { activeTab, useTabs } from "@table-craft/desktop/renderer/state/tabs.js";
import type { McpActiveConsole } from "@table-craft/desktop/settings/mcp.js";

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

/**
 * Answers the MCP host's console tools (decision 127): `open_in_console` opens a console with the
 * agent's text and runs nothing, `get_active_context` reads the focused console. The host decides
 * whether the agent may see that console's datasource.
 */
export function installMcpConsoleRelay(): () => void {
  const offOpen = bridge().onMcpOpenConsole((request) => void openConsole(request.datasourceId, request.sql));
  const offContext = bridge().onMcpContextRequest(
    (request) => void bridge().mcpContextReply(request.requestId, activeConsole()),
  );
  return () => {
    offOpen();
    offContext();
  };
}
