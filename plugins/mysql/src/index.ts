import { connect, type Socket } from "node:net";
import type { Readable } from "node:stream";
import mysql from "mysql2";
import {
  PluginError,
  toWireInteger,
  toWireValue,
  z,
  type Capability,
  type Column,
  type ColumnOrigin,
  type ConnectOptions,
  type DatasourcePlugin,
  type ExecuteOptions,
  type ExecuteResult,
  type ExplainedPlan,
  type ExplainOptions,
  type InsertRow,
  type InsertTarget,
  type Introspector,
  type ParameterValue,
  type Row,
  type PluginErrorCode,
  type ServerMessage,
  type ServerTimeout,
  type CancelReach,
  type Session,
  type SessionMonitor,
  type SqlLanguage,
  type StatementKind,
  type TlsInfo,
  type TransactionMode,
  type Transactions,
  type WireValue,
} from "@table-craft/plugin-api";
import {
  classifyTokens,
  defaultKeyword,
  explainedVerb,
  planText,
  namespaceSwitcher,
  quoteIdentifierWith,
  sqlSavepoints,
  SQL_KEYWORDS,
  sqlCompleter,
  sqlInspector,
  sqlExplainable,
  sqlFormatter,
  sqlGenerator,
  identifierWriter,
  sqlImporter,
  sqlLiteral,
  sqlParameters,
  sqlSplitter,
  sqlStatementStream,
  transactionEffect,
  type ParameterOptions,
  type SqlDialectOptions,
  type SqlLiteralOptions,
  type CompleterOptions,
} from "@table-craft/plugin-api/sql";
import { MYSQL_RESERVED_WORDS } from "./reserved.js";
import { insertStatement, MYSQL_IMPORT_TYPES, mysqlDecimal } from "./bulk.js";
import { syntaxErrorPosition } from "./errorPosition.js";
import { MYSQL_FUNCTIONS } from "./functions/index.js";
import {
  ANALYZE_VERBS,
  EXPLAIN_VERBS,
  explainStatement,
  planFormat,
  readJson,
  type PlanFormat,
  readTidbTable,
  readTree,
  tableText,
} from "./explain.js";
import { mysqlIntrospector } from "./introspect.js";
import { mysqlObjects } from "./objects.js";
import { mysqlRoutineCall } from "./routines.js";
import {
  explainDialect,
  cancelReachOf,
  killStatementFor,
  namesServerTimeout,
  ownTimeoutMs,
  readServerTimeoutSql,
  serverDialect,
  serverIdentity,
  serverTimeoutOf,
  serverTimeoutSql,
  stoppedAtLimit,
  stoppedAtLimitMessage,
  tidbGlobalKill,
  type ServerDialect,
} from "./server.js";
import { mysqlSessions, tidbInstanceOf } from "./sessions.js";
import { connectFailure, SSL_MODES, tlsInfoOf, tlsOptions } from "./tls.js";
import { SHOW_WARNINGS_SQL, warningCount, warningMessages } from "./warnings.js";

const PLUGIN_ID = "mysql";
const CAPABILITIES: readonly Capability[] = [
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
  "serverTimeout",
];

/** What the mysql client accepts: `'\''`, `# comments`, `DELIMITER //` and `BEGIN … END` routine bodies. */
const DIALECT: SqlDialectOptions = {
  backslashEscapes: true,
  delimiterCommand: true,
  hashComments: true,
  blockKeywords: ["BEGIN"],
  namespaceStatements: ["use"],
};

const PARAMETERS: ParameterOptions = { dialect: DIALECT, styles: ["named", "positional"], native: "positional" };

const LITERALS: SqlLiteralOptions = { backslashEscapes: true, bytes: (hex) => `X'${hex}'` };

const quoteIdentifier = quoteIdentifierWith("`");

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const KEYWORDS: readonly string[] = [...SQL_KEYWORDS, "STRAIGHT_JOIN", "REPLACE"];
const writeName = identifierWriter({ quoteIdentifier, plainIdentifier: PLAIN_IDENTIFIER, keywords: KEYWORDS });

const { explainable } = sqlExplainable({
  dialect: DIALECT,
  name: "MySQL",
  verbs: EXPLAIN_VERBS,
  analyzeVerbs: ANALYZE_VERBS,
});

const COMPLETER: CompleterOptions = {
  dialect: DIALECT,
  identifierFolding: "none",
  plainIdentifier: PLAIN_IDENTIFIER,
  quoteIdentifier,
  keywords: KEYWORDS,
  functions: MYSQL_FUNCTIONS,
  server: serverIdentity,
};

