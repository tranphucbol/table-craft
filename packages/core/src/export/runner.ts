import type { Row, WireValue } from "@table-craft/plugin-api";
import { ExportError } from "@table-craft/core/export/errors.js";
import type { FileSink } from "@table-craft/core/export/fileSink.js";

/** At most one progress report per this many milliseconds (plan 018, ruling 1). */
export const EXPORT_PROGRESS_INTERVAL_MS = 250;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const HEX_DIGITS_PER_BYTE = 2;
const TRAILING_STOP = /\.$/u;

const STALL_HINT =
  "Check the network and the server, then choose Retry. If the query is slow to return its first row, raise Transfer stall timeout in Settings.";
const CANCEL_HINT = "Export again when you are ready.";
const SOURCE_HINT = "Check the connection, then choose Retry; the export starts again from the first row.";

/** A format written piece by piece; `xlsx` yields bytes, the text formats strings. */
export interface ExportEncoder {
  start(): string | Uint8Array;
  row(row: Row, index: number): string | Uint8Array;
  end(count: number): string | Uint8Array;
  /** Sheets an `xlsx` export filled; 0 for the text formats. */
  readonly sheets: number;
  /** Cells cut to the format's limit. */
  readonly truncatedCells: number;
}

export interface ExportClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

export const systemClock: ExportClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => {
    clearTimeout(timer as ReturnType<typeof setTimeout>);
  },
};

export interface ExportProgress {
  readonly rows: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

export interface ExportOutcome extends ExportProgress {
  readonly sheets: number;
  readonly truncatedCells: number;
  /** Bytes values written as a preview because the rows came from the grid, not the database. */
  readonly clippedBytes: number;
}

export interface RunExportOptions {
  /** Opened lazily so that executing the statement is watched for a stall too. */
  readonly rows: () => Promise<AsyncIterable<Row>> | AsyncIterable<Row>;
  readonly encoder: ExportEncoder;
  readonly sink: FileSink;
  readonly signal: AbortSignal;
  /** No row for this long fails the export as stalled. */
  readonly stallMs: number;
  readonly clock?: ExportClock;
  readonly progressIntervalMs?: number;
  readonly onProgress?: (progress: ExportProgress) => void;
  /**
   * Called when the watchdog fires, before the export fails: closes the connection, so the read
   * that never answered is abandoned rather than awaited.
   */
  readonly onStall?: () => void;
}

/** `12,345 rows were exported before it stopped; the partial file was removed.` */
function stoppedAfter(rows: number): string {
  return `${rows.toLocaleString("en-US")} ${rows === 1 ? "row was" : "rows were"} exported before it stopped; the partial file was removed.`;
}

/** `2 minutes`, `45 seconds`. */
export function durationText(ms: number): string {
  const seconds = Math.round(ms / MS_PER_SECOND);
  if (seconds % SECONDS_PER_MINUTE === 0 && seconds >= SECONDS_PER_MINUTE) {
    const minutes = seconds / SECONDS_PER_MINUTE;
    return `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${String(seconds)} ${seconds === 1 ? "second" : "seconds"}`;
}

function isClippedBytes(value: WireValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    value.kind === "bytes" &&
    value.preview.length < value.length * HEX_DIGITS_PER_BYTE
  );
}

class Interrupted extends Error {
  constructor(readonly reason: "stalled" | "cancelled") {
    super(reason);
  }
}

/**
 * Streams `rows` through `encoder` into `sink` (decision 040). Each row is read only after the
 * previous one is accepted by the sink, so a slow disk slows the read; every wait on the source is
 * raced against the stall watchdog and `signal`. On any failure the sink is aborted and the error
 * is an `ExportError` saying how many rows were exported.
 */
export async function runExport(options: RunExportOptions): Promise<ExportOutcome> {
  const clock = options.clock ?? systemClock;
  const interval = options.progressIntervalMs ?? EXPORT_PROGRESS_INTERVAL_MS;
  const { sink, encoder, signal } = options;
  const started = clock.now();
  let rows = 0;
  let clippedBytes = 0;
  let lastReport = started;
  let iterator: AsyncIterator<Row> | null = null;

  /** `pending` raced against the watchdog and the cancel signal. */
  function watched<T>(pending: Promise<T>): Promise<T> {
    // The abandoned promise may reject later, when its connection closes; nobody waits for it.
    pending.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      const timer = clock.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        reject(new Interrupted("stalled"));
      }, options.stallMs);
      function onAbort(): void {
        clock.clearTimeout(timer);
        reject(new Interrupted("cancelled"));
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          clock.clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (cause: unknown) => {
          clock.clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        },
      );
    });
  }

  function report(force: boolean): void {
    const at = clock.now();
    if (!force && at - lastReport < interval) return;
    lastReport = at;
    options.onProgress?.({ rows, bytes: sink.bytes, elapsedMs: at - started });
  }

  async function checked(write: Promise<void>): Promise<void> {
    await write;
    if (signal.aborted) throw new Interrupted("cancelled");
  }

  try {
    await checked(sink.write(encoder.start()));
    const source = await watched(Promise.resolve().then(() => options.rows()));
    iterator = source[Symbol.asyncIterator]();
    const reading = iterator;
    for (;;) {
      const next = await watched(reading.next());
      if (next.done === true) break;
      for (const value of next.value) if (isClippedBytes(value)) clippedBytes += 1;
      await checked(sink.write(encoder.row(next.value, rows)));
      rows += 1;
      report(false);
    }
    iterator = null;
    await checked(sink.write(encoder.end(rows)));
    await sink.commit();
  } catch (cause) {
    await sink.abort();
    if (iterator !== null) {
      // Never awaited: on a dead connection closing the cursor would wait as long as the stall did.
      void Promise.resolve()
        .then(() => iterator?.return?.())
        .catch(() => undefined);
    }
    throw failure(cause, rows, options);
  }
  const elapsedMs = clock.now() - started;
  options.onProgress?.({ rows, bytes: sink.bytes, elapsedMs });
  return {
    rows,
    bytes: sink.bytes,
    elapsedMs,
    sheets: encoder.sheets,
    truncatedCells: encoder.truncatedCells,
    clippedBytes,
  };
}

function failure(cause: unknown, rows: number, options: RunExportOptions): ExportError {
  if (cause instanceof Interrupted && cause.reason === "stalled") {
    options.onStall?.();
    return new ExportError(
      "stalled",
      `The server sent nothing for ${durationText(options.stallMs)}; the network or the server stalled. ${stoppedAfter(rows)}`,
      STALL_HINT,
      rows,
    );
  }
  if (cause instanceof Interrupted) {
    return new ExportError("cancelled", `Export cancelled. ${stoppedAfter(rows)}`, CANCEL_HINT, rows);
  }
  if (cause instanceof ExportError) {
    return new ExportError(cause.reason, `${cause.message} ${stoppedAfter(rows)}`, cause.hint, rows, cause.cause);
  }
  const message = (cause instanceof Error ? cause.message : String(cause)).replace(TRAILING_STOP, "");
  return new ExportError("source", `The export stopped: ${message}. ${stoppedAfter(rows)}`, SOURCE_HINT, rows, cause);
}
