import oracledb from "oracledb";
import {
  PluginError,
  type CancelReach,
  type Capability,
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
  type Session,
  type SessionMonitor,
  type TlsInfo,
  type TransactionMode,
  type Transactions,
} from "@table-craft/plugin-api";
import { boundRow, insertStatement } from "./bulk.js";
import { connectionSchema, messageOf, openConnection, type OracleConfig } from "./connect.js";
import { serverErrorPosition } from "./errorPosition.js";
import {
  ANALYZE_GRANT_PROBE_SQL,
  ANALYZED_ROWS_SQL,
  ANALYZED_TEXT_SQL,
  analyzeGrantHint,
  explainStatement,
  LAST_CURSOR_SQL,
  PLAN_CLEANUP_SQL,
  PLAN_ROWS_SQL,
  PLAN_TEXT_SQL,
  planTree,
  STATISTICS_OFF_SQL,
  STATISTICS_ON_SQL,
  type PlanRow,
} from "./explain.js";
import { oracleIntrospector } from "./introspect.js";
import { explainable, importName, language, quoteIdentifier, writeName } from "./language.js";
import { compileMessages, COMPILE_WARNING, drainOutput, ENABLE_OUTPUT_SQL, MessageCollector } from "./output.js";
import { cancelStatement, oracleSessions, SERVER_SESSION_ID_SQL } from "./sessions.js";
import { classify, oracleTransactionEffect, serverText } from "./statements.js";
import { columnReader, fetchTypeHandler, SESSION_FORMATS, wireRow, type ColumnReader } from "./values.js";

const PLUGIN_ID = "oracle";
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

const COMMIT_SQL = "COMMIT";
const ROLLBACK_SQL = "ROLLBACK";
/** Each batch of an import is atomic inside the import's transaction (decision 046). */
const SAVEPOINT_SQL = "SAVEPOINT table_craft_insert";
const ROLLBACK_TO_SQL = "ROLLBACK TO SAVEPOINT table_craft_insert";
/**
 * A read-only session keeps a read-only transaction open: this ends the last one, so each
 * statement in auto-commit reads fresh data, and opens the next.
 */
const READ_ONLY_TRANSACTION_SQL = "BEGIN COMMIT; DBMS_TRANSACTION.READ_ONLY; END;";
const CURRENT_SCHEMA_SQL = "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL";
const SESSION_USER_SQL = "SELECT SYS_CONTEXT('USERENV', 'SESSION_USER') FROM DUAL";
const OPEN_TRANSACTION_MESSAGE = "A transaction is open; commit or roll it back before switching to auto-commit.";
const BUSY_MESSAGE = "Another statement is still running in this session.";
const READ_ONLY_REFUSED_MESSAGE =
  "This session is read-only, so the statement was not sent. Turn off Read-only on the data source to change data or schema.";
const CANCELLED_MESSAGE = "The statement was cancelled.";
const CANCEL_REACH: CancelReach = { method: "ALTER SYSTEM CANCEL SQL", reaches: "statement" };
const WRITING_KINDS = new Set(["write", "ddl"]);
/** How long `close` waits for the server to acknowledge the logoff before giving up on it. */
const CLOSE_GRACE_MS = 3000;
/** Rows per fetch: one result-window's worth, so the first window costs one round trip. */
const FETCH_ROWS = 500;
/** ORA-01013: user requested cancel of current operation, what `break()` makes the statement fail with. */
const USER_CANCELLED = 1013;
/** ORA-00942: the account cannot see the view Explain Analyse reads. */
const NO_VIEW = 942;
/** `RELEASE SAVEPOINT`, which Oracle lacks: its savepoints end with the transaction. */
const RELEASE_SAVEPOINT = /^\s*RELEASE\s+SAVEPOINT\b/i;
/** `INSERT INTO t DEFAULT VALUES`, the shared empty insert, which Oracle lacks. */
const DEFAULT_VALUES_INSERT = /^\s*INSERT\s+INTO\s+([\s\S]+?)\s+DEFAULT\s+VALUES\s*;?\s*$/i;
const NAME_PART = /"((?:[^"]|"")+)"|([A-Za-z][\w$#]*)/g;
const FIRST_COLUMN_SQL = `SELECT column_name FROM all_tab_cols
  WHERE owner = NVL(:owner, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')) AND table_name = :name
    AND hidden_column = 'NO' AND virtual_column = 'NO'
  ORDER BY column_id FETCH FIRST 1 ROWS ONLY`;

