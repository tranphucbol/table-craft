import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";
import Cursor from "pg-cursor";
import {
  BYTES_PREVIEW_LENGTH,
  PluginError,
  toWireInteger,
  z,
  type CancelReach,
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
  type ServerMessage,
  type ServerTimeout,
  type Session,
  type SessionMonitor,
  type SqlLanguage,
  type TlsInfo,
  type TransactionMode,
  type Transactions,
  type WireValue,
} from "@table-craft/plugin-api";
import {
  classifyTokens,
  defaultKeyword,
  defaultValuesInsert,
  identifierWriter,
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
import { POSTGRES_RESERVED_WORDS } from "./reserved.js";
import { copyLine, POSTGRES_IMPORT_TYPES, postgresDecimal } from "./bulk.js";
import { serverErrorPosition } from "./errorPosition.js";
import { EXPLAIN_VERBS, explainStatement, readPlan } from "./explain.js";
import { POSTGRES_FUNCTIONS } from "./functions.js";
import { postgresIntrospector } from "./introspect.js";
import { NoticeCollector, type Notice } from "./notices.js";
import { postgresObjects } from "./objects.js";
import { postgresRoutineCall } from "./routines.js";
import { postgresSessions } from "./sessions.js";
import {
  FAILED_TRANSACTION,
  namesServerTimeout,
  POSTGRES_SERVER_TIMEOUT,
  postgresDurationMs,
  READ_TIMEOUT_SQL,
  SET_TIMEOUT_SQL,
} from "./timeout.js";
import { connectFailure, SSL_MODES, tlsInfoOf, tlsOptions } from "./tls.js";

const PLUGIN_ID = "postgres";
const CANCEL_REACH: CancelReach = { method: "pg_cancel_backend", reaches: "statement" };
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

/** Function bodies live in dollar quotes; `BEGIN ATOMIC … END` holds a SQL-standard body. */
const DIALECT: SqlDialectOptions = {
  dollarQuotes: true,
  nestedBlockComments: true,
  blockKeywords: ["BEGIN"],
  namespaceStatements: ["searchPath"],
};

const PARAMETERS: ParameterOptions = { dialect: DIALECT, styles: ["named", "numbered"], native: "numbered" };

const LITERALS: SqlLiteralOptions = { backslashEscapes: false, bytes: (hex) => `'\\x${hex}'::bytea` };

const quoteIdentifier = quoteIdentifierWith('"');

/** An upper-case letter would fold away unquoted, so only lower case reads back as written. */
const PLAIN_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;
const KEYWORDS: readonly string[] = [...SQL_KEYWORDS, "ILIKE", "LATERAL", "RETURNING"];
const writeName = identifierWriter({ quoteIdentifier, plainIdentifier: PLAIN_IDENTIFIER, keywords: KEYWORDS });

const { explainable } = sqlExplainable({
  dialect: DIALECT,
  name: "PostgreSQL",
  verbs: EXPLAIN_VERBS,
  analyzeVerbs: EXPLAIN_VERBS,
});

const COMPLETER: CompleterOptions = {
  dialect: DIALECT,
  identifierFolding: "lower",
  plainIdentifier: PLAIN_IDENTIFIER,
  quoteIdentifier,
  keywords: KEYWORDS,
  functions: POSTGRES_FUNCTIONS,
};

const language: SqlLanguage = {
  split: sqlSplitter(DIALECT),
  splitStream: sqlStatementStream(DIALECT),
  classify: (sql) => classifyTokens(sql, DIALECT),
  quoteIdentifier,
  literal: (value) => sqlLiteral(value, LITERALS),
  emptyInsert: defaultValuesInsert,
  updateDefault: defaultKeyword,
  savepoint: sqlSavepoints(quoteIdentifier),
  ...sqlCompleter(COMPLETER),
  ...sqlInspector({ ...COMPLETER, reservedWords: POSTGRES_RESERVED_WORDS }),
  ...sqlGenerator({
    quoteIdentifier,
    updateDefault: defaultKeyword,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: KEYWORDS,
  }),
  explainable,
  ...sqlFormatter({ dialect: "postgresql", lexer: DIALECT, parameters: PARAMETERS.styles }),
  ...sqlParameters(PARAMETERS),
  ...sqlImporter({
    quoteIdentifier,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: KEYWORDS,
    types: POSTGRES_IMPORT_TYPES,
    decimal: postgresDecimal,
  }),
  namespaceSwitch: namespaceSwitcher("searchPath", quoteIdentifier),
  objects: postgresObjects({
    name: writeName,
    text: (value) => sqlLiteral(value, LITERALS),
  }),
  routineCall: postgresRoutineCall(writeName),
};

const BEGIN_SQL = "BEGIN";
const COMMIT_SQL = "COMMIT";
const ROLLBACK_SQL = "ROLLBACK";
/** Each batch of an import is atomic inside the import's transaction (decision 046). */
const SAVEPOINT_SQL = "SAVEPOINT table_craft_insert";
const RELEASE_SQL = "RELEASE SAVEPOINT table_craft_insert";
const ROLLBACK_TO_SQL = "ROLLBACK TO SAVEPOINT table_craft_insert";
const OPEN_TRANSACTION_MESSAGE = "A transaction is open; commit or roll it back before switching to auto-commit.";
const BUSY_MESSAGE = "Another statement is still running in this session.";
const CANCELLED_MESSAGE = "The statement was cancelled.";

const DEFAULT_PORT = 5432;
const MAX_PORT = 65_535;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const MAX_CONNECT_TIMEOUT_SECONDS = 3600;
const MS_PER_SECOND = 1000;
/** How long `close` waits for the server to acknowledge Terminate before dropping the socket. */
const CLOSE_GRACE_MS = 3000;
/** Rows per cursor fetch: one result-window's worth, so the first window costs one round trip. */
const FETCH_ROWS = 500;
/** SQLSTATE `query_canceled`, raised by `pg_cancel_backend`. */
const QUERY_CANCELED = "57014";
const APPLICATION_NAME = "TableCraft";
const PING_SQL = "SELECT 1";
const CLOSED_MESSAGE = "the server closed the connection";

const connectionSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  database: z.string().min(1),
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
  applicationName: z.string().default(APPLICATION_NAME),
});

