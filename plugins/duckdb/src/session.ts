import type { DuckDBConnection, DuckDBDataChunk, DuckDBResult, DuckDBValueConverter, Json } from "@duckdb/node-api";
import {
  PluginError,
  type CancelReach,
  type ExecuteOptions,
  type ExecuteResult,
  type ExplainedPlan,
  type ExplainOptions,
  type InsertRow,
  type InsertTarget,
  type ParameterValue,
  type PluginSession,
  type Row,
  type TransactionMode,
  type Transactions,
} from "@table-craft/plugin-api";
import { transactionEffect } from "@table-craft/plugin-api/sql";
import type { DuckdbDriver } from "./driver.js";
import { duckdbErrorPosition } from "./errorPosition.js";
import { explainStatement, readPlanRows } from "./explain.js";
import { messageOf } from "./failures.js";
import { duckdbIntrospector } from "./introspect.js";
import { DIALECT, language, quoteIdentifier, type DuckdbCapability } from "./language.js";
import { zonedText, type ZonedText } from "./timeZone.js";
import { columnFor, rowsOf, type ColumnType } from "./values.js";

const CANCEL_REACH: CancelReach = { method: "duckdb_interrupt", reaches: "statement" };
/** DuckDB clears an interrupt when the next task starts, so one sent between tasks is lost; TablePro resends too. */
const CANCEL_RESEND_MS = 10;
/** Rows per `INSERT` of `insertRows`; DuckDB has no parameter limit, this bounds one statement's text. */
export const ROWS_PER_INSERT = 1000;

const BEGIN_SQL = "BEGIN TRANSACTION";
const BEGIN_READ_ONLY_SQL = "BEGIN TRANSACTION READ ONLY";
const COMMIT_SQL = "COMMIT";
const ROLLBACK_SQL = "ROLLBACK";

const BUSY_MESSAGE = "Another statement is still running in this session.";
const CANCELLED_MESSAGE = "The statement was cancelled.";
const OPEN_TRANSACTION_MESSAGE = "A transaction is open; commit or roll it back before switching to auto-commit.";
const ABORTED_INSERT_MESSAGE =
  "The import failed inside your open transaction, which DuckDB has aborted; roll it back and import again.";
/** What DuckDB says when `interrupt()` stopped a statement. */
const INTERRUPTED = /^INTERRUPT Error/u;
/** `ResultReturnType` values, copied for the reason `TYPE_ID` is (`values.ts`). */
const CHANGED_ROWS = 1;
const QUERY_RESULT = 3;
/** `StatementType.SET`: `SET` and `RESET`, after which the session's time zone may differ. */
const SET_STATEMENT = 20;
const TIME_ZONE_SQL = "SELECT current_setting('TimeZone') AS time_zone";
/** How the exporter writes bytes (`cellText`): `0x` and hex, which DuckDB reads back as `\x` pairs. */
const EXPORTED_BYTES = /^0x((?:[0-9a-fA-F]{2})*)$/u;
const BLOB_TYPE = /^BLOB$/iu;

const NO_ROWS: AsyncIterable<Row> = {
  [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true, value: undefined }) }),
};

/** What a session needs from the instance it was opened on. */
export interface SessionParts {
  readonly driver: DuckdbDriver;
  readonly connection: DuckDBConnection;
  /** A second connection for the schema tree and DDL, so they never wait on an open result. */
  readonly metadata: DuckDBConnection;
  readonly readOnly: boolean;
  readonly privateDatabase: boolean;
  readonly serverVersion: string;
  readonly openedDatabase: string;
  /** The connection's `TimeZone` setting when it opened. */
  readonly timeZone: string;
  /** Closes the instance's share this session holds, after both connections closed. */
  readonly release: () => void;
}

/** The statement running now, and the result whose rows are still being read. */
interface Running {
  cancelRequested: boolean;
  inFlight: number;
}

interface OpenResult {
  readonly result: DuckDBResult;
  /** Closes the result, then ends the read-only wrapper transaction if the statement has one. */
  readonly finish: (failed: boolean) => Promise<void>;
}

