import { Request, TYPES, type Connection } from "tedious";
import type { ColumnMetadata } from "tedious/lib/token/colmetadata-token-parser.js";
import type { ServerMessage } from "@table-craft/plugin-api";
import { infoMessage, MessageCollector, type InfoMessage } from "./messages.js";

/** Rows read ahead of the console before the plugin stops reading the socket (decision 125). */
export const FETCH_ROWS = 500;
/** tedious's code for a request the client cancelled. */
const CANCELLED_CODE = "ECANCEL";

interface RowColumn {
  readonly value: unknown;
}

export interface Settled {
  readonly error: Error | null;
  /** Null when no statement of the batch reported a count. */
  readonly rowsAffected: number | null;
  /** Result sets after the first, whose rows the batch read and dropped. */
  readonly moreResultSets: number;
  readonly messages: ServerMessage[];
}

export function isCancelled(cause: unknown): boolean {
  return (cause as { code?: unknown } | null)?.code === CANCELLED_CODE;
}

/** The error to report from what a request failed with: several errors arrive as an `AggregateError`. */
export function firstError(cause: unknown): Error {
  const first: unknown = cause instanceof AggregateError && cause.errors.length > 0 ? cause.errors[0] : cause;
  return first instanceof Error ? first : new Error(String(first));
}

/**
 * One request on the connection: a batch, or with parameters a call of `sp_executesql`. Its first
 * result set streams, read ahead by at most `FETCH_ROWS` rows; every later one is read and dropped
 * and only counted (decision 125), since a console result shows one set.
 */
export class Batch {
  readonly #connection: Connection;
  readonly #request: Request;
  readonly #messages = new MessageCollector();
  readonly #onInfo = (info: InfoMessage): void => this.#messages.add(infoMessage(info));
  readonly #buffer: unknown[][] = [];
  #sets = 0;
  #rowsAffected: number | null = null;
  #paused = false;
  #settled: Settled | null = null;
  #wake: (() => void) | null = null;
  #columns: ((metadata: ColumnMetadata[] | null) => void) | null = null;
  readonly settled: Promise<Settled>;
  /** The first result set's columns, or null when the batch returned none. */
  readonly columns: Promise<ColumnMetadata[] | null>;

  constructor(connection: Connection, sql: string, params: readonly (string | null)[]) {
    this.#connection = connection;
    let settle: (settled: Settled) => void = () => undefined;
    this.settled = new Promise((resolve) => (settle = resolve));
    this.columns = new Promise((resolve) => (this.#columns = resolve));
    this.#request = new Request(sql, (error) => {
      connection.removeListener("infoMessage", this.#onInfo);
      this.#settled = {
        error: error ?? null,
        rowsAffected: this.#rowsAffected,
        moreResultSets: Math.max(0, this.#sets - 1),
        messages: this.#messages.messages(),
      };
      this.#columns?.(null);
      settle(this.#settled);
      this.#notify();
    });
    params.forEach((value, index) => this.#request.addParameter(`p${String(index + 1)}`, TYPES.NVarChar, value));
    this.#request.on("columnMetadata", (columns) => {
      this.#sets += 1;
      if (this.#sets === 1) this.#columns?.(Array.isArray(columns) ? columns : Object.values(columns));
    });
    this.#request.on("row", (columns: RowColumn[]) => {
      if (this.#sets !== 1) return;
      this.#buffer.push(columns.map((column) => column.value));
      if (this.#buffer.length >= FETCH_ROWS && !this.#paused) {
        this.#paused = true;
        this.#request.pause();
      }
      this.#notify();
    });
    const counted = (rowCount: number | undefined): void => {
      if (rowCount !== undefined && this.#sets === 0) this.#rowsAffected = (this.#rowsAffected ?? 0) + rowCount;
    };
    this.#request.on("done", counted);
    this.#request.on("doneInProc", counted);
    this.#request.on("doneProc", counted);
    connection.on("infoMessage", this.#onInfo);
    if (params.length === 0) connection.execSqlBatch(this.#request);
    else connection.execSql(this.#request);
  }

  get done(): boolean {
    return this.#settled !== null;
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }

  /** The first result set's rows as tedious read them; throws what the batch failed with. */
  async *rows(): AsyncGenerator<unknown[]> {
    for (;;) {
      const row = this.#buffer.shift();
      if (row !== undefined) {
        if (this.#paused && this.#buffer.length < FETCH_ROWS / 2) {
          this.#paused = false;
          this.#request.resume();
        }
        yield row;
        continue;
      }
      if (this.#settled !== null) {
        if (this.#settled.error !== null) throw this.#settled.error;
        return;
      }
      await new Promise<void>((resolve) => (this.#wake = resolve));
    }
  }

  /** Stops the batch: the server drops what is left, and the request settles as cancelled. */
  async stop(): Promise<void> {
    if (this.#settled === null) {
      this.#buffer.length = 0;
      this.#connection.cancel();
      if (this.#paused) {
        this.#paused = false;
        this.#request.resume();
      }
    }
    await this.settled;
  }

  /** Every row of the first result set, then the batch's outcome. */
  async drain(): Promise<{ rows: unknown[][]; settled: Settled }> {
    const rows: unknown[][] = [];
    for await (const row of this.rows()) rows.push(row);
    return { rows, settled: await this.settled };
  }
}

/** One result set read whole, for the plugin's own queries. */
export interface ReadSet {
  readonly columns: readonly ColumnMetadata[];
  readonly rows: readonly unknown[][];
}

/**
 * Every result set of a request, read whole; for queries the plugin writes itself (the catalog,
 * plans, sessions), whose results are small. Rejects with what the request failed with.
 */
export function readAll(
  connection: Connection,
  sql: string,
  params: readonly (string | null)[] = [],
): Promise<ReadSet[]> {
  return new Promise((resolve, reject) => {
    const sets: { columns: ColumnMetadata[]; rows: unknown[][] }[] = [];
    const request = new Request(sql, (error) => (error ? reject(firstError(error)) : resolve(sets)));
    params.forEach((value, index) => request.addParameter(`p${String(index + 1)}`, TYPES.NVarChar, value));
    request.on("columnMetadata", (columns) =>
      sets.push({ columns: Array.isArray(columns) ? columns : Object.values(columns), rows: [] }),
    );
    request.on("row", (columns: RowColumn[]) => sets.at(-1)?.rows.push(columns.map((column) => column.value)));
    if (params.length === 0) connection.execSqlBatch(request);
    else connection.execSql(request);
  });
}

/** The first result set as objects keyed by column name. */
export async function readRecords<T>(
  connection: Connection,
  sql: string,
  params: readonly (string | null)[] = [],
): Promise<T[]> {
  const [first] = await readAll(connection, sql, params);
  if (first === undefined) return [];
  return first.rows.map(
    (row) => Object.fromEntries(first.columns.map((column, index) => [column.colName, row[index]])) as T,
  );
}