type PostgresConfig = z.output<typeof connectionSchema>;

/** Type OIDs from `pg_type.dat` in the PostgreSQL source; they are fixed for built-in types. */
const OID = {
  bool: 16,
  bytea: 17,
  int8: 20,
  int2: 21,
  int4: 23,
  oid: 26,
  json: 114,
  float4: 700,
  float8: 701,
  jsonb: 3802,
} as const;

/** `\x` that starts every bytea in the default `bytea_output = hex`. */
const BYTEA_HEX_PREFIX = "\\x";
const HEX_DIGITS_PER_BYTE = 2;

type Cell = (text: string) => WireValue;

const asText: Cell = (text) => text;

function byteaHex(text: string): string {
  return text.startsWith(BYTEA_HEX_PREFIX) ? text.slice(BYTEA_HEX_PREFIX.length) : text;
}

function bytea(text: string): WireValue {
  const hex = byteaHex(text);
  return {
    kind: "bytes",
    preview: hex.slice(0, BYTES_PREVIEW_LENGTH * HEX_DIGITS_PER_BYTE),
    length: hex.length / HEX_DIGITS_PER_BYTE,
  };
}

function wholeBytea(text: string): WireValue {
  const hex = byteaHex(text);
  return { kind: "bytes", preview: hex, length: hex.length / HEX_DIGITS_PER_BYTE };
}

/**
 * Every value arrives as the server's text (the parsers below are identity), and only types whose
 * text a JavaScript value represents exactly become something else (decision 017). Dates,
 * timestamps and numerics stay text, so no client time zone or float rounding touches them.
 */
const CELLS: ReadonlyMap<number, Cell> = new Map<number, Cell>([
  [OID.bool, (text) => text === "t"],
  [OID.int2, Number],
  [OID.int4, Number],
  [OID.oid, Number],
  [OID.float4, Number],
  [OID.float8, Number],
  [OID.int8, toWireInteger],
  [OID.json, (text) => ({ kind: "json", text })],
  [OID.jsonb, (text) => ({ kind: "json", text })],
  [OID.bytea, bytea],
]);

const FULL_BYTES_CELLS: ReadonlyMap<number, Cell> = new Map<number, Cell>([...CELLS, [OID.bytea, wholeBytea]]);

const NO_ROWS: AsyncIterable<Row> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

