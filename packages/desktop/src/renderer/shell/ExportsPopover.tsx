import { useEffect } from "react";
import { EXPORT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/exportActions.js";
import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { invoke, registry } from "@table-craft/desktop/renderer/actions/index.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import {
  EXPORT_OUTCOME,
  exportDetailText,
  exportNotes,
  exportPercent,
  exportPopoverEntries,
  fileNameOf,
} from "@table-craft/desktop/renderer/model/exportText.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { isRunning, useExports, type ExportEntry } from "@table-craft/desktop/renderer/state/exports.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { ACTION_ICONS } from "@table-craft/desktop/renderer/ui/icons.js";
import { OutcomeGlyph } from "@table-craft/desktop/renderer/ui/Outcome.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { ProgressBar } from "@table-craft/desktop/renderer/ui/ProgressBar.js";
import { useClock } from "@table-craft/desktop/renderer/ui/useClock.js";

const ROW_BUTTON =
  "press flex size-row shrink-0 items-center justify-center rounded text-ink-muted hover:bg-line hover:text-ink disabled:opacity-50";
/** Cancel ends work, so it reads red while it can be pressed, as the console's Cancel does. */
const CANCEL_BUTTON = cn(ROW_BUTTON, "enabled:text-danger");
const CANCELLING_LABEL = "Cancelling…";
const CANCEL_ALL_MIN = 2;

/** An icon button for one task, its glyph and tooltip taken from the action it invokes. */
function RowButton({
  actionId,
  taskId,
  testId,
  label,
  disabled = false,
  className = ROW_BUTTON,
}: {
  readonly actionId: string;
  readonly taskId: string;
  readonly testId: string;
  /** Replaces the action's title, as Cancel reads `Cancelling…` once pressed. */
  readonly label?: string;
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const action = registry.get(actionId);
  if (action === undefined) return null;
  const Icon = action.icon === undefined ? null : ACTION_ICONS[action.icon];
  const title = label ?? action.title;
  // A native title, not Tooltip: the popover focuses its first button on open, a Radix tooltip
  // would open on that focus and take the first Escape meant to close the popover.
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={title}
      title={title}
      className={className}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => invoke(actionId, { taskId })}
    >
      {Icon === null ? title : <Icon aria-hidden className="size-icon" />}
    </button>
  );
}

function ExportRow({ entry, now }: { readonly entry: ExportEntry; readonly now: number }) {
  const { task } = entry;
  const datasource = useDatasources((state) => datasourceById(state, entry.datasourceId)?.name ?? entry.datasourceId);
  const cancelling = useExports((state) => state.cancelling.has(task.taskId));
  const running = task.state === "running";
  const finished = !running;
  const notes = task.state === "done" ? exportNotes(task) : [];
  const failure = task.state === "failed" ? task.error : null;
  const detail = exportDetailText(task, now);
  return (
    <li
      data-testid="exports-popover-row"
      data-state={cancelling ? "cancelling" : task.state}
      className="flex min-w-0 flex-col gap-1 border-b border-line p-gap"
    >
      <div className="flex min-w-0 items-center gap-gap">
        <OutcomeGlyph outcome={EXPORT_OUTCOME[task.state]} />
        <span className="min-w-0 flex-1 truncate" title={task.path}>
          <span className="font-semibold">{fileNameOf(task.path)}</span>
          <span className="text-ink-muted"> · {datasource}</span>
        </span>
        {running ? (
          <RowButton
            actionId={EXPORT_ACTION_IDS.cancel}
            taskId={task.taskId}
            label={cancelling ? CANCELLING_LABEL : undefined}
            testId="exports-row-cancel"
            disabled={cancelling}
            className={CANCEL_BUTTON}
          />
        ) : null}
        {task.state === "done" ? (
          <RowButton actionId={EXPORT_ACTION_IDS.reveal} taskId={task.taskId} testId="exports-row-reveal" />
        ) : null}
        {finished && task.state !== "done" && task.retryable ? (
          <RowButton actionId={EXPORT_ACTION_IDS.retry} taskId={task.taskId} testId="exports-row-retry" />
        ) : null}
        {finished ? (
          <RowButton actionId={EXPORT_ACTION_IDS.dismiss} taskId={task.taskId} testId="exports-row-remove" />
        ) : null}
      </div>
      {running ? <ProgressBar percent={exportPercent(task)} className="mt-0.5 w-full" /> : null}
      {failure === null ? (
        <span data-testid="exports-row-detail" className="truncate text-label text-ink-muted tabular-nums">
          {cancelling ? `${CANCELLING_LABEL} ${detail}` : detail}
        </span>
      ) : (
        <span data-testid="exports-row-detail" className="whitespace-normal wrap-anywhere text-danger">
          {failure.message}
        </span>
      )}
      {task.warning !== null && running ? <span className="text-warning">{task.warning}</span> : null}
      {notes.map((note) => (
        <span key={note} className="text-ink-muted">
          {note}
        </span>
      ))}
    </li>
  );
}

function summaryOf(entries: readonly ExportEntry[], running: number): string {
  if (entries.length === 0) return "No exports";
  return running === 0 ? "Exports" : `Exports · ${formatCount(running)} running`;
}

/**
 * The Exports chip's popover (plan 138): what runs, with its rate, time left and Cancel, then what
 * finished this session, newest first. Closing it counts every failure as seen: until then the
 * chip, its anchor, keeps saying what failed.
 */
export function ExportsPopover({ anchor }: { readonly anchor: PopoverAnchor }) {
  const entries = useExports((state) => state.entries);
  const now = useClock();
  const rows = exportPopoverEntries(entries);
  const running = entries.filter(isRunning).length;

  useEffect(
    () => () => {
      const exports = useExports.getState();
      const failed = exports.entries.filter((entry) => entry.task.state === "failed").map((entry) => entry.task.taskId);
      if (failed.length > 0) exports.markSeen(failed);
    },
    [],
  );

  return (
    <Popover
      anchor={anchor}
      label="Exports"
      testId="exports-popover"
      onClose={() => useExports.getState().setPopover(false)}
    >
      <div className="flex min-h-0 w-status-popover max-w-full min-w-0 flex-col">
        <div className="border-b border-line p-gap font-semibold">{summaryOf(entries, running)}</div>
        {rows.length === 0 ? null : (
          <ul aria-label="Exports" className="flex min-h-0 min-w-0 flex-col overflow-y-auto">
            {rows.map((entry) => (
              <ExportRow key={entry.task.taskId} entry={entry} now={now} />
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1 px-gap py-cell">
          {running >= CANCEL_ALL_MIN ? <ActionButton actionId={EXPORT_ACTION_IDS.cancelAll} tone="danger" /> : null}
          <span className="ml-auto">
            <ActionButton actionId={ACTION_IDS.toggleServices} />
          </span>
        </div>
      </div>
    </Popover>
  );
}
