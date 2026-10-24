/**
 * Every message between the renderer and an engine host (decision 002). The renderer may not
 * import core or plugin-api, so the wire types and constants both sides need are restated here
 * and pinned to their originals by `test/desktop/protocol.test.ts`.
 */

/** Mirrors `RESULT_WINDOW_ROWS` in core: the most rows one `result.window` returns. */
export const RESULT_WINDOW_ROWS = 500;
/** Mirrors `RESULT_PAGE_ROWS` in core: the default page, before the user's setting (decision 032). */
export const RESULT_PAGE_ROWS = 500;
/** Mirrors `RESULT_FETCH_ALL_CAP` in core: the default Fetch All cap, before the user's setting. */
export const RESULT_FETCH_ALL_CAP = 100_000;

/** What main posts on the engine's parent port, once, before any renderer port arrives. */
export const ENGINE_BOOT_MESSAGE = "engine.boot";
/** What main posts on the engine's parent port alongside a fresh renderer port. */
export const ENGINE_PORT_MESSAGE = "engine.port";
/** What main posts on the engine's parent port to have it close every session and exit. */
export const ENGINE_SHUTDOWN_MESSAGE = "engine.shutdown";
/** What a probe engine posts on its parent port, once, before it exits. */
export const ENGINE_PROBED_MESSAGE = "engine.probed";
/** What an engine posts on its parent port for each log record; main alone writes the log (plan 017). */
export const ENGINE_LOG_MESSAGE = "engine.log";
/**
 * A plain cancel's message. A `cancelled` error with any other message says what else the cancel
 * did, such as resetting the session on a server that cannot stop a statement (decision 058).
 */
export const STATEMENT_CANCELLED_MESSAGE = "The statement was cancelled.";

/** Mirrors `WireValue` in plugin-api. */
export type WireValue =
  | null
  | boolean
  | number
  | string
  | { readonly kind: "bigint"; readonly value: string }
  | { readonly kind: "bytes"; readonly preview: string; readonly length: number }
  | { readonly kind: "json"; readonly text: string }
  | { readonly kind: "date"; readonly iso: string };

export type Row = readonly WireValue[];

/** Mirrors `Column` in plugin-api. */
export interface Column {
  readonly name: string;
  readonly type: string | null;
  readonly origin?: ColumnOrigin | null;
}

/** Mirrors `ColumnOrigin` in plugin-api. */
export interface ColumnOrigin {
  readonly table: string;
  readonly column: string;
}

/** Mirrors `Capability` in plugin-api. The renderer branches on these, never on a plugin id (decision 007). */
export type Capability =
  | "sql"
  | "cancel"
  | "schemaTree"
  | "transactions"
  | "ddl"
  | "explain"
  | "explainAnalyze"
  | "currentNamespace"
  | "keepAlive"
  | "bulkInsert"
  | "objects"
  | "serverMessages"
  | "sessions";

/** Mirrors `ServerMessageLevel` in plugin-api. */
export type ServerMessageLevel = "error" | "warning" | "notice" | "info";

/** Mirrors `ServerMessage` in plugin-api: a warning or notice the server raised running a statement (decision 066). */
export interface ServerMessage {
  readonly level: ServerMessageLevel;
  readonly code: string | null;
  readonly text: string;
}

/** Mirrors `ServerSessionState` in plugin-api. */
export type ServerSessionState = "active" | "idle" | "idleInTransaction" | "blocked" | "other";

/** Mirrors `ServerSession` in plugin-api: one session on the server (decision 088). */
export interface ServerSession {
  readonly id: string;
  readonly instance: string | null;
  readonly state: ServerSessionState;
  readonly rawState: string | null;
  readonly user: string | null;
  readonly database: string | null;
  readonly client: string | null;
  readonly application: string | null;
  readonly queryMs: number | null;
  readonly transactionMs: number | null;
  readonly waitEvent: string | null;
  readonly blockedBy: readonly string[] | null;
  readonly query: string | null;
  readonly system: boolean;
  readonly cancel: string | null;
  readonly terminate: string | null;
}

/** Mirrors `SessionTarget` in plugin-api. */
export interface SessionTarget {
  readonly id: string;
  readonly instance: string | null;
}

/** A listed server session, and whether it is one of this engine's own connections. */
export interface ListedSession extends ServerSession {
  /** This engine's session id for it, as `session.open` returned it; null for the catalog's connection and everyone else's. */
  readonly ownSessionId: string | null;
  readonly own: boolean;
}

/** What `sessions.list` answers: the server's sessions, and what the listing leaves out and why. */
export interface SessionsListing {
  readonly sessions: readonly ListedSession[];
  readonly notes: readonly string[];
}

/** What the SQL Generator writes: `create` is the relation's definition, the rest mirror `GeneratedStatement` in plugin-api. */
export type GeneratorStatement = "create" | "drop" | "select" | "insert" | "update";

/** Mirrors `StatementKind` in plugin-api. */
export type StatementKind = "read" | "write" | "ddl" | "transaction" | "other";

/** Mirrors `TransactionMode` in plugin-api: `auto` commits each statement, `manual` holds one transaction open. */
export type TransactionMode = "auto" | "manual";

/** Mirrors `ParameterStyle` in plugin-api. */
export type ParameterStyle = "named" | "numbered" | "positional";

