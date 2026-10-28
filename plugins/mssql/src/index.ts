import { Connection, type ConnectionConfiguration } from "tedious";
import type { ColumnMetadata } from "tedious/lib/token/colmetadata-token-parser.js";
import {
  PluginError,
  z,
  type Capability,
  type Column,
  type ConnectOptions,
  type DatasourcePlugin,
  type ExecuteOptions,
  type ExecuteResult,
  type ExplainedPlan,
  type ExplainOptions,
  type InsertRow,
  type InsertTarget,
  type ParameterValue,
  type Row,
  type ServerMessage,
  type Session,
  type SessionMonitor,
  type StatementKind,
  type TlsInfo,
  type TransactionMode,
  type Transactions,
  type WireValue,
} from "@table-craft/plugin-api";
import { Batch, firstError, isCancelled, readAll, type ReadSet } from "./batch.js";
import { insertChunks } from "./bulk.js";
import { serverErrorPosition } from "./errorPosition.js";
import { explainBatches, PLAN_COLUMN, readPlan } from "./explain.js";
import { mssqlIntrospector, type Reader } from "./introspect.js";
import { language, nationalText, quoteIdentifier } from "./language.js";
import { infoMessage, MessageCollector, type InfoMessage } from "./messages.js";
import { serverVersionOf } from "./server.js";
import { mssqlSessions } from "./sessions.js";
import { connectFailure, ENCRYPT_MODES, rootCertificate, tediousEncrypt, tlsInfoOf } from "./tls.js";
import { bigintValue, columnOf, installExactValues, wireValue } from "./values.js";

const PLUGIN_ID = "mssql";

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
];

const AUTHENTICATIONS = ["sql", "ntlm", "azure-active-directory-password", "azure-active-directory-default"] as const;

const DEFAULT_PORT = 1433;
const MAX_PORT = 65535;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const MAX_CONNECT_TIMEOUT_SECONDS = 3600;
const MS_PER_SECOND = 1000;
const APPLICATION_NAME = "TableCraft";
const CLOSE_GRACE_MS = 3000;

const IDENTITY_SQL =
  "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version, " +
  "CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition, @@SPID AS id";
const PING_SQL = "SELECT 1";
const NAMESPACE_SQL = "SELECT DB_NAME() AS d, SCHEMA_NAME() AS s";
const MANUAL_SQL = "SET IMPLICIT_TRANSACTIONS ON";
const AUTO_SQL = "SET IMPLICIT_TRANSACTIONS OFF";
const BEGIN_SQL = "BEGIN TRANSACTION";
const COMMIT_SQL = "WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION";
const ROLLBACK_SQL = "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION";
const IMPORT_SAVEPOINT = quoteIdentifier("table_craft_import");
const IMPORT_SAVEPOINT_SQL = `IF @@TRANCOUNT = 0 BEGIN TRANSACTION;\nSAVE TRANSACTION ${IMPORT_SAVEPOINT}`;
const IMPORT_ROLLBACK_SQL = `IF XACT_STATE() = 1 ROLLBACK TRANSACTION ${IMPORT_SAVEPOINT}`;

/** The error SQL Server raises when the login lacks the SHOWPLAN permission. */
const SHOWPLAN_DENIED = 262;

const OPEN_TRANSACTION_MESSAGE = "A transaction is open; commit or roll it back before switching to auto-commit.";
const BUSY_MESSAGE = "Another statement is still running in this session.";
const READ_ONLY_REFUSED_MESSAGE =
  "This session is read-only, so the statement was not sent. Turn off Read-only on the data source to change data or schema.";
const WRITING_KINDS: ReadonlySet<StatementKind> = new Set(["write", "ddl"]);
const TUNNELLED_INSTANCE_MESSAGE =
  "A named instance is found through the SQL Server Browser on UDP port 1434, which an SSH tunnel does not carry. Leave Instance empty and give the instance's TCP port instead.";

const connectionSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
  instance: z.string().default(""),
  database: z.string().default(""),
  authentication: z.enum(AUTHENTICATIONS).default("sql"),
  user: z.string().default(""),
  password: z.string().default(""),
  domain: z.string().default(""),
  clientId: z.string().default(""),
  tenantId: z.string().default(""),
  encrypt: z.enum(ENCRYPT_MODES).default("mandatory"),
  trustServerCertificate: z.boolean().default(false),
  sslRootCert: z.string().default(""),
  connectTimeout: z.number().int().min(1).max(MAX_CONNECT_TIMEOUT_SECONDS).default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
  applicationName: z.string().default(APPLICATION_NAME),
});

type MssqlConfig = z.infer<typeof connectionSchema>;

/** What the server said a transaction is: tedious keeps one descriptor per open level, plus the outermost. */
interface TransactionTracking {
  readonly transactionDescriptors: readonly unknown[];
}

const NO_ROWS: AsyncIterable<Row> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function numberOf(cause: unknown): number | null {
  const value = (cause as { number?: unknown } | null)?.number;
  return typeof value === "number" ? value : null;
}

function authenticationOf(config: MssqlConfig): ConnectionConfiguration["authentication"] {
  switch (config.authentication) {
    case "ntlm":
      return {
        type: "ntlm",
        options: { userName: config.user, password: config.password, domain: config.domain },
      };
    case "azure-active-directory-password":
      return {
        type: "azure-active-directory-password",
        options: {
          userName: config.user,
          password: config.password,
          clientId: config.clientId,
          tenantId: config.tenantId,
        },
      };
    case "azure-active-directory-default":
      return {
        type: "azure-active-directory-default",
        options: config.clientId === "" ? {} : { clientId: config.clientId },
      };
    case "sql":
      return { type: "default", options: { userName: config.user, password: config.password } };
  }
}

async function tediousConfig(config: MssqlConfig, options: ConnectOptions): Promise<ConnectionConfiguration> {
  const ca = await rootCertificate(config);
  return {
    server: config.host,
    authentication: authenticationOf(config),
    options: {
      ...(config.instance === "" ? { port: config.port } : { instanceName: config.instance }),
      ...(config.database === "" ? {} : { database: config.database }),
      encrypt: tediousEncrypt(config.encrypt),
      trustServerCertificate: config.trustServerCertificate,
      ...(ca === undefined ? {} : { cryptoCredentialsDetails: { ca } }),
      ...(options.serverName === undefined ? {} : { serverName: options.serverName }),
      connectTimeout: config.connectTimeout * MS_PER_SECOND,
      requestTimeout: 0,
      appName: config.applicationName,
      readOnlyIntent: options.readOnly,
      // Values are decoded from the wire by values.ts, so tedious's own Date handling never shows.
      useUTC: true,
    },
  };
}

/** Opens a connection, rejecting with what the login failed with. */
/**
 * The TLS layer of each connection: with `encrypt: "strict"` it is the socket itself, otherwise
 * TDS carries TLS inside its packets and tedious hands the inner socket out once, on `secure`.
 */
const TLS_LAYER = new WeakMap<Connection, unknown>();

function openConnection(settings: ConnectionConfiguration): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const connection = new Connection(settings);
    connection.once("secure", (cleartext) => TLS_LAYER.set(connection, cleartext));
    const onError = (error: unknown): void => reject(error instanceof Error ? error : new Error(String(error)));
    connection.once("error", onError);
    connection.connect((error) => {
      connection.removeListener("error", onError);
      if (error) {
        connection.close();
        reject(error);
      } else resolve(connection);
    });
  });
}

function closeConnection(connection: Connection): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      connection.socket?.destroy();
      resolve();
    }, CLOSE_GRACE_MS);
    connection.once("end", () => {
      clearTimeout(timer);
      resolve();
    });
    connection.close();
  });
}

/** One request at a time on a connection, as TDS allows; the catalog and the console queue here. */
class Lane {
  #tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void = () => undefined;
    const previous = this.#tail;
    this.#tail = new Promise((resolve) => (release = resolve));
    await previous;
    return release;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  }
}

