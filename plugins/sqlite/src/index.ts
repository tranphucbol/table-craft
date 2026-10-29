import { DatabaseSync, type StatementColumnMetadata } from "node:sqlite";
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
  type PluginErrorCode,
  type Row,
  type Session,
  type SqlLanguage,
  type TransactionMode,
  type Transactions,
  type WireValue,
} from "@table-craft/plugin-api";
import {
  classifyTokens,
  defaultValuesInsert,
  identifierWriter,
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
import { SQLITE_RESERVED_WORDS } from "./reserved.js";
import { sqliteErrorPosition } from "./errorPosition.js";
import { SQLITE_FUNCTIONS } from "./functions.js";
import { EXPLAIN_VERBS, explainStatement, readPlanRows } from "./explain.js";
import { sqliteIntrospector } from "./introspect.js";
import { sqliteObjects } from "./objects.js";

const PLUGIN_ID = "sqlite";
/** No `cancel`: node:sqlite runs a statement synchronously, so nothing could deliver the request. */
const CAPABILITIES: readonly Capability[] = [
  "sql",
  "schemaTree",
  "transactions",
  "ddl",
  "explain",
  "bulkInsert",
  "objects",
];

/** Trigger bodies are `BEGIN … END` and hold semicolons. */
const DIALECT: SqlDialectOptions = { blockKeywords: ["BEGIN"] };

const PARAMETERS: ParameterOptions = { dialect: DIALECT, styles: ["named", "positional"], native: "positional" };

const LITERALS: SqlLiteralOptions = { backslashEscapes: false, bytes: (hex) => `X'${hex}'` };

const quoteIdentifier = quoteIdentifierWith('"');
/** SQLite has no `DEFAULT` inside `SET`; `dflt_value` is the declared expression, valid SQL as written. */
const updateDefault = (expression: string | null): string => expression ?? "NULL";

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const KEYWORDS: readonly string[] = [...SQL_KEYWORDS, "GLOB", "PRAGMA"];

/** No `explainAnalyze`: SQLite's `EXPLAIN QUERY PLAN` only plans, and nothing else reports run times. */
const { explainable } = sqlExplainable({ dialect: DIALECT, name: "SQLite", verbs: EXPLAIN_VERBS, analyzeVerbs: [] });

const COMPLETER: CompleterOptions = {
  dialect: DIALECT,
  identifierFolding: "none",
  plainIdentifier: PLAIN_IDENTIFIER,
  quoteIdentifier,
  keywords: KEYWORDS,
  functions: SQLITE_FUNCTIONS,
};

const language: SqlLanguage = {
  split: sqlSplitter(DIALECT),
  splitStream: sqlStatementStream(DIALECT),
  classify: (sql) => classifyTokens(sql, DIALECT),
  quoteIdentifier,
  literal: (value) => sqlLiteral(value, LITERALS),
  emptyInsert: defaultValuesInsert,
  updateDefault,
  savepoint: sqlSavepoints(quoteIdentifier),
  ...sqlCompleter(COMPLETER),
  ...sqlInspector({ ...COMPLETER, reservedWords: SQLITE_RESERVED_WORDS }),
  ...sqlGenerator({ quoteIdentifier, updateDefault, plainIdentifier: PLAIN_IDENTIFIER, keywords: KEYWORDS }),
  explainable,
  ...sqlFormatter({ dialect: "sqlite", lexer: DIALECT, parameters: PARAMETERS.styles }),
  ...sqlParameters(PARAMETERS),
  ...sqlImporter({
    quoteIdentifier,
    plainIdentifier: PLAIN_IDENTIFIER,
    keywords: KEYWORDS,
    types: {
      boolean: "BOOLEAN",
      integer: "INTEGER",
      bigint: "INTEGER",
      double: "REAL",
      date: "DATE",
      timestamp: "TIMESTAMP",
      text: "TEXT",
    },
    // NUMERIC keeps text it cannot hold exactly, such as more than 15 significant digits, as text.
    decimal: () => "NUMERIC",
  }),
  objects: sqliteObjects({
    name: identifierWriter({ quoteIdentifier, plainIdentifier: PLAIN_IDENTIFIER, keywords: KEYWORDS }),
  }),
};

const BEGIN_SQL = "BEGIN";
const COMMIT_SQL = "COMMIT";
const ROLLBACK_SQL = "ROLLBACK";
/** Each batch of an import is atomic inside the import's transaction (decision 046). */
const SAVEPOINT_SQL = "SAVEPOINT table_craft_insert";
const RELEASE_SQL = "RELEASE SAVEPOINT table_craft_insert";
const ROLLBACK_TO_SQL = "ROLLBACK TO SAVEPOINT table_craft_insert";
/** SQLITE_MAX_VARIABLE_NUMBER since 3.32. */
const MAX_PARAMETERS = 32_766;
/** How the exporter writes bytes (`cellText`): `0x` and hex. */
const EXPORTED_BYTES = /^0x([0-9a-fA-F]*)$/u;
const BLOB_DECLARATION = /BLOB/iu;
const BOOLEAN_TEXT: ReadonlyMap<string, number> = new Map([
  ["true", 1],
  ["false", 0],
]);
const OPEN_TRANSACTION_MESSAGE = "A transaction is open; commit or roll it back before switching to auto-commit.";

const connectionSchema = z.strictObject({
  /** A file path, or `:memory:` for a private in-memory database. */
  path: z.string().min(1),
});

type SqliteConfig = z.infer<typeof connectionSchema>;

/**
 * SQLite stores booleans as integers and JSON as text; the declared column type is the only
 * place the intent survives, so it decides the wire value (decision 017).
 */
const BOOLEAN_DECLARATION = /^BOOL(EAN)?$/i;
const JSON_DECLARATION = /^JSONB?$/i;

type Cell = (value: unknown) => WireValue;

type Bound = string | number | Uint8Array | null;

/** What the exporter wrote, as the declared type wants it: bytes for `0x…` in a BLOB, 1/0 for a BOOLEAN's text. */
function bound(value: string | null, declared: string | null): Bound {
  if (value === null || declared === null) return value;
  if (BLOB_DECLARATION.test(declared)) {
    const hex = EXPORTED_BYTES.exec(value);
    if (hex !== null) return Buffer.from(hex[1] ?? "", "hex");
  }
  if (BOOLEAN_DECLARATION.test(declared)) return BOOLEAN_TEXT.get(value.toLowerCase()) ?? value;
  return value;
}

function plainCell(value: unknown): WireValue {
  return typeof value === "bigint" ? toWireInteger(value) : toWireValue(value);
}

function wholeCell(value: unknown): WireValue {
  return typeof value === "bigint" ? toWireInteger(value) : toWireValue(value, { fullBytes: true });
}

function cellFor(column: Column, options: ExecuteOptions): Cell {
  const plain = options.fullBytes === true ? wholeCell : plainCell;
  const declared = column.type ?? "";
  if (BOOLEAN_DECLARATION.test(declared)) {
    return (value) => (value === 0n || value === 1n ? value === 1n : plain(value));
  }
  if (JSON_DECLARATION.test(declared)) {
    return (value) => (typeof value === "string" ? { kind: "json", text: value } : plain(value));
  }
  return plain;
}

/** node:sqlite is synchronous; this turns a throw into a rejection coded as the contract expects. */
// eslint-disable-next-line @typescript-eslint/require-await -- async is what turns the throw into a rejection
async function settle<T>(code: PluginErrorCode, work: () => T, sql?: string): Promise<T> {
  try {
    return work();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const position = sql === undefined ? undefined : sqliteErrorPosition(sql, message);
    throw new PluginError(code, message, { cause, position });
  }
}

function readRows(rows: Iterator<unknown>, cells: readonly Cell[]): AsyncIterable<Row> {
  const iterator: AsyncIterator<Row> = {
    next: () =>
      settle("statementFailed", (): IteratorResult<Row> => {
        const next = rows.next();
        if (next.done === true) return { done: true, value: undefined };
        const values = next.value as unknown[];
        return { done: false, value: values.map((value, index) => (cells[index] ?? plainCell)(value)) };
      }),
    return: () =>
      settle("statementFailed", (): IteratorResult<Row> => {
        rows.return?.();
        return { done: true, value: undefined };
      }),
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

const VERSION_SQL = "SELECT sqlite_version() AS version";
/** SQLite's name for a database private to its connection; an empty path makes a private temporary one. */
const MEMORY_PATH = ":memory:";

/** Refuses every write on this connection, temporary tables included. */
const READ_ONLY_SQL = "PRAGMA query_only = ON";

/**
 * SQLite reports whether a transaction is open (`isTransaction`), so `open` is read, not tracked.
 * Everything runs synchronously, so every method has settled before it returns.
 */
class SqliteSession implements Session {
  readonly #database: DatabaseSync;
  #mode: TransactionMode = "auto";
  readonly serverVersion: string | null;
  /** The manifest's one brand. */
  readonly serverBrand = "sqlite";
  readonly privateDatabase: boolean;
  readonly introspector: Introspector;
  readonly transactions: Transactions;

  constructor(config: SqliteConfig, options: ConnectOptions) {
    this.#database = new DatabaseSync(config.path);
    this.privateDatabase = config.path === MEMORY_PATH || config.path === "";
    this.introspector = sqliteIntrospector(this.#database);
    const database = this.#database;
    const mode = (): TransactionMode => this.#mode;
    this.transactions = {
      setMode: (next) =>
        settle("statementFailed", () => {
          if (next === "auto" && database.isTransaction) throw new Error(OPEN_TRANSACTION_MESSAGE);
          this.#mode = next;
        }),
      commit: () => this.#end(COMMIT_SQL),
      rollback: () => this.#end(ROLLBACK_SQL),
      get mode() {
        return mode();
      },
      get open() {
        return database.isOpen && database.isTransaction;
      },
    };
    if (options.readOnly) this.#database.exec(READ_ONLY_SQL);
    const row = this.#database.prepare(VERSION_SQL).get();
    this.serverVersion = typeof row?.version === "string" ? row.version : null;
  }

  execute(sql: string, params: readonly ParameterValue[] = [], options: ExecuteOptions = {}): Promise<ExecuteResult> {
    return settle(
      "statementFailed",
      () => {
        const database = this.#database;
        if (this.#mode === "manual" && !database.isTransaction && transactionEffect(sql, DIALECT) === null) {
          database.exec(BEGIN_SQL);
        }
        const statement = database.prepare(sql);
        statement.setReadBigInts(true);
        const columns: Column[] = statement.columns().map((column) => ({
          name: column.name,
          type: column.type,
          origin: originOf(column),
        }));
        if (columns.length === 0) {
          const { changes } = statement.run(...params);
          return { columns, rows: readRows([].values(), []), rowsAffected: Number(changes) };
        }
        statement.setReturnArrays(true);
        return {
          columns,
          rows: readRows(
            statement.iterate(...params),
            columns.map((column) => cellFor(column, options)),
          ),
          rowsAffected: null,
        };
      },
      sql,
    );
  }

  insertRows(target: InsertTarget, rows: readonly InsertRow[]): Promise<void> {
    return settle("statementFailed", () => {
      if (rows.length === 0) return;
      const database = this.#database;
      if (this.#mode === "manual" && !database.isTransaction) database.exec(BEGIN_SQL);
      const width = Math.max(1, target.columns.length);
      const perStatement = Math.max(1, Math.floor(MAX_PARAMETERS / width));
      const names = target.columns.map((column) => quoteIdentifier(column.name)).join(", ");
      const tuple = `(${target.columns.map(() => "?").join(", ")})`;
      database.exec(SAVEPOINT_SQL);
      try {
        for (let from = 0; from < rows.length; from += perStatement) {
          const chunk = rows.slice(from, from + perStatement);
          const values: Bound[] = [];
          for (const row of chunk) {
            row.forEach((value, index) => values.push(bound(value, target.columns[index]?.type ?? null)));
          }
          database
            .prepare(`INSERT INTO ${target.table} (${names}) VALUES ${chunk.map(() => tuple).join(", ")}`)
            .run(...values);
        }
        database.exec(RELEASE_SQL);
      } catch (cause) {
        database.exec(ROLLBACK_TO_SQL);
        database.exec(RELEASE_SQL);
        throw cause;
      }
    });
  }

  async explain(sql: string, options: ExplainOptions): Promise<ExplainedPlan> {
    const verdict = explainable(sql, options);
    if (!verdict.ok) throw new PluginError("explainUnsupported", verdict.reason);
    const statement = explainStatement(sql);
    const rows: Row[] = [];
    for await (const row of (await this.execute(statement)).rows) rows.push(row);
    return readPlanRows(rows, statement);
  }

  #end(sql: string): Promise<void> {
    return settle("statementFailed", () => {
      if (this.#database.isTransaction) this.#database.exec(sql);
    });
  }

  close(): Promise<void> {
    return settle("statementFailed", () => this.#database.close());
  }
}

const plugin: DatasourcePlugin = {
  id: PLUGIN_ID,
  capabilities: CAPABILITIES,
  language,
  connectionSchema,
  connect: (config, options) =>
    settle("connectionFailed", () => new SqliteSession(connectionSchema.parse(config), options)),
};

export default plugin;

/** The table column better-sqlite3 reads a result column from, or null for an expression (plan 026). */
function originOf(column: StatementColumnMetadata): ColumnOrigin | null {
  if (column.table === null || column.column === null) return null;
  return { table: `${column.database ?? ""}.${column.table}`, column: column.column };
}