/** Mirrors `SqlParameter` in plugin-api: a placeholder, in offsets into its statement's `sql`. */
export interface StatementParameter {
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly style: ParameterStyle;
}

/** Mirrors `ParameterValue` in plugin-api: text the server casts, or SQL NULL (decision 043). */
export type ParameterValue = string | null;

/** One statement of a script: its span in UTF-16 offsets, as the plugin split it, and its class. */
export interface ClassifiedStatement {
  readonly from: number;
  readonly to: number;
  readonly sql: string;
  readonly kind: StatementKind;
  /** Why the console asks before running it, such as `DELETE without WHERE`; null when it need not. */
  readonly destructive: string | null;
  /** The placeholders the plugin finds in `sql`, in order. */
  readonly parameters: readonly StatementParameter[];
}

/** Mirrors `KEYWORD_CASES` in plugin-api. */
export const KEYWORD_CASES = ["upper", "lower", "preserve"] as const;

export type KeywordCase = (typeof KEYWORD_CASES)[number];

/** Mirrors `FORMAT_STYLES` in plugin-api. */
export const FORMAT_STYLES = ["aligned", "standard"] as const;

export type FormatStyle = (typeof FORMAT_STYLES)[number];

/** Mirrors `FormatOptions` in plugin-api (decisions 042, 061). */
export interface FormatOptions {
  readonly style: FormatStyle;
  readonly keywordCase: KeywordCase;
  readonly indentWidth: number;
  readonly linesBetweenStatements: number;
  readonly alignAliases: boolean;
}

/** A session's transaction after a transaction request. */
export interface TransactionState {
  readonly mode: TransactionMode;
  readonly transactionOpen: boolean;
  /** The session's namespace after a commit or rollback, which may undo a switch; see `ExecutedStatement`. */
  readonly namespace?: CurrentNamespace;
}

/**
 * The namespace a console's session is in, as an introspector path (decision 048); null when the
 * plugin reports none, such as a search_path that names no schema.
 */
export type CurrentNamespace = readonly string[] | null;

/** Mirrors `Namespace` in plugin-api. */
export interface Namespace {
  readonly path: readonly string[];
  readonly name: string;
  readonly kind: "database" | "schema";
  readonly system: boolean;
  readonly current: boolean;
}

/** A namespace switch as the plugin writes it; `transactional` when a rollback undoes it. */
export interface SwitchStatement {
  readonly sql: string;
  readonly transactional: boolean;
}

/** Mirrors `ColumnMeta` in plugin-api. */
export interface ColumnMeta {
  readonly name: string;
  readonly position: number;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly comment: string | null;
  readonly autoIncrement: boolean;
}

/** Mirrors `Key` in plugin-api. */
export interface Key {
  readonly name: string;
  readonly columns: readonly string[];
}

/** Mirrors `ForeignKey` in plugin-api. */
export interface ForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly target: {
    readonly path: readonly string[];
    readonly relation: string;
    readonly columns: readonly string[];
  };
  readonly onDelete: string;
  readonly onUpdate: string;
}

/** Mirrors `Index` in plugin-api. */
export interface Index {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly primary: boolean;
}

/** Mirrors `RelationKind` in plugin-api. */
export type RelationKind = "table" | "view" | "materializedView";