const language: SqlLanguage = {
  split: sqlSplitter(DIALECT),
  splitStream: sqlStatementStream(DIALECT),
  classify: (sql) => classifyTokens(sql, DIALECT),
  quoteIdentifier,
  literal: (value) => sqlLiteral(value, LITERALS),
  emptyInsert: (table) => `INSERT INTO ${table} () VALUES ()`,
  updateDefault: defaultKeyword,
  savepoint: sqlSavepoints(quoteIdentifier),
  ...sqlCompleter(COMPLETER),
  ...sqlInspector({ ...COMPLETER, reservedWords: MYSQL_RESERVED_WORDS }),
  ...sqlGenerator({
    quoteIdentifier,
    updateDefault: defaultKeyword,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: KEYWORDS,
  }),
  explainable,
  ...sqlFormatter({ dialect: "mysql", lexer: DIALECT, parameters: PARAMETERS.styles }),
  ...sqlParameters(PARAMETERS),
  ...sqlImporter({
    quoteIdentifier,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: KEYWORDS,
    types: MYSQL_IMPORT_TYPES,
    decimal: mysqlDecimal,
  }),
  namespaceSwitch: namespaceSwitcher("use", quoteIdentifier),
  objects: mysqlObjects({
    name: writeName,
    text: (value) => sqlLiteral(value, LITERALS),
  }),
  routineCall: mysqlRoutineCall(writeName),
};

/** Manual mode is autocommit off: the server opens a transaction with the next statement. */
const MANUAL_SQL = "SET autocommit = 0";
const AUTO_SQL = "SET autocommit = 1";
const COMMIT_SQL = "COMMIT";
const ROLLBACK_SQL = "ROLLBACK";
/** Each batch of an import is atomic inside the import's transaction (decision 046). */
const SAVEPOINT_SQL = "SAVEPOINT table_craft_insert";
const RELEASE_SQL = "RELEASE SAVEPOINT table_craft_insert";
const ROLLBACK_TO_SQL = "ROLLBACK TO SAVEPOINT table_craft_insert";
const OPEN_TRANSACTION_MESSAGE = "A transaction is open; commit or roll it back before switching to auto-commit.";
const BUSY_MESSAGE = "Another statement is still running in this session.";
const READ_ONLY_REFUSED_MESSAGE =
  "This session is read-only, so the statement was not sent. Turn off Read-only on the data source to change data or schema.";
const WRITING_KINDS: ReadonlySet<StatementKind> = new Set(["write", "ddl"]);

const DEFAULT_PORT = 3306;
const MAX_PORT = 65_535;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const MAX_CONNECT_TIMEOUT_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const CLOSED_MESSAGE = "the server closed the connection";
/** How long `close` waits for the server to acknowledge COM_QUIT before dropping the socket. */
const CLOSE_GRACE_MS = 3000;
/** Rows buffered ahead of the reader before the connection is paused. */
const FETCH_ROWS = 500;
/**
 * How long closing an abandoned result may take, killed or read to the end, before the connection
 * is dropped. Longer than the engine's own grace, so the engine reports a slow close first.
 */
const ABANDON_BUDGET_MS = 10_000;
const ABANDON_EXPIRED_MESSAGE = "an abandoned result could not be closed in time, so the connection was dropped";
const RESET_MESSAGE = "the session was reset to stop a statement";
const CANCELLED_MESSAGE = "The statement was cancelled.";
const RESET_CANCELLED_MESSAGE =
  "The statement was cancelled by resetting the session, as this server cannot stop it on its own; session state and any open transaction are gone.";
/** `ER_QUERY_INTERRUPTED`, raised by `KILL QUERY` in a statement that checks for it. */
const QUERY_INTERRUPTED = 1317;
/** The `binary` collation id; a string type carrying it holds bytes, not text. */
const BINARY_CHARSET = 63;
/** A `TINYINT(1)` is how MySQL spells `BOOLEAN`. */
const BOOLEAN_DISPLAY_WIDTH = 1;

const connectionSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  database: z.string().min(1).optional(),
  user: z.string().min(1),
  password: z.string().default(""),
  /**
   * `require` encrypts without checking the certificate; `verify-ca` checks it is signed by the CA;
   * `verify-full` checks that and the host name.
   */
  sslMode: z.enum(SSL_MODES).default("disable"),
  /** Paths, read at connect (decision 072); empty: none. */
  sslRootCert: z.string().default(""),
  sslCert: z.string().default(""),
  sslKey: z.string().default(""),
  sslKeyPassphrase: z.string().default(""),
  connectTimeout: z.number().int().min(1).max(MAX_CONNECT_TIMEOUT_SECONDS).default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
});

type MysqlConfig = z.output<typeof connectionSchema>;

