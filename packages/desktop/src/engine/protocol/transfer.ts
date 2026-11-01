import type { EngineError } from "./calls.js";

/** Mirrors `EXTRACTOR_KINDS` in core: the formats Copy and Export write. */
export const EXTRACTOR_KINDS = ["csv", "tsv", "json", "sqlInsert", "markdown"] as const;
export type ExtractorKind = (typeof EXTRACTOR_KINDS)[number];

/** Rows `from` up to but not including `to`, in the result's current sort order and view. */
export interface RowRange {
  readonly from: number;
  readonly to: number;
}

/** Mirrors `EXPORT_FORMATS` in core: every extractor, plus XLSX, which only Export writes. */
export const EXPORT_FORMATS = [...EXTRACTOR_KINDS, "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Mirrors `EXPORT_FAILURE_REASONS` in core. */
export const EXPORT_FAILURE_REASONS = ["stalled", "diskFull", "cancelled", "source", "file"] as const;
export type ExportFailureReason = (typeof EXPORT_FAILURE_REASONS)[number];

/**
 * What an export reads (decision 040): a console or table-editor result by handle, with the
 * result's column indices, or a whole table by path and name, with column names.
 */
export type ExportSource =
  | {
      readonly kind: "result";
      readonly handle: string;
      readonly columns: readonly number[];
      /** Write only the rows a local filter shows, from memory (decision 050). */
      readonly shownOnly?: boolean;
    }
  | {
      readonly kind: "table";
      readonly path: readonly string[];
      readonly relation: string;
      readonly columns: readonly string[];
    };

/**
 * Where the rows come from: `rerun` runs the result's statement again on a session of the
 * export's own, `table` selects a whole table there, `memory` writes the rows the grid holds,
 * `cursor` drains the console's still-open cursor.
 */
export type ExportOrigin = "rerun" | "table" | "memory" | "cursor";
export type ExportTaskState = "running" | "done" | "failed" | "cancelled";

/** One background export, as every event carries it whole. */
export interface ExportTask {
  readonly taskId: string;
  readonly path: string;
  readonly format: ExportFormat;
  readonly origin: ExportOrigin;
  readonly state: ExportTaskState;
  readonly rows: number;
  readonly bytes: number;
  readonly elapsedMs: number;
  /** Epoch ms the task started; the clock the renderer runs from between progress events. */
  readonly startedAt: number;
  /** Rows expected, when known: only a memory export knows. */
  readonly estimate: number | null;
  /** XLSX sheets written; 0 for text formats. */
  readonly sheets: number;
  readonly truncatedCells: number;
  /** Binary values written from the grid's preview, not in full. */
  readonly clippedBytes: number;
  /** Shown beside the task, never blocking: low free disk space. */
  readonly warning: string | null;
  readonly error: (EngineError & { readonly reason: ExportFailureReason }) | null;
  /** Only re-run and table exports can run again; a memory or cursor export's rows are gone. */
  readonly retryable: boolean;
  /** The result handle a cursor export drains, so its grid can show the drain end; null otherwise. */
  readonly drains: string | null;
}

export const EXPORT_EVENT_TYPES = ["export.progress", "export.done", "export.failed", "export.cancelled"] as const;
export type ExportEventType = (typeof EXPORT_EVENT_TYPES)[number];

/** Pushed by the engine to every connection, unasked: `id` is always null. */
export interface ExportEvent {
  readonly id: null;
  readonly type: ExportEventType;
  readonly task: ExportTask;
}

/** Mirrors `IMPORT_ENCODINGS` in core; `auto` reads a BOM and falls back to UTF-8. */
export const IMPORT_ENCODINGS = ["auto", "utf-8", "utf-16le", "utf-16be", "windows-1252"] as const;
export type ImportEncoding = (typeof IMPORT_ENCODINGS)[number];

/** Mirrors `ImportFormat` in core (decision 046). */
export interface ImportFormat {
  readonly delimiter: string;
  readonly quote: string | null;
  readonly escape: "double" | "backslash";
  readonly header: boolean;
  readonly encoding: ImportEncoding;
  /** An unquoted field equal to this is NULL; "" is the empty field. */
  readonly nullToken: string;
  readonly trim: boolean;
}

/** Mirrors `IMPORT_KINDS` in plugin-api: what a sampled column's values all fit. */
export const IMPORT_KINDS = ["boolean", "integer", "bigint", "decimal", "double", "date", "timestamp", "text"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

/** The head of a file read with a format: what the import dialog shows before anything is written. */
export interface ImportPreview {
  /** The header's names, or `column_1`… without one. */
  readonly names: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
  readonly kinds: readonly ImportKind[];
  /** The plugin's column type for each kind, for a new table. */
  readonly types: readonly string[];
  /** The encoding read: what `auto` found. */
  readonly encoding: ImportEncoding;
  /** Sampled rows whose field count differs from the first record's: each will be a bad row. */
  readonly ragged: number;
  /** The file's size in bytes. */
  readonly size: number;
}

/** One target column and the file's field written to it. */
export interface ImportMapping {
  readonly column: string;
  readonly field: number;
}

/** A new table's column: its name, the type the DDL gives it, and the field it takes. */
export interface NewImportColumn {
  readonly name: string;
  readonly type: string;
  readonly field: number;
}

/** Where an import writes: an existing table's mapped columns, or a table it creates first. */
export type ImportTarget =
  | {
      readonly kind: "table";
      readonly path: readonly string[];
      readonly relation: string;
      readonly mapping: readonly ImportMapping[];
    }
  | {
      readonly kind: "new";
      readonly path: readonly string[];
      readonly relation: string;
      readonly columns: readonly NewImportColumn[];
    };

export type ImportTransaction = { readonly mode: "all" } | { readonly mode: "every"; readonly rows: number };
export type ImportErrorPolicy = { readonly mode: "stop" } | { readonly mode: "skip"; readonly limit: number };

/** Mirrors `IMPORT_FAILURE_REASONS` in core. */
export const IMPORT_FAILURE_REASONS = ["stalled", "cancelled", "badRow", "tooManyRejected", "file", "target"] as const;
export type ImportFailureReason = (typeof IMPORT_FAILURE_REASONS)[number];

/** One background import, as every event carries it whole (decision 046). */
export interface ImportTask {
  readonly taskId: string;
  readonly file: string;
  /** The target's qualified name, as the plugin quotes it. */
  readonly table: string;
  readonly state: ExportTaskState;
  readonly transaction: ImportTransaction;
  /** Bytes of the file read so far, of `size`. */
  readonly bytes: number;
  readonly size: number;
  readonly written: number;
  readonly committed: number;
  readonly rejected: number;
  readonly elapsedMs: number;
  /** The first data row a Resume (or Retry, when nothing is committed) starts from; 1-based. */
  readonly resumeFrom: number;
  /** The last commit's answer was lost: its rows may or may not be kept. */
  readonly ambiguous: boolean;
  /** This import created the table; it stays when the import fails. */
  readonly created: boolean;
  /** Where Skip wrote the rows it rejected; null when none were. */
  readonly rejectedFile: string | null;
  readonly error: (EngineError & { readonly reason: ImportFailureReason }) | null;
}

export const IMPORT_EVENT_TYPES = ["import.progress", "import.done", "import.failed", "import.cancelled"] as const;
export type ImportEventType = (typeof IMPORT_EVENT_TYPES)[number];

/** Pushed by the engine to every connection, unasked, like `ExportEvent`. */
export interface ImportEvent {
  readonly id: null;
  readonly type: ImportEventType;
  readonly task: ImportTask;
}

/**
 * What a run of several statements does when one fails (decision 083): pause and ask, stop as it
 * always did, or log the failure and go on.
 */
export const ON_ERROR_CHOICES = ["ask", "stop", "continue"] as const;
export type OnErrorChoice = (typeof ON_ERROR_CHOICES)[number];

/** The answers to a paused run: go on, go on without asking again, stop, or run it again. */
export const ERROR_ANSWERS = ["skip", "skipAll", "stop", "retry"] as const;
export type ErrorAnswer = (typeof ERROR_ANSWERS)[number];

/** A line and column in a file, both from 1, the column in UTF-16 code units. */
export interface FilePosition {
  readonly line: number;
  readonly column: number;
}

/**
 * Where a script statement failed (decision 081): the file, and the line and column (from 1) the
 * failing statement starts at, with its first characters; all null when the run failed before a
 * statement. `at` is where in the file the database located the error (decision 082), when it did.
 */
export interface ScriptError extends Omit<EngineError, "position"> {
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly statement: string | null;
  readonly at: FilePosition | null;
}

/** One Run SQL Script task, as every event carries it whole (decision 081). */
export interface ScriptTask {
  readonly taskId: string;
  /** Every file the task runs, in order; `file` is the one running or the last run. */
  readonly files: readonly string[];
  readonly file: string;
  /** The schema or database each file runs in; null runs in the session's default. */
  readonly namespace: readonly string[] | null;
  readonly state: ExportTaskState;
  /** Statements that finished, across every file. */
  readonly statements: number;
  /** Bytes read so far, of `size`, across every file. */
  readonly bytes: number;
  readonly size: number;
  readonly elapsedMs: number;
  /** Why the task failed or was cancelled; null while it runs and when it is done. */
  readonly error: ScriptError | null;
  /** Statements that failed and were skipped past (decision 083), across every file. */
  readonly failed: number;
  /** The first `SCRIPT_FAILURES_KEPT` of them, in order; `failed` counts them all. */
  readonly failures: readonly ScriptError[];
  /** The failure an `ask` task waits on, until `script.answer` answers it. */
  readonly question: ScriptError | null;
}

/** A script that fails a million times keeps the first failures, not an event the size of the file. */
export const SCRIPT_FAILURES_KEPT = 100;

export const SCRIPT_EVENT_TYPES = ["script.progress", "script.done", "script.failed", "script.cancelled"] as const;
export type ScriptEventType = (typeof SCRIPT_EVENT_TYPES)[number];

/** Pushed by the engine to every connection, unasked, like `ExportEvent`. */
export interface ScriptEvent {
  readonly id: null;
  readonly type: ScriptEventType;
  readonly task: ScriptTask;
}

export type EngineEvent = ExportEvent | ImportEvent | ScriptEvent;
