import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { formatDuration } from "@table-craft/desktop/renderer/model/format.js";
import type { AgentClientGroup, AgentDatasourceGroup } from "@table-craft/desktop/renderer/model/mcp.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { AgentIcon, DatabaseIcon, SpinnerIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import type { McpRunView } from "@table-craft/desktop/settings/mcp.js";

function firstLine(text: string): string {
  return text.trimStart().split("\n", 1)[0] ?? "";
}

function useDatasourceName(datasourceId: string): string {
  return useDatasources((state) => state.datasources.find((view) => view.id === datasourceId)?.name ?? datasourceId);
}

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

export function AgentClientLine({ client }: { readonly client: AgentClientGroup }) {
  const running = client.datasources.reduce((total, group) => total + group.runs.length, 0);
  return (
    <>
      <span className="truncate">{client.clientName}</span>
      <span className="text-ink-muted">{running === 0 ? "idle" : `${String(running)} running`}</span>
    </>
  );
}

export function AgentDatasourceLine({ group }: { readonly group: AgentDatasourceGroup }) {
  const name = useDatasourceName(group.datasourceId);
  return (
    <>
      <DatabaseIcon aria-hidden className="size-icon shrink-0 text-accent" />
      <span className="truncate">{name}</span>
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
