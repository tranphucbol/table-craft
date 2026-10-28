import { randomBytes } from "node:crypto";
import { fileChunks, systemClock, Utf8Error, utf8Decoder, type ExportClock } from "@table-craft/core";
import type { StatementStream, StreamedStatement } from "@table-craft/plugin-api";
import type { Logger } from "@table-craft/desktop/log/record.js";
import {
  SCRIPT_FAILURES_KEPT,
  type EngineError,
  type ErrorAnswer,
  type FilePosition,
  type OnErrorChoice,
  type ScriptError,
  type ScriptEvent,
  type ScriptEventType,
  type ScriptTask,
} from "@table-craft/desktop/engine/protocol.js";

/** How long a finished script waits for its session to close before it reports anyway. */
const SESSION_CLOSE_GRACE_MS = 5_000;
/** A script of small statements finishes thousands a second; the Services line needs a few updates. */
const PROGRESS_INTERVAL_MS = 200;
const TASK_PREFIX = "script-";
const TASK_ID_RANDOM_BYTES = 4;
/** Enough of the failing statement to recognise it; the link opens the file for the rest. */
const STATEMENT_PREVIEW_CHARS = 200;
const UNEXPECTED_HINT = "This is a TableCraft bug; restart the app and report it.";
const CANCEL_HINT = "Statements that finished stay applied; run the script again when you are ready.";
const UTF8_HINT = "Save the file as UTF-8 and run it again; the statements before that byte ran.";
const READ_HINT = "Check that the file exists and that you may read it, then run the script again.";
/** Said with every failure skipped past inside a transaction the script opened (plan 042). */
const IN_TRANSACTION_HINT =
  "It failed inside a transaction: PostgreSQL refuses every later statement until the transaction ends, and then rolls it back.";

/**
 * `pending`, or a rejection as soon as `signal` aborts. The listener goes once `pending` settles,
 * so a script of a million statements does not leave a million listeners on one signal.
 */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = (): void => reject(new Error("cancelled"));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", fail));
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The script's own session, already in the namespace it runs in; `close` settles in bounded time. */
export interface ScriptSession {
  /** Runs one statement, `repeat` times when the script says so (`GO 3`), and reads its result to the end. */
  execute(sql: string, repeat?: number): Promise<void>;
  /** Stops the statement in flight, where the plugin can. */
  cancel(): void;
  close(): Promise<void>;
  /** Whether a transaction the script began is still open. */
  inTransaction(): boolean;
}

export interface ScriptFile {
  readonly path: string;
  readonly size: number;
}

export interface ScriptJob {
  readonly files: readonly ScriptFile[];
  readonly namespace: readonly string[] | null;
  open(): Promise<ScriptSession>;
  /** A fresh splitter for each file. */
  stream(): StatementStream;
  /** What a failed connect or statement tells the user; `sql` is the statement that failed. */
  failure(cause: unknown, sql?: string): EngineError;
  readonly onError: OnErrorChoice;
}

export type ScriptListener = (event: ScriptEvent) => void;

export interface ScriptTasks {
  start(job: ScriptJob): ScriptTask;
  get(taskId: string): ScriptTask | undefined;
  cancel(taskId: string): void;
  /** Answers the failure a task waits on; false when it waits on none. */
  answer(taskId: string, answer: ErrorAnswer): boolean;
  list(): ScriptTask[];
  subscribe(listener: ScriptListener): () => void;
  /** Resolves once no task runs, including tasks started while it waited. */
  settled(): Promise<void>;
  /** Cancels what runs and waits for them. */
  close(): Promise<void>;
}

export interface ScriptTasksOptions {
  readonly clock?: ExportClock;
  readonly chunks?: (file: string) => AsyncIterable<Uint8Array>;
  /** How each task ended: counts only, never a path or a statement (decision 038). */
  readonly log?: Pick<Logger, "info" | "warn">;
}

interface Running {
  task: ScriptTask;
  readonly controller: AbortController;
  done: Promise<void>;
  /** Resolves the question the task waits on. */
  answer: ((answer: ErrorAnswer) => void) | null;
}

/** Why a run stopped, before it becomes the task's `ScriptError`. */
class ScriptStop extends Error {
  constructor(
    readonly error: ScriptError,
    readonly cancelled = false,
  ) {
    super(error.message);
  }
}

const NOWHERE = { file: null, line: null, column: null, statement: null, at: null } as const;

/** Where in the file `offset` into a statement starting at `statement.line:column` falls. */
function filePosition(statement: StreamedStatement, offset: number): FilePosition {
  const before = statement.sql.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  if (lastBreak === -1) return { line: statement.line, column: statement.column + offset };
  return { line: statement.line + before.split("\n").length - 1, column: offset - lastBreak };
}