/** Column type numbers from `include/field_types.h` in the MySQL source. */
const TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  [0, "decimal"],
  [1, "tinyint"],
  [2, "smallint"],
  [3, "int"],
  [4, "float"],
  [5, "double"],
  [6, "null"],
  [7, "timestamp"],
  [8, "bigint"],
  [9, "mediumint"],
  [10, "date"],
  [11, "time"],
  [12, "datetime"],
  [13, "year"],
  [14, "date"],
  [15, "varchar"],
  [16, "bit"],
  [242, "vector"],
  [245, "json"],
  [246, "decimal"],
  [247, "enum"],
  [248, "set"],
  [249, "tinytext"],
  [250, "mediumtext"],
  [251, "longtext"],
  [252, "text"],
  [253, "varchar"],
  [254, "char"],
  [255, "geometry"],
]);

/** The text spelling of a type whose binary-collation twin has another name. */
const BINARY_TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  ["varchar", "varbinary"],
  ["char", "binary"],
  ["tinytext", "tinyblob"],
  ["mediumtext", "mediumblob"],
  ["longtext", "longblob"],
  ["text", "blob"],
]);

/**
 * MariaDB sends JSON as LONGTEXT and names the format only in its extended metadata; mysql2 would
 * parse such a cell, losing the server's spelling and any integer past 2^53.
 */
const MARIADB_JSON_FORMAT = "json";

function typeName(field: mysql.FieldPacket): string | null {
  if (field.extendedFormat === MARIADB_JSON_FORMAT) return "json";
  const name = field.columnType === undefined ? undefined : TYPE_NAMES.get(field.columnType);
  if (name === undefined) return null;
  return field.characterSet === BINARY_CHARSET ? (BINARY_TYPE_NAMES.get(name) ?? name) : name;
}

/**
 * `dateStrings` and `bigNumberStrings` keep temporal and exact values as the server's text, so
 * the cast below only decides what JavaScript can represent exactly (decision 017).
 */
const FULL_BYTES: ExecuteOptions = { fullBytes: true };

function cast(field: mysql.TypeCastField, next: mysql.TypeCastNext): WireValue {
  return castCell(field, next, {});
}

function fullBytesCast(field: mysql.TypeCastField, next: mysql.TypeCastNext): WireValue {
  return castCell(field, next, FULL_BYTES);
}

function castCell(field: mysql.TypeCastField, next: mysql.TypeCastNext, options: ExecuteOptions): WireValue {
  if (field.extendedFormat === MARIADB_JSON_FORMAT) {
    const text = field.string("utf8");
    return text === null ? null : { kind: "json", text };
  }
  switch (field.type) {
    case "JSON": {
      const text = field.string("utf8");
      return text === null ? null : { kind: "json", text };
    }
    case "LONGLONG": {
      const value = next();
      return value === null ? null : toWireInteger(value as string);
    }
    case "TINY": {
      const value = next();
      if (value === null || field.length !== BOOLEAN_DISPLAY_WIDTH) return toWireValue(value);
      return value !== 0;
    }
    default:
      return toWireValue(next(), options);
  }
}

const CONNECTION_OPTIONS = {
  charset: "utf8mb4",
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
} as const satisfies mysql.ConnectionOptions;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface OpenOptions {
  readonly keepAliveInitialDelayMs?: number | undefined;
  readonly serverName?: string | undefined;
}

/**
 * mysql2 checks the certificate against the `host` it dials (`lib/base/connection.js`, `startTLS`),
 * so to check another name it is given that name as `host` and a socket already aimed elsewhere.
 * The socket gets what mysql2 gives its own (`lib/base/connection.js`, constructor).
 */
function redirectedStream(config: MysqlConfig, options: OpenOptions): { host: string; stream?: Socket } {
  const { serverName } = options;
  if (serverName === undefined || serverName === config.host) return { host: config.host };
  const stream = connect(config.port, config.host);
  stream.setNoDelay(true);
  const delay = options.keepAliveInitialDelayMs;
  if (delay !== undefined) stream.on("connect", () => stream.setKeepAlive(true, delay));
  return { host: serverName, stream };
}

async function openConnection(config: MysqlConfig, options: OpenOptions): Promise<mysql.Connection> {
  const { keepAliveInitialDelayMs } = options;
  const ssl = await tlsOptions(config);
  const connection = mysql.createConnection({
    ...CONNECTION_OPTIONS,
    ...(keepAliveInitialDelayMs === undefined
      ? {}
      : { enableKeepAlive: true, keepAliveInitialDelay: keepAliveInitialDelayMs }),
    connectTimeout: config.connectTimeout * MS_PER_SECOND,
    ...(ssl === undefined ? { host: config.host } : redirectedStream(config, options)),
    port: config.port,
    user: config.user,
    password: config.password,
    ...(config.database === undefined ? {} : { database: config.database }),
    ssl,
  });
  return new Promise((resolve, reject) => {
    connection.connect((error) => {
      if (error === null) {
        resolve(connection);
        return;
      }
      reject(connectFailure(config, options.serverName, error));
    });
  });
}

