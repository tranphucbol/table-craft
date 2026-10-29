import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import {
  approvalWaitText,
  clockTime,
  firstLine,
  formatDuration,
  rowsText,
} from "@table-craft/desktop/renderer/model/format.js";
import {
  CALL_EXECUTION_OUTCOMES,
  CALL_OUTCOME_LABELS,
  type AgentClientGroup,
  type AgentDatasourceGroup,
} from "@table-craft/desktop/renderer/model/mcp.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { DatasourceGlyph, useDatasourceBrand } from "@table-craft/desktop/renderer/ui/brandIcons.js";
import { AgentIcon, SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { OutcomeGlyph } from "@table-craft/desktop/renderer/ui/Outcome.js";
import type { McpActivityView, McpRunView } from "@table-craft/desktop/settings/mcp.js";

export function agentRunLabel(run: McpRunView): string {
  return `${run.tool}, ${firstLine(run.sql)}`;
}

export function AgentsLine({ count }: { readonly count: number }) {
  return (
    <>
      <AgentIcon aria-hidden className="size-icon shrink-0 text-accent" />
      <span className="truncate">Agents</span>
      <span className="text-ink-muted tabular-nums">{count}</span>
    </>
  );
}

function clientState(client: AgentClientGroup): string {
  const running = client.datasources.reduce((total, group) => total + group.runs.length, 0);
  if (running > 0) return `${String(running)} running`;
  return client.connected ? "idle" : "disconnected";
}

export function agentClientLabel(client: AgentClientGroup): string {
  return `${client.clientName}, ${clientState(client)}`;
}

export function AgentClientLine({ client }: { readonly client: AgentClientGroup }) {
  return (
    <>
      <span className="truncate">{client.clientName}</span>
      <span className="text-ink-muted">{clientState(client)}</span>
    </>
  );
}

export function agentCallLabel(call: McpActivityView): string {
  const target = call.target === null ? "" : `, ${firstLine(call.target)}`;
  return `${call.tool}${target}, ${CALL_OUTCOME_LABELS[call.outcome]}`;
}

/** A finished tool call, kept like a console execution: outcome, tool, statement or target, rows, time. */
export function AgentCallLine({ call }: { readonly call: McpActivityView }) {
  return (
    <>
      <OutcomeGlyph outcome={CALL_EXECUTION_OUTCOMES[call.outcome]} />
      <span className="shrink-0 text-ink-muted">{call.tool}</span>
      <span className="min-w-0 truncate font-editor text-editor" title={call.message ?? call.target ?? undefined}>
        {call.target === null ? "" : firstLine(call.target)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-cell text-ink-muted tabular-nums">
        {call.outcome === "ok" || call.outcome === "capped" ? null : <span>{CALL_OUTCOME_LABELS[call.outcome]}</span>}
        {call.rowCount === null ? null : <span>{rowsText(call.rowCount)}</span>}
        <span title={approvalWaitText(call.approvalWaitMs) ?? undefined}>{formatDuration(call.durationMs)}</span>
        <span>{clockTime(call.at)}</span>
      </span>
    </>
  );
}

export function AgentDatasourceLine({ group }: { readonly group: AgentDatasourceGroup }) {
  const { datasourceId } = group;
  const view = useDatasources((state) => datasourceById(state, datasourceId));
  const brand = useDatasourceBrand({ id: datasourceId, pluginId: view?.pluginId ?? "", brand: view?.brand });
  return (
    <>
      <DatasourceGlyph brand={brand} className="size-icon shrink-0" />
      <span className="truncate">{view?.name ?? datasourceId}</span>
    </>
  );
}

/** One tool call an agent has running (decision 127): its statement, elapsed time and Cancel. */
export function AgentRunLine({ run, now }: { readonly run: McpRunView; readonly now: number }) {
  return (
    <>
      <SpinnerIcon aria-hidden className="size-icon shrink-0 animate-spin text-accent" />
      <span className="shrink-0 text-ink-muted">{run.tool}</span>
      <span className="min-w-0 truncate font-editor text-editor" title={run.sql}>
        {firstLine(run.sql)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-cell text-ink-muted tabular-nums">
        <span>{formatDuration(Math.max(0, now - run.startedAt))}</span>
        {run.cancellable ? (
          <button
            type="button"
            tabIndex={-1}
            data-action={MCP_ACTION_IDS.cancel}
            className="rounded px-1 text-accent hover:bg-raised"
            onClick={(event) => {
              event.stopPropagation();
              invoke(MCP_ACTION_IDS.cancel, run.id);
            }}
          >
            Cancel
          </button>
        ) : null}
      </span>
    </>
  );
}