/** Mirrors `Relation` in plugin-api. */
export interface Relation {
  readonly name: string;
  readonly kind: RelationKind;
  readonly comment: string | null;
  readonly columns: readonly ColumnMeta[];
  readonly primaryKey: Key | null;
  readonly uniqueKeys: readonly Key[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly indexes: readonly Index[];
}

/** Mirrors `Routine` in plugin-api. */
export interface Routine {
  readonly name: string;
  readonly kind: "function" | "procedure";
}

/** Mirrors `Sequence` in plugin-api. */
export interface Sequence {
  readonly name: string;
}

/** Mirrors `NamespaceCatalog` in plugin-api. */
export interface NamespaceCatalog {
  readonly path: readonly string[];
  readonly relations: readonly Relation[];
  readonly routines: readonly Routine[];
  readonly sequences: readonly Sequence[];
}

/** Mirrors `OBJECT_KINDS` in plugin-api: what the tree can rename and drop. */
export const OBJECT_KINDS = ["table", "view", "materializedView", "sequence", "function", "procedure"] as const;

export type ObjectKind = (typeof OBJECT_KINDS)[number];

/** Mirrors `CatalogObject` in plugin-api. */
export interface CatalogObject {
  readonly kind: ObjectKind;
  readonly name: string;
}

/** Mirrors `ColumnDesign` in plugin-api. `original` is the column's name in the table, null when new. */
export interface ColumnDesign {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
  readonly autoIncrement: boolean;
  readonly comment: string | null;
  readonly original: string | null;
}

/** Mirrors `IndexDesign` in plugin-api. */
export interface IndexDesign {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly original: string | null;
}

/** Mirrors `ForeignKeyDesign` in plugin-api. */
export interface ForeignKeyDesign {
  readonly name: string;
  readonly columns: readonly string[];
  readonly target: { readonly path: readonly string[]; readonly relation: string; readonly columns: readonly string[] };
  readonly onDelete: string | null;
  readonly onUpdate: string | null;
  readonly original: string | null;
}

/** Mirrors `CheckDesign` in plugin-api. */
export interface CheckDesign {
  readonly name: string;
  readonly expression: string;
  readonly original: string | null;
}

/** Mirrors `TableDesign` in plugin-api: what the Create and Modify Table dialog edits. */
export interface TableDesign {
  readonly name: string;
  readonly comment: string | null;
  readonly columns: readonly ColumnDesign[];
  readonly primaryKey: readonly string[];
  readonly primaryKeyName: string | null;
  readonly indexes: readonly IndexDesign[];
  readonly foreignKeys: readonly ForeignKeyDesign[];
  readonly checks: readonly CheckDesign[];
}

/** Mirrors `ObjectChange` in plugin-api: one change to the database's objects. */
export type ObjectChange =
  | { readonly kind: "createTable"; readonly path: readonly string[]; readonly design: TableDesign }
  | {
      readonly kind: "alterTable";
      readonly path: readonly string[];
      readonly relation: string;
      readonly design: TableDesign;
    }
  | {
      readonly kind: "rename";
      readonly path: readonly string[];
      readonly object: CatalogObject;
      readonly name: string;
    }
  | {
      readonly kind: "drop";
      readonly path: readonly string[];
      readonly object: CatalogObject;
      readonly cascade: boolean;
    }
  | {
      readonly kind: "truncate";
      readonly path: readonly string[];
      readonly relation: string;
      readonly cascade: boolean;
    }
  | { readonly kind: "createNamespace"; readonly path: readonly string[]; readonly name: string };

/** Mirrors `DdlScript` in plugin-api. */
export interface DdlScript {
  readonly prepare: readonly string[];
  readonly statements: readonly string[];
  readonly verify: readonly string[];
  readonly finish: readonly string[];
  readonly transactional: boolean;
  readonly notes: readonly string[];
}

/** Mirrors `ObjectFeatures` in plugin-api. */
export interface ObjectFeatures {
  readonly types: readonly string[];
  readonly checks: boolean;
  readonly comments: boolean;
  readonly cascade: boolean;
  readonly truncate: boolean;
  readonly namespaceKind: "schema" | "database" | null;
  readonly renamable: readonly ObjectKind[];
  readonly droppable: readonly ObjectKind[];
}

/** What `objects.apply` ran. */
export interface AppliedChange {
  readonly statements: number;
  readonly elapsedMs: number;
}

/** Mirrors `CachedCatalog` in core: a catalog and when, and how fast, it was read. */
export interface DescribedCatalog {
  readonly catalog: NamespaceCatalog;
  /** Epoch milliseconds. */
  readonly introspectedAt: number;
  readonly elapsedMs: number;
}

/**
 * The one datasource an engine host serves. Main assembles it from `datasources.json` and the
 * secret store, so `config` carries decrypted secrets and never travels to the renderer.
 */
export interface DatasourceConfig {
  readonly id: string;
  readonly pluginId: string;
  readonly config: unknown;
  /** Every session asks the database to refuse writes (decision 011). */
  readonly readOnly: boolean;
  /**
   * Seconds of silence before TCP keepalive probes on every session this host opens, and how long a
   * console session may idle before the engine pings it; 0 turns both off (decision 054).
   */
  readonly keepAliveSeconds: number;
  /** The SSH tunnel every session goes through (decision 070), its secrets decrypted; absent: direct. */
  readonly ssh?: SshTunnelConfig;
}

/** Mirrors `SshAuthMethod` in core. */
export type SshAuthMethod = "password" | "key" | "agent";

/** Mirrors `SshEndpoint` in core. */
export interface SshTunnelConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuthMethod;
  readonly password?: string;
  readonly keyPath?: string;
  readonly passphrase?: string;
}

/** What an engine posts on its parent port to ask main whether to trust an SSH host key (decision 071). */
export const ENGINE_HOST_KEY_MESSAGE = "engine.host-key";
/** What main posts back on the engine's parent port with the verdict on one host key. */
export const ENGINE_HOST_KEY_ANSWER_MESSAGE = "engine.host-key-answer";

/** Mirrors `HostKeyOffer` in core: the key an SSH server presented, `key` its base64 blob. */
export interface HostKeyOffer {
  readonly host: string;
  readonly port: number;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly key: string;
}

export interface EngineHostKeyRequest {
  readonly kind: typeof ENGINE_HOST_KEY_MESSAGE;
  readonly requestId: number;
  readonly offer: HostKeyOffer;
}

/**
 * `rejected`: the key was unknown and the user, or the lack of a window to ask in, declined it;
 * `changed`: a different key is on record for the host, so it was refused without asking.
 */
export type HostKeyVerdict =
  | { readonly verdict: "trusted" }
  | { readonly verdict: "rejected" }
  | { readonly verdict: "changed"; readonly knownFingerprint: string; readonly file: string };

export type EngineHostKeyAnswer = HostKeyVerdict & {
  readonly kind: typeof ENGINE_HOST_KEY_ANSWER_MESSAGE;
  readonly requestId: number;
};

/** The SSH hop of a tunnelled Test Connection (decision 070). */
export interface SshHop {
  readonly host: string;
  readonly user: string;
  readonly elapsedMs: number;
}

/** `serve` answers renderer ports until the last closes; `probe` tests one connection and exits. */
export type EngineMode = "serve" | "probe";

export interface EngineBoot {
  readonly kind: typeof ENGINE_BOOT_MESSAGE;
  readonly mode: EngineMode;
  readonly datasource: DatasourceConfig;
  /** Directories whose subdirectories are plugins, in precedence order (decision 005). */
  readonly pluginRoots: readonly string[];
}

