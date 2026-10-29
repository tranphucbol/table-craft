import type {
  CompletionResult,
  CompletionScope,
  Declaration,
  DescribedCatalog,
  Namespace,
  Routine,
  RoutineArgument,
  RoutineCall,
  SignatureHelp,
} from "./catalog.js";
import type { Problem } from "./inspection.js";
import type { AppliedChange, DdlScript, ObjectChange, ObjectFeatures, TableDesign } from "./objects.js";
import type {
  FoundMatch,
  CellBytes,
  ResultState,
  ResultWindow,
  SelectionAggregates,
  StagedBytes,
  SortKey,
  ViewSpec,
  ViewState,
} from "./results.js";
import type {
  ExecutedStatement,
  OpenedSession,
  SessionTarget,
  SessionsListing,
  SwitchStatement,
  TransactionMode,
  TransactionState,
} from "./sessions.js";
import type {
  ClassifiedStatement,
  Explainability,
  ExplainedStatement,
  FormatOptions,
  GeneratorStatement,
  ParameterValue,
} from "./sql.js";
import type {
  KeyApplied,
  KeyApplyOptions,
  KeyChange,
  KeyDatabases,
  KeyExpiry,
  KeyInfo,
  KeyName,
  KeyReadRange,
  KeyScan,
  KeyType,
  OpenedKey,
} from "./keyspace.js";
import type { ServerInfo, ServerNode, SlowCommand } from "./server.js";
import type { ConditionColumn, OrderTerm, ResultEditable, RowEdit, SubmittedEdits, TableQuery } from "./tables.js";
import type {
  ErrorAnswer,
  ExportFormat,
  ExportSource,
  ExportTask,
  ExtractorKind,
  ImportErrorPolicy,
  ImportFormat,
  ImportPreview,
  ImportTarget,
  ImportTask,
  ImportTransaction,
  NewImportColumn,
  OnErrorChoice,
  RowRange,
  ScriptTask,
} from "./transfer.js";
import type { ResultPaging, StatementLimit } from "./wire.js";