/** mysql2 keeps the socket, after any TLS upgrade, on the connection; its typings omit it. */
interface WithStream {
  readonly stream: unknown;
}

const READ_ONLY_SQL = "SET SESSION TRANSACTION READ ONLY";
const IDENTITY_SQL = "SELECT VERSION() AS version, CONNECTION_ID() AS id";
const CURRENT_DATABASE_SQL = "SELECT DATABASE() AS name";

function query(
  connection: mysql.Connection,
  sql: string,
  code: PluginErrorCode = "connectionFailed",
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    connection.query(sql, (error, rows) => {
      if (error === null) resolve(rows);
      else reject(new PluginError(code, messageOf(error), { cause: error }));
    });
  });
}

interface Identity {
  readonly serverVersion: string | null;
  readonly dialect: ServerDialect;
  /** What stops this connection's running statement from another connection; `null` when nothing safely does. */
  readonly kill: string | null;
  readonly serverSessionId: string;
  /** The session refuses writes itself, because the server would not. */
  readonly refusesWrites: boolean;
}

/**
 * Configures a fresh connection and reads what the server reports about itself. The id comes from
 * `CONNECTION_ID()`, not the handshake: a proxy in front of the server may hand out its own.
 *
 * TiDB has no read-only session: 4.x accepts `SET SESSION TRANSACTION READ ONLY` and ignores it,
 * and 5.x and later refuse it unless `tidb_enable_noop_functions` is on, which failed every
 * read-only connection. On TiDB the session refuses writes and DDL before sending them instead.
 */
async function prepareConnection(connection: mysql.Connection, options: ConnectOptions): Promise<Identity> {
  const rows = (await query(connection, IDENTITY_SQL)) as readonly { version?: unknown; id?: unknown }[];
  const version = rows[0]?.version;
  const serverVersion = typeof version === "string" && version !== "" ? version : null;
  const dialect = serverDialect(serverVersion);
  const readOnly = options.readOnly === true;
  const refusesWrites = readOnly && dialect.kind === "tidb";
  if (readOnly && !refusesWrites) await query(connection, READ_ONLY_SQL);
  const reported = rows[0]?.id;
  // bigNumberStrings hands a TiDB Global Kill id over as text.
  const serverSessionId =
    typeof reported === "string" || typeof reported === "number" ? String(reported) : String(connection.threadId);
  const id = Number(serverSessionId);
  return {
    serverVersion,
    dialect,
    kill: Number.isSafeInteger(id) ? killStatementFor(serverVersion, id) : null,
    serverSessionId,
    refusesWrites,
  };
}

/** Whether `work` settled within `ms`. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const settled = work.then(
    () => true,
    () => true,
  );
  const outcome = await Promise.race([settled, expired]);
  clearTimeout(timer);
  return outcome;
}

function closeConnection(connection: mysql.Connection): Promise<void> {
  return new Promise((resolve) => {
    connection.end(() => resolve());
  });
}

/** `closeConnection`, but a server that does not answer within `CLOSE_GRACE_MS` loses the socket. */
async function closeWithin(connection: mysql.Connection): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
  });
  const ended = await Promise.race([closeConnection(connection).then(() => true), expired]);
  clearTimeout(timer);
  if (!ended) connection.destroy();
}

/** Note 1003: EXPLAIN echoes the statement as the optimizer rewrote it, every time; it is not news. */
const REWRITTEN_QUERY_NOTE = "1003";

function readPlan(
  format: PlanFormat,
  columns: readonly Column[],
  rows: readonly Row[],
  statement: string,
  analyzed: boolean,
): ExplainedPlan {
  if (format === "json") return readJson(planText(rows), statement, analyzed);
  if (format === "tree") return readTree(planText(rows), statement, analyzed);
  const cells = rows.map((row) => row.map((cell) => planText([[cell]])));
  return readTidbTable(
    tableText(
      columns.map((column) => column.name),
      cells,
    ),
    statement,
    analyzed,
  );
}

const NO_ROWS: AsyncIterable<Row> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

interface Running {
  cancelRequested: boolean;
  /** Set when cancel had to drop the connection, so the statement's error says so. */
  reset: boolean;
  inFlight: InFlight | null;
  /** When the statement was sent, which the server's limit counts from. */
  startedAt: number;
  /** The server's own statement limit while it runs, in ms; null when it has none. */
  limitMs: number | null;
}

function startRunning(): Running {
  return { cancelRequested: false, reset: false, inFlight: null, startedAt: Date.now(), limitMs: null };
}

interface TransactionState {
  mode: TransactionMode;
  open: boolean;
}