interface Running {
  cancelRequested: boolean;
  batch: Batch | null;
}

interface Identity {
  readonly version: string;
  readonly edition: number;
  readonly id: number;
}

function moreResultSetsMessage(count: number): ServerMessage {
  const sets = count === 1 ? "1 more result set" : `${String(count)} more result sets`;
  return { level: "info", code: null, text: `${sets} in this batch; separate statements with ; to see each.` };
}

class MssqlSession implements Session {
  readonly #connection: Connection;
  readonly #lane = new Lane();
  readonly #readOnly: boolean;
  #broken: Error | null = null;
  #running: Running | null = null;
  #cancelling: Promise<void> = Promise.resolve();
  #mode: TransactionMode = "auto";
  readonly serverVersion: string | null;
  readonly serverSessionId: string;
  readonly tls: TlsInfo | null;
  readonly introspector;
  readonly sessions: SessionMonitor;
  readonly transactions: Transactions;

  private constructor(connection: Connection, identity: Identity, fresh: () => Promise<Connection>, readOnly: boolean) {
    this.#connection = connection;
    this.#readOnly = readOnly;
    this.serverVersion = serverVersionOf(identity.version, identity.edition);
    this.serverSessionId = String(identity.id);
    this.tls = tlsInfoOf(connection.socket) ?? tlsInfoOf(TLS_LAYER.get(connection));
    connection.on("error", (error: Error) => (this.#broken ??= error));
    connection.on("end", () => (this.#broken ??= new Error("The server closed the connection.")));
    const read: Reader = (sql, params = []) => this.#read(sql, params);
    this.introspector = mssqlIntrospector(read, quoteIdentifier, nationalText);
    this.sessions = mssqlSessions(read, async (work) => {
      const other = await fresh();
      try {
        return await work((sql, params = []) => readAll(other, sql, params));
      } finally {
        await closeConnection(other);
      }
    });
    const mode = (): TransactionMode => this.#mode;
    const open = (): boolean => this.#open;
    this.transactions = {
      setMode: (mode) => this.#setMode(mode),
      commit: () => this.#endTransaction(COMMIT_SQL),
      rollback: () => this.#endTransaction(ROLLBACK_SQL),
      get mode() {
        return mode();
      },
      get open() {
        return open();
      },
    };
  }

  static async open(config: MssqlConfig, options: ConnectOptions): Promise<MssqlSession> {
    if (config.instance !== "" && options.serverName !== undefined) {
      throw new PluginError("connectionFailed", TUNNELLED_INSTANCE_MESSAGE);
    }
    const settings = await tediousConfig(config, options);
    let connection: Connection;
    try {
      connection = await openConnection(settings);
    } catch (cause) {
      throw connectFailure(config, options.serverName, cause);
    }
    try {
      installExactValues();
      if (options.keepAliveInitialDelayMs !== undefined) {
        connection.socket?.setKeepAlive(true, options.keepAliveInitialDelayMs);
      }
      const [set] = await readAll(connection, IDENTITY_SQL);
      const row = set?.rows[0] ?? [];
      const identity: Identity = {
        version: typeof row[0] === "string" ? row[0] : "",
        edition: typeof row[1] === "number" ? row[1] : 0,
        id: typeof row[2] === "number" ? row[2] : 0,
      };
      return new MssqlSession(connection, identity, () => openConnection(settings), options.readOnly);
    } catch (cause) {
      await closeConnection(connection);
      throw new PluginError("connectionFailed", messageOf(cause), { cause });
    }
  }

  get #open(): boolean {
    return (this.#connection as unknown as TransactionTracking).transactionDescriptors.length > 1;
  }

  #checkUsable(): void {
    if (this.#broken !== null) {
      throw new PluginError("connectionLost", `The connection was lost: ${this.#broken.message}`);
    }
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
  }

  async #read(sql: string, params: readonly (string | null)[]): Promise<ReadSet[]> {
    if (this.#broken !== null) {
      throw new PluginError("connectionLost", `The connection was lost: ${this.#broken.message}`);
    }
    return this.#lane.run(() => readAll(this.#connection, sql, params));
  }

  async execute(
    sql: string,
    params: readonly ParameterValue[] = [],
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    this.#checkUsable();
    if (this.#readOnly && WRITING_KINDS.has(language.classify(sql).kind)) {
      throw new PluginError("statementFailed", READ_ONLY_REFUSED_MESSAGE);
    }
    const running: Running = { cancelRequested: false, batch: null };
    this.#running = running;
    await this.#cancelling.catch(() => undefined);
    const release = await this.#lane.acquire();
    const finish = (): void => {
      release();
      if (this.#running === running) this.#running = null;
    };
    const earlier: ServerMessage[] = [];
    try {
      for (let run = 1; run < (options.repeat ?? 1); run += 1) {
        const batch = new Batch(this.#connection, sql, params);
        running.batch = batch;
        const { settled } = await batch.drain();
        earlier.push(...settled.messages);
        if (running.cancelRequested) throw new PluginError("cancelled", "The statement was cancelled.");
      }
    } catch (cause) {
      finish();
      throw this.#failure(cause, running, sql);
    }
    const batch = new Batch(this.#connection, sql, params);
    running.batch = batch;
    const metadata = await batch.columns;
    if (metadata === null) {
      const settled = await batch.settled;
      finish();
      if (settled.error !== null) throw this.#failure(settled.error, running, sql);
      return {
        columns: [],
        rows: NO_ROWS,
        rowsAffected: settled.rowsAffected,
        messages: [...earlier, ...settled.messages],
      };
    }
    const columns: Column[] = metadata.map((column) => columnOf(column));
    const messages: ServerMessage[] = [];
    return {
      columns,
      rows: this.#rows(batch, metadata, running, sql, options.fullBytes === true, messages, earlier, finish),
      rowsAffected: null,
      messages,
    };
  }

  async *#rows(
    batch: Batch,
    metadata: readonly ColumnMetadata[],
    running: Running,
    sql: string,
    fullBytes: boolean,
    messages: ServerMessage[],
    earlier: readonly ServerMessage[],
    finish: () => void,
  ): AsyncGenerator<Row> {
    const converters = metadata.map((column) =>
      column.type.name === "BigInt" || (column.type.name === "IntN" && column.dataLength === 8)
        ? bigintValue
        : (value: unknown): WireValue => wireValue(value, fullBytes),
    );
    let completed = false;
    try {
      for await (const raw of batch.rows()) yield raw.map((value, index) => converters[index]?.(value) ?? null);
      completed = true;
    } catch (cause) {
      throw this.#failure(cause, running, sql);
    } finally {
      if (!completed) await batch.stop();
      const settled = await batch.settled;
      if (completed) {
        messages.push(...earlier, ...settled.messages);
        if (settled.moreResultSets > 0) messages.push(moreResultSetsMessage(settled.moreResultSets));
      }
      finish();
    }
  }

  async cancel(): Promise<void> {
    const running = this.#running;
    if (running === null) return;
    running.cancelRequested = true;
    this.#cancelling = running.batch?.stop() ?? Promise.resolve();
    await this.#cancelling;
  }

  async currentNamespace(): Promise<readonly string[] | null> {
    this.#checkUsable();
    try {
      const [set] = await this.#read(NAMESPACE_SQL, []);
      const [database, schema] = set?.rows[0] ?? [];
      return typeof database === "string" && typeof schema === "string" ? [database, schema] : null;
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(firstError(cause)), { cause });
    }
  }

  async ping(): Promise<void> {
    try {
      await this.#read(PING_SQL, []);
    } catch (cause) {
      throw new PluginError("connectionLost", `The connection was lost: ${messageOf(cause)}`, { cause });
    }
  }

  async insertRows(target: InsertTarget, rows: readonly InsertRow[]): Promise<void> {
    if (this.#broken !== null) {
      throw new PluginError("connectionFailed", `The connection was lost: ${this.#broken.message}`);
    }
    if (this.#readOnly) throw new PluginError("statementFailed", READ_ONLY_REFUSED_MESSAGE);
    const quoted = target.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const chunks = insertChunks(target.table, target.columns, quoted, rows);
    await this.#lane.run(async () => {
      const own = this.#mode === "auto" && !this.#open;
      await readAll(this.#connection, own ? BEGIN_SQL : IMPORT_SAVEPOINT_SQL);
      try {
        for (const chunk of chunks) await readAll(this.#connection, chunk.sql, chunk.params);
        if (own) await readAll(this.#connection, COMMIT_SQL);
      } catch (cause) {
        await readAll(this.#connection, own ? ROLLBACK_SQL : IMPORT_ROLLBACK_SQL).catch(() => undefined);
        throw new PluginError("statementFailed", messageOf(cause), { cause });
      }
    });
  }

  async explain(sql: string, options: ExplainOptions): Promise<ExplainedPlan> {
    const verdict = language.explainable?.(sql, options);
    if (verdict !== undefined && !verdict.ok) throw new PluginError("explainUnsupported", verdict.reason);
    this.#checkUsable();
    const { on, off, statement } = explainBatches(sql, options.analyze);
    const collector = new MessageCollector();
    const onInfo = (info: InfoMessage): void => collector.add(infoMessage(info));
    const xml = await this.#lane.run(async () => {
      await readAll(this.#connection, on);
      this.#connection.on("infoMessage", onInfo);
      try {
        const sets = await readAll(this.#connection, sql);
        const plan = sets.find((set) => PLAN_COLUMN.test(set.columns[0]?.colName ?? ""));
        const value = plan?.rows[0]?.[0];
        return typeof value === "string" ? value : "";
      } catch (cause) {
        const failure = firstError(cause);
        const hint = numberOf(failure) === SHOWPLAN_DENIED ? " Ask for GRANT SHOWPLAN TO the login to explain." : "";
        throw new PluginError("statementFailed", `${messageOf(failure)}${hint}`, {
          cause: failure,
          position: serverErrorPosition(sql, failure),
        });
      } finally {
        this.#connection.removeListener("infoMessage", onInfo);
        await readAll(this.#connection, off).catch(() => undefined);
      }
    });
    return { ...readPlan(xml, statement, options.analyze), messages: collector.messages() };
  }

  async #setMode(mode: TransactionMode): Promise<void> {
    if (mode === this.#mode) return;
    this.#checkUsable();
    if (mode === "auto" && this.#open) throw new PluginError("statementFailed", OPEN_TRANSACTION_MESSAGE);
    await this.#lane.run(() => readAll(this.#connection, mode === "manual" ? MANUAL_SQL : AUTO_SQL));
    this.#mode = mode;
  }

  async #endTransaction(sql: string): Promise<void> {
    if (!this.#open) return;
    this.#checkUsable();
    try {
      await this.#lane.run(() => readAll(this.#connection, sql));
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    }
  }

  #failure(cause: unknown, running: Running, sql: string): PluginError {
    if (cause instanceof PluginError) return cause;
    const failure = firstError(cause);
    if (running.cancelRequested || isCancelled(failure)) {
      return new PluginError("cancelled", "The statement was cancelled.", { cause: failure });
    }
    if (this.#broken !== null) {
      return new PluginError("connectionLost", `The connection was lost: ${this.#broken.message}`, { cause: failure });
    }
    const position = serverErrorPosition(sql, failure);
    return new PluginError("statementFailed", messageOf(failure), {
      cause: failure,
      ...(position === undefined ? {} : { position }),
    });
  }

  async close(): Promise<void> {
    await this.#cancelling.catch(() => undefined);
    await closeConnection(this.#connection);
  }
}

const plugin: DatasourcePlugin = {
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  language,
  connectionSchema,
  connect: (config, options) => MssqlSession.open(connectionSchema.parse(config), options),
};

export default plugin;