/** The longest `VARCHAR2` or `RAW` a bind carries; a longer value goes as a LOB. */
const MAX_INLINE_BIND_BYTES = 32_767;
/** Thin mode keeps its socket private, so the negotiated TLS version and cipher are not known. */
const TCPS: TlsInfo = { protocol: "TCPS", cipher: "negotiated by the server" };

const NO_ROWS: AsyncIterable<Row> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

const EMPTY_RESULT: ExecuteResult = { columns: [], rows: NO_ROWS, rowsAffected: null, messages: [] };

interface Running {
  cancelRequested: boolean;
}

interface TransactionState {
  mode: TransactionMode;
  open: boolean;
}

/** The stored owner and name a written `owner.table` or `table` refers to. */
function storedParts(written: string): string[] {
  return [...written.matchAll(NAME_PART)].map((match) =>
    match[1] === undefined ? (match[2] ?? "").toUpperCase() : match[1].replace(/""/g, '"'),
  );
}

function isResultSet(value: unknown): value is oracledb.ResultSet<unknown[]> {
  return typeof (value as { getRows?: unknown } | null)?.getRows === "function";
}

function extraResultsMessage(count: number): ServerMessage {
  return {
    level: "info",
    code: null,
    text: `The call returned ${String(count)} result sets; the first is shown and the other ${String(count - 1)} were closed.`,
  };
}

/** Configures a fresh connection: ISO-like date text, `DBMS_OUTPUT` collected, the module named. */
async function prepare(connection: oracledb.Connection, config: OracleConfig): Promise<void> {
  for (const sql of SESSION_FORMATS) await connection.execute(sql);
  await connection.execute(ENABLE_OUTPUT_SQL);
  if (config.applicationName !== "") connection.module = config.applicationName;
}

async function firstValue(connection: oracledb.Connection, sql: string): Promise<string | null> {
  const result = await connection.execute<unknown[]>(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY });
  const value = result.rows?.[0]?.[0];
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

class OracleSession implements Session {
  readonly #config: OracleConfig;
  readonly #connection: oracledb.Connection;
  readonly #readOnly: boolean;
  #broken: Error | null = null;
  #running: Running | null = null;
  #cancelling: Promise<void> = Promise.resolve();
  readonly #transaction: TransactionState = { mode: "auto", open: false };
  #explained = 0;

  readonly serverVersion: string | null;
  /** The manifest's one brand. */
  readonly serverBrand = "oracle";
  readonly cancelReach = CANCEL_REACH;
  readonly tls: TlsInfo | null;
  readonly introspector: Introspector;
  readonly transactions: Transactions;
  readonly sessions: SessionMonitor;
  readonly serverSessionId: string;

  constructor(config: OracleConfig, connection: oracledb.Connection, readOnly: boolean, sessionId: string) {
    this.#config = config;
    this.#connection = connection;
    this.#readOnly = readOnly;
    this.serverVersion = connection.oracleServerVersionString || null;
    this.tls = config.sslMode === "disable" ? null : TCPS;
    this.introspector = oracleIntrospector(connection, writeName);
    this.sessions = oracleSessions(connection, () => openConnection(config, {}));
    this.serverSessionId = sessionId;
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
  }

  static async open(config: OracleConfig, options: ConnectOptions): Promise<OracleSession> {
    const connection = await openConnection(config, options);
    try {
      await prepare(connection, config);
      const sessionId = (await firstValue(connection, SERVER_SESSION_ID_SQL)) ?? "";
      return new OracleSession(config, connection, options.readOnly, sessionId);
    } catch (cause) {
      await connection.close().catch(() => undefined);
      throw new PluginError("connectionFailed", messageOf(cause), { cause });
    }
  }

  #lostError(code: "connectionLost" | "connectionFailed"): PluginError | null {
    return this.#broken === null
      ? null
      : new PluginError(code, `The connection was lost: ${messageOf(this.#broken)}`, { cause: this.#broken });
  }

  /** Whether a statement in `mode` commits on its own: auto-commit outside an explicit transaction. */
  #autoCommit(): boolean {
    return this.#transaction.mode === "auto" && !this.#transaction.open && !this.#readOnly;
  }

