import type { InvokeResult } from "@table-craft/desktop/preload/bridge.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { copied, writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { useSettingsDialog } from "@table-craft/desktop/renderer/state/settingsDialog.js";
import {
  MCP_CLIENT_LABELS,
  mcpEndpoint,
  type AgentAccess,
  type AgentPolicy,
  type ApprovalAnswer,
  type McpClient,
  type McpConsoleRequest,
  type McpKnownClient,
} from "@table-craft/desktop/settings/mcp.js";

export const MCP_ACTION_IDS = {
  toggle: "mcp.toggle",
  show: "mcp.show",
  pause: "mcp.pause",
  resume: "mcp.resume",
  approvals: "mcp.approvals",
  answer: "mcp.answer",
  disconnect: "mcp.disconnect",
  copyConfig: "mcp.copyConfig",
  regenerateToken: "mcp.regenerateToken",
  setAccess: "mcp.setAccess",
  setPolicy: "mcp.setPolicy",
  settings: "mcp.settings",
  productionNote: "mcp.productionNote",
  copyToken: "mcp.copyToken",
  copyEndpoint: "mcp.copyEndpoint",
  decideClient: "mcp.decideClient",
  forgetClient: "mcp.forgetClient",
  cancel: "mcp.cancel",
  handOff: "mcp.handOff",
  activity: "mcp.activity",
  openInConsole: "mcp.openInConsole",
} as const;

export interface AgentPolicyArgs {
  readonly datasourceId: string;
  readonly policy: AgentPolicy;
}

export interface ApprovalAnswerArgs {
  readonly approvalId: string;
  readonly answer: ApprovalAnswer;
}

export interface AgentAccessArgs {
  readonly datasourceId: string;
  readonly access: AgentAccess;
}

function running(): boolean {
  return useMcp.getState().status.state === "running";
}

function paused(): boolean {
  return useMcp.getState().status.paused;
}

function waiting(): boolean {
  return useMcp.getState().status.approvals.length > 0;
}

async function answered(request: Promise<InvokeResult<unknown>>, failure: string): Promise<void> {
  const answer = await request;
  if (!answer.ok) {
    await useModal.getState().ask({ kind: "notice", title: failure, ...answer.error });
  }
}

function toggle(): Promise<void> {
  return useSettings
    .getState()
    .update((settings) => ({ ...settings, mcp: { ...settings.mcp, enabled: !settings.mcp.enabled } }));
}

/** Allow or Block a client by name; the MCP host follows the settings (decision 127). */
function setClients(next: (clients: readonly McpKnownClient[]) => readonly McpKnownClient[]): Promise<void> {
  return useSettings
    .getState()
    .update((settings) => ({ ...settings, mcp: { ...settings.mcp, clients: next(settings.mcp.clients) } }));
}

function decideClient(decision: McpKnownClient): Promise<void> {
  return setClients((clients) => [...clients.filter((client) => client.name !== decision.name), decision]);
}

async function copyToken(): Promise<void> {
  const answer = await bridge().mcpCopyToken();
  if (answer.ok) copied();
  else await useModal.getState().ask({ kind: "notice", title: "Could not copy the access token", ...answer.error });
}

/** Opens the statement in a console and tells the agent the user took it over; nothing runs. */
async function handOff(approvalId: string): Promise<void> {
  const approval = useMcp.getState().status.approvals.find((pending) => pending.id === approvalId);
  if (approval === undefined) return;
  useMcp.getState().setApproval(false);
  await openConsole(approval.datasourceId, approval.sql);
  await answered(
    bridge().mcpControl({ action: "answer", approvalId, answer: "handOff" }),
    "Could not answer the agent",
  );
}

function showActivity(): void {
  useMcp.getState().setPopover(false);
  useMcp.getState().setActivity(true);
}

function reviewApprovals(): void {
  useMcp.getState().setPopover(false);
  useMcp.getState().setApproval(true);
}

async function copyConfig(client: McpClient): Promise<void> {
  const answer = await bridge().mcpCopyClientConfig(client);
  if (answer.ok) {
    copied();
    return;
  }
  await useModal.getState().ask({
    kind: "notice",
    title: `Could not copy the ${MCP_CLIENT_LABELS[client]} config`,
    ...answer.error,
  });
}

/** Where the palette lands an action that needs a choice it cannot make, such as which client. */
function showSettings(): void {
  useMcp.getState().setPopover(false);
  useSettingsDialog.getState().show("mcp");
}

async function regenerateToken(): Promise<void> {
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Regenerate Access Token",
    message:
      "Every connected client is disconnected and needs the new token. Copy each client's config again after this.",
    confirm: "Regenerate",
    destructive: true,
  });
  if (confirmed === null) return;
  await answered(bridge().mcpRegenerateToken(), "Could not regenerate the token");
}

/**
 * Settings › MCP Server, the status bar chip and the write approval dialog (plan 117). The MCP
 * host decides; these only ask. None has a default chord.
 */
