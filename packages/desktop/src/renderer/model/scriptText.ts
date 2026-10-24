import type { ExportTaskState, ScriptError, ScriptTask } from "@table-craft/desktop/engine/protocol.js";
import { fileNameOf } from "@table-craft/desktop/renderer/model/exportText.js";
import { formatBytes, formatCount, formatDuration } from "@table-craft/desktop/renderer/model/format.js";

const PERCENT = 100;

/** How a Services script line words its state. */
export const SCRIPT_STATE_TEXT: Readonly<Record<ExportTaskState, string>> = {
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

const ASKING_TEXT = "waiting on a failed statement";

/**
 * A script line's state: `running 41%`, `waiting on a failed statement` while it asks what to do
 * (decision 083), `done, 2 failed` when it went on past failures.
 */
export function scriptStateText(task: ScriptTask): string {
  if (task.state === "running") {
    if (task.question !== null) return ASKING_TEXT;
    const percent = scriptPercent(task);
    return percent === null ? SCRIPT_STATE_TEXT.running : `${SCRIPT_STATE_TEXT.running} ${String(percent)}%`;
  }
  if (task.failed === 0) return SCRIPT_STATE_TEXT[task.state];
  return `${SCRIPT_STATE_TEXT[task.state]}, ${formatCount(task.failed)} failed`;
}

/** The failure a script line shows and Go to statement lands on: the one it asks about, stopped at, or skipped last. */
export function scriptFailure(task: ScriptTask): ScriptError | null {
  return task.question ?? (task.error?.line == null ? null : task.error) ?? task.failures.at(-1) ?? null;
}

/** Every failure the task knows of, in the order they happened. */
export function scriptFailures(task: ScriptTask): readonly ScriptError[] {
  return [
    ...task.failures,
    ...(task.question === null ? [] : [task.question]),
    ...(task.error === null ? [] : [task.error]),
  ];
}

/** Whole percent of the files read; null when they are empty. */
export function scriptPercent(task: Pick<ScriptTask, "bytes" | "size">): number | null {
  if (task.size <= 0) return null;
  return Math.min(PERCENT, Math.floor((task.bytes / task.size) * PERCENT));
}

/** `orders.sql`, or `orders.sql (2 of 3)` while a task of several files runs. */
export function scriptName(task: ScriptTask): string {
  const name = fileNameOf(task.file);
  if (task.files.length < 2) return name;
  return `${name} (${String(task.files.indexOf(task.file) + 1)} of ${String(task.files.length)})`;
}

/** A script line's detail: `1,204 statements · 4.1 MB of 9.8 MB · 3.2 s`. */
export function scriptProgressText(task: ScriptTask): string {
  const statements = `${formatCount(task.statements)} ${task.statements === 1 ? "statement" : "statements"}`;
  return [statements, `${formatBytes(task.bytes)} of ${formatBytes(task.size)}`, formatDuration(task.elapsedMs)].join(
    " · ",
  );
}

/** The status bar's item while scripts run: `Running script · 41%` when one runs. */
export function scriptsRunningText(running: readonly ScriptTask[]): string {
  const only = running.length === 1 ? running[0] : undefined;
  if (only === undefined) return `Running ${formatCount(running.length)} scripts`;
  const percent = scriptPercent(only);
  return percent === null ? "Running script" : `Running script · ${String(percent)}%`;
}
