import { useLayoutEffect, useRef, useState } from "react";
import { useClock } from "@table-craft/desktop/renderer/ui/useClock.js";
import { invoke, useActionAvailable } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import {
  CALL_OUTCOME_LABELS,
  connectedFor,
  countdown,
  mcpChip,
  mcpStatusText,
  type McpChipTone,
} from "@table-craft/desktop/renderer/model/mcp.js";
import { approvalWaitText } from "@table-craft/desktop/renderer/model/format.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import type {
  McpCallView,
  McpClientView,
  McpKnownClient,
  McpPendingClient,
} from "@table-craft/desktop/settings/mcp.js";

const ROW_BUTTON = "h-row shrink-0 rounded border border-line px-gap hover:bg-raised";

const TONE_CLASSES: Readonly<Record<McpChipTone, string>> = {
  off: "text-ink-muted hover:bg-raised",
  running: "text-ink hover:bg-raised",
  waiting: "border border-warning text-warning hover:bg-raised",
  failed: "border border-danger text-danger hover:bg-raised",
};

const DOT_CLASSES: Readonly<Record<McpChipTone, string>> = {
  off: "border border-ink-muted",
  running: "bg-success",
  waiting: "bg-warning",
  failed: "bg-danger",
};

function PopoverAction({ actionId }: { readonly actionId: string }) {
  return useActionAvailable(actionId) ? <ActionButton actionId={actionId} /> : null;
}

function LastCall({ call }: { readonly call: McpCallView }) {
  const name = useDatasources((state) =>
    call.datasourceId === null ? null : (datasourceById(state, call.datasourceId)?.name ?? call.datasourceId),
  );
  return (
    <span
      className={cn("truncate font-grid", call.outcome === "ok" ? "text-ink-muted" : "text-warning")}
      title={approvalWaitText(call.approvalWaitMs) ?? undefined}
    >
      {call.tool}
      {name === null ? "" : ` · ${name}`} · {String(call.durationMs)} ms · {CALL_OUTCOME_LABELS[call.outcome]}
    </span>
  );
}

function ClientRow({ client, now }: { readonly client: McpClientView; readonly now: number }) {
  return (
    <li data-testid="mcp-client" className="flex min-w-0 items-center gap-gap">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">
          {client.name}
          {client.version === "" ? null : <span className="text-ink-muted"> {client.version}</span>}
          <span className="text-ink-muted"> · connected {connectedFor(client.connectedAt, now)}</span>
        </span>
        {client.lastCall === null ? (
          <span className="text-ink-muted">No calls yet</span>
        ) : (
          <LastCall call={client.lastCall} />
        )}
      </div>
      <button type="button" className={ROW_BUTTON} onClick={() => invoke(MCP_ACTION_IDS.disconnect, client.id)}>
        Disconnect
      </button>
    </li>
  );
}

function PendingClientRow({ client, now }: { readonly client: McpPendingClient; readonly now: number }) {
  const decide = (allowed: boolean) =>
    invoke(MCP_ACTION_IDS.decideClient, { name: client.name, allowed } satisfies McpKnownClient);
  return (
    <li data-testid="mcp-pending-client" className="flex min-w-0 items-center gap-gap">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-warning">
          {client.name}
          {client.version === "" ? null : <span className="text-ink-muted"> {client.version}</span>} wants to connect
        </span>
        <span className="text-ink-muted">Refused automatically in {countdown(client.deadline, now)}</span>
      </div>
      <button type="button" data-testid="mcp-block-client" className={ROW_BUTTON} onClick={() => decide(false)}>
        Block
      </button>
      <button
        type="button"
        data-testid="mcp-allow-client"
        className="h-row shrink-0 rounded bg-accent px-gap text-accent-ink"
        onClick={() => decide(true)}
      >
        Allow
      </button>
    </li>
  );
}

function McpPopover({ anchor }: { readonly anchor: PopoverAnchor }) {
  const status = useMcp((state) => state.status);
  const waiting = status.approvals.length;
  const now = useClock();
  return (
    <Popover
      anchor={anchor}
      label="MCP server"
      testId="mcp-popover"
      onClose={() => useMcp.getState().setPopover(false)}
    >
      <div className="flex min-w-0 flex-col gap-gap p-gap">
        <div className="font-semibold">{mcpStatusText(status)}</div>
        {status.message === null ? null : (
          <p className="max-w-popover whitespace-normal wrap-anywhere text-danger">{status.message}</p>
        )}
        {waiting === 0 ? null : (
          <button
            type="button"
            data-testid="mcp-review"
            className="h-row rounded border border-warning px-gap text-left text-warning hover:bg-raised"
            onClick={() => invoke(MCP_ACTION_IDS.approvals)}
          >
            {waiting === 1
              ? "1 agent request is waiting: review"
              : `${String(waiting)} agent requests are waiting: review`}
          </button>
        )}
        {status.pendingClients.length === 0 ? null : (
          <ul aria-label="Clients asking to connect" className="flex min-w-0 flex-col gap-cell">
            {status.pendingClients.map((client) => (
              <PendingClientRow key={client.name} client={client} now={now} />
            ))}
          </ul>
        )}
        {status.clients.length === 0 ? null : (
          <ul aria-label="Connected clients" className="flex min-w-0 flex-col gap-cell">
            {status.clients.map((client) => (
              <ClientRow key={client.id} client={client} now={now} />
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-1">
          {status.state === "running" ? null : <ActionButton actionId={MCP_ACTION_IDS.toggle} />}
          <PopoverAction actionId={MCP_ACTION_IDS.pause} />
          <PopoverAction actionId={MCP_ACTION_IDS.resume} />
          <ActionButton actionId={MCP_ACTION_IDS.activity} />
          <ActionButton actionId={MCP_ACTION_IDS.settings} />
        </div>
      </div>
    </Popover>
  );
}

/**
 * The MCP chip at the right of the status bar (plan 117): grey while off, green while running,
 * amber while an agent or a new client waits for an answer or agents are paused, red when the
 * server could not start. A click opens the popover; nothing opens on its own (decision 127).
 */
export function McpStatusChip() {
  const status = useMcp((state) => state.status);
  const open = useMcp((state) => state.popoverOpen);
  const view = mcpChip(status);
  const button = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);

  useLayoutEffect(() => {
    if (!open || button.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="status-mcp"
        data-tone={view.tone}
        title={view.tooltip}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn("flex h-full items-center gap-1 rounded px-1 whitespace-nowrap", TONE_CLASSES[view.tone])}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => invoke(status.approvals.length > 0 && !open ? MCP_ACTION_IDS.approvals : MCP_ACTION_IDS.show)}
      >
        <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_CLASSES[view.tone])} />
        {view.label}
      </button>
      {open && anchor !== null ? <McpPopover anchor={anchor} /> : null}
    </>
  );
}