export const MCP_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: MCP_ACTION_IDS.toggle,
    title: "Toggle MCP Server",
    category: "App",
    icon: "server",
    run: toggle,
  }),
  defineAction({
    id: MCP_ACTION_IDS.show,
    title: "Show MCP Server Status",
    category: "App",
    icon: "server",
    run: () => useMcp.getState().setPopover(!useMcp.getState().popoverOpen),
  }),
  defineAction({
    id: MCP_ACTION_IDS.pause,
    title: "Pause Agents",
    category: "App",
    icon: "cancel",
    available: () => running() && !paused(),
    run: () => answered(bridge().mcpControl({ action: "pause", paused: true }), "Could not pause agents"),
  }),
  defineAction({
    id: MCP_ACTION_IDS.resume,
    title: "Resume Agents",
    category: "App",
    icon: "run",
    available: () => running() && paused(),
    run: () => answered(bridge().mcpControl({ action: "pause", paused: false }), "Could not resume agents"),
  }),
  defineAction({
    id: MCP_ACTION_IDS.approvals,
    title: "Review Agent Request…",
    category: "App",
    icon: "submit",
    available: waiting,
    run: reviewApprovals,
  }),
  defineAction<ApprovalAnswerArgs | undefined>({
    id: MCP_ACTION_IDS.answer,
    title: "Answer Agent Request",
    category: "App",
    available: waiting,
    run: (_context, args) => {
      if (args === undefined) return reviewApprovals();
      const { approvalId, answer } = args;
      return answered(bridge().mcpControl({ action: "answer", approvalId, answer }), "Could not answer the agent");
    },
  }),
  defineAction<string | undefined>({
    id: MCP_ACTION_IDS.disconnect,
    title: "Disconnect Agent",
    category: "App",
    icon: "disconnect",
    available: () => useMcp.getState().status.clients.length > 0,
    run: (_context, clientId) => {
      if (clientId === undefined) return useMcp.getState().setPopover(true);
      return answered(bridge().mcpControl({ action: "disconnect", clientId }), "Could not disconnect the agent");
    },
  }),
  defineAction<McpClient | undefined>({
    id: MCP_ACTION_IDS.copyConfig,
    title: "Copy MCP Client Config",
    category: "App",
    icon: "copy",
    run: (_context, client) => {
      if (client === undefined) return showSettings();
      return copyConfig(client);
    },
  }),
  defineAction({
    id: MCP_ACTION_IDS.regenerateToken,
    title: "Regenerate MCP Access Token…",
    category: "App",
    icon: "synchronize",
    run: regenerateToken,
  }),
  defineAction<AgentAccessArgs | undefined>({
    id: MCP_ACTION_IDS.setAccess,
    title: "Set AI Agent Access",
    category: "Database",
    run: (_context, args) => {
      if (args === undefined) return showSettings();
      return answered(bridge().setAgentAccess(args.datasourceId, args.access), "Could not change AI agent access");
    },
  }),
  defineAction<AgentPolicyArgs | undefined>({
    id: MCP_ACTION_IDS.setPolicy,
    title: "Set AI Agent Schemas and Row Limit",
    category: "Database",
    run: (_context, args) => {
      if (args === undefined) return showSettings();
      return answered(bridge().setAgentPolicy(args.datasourceId, args.policy), "Could not change AI agent access");
    },
  }),
  defineAction({
    id: MCP_ACTION_IDS.copyToken,
    title: "Copy MCP Access Token",
    category: "App",
    icon: "copy",
    run: copyToken,
  }),
  defineAction({
    id: MCP_ACTION_IDS.copyEndpoint,
    title: "Copy MCP Endpoint",
    category: "App",
    icon: "copy",
    run: () => writeClipboard(mcpEndpoint(useSettings.getState().settings.mcp.port)),
  }),
  defineAction<McpKnownClient | undefined>({
    id: MCP_ACTION_IDS.decideClient,
    title: "Allow or Block Agent Client",
    category: "App",
    available: () => useMcp.getState().status.pendingClients.length > 0,
    run: (_context, decision) => {
      if (decision === undefined) return useMcp.getState().setPopover(true);
      return decideClient(decision);
    },
  }),
  defineAction<string | undefined>({
    id: MCP_ACTION_IDS.forgetClient,
    title: "Forget Agent Client",
    category: "App",
    available: () => useSettings.getState().settings.mcp.clients.length > 0,
    run: (_context, name) => {
      if (name === undefined) return showSettings();
      return setClients((clients) => clients.filter((client) => client.name !== name));
    },
  }),
  defineAction<string | undefined>({
    id: MCP_ACTION_IDS.cancel,
    title: "Cancel Agent Statement",
    category: "App",
    icon: "cancel",
    available: () => useMcp.getState().status.running.length > 0,
    run: (_context, runId) => {
      const target = runId ?? useMcp.getState().status.running[0]?.id;
      if (target === undefined) return undefined;
      return answered(bridge().mcpControl({ action: "cancel", runId: target }), "Could not cancel the statement");
    },
  }),
  defineAction<string | undefined>({
    id: MCP_ACTION_IDS.handOff,
    title: "Open Agent Request in Console",
    category: "App",
    icon: "newConsole",
    available: waiting,
    run: (_context, approvalId) => {
      const target = approvalId ?? useMcp.getState().status.approvals[0]?.id;
      return target === undefined ? undefined : handOff(target);
    },
  }),
  defineAction<McpConsoleRequest | undefined>({
    id: MCP_ACTION_IDS.openInConsole,
    title: "Open Agent Statement in Console",
    category: "App",
    icon: "newConsole",
    run: (_context, request) => {
      if (request === undefined) return showActivity();
      return openConsole(request.datasourceId, request.sql).then(() => useMcp.getState().setActivity(false));
    },
  }),
  defineAction({
    id: MCP_ACTION_IDS.activity,
    title: "Show Agent Activity",
    category: "App",
    icon: "history",
    run: showActivity,
  }),
  defineAction({
    id: MCP_ACTION_IDS.settings,
    title: "MCP Server Settings…",
    category: "App",
    icon: "agent",
    run: showSettings,
  }),
  defineAction<boolean | undefined>({
    id: MCP_ACTION_IDS.productionNote,
    title: "Toggle Red Data Source Warning",
    category: "App",
    // The palette passes no argument, so it flips the warning; the page's close and (i) say which.
    run: (_context, shown) => {
      const layout = useLayout.getState();
      layout.setProductionNote(shown ?? !layout.layout.productionNote);
    },
  }),
];