/**
 * What Test Connection shows: the server that answered, or why none did. `ssh` is the tunnel's hop
 * when it opened, so a failure past it still says the bastion was reached.
 */
export type ProbeResult =
  | {
      readonly ok: true;
      readonly pluginName: string;
      readonly serverVersion: string | null;
      readonly elapsedMs: number;
      readonly ssh?: SshHop;
    }
  | { readonly ok: false; readonly error: EngineError; readonly ssh?: SshHop };

/** `record` is a `LogRecord` (`log/record.ts`); main validates it and sets its `process`. */
export interface EngineLog {
  readonly kind: typeof ENGINE_LOG_MESSAGE;
  readonly record: unknown;
}

export interface EngineProbed {
  readonly kind: typeof ENGINE_PROBED_MESSAGE;
  readonly result: ProbeResult;
}

/** Mirrors `ResultWindow` in core; `matches` are flat `row, column` pairs while a find is set. */
export interface ResultWindow {
  readonly offset: number;
  readonly rows: readonly Row[];
  readonly matches?: readonly number[];
}

/** Mirrors `TypeClass` in core: what a column holds, for its header glyph. */
export type TypeClass = "integer" | "float" | "decimal" | "boolean" | "temporal" | "json" | "bytes" | "text";

/** Mirrors `ResultState` in core: how far a result has been read, and whether more can be. */
export interface ResultState {
  readonly rowCount: number;
  readonly complete: boolean;
  readonly cursorOpen: boolean;
  /** What the server said running the statement; present once the result is complete and it said anything. */
  readonly messages?: readonly ServerMessage[];
}

/** Mirrors `SortDirection` in core. */
export type SortDirection = "asc" | "desc";

/** Mirrors `SortKey` in core: a column index and its direction. */
export interface SortKey {
  readonly column: number;
  readonly direction: SortDirection;
}

/** Mirrors `FindQuery` in core: what the grid's find bar looks for (decision 050). */
export interface FindQuery {
  readonly text: string;
  readonly caseSensitive: boolean;
  readonly regex: boolean;
  readonly wholeCell: boolean;
}

/** Mirrors `FilterChip` in core: a local quick filter; `text` is the value's database text. */
export type FilterChip =
  | { readonly column: number; readonly op: "equals" | "notEquals"; readonly text: string }
  | { readonly column: number; readonly op: "isNull" | "isNotNull" };

export type FilterOp = FilterChip["op"];

/** Mirrors `DisplayFormats` in core. */
export interface DisplayFormats {
  readonly groupDigits: boolean;
}

/** Mirrors `ViewSpec` in core: the find query and filters, over the columns the grid draws. */
export interface ViewSpec {
  readonly find: FindQuery | null;
  readonly rowsOnly: boolean;
  readonly filters: readonly FilterChip[];
  readonly columns: readonly number[];
  readonly formats: DisplayFormats;
}

/** Mirrors `ViewState` in core: rows shown, held positions when filtered, and the match count. */
export interface ViewState {
  readonly shown: number;
  readonly filtered: boolean;
  readonly sources: readonly number[] | null;
  readonly matches: number;
  readonly error: string | null;
}

/** Mirrors `FoundMatch` in core. */
export interface FoundMatch {
  readonly index: number;
  readonly row: number;
  readonly column: number;
}

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
 * Where a script stopped (decision 081): the file, and the line and column (from 1) the failing
 * statement starts at, with its first characters; all null when the run failed before a statement.
 */
export interface ScriptError extends EngineError {
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly statement: string | null;
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
  readonly error: ScriptError | null;
}

export const SCRIPT_EVENT_TYPES = ["script.progress", "script.done", "script.failed", "script.cancelled"] as const;
export type ScriptEventType = (typeof SCRIPT_EVENT_TYPES)[number];

/** Pushed by the engine to every connection, unasked, like `ExportEvent`. */
export interface ScriptEvent {
  readonly id: null;
  readonly type: ScriptEventType;
  readonly task: ScriptTask;
}

export type EngineEvent = ExportEvent | ImportEvent | ScriptEvent;

/** Mirrors `ResultSummary` in core, with the first window and the session's transaction attached. */
export interface ExecutedStatement extends ResultState {
  readonly handle: string;
  readonly columns: readonly Column[];
  readonly typeClasses: readonly TypeClass[];
  readonly rowsAffected: number | null;
  readonly firstWindow: ResultWindow;
  /** Whether the session holds a transaction open after the statement; always false without `transactions`. */
  readonly transactionOpen: boolean;
  /**
   * Present only when the engine read the session's namespace after the statement: it may have
   * switched one (decision 048). Absent, the console keeps the namespace it had.
   */
  readonly namespace?: CurrentNamespace;
  /** Present when the engine replaced a lost session before running the statement (decision 054). */
  readonly reconnected?: Reconnection;
}

/** A lost session the engine replaced with a new one under the same `sessionId`. */
export interface Reconnection {
  /** Where the new session starts. */
  readonly namespace: CurrentNamespace;
  /** Whether the old session had moved away from where a session starts, by USE or a search path. */
  readonly namespaceLost: boolean;
  /**
   * Why the old session was replaced when it was not lost (decision 058): its last result did not
   * close within the grace, or the plugin refused a statement as busy. Absent when it was lost.
   */
  readonly reason?: "resultNotClosed" | "sessionBusy";
}