/** One statement in flight; its rows arrive through a paused-when-full object stream. */
interface InFlight {
  readonly rows: AsyncIterator<unknown>;
  readonly stream: Readable;
  /** Settles when the driver is done with the statement, whatever its outcome. */
  readonly ended: Promise<void>;
  readonly fields: Promise<mysql.FieldPacket[] | undefined>;
  /** The warning count of the last EOF packet: mysql2 reads it off the wire but never reports it for rows. */
  readonly warnings: { count: number };
}

interface ProtocolPacket {
  isError(): boolean;
  isEOF(): boolean;
  eofWarningCount(): number;
}

/** mysql2 hands each packet to the command's `execute`; watching there is the one place the row EOF is seen. */
function watchWarnings(command: object, warnings: { count: number }): void {
  const target = command as { execute: (packet: ProtocolPacket | null | undefined, connection: unknown) => boolean };
  const execute = target.execute.bind(target);
  target.execute = (packet, connection) => {
    // A prepared statement's first step runs with no packet.
    if (packet != null && !packet.isError() && packet.isEOF()) warnings.count = warningCount(packet.eofWarningCount());
    return execute(packet, connection);
  };
}

/**
 * Without values, the text protocol. With them, a server-side prepared statement, so the server
 * binds them (decision 043); it is closed once the statement ends, as mysql2 would otherwise
 * cache one per distinct text for the life of the connection.
 */
function start(
  connection: mysql.Connection,
  sql: string,
  params: readonly ParameterValue[],
  executeOptions: ExecuteOptions,
): InFlight {
  const prepared = params.length > 0;
  const typeCast = executeOptions.fullBytes === true ? fullBytesCast : cast;
  const options = { sql, rowsAsArray: true, typeCast };
  const query = prepared ? connection.execute({ ...options, values: [...params] }) : connection.query(options);
  const warnings = { count: 0 };
  watchWarnings(query, warnings);
  // The stream reports the error; this listener stops the query's own emit from throwing.
  query.on("error", () => undefined);
  const stream = query.stream({ highWaterMark: FETCH_ROWS });
  // mysql2 reports a lost connection (a reset, a killed server) to the connection alone when the
  // query has no callback, so the stream would wait for rows forever.
  const ended = new Promise<void>((resolve) => {
    const lost = (error: Error) => {
      stream.destroy(error);
      resolve();
    };
    connection.once("error", lost);
    query.once("end", () => {
      connection.off("error", lost);
      if (prepared) connection.unprepare(sql);
      resolve();
    });
  });
  const fields = new Promise<mysql.FieldPacket[] | undefined>((resolve, reject) => {
    stream.once("fields", resolve);
    stream.once("error", reject);
  });
  // `fields` may never be awaited when the first row read reports the same error.
  fields.catch(() => undefined);
  return { rows: stream[Symbol.asyncIterator](), stream, ended, fields, warnings };
}

/** mysql2 marks an error that ended the connection, as opposed to one the server answered with. */
function isFatal(cause: unknown): boolean {
  return (cause as { fatal?: unknown }).fatal === true;
}

class MysqlSession implements Session {
  readonly #config: MysqlConfig;
  readonly #serverName: string | undefined;
  readonly #connection: mysql.Connection;
  readonly #kill: string | null;
  readonly #refusesWrites: boolean;
  /** Set by the connection's `error` event; a broken connection is reported, not thrown at random. */
  #broken: Error | null = null;
  #running: Running | null = null;
  #cancelling: Promise<void> = Promise.resolve();
  readonly #transaction: TransactionState = { mode: "auto", open: false };
  readonly #dialect: ServerDialect;
  /** The session's own statement limit in ms, 0 for none; read before the first limited statement. */
  #ownTimeoutMs: number | null = null;
  /** The limit this plugin last set; null before it set one, or once a statement may have changed it. */
  #appliedTimeoutMs: number | null = null;

  readonly serverVersion: string | null;
  readonly serverBrand: string;
  readonly serverTimeout: ServerTimeout | null;
  readonly cancelReach: CancelReach;
  readonly tls: TlsInfo | null;
  readonly introspector: Introspector;
  readonly transactions: Transactions;
  readonly sessions: SessionMonitor;
  readonly serverSessionId: string;
  readonly findServerInstance?: () => Promise<string | null>;

