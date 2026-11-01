import { randomBytes } from "node:crypto";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import {
  byteSize,
  ExportError,
  exportEncoder,
  nodeSinkFiles,
  openFileSink,
  project,
  runExport,
  systemClock,
  type ExportClock,
  type ExportEncoderOptions,
  type SinkFiles,
} from "@table-craft/core";
import type { Column, Row } from "@table-craft/plugin-api";
import type { Logger } from "@table-craft/desktop/log/record.js";
import type {
  EngineErrorCode,
  ExportEvent,
  ExportEventType,
  ExportFailureReason,
  ExportFormat,
  ExportOrigin,
  ExportTask,
} from "@table-craft/desktop/engine/protocol.js";

/** Below this much free space at the target the task carries a warning; it still runs. */
export const LOW_DISK_BYTES = 1024 ** 3;
/** How long a finished export waits for its connection to close before it reports anyway. */
const SOURCE_CLOSE_GRACE_MS = 5_000;
const TASK_PREFIX = "export-";
/** Random bytes in a task id, so a `.part` file left by a crashed run never collides with a new one. */
const TASK_ID_RANDOM_BYTES = 4;
const UNEXPECTED_HINT = "This is a TableCraft bug; restart the app and report it.";

/** The rows an export reads and how to let go of their connection; `close` settles in bounded time. */
export interface ExportRows {
  readonly rows: AsyncIterable<Row>;
  close(): Promise<void>;
}

/** Everything a task needs to run, and to run again on Retry. */
export interface ExportJob {
  readonly path: string;
  readonly format: ExportFormat;
  readonly origin: ExportOrigin;
  /** The columns written, in order, as the header describes them. */
  readonly columns: readonly Column[];
  /** Indices of `columns` within each source row; null when the source reads exactly them. */
  readonly projection: readonly number[] | null;
  readonly estimate: number | null;
  readonly encoder: ExportEncoderOptions;
  /** Re-run and table jobs can open their rows again; memory and cursor jobs cannot. */
  readonly retryable: boolean;
  readonly drains: string | null;
  open(): Promise<ExportRows>;
}

export type ExportListener = (event: ExportEvent) => void;

export interface ExportTasks {
  start(job: ExportJob, stallMs: number): ExportTask;
  get(taskId: string): ExportTask | undefined;
  cancel(taskId: string): void;
  /** Runs a finished task's job again as a new task; the caller checks it is retryable. */
  retry(taskId: string, stallMs: number): ExportTask;
  list(): ExportTask[];
  /** Every event goes to every subscriber; the returned function unsubscribes. */
  subscribe(listener: ExportListener): () => void;
  /** Resolves once no task runs, including tasks started while it waited. */
  settled(): Promise<void>;
  /** Cancels what runs and waits for each `.part` file to be removed. */
  close(): Promise<void>;
}

export interface ExportTasksOptions {
  readonly clock?: ExportClock;
  readonly files?: SinkFiles;
  /** Free bytes in a folder; null when the platform cannot tell. */
  readonly freeBytes?: (folder: string) => Promise<number | null>;
  /** How each task ended, never its rows or the statement (decision 038); silent when absent. */
  readonly log?: Pick<Logger, "info" | "warn">;
}

interface Running {
  task: ExportTask;
  readonly job: ExportJob;
  readonly controller: AbortController;
  done: Promise<void>;
}

async function systemFreeBytes(folder: string): Promise<number | null> {
  try {
    const stats = await statfs(folder);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

const ERROR_CODES: Readonly<Record<ExportFailureReason, EngineErrorCode>> = {
  stalled: "timedOut",
  cancelled: "cancelled",
  diskFull: "exportFailed",
  file: "exportFailed",
  source: "exportFailed",
};

function failureOf(cause: unknown, rows: number): NonNullable<ExportTask["error"]> {
  const error =
    cause instanceof ExportError
      ? cause
      : new ExportError("source", cause instanceof Error ? cause.message : String(cause), UNEXPECTED_HINT, rows);
  return { code: ERROR_CODES[error.reason], message: error.message, hint: error.hint, reason: error.reason };
}

async function* projected(rows: AsyncIterable<Row>, indices: readonly number[] | null): AsyncGenerator<Row> {
  if (indices === null) {
    yield* rows;
    return;
  }
  for await (const row of rows) yield project(row, indices);
}

function withinGrace(pending: Promise<void>, clock: ExportClock): Promise<void> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(resolve, SOURCE_CLOSE_GRACE_MS);
    void pending.finally(() => {
      clock.clearTimeout(timer);
      resolve();
    });
  });
}

const SILENT: Pick<Logger, "info" | "warn"> = { info: () => undefined, warn: () => undefined };

/**
 * The engine's export tasks (decision 040). One table for the whole engine, not per renderer
 * port, so a reloaded window finds its exports still running.
 */