/** Mirrors `CellInput` in core: text the database casts, `NULL`, or the column's default. */
export type CellInput =
  { readonly kind: "text"; readonly text: string } | { readonly kind: "null" } | { readonly kind: "default" };

/** Mirrors `RowEdit` in core; `row` indexes the table result's held rows. */
export type RowEdit =
  | {
      readonly kind: "update";
      readonly row: number;
      readonly values: readonly { readonly column: number; readonly value: CellInput }[];
    }
  | { readonly kind: "insert"; readonly values: readonly CellInput[] }
  | { readonly kind: "delete"; readonly row: number };

/** Mirrors `EditableIdentity` in core: the key columns that name a row, or why the table is read-only. */
export type EditableIdentity = { readonly identity: readonly string[] } | { readonly readOnly: string };

/** What `table.query` answers: the rows, the SQL that read them, and how they may be edited (decision 026). */
export interface TableQuery {
  readonly statement: ExecutedStatement;
  readonly sql: string;
  readonly editable: EditableIdentity;
  /** The catalog's view of each result column, in result order. */
  readonly columns: readonly ColumnMeta[];
  /** The table's own foreign keys, for go-to-referenced. */
  readonly foreignKeys: readonly ForeignKey[];
  /** Foreign keys of described tables that point at this one, for show-referencing. */
  readonly referencing: readonly ReferencingKey[];
}

/** Whether a console result may be edited in its grid, and how (decision 056). */
export interface ResultEditable {
  readonly editable: EditableIdentity;
  /** The catalog's view of each result column, or what the driver reported for an expression. */
  readonly columns: readonly ColumnMeta[];
  /** Per result column: a computed, aliased-expression or repeated column no edit may write. */
  readonly readOnlyColumns: readonly boolean[];
}

/** A foreign key of the relation at `path`.`relation` that points at another table. */
export interface ReferencingKey {
  readonly path: readonly string[];
  readonly relation: string;
  readonly foreignKey: ForeignKey;
}

/** Mirrors `SubmittedEdits` in core. */
export interface SubmittedEdits {
  readonly statements: readonly string[];
  readonly rowsAffected: number;
}

/** A column a value condition matches on: the result column whose values it reads, written as `name`. */
export interface ConditionColumn {
  readonly column: number;
  readonly name: string;
}

/** Mirrors `OrderTerm` in core: one ORDER BY term by column name. */
export interface OrderTerm {
  readonly name: string;
  readonly direction: SortDirection;
}

/** Mirrors `COMPLETION_KINDS` in plugin-api. */
export const COMPLETION_KINDS = [
  "namespace",
  "table",
  "view",
  "column",
  "alias",
  "cte",
  "join",
  "function",
  "keyword",
] as const;

export type CompletionKind = (typeof COMPLETION_KINDS)[number];

/** Mirrors `CompletionItem` in plugin-api. */
export interface CompletionItem {
  readonly label: string;
  readonly kind: CompletionKind;
  readonly detail: string | null;
  readonly apply: string;
  readonly boost: number;
}

/** Mirrors `CompletionScope` in plugin-api: the table a clause body is written against. */
export interface CompletionScope {
  readonly path: readonly string[];
  readonly relation: string;
}

/** Mirrors `CompletionResult` in plugin-api. */
export interface CompletionResult {
  readonly from: number;
  readonly to: number;
  readonly items: readonly CompletionItem[];
  /** A regular expression source the editor may keep filtering with; null to ask on every keystroke. */
  readonly validFor: string | null;
}

/** Mirrors `Declaration` in plugin-api. */
export type Declaration =
  | { readonly kind: "alias" | "cte"; readonly from: number; readonly to: number }
  | { readonly kind: "relation"; readonly path: readonly string[]; readonly relation: string }
  | { readonly kind: "column"; readonly path: readonly string[]; readonly relation: string; readonly column: string };

/** Mirrors `Explainability` in plugin-api. */
export type Explainability =
  { readonly ok: true; readonly writes: boolean } | { readonly ok: false; readonly reason: string };

/** Mirrors `PlanProperty` in plugin-api. */
export interface PlanProperty {
  readonly name: string;
  readonly value: string;
}

/** Mirrors `PlanNode` in plugin-api: one operator of the plan, numbers or null where the dialect says nothing. */
export interface PlanNode {
  readonly operation: string;
  readonly target: string | null;
  readonly detail: string | null;
  readonly estimatedRows: number | null;
  readonly estimatedCost: number | null;
  readonly actualRows: number | null;
  readonly actualTimeMs: number | null;
  readonly loops: number | null;
  readonly properties: readonly PlanProperty[];
  readonly children: readonly PlanNode[];
}

/** Mirrors `ExplainedPlan` in plugin-api. */
export interface ExplainedPlan {
  /** The EXPLAIN statement the plugin sent. */
  readonly statement: string;
  readonly analyzed: boolean;
  readonly roots: readonly PlanNode[];
  readonly summary: readonly PlanProperty[];
  /** What the database printed, for the Raw view. */
  readonly raw: string;
  readonly messages?: readonly ServerMessage[];
}

export interface ExplainedStatement {
  readonly plan: ExplainedPlan;
  /** Whether the session's transaction is open after the explain, as `ExecutedStatement` reports it. */
  readonly transactionOpen: boolean;
  readonly reconnected?: Reconnection;
}