/** pg sets it from BackendKeyData but its typings omit it. */
interface WithBackendPid {
  readonly processID: number;
}

const TEXT_TYPES: pg.CustomTypesConfig = { getTypeParser: () => (text: string) => text };

interface OpenOptions {
  readonly keepAliveInitialDelayMs?: number | undefined;
  readonly serverName?: string | undefined;
}

async function clientConfig(config: PostgresConfig, options: OpenOptions): Promise<pg.ClientConfig> {
  const { keepAliveInitialDelayMs } = options;
  return {
    ...(keepAliveInitialDelayMs === undefined
      ? {}
      : { keepAlive: true, keepAliveInitialDelayMillis: keepAliveInitialDelayMs }),
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: await tlsOptions(config, options.serverName),
    connectionTimeoutMillis: config.connectTimeout * MS_PER_SECOND,
    ...(config.applicationName === "" ? {} : { application_name: config.applicationName }),
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function openClient(config: PostgresConfig, options: OpenOptions): Promise<pg.Client> {
  const client = new pg.Client(await clientConfig(config, options));
  try {
    await client.connect();
  } catch (cause) {
    throw connectFailure(config, options.serverName, cause);
  }
  return client;
}

/** pg keeps the socket, after any TLS upgrade, on its connection; its typings omit both. */
interface WithConnection {
  readonly connection: { readonly stream: unknown };
}

interface Running {
  cancelRequested: boolean;
  /** When the statement was sent, which `statement_timeout` counts from. */
  startedAt: number;
  /** `statement_timeout` while it runs, in ms; null when there is none. */
  limitMs: number | null;
}

function startRunning(): Running {
  return { cancelRequested: false, startedAt: Date.now(), limitMs: null };
}

/**
 * `#appliedTimeoutMs` once a transaction ended after the plugin set the limit: a `ROLLBACK` may
 * have undone it, so the next statement sets it again whatever it asks for.
 */
const UNKNOWN_TIMEOUT = -1;

interface TransactionState {
  mode: TransactionMode;
  open: boolean;
}

function readBatch(cursor: Cursor<unknown[]>): Promise<{ rows: unknown[][]; result: pg.QueryResult }> {
  return new Promise((resolve, reject) => {
    cursor.read(FETCH_ROWS, (error, rows, result) => {
      // The typings say `undefined` on success; pg-cursor passes `null`.
      if (error == null) resolve({ rows, result });
      else reject(error);
    });
  });
}

const READ_ONLY_SQL = "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY";
const VERSION_SQL = "SHOW server_version";
/** `current_schema()` is the first search_path entry that exists, and null when none does. */
const CURRENT_NAMESPACE_SQL = "SELECT current_database() AS database, current_schema() AS schema";

/** Distribution builds append a build note, as in `17.4 (Debian 17.4-1.pgdg120+2)`. */
function shortVersion(reported: string | undefined): string | null {
  const version = reported?.split(" (")[0]?.trim() ?? "";
  return version === "" ? null : version;
}

/** SQLSTATE classes the server sends when the connection itself is going away. */
const CONNECTION_CLASSES = ["08", "57P01", "57P02", "57P03"];

/** An error the server sent in answer to a statement, not one the socket or the client raised. */
function isServerError(cause: unknown): boolean {
  const { code, severity } = cause as { code?: unknown; severity?: unknown };
  return (
    typeof severity === "string" &&
    typeof code === "string" &&
    !CONNECTION_CLASSES.some((prefix) => code.startsWith(prefix))
  );
}

class PostgresSession implements Session {
  readonly #config: PostgresConfig;
  readonly #serverName: string | undefined;
  readonly #client: pg.Client;
  readonly #typeNames: ReadonlyMap<number, string>;
  /** Set by the client's `error` event; a broken connection is reported, not thrown at random. */
  #broken: Error | null = null;
  #running: Running | null = null;
  /** Set while a user's statement runs: notices from the engine's own statements are not the user's news. */
  #notices: NoticeCollector | null = null;
  #cancelling: Promise<void> = Promise.resolve();
  readonly #transaction: TransactionState = { mode: "auto", open: false };
  /** The session's own `statement_timeout` in ms, 0 for none; read before the first limited statement. */
  #ownTimeoutMs: number | null = null;
  /** The limit this plugin last set; null before it set one; `UNKNOWN_TIMEOUT` after a transaction ended. */
  #appliedTimeoutMs: number | null = null;

  readonly serverVersion: string | null;
  /** The manifest's one brand. */
  readonly serverBrand = "postgresql";
  readonly serverTimeout: ServerTimeout = POSTGRES_SERVER_TIMEOUT;
  readonly cancelReach: CancelReach = CANCEL_REACH;
  readonly tls: TlsInfo | null;
  readonly introspector: Introspector;
  readonly transactions: Transactions;
  readonly sessions: SessionMonitor;
  readonly serverSessionId: string;

  constructor(
    config: PostgresConfig,
    serverName: string | undefined,
    client: pg.Client,
    typeNames: ReadonlyMap<number, string>,
    serverVersion: string | null,
  ) {
    this.#config = config;
    this.#serverName = serverName;
    this.#client = client;
    this.#typeNames = typeNames;
    this.serverVersion = serverVersion;
    this.tls = tlsInfoOf((client as unknown as WithConnection).connection.stream);
    this.introspector = postgresIntrospector(client);
    this.sessions = postgresSessions(client, () => openClient(config, { serverName }));
    this.serverSessionId = String((client as pg.Client & WithBackendPid).processID);
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
    client.on("error", (error) => {
      this.#broken = error;
    });
    client.on("end", () => {
      this.#broken ??= new Error(CLOSED_MESSAGE);
    });
    client.on("notice", (notice: Notice) => {
      this.#notices?.add(notice);
    });
  }

  static async open(config: PostgresConfig, options: ConnectOptions): Promise<PostgresSession> {
    const client = await openClient(config, options);
    try {
      if (options.readOnly) await client.query(READ_ONLY_SQL);
      const types = await client.query<{ oid: number; typname: string }>("SELECT oid, typname FROM pg_type");
      const version = await client.query<{ server_version: string }>(VERSION_SQL);
      return new PostgresSession(
        config,
        options.serverName,
        client,
        new Map(types.rows.map((type) => [type.oid, type.typname])),
        shortVersion(version.rows[0]?.server_version),
      );
    } catch (cause) {
      await client.end();
      throw new PluginError("connectionFailed", messageOf(cause), { cause });
    }
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
    await this.#cancelling.catch(() => undefined);
    const running = startRunning();
    this.#running = running;
    const effect = transactionEffect(sql, DIALECT);
    const state = this.#transaction;
    try {
      if (state.mode === "manual" && !state.open && effect === null) {
        await this.#client.query(BEGIN_SQL);
        state.open = true;
      }
      running.limitMs = await this.#applyTimeout(options.serverTimeoutMs);
      if (namesServerTimeout(sql)) this.#appliedTimeoutMs = null;
      if (running.cancelRequested) throw new Error(CANCELLED_MESSAGE);
      running.startedAt = Date.now();
    } catch (cause) {
      this.#running = null;
      throw this.#failure(cause, running);
    }
    const notices = new NoticeCollector();
    this.#notices = notices;
    const cursor = this.#client.query(
      new Cursor<unknown[]>(sql, params.length === 0 ? undefined : [...params], {
        rowMode: "array",
        types: TEXT_TYPES,
      }),
    );
    try {
      const first = await readBatch(cursor).catch((cause: unknown) => {
        // A failed COMMIT still ends the transaction; a failed statement inside one leaves it open.
        if (effect === "end") this.#transactionEnded();
        throw cause;
      });
      if (effect === "end") this.#transactionEnded();
      else if (effect !== null) state.open = true;
      const fields = first.result.fields;
      if (fields.length === 0) {
        this.#notices = null;
        this.#running = null;
        return { columns: [], rows: NO_ROWS, rowsAffected: first.result.rowCount, messages: notices.messages() };
      }
      const columns: Column[] = fields.map((field) => ({
        name: field.name,
        type: this.#typeNames.get(field.dataTypeID) ?? null,
        origin: originOf(field),
      }));
      const cellMap = options.fullBytes === true ? FULL_BYTES_CELLS : CELLS;
      const cells = fields.map((field) => cellMap.get(field.dataTypeID) ?? asText);
      const messages: ServerMessage[] = [];
      return { columns, rows: this.#rows(cursor, running, first.rows, cells, messages), rowsAffected: null, messages };
    } catch (cause) {
      this.#notices = null;
      this.#running = null;
      throw this.#failure(cause, running, sql);
    }
  }

  async currentNamespace(): Promise<readonly string[] | null> {
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    try {
      const result = await this.#client.query<{ database: string; schema: string | null }>(CURRENT_NAMESPACE_SQL);
      const row = result.rows[0];
      return row?.schema == null ? null : [row.database, row.schema];
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    }
  }

  async ping(): Promise<void> {
    if (this.#broken !== null) {
      throw new PluginError("connectionLost", `The connection was lost: ${this.#broken.message}`);
    }
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    try {
      await this.#client.query(PING_SQL);
    } catch (cause) {
      throw new PluginError("connectionLost", `The connection was lost: ${messageOf(cause)}`, { cause });
    }
  }

  async insertRows(target: InsertTarget, rows: readonly InsertRow[]): Promise<void> {
    if (this.#broken !== null) {
      throw new PluginError("connectionFailed", `The connection was lost: ${this.#broken.message}`);
    }
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    if (rows.length === 0) return;
    await this.#cancelling.catch(() => undefined);
    const running = startRunning();
    this.#running = running;
    const state = this.#transaction;
    try {
      if (state.mode === "manual" && !state.open) {
        await this.#client.query(BEGIN_SQL);
        state.open = true;
      }
      // Outside a transaction COPY is atomic by itself; inside one, a refused row would abort it.
      const savepoint = state.open;
      if (savepoint) await this.#client.query(SAVEPOINT_SQL);
      try {
        await this.#copy(target, rows);
        if (savepoint) await this.#client.query(RELEASE_SQL);
      } catch (cause) {
        if (savepoint && this.#lost() === null) {
          await this.#client.query(ROLLBACK_TO_SQL).catch((lost: unknown) => {
            this.#broken ??= lost instanceof Error ? lost : new Error(String(lost));
          });
        }
        throw cause;
      }
    } catch (cause) {
      // Only the server refuses rows; anything else (a reset socket, a closed client) is the link.
      if (!isServerError(cause)) this.#broken ??= cause instanceof Error ? cause : new Error(String(cause));
      const lost = this.#lost();
      if (lost !== null)
        throw new PluginError("connectionFailed", `The connection was lost: ${lost.message}`, { cause });
      throw this.#failure(cause, running);
    } finally {
      this.#running = null;
    }
  }

  /** Read through a method: the client's `error` event sets it while a statement is awaited. */
  #lost(): Error | null {
    return this.#broken;
  }

  async #copy(target: InsertTarget, rows: readonly InsertRow[]): Promise<void> {
    const columns = target.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const stream = this.#client.query(copyFrom(`COPY ${target.table} (${columns}) FROM STDIN`));
    const text = rows.map((row) => copyLine(row, target.columns)).join("");
    await pipeline(Readable.from([text]), stream);
  }

  async explain(sql: string, options: ExplainOptions): Promise<ExplainedPlan> {
    const verdict = explainable(sql, options);
    if (!verdict.ok) throw new PluginError("explainUnsupported", verdict.reason);
    const statement = explainStatement(sql, options.analyze);
    const rows: Row[] = [];
    const limit = options.serverTimeoutMs;
    const result = await this.execute(statement, [], limit === undefined ? {} : { serverTimeoutMs: limit });
    for await (const row of result.rows) rows.push(row);
    return { ...readPlan(planText(rows), statement, options.analyze), messages: result.messages ?? [] };
  }

  async *#rows(
    cursor: Cursor<unknown[]>,
    running: Running,
    first: unknown[][],
    cells: readonly Cell[],
    messages: ServerMessage[],
  ): AsyncGenerator<Row, void, undefined> {
    let batch = first;
    let exhausted = false;
    let completed = false;
    try {
      while (batch.length > 0) {
        for (const values of batch) {
          yield values.map((value, index) => (value === null ? null : (cells[index] ?? asText)(value as string)));
        }
        try {
          batch = (await readBatch(cursor)).rows;
        } catch (cause) {
          exhausted = true;
          throw this.#failure(cause, running);
        }
      }
      exhausted = true;
      completed = true;
    } finally {
      if (!exhausted) await cursor.close();
      if (completed) messages.push(...(this.#notices?.messages() ?? []));
      this.#notices = null;
      this.#running = null;
    }
  }

  #failure(cause: unknown, running: Running, sql?: string): PluginError {
    const code = (cause as { code?: unknown }).code;
    const limit = running.limitMs;
    // pg_cancel_backend and the timeout both send 57014; only a cancel the plugin asked for is one.
    if (
      !running.cancelRequested &&
      code === QUERY_CANCELED &&
      limit !== null &&
      Date.now() - running.startedAt >= limit
    ) {
      return new PluginError(
        "timedOut",
        `PostgreSQL stopped the statement at its ${String(limit / MS_PER_SECOND)} s limit (statement_timeout).`,
        { cause },
      );
    }
    if (running.cancelRequested || code === QUERY_CANCELED) {
      return new PluginError("cancelled", CANCELLED_MESSAGE, { cause });
    }
    const position = sql === undefined ? undefined : serverErrorPosition(sql, cause);
    return new PluginError("statementFailed", messageOf(cause), { cause, position });
  }

  cancel(): Promise<void> {
    const running = this.#running;
    if (running === null) return Promise.resolve();
    running.cancelRequested = true;
    this.#cancelling = this.#cancelBackend();
    return this.#cancelling;
  }

  /** On a second connection, because the session's own is busy with the statement it cancels. */
  async #cancelBackend(): Promise<void> {
    const backendPid = (this.#client as pg.Client & WithBackendPid).processID;
    const canceller = await openClient(this.#config, { serverName: this.#serverName });
    try {
      await canceller.query("SELECT pg_cancel_backend($1)", [backendPid]);
    } finally {
      await canceller.end();
    }
  }

  #setMode(mode: TransactionMode): Promise<void> {
    if (mode === "auto" && this.#transaction.open) {
      return Promise.reject(new PluginError("statementFailed", OPEN_TRANSACTION_MESSAGE));
    }
    this.#transaction.mode = mode;
    return Promise.resolve();
  }

  async #endTransaction(sql: string): Promise<void> {
    if (!this.#transaction.open) return;
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    try {
      await this.#client.query(sql);
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    } finally {
      this.#transactionEnded();
    }
  }

  /** `statement_timeout` is transactional: a `ROLLBACK` undoes a `SET` made inside it. */
  #transactionEnded(): void {
    this.#transaction.open = false;
    if (this.#appliedTimeoutMs !== null) this.#appliedTimeoutMs = UNKNOWN_TIMEOUT;
  }

  /**
   * Sets `statement_timeout` to `requested`, never above the session's own, or puts the own back
   * when nothing is requested; sends nothing when the value would not change (decision 129). In a
   * failed transaction, which refuses the `SET`, it is skipped and the statement fails on its own.
   * Returns the limit the statement runs under, null for none.
   */
  async #applyTimeout(requested: number | undefined): Promise<number | null> {
    if (requested === undefined && this.#appliedTimeoutMs === null) return null;
    try {
      if (this.#ownTimeoutMs === null) {
        const shown = await this.#client.query<{ statement_timeout?: string }>(READ_TIMEOUT_SQL);
        this.#ownTimeoutMs = postgresDurationMs(shown.rows[0]?.statement_timeout ?? "0");
      }
      const own = this.#ownTimeoutMs;
      const want = requested === undefined ? own : own === 0 ? requested : Math.min(own, requested);
      if (want !== this.#appliedTimeoutMs) {
        await this.#client.query(SET_TIMEOUT_SQL, [String(want)]);
        this.#appliedTimeoutMs = want;
      }
      return want === 0 ? null : want;
    } catch (cause) {
      if ((cause as { code?: unknown }).code !== FAILED_TRANSACTION) throw cause;
      return null;
    }
  }

  async close(): Promise<void> {
    await this.#cancelling.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceful = this.#client.end().then(
      () => true,
      () => true,
    );
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
    });
    const ended = await Promise.race([graceful, expired]);
    clearTimeout(timer);
    if (!ended) this.#client.connection.stream.destroy();
  }
}

const plugin: DatasourcePlugin = {
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  language,
  connectionSchema,
  connect: (config, options) => PostgresSession.open(connectionSchema.parse(config), options),
};

export default plugin;

/** The table OID and attribute number PostgreSQL reports, or null for an expression (plan 026). */
function originOf(field: pg.FieldDef): ColumnOrigin | null {
  if (field.tableID === 0 || field.columnID === 0) return null;
  return { table: String(field.tableID), column: String(field.columnID) };
}
