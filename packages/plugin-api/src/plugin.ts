import type { z } from "zod";
import type { Introspector, Namespace, Relation, Routine } from "./catalog.js";
import type {
  CompletionCatalog,
  CompletionRequest,
  CompletionResult,
  Declaration,
  ResolveRequest,
  SignatureHelp,
} from "./completion.js";
import type { ExplainedPlan, Explainability, ExplainOptions } from "./explain.js";
import type { InspectionRequest, Problem } from "./inspection.js";
import type { KeySource, Keyspace } from "./keyspace.js";
import type { ObjectEditor } from "./objects.js";
import type { SessionMonitor } from "./sessions.js";
import type { TypeClass, WireValue } from "./values.js";

/**
 * What a plugin can do. The UI branches on these, never on a plugin id (decision 007), and a
 * capability without contract-suite coverage cannot be declared (decision 013).
 */
export const CAPABILITIES = [
  "sql",
  "cancel",
  "schemaTree",
  "transactions",
  "ddl",
  "explain",
  "explainAnalyze",
  "currentNamespace",
  "keepAlive",
  "bulkInsert",
  "objects",
  "serverMessages",
  "sessions",
  "routineCall",
  "commands",
  "keyValue",
  "nodes",
  "serverInfo",
  "serverTimeout",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Statements `SqlLanguage.generate` writes from a catalog relation (plan 010). */
export const GENERATED_STATEMENTS = ["drop", "select", "insert", "update"] as const;

export type GeneratedStatement = (typeof GENERATED_STATEMENTS)[number];

export interface Column {
  readonly name: string;
  /** The type the database reports, verbatim; null when it reports none. */
  readonly type: string | null;
  /**
   * What the values are, when the type name alone does not say: Oracle's `NUMBER` is an integer
   * at scale 0 and a decimal otherwise. Absent, the host reads the class from `type` (decision 101).
   */
  readonly typeClass?: TypeClass;
  /**
   * The base-table column the driver says the value is read from (plan 026): null for an
   * expression, absent when the driver does not say. A console result is editable only where the
   * plugin's `selectSource` and this agree.
   */
  readonly origin?: ColumnOrigin | null;
}

/**
 * Where the driver says a result column comes from, in its own terms: a table id or qualified
 * name, and a column number or name. Stable within one result; compared, never shown or parsed.
 */
export interface ColumnOrigin {
  readonly table: string;
  readonly column: string;
}

export type Row = readonly WireValue[];

export interface ExecuteResult {
  /** Empty for a statement that returns no rows. */
  readonly columns: readonly Column[];
  /** Pulled lazily, so the host decides how many rows to fetch. */
  readonly rows: AsyncIterable<Row>;
  /** Null when the database does not report it, or the statement returns rows. */
  readonly rowsAffected: number | null;
  /**
   * What the server said about the statement besides its rows, such as MySQL's warnings or
   * PostgreSQL's notices (decision 066), in the order it said them, at most `SERVER_MESSAGE_LIMIT`
   * of them and one more saying how many were left out. Complete once `rows` is exhausted; empty
   * before that, and when the statement was cancelled or its rows abandoned. Present exactly when
   * the plugin declares `serverMessages`.
   */
  readonly messages?: readonly ServerMessage[];
  /**
   * A command's one-value answer, such as a status, a number or a string (decision 112): the
   * console shows it in Output and opens no result unless it is `read`. Only a `commands` plugin sets it, and then
   * `columns` and `rows` are empty.
   */
  readonly reply?: CommandReply;
  /**
   * The one key the command read, when it read exactly one (decision 119); absent for writes,
   * keyless and multi-key commands. Only a `keyValue` plugin sets it.
   */
  readonly source?: KeySource;
}

/** A scalar reply to a command (decision 112). */
export interface CommandReply {
  readonly value: WireValue;
  /** The reply as the server's own client prints it: `"Ann"`, `(integer) 5`, `(nil)`, `OK`. */
  readonly text: string;
  /**
   * The reply is a value read, such as a bulk string from `GET` or `HGET` or the nil of a missing
   * one (decision 119): the console opens it as a one-row `value` result besides Output. Absent
   * for statuses, numbers and errors, which stay in Output.
   */
  readonly read?: boolean;
}

/** How serious a `ServerMessage` is, from the server's own word for it. */
export const SERVER_MESSAGE_LEVELS = ["error", "warning", "notice", "info"] as const;

export type ServerMessageLevel = (typeof SERVER_MESSAGE_LEVELS)[number];

/** One thing the server said about a statement that succeeded (decision 066). */
export interface ServerMessage {
  readonly level: ServerMessageLevel;
  /** The server's code for it, such as `1815` or `01000`; null when it gives none. */
  readonly code: string | null;
  readonly text: string;
}

/** The most messages a plugin reports for one statement; past it, one more message says how many it left out. */
export const SERVER_MESSAGE_LIMIT = 100;

/** The message that stands for the ones past `SERVER_MESSAGE_LIMIT`. */
export function omittedMessages(count: number): ServerMessage {
  return {
    level: "info",
    code: null,
    text: `${String(count)} more server ${count === 1 ? "message is" : "messages are"} not shown.`,
  };
}

/** A value bound to a placeholder: text the server casts, or SQL NULL (decision 043). */
export type ParameterValue = string | null;

/** What one routine parameter is given: a value, or its declared default (decision 090). */
export type RoutineArgument = { readonly kind: "value"; readonly value: ParameterValue } | { readonly kind: "default" };

/** The console text that calls a routine, and the value for each `:marker` in it (decision 090). */
export interface RoutineCall {
  /** One statement per line; every value is a named placeholder, never a literal. */
  readonly sql: string;
  /** Keyed by marker with its colon, `:amount`: the record `bind` takes. */
  readonly params: Readonly<Record<string, ParameterValue>>;
}

export interface ExecuteOptions {
  /**
   * Ship every byte of a binary value (`BytesValue.preview` holds all of it) instead of the
   * preview. For an export, which writes values whole (decision 040); a grid never asks.
   */
  readonly fullBytes?: boolean;
  /**
   * Where a command runs, for a plugin that declares `nodes` (decision 114): `NODE_AUTO` (absent
   * means the same) lets the plugin route it, `NODE_ALL_PRIMARIES` runs it on every primary and
   * leads each row with a `node` column, and anything else is a `ServerNode.id`.
   */
  readonly node?: string;
  /**
   * `StatementSpan.repeat` of the statement, at least 2, when the script asks for it to run more
   * than once (SQL Server's `GO 3`, decision 100). A plugin that splits such scripts runs it that
   * many times and answers with the last run; any other plugin never receives it.
   */
  readonly repeat?: number;
  /**
   * Have the server itself stop the statement after this many milliseconds, at least 1 (decision
   * 129), through its own setting, never above a limit the server already had. The host sends it
   * only to a session whose `serverTimeout` is not null. Absent: the plugin puts back the
   * server's own value. A statement the server stops rejects with `timedOut`.
   */
  readonly serverTimeoutMs?: number;
}

/** What the connected server stops by itself once `ExecuteOptions.serverTimeoutMs` passes (decision 129). */
export interface ServerTimeout {
  /** The server's own name for it, for messages: `max_execution_time`, `statement_timeout`. */
  readonly setting: string;
  /** `reads`: only `SELECT` (and `SELECT … FOR UPDATE`); `all`: every statement. */
  readonly covers: "reads" | "all";
  /**
   * `statement`: from the start until the last row is sent, so a result read slowly is cut too;
   * `serverWork`: only while the server works on it.
   */
  readonly counts: "statement" | "serverWork";
}

/** `ExecuteOptions.node`: the plugin routes the command by its keys (decision 114). */
export const NODE_AUTO = "auto";
/** `ExecuteOptions.node`: the command runs once on every primary (decision 114). */
export const NODE_ALL_PRIMARIES = "allPrimaries";

export const NODE_ROLES = ["primary", "replica"] as const;

export type NodeRole = (typeof NODE_ROLES)[number];

/** One server of the datasource (decision 114); a standalone server is one primary. */
export interface ServerNode {
  /** Stable while the cluster is: Redis' node id, or the address of a standalone server. */
  readonly id: string;
  /** `host:port`, as the client reaches it. */
  readonly address: string;
  readonly role: NodeRole;
  /** Inclusive hash-slot ranges a primary serves; empty for a replica and a standalone server. */
  readonly slots: readonly (readonly [number, number])[];
  /** The primary a replica follows; null for a primary. */
  readonly primaryId: string | null;
  /** The server's word for its health, such as `connected` or `fail`. */
  readonly state: string;
}

/** A titled group of a server's figures, such as Redis' `# Memory` section of `INFO` (decision 114). */
export interface ServerInfoSection {
  readonly title: string;
  readonly entries: readonly { readonly name: string; readonly value: string }[];
}

/** One slow-log entry: when, for how long, what ran, and from where. */
export interface SlowCommand {
  readonly id: number;
  /** ISO-8601. */
  readonly at: string;
  readonly durationMicros: number;
  readonly command: string;
  readonly client: string | null;
  readonly node: string | null;
}

/** What `Session.serverInfo` reads about one node. */
export interface ServerInfo {
  /** The node, or null for a standalone server. */
  readonly node: string | null;
  readonly sections: readonly ServerInfoSection[];
}

/** Kinds a file importer infers from a column's text, narrowest first within each family (plan 021). */
export const IMPORT_KINDS = ["boolean", "integer", "bigint", "decimal", "double", "date", "timestamp", "text"] as const;

export type ImportKind = (typeof IMPORT_KINDS)[number];

/** What a sample of one column's text looks like; `integerDigits` and `scale` are the widest `decimal` seen. */
export interface InferredColumn {
  readonly kind: ImportKind;
  readonly integerDigits: number;
  readonly scale: number;
}

/** A column of a table an import creates, typed in the dialect. */
export interface NewColumn {
  readonly name: string;
  readonly type: string;
}

/** Where `Session.insertRows` writes: `table` as the introspector qualifies it, `columns` as it describes them. */
export interface InsertTarget {
  readonly table: string;
  readonly columns: readonly Column[];
}

/** One row for `Session.insertRows`, a value per target column: text as a file holds it, or SQL NULL. */
export type InsertRow = readonly ParameterValue[];

export interface Session {
  /**
   * Rejects with a `PluginError`: `cancelled` when `cancel` interrupted it, `connectionLost` when
   * the connection was gone before the statement was sent, `sessionBusy` when an earlier statement
   * or its result has not finished closing, `statementFailed` otherwise. A session runs one
   * statement at a time. `params` are bound by the driver to the
   * dialect's native placeholders in `sql`, as `SqlLanguage.bind` wrote them; never spliced.
   */
  execute(sql: string, params?: readonly ParameterValue[], options?: ExecuteOptions): Promise<ExecuteResult>;
  /**
   * Present exactly when the plugin declares `cancel`. Interrupts the running statement, which
   * then rejects with `cancelled`, and leaves the session usable; a no-op when nothing runs.
   */
  cancel?(): Promise<void>;
  /** Present exactly when the plugin declares `schemaTree`. */
  readonly introspector?: Introspector;
  /** Present exactly when the plugin declares `transactions`. A new session starts in `auto`. */
  readonly transactions?: Transactions;
  /**
   * Present exactly when the plugin declares `explain` (decision 031). Checks `sql` with
   * `SqlLanguage.explainable` and rejects with `explainUnsupported` and its reason when refused;
   * otherwise sends the dialect's EXPLAIN on this session, like `execute`, and reads the whole plan.
   * With `analyze`, which needs `explainAnalyze`, the statement runs, in this session's transaction.
   * `cancel` interrupts it as it does `execute`.
   */
  explain?(sql: string, options: ExplainOptions): Promise<ExplainedPlan>;
  /**
   * Present exactly when the plugin declares `currentNamespace` (decision 048). Asks the server
   * which namespace unqualified names resolve against now, as an introspector namespace path; null
   * when none does. Never opens a transaction, and the host calls it only while nothing runs.
   */
  currentNamespace?(): Promise<readonly string[] | null>;
  /**
   * Present exactly when the plugin declares `keepAlive` (decision 054). One round trip to the
   * server; rejects with `connectionLost` when the connection is gone. The host calls it only while
   * nothing runs, and bounds how long it waits.
   */
  ping?(): Promise<void>;
  /**
   * Present exactly when the plugin declares `bulkInsert` (decision 046). Writes `rows` into
   * `target` by the dialect's fastest safe path, values never spliced into SQL. Atomic: when the
   * database refuses any row it rejects with `statementFailed`, none of `rows` is kept, and an open
   * transaction stays usable; a lost connection rejects with `connectionFailed`. Text is converted
   * where the column needs it, so what TableCraft's CSV export writes inserts back the same: `0x…`
   * hex into a binary column, `true`/`false` into a boolean stored as a number.
   */
  insertRows?(target: InsertTarget, rows: readonly InsertRow[]): Promise<void>;
  /** Present exactly when the plugin declares `sessions` (decision 088). */
  readonly sessions?: SessionMonitor;
  /**
   * Present exactly when the plugin declares `sessions`: the server's id for this connection, as
   * `ServerSession.id` lists it, so the host can tell its own sessions apart.
   */
  readonly serverSessionId?: string;
  /**
   * The `ServerSession.instance` this connection is listed under, where an id names a session on one
   * server of a cluster only (TiDB before Global Kill); absent elsewhere, or when the server would
   * not say, and the host then matches by id alone.
   */
  readonly serverInstance?: string;
  /** Present exactly when the plugin declares `keyValue` (decision 113). */
  readonly keyspace?: Keyspace;
  /**
   * Present exactly when the plugin declares `nodes` (decision 114): every server of the
   * datasource, primaries first; one entry for a single server.
   */
  nodes?(): Promise<readonly ServerNode[]>;
  /**
   * Present exactly when the plugin declares `serverInfo`: what `node` (a `ServerNode.id`, or null
   * for the one server or a primary of the plugin's choice) reports about itself.
   */
  serverInfo?(node: string | null): Promise<ServerInfo>;
  /** Present exactly when the plugin declares `serverInfo`: the newest `limit` slow commands, of every primary for a null `node`. */
  slowLog?(node: string | null, limit: number): Promise<readonly SlowCommand[]>;
  /**
   * Settles in bounded time even when the network is gone: a graceful goodbye that does not
   * answer within a few seconds gives way to dropping the socket (decision 040).
   */
  close(): Promise<void>;
  /** What the server reports about itself, such as `17.4`; null when it reports nothing. */
  readonly serverVersion: string | null;
  /** The manifest `brands` id of the product this session reached; absent when the plugin declares no brands or cannot tell. */
  readonly serverBrand?: string;
  /**
   * True when another session on the same configuration sees a different database, as with
   * SQLite's `:memory:`; the engine then never re-runs this session's statements elsewhere.
   */
  readonly privateDatabase?: boolean;
  /**
   * The TLS the connection settled on, read once after connect; null or absent when it is plain
   * (decision 072).
   */
  readonly tls?: TlsInfo | null;
  /**
   * Present exactly when the plugin declares `serverTimeout` (decision 129): what this server stops
   * by itself under `ExecuteOptions.serverTimeoutMs`, read once at connect; null when this server
   * version has no such setting.
   */
  readonly serverTimeout?: ServerTimeout | null;
}

/** What a TLS handshake agreed, as Node's socket names it: `TLSv1.3`, `TLS_AES_256_GCM_SHA384`. */
export interface TlsInfo {
  readonly protocol: string;
  readonly cipher: string;
}

export interface ConnectOptions {
  /**
   * Ask the database to refuse writes for the whole session (decision 011). A guard against
   * accidents, not a security boundary: a statement can switch it back off.
   */
  readonly readOnly: boolean;
  /**
   * Turn on TCP keepalive, first probe after this many idle milliseconds, so a peer that vanished
   * without a goodbye is noticed by the OS (decisions 040, 054). Absent: the driver's default. A
   * plugin declaring `keepAlive` honours it; one without a socket ignores it.
   */
  readonly keepAliveInitialDelayMs?: number;
  /**
   * The host name the server certificate must carry when the plugin dials another address, as
   * through an SSH tunnel to `127.0.0.1` (decision 073). Absent: the configured host itself.
   */
  readonly serverName?: string;
}

/** One statement of a script, in UTF-16 offsets into the text `split` received (decision 023). */
export interface StatementSpan {
  readonly from: number;
  readonly to: number;
  /** `text.slice(from, to)`: the statement without its delimiter. */
  readonly sql: string;
  /**
   * How many times the script asks for the statement to run: SQL Server's `GO 3` after it
   * (decision 100). Absent means once. The host never repeats a statement; it passes the count
   * as `ExecuteOptions.repeat` and the plugin runs it that many times.
   */
  readonly repeat?: number;
}

/**
 * A statement of a streamed script (decision 081): offsets count UTF-16 units from the start of
 * everything pushed, and `line` and `column` (both from 1) say where it starts.
 */
export interface StreamedStatement extends StatementSpan {
  readonly line: number;
  readonly column: number;
}

/**
 * `split` over text that arrives in pieces, so a script never has to be held whole (decision 081).
 * `push` returns the statements the text so far completes; `end` returns the rest.
 */
export interface StatementStream {
  push(text: string): readonly StreamedStatement[];
  end(): readonly StreamedStatement[];
}

export const STATEMENT_KINDS = ["read", "write", "ddl", "transaction", "other"] as const;

export type StatementKind = (typeof STATEMENT_KINDS)[number];

export interface StatementClass {
  readonly kind: StatementKind;
  /** Why the statement needs confirmation before it runs (decision 011), such as `DELETE without WHERE`; null when it does not. */
  readonly destructive: string | null;
  /**
   * The statement may move the session's current namespace, such as `USE db` or
   * `SET search_path` (plan 022); the host then asks `Session.currentNamespace` again.
   */
  readonly setsNamespace?: boolean;
  /**
   * Why the statement may be slow or heavy for the server, such as `KEYS walks every key`; the
   * editor marks it and never blocks the run (decision 112). Null or absent when it is not.
   */
  readonly costly?: string | null;
  /** With `destructive`: confirming it asks for the datasource's name, not just OK (decision 112). */
  readonly confirmByName?: boolean;
}

export const KEYWORD_CASES = ["upper", "lower", "preserve"] as const;

export type KeywordCase = (typeof KEYWORD_CASES)[number];

/** `aligned` is the DataGrip-like layout (decision 061); `standard` is `sql-formatter`'s own (decision 042). */
export const FORMAT_STYLES = ["aligned", "standard"] as const;

export type FormatStyle = (typeof FORMAT_STYLES)[number];

/** How `SqlLanguage.format` lays text out (decisions 042, 061). */
export interface FormatOptions {
  readonly style: FormatStyle;
  readonly keywordCase: KeywordCase;
  readonly indentWidth: number;
  /** Blank lines between two statements. */
  readonly linesBetweenStatements: number;
  /** In the aligned style, `AS` in a select list and `=` in a `SET` line up in a column. */
  readonly alignAliases: boolean;
}

export const PARAMETER_STYLES = ["named", "numbered", "positional"] as const;

/** `:name`, `$1`, or a bare `?` (decision 043). */
export type ParameterStyle = (typeof PARAMETER_STYLES)[number];

/** One placeholder in a statement, in UTF-16 offsets into the text `parameters` received. */
export interface SqlParameter {
  /** As written for `:name` and `$1`; the n-th bare `?` is `?n`. Occurrences sharing a name share a value. */
  readonly name: string;
  readonly from: number;
  readonly to: number;
  readonly style: ParameterStyle;
}

/** A statement rewritten to the dialect's native placeholders, and the values for them in order. */
export interface BoundStatement {
  readonly sql: string;
  readonly params: readonly ParameterValue[];
}

/**
 * What a console `SELECT` reads, for editing its result in place (plan 026, decision 056): the
 * one base table, and per select-list column the table column it is (`*` expanded from the
 * catalog), or null for anything else. `readOnly` says, for the toolbar, why the statement is not
 * that simple.
 */
export type SelectSource =
  | {
      readonly kind: "table";
      readonly path: readonly string[];
      readonly relation: string;
      readonly columns: readonly (string | null)[];
    }
  | { readonly kind: "readOnly"; readonly reason: string };

/** The statements that set, roll back to and release a savepoint called `name` (plan 026). */
export interface SavepointStatements {
  readonly set: string;
  readonly rollback: string;
  readonly release: string;
}

/** What the console asks the plugin about its dialect (decision 008); the host never parses SQL. */
export interface SqlLanguage {
  /** Every non-empty statement in `text`, in order. Comments and blanks between statements belong to none. */
  split(text: string): readonly StatementSpan[];
  /**
   * A fresh stream that splits exactly as `split` would, for scripts too large to hold (decision
   * 081). Absent: the host splits the whole file with `split`, up to a size it can hold.
   */
  splitStream?(): StatementStream;
  classify(sql: string): StatementClass;
  /** `name` quoted as an identifier, whatever characters it holds. */
  quoteIdentifier(name: string): string;
  /**
   * `value` as a literal a statement can insert into a column of `columnType`. A bytes value
   * carries only its preview, so a longer one is written clipped with a comment saying so.
   */
  literal(value: WireValue, columnType: string | null): string;
  /** An `INSERT` into `qualifiedTable` where every column takes its default (decision 026). */
  emptyInsert(qualifiedTable: string): string;
  /**
   * What `UPDATE … SET column = …` writes to give a column its default: `DEFAULT` where the dialect
   * accepts it, else the catalog's `defaultExpression` (`ColumnMeta.default`), or `NULL` without one.
   */
  updateDefault(defaultExpression: string | null): string;
  /**
   * What fits at the caret, read from `catalog` (decision 028). Never rejects for SQL it cannot
   * read: it offers less. `sqlCompleter` in `@table-craft/plugin-api/sql` implements it.
   */
  complete(request: CompletionRequest, catalog: CompletionCatalog): Promise<CompletionResult>;
  /** Where the name at the caret was declared; null when it names nothing the scope or catalog knows. */
  resolve(request: ResolveRequest, catalog: CompletionCatalog): Promise<Declaration | null>;
  /**
   * The built-in function call the caret is inside and the argument it is at, for the parameter
   * hint (decision 098); null outside a call or in one the dialect does not document.
   */
  signatureAt?(request: CompletionRequest, catalog: CompletionCatalog): Promise<SignatureHelp | null>;
  /**
   * Every problem in `request.text` found without running it, each with its quick fixes (plan 108).
   * Never rejects for SQL it cannot read: it reports less. A name the catalog cannot answer for (an
   * empty or undescribed namespace) is not reported unresolved. `sqlInspector` implements it.
   */
  inspect?(request: InspectionRequest, catalog: CompletionCatalog): Promise<readonly Problem[]>;
  /**
   * A `statement` over `relation` for the SQL Generator (decision 029): one clause per line, columns
   * in table order, names quoted only where needed; `qualifiedName` is what the introspector names
   * the relation. A generated UPDATE matches no row until its `NULL`s are edited. `sqlGenerator` in
   * `@table-craft/plugin-api/sql` implements it.
   */
  generate(statement: GeneratedStatement, relation: Relation, qualifiedName: string): string;
  /**
   * Present exactly when the plugin declares `explain` (decision 031): whether `sql`, one statement
   * without its delimiter, can be explained (with `analyze`, analysed) in this dialect, and whether it
   * writes. Pure; `sqlExplainable` in `@table-craft/plugin-api/sql` implements it.
   */
  explainable?(sql: string, options: ExplainOptions): Explainability;
  /**
   * `text` laid out by `options` (decision 042), comments and literals untouched. Throws an `Error`
   * whose message says why when the text cannot be read; the host then leaves the text as it was.
   * `sqlFormatter` in `@table-craft/plugin-api/sql` implements it.
   */
  format(text: string, options: FormatOptions): string;
  /**
   * Every placeholder in `statement`, one statement without its delimiter, in order (decision 043).
   * Nothing inside a literal, quoted identifier or comment is one. `sqlParameters` implements it.
   */
  parameters(statement: string): readonly SqlParameter[];
  /**
   * `statement` with each placeholder `parameters` finds rewritten to the driver's native form, and
   * the values in the order `Session.execute` binds them. Throws a `PluginError` coded
   * `statementFailed` naming a placeholder `values` has no entry for.
   */
  bind(statement: string, values: Readonly<Record<string, ParameterValue>>): BoundStatement;
  /**
   * Present exactly when the plugin declares `bulkInsert`: the column type an import proposes for
   * text that looks like `column` (decision 046). Every value of the sample inserts into it.
   */
  importType?(column: InferredColumn): string;
  /** Present exactly when the plugin declares `bulkInsert`: the `CREATE TABLE` for a new import target. */
  createTable?(qualifiedName: string, columns: readonly NewColumn[]): string;
  /** Present exactly when the plugin declares `objects`: the DDL for creating, altering, renaming and dropping (decision 052). */
  readonly objects?: ObjectEditor;
  /**
   * The base table `sql`, one statement without its delimiter, reads, when it is a single-table
   * `SELECT` with no join, grouping, aggregate, window, set operation, `DISTINCT` or `WITH`
   * (plan 026). Never rejects: what it cannot read is `readOnly`. Absent: console results stay
   * read-only. `sqlCompleter` in `@table-craft/plugin-api/sql` implements it.
   */
  selectSource?(sql: string, catalog: CompletionCatalog): Promise<SelectSource>;
  /**
   * Present with `selectSource`: the savepoint statements that let edits joining an open
   * transaction undo only themselves when one is refused. `sqlSavepoints` implements it.
   */
  savepoint?(name: string): SavepointStatements;
  /** Present exactly when the plugin declares `currentNamespace`: how the console switches namespace (decision 060). */
  readonly namespaceSwitch?: NamespaceSwitch;
  /**
   * Present exactly when the plugin declares `routineCall` (decision 090): the console text that
   * calls `routine`, named `qualifiedName` by the introspector, and returns its result, OUT values
   * included. `args` has one entry per parameter in order; an `out` entry is ignored. Throws a
   * `PluginError` coded `statementFailed` saying what to change when the arguments do not fit.
   */
  routineCall?(routine: Routine, qualifiedName: string, args: readonly RoutineArgument[]): RoutineCall;
}

/** How a session moves to another namespace from the console's switcher (decision 060). */
export interface NamespaceSwitch {
  /**
   * Which catalog namespaces a switch can name: `topLevel` the ones with a one-part path (MySQL's
   * databases), `schema` those of kind `schema` (PostgreSQL's schemas).
   */
  readonly targets: "topLevel" | "schema";
  /** Whether a rollback undoes the switch inside an open transaction. */
  readonly transactional: boolean;
  /**
   * The one statement that makes `path` the session's current namespace, the name always quoted.
   * Throws a `PluginError` coded `statementFailed` for a path it cannot name.
   */
  statement(path: readonly string[]): string;
}

/**
 * Whether a switch over `targets` can name `namespace`. Not by `Namespace.kind` alone: MySQL lists
 * its databases as top-level schemas, so a `USE` picks a top-level namespace whatever its kind.
 */
export function switchableTo(targets: NamespaceSwitch["targets"], namespace: Namespace): boolean {
  return targets === "topLevel" ? namespace.path.length === 1 : namespace.kind === "schema";
}

export const TRANSACTION_MODES = ["auto", "manual"] as const;

export type TransactionMode = (typeof TRANSACTION_MODES)[number];

/**
 * Transaction control for one session (decision 011). In `manual` the plugin opens a transaction
 * before the first statement; in `auto` it tracks the ones a statement opens or ends explicitly.
 */
export interface Transactions {
  /** Rejects with `statementFailed` when leaving `manual` while a transaction is open: commit or roll back first. */
  setMode(mode: TransactionMode): Promise<void>;
  /** A no-op when no transaction is open. */
  commit(): Promise<void>;
  /** A no-op when no transaction is open. */
  rollback(): Promise<void>;
  readonly mode: TransactionMode;
  /** Whether a transaction is open after the last statement, commit or rollback. */
  readonly open: boolean;
}

/**
 * The console language of a datasource that speaks commands, not SQL (decision 112): one command
 * per line, as the server's own client reads them.
 */
export interface CommandLanguage {
  /** Every command in `text`, in order; comments and blank lines belong to none. */
  split(text: string): readonly StatementSpan[];
  classify(command: string): StatementClass;
  /**
   * What fits at the caret. `session` is a connection the host keeps for such questions, null
   * when it cannot open one; the plugin then completes from what it knows offline. Never rejects
   * for text it cannot read.
   */
  complete(request: CompletionRequest, session: Session | null): Promise<CompletionResult>;
  /** The command the caret is in and the argument it is at, for the parameter hint (decision 098). */
  signatureAt?(request: CompletionRequest, session: Session | null): Promise<SignatureHelp | null>;
  /** Problems in `request.text` found without running it, such as a costly command, with quick fixes. */
  inspect?(request: InspectionRequest): Promise<readonly Problem[]>;
}

/** The default export of a plugin's entry module (decision 005). */
export interface DatasourcePlugin {
  readonly id: string;
  readonly capabilities: readonly Capability[];
  /** Present exactly when the plugin declares `sql`. */
  readonly language?: SqlLanguage;
  /** Present exactly when the plugin declares `commands` (decision 112). */
  readonly commandLanguage?: CommandLanguage;
  /** Validates the configuration `connect` receives; the host parses before it calls. */
  readonly connectionSchema: z.ZodType;
  /** Rejects with a `PluginError` coded `connectionFailed` when the database cannot be reached. */
  connect(config: unknown, options: ConnectOptions): Promise<Session>;
}