/** The exporter's `0x…` back into the `\x…` text DuckDB casts to a BLOB. */
export function boundValue(value: ParameterValue, type: string | null): ParameterValue {
  if (value === null || type === null || !BLOB_TYPE.test(type)) return value;
  const hex = EXPORTED_BYTES.exec(value);
  return hex === null ? value : (hex[1] ?? "").replace(/../gu, "\\x$&");
}

/** One multi-row `INSERT` of `insertRows`, with its placeholders per row. */
interface InsertBatch {
  readonly sql: string;
  readonly values: ParameterValue[];
  readonly tuples: readonly (readonly string[])[];
}

function insertBatches(target: InsertTarget, rows: readonly InsertRow[]): InsertBatch[] {
  const columns = target.columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const batches: InsertBatch[] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    const values: ParameterValue[] = [];
    const tuples = rows.slice(start, start + ROWS_PER_INSERT).map((row) =>
      row.map((value, index) => {
        values.push(boundValue(value, target.columns[index]?.type ?? null));
        return `$${String(values.length)}`;
      }),
    );
    const sql = `INSERT INTO ${target.table} (${columns}) VALUES ${tuples.map((tuple) => `(${tuple.join(", ")})`).join(", ")}`;
    batches.push({ sql, values, tuples });
  }
  return batches;
}

export class DuckdbSession implements PluginSession<DuckdbCapability> {
  readonly serverVersion: string;
  readonly privateDatabase: boolean;
  readonly services;

  readonly #parts: SessionParts;
  readonly #json: DuckDBValueConverter<Json>;
  #zoned: ZonedText;
  #mode: TransactionMode = "auto";
  #open = false;
  #running: Running | null = null;
  #current: OpenResult | null = null;
  #closed = false;