export interface OpenedSession {
  readonly sessionId: string;
  /** The datasource's plugin, by its manifest name, for display only. */
  readonly pluginName: string;
  readonly capabilities: readonly Capability[];
  /** What the server reports about itself, for the status bar; null when it reports nothing. */
  readonly serverVersion: string | null;
  /** Where the session starts; always null without `currentNamespace`. */
  readonly namespace: CurrentNamespace;
}

/**
 * The user's paging preferences, sent with every call that reads rows, because the engine keeps no
 * preferences of its own (decision 032).
 */
export interface ResultPaging {
  /** Rows read when the statement runs, and per Fetch Next Page. */
  readonly pageRows: number;
  /** The most rows the result holds; Fetch All stops there and closes the cursor. */
  readonly fetchAllCap: number;
}

/**
 * How long the statement may run before the engine cancels it with `statementTimedOut`; 0 or absent
 * for no limit. The renderer resolves it from the data source and Settings (decision 054).
 */
export interface StatementLimit {
  readonly timeoutSeconds?: number;
}

/** The engine's calls: what each request carries and what its response answers with. */
export interface EngineCalls {
  "session.open": { params: Record<never, never>; result: OpenedSession };
  /** Closes the session and releases every result it produced. */
  "session.close": { params: { readonly sessionId: string }; result: null };
  /**
   * With `parameters`, the plugin binds them to the placeholders in `sql` (decision 043); a name
   * without a value fails with `statementFailed`. Without, `sql` runs verbatim.
   */
  "statement.execute": {
    params: {
      readonly sessionId: string;
      readonly sql: string;
      readonly parameters?: Readonly<Record<string, ParameterValue>>;
    } & ResultPaging &
      StatementLimit;
    result: ExecutedStatement;
  };
  /** Cancels the statement running in the session, if any; its `statement.execute` fails with `cancelled`. */
  "statement.cancel": { params: { readonly sessionId: string }; result: null };
  /** Splits and classifies `text` with the datasource plugin's language; needs no session. */
  "script.split": { params: { readonly text: string }; result: readonly ClassifiedStatement[] };
  /** `text` laid out by the plugin's language (decision 042); fails with `formatFailed` and the reason. Needs no session. */
  "sql.format": { params: { readonly text: string; readonly options: FormatOptions }; result: string };
  /** Whether the plugin's language can explain `sql` (one statement), and whether it writes; needs no session. Needs `explain`. */
  "sql.explainable": {
    params: { readonly sql: string; readonly analyze: boolean };
    result: Explainability;
  };
  /**
   * Explains `sql` on the session, closing its open cursor first; with `analyze` the statement runs
   * (decision 031) and `statement.cancel` stops it. Needs `explain`, and `explainAnalyze` for `analyze`.
   */
  "statement.explain": {
    params: { readonly sessionId: string; readonly sql: string; readonly analyze: boolean } & StatementLimit;
    result: ExplainedStatement;
  };
  /** Switching to `auto` while a transaction is open fails with `statementFailed`. Needs `transactions`. */
  "transaction.setMode": {
    params: { readonly sessionId: string; readonly mode: TransactionMode };
    result: TransactionState;
  };
  /** Commits the open transaction; does nothing when none is open. Needs `transactions`. */
  "transaction.commit": { params: { readonly sessionId: string }; result: TransactionState };
  /** Rolls back the open transaction; does nothing when none is open. Needs `transactions`. */
  "transaction.rollback": { params: { readonly sessionId: string }; result: TransactionState };
  "result.window": {
    params: { readonly handle: string; readonly offset: number; readonly limit: number };
    result: ResultWindow;
  };
  /** Closes the result's cursor and drops its rows. */
  "result.release": { params: { readonly handle: string }; result: null };
  /** Reads one more page, or with `all` up to `fetchAllCap`; a no-op once the cursor is closed. */
  "result.fetchMore": {
    params: { readonly handle: string; readonly all: boolean } & ResultPaging;
    result: ResultState;
  };
  /** Ends a running fetch after its current row; the cursor stays open. */
  "result.stopFetch": { params: { readonly handle: string }; result: ResultState };
  /** Sorts the held rows in the engine; windows read through the new order. No keys restores it. */
  "result.sort": { params: { readonly handle: string; readonly keys: readonly SortKey[] }; result: ResultState };
  /**
   * Sets the find query and local filters later windows, copies and shown-only exports see; null
   * clears them (decision 050). Recomputed in the engine after every fetch and sort.
   */
  "result.view": { params: { readonly handle: string; readonly spec: ViewSpec | null }; result: ViewState };
  /** The view as it stands, after a fetch or sort changed the held rows. */
  "result.viewState": { params: { readonly handle: string }; result: ViewState };
  /** The match after `from` (before it, `backward`), wrapping; null when nothing matches. */
  "result.findMatch": {
    params: {
      readonly handle: string;
      readonly from: { readonly row: number; readonly column: number } | null;
      readonly backward: boolean;
    };
    result: FoundMatch | null;
  };
  /** The given rows and columns as `extractor` text, for the clipboard. */
  /**
   * Whether a console result can be edited in its grid (decision 056): the plugin reads the
   * statement, the catalog names the key, the driver's column origins confirm. After it answers an
   * editable result, `edits.preview` and `edits.submit` accept the handle.
   */
  "result.editable": {
    params: {
      readonly handle: string;
      /** The console's namespace, which unqualified names resolve against. */
      readonly current?: readonly string[];
    };
    result: ResultEditable;
  };
  "result.extract": {
    params: {
      readonly handle: string;
      readonly extractor: ExtractorKind;
      readonly rows: readonly RowRange[];
      readonly columns: readonly number[];
    };
    result: string;
  };
  /**
   * Starts a background export to `path` and answers at once with the task; progress and the end
   * arrive as `ExportEvent`s (decision 040). The stall timeout is the `data.exportStallSeconds`
   * setting, which the engine cannot read itself.
   */
  "export.start": {
    params: {
      readonly source: ExportSource;
      readonly format: ExportFormat;
      readonly path: string;
      readonly stallSeconds: number;
    };
    result: ExportTask;
  };
  /** Stops a running export; its `.part` file is removed. A finished task is left as it is. */
  "export.cancel": { params: { readonly taskId: string }; result: null };
  /** Runs a failed or cancelled re-run or table export again, from the first row, as a new task. */
  "export.retry": { params: { readonly taskId: string; readonly stallSeconds: number }; result: ExportTask };
  /** Every task this engine ran, for a renderer that reloaded. */
  "export.list": { params: Record<never, never>; result: readonly ExportTask[] };
  /** Reads the head of `file` with `format`: names, rows, inferred kinds and the plugin's types. Needs `bulkInsert`. */
  "import.preview": { params: { readonly file: string; readonly format: ImportFormat }; result: ImportPreview };
  /** The CREATE TABLE a new-table import runs first, written by the plugin's language (decision 008). */
  "import.ddl": {
    params: {
      readonly path: readonly string[];
      readonly relation: string;
      readonly columns: readonly NewImportColumn[];
    };
    result: string;
  };
  /**
   * Starts a background import of `file` into `target` and answers at once with the task; progress
   * and the end arrive as `ImportEvent`s (decision 046). A new table is created before it answers.
   */
  "import.start": {
    params: {
      readonly file: string;
      readonly format: ImportFormat;
      readonly target: ImportTarget;
      readonly transaction: ImportTransaction;
      readonly errors: ImportErrorPolicy;
      readonly stallSeconds: number;
    };
    result: ImportTask;
  };
  /** Stops a running import; what it had not committed is rolled back. */
  "import.cancel": { params: { readonly taskId: string }; result: null };
  /**
   * Runs a finished import's job again as a new task from its `resumeFrom` row: a resume after a
   * partial commit, a retry from the first row when nothing was committed.
   */
  "import.resume": { params: { readonly taskId: string; readonly stallSeconds: number }; result: ImportTask };
  /** Every import this engine ran, for a renderer that reloaded. */
  "import.list": { params: Record<never, never>; result: readonly ImportTask[] };
  /**
   * Runs `files` (absolute paths) one after another on a session of the task's own, in auto-commit,
   * first switching to `namespace` when given; answers at once with the task. The files are
   * streamed through the plugin's splitter and stop at the first failing statement (decision 081).
   */
  "script.run": {
    params: { readonly files: readonly string[]; readonly namespace: readonly string[] | null };
    result: ScriptTask;
  };
  /** Stops a running script between statements, cancelling the one in flight where the plugin can. */
  "script.cancel": { params: { readonly taskId: string }; result: null };
  /** Every script this engine ran, for a renderer that reloaded. */
  "script.list": { params: Record<never, never>; result: readonly ScriptTask[] };
  /** What the plugin's object editor can write: types, checks, comments, cascade, the kinds it renames and drops. Needs `objects`. */
  "objects.features": { params: Record<never, never>; result: ObjectFeatures };
  /** Table `relation` as the Modify Table dialog starts from it, described afresh. Needs `objects`. */
  "objects.design": { params: { readonly path: readonly string[]; readonly relation: string }; result: TableDesign };
  /** The statements `change` takes, written by the plugin and not run (decision 052). Needs `objects`. */
  "objects.script": { params: { readonly change: ObjectChange }; result: DdlScript };
  /**
   * Writes `change` again and runs it on a session of its own, in one transaction where the database
   * has transactional DDL. Refuses when the script differs from `statements`, what the preview
   * showed, or while an import or export uses the table; then refreshes the namespace's catalog.
   */
  "objects.apply": {
    params: { readonly change: ObjectChange; readonly statements: readonly string[] };
    result: AppliedChange;
  };
  /**
   * The datasource's namespaces, from the engine's cache unless `refresh`; the first call opens the
   * engine's introspection session (decision 022). Needs `schemaTree`.
   */
  "catalog.namespaces": { params: { readonly refresh?: boolean }; result: readonly Namespace[] };
  /**
   * The namespaces a console can switch to, in catalog order: `catalog.namespaces` narrowed to the
   * plugin's switch targets. Needs `currentNamespace`.
   */
  "namespace.targets": { params: { readonly refresh?: boolean }; result: readonly Namespace[] };
  /** The plugin's statement that switches a session to `path` (decision 060). Needs `currentNamespace`. */
  "namespace.switchStatement": { params: { readonly path: readonly string[] }; result: SwitchStatement };
  /** One namespace's objects, from the engine's cache unless `refresh`. Needs `schemaTree`. */
  "catalog.describe": {
    params: { readonly path: readonly string[]; readonly refresh?: boolean };
    result: DescribedCatalog;
  };
  /** `name` inside `path`, quoted by the plugin (decision 008). Needs `schemaTree`. */
  "catalog.qualifiedName": { params: { readonly path: readonly string[]; readonly name: string }; result: string };
  /**
   * The statements that create relation `name`, read from the database on the introspection session
   * and never cached (decision 029). Fails with `definitionNotFound` when it is gone. Needs `ddl`.
   */
  "catalog.definition": { params: { readonly path: readonly string[]; readonly name: string }; result: string };
  /**
   * A statement over relation `name` from the cached catalog, written by the plugin's language;
   * `create` answers what `catalog.definition` does. Needs `sql`, and `ddl` for `create`.
   */
  "sql.generate": {
    params: { readonly path: readonly string[]; readonly name: string; readonly statement: GeneratorStatement };
    result: string;
  };
  /**
   * Opens `relation` in the table editor: `SELECT *` with the bars' clauses verbatim, run on the
   * session, plus its identity from the catalog cache (decision 026). Its result refuses local sort.
   */
  "table.query": {
    params: {
      readonly sessionId: string;
      readonly path: readonly string[];
      readonly relation: string;
      readonly where: string;
      readonly orderBy: string;
    } & ResultPaging &
      StatementLimit;
    result: TableQuery;
  };
  /** `SELECT COUNT(*)` with the WHERE bar, on the engine's own session so the editor's cursor stays open. */
  "table.count": {
    params: { readonly path: readonly string[]; readonly relation: string; readonly where: string };
    result: number;
  };
  /**
   * A WHERE condition matching the values `rows` hold in `columns`, written with the plugin's literals,
   * for Filter by This Value and foreign-key navigation.
   */
  "table.condition": {
    params: {
      readonly handle: string;
      readonly rows: readonly number[];
      readonly columns: readonly ConditionColumn[];
    };
    result: string;
  };
  /**
   * What may be typed at `offset` in `text`, read from the catalog cache and never from a console's
   * session (decision 028). With `scope`, `text` is a clause body against that table. Needs `sql`.
   */
  "completion.complete": {
    params: {
      readonly text: string;
      readonly offset: number;
      readonly scope?: CompletionScope;
      /** The console's namespace, which unqualified names resolve against instead of the catalog's. */
      readonly current?: readonly string[];
    };
    result: CompletionResult;
  };
  /** Where the name at `offset` was declared; null when it names nothing known. Needs `sql`. */
  "navigation.resolve": {
    params: { readonly text: string; readonly offset: number; readonly current?: readonly string[] };
    result: Declaration | null;
  };
  /** The ORDER BY bar's text for header-click sorting, names quoted by the plugin; empty for no terms. */
  "table.orderBy": { params: { readonly terms: readonly OrderTerm[] }; result: string };
  /** The statements `edits.submit` would run, in order, without running them. */
  "edits.preview": {
    params: { readonly handle: string; readonly edits: readonly RowEdit[] };
    result: readonly string[];
  };
  /**
   * Runs the edits in one transaction on the table's session; any statement that fails or touches
   * other than one row rolls everything back with `editRejected` (decision 026). A console result's
   * edits run on the console's session in its transaction mode: in manual mode they stay in its
   * open transaction, and a rejected batch undoes only itself (decision 056).
   */
  "edits.submit": {
    params: { readonly sessionId: string; readonly handle: string; readonly edits: readonly RowEdit[] };
    result: SubmittedEdits & { readonly transactionOpen: boolean };
  };
}