  constructor(config: MysqlConfig, serverName: string | undefined, connection: mysql.Connection, identity: Identity) {
    this.#config = config;
    this.#serverName = serverName;
    this.#connection = connection;
    this.#kill = identity.kill;
    this.#refusesWrites = identity.refusesWrites;
    this.serverVersion = identity.serverVersion;
    this.serverBrand = identity.dialect.kind;
    this.#dialect = identity.dialect;
    this.serverTimeout = serverTimeoutOf(this.#dialect);
    this.cancelReach = cancelReachOf(identity.serverVersion);
    this.tls = tlsInfoOf((connection as unknown as WithStream).stream);
    this.introspector = mysqlIntrospector(connection);
    this.sessions = mysqlSessions(connection, identity.serverVersion, () => openConnection(config, { serverName }));
    this.serverSessionId = identity.serverSessionId;
    // Asked for on demand: CLUSTER_PROCESSLIST asks every TiDB server, and one that never answers held each connect for 40 s.
    if (tidbGlobalKill(identity.serverVersion) === false) this.findServerInstance = () => tidbInstanceOf(connection);
    const state = this.#transaction;
    this.transactions = {
      setMode: (mode) => this.#setMode(mode),
      commit: () => this.#endTransaction(COMMIT_SQL),
      rollback: () => this.#endTransaction(ROLLBACK_SQL),
      get mode() {
        return state.mode;
      },
      get open() {
        return state.open;
      },
    };
    connection.on("error", (error: Error) => {
      this.#broken = error;
    });
    connection.on("end", () => {
      this.#broken ??= new Error(CLOSED_MESSAGE);
    });
  }

  async execute(
    sql: string,
    params: readonly ParameterValue[] = [],
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    if (this.#broken !== null) {
      throw new PluginError("connectionLost", `The connection was lost: ${this.#broken.message}`);
    }
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    if (this.#refusesWrites && WRITING_KINDS.has(language.classify(sql).kind)) {
      throw new PluginError("statementFailed", READ_ONLY_REFUSED_MESSAGE);
    }
    await this.#cancelling.catch(() => undefined);
    const running = startRunning();
    this.#running = running;
    try {
      running.limitMs = await this.#applyTimeout(options.serverTimeoutMs);
      if (namesServerTimeout(sql)) this.#appliedTimeoutMs = null;
      if (running.cancelRequested) throw this.#cancelled(running);
    } catch (cause) {
      this.#running = null;
      throw this.#failure(cause, running);
    }
    running.startedAt = Date.now();
    const inFlight = start(this.#connection, sql, params, options);
    running.inFlight = inFlight;
    try {
      const fields = await inFlight.fields.catch((cause: unknown) => {
        if (transactionEffect(sql, DIALECT) === "end") this.#transaction.open = false;
        throw cause;
      });
      this.#track(sql);
      // Like Postgres, resolve once the first row is in: a statement that sends its columns and then
      // computes (`SELECT SLEEP(30)`) is still running, and cancelling it must reject execute.
      const first = await inFlight.rows.next();
      if (running.cancelRequested) {
        await this.#finish(inFlight, first.done !== true);
        throw this.#cancelled(running);
      }
      if (fields === undefined) {
        const header = first.value as mysql.ResultSetHeader;
        await this.#finish(inFlight, false);
        const messages = await this.#warnings(warningCount(header.warningStatus));
        this.#running = null;
        return { columns: [], rows: NO_ROWS, rowsAffected: header.affectedRows, messages };
      }
      const columns: Column[] = fields.map((field) => ({
        name: field.name,
        type: typeName(field),
        origin: originOf(field),
      }));
      const messages: ServerMessage[] = [];
      return { columns, rows: this.#rows(inFlight, running, first, messages), rowsAffected: null, messages };
    } catch (cause) {
      this.#running = null;
      throw this.#failure(cause, running, sql);
    }
  }

  /**
   * Sets the server's session limit to `requested`, never above the session's own, or puts the own
   * back when nothing is requested; sends nothing when the value would not change (decision 129).
   * Returns the limit the statement runs under, null for none.
   */
  async #applyTimeout(requested: number | undefined): Promise<number | null> {
    if (this.serverTimeout === null) return null;
    if (requested === undefined && this.#appliedTimeoutMs === null) return null;
    if (this.#ownTimeoutMs === null) {
      const rows = (await query(
        this.#connection,
        readServerTimeoutSql(this.#dialect),
        "statementFailed",
      )) as readonly Record<string, unknown>[];
      this.#ownTimeoutMs = ownTimeoutMs(this.#dialect, Object.values(rows[0] ?? {})[0]);
    }
    const own = this.#ownTimeoutMs;
    const want = requested === undefined ? own : own === 0 ? requested : Math.min(own, requested);
    if (want !== this.#appliedTimeoutMs) {
      await query(this.#connection, serverTimeoutSql(this.#dialect, want), "statementFailed");
      this.#appliedTimeoutMs = want;
    }
    return want === 0 ? null : want;
  }

  async currentNamespace(): Promise<readonly string[] | null> {
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    const rows = (await query(this.#connection, CURRENT_DATABASE_SQL, "statementFailed")) as readonly {
      name?: unknown;
    }[];
    const name = rows[0]?.name;
    return typeof name === "string" ? [name] : null;
  }

  async ping(): Promise<void> {
    if (this.#broken !== null) {
      throw new PluginError("connectionLost", `The connection was lost: ${this.#broken.message}`);
    }
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    await new Promise<void>((resolve, reject) => {
      // mysql2 answers a successful ping with no argument at all, not null.
      this.#connection.ping((error: mysql.QueryError | null | undefined) => {
        if (error === null || error === undefined) resolve();
        else reject(new PluginError("connectionLost", `The connection was lost: ${error.message}`, { cause: error }));
      });
    });
  }

  async insertRows(target: InsertTarget, rows: readonly InsertRow[]): Promise<void> {
    if (this.#broken !== null) {
      throw new PluginError("connectionFailed", `The connection was lost: ${this.#broken.message}`);
    }
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    if (this.#refusesWrites) throw new PluginError("statementFailed", READ_ONLY_REFUSED_MESSAGE);
    if (rows.length === 0) return;
    await this.#cancelling.catch(() => undefined);
    const running = startRunning();
    this.#running = running;
    const state = this.#transaction;
    const { sql, values } = insertStatement(target.table, target.columns, quoteIdentifier, rows);
    try {
      // With autocommit off the savepoint itself opens the transaction.
      const savepoint = state.mode === "manual" || state.open;
      if (savepoint) {
        await this.#send(SAVEPOINT_SQL, []);
        state.open = true;
      }
      try {
        await this.#send(sql, values);
        if (savepoint) await this.#send(RELEASE_SQL, []);
      } catch (cause) {
        // A deadlock rolls back the whole transaction and the savepoint with it: nothing is left to keep.
        if (savepoint && !isFatal(cause)) {
          await this.#send(ROLLBACK_TO_SQL, []).catch((lost: unknown) => {
            this.#broken ??= lost instanceof Error ? lost : new Error(String(lost));
          });
        }
        throw cause;
      }
    } catch (cause) {
      if (running.reset) throw this.#cancelled(running);
      if (isFatal(cause)) this.#broken ??= cause instanceof Error ? cause : new Error(String(cause));
      const lost = this.#lost();
      if (lost !== null)
        throw new PluginError("connectionFailed", `The connection was lost: ${lost.message}`, { cause });
      throw this.#failure(cause, running);
    } finally {
      this.#running = null;
    }
  }

  /** Read through a method: the connection's `error` event sets it while a statement is awaited. */
  #lost(): Error | null {
    return this.#broken;
  }

  /** The text protocol with values escaped by the driver; a callback, so a lost link rejects instead of hanging. */
  #send(sql: string, values: readonly (string | Buffer | null)[]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#connection.query(sql, [...values], (error) => {
        if (error === null) resolve();
        else reject(error);
      });
    });
  }

  async explain(sql: string, options: ExplainOptions): Promise<ExplainedPlan> {
    const verdict = explainable(sql, options);
    if (!verdict.ok) throw new PluginError("explainUnsupported", verdict.reason);
    const dialect = explainDialect(this.serverVersion);
    const format = planFormat(explainedVerb(sql, DIALECT), dialect, options.analyze);
    const statement = explainStatement(sql, options.analyze, format, dialect);
    const rows: Row[] = [];
    const limit = options.serverTimeoutMs;
    const result = await this.execute(statement, [], limit === undefined ? {} : { serverTimeoutMs: limit });
    for await (const row of result.rows) rows.push(row);
    const plan = readPlan(format, result.columns, rows, statement, options.analyze);
    const messages = (result.messages ?? []).filter((message) => message.code !== REWRITTEN_QUERY_NOTE);
    return { ...plan, messages };
  }

  async *#rows(
    inFlight: InFlight,
    running: Running,
    first: IteratorResult<unknown>,
    messages: ServerMessage[],
  ): AsyncGenerator<Row, void, undefined> {
    let next = first;
    let exhausted = false;
    let completed = false;
    try {
      while (next.done !== true) {
        yield next.value as Row;
        try {
          next = await inFlight.rows.next();
        } catch (cause) {
          exhausted = true;
          throw this.#failure(cause, running);
        }
      }
      exhausted = true;
      if (running.cancelRequested) throw this.#cancelled(running);
      completed = true;
    } finally {
      await this.#finish(inFlight, !exhausted);
      if (completed) messages.push(...(await this.#warnings(inFlight.warnings.count)));
      this.#running = null;
    }
  }

  /**
   * Asked only when the statement reported warnings, while the session is still busy, so nothing
   * else can run in between and clear them. Failing to read them never fails the statement.
   */
  async #warnings(count: number): Promise<ServerMessage[]> {
    if (count === 0 || this.#broken !== null) return [];
    try {
      const rows = (await query(this.#connection, SHOW_WARNINGS_SQL, "statementFailed")) as readonly unknown[];
      return warningMessages(rows, count);
    } catch {
      return [];
    }
  }

  /**
   * MySQL commits implicitly before and after DDL, and with autocommit off any other statement
   * leaves a transaction open until COMMIT or ROLLBACK.
   */
  #track(sql: string): void {
    const state = this.#transaction;
    const effect = transactionEffect(sql, DIALECT);
    if (effect !== null) state.open = effect === "begin";
    else if (language.classify(sql).kind === "ddl") state.open = false;
    else if (state.mode === "manual") state.open = true;
  }

  async #setMode(mode: TransactionMode): Promise<void> {
    const state = this.#transaction;
    if (mode === state.mode) return;
    if (mode === "auto" && state.open) throw new PluginError("statementFailed", OPEN_TRANSACTION_MESSAGE);
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    await query(this.#connection, mode === "manual" ? MANUAL_SQL : AUTO_SQL, "statementFailed");
    state.mode = mode;
  }

  async #endTransaction(sql: string): Promise<void> {
    if (!this.#transaction.open) return;
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    try {
      await query(this.#connection, sql, "statementFailed");
    } finally {
      this.#transaction.open = false;
    }
  }

  /**
   * Leave the connection ready for the next statement. The text protocol has no way to stop a
   * result set but to read it to the end, which mysql2 does, discarding, once the stream is
   * destroyed; abandoned rows are killed server-side first where that is safe. Past
   * `ABANDON_BUDGET_MS` the connection is dropped, so the next statement reports it lost.
   */
  async #finish(inFlight: InFlight, abandoned: boolean): Promise<void> {
    if (this.#broken !== null) return;
    if (!abandoned) {
      await inFlight.ended;
      return;
    }
    const closing = (async () => {
      if (this.#kill !== null) await this.#killQuery(this.#kill).catch(() => undefined);
      inFlight.stream.destroy();
      await inFlight.ended;
    })();
    if (await settlesWithin(closing, ABANDON_BUDGET_MS)) return;
    this.#drop(new Error(ABANDON_EXPIRED_MESSAGE));
  }

  #drop(reason: Error): void {
    this.#broken ??= reason;
    this.#connection.destroy();
  }

  #cancelled(running: Running): PluginError {
    return new PluginError("cancelled", running.reset ? RESET_CANCELLED_MESSAGE : CANCELLED_MESSAGE);
  }

  #failure(cause: unknown, running: Running, sql?: string): PluginError {
    if (cause instanceof PluginError) return cause;
    const errno = (cause as { errno?: unknown }).errno;
    if (
      !running.cancelRequested &&
      typeof errno === "number" &&
      stoppedAtLimit(this.#dialect, errno, Date.now() - running.startedAt, running.limitMs)
    ) {
      return new PluginError("timedOut", stoppedAtLimitMessage(this.#dialect, running.limitMs), { cause });
    }
    if (running.cancelRequested || errno === QUERY_INTERRUPTED) {
      return new PluginError("cancelled", running.reset ? RESET_CANCELLED_MESSAGE : CANCELLED_MESSAGE, { cause });
    }
    const message = messageOf(cause);
    const position = sql === undefined ? undefined : syntaxErrorPosition(sql, message);
    return new PluginError("statementFailed", message, { cause, position });
  }

  cancel(): Promise<void> {
    const running = this.#running;
    if (running === null) return Promise.resolve();
    running.cancelRequested = true;
    if (this.#kill === null) {
      // Nothing stops the statement safely, so the session goes instead (decision 058).
      running.reset = true;
      const reason = new Error(RESET_MESSAGE);
      this.#drop(reason);
      running.inFlight?.stream.destroy(reason);
      return Promise.resolve();
    }
    this.#cancelling = this.#killQuery(this.#kill);
    return this.#cancelling;
  }

  /** On a second connection, because the session's own is busy with the statement it kills. */
  async #killQuery(statement: string): Promise<void> {
    const killer = await openConnection(this.#config, { serverName: this.#serverName });
    try {
      await new Promise<void>((resolve, reject) => {
        killer.query(statement, (error) => {
          if (error === null) resolve();
          else reject(error);
        });
      });
    } finally {
      await closeConnection(killer);
    }
  }

  async close(): Promise<void> {
    await this.#cancelling.catch(() => undefined);
    await closeWithin(this.#connection);
  }
}

const plugin: DatasourcePlugin = {
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  language,
  connectionSchema,
  connect: async (config, options) => {
    const parsed = connectionSchema.parse(config);
    const connection = await openConnection(parsed, options);
    try {
      return new MysqlSession(parsed, options.serverName, connection, await prepareConnection(connection, options));
    } catch (cause) {
      await closeConnection(connection);
      throw cause;
    }
  },
};

export default plugin;

/** The table column MySQL reports a result column comes from, or null for an expression (plan 026). */
function originOf(field: mysql.FieldPacket): ColumnOrigin | null {
  if (field.orgTable === "" || field.orgName === "") return null;
  return { table: `${field.db ?? field.schema ?? ""}.${field.orgTable}`, column: field.orgName };
}