  constructor(parts: SessionParts) {
    this.#parts = parts;
    this.#json = parts.driver.JsonDuckDBValueConverter;
    this.#zoned = this.#zonedIn(parts.timeZone);
    this.serverVersion = parts.serverVersion;
    this.privateDatabase = parts.privateDatabase;
    const catalog = duckdbIntrospector(
      async (sql, params = []) => (await parts.metadata.runAndReadAll(sql, [...params])).getRowObjectsJson(),
      {
        quoteIdentifier,
        literal: (text) => language.literal(text, null),
        openedDatabase: parts.openedDatabase,
      },
    );
    const own = (): DuckdbSession => this;
    const transactions: Transactions = {
      setMode: (mode) => this.#setMode(mode),
      commit: () => this.#endTransaction(COMMIT_SQL),
      rollback: () => this.#endTransaction(ROLLBACK_SQL),
      get mode() {
        return own().#mode;
      },
      get open() {
        return own().#open;
      },
    };
    this.services = {
      cancel: { cancel: () => this.#cancel(), reach: CANCEL_REACH },
      schemaTree: catalog,
      ddl: catalog,
      transactions,
      explain: { explain: (sql: string, options: ExplainOptions) => this.#explain(sql, options) },
      bulkInsert: { insertRows: (target: InsertTarget, rows: readonly InsertRow[]) => this.#insertRows(target, rows) },
    } as const;
  }

  async execute(
    sql: string,
    params: readonly ParameterValue[] = [],
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    const running: Running = { cancelRequested: false, inFlight: 0 };
    this.#running = running;
    const effect = transactionEffect(sql, DIALECT);
    let wrapped = false;
    try {
      await this.#settleCurrent();
      if (effect === null && !this.#open) {
        if (this.#mode === "manual") {
          await this.#run(this.#parts.readOnly ? BEGIN_READ_ONLY_SQL : BEGIN_SQL);
          this.#open = true;
        } else if (this.#parts.readOnly) {
          await this.#run(BEGIN_READ_ONLY_SQL);
          wrapped = true;
        }
      }
      return await this.#stream(sql, params, options, running, effect, wrapped);
    } catch (cause) {
      if (wrapped) await this.#quietly(ROLLBACK_SQL);
      // A failed COMMIT or ROLLBACK still ends the transaction in DuckDB.
      if (effect === "end") this.#open = false;
      this.#running = null;
      throw this.#failure(cause, running, sql);
    }
  }

  async #stream(
    sql: string,
    params: readonly ParameterValue[],
    options: ExecuteOptions,
    running: Running,
    effect: ReturnType<typeof transactionEffect>,
    wrapped: boolean,
  ): Promise<ExecuteResult> {
    const result = await this.#inFlight(running, () =>
      this.#parts.connection.stream(sql, params.length === 0 ? undefined : [...params]),
    );
    if (effect === "begin") this.#open = true;
    if (effect === "end") this.#open = false;
    const finish = async (failed: boolean): Promise<void> => {
      result.closeSync();
      if (this.#current?.result === result) this.#current = null;
      if (this.#running === running) this.#running = null;
      if (wrapped) await this.#run(failed ? ROLLBACK_SQL : COMMIT_SQL);
    };
    const returnType: number = result.returnType;
    if (returnType !== QUERY_RESULT) {
      const rowsAffected = returnType === CHANGED_ROWS ? Number(result.rowsChanged) : null;
      await finish(false);
      const statementType: number = result.statementType;
      if (statementType === SET_STATEMENT) await this.#readTimeZone();
      return { columns: [], rows: NO_ROWS, rowsAffected };
    }
    const types: ColumnType[] = [];
    const columns = result.columnNames().map((name, index) => {
      const type = result.columnType(index);
      types.push(type);
      return columnFor(name, type);
    });
    let first: DuckDBDataChunk | null;
    try {
      first = await this.#inFlight(running, () => result.fetchChunk());
    } catch (cause) {
      await finish(true).catch(() => undefined);
      throw cause;
    }
    this.#running = null;
    this.#current = { result, finish };
    const fullBytes = options.fullBytes === true;
    const zoned = this.#zoned;
    const read = (chunk: DuckDBDataChunk): Row[] => rowsOf(chunk, types, this.#json, fullBytes, zoned);
    const fetch = (): Promise<DuckDBDataChunk | null> => this.#inFlight(running, () => result.fetchChunk());
    const failure = (cause: unknown): PluginError => this.#failure(cause, running, sql);
    async function* rows(): AsyncGenerator<Row> {
      let failed = false;
      try {
        for (let chunk = first; chunk !== null && chunk.rowCount > 0; chunk = await fetch()) {
          yield* read(chunk);
          first = null;
        }
      } catch (cause) {
        failed = true;
        throw failure(cause);
      } finally {
        await finish(failed);
      }
    }
    return { columns, rows: rows(), rowsAffected: null };
  }

  /** Runs `work` as the statement `cancel` may interrupt. */
  async #inFlight<T>(running: Running, work: () => Promise<T>): Promise<T> {
    if (running.cancelRequested) throw new PluginError("cancelled", CANCELLED_MESSAGE);
    running.inFlight += 1;
    try {
      return await work();
    } finally {
      running.inFlight -= 1;
    }
  }

  #zonedIn(timeZone: string): ZonedText {
    const { DuckDBTimestampValue } = this.#parts.driver;
    return zonedText(timeZone, (micros) => String(new DuckDBTimestampValue(micros)));
  }

  /** Follows a `SET TimeZone`; keeps the zone it had when the transaction cannot answer. */
  async #readTimeZone(): Promise<void> {
    try {
      const row = (await this.#parts.connection.runAndReadAll(TIME_ZONE_SQL)).getRowObjectsJson()[0];
      if (typeof row?.time_zone === "string") this.#zoned = this.#zonedIn(row.time_zone);
    } catch {
      // An aborted transaction refuses every statement but ROLLBACK.
    }
  }

  async #run(sql: string): Promise<void> {
    (await this.#parts.connection.run(sql)).closeSync();
  }

  async #quietly(sql: string): Promise<void> {
    await this.#run(sql).catch(() => undefined);
  }

  /** The previous statement's rows, abandoned unread: DuckDB refuses a new query while they are open. */
  async #settleCurrent(): Promise<void> {
    const current = this.#current;
    if (current === null) return;
    this.#current = null;
    await current.finish(false);
  }