function withinGrace(pending: Promise<void>, clock: ExportClock): Promise<void> {
  return new Promise((resolve) => {
    const timer = clock.setTimeout(resolve, SESSION_CLOSE_GRACE_MS);
    void pending.finally(() => {
      clock.clearTimeout(timer);
      resolve();
    });
  });
}

const SILENT: Pick<Logger, "info" | "warn"> = { info: () => undefined, warn: () => undefined };

/** The engine's Run SQL Script tasks (decision 081), one table for the whole engine like imports'. */
export function scriptTasks(options: ScriptTasksOptions = {}): ScriptTasks {
  const clock = options.clock ?? systemClock;
  const chunks = options.chunks ?? fileChunks;
  const log = options.log ?? SILENT;
  const tasks = new Map<string, Running>();
  const listeners = new Set<ScriptListener>();
  let next = 1;

  function emit(type: ScriptEventType, task: ScriptTask): void {
    const event: ScriptEvent = { id: null, type, task };
    for (const listener of listeners) listener(event);
  }

  async function run(entry: Running, job: ScriptJob): Promise<void> {
    const { controller } = entry;
    const started = clock.now();
    let lastProgress = started;
    let session: ScriptSession | null = null;
    let finished = false;
    let closing: Promise<void> | null = null;
    const closeSession = (): Promise<void> => {
      closing ??= session === null ? Promise.resolve() : session.close().catch(() => undefined);
      return closing;
    };
    const update = (patch: Partial<ScriptTask>): void => {
      entry.task = { ...entry.task, ...patch };
    };
    const progress = (force = false): void => {
      const now = clock.now();
      if (!force && now - lastProgress < PROGRESS_INTERVAL_MS) return;
      lastProgress = now;
      update({ elapsedMs: now - started });
      emit("script.progress", entry.task);
    };
    const cancelled = (): ScriptStop =>
      new ScriptStop(
        {
          code: "cancelled",
          message: `Script cancelled after ${String(entry.task.statements)} statements.`,
          hint: CANCEL_HINT,
          ...NOWHERE,
        },
        true,
      );

    let onError = job.onError;
    const failed = (open: ScriptSession, cause: unknown, path: string, statement: StreamedStatement): ScriptError => {
      const { position, ...error } = job.failure(cause, statement.sql);
      return {
        ...error,
        ...(open.inTransaction() && error.code === "statementFailed" ? { hint: IN_TRANSACTION_HINT } : {}),
        file: path,
        line: statement.line,
        column: statement.column,
        statement: statement.sql.slice(0, STATEMENT_PREVIEW_CHARS),
        at: position === undefined ? null : filePosition(statement, position),
      };
    };
    const asked = (error: ScriptError): Promise<ErrorAnswer> => {
      const answered = new Promise<ErrorAnswer>((resolve) => {
        entry.answer = resolve;
      });
      update({ question: error });
      progress(true);
      return abortable(answered, controller.signal)
        .catch(() => {
          throw cancelled();
        })
        .finally(() => {
          entry.answer = null;
          update({ question: null });
        });
    };
    const skipped = (error: ScriptError): void => {
      const { failures } = entry.task;
      update({
        failed: entry.task.failed + 1,
        failures: failures.length < SCRIPT_FAILURES_KEPT ? [...failures, error] : failures,
      });
      progress(true);
    };

    const runStatement = async (open: ScriptSession, path: string, statement: StreamedStatement): Promise<void> => {
      for (;;) {
        if (controller.signal.aborted) throw cancelled();
        try {
          await abortable(open.execute(statement.sql, statement.repeat), controller.signal);
          update({ statements: entry.task.statements + 1 });
          progress();
          return;
        } catch (cause) {
          if (controller.signal.aborted) throw cancelled();
          const error = failed(open, cause, path, statement);
          // Only a statement's own failure may be skipped past; a lost connection fails the rest too.
          if (onError === "stop" || error.code !== "statementFailed") throw new ScriptStop(error);
          const answer = onError === "continue" ? "skip" : await asked(error);
          if (answer === "stop") throw new ScriptStop(error);
          if (answer === "retry") continue;
          if (answer === "skipAll") onError = "continue";
          skipped(error);
          return;
        }
      }
    };

    const runFile = async (open: ScriptSession, path: string): Promise<void> => {
      update({ file: path });
      progress(true);
      const decoder = utf8Decoder();
      const stream = job.stream();
      const fileFailed = (cause: unknown): ScriptStop => {
        if (cause instanceof Utf8Error) {
          return new ScriptStop({
            code: "scriptFailed",
            message: `${path} is not UTF-8 text: byte ${String(cause.offset)} starts an invalid sequence.`,
            hint: UTF8_HINT,
            ...NOWHERE,
            file: path,
          });
        }
        return new ScriptStop({
          code: "scriptFailed",
          message: `Cannot read ${path}: ${messageOf(cause)}`,
          hint: READ_HINT,
          ...NOWHERE,
          file: path,
        });
      };
      const source = chunks(path)[Symbol.asyncIterator]();
      try {
        for (;;) {
          let chunk: IteratorResult<Uint8Array>;
          let text: string;
          try {
            chunk = await source.next();
            text = chunk.done === true ? decoder.end() : decoder.push(chunk.value);
          } catch (cause) {
            throw fileFailed(cause);
          }
          if (chunk.done !== true) update({ bytes: entry.task.bytes + chunk.value.byteLength });
          const statements = chunk.done === true ? [...stream.push(text), ...stream.end()] : stream.push(text);
          for (const statement of statements) await runStatement(open, path, statement);
          if (chunk.done === true) return;
          progress();
        }
      } finally {
        await source.return?.();
      }
    };

    let type: ScriptEventType;
    try {
      const opening = job.open();
      // A connect that answers after a cancel is closed, not leaked.
      void opening.then(
        (opened) => {
          if (finished) void opened.close().catch(() => undefined);
        },
        () => undefined,
      );
      const opened = await abortable(opening, controller.signal).catch((cause: unknown) => {
        if (controller.signal.aborted) throw cancelled();
        const { position: _unlocated, ...error } = job.failure(cause);
        throw new ScriptStop({ ...error, ...NOWHERE });
      });
      session = opened;
      controller.signal.addEventListener("abort", () => opened.cancel(), { once: true });
      for (const file of job.files) await runFile(opened, file.path);
      type = "script.done";
      update({ state: "done" });
    } catch (cause) {
      const stop =
        cause instanceof ScriptStop
          ? cause
          : new ScriptStop({ code: "internal", message: messageOf(cause), hint: UNEXPECTED_HINT, ...NOWHERE });
      type = stop.cancelled ? "script.cancelled" : "script.failed";
      update({ state: stop.cancelled ? "cancelled" : "failed", error: stop.error });
    } finally {
      finished = true;
    }
    await withinGrace(closeSession(), clock);
    update({ elapsedMs: clock.now() - started });
    const { task } = entry;
    const fields = {
      taskId: task.taskId,
      files: task.files.length,
      statements: task.statements,
      bytes: task.bytes,
      size: task.size,
      elapsedMs: task.elapsedMs,
    };
    if (task.state === "done") log.info("script finished", { ...fields, failed: task.failed });
    else if (task.state === "cancelled") log.info("script cancelled", fields);
    // The message can quote the statement or a value; the code and the counts say enough (decision 038).
    else log.warn("script failed", { ...fields, code: task.error?.code });
    emit(type, task);
  }

  return {
    start(job) {
      const taskId = `${TASK_PREFIX}${String(next++)}-${randomBytes(TASK_ID_RANDOM_BYTES).toString("hex")}`;
      const files = job.files.map((file) => file.path);
      const entry: Running = {
        controller: new AbortController(),
        done: Promise.resolve(),
        answer: null,
        task: {
          taskId,
          files,
          file: files[0] ?? "",
          namespace: job.namespace,
          state: "running",
          statements: 0,
          bytes: 0,
          size: job.files.reduce((total, file) => total + file.size, 0),
          elapsedMs: 0,
          error: null,
          failed: 0,
          failures: [],
          question: null,
        },
      };
      tasks.set(taskId, entry);
      entry.done = run(entry, job);
      return entry.task;
    },
    get: (taskId) => tasks.get(taskId)?.task,
    cancel(taskId) {
      tasks.get(taskId)?.controller.abort();
    },
    answer(taskId, answer) {
      const respond = tasks.get(taskId)?.answer;
      if (respond == null) return false;
      respond(answer);
      return true;
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

/**
 * A stream over `split` for a plugin without `splitStream`: it holds the whole file and splits at
 * the end, so the engine only offers it for files up to `SCRIPT_WHOLE_FILE_MAX_BYTES`.
 */
export function wholeFileStream(
  split: (text: string) => readonly { from: number; to: number; sql: string }[],
): StatementStream {
  const pieces: string[] = [];
  return {
    push(text) {
      pieces.push(text);
      return [];
    },
    end() {
      const text = pieces.join("");
      let line = 1;
      let lineStart = 0;
      let cursor = 0;
      return split(text).map((span) => {
        for (let at = text.indexOf("\n", cursor); at >= 0 && at < span.from; at = text.indexOf("\n", at + 1)) {
          line += 1;
          lineStart = at + 1;
        }
        cursor = span.from;
        return { ...span, line, column: span.from - lineStart + 1 };
      });
    },
  };
}

/** The largest file a plugin without `splitStream` can run as a script, held whole in the engine. */
export const SCRIPT_WHOLE_FILE_MAX_BYTES = 32 * 1024 * 1024;