/** The engine's calls: what each request carries and what its response answers with. */
export interface EngineCalls {
  /** `readOnly` asks for a read-only session on a writable datasource; it never lifts the datasource's own flag. */
  "session.open": { params: { readOnly?: boolean }; result: OpenedSession };
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
      /** Where a command runs on a `nodes` datasource: `auto`, `allPrimaries` or a node id (decision 114). */
      readonly node?: string;
      /** The statement's `ClassifiedStatement.repeat`: the plugin runs it that many times. */
      readonly repeat?: number;
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
  /** Count, distinct, and sum, average, minimum and maximum of the given shown rows and columns. */
  "result.aggregate": {
    params: { readonly handle: string; readonly rows: readonly RowRange[]; readonly columns: readonly number[] };
    result: SelectionAggregates;
  };
  /**
   * Every byte of the cell at held row `row`, read again by the row's key when the result holds
   * only a preview. Refused past `maxBytes`, and for a result with no table to read from.
   */
  "result.cellBytes": {
    params: { readonly handle: string; readonly row: number; readonly column: number; readonly maxBytes: number };
    result: CellBytes;
  };
  /** Writes every byte of a cell to `path`, an absolute path the user chose; answers the length. */
  "result.saveBytes": {
    params: {
      readonly handle: string;
      readonly row: number;
      readonly column: number;
      readonly path: string;
      readonly maxBytes: number;
    };
    result: number;
  };
  /**
   * Reads the file at `path`, refused past `maxBytes`, and holds its bytes for the result's edits
   * until the result is released; a `bytes` cell input names them by the answered id.
   */
  "result.loadBytes": {
    params: { readonly handle: string; readonly path: string; readonly maxBytes: number };
    result: StagedBytes;
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
   * streamed through the plugin's splitter (decision 081); a failing statement stops the task,
   * pauses it for `script.answer`, or is skipped past, as `onError` says (decision 083).
   */
  "script.run": {
    params: {
      readonly files: readonly string[];
      readonly namespace: readonly string[] | null;
      readonly onError: OnErrorChoice;
    };
    result: ScriptTask;
  };
  /** Answers the failure a task paused on (`ScriptTask.question`); refused when it waits on none. */
  "script.answer": { params: { readonly taskId: string; readonly answer: ErrorAnswer }; result: null };
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
  /** Every server of the datasource, primaries first (decision 114). Needs `nodes`. */
  "server.nodes": { params: Record<never, never>; result: readonly ServerNode[] };
  /** What `node` (null: the server, or a primary) reports about itself. Needs `serverInfo`. */
  "server.info": { params: { readonly node: string | null }; result: ServerInfo };
  /** The newest `limit` slow commands of `node`, or of every primary for null. Needs `serverInfo`. */
  "server.slowLog": {
    params: { readonly node: string | null; readonly limit: number };
    result: readonly SlowCommand[];
  };
  /** The datasource's databases with their key counts (decision 113). Needs `keyValue`. */
  "keyspace.databases": { params: Record<never, never>; result: KeyDatabases };
  /** One batch of a pass over `database`'s keys; `cursor` null starts the pass. Needs `keyValue`. */
  "keyspace.scan": {
    params: {
      readonly database: number;
      readonly cursor: string | null;
      readonly match: string;
      readonly keyType: KeyType | null;
    };
    result: KeyScan;
  };
  /** Type and expiry of each key, in order. Needs `keyValue`. */
  "keyspace.describe": {
    params: { readonly database: number; readonly keys: readonly KeyName[] };
    result: readonly KeyInfo[];
  };
  /**
   * Reads `key` on the key tab's session: its rows go to the result store like a statement's, its
   * value comes back whole up to 1 MiB (decision 113). Needs `keyValue`.
   */
  "keyspace.open": {
    params: {
      readonly sessionId: string;
      readonly database: number;
      readonly key: KeyName;
      readonly range: KeyReadRange;
    } & ResultPaging &
      StatementLimit;
    result: OpenedKey;
  };
  /** The commands `keyspace.apply` would run for the changes, unnumbered. Needs `keyValue`. */
  "keyspace.preview": {
    params: { readonly key: KeyName; readonly changes: readonly KeyChange[]; readonly options: KeyApplyOptions };
    result: readonly string[];
  };
  /**
   * Runs the changes to one key as one `MULTI`; guarded, it fails with `conflict` and writes nothing
   * when an element changed since it was read (decision 115). Needs `keyValue`.
   */
  "keyspace.apply": {
    params: {
      readonly database: number;
      readonly key: KeyName;
      readonly changes: readonly KeyChange[];
      readonly options: KeyApplyOptions;
    };
    result: KeyApplied;
  };
  /** Renames a key; refused when `to` exists unless `overwrite`. Needs `keyValue`. */
  "keyspace.rename": {
    params: { readonly database: number; readonly key: KeyName; readonly to: KeyName; readonly overwrite: boolean };
    result: null;
  };
  /** Sets or removes a key's expiry. Needs `keyValue`. */
  "keyspace.expire": {
    params: { readonly database: number; readonly key: KeyName; readonly expiry: KeyExpiry };
    result: null;
  };
  /** Removes the keys and says how many existed. Needs `keyValue`. */
  "keyspace.remove": {
    params: { readonly database: number; readonly keys: readonly KeyName[] };
    result: number;
  };
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
   * The console text that calls the routine `name` (`kind`, `signature`) in `path` with `args`, one
   * per parameter, written by the plugin from the cached catalog (decision 090), and the value of
   * each `:marker` in it. Fails `invalidRequest` when the routine is not described, and
   * `statementFailed` when the arguments do not fit it. Needs `routineCall`.
   */
  "routine.call": {
    params: {
      readonly path: readonly string[];
      readonly name: string;
      readonly kind: Routine["kind"];
      readonly signature: string;
      readonly args: readonly RoutineArgument[];
    };
    result: RoutineCall;
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
  /**
   * The built-in function call around `offset` and the argument it is at, for the parameter hint
   * (decision 098); null outside a call the plugin documents. Needs `sql`.
   */
  "completion.signature": {
    params: { readonly text: string; readonly offset: number; readonly scope?: CompletionScope };
    result: SignatureHelp | null;
  };
  /**
   * Every problem in `text` found without running it, with quick fixes (plan 108), read from the
   * catalog cache like completion. Empty when the plugin has no `inspect`. Needs `sql`.
   */
  "inspection.inspect": {
    params: {
      readonly text: string;
      /** The console's namespace, which unqualified names resolve against instead of the catalog's. */
      readonly current?: readonly string[];
      /** Inspection ids the user turned off. */
      readonly disabled?: readonly string[];
    };
    result: readonly Problem[];
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
  /**
   * The server's sessions, read on the introspection session, each tagged with the engine session that
   * holds it when it is this engine's own. Needs `sessions` (decision 088).
   */
  "sessions.list": { params: Record<never, never>; result: SessionsListing };
  /** Runs the row's `cancel` statement on a fresh connection. Refused on a read-only data source. */
  "sessions.cancel": { params: { readonly target: SessionTarget }; result: null };
  /** Runs the row's `terminate` statement on a fresh connection. Refused on a read-only data source. */
  "sessions.terminate": { params: { readonly target: SessionTarget }; result: null };
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
  | "conflict"
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
  /**
   * For `statementFailed`: where the database located the error, as a 0-based offset into the
   * request's `sql` (decision 082); absent when it did not say, or when the text it ran was not the
   * request's own (bound parameters, Explain).
   */
  readonly position?: number;
}

export interface EngineErrorMessage {
  /** The request that failed, or `null` when the request was unreadable. */
  readonly id: number | null;
  readonly type: "engine.error";
  readonly error: EngineError;
}

export type EngineResponse = { [M in EngineMethod]: EngineResult<M> }[EngineMethod] | EngineErrorMessage;