  #failure(cause: unknown, running: Running, sql?: string): PluginError {
    if (cause instanceof PluginError) return cause;
    const message = messageOf(cause);
    if (running.cancelRequested && INTERRUPTED.test(message)) {
      return new PluginError("cancelled", CANCELLED_MESSAGE, { cause });
    }
    const position = sql === undefined ? undefined : duckdbErrorPosition(sql, message);
    return new PluginError("statementFailed", message, { cause, position });
  }

  async #cancel(): Promise<void> {
    const running = this.#running;
    if (running === null) return;
    running.cancelRequested = true;
    while (this.#running === running) {
      if (running.inFlight > 0) this.#parts.connection.interrupt();
      await new Promise((resolve) => setTimeout(resolve, CANCEL_RESEND_MS));
    }
  }

  async #setMode(mode: TransactionMode): Promise<void> {
    if (mode === "auto" && this.#open) throw new PluginError("statementFailed", OPEN_TRANSACTION_MESSAGE);
    this.#mode = mode;
    return Promise.resolve();
  }

  async #endTransaction(sql: string): Promise<void> {
    if (!this.#open) return;
    await this.#settleCurrent();
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    try {
      await this.#run(sql);
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    } finally {
      this.#open = false;
    }
  }

  async #explain(sql: string, options: ExplainOptions): Promise<ExplainedPlan> {
    const verdict = language.services.explain.explainable(sql, options);
    if (!verdict.ok) throw new PluginError("explainUnsupported", verdict.reason);
    const statement = explainStatement(sql, options.analyze);
    const result = await this.execute(statement);
    const rows: Row[] = [];
    for await (const row of result.rows) rows.push(row);
    return readPlanRows(rows, statement, options.analyze);
  }

  async #insertRows(target: InsertTarget, rows: readonly InsertRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#settleCurrent();
    if (this.#running !== null) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    if (this.#mode === "manual" && !this.#open) {
      await this.#run(this.#parts.readOnly ? BEGIN_READ_ONLY_SQL : BEGIN_SQL);
      this.#open = true;
    }
    const joined = this.#open;
    const batches = insertBatches(target, rows);
    if (joined) {
      for (const batch of batches) await this.#checkCasts(target, batch);
    }
    try {
      if (!joined) await this.#run(BEGIN_SQL);
      for (const batch of batches) (await this.#parts.connection.run(batch.sql, batch.values)).closeSync();
      if (!joined) await this.#run(COMMIT_SQL);
    } catch (cause) {
      if (!joined) {
        await this.#quietly(ROLLBACK_SQL);
        throw new PluginError("statementFailed", messageOf(cause), { cause });
      }
      throw new PluginError("statementFailed", `${messageOf(cause)}\n${ABORTED_INSERT_MESSAGE}`, { cause });
    }
  }

  /**
   * Any failed statement aborts a DuckDB transaction, and DuckDB has no savepoint to fall back to.
   * Inside the user's transaction the batch's values are first cast on the metadata connection,
   * outside it, so a value the column cannot take refuses the batch and leaves the transaction
   * usable. A constraint the batch breaks still aborts it.
   */
  async #checkCasts(target: InsertTarget, batch: InsertBatch): Promise<void> {
    const names = target.columns.map((_, index) => `c${String(index)}`);
    const casts = target.columns.map((column, index) =>
      column.type === null ? names[index] : `CAST(${names[index] ?? ""} AS ${column.type})`,
    );
    const tuples = batch.tuples.map(
      (tuple) => `(${tuple.map((placeholder) => `CAST(${placeholder} AS VARCHAR)`).join(", ")})`,
    );
    const sql = `SELECT ${casts.join(", ")} FROM (VALUES ${tuples.join(", ")}) AS v(${names.join(", ")})`;
    try {
      await this.#parts.metadata.runAndReadAll(sql, batch.values);
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#running !== null) this.#parts.connection.interrupt();
    await this.#settleCurrent().catch(() => undefined);
    this.#parts.connection.closeSync();
    this.#parts.metadata.closeSync();
    this.#parts.release();
  }
}