  async execute(
    sql: string,
    params: readonly ParameterValue[] = [],
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const lost = this.#lostError("connectionLost");
    if (lost !== null) throw lost;
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    await this.#cancelling.catch(() => undefined);
    if (RELEASE_SAVEPOINT.test(sql)) return EMPTY_RESULT;
    const { kind } = classify(sql);
    if (this.#readOnly && WRITING_KINDS.has(kind)) throw new PluginError("statementFailed", READ_ONLY_REFUSED_MESSAGE);
    const running: Running = { cancelRequested: false };
    this.#running = running;
    const effect = oracleTransactionEffect(sql);
    const state = this.#transaction;
    let text = serverText(sql);
    let result: oracledb.Result<unknown[]>;
    try {
      text = await this.#withoutDefaultValues(text);
      if (this.#readOnly && effect === null && !state.open) {
        await this.#connection.execute(READ_ONLY_TRANSACTION_SQL);
        if (state.mode === "manual") state.open = true;
      }
      if (state.mode === "manual" && effect === null && kind !== "ddl") state.open = true;
      result = await this.#connection.execute<unknown[]>(text, [...params], {
        autoCommit: this.#autoCommit(),
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        fetchTypeHandler,
      });
    } catch (cause) {
      if (effect === "end") state.open = false;
      this.#running = null;
      throw this.#failure(cause, running, text);
    }
    if (effect !== null) state.open = effect === "begin";
    else if (kind === "ddl") state.open = false;
    const messages = new MessageCollector();
    const fullBytes = options.fullBytes === true;
    try {
      const results = [result.resultSet, ...(result.implicitResults ?? [])].filter((found) => found !== undefined);
      for (const extra of results.slice(1)) if (isResultSet(extra)) await extra.close();
      if (results.length > 1) messages.add(extraResultsMessage(results.length));
      const [shown] = results;
      if (shown === undefined) {
        if (result.warning?.message.startsWith(COMPILE_WARNING) === true) {
          await compileMessages(this.#connection, text, messageOf(result.warning), messages);
        }
        await drainOutput(this.#connection, messages);
        this.#running = null;
        return { columns: [], rows: NO_ROWS, rowsAffected: result.rowsAffected ?? null, messages: messages.messages() };
      }
      const metaData = isResultSet(shown) ? shown.metaData : (result.metaData ?? []);
      const readers = metaData.map(columnReader);
      const delivered: ServerMessage[] = [];
      return {
        columns: readers.map((reader) => reader.column),
        rows: this.#rows(shown, running, readers, fullBytes, messages, delivered),
        rowsAffected: null,
        messages: delivered,
      };
    } catch (cause) {
      this.#running = null;
      throw this.#failure(cause, running, text);
    }
  }

  /** `INSERT INTO t DEFAULT VALUES` as `INSERT INTO t (first) VALUES (DEFAULT)`, which Oracle accepts. */
  async #withoutDefaultValues(sql: string): Promise<string> {
    const match = DEFAULT_VALUES_INSERT.exec(sql);
    const written = match?.[1];
    if (written === undefined) return sql;
    const parts = storedParts(written);
    const name = parts.at(-1) ?? "";
    const owner = parts.length > 1 ? (parts[0] ?? null) : null;
    const result = await this.#connection.execute<unknown[]>(
      FIRST_COLUMN_SQL,
      { owner, name },
      { outFormat: oracledb.OUT_FORMAT_ARRAY },
    );
    const column = result.rows?.[0]?.[0];
    if (typeof column !== "string") return sql;
    return `INSERT INTO ${written} (${quoteIdentifier(column)}) VALUES (DEFAULT)`;
  }

  async currentNamespace(): Promise<readonly string[] | null> {
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    try {
      const schema = await firstValue(this.#connection, CURRENT_SCHEMA_SQL);
      return schema === null ? null : [schema];
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    }
  }

  async ping(): Promise<void> {
    const lost = this.#lostError("connectionLost");
    if (lost !== null) throw lost;
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    try {
      await this.#connection.ping();
    } catch (cause) {
      this.#broken ??= cause instanceof Error ? cause : new Error(String(cause));
      throw new PluginError("connectionLost", `The connection was lost: ${messageOf(cause)}`, { cause });
    }
  }

  async insertRows(target: InsertTarget, rows: readonly InsertRow[]): Promise<void> {
    const lost = this.#lostError("connectionFailed");
    if (lost !== null) throw lost;
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    if (rows.length === 0) return;
    if (this.#readOnly) throw new PluginError("statementFailed", READ_ONLY_REFUSED_MESSAGE);
    await this.#cancelling.catch(() => undefined);
    const running: Running = { cancelRequested: false };
    this.#running = running;
    const state = this.#transaction;
    const connection = this.#connection;
    const statement = insertStatement(
      target.table,
      target.columns.map((column) => importName(column.name)),
    );
    const binds = rows.map((row) => boundRow(row, target.columns));
    const inTransaction = state.open || state.mode === "manual";
    try {
      if (state.mode === "manual") state.open = true;
      // executeMany keeps the rows before a refused one, so the batch is undone to here by hand.
      if (inTransaction) await connection.execute(SAVEPOINT_SQL);
      try {
        await connection.executeMany(statement, binds, { autoCommit: false, bindDefs: bindDefsOf(binds) });
        if (!inTransaction) await connection.commit();
      } catch (cause) {
        if (connection.isHealthy()) {
          await (inTransaction ? connection.execute(ROLLBACK_TO_SQL) : connection.rollback()).catch(() => undefined);
        }
        throw cause;
      }
    } catch (cause) {
      if (!connection.isHealthy()) {
        this.#broken ??= cause instanceof Error ? cause : new Error(String(cause));
        throw new PluginError("connectionFailed", `The connection was lost: ${messageOf(cause)}`, { cause });
      }
      throw this.#failure(cause, running);
    } finally {
      this.#running = null;
    }
  }

  async explain(sql: string, options: ExplainOptions): Promise<ExplainedPlan> {
    const verdict = explainable(sql, options);
    if (!verdict.ok) throw new PluginError("explainUnsupported", verdict.reason);
    const lost = this.#lostError("connectionLost");
    if (lost !== null) throw lost;
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    const running: Running = { cancelRequested: false };
    this.#running = running;
    const text = serverText(sql);
    try {
      return options.analyze ? await this.#analyze(text, running) : await this.#plan(text);
    } catch (cause) {
      if (cause instanceof PluginError) throw cause;
      throw this.#failure(cause, running, text);
    } finally {
      this.#running = null;
    }
  }

  async #plan(sql: string): Promise<ExplainedPlan> {
    this.#explained += 1;
    const id = `table_craft_${String(this.#explained)}`;
    const statement = explainStatement(sql, id);
    const connection = this.#connection;
    await connection.execute(statement);
    try {
      const rows = await connection.execute<PlanRow>(PLAN_ROWS_SQL, { id }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const raw = await connection.execute<[string]>(PLAN_TEXT_SQL, { id }, { outFormat: oracledb.OUT_FORMAT_ARRAY });
      const messages = new MessageCollector();
      await drainOutput(connection, messages);
      return {
        statement,
        analyzed: false,
        roots: planTree(rows.rows ?? [], false),
        summary: [],
        raw: (raw.rows ?? []).map(([line]) => line).join("\n"),
        messages: messages.messages(),
      };
    } finally {
      await connection.execute(PLAN_CLEANUP_SQL, { id }).catch(() => undefined);
    }
  }

  /**
   * Runs the statement with every row source timed (`STATISTICS_LEVEL = ALL`), reads its cursor's
   * statistics, and leaves its changes in the transaction like any statement run from the console.
   */
  async #analyze(sql: string, running: Running): Promise<ExplainedPlan> {
    const connection = this.#connection;
    try {
      await connection.execute(ANALYZE_GRANT_PROBE_SQL);
    } catch (cause) {
      if ((cause as { errorNum?: number }).errorNum !== NO_VIEW) throw cause;
      const user = (await firstValue(connection, SESSION_USER_SQL)) ?? this.#config.user;
      throw new PluginError("explainUnsupported", analyzeGrantHint(user), { cause });
    }
    const effect = oracleTransactionEffect(sql);
    const state = this.#transaction;
    if (state.mode === "manual" && effect === null) state.open = true;
    await connection.execute(STATISTICS_ON_SQL);
    let cursor: { sqlId: string; child: number } | undefined;
    try {
      const result = await connection.execute<unknown[]>(sql, [], {
        autoCommit: this.#autoCommit(),
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        fetchTypeHandler,
      });
      if (result.resultSet !== undefined) {
        while ((await result.resultSet.getRows(FETCH_ROWS)).length > 0 && !running.cancelRequested);
        await result.resultSet.close();
      }
      const last = await connection.execute<{ sqlId: string; child: number }>(LAST_CURSOR_SQL, [], {
        outFormat: oracledb.OUT_FORMAT_OBJECT,
      });
      cursor = last.rows?.[0];
    } finally {
      await connection.execute(STATISTICS_OFF_SQL).catch(() => undefined);
    }
    const binds = { sqlId: cursor?.sqlId ?? "", child: cursor?.child ?? 0 };
    const rows = await connection.execute<PlanRow>(ANALYZED_ROWS_SQL, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
    const raw = await connection.execute<[string]>(ANALYZED_TEXT_SQL, binds, { outFormat: oracledb.OUT_FORMAT_ARRAY });
    const messages = new MessageCollector();
    await drainOutput(connection, messages);
    return {
      statement: `EXPLAIN PLAN /* analysed: STATISTICS_LEVEL = ALL */ FOR ${sql}`,
      analyzed: true,
      roots: planTree(rows.rows ?? [], true),
      summary: [],
      raw: (raw.rows ?? []).map(([line]) => line).join("\n"),
      messages: messages.messages(),
    };
  }

  async *#rows(
    source: oracledb.ResultSet<unknown[]> | unknown[][],
    running: Running,
    readers: readonly ColumnReader[],
    fullBytes: boolean,
    messages: MessageCollector,
    delivered: ServerMessage[],
  ): AsyncGenerator<Row, void, undefined> {
    let completed = false;
    try {
      if (Array.isArray(source)) {
        for (const values of source) yield wireRow(values, readers, fullBytes);
      } else {
        for (;;) {
          let batch: unknown[][];
          try {
            batch = await source.getRows(FETCH_ROWS);
          } catch (cause) {
            throw this.#failure(cause, running);
          }
          if (batch.length === 0) break;
          for (const values of batch) yield wireRow(values, readers, fullBytes);
        }
      }
      completed = true;
    } finally {
      if (!Array.isArray(source)) await source.close().catch(() => undefined);
      if (completed && this.#broken === null) {
        await drainOutput(this.#connection, messages).catch(() => undefined);
        delivered.push(...messages.messages());
      }
      this.#running = null;
    }
  }

  #failure(cause: unknown, running: Running, sql?: string): PluginError {
    if (cause instanceof PluginError) return cause;
    if (!this.#connection.isHealthy()) {
      this.#broken ??= cause instanceof Error ? cause : new Error(String(cause));
      return new PluginError("connectionLost", `The connection was lost: ${messageOf(cause)}`, { cause });
    }
    if (running.cancelRequested || (cause as { errorNum?: number }).errorNum === USER_CANCELLED) {
      return new PluginError("cancelled", CANCELLED_MESSAGE, { cause });
    }
    const position = sql === undefined ? undefined : serverErrorPosition(sql, cause);
    return new PluginError("statementFailed", messageOf(cause), { cause, position });
  }

  cancel(): Promise<void> {
    const running = this.#running;
    if (running === null) return Promise.resolve();
    running.cancelRequested = true;
    this.#cancelling = this.#cancelOnServer().catch(() => this.#connection.break());
    return this.#cancelling;
  }

  /**
   * `break()` alone is not enough: its marker is only read when the server next talks to the
   * client, so a statement that waits (DBMS_SESSION.SLEEP, a lock) runs to its end. A second
   * connection's `ALTER SYSTEM CANCEL SQL` stops it at once; `break()` is the fallback for an
   * account without the ALTER SYSTEM privilege.
   */
  async #cancelOnServer(): Promise<void> {
    const other = await openConnection(this.#config, {});
    try {
      await other.execute(cancelStatement(this.serverSessionId, null));
    } finally {
      await other.close().catch(() => undefined);
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
      await this.#connection.execute(sql);
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    } finally {
      this.#transaction.open = false;
    }
  }

  async close(): Promise<void> {
    await this.#cancelling.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceful = this.#connection.close().then(
      () => true,
      () => true,
    );
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
    });
    await Promise.race([graceful, expired]);
    clearTimeout(timer);
  }
}

/** Explicit bind types, so a batch whose first row holds nulls still binds its later values. */
function bindDefsOf(rows: readonly (readonly (string | Buffer | null)[])[]): oracledb.BindDefinition[] {
  const width = rows[0]?.length ?? 0;
  return Array.from({ length: width }, (_, index) => {
    let bytes = false;
    let maxSize = 1;
    for (const row of rows) {
      const value = row[index];
      if (value === null || value === undefined) continue;
      if (typeof value !== "string") bytes = true;
      maxSize = Math.max(maxSize, typeof value === "string" ? Buffer.byteLength(value) : value.length);
    }
    if (maxSize > MAX_INLINE_BIND_BYTES) return { type: bytes ? oracledb.DB_TYPE_BLOB : oracledb.DB_TYPE_CLOB };
    return { type: bytes ? oracledb.DB_TYPE_RAW : oracledb.DB_TYPE_VARCHAR, maxSize };
  });
}

const plugin: DatasourcePlugin = {
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  language,
  connectionSchema,
  connect: (config, options) => OracleSession.open(connectionSchema.parse(config), options),
};

export default plugin;