export type EngineMethod = keyof EngineCalls;

export type RequestOf<M extends EngineMethod> = { readonly id: number; readonly type: M } & EngineCalls[M]["params"];
export type EngineRequest = { [M in EngineMethod]: RequestOf<M> }[EngineMethod];

export type ResultOf<M extends EngineMethod> = EngineCalls[M]["result"];
export interface EngineResult<M extends EngineMethod = EngineMethod> {
  readonly id: number;
  readonly type: M;
  readonly result: ResultOf<M>;
}

/** Core's codes, plus the ones only the engine can raise. */
export type EngineErrorCode =
  | "unknownHandle"
  | "unknownPlugin"
  | "pluginUnavailable"
  | "invalidConfig"
  | "unknownSession"
  | "connectionFailed"
  | "statementFailed"
  | "cancelled"
  | "introspectionFailed"
  | "definitionNotFound"
  | "explainUnsupported"
  | "formatFailed"
  | "invalidRequest"
  | "editRejected"
  | "timedOut"
  | "statementTimedOut"
  | "connectionLost"
  | "sessionBusy"
  | "exportFailed"
  | "importFailed"
  | "scriptFailed"
  | "objectBusy"
  | "sshAuthFailed"
  | "sshHostUnreachable"
  | "sshHostKeyChanged"
  | "sshHostKeyUnknown"
  | "sshTunnelLost"
  | "internal";

export interface EngineError {
  readonly code: EngineErrorCode;
  readonly message: string;
  /** What the user can do next. */
  readonly hint: string;
  /** For `editRejected`: the 0-based index of the statement that failed or touched the wrong rows. */
  readonly statementIndex?: number;
}

export interface EngineErrorMessage {
  /** The request that failed, or `null` when the request was unreadable. */
  readonly id: number | null;
  readonly type: "engine.error";
  readonly error: EngineError;
}

export type EngineResponse = { [M in EngineMethod]: EngineResult<M> }[EngineMethod] | EngineErrorMessage;
