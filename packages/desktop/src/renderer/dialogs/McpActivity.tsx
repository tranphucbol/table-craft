import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useClock } from "@table-craft/desktop/renderer/ui/useClock.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { MCP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/mcpActions.js";
import { Button, CONTENT_CLASS, OVERLAY_CLASS, Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  approvalWaitText,
  firstLine,
  formatDuration,
  historyTime,
} from "@table-craft/desktop/renderer/model/format.js";
import {
  ALL_ACTIVITY,
  CALL_OUTCOME_LABELS,
  CALL_OUTCOME_TONES,
  activityClients,
  activityConsoleRequest,
  filteredActivity,
  type ActivityFilter,
} from "@table-craft/desktop/renderer/model/mcp.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useMcp } from "@table-craft/desktop/renderer/state/mcp.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import type { McpActivityView, McpCallOutcome } from "@table-craft/desktop/settings/mcp.js";

const ANY = "";
const OUTCOMES = Object.keys(CALL_OUTCOME_LABELS) as McpCallOutcome[];

const TONE_TEXT: Readonly<Record<(typeof CALL_OUTCOME_TONES)[McpCallOutcome], string>> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-ink-muted",
};

const COLUMNS = ["Time", "Client", "Tool", "Data source", "Statement or target", "Rows", "Duration", "Outcome"];
const CELL = "px-cell py-0.5 text-left align-top whitespace-nowrap";

function ActivityRow({ entry, now }: { readonly entry: McpActivityView; readonly now: number }) {
  const datasource = useDatasources((state) =>
    entry.datasourceId === null ? null : (datasourceById(state, entry.datasourceId)?.name ?? entry.datasourceId),
  );
  const request = activityConsoleRequest(entry);
  return (
    <tr
      data-testid="mcp-activity-row"
      data-outcome={entry.outcome}
      className={cn("border-b border-line", request !== null && "cursor-default hover:bg-raised")}
      title={request === null ? (entry.message ?? undefined) : "Double-click to open in a console"}
      onDoubleClick={() => {
        if (request !== null) invoke(MCP_ACTION_IDS.openInConsole, request);
      }}
    >
      <td className={cn(CELL, "text-ink-muted")}>{historyTime(entry.at, now)}</td>
      <td className={CELL}>{entry.clientName}</td>
      <td className={cn(CELL, "font-ui")}>{entry.tool}</td>
      <td className={CELL}>{datasource ?? "—"}</td>
      <td className={cn(CELL, "max-w-64 truncate font-grid")}>
        {entry.target === null ? "—" : firstLine(entry.target)}
      </td>
      <td className={cn(CELL, "text-right tabular-nums")}>{entry.rowCount === null ? "—" : String(entry.rowCount)}</td>
      <td
        data-testid="mcp-activity-duration"
        className={cn(CELL, "text-right tabular-nums")}
        title={approvalWaitText(entry.approvalWaitMs) ?? undefined}
      >
        {formatDuration(entry.durationMs)}
        {entry.approvalWaitMs > 0 ? (
          <span className="text-ink-muted"> +{formatDuration(entry.approvalWaitMs)} approval</span>
        ) : null}
      </td>
      <td className={cn(CELL, TONE_TEXT[CALL_OUTCOME_TONES[entry.outcome]])}>
        {CALL_OUTCOME_LABELS[entry.outcome]}
        {entry.message === null || entry.outcome === "ok" ? null : (
          <span className="block max-w-48 truncate text-ink-muted" title={entry.message}>
            {entry.message}
          </span>
        )}
      </td>
    </tr>
  );
}

function Activity() {
  const activity = useMcp((state) => state.status.activity);
  const [filter, setFilter] = useState<ActivityFilter>(ALL_ACTIVITY);
  const shown = filteredActivity(activity, filter);
  const now = useClock();
  return (
    <div className="flex h-full min-h-0 flex-col gap-gap p-gap">
      <Dialog.Title className="font-semibold">Agent Activity</Dialog.Title>
      <div className="flex items-center gap-gap">
        <Select
          label="Client"
          testId="mcp-activity-client"
          value={filter.client ?? ANY}
          options={[
            { label: "All clients", value: ANY },
            ...activityClients(activity).map((name) => ({ label: name, value: name })),
          ]}
          onChange={(client) => setFilter({ ...filter, client: client === ANY ? null : client })}
        />
        <Select
          label="Outcome"
          testId="mcp-activity-outcome"
          value={filter.outcome ?? ANY}
          options={[
            { label: "Any outcome", value: ANY },
            ...OUTCOMES.map((outcome) => ({ label: CALL_OUTCOME_LABELS[outcome], value: outcome })),
          ]}
          onChange={(outcome) =>
            setFilter({ ...filter, outcome: outcome === ANY ? null : (outcome as McpCallOutcome) })
          }
        />
        <span className="flex-1 text-right text-ink-muted">
          {String(shown.length)} of {String(activity.length)} calls since the server started
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded border border-line bg-canvas">
        {shown.length === 0 ? (
          <p className="p-gap text-ink-muted">
            {activity.length === 0 ? "No agent has called a tool yet." : "No call matches these filters."}
          </p>
        ) : (
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line">
                {COLUMNS.map((column) => (
                  <th key={column} className={cn(CELL, "font-semibold text-ink-muted")}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} now={now} />
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex justify-end">
        <Dialog.Close asChild>
          <Button variant="primary">Close</Button>
        </Dialog.Close>
      </div>
    </div>
  );
}

/** Every tool call agents made since the MCP server started, newest first (plan 117). */
export function McpActivityDialog() {
  const open = useMcp((state) => state.activityOpen);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => useMcp.getState().setActivity(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="mcp-activity"
          className={cn(CONTENT_CLASS, "h-dialog-height w-dialog max-w-[95vw]")}
        >
          {open ? <Activity /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