export function exportTasks(options: ExportTasksOptions = {}): ExportTasks {
  const clock = options.clock ?? systemClock;
  const files = options.files ?? nodeSinkFiles;
  const freeBytes = options.freeBytes ?? systemFreeBytes;
  const log = options.log ?? SILENT;
  const tasks = new Map<string, Running>();
  const listeners = new Set<ExportListener>();
  let next = 1;

  function emit(type: ExportEventType, task: ExportTask): void {
    const event: ExportEvent = { id: null, type, task };
    for (const listener of listeners) listener(event);
  }

  function newTaskId(): string {
    return `${TASK_PREFIX}${String(next++)}-${randomBytes(TASK_ID_RANDOM_BYTES).toString("hex")}`;
  }

  async function lowDiskWarning(path: string): Promise<string | null> {
    const folder = dirname(path);
    const free = await freeBytes(folder);
    if (free === null || free >= LOW_DISK_BYTES) return null;
    return `Only ${byteSize(free)} free in ${folder}; the export stops if the disk fills.`;
  }

  async function run(entry: Running, stallMs: number): Promise<void> {
    const { job, controller } = entry;
    const { taskId } = entry.task;
    const started = clock.now();
    let opened: ExportRows | null = null;
    let finished = false;
    let closing: Promise<void> | null = null;
    const closeSource = (): Promise<void> => {
      closing ??= opened === null ? Promise.resolve() : opened.close().catch(() => undefined);
      return closing;
    };
    const update = (patch: Partial<ExportTask>): void => {
      entry.task = { ...entry.task, ...patch };
    };

    let outcome: { type: ExportEventType; patch: Partial<ExportTask> };
    try {
      update({ warning: await lowDiskWarning(job.path) });
      const sink = await openFileSink(job.path, taskId, files);
      const result = await runExport({
        rows: async () => {
          const rows = await job.open();
          // A connect that answered after the export gave up is closed, not leaked.
          if (finished) void rows.close().catch(() => undefined);
          opened = rows;
          return projected(rows.rows, job.projection);
        },
        encoder: exportEncoder(job.format, job.columns, job.encoder),
        sink,
        signal: controller.signal,
        stallMs,
        clock,
        onProgress: (progress) => {
          update(progress);
          emit("export.progress", entry.task);
        },
        onStall: () => void closeSource(),
      });
      outcome = { type: "export.done", patch: { ...result, state: "done" } };
    } catch (cause) {
      const rows = cause instanceof ExportError ? cause.rows : entry.task.rows;
      const error = failureOf(cause, rows);
      const cancelled = error.reason === "cancelled";
      outcome = {
        type: cancelled ? "export.cancelled" : "export.failed",
        patch: { state: cancelled ? "cancelled" : "failed", rows, bytes: 0, error },
      };
    } finally {
      finished = true;
    }
    await withinGrace(closeSource(), clock);
    update({ ...outcome.patch, elapsedMs: clock.now() - started });
    const { task } = entry;
    const fields = {
      taskId,
      format: task.format,
      origin: task.origin,
      rows: task.rows,
      bytes: task.bytes,
      elapsedMs: task.elapsedMs,
    };
    if (task.state === "done") log.info("export finished", { ...fields, sheets: task.sheets });
    else if (task.state === "cancelled") log.info("export cancelled", fields);
    else log.warn("export failed", { ...fields, reason: task.error?.reason, error: task.error?.message });
    emit(outcome.type, task);
  }

  function start(job: ExportJob, stallMs: number): ExportTask {
    const taskId = newTaskId();
    const entry: Running = {
      job,
      controller: new AbortController(),
      done: Promise.resolve(),
      task: {
        taskId,
        path: job.path,
        format: job.format,
        origin: job.origin,
        state: "running",
        rows: 0,
        bytes: 0,
        elapsedMs: 0,
        startedAt: clock.now(),
        estimate: job.estimate,
        sheets: 0,
        truncatedCells: 0,
        clippedBytes: 0,
        warning: null,
        error: null,
        retryable: job.retryable,
        drains: job.drains,
      },
    };
    tasks.set(taskId, entry);
    entry.done = run(entry, stallMs);
    return entry.task;
  }

  return {
    start,
    get: (taskId) => tasks.get(taskId)?.task,
    cancel(taskId) {
      tasks.get(taskId)?.controller.abort();
    },
    retry(taskId, stallMs) {
      const entry = tasks.get(taskId);
      if (entry === undefined) throw new Error(`No export task "${taskId}".`);
      return start(entry.job, stallMs);
    },
    list: () => [...tasks.values()].map((entry) => entry.task),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async settled() {
      for (;;) {
        const running = [...tasks.values()].filter((entry) => entry.task.state === "running");
        if (running.length === 0) return;
        await Promise.allSettled(running.map((entry) => entry.done));
      }
    },
    async close() {
      const running = [...tasks.values()];
      for (const entry of running) entry.controller.abort();
      await Promise.allSettled(running.map((entry) => entry.done));
    },
  };
}
