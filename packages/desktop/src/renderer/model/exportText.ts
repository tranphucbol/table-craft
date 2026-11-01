import type { ExportTask, ExportTaskState } from "@table-craft/desktop/engine/protocol.js";
import { formatBytes, formatClock, formatCount, formatDuration } from "@table-craft/desktop/renderer/model/format.js";
import type { ExecutionOutcome } from "@table-craft/desktop/renderer/state/executions.js";
import type { ExportEntry } from "@table-craft/desktop/renderer/state/exports.js";

const PERCENT = 100;
const PATH_SEPARATOR = /[\\/]/;

/** An export's state as the outcome glyph Services and the Exports popover draw. */
export const EXPORT_OUTCOME: Readonly<Record<ExportTaskState, ExecutionOutcome>> = {
  running: "running",
  done: "success",
  failed: "error",
  cancelled: "cancelled",
};

/** How a Services export line words its state. */
export const EXPORT_STATE_TEXT: Readonly<Record<ExportTaskState, string>> = {
  running: "exporting",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** The file's name without its folder: what an export line shows, the full path in its tooltip. */
export function fileNameOf(path: string): string {
  return path.split(PATH_SEPARATOR).pop() ?? path;
}

/** Whole percent of the estimate, or null when there is none to measure against. */
export function exportPercent(task: Pick<ExportTask, "rows" | "estimate">): number | null {
  if (task.estimate === null || task.estimate <= 0) return null;
  return Math.min(PERCENT, Math.floor((task.rows / task.estimate) * PERCENT));
}

/**
 * An export line's detail: `12,345 of 50,000 rows · 4.1 MB · 3.2 s` while running against an
 * estimate, `12,345 rows · 4.1 MB · 3.2 s` otherwise.
 */
export function exportProgressText(task: ExportTask): string {
  const rows =
    task.state === "running" && task.estimate !== null
      ? `${formatCount(task.rows)} of ${formatCount(task.estimate)} rows`
      : `${formatCount(task.rows)} ${task.rows === 1 ? "row" : "rows"}`;
  // A failed or cancelled export removed its file, so it names the rows it reached and no size.
  if (task.state === "failed" || task.state === "cancelled") {
    return [`${rows} before it stopped`, formatDuration(task.elapsedMs)].join(" · ");
  }
  return [rows, formatBytes(task.bytes), formatDuration(task.elapsedMs)].join(" · ");
}

/** What else a finished export says: the warning, cells cut to fit, bytes shown as previews. */
export function exportNotes(task: ExportTask): readonly string[] {
  const notes: string[] = [];
  if (task.warning !== null) notes.push(task.warning);
  if (task.sheets > 1) notes.push(`${formatCount(task.sheets)} sheets`);
  if (task.truncatedCells > 0) notes.push(`${formatCount(task.truncatedCells)} cells cut to the format's limit`);
  if (task.clippedBytes > 0) {
    notes.push(
      `${formatCount(task.clippedBytes)} binary values exported as previews; export the table for full values`,
    );
  }
  return notes;
}

/** How long the chip keeps a finished export in view once nothing else runs. */
export const EXPORT_DONE_FLASH_MS = 8_000;
/** Before this, the first burst of rows would promise a time left the export cannot keep. */
export const ETA_MIN_ELAPSED_MS = 3_000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

export type ExportChipTone = "running" | "done" | "failed";

/** What the status bar's Exports chip draws. */
export interface ExportChipView {
  readonly tone: ExportChipTone;
  readonly label: string;
  readonly tooltip: string;
  /** 0..100, or null for an indeterminate bar; only drawn while running. */
  readonly percent: number | null;
  /** The oldest running task's start, which the chip's clock counts from; null once none runs. */
  readonly startedAt: number | null;
  /** The one task the chip's Cancel stops; null with several or none running. */
  readonly cancelTaskId: string | null;
  readonly cancelling: boolean;
}

export interface ExportChipState {
  readonly cancelling: ReadonlySet<string>;
  /** Failed tasks the user has looked at in the popover. */
  readonly seen: ReadonlySet<string>;
}

/** `1 row`, `412,300 rows`. */
export function exportRowsText(rows: number): string {
  return `${formatCount(rows)} ${rows === 1 ? "row" : "rows"}`;
}

function elapsedOf(task: ExportTask, now: number): number {
  return task.state === "running" ? now - task.startedAt : task.elapsedMs;
}

function runningTooltip(task: ExportTask): string {
  const rows =
    task.estimate === null
      ? exportRowsText(task.rows)
      : `${formatCount(task.rows)} of ${formatCount(task.estimate)} rows`;
  return `${task.path}\n${rows} · ${formatBytes(task.bytes)}`;
}

function combinedPercent(running: readonly ExportTask[]): number | null {
  if (running.some((task) => task.estimate === null || task.estimate <= 0)) return null;
  const rows = running.reduce((sum, task) => sum + task.rows, 0);
  const estimate = running.reduce((sum, task) => sum + (task.estimate ?? 0), 0);
  return exportPercent({ rows, estimate });
}

function runningChip(running: readonly ExportEntry[], cancelling: ReadonlySet<string>): ExportChipView {
  const tasks = running.map((entry) => entry.task);
  const startedAt = Math.min(...tasks.map((task) => task.startedAt));
  const percent = combinedPercent(tasks);
  const [only] = tasks;
  if (tasks.length === 1 && only !== undefined) {
    const name = fileNameOf(only.path);
    const stopping = cancelling.has(only.taskId);
    const progress = percent === null ? exportRowsText(only.rows) : `${String(percent)}%`;
    return {
      tone: "running",
      label: stopping ? `Cancelling ${name}…` : `${name} · ${progress}`,
      tooltip: `${runningTooltip(only)}\nClick for details`,
      percent,
      startedAt,
      cancelTaskId: only.taskId,
      cancelling: stopping,
    };
  }
  const count = `${formatCount(tasks.length)} exports`;
  return {
    tone: "running",
    label: percent === null ? count : `${count} · ${String(percent)}%`,
    tooltip: `${tasks.map((task) => fileNameOf(task.path)).join("\n")}\nClick for details`,
    percent,
    startedAt,
    cancelTaskId: null,
    cancelling: false,
  };
}

/**
 * The Exports chip (plan 138): what runs, with its own Cancel when only one does; else a failure
 * not yet looked at; else an export done within `EXPORT_DONE_FLASH_MS`; else nothing.
 */
export function exportChip(
  entries: readonly ExportEntry[],
  state: ExportChipState,
  now: number,
): ExportChipView | null {
  const running = entries.filter((entry) => entry.task.state === "running");
  if (running.length > 0) return runningChip(running, state.cancelling);
  const failed = entries.filter((entry) => entry.task.state === "failed" && !state.seen.has(entry.task.taskId));
  const [firstFailed] = failed;
  if (firstFailed !== undefined) {
    return {
      tone: "failed",
      label:
        failed.length === 1
          ? `Export failed · ${fileNameOf(firstFailed.task.path)}`
          : `${formatCount(failed.length)} exports failed`,
      tooltip: `${failed.map((entry) => entry.task.error?.message ?? fileNameOf(entry.task.path)).join("\n")}\nClick for details`,
      percent: null,
      startedAt: null,
      cancelTaskId: null,
      cancelling: false,
    };
  }
  const done = newestFinished(entries.filter((entry) => entry.task.state === "done"));
  if (done === undefined || done.finishedAt === null || now - done.finishedAt >= EXPORT_DONE_FLASH_MS) return null;
  const { task } = done;
  return {
    tone: "done",
    label: `${fileNameOf(task.path)} · ${exportRowsText(task.rows)} · ${formatDuration(task.elapsedMs)}`,
    tooltip: `${task.path}\n${exportProgressText(task)}\nClick for details`,
    percent: null,
    startedAt: null,
    cancelTaskId: null,
    cancelling: false,
  };
}

function newestFinished(entries: readonly ExportEntry[]): ExportEntry | undefined {
  return [...entries].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
}

/** When the chip's done flash ends, so it can re-render then; null when nothing flashes. */
export function exportFlashEndsAt(entries: readonly ExportEntry[]): number | null {
  if (entries.some((entry) => entry.task.state === "running")) return null;
  const done = newestFinished(entries.filter((entry) => entry.task.state === "done"));
  return done?.finishedAt == null ? null : done.finishedAt + EXPORT_DONE_FLASH_MS;
}

/** Running first in the order they started, then finished ones newest first: the popover's rows. */
export function exportPopoverEntries(entries: readonly ExportEntry[]): readonly ExportEntry[] {
  const running = entries.filter((entry) => entry.task.state === "running");
  const finished = [...entries.filter((entry) => entry.task.state !== "running")].sort(
    (a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0),
  );
  return [...running, ...finished];
}

/** Rows a second so far, or null before there is a second to measure. */
export function exportRate(task: ExportTask, now: number): number | null {
  const elapsed = elapsedOf(task, now);
  if (elapsed < MS_PER_SECOND || task.rows === 0) return null;
  return task.rows / (elapsed / MS_PER_SECOND);
}

/** `about 3 min left`, `less than a minute left`, or null without an estimate or enough time to judge. */
export function exportTimeLeft(task: ExportTask, now: number): string | null {
  if (task.state !== "running" || task.estimate === null || task.estimate <= task.rows) return null;
  if (now - task.startedAt < ETA_MIN_ELAPSED_MS) return null;
  const rate = exportRate(task, now);
  if (rate === null || rate <= 0) return null;
  const minutes = (task.estimate - task.rows) / rate / SECONDS_PER_MINUTE;
  return minutes < 1 ? "less than a minute left" : `about ${formatCount(Math.round(minutes))} min left`;
}

/**
 * A popover row's detail. Running: `412,300 of 1,000,000 rows · 118 MB · 3,240 rows/s · 1:42 · about
 * 3 min left`; finished: as Services words it.
 */
export function exportDetailText(task: ExportTask, now: number): string {
  if (task.state !== "running") return exportProgressText(task);
  const rows =
    task.estimate === null
      ? exportRowsText(task.rows)
      : `${formatCount(task.rows)} of ${formatCount(task.estimate)} rows`;
  const rate = exportRate(task, now);
  return [
    rows,
    formatBytes(task.bytes),
    rate === null ? null : `${formatCount(Math.round(rate))} rows/s`,
    formatClock(now - task.startedAt),
    exportTimeLeft(task, now),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
