import {
  createLogger,
  enabled,
  type LoggedError,
  type Logger,
  type LogLevel,
  type LogRecord,
} from "@table-craft/desktop/log/record.js";
import type { Redactor } from "./redact.js";
import type { LogWriter } from "./writer.js";

/** Plan 017 decision 8: one record never takes more than this on disk. */
export const LOG_RECORD_BYTES = 16 * 1024;
/** What a capped record keeps of its message and its error's message and stack. */
const CAPPED_TEXT_CHARS = 2048;

export const ROOT_SCOPE = "app";

export type LogListener = (record: LogRecord) => void;

export interface LogHubOptions {
  readonly writer: LogWriter;
  readonly redactor: Redactor;
  /** Read on every record, so a settings change applies to the next one (decision 3). */
  readonly level: () => LogLevel;
  /** Called with each written record; main mirrors warnings to stderr through it when unpackaged. */
  readonly mirror?: (record: LogRecord) => void;
}

/**
 * Main's one log (plan 017, decision 038). Every process's records come through `write`; main's
 * own code logs with `logger("main").child(scope)`.
 */
export interface LogHub {
  readonly writer: LogWriter;
  readonly redactor: Redactor;
  logger(process: string): Logger;
  write(record: LogRecord): void;
  subscribe(listener: LogListener): () => void;
}

function cut(text: string): string {
  return text.length > CAPPED_TEXT_CHARS ? text.slice(0, CAPPED_TEXT_CHARS) : text;
}

function cappedError(err: LoggedError | undefined): LoggedError | undefined {
  if (err === undefined) return undefined;
  return {
    name: cut(err.name),
    message: cut(err.message),
    ...(err.code === undefined ? {} : { code: cut(err.code) }),
    ...(err.stack === undefined ? {} : { stack: cut(err.stack) }),
  };
}

/** The record as one JSON line no longer than `LOG_RECORD_BYTES`, and the record that line holds. */
export function serializeRecord(record: LogRecord): { readonly line: string; readonly record: LogRecord } {
  const line = JSON.stringify(record);
  if (Buffer.byteLength(line, "utf8") <= LOG_RECORD_BYTES) return { line, record };
  const err = cappedError(record.err);
  const cutFields = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, typeof value === "string" ? cut(value) : value]),
  );
  const shortened: LogRecord = {
    ...record,
    ...cutFields,
    msg: cut(record.msg),
    truncated: true,
    bytes: Buffer.byteLength(line, "utf8"),
    ...(err === undefined ? {} : { err }),
  };
  const shortLine = JSON.stringify(shortened);
  if (Buffer.byteLength(shortLine, "utf8") <= LOG_RECORD_BYTES) return { line: shortLine, record: shortened };
  const capped: LogRecord = {
    ts: record.ts,
    level: record.level,
    process: record.process,
    scope: record.scope,
    msg: cut(record.msg),
    truncated: true,
    bytes: Buffer.byteLength(line, "utf8"),
    ...(err === undefined ? {} : { err }),
  };
  return { line: JSON.stringify(capped), record: capped };
}

export function createLogHub(options: LogHubOptions): LogHub {
  const listeners = new Set<LogListener>();
  const write = (record: LogRecord) => {
    if (!enabled(record.level, options.level())) return;
    const serialized = serializeRecord(options.redactor.record(record));
    options.writer.append(`${serialized.line}\n`);
    options.mirror?.(serialized.record);
    for (const listener of listeners) listener(serialized.record);
  };
  return {
    writer: options.writer,
    redactor: options.redactor,
    logger: (process) => createLogger({ process, scope: ROOT_SCOPE, sink: write }),
    write,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
