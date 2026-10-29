import { existsSync, renameSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/** Rows kept per datasource; the insert past it deletes the oldest (plan 011, decision 3). */
export const HISTORY_LIMIT = 10_000;
/** Distinct statements one search answers at most (plan 011, decision 4). */
export const HISTORY_SEARCH_LIMIT = 200;

export const HISTORY_OUTCOMES = ["success", "error", "cancelled"] as const;
export type HistoryOutcome = (typeof HISTORY_OUTCOMES)[number];
export const HISTORY_SOURCES = ["console", "table", "agent"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

/** One statement run, as the renderer saw it end (decision 030). */
export interface HistoryEntry {
  readonly datasourceId: string;
  readonly sql: string;
  /** Epoch milliseconds. */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: HistoryOutcome;
  /** Rows returned for a result set, rows affected otherwise; null when unknown. */
  readonly rowCount: number | null;
  /** The error's message for a failure. */
  readonly message: string | null;
  readonly source: HistorySource;
  /** The values it was bound with, by parameter name (plan 019 decision 9); absent or null when none. */
  readonly parameters?: HistoryParameters | null;
  /**
   * How many warnings the server left (decision 066), never their text; absent or null when it
   * left none or had not said yet.
   */
  readonly warnings?: number | null;
  /** The MCP client that ran it, as it named itself; absent or null for the user's own runs. */
  readonly client?: string | null;
}

export type HistoryParameters = Readonly<Record<string, string | null>>;

/** Every run of one exact statement text, described by its newest run. */
export interface HistoryStatement {
  readonly sql: string;
  readonly lastStartedAt: number;
  readonly lastDurationMs: number;
  readonly lastOutcome: HistoryOutcome;
  readonly lastRowCount: number | null;
  readonly lastMessage: string | null;
  /** The values the newest run was bound with; null when it had none. */
  readonly lastParameters: HistoryParameters | null;
  /** Where the newest run came from; `agent` marks an MCP client's run (decision 127). */
  readonly lastSource: HistorySource;
  /** The MCP client behind the newest run; null for the user's own. */
  readonly lastClient: string | null;
  readonly runs: number;
}

/** One run without its statement text or error message, for a diagnostics export (plan 017). */
export interface HistoryRun {
  readonly datasourceId: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly outcome: HistoryOutcome;
  readonly rowCount: number | null;
  readonly source: HistorySource;
  readonly warnings: number | null;
}

export interface QueryHistory {
  record(entry: HistoryEntry): void;
  /** Distinct statements of the datasource containing `query`, case-insensitively, newest first. */
  search(datasourceId: string, query: string, limit?: number): readonly HistoryStatement[];
  clear(datasourceId: string): void;
  /** The newest runs across every datasource, newest first, metadata only. */
  recentRuns(limit: number): readonly HistoryRun[];
  close(): void;
  /** Where an unreadable file was moved when this history opened; null when it opened as it was. */
  readonly recoveredFrom: string | null;
}

export interface QueryHistoryOptions {
  readonly limit?: number;
  readonly now?: () => number;
}

const SCHEMA_VERSION = 4;
const MEMORY_PATH = ":memory:";
const CORRUPT_SUFFIX = ".corrupt-";
/** SQLite keeps these beside a WAL database; they move with it so they never pair with a fresh file. */
const COMPANION_SUFFIXES = ["-wal", "-shm"] as const;
const COLUMNS = [
  "id",
  "datasource_id",
  "sql",
  "started_at",
  "duration_ms",
  "outcome",
  "row_count",
  "message",
  "source",
  "parameters",
  "warnings",
  "client",
] as const;
const PARAMETERS_COLUMN = "parameters";
const WARNINGS_COLUMN = "warnings";
const CLIENT_MIGRATION = `ALTER TABLE entries ADD COLUMN client TEXT NULL; PRAGMA user_version = 4;`;
const WARNINGS_MIGRATION = `ALTER TABLE entries ADD COLUMN warnings INTEGER NULL; ${CLIENT_MIGRATION}`;
/**
 * Version 1 lacked `parameters`, `warnings` and `client`, version 2 the last two, version 3
 * `client`; each is added in place, keeping every row. Each entry is the columns the version had
 * and the script that brings it up.
 */
const MIGRATIONS: Readonly<Record<number, { readonly columns: readonly string[]; readonly script: string }>> = {
  1: {
    columns: COLUMNS.slice(0, COLUMNS.indexOf(PARAMETERS_COLUMN)),
    script: `ALTER TABLE entries ADD COLUMN parameters TEXT NULL; ${WARNINGS_MIGRATION}`,
  },
  2: { columns: COLUMNS.slice(0, COLUMNS.indexOf(WARNINGS_COLUMN)), script: WARNINGS_MIGRATION },
  3: { columns: COLUMNS.slice(0, -1), script: CLIENT_MIGRATION },
};

const CREATE_SCHEMA = `
CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  datasource_id TEXT NOT NULL,
  sql TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  row_count INTEGER NULL,
  message TEXT NULL,
  source TEXT NOT NULL,
  parameters TEXT NULL,
  warnings INTEGER NULL,
  client TEXT NULL
);
CREATE INDEX entries_datasource_started ON entries (datasource_id, started_at);
PRAGMA user_version = ${String(SCHEMA_VERSION)};
`;

const INSERT = `INSERT INTO entries (datasource_id, sql, started_at, duration_ms, outcome, row_count, message, source, parameters, warnings, client)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const COUNT = "SELECT count(*) AS n FROM entries WHERE datasource_id = ?";
const PRUNE = `DELETE FROM entries WHERE id IN (
  SELECT id FROM entries WHERE datasource_id = ? ORDER BY started_at, id LIMIT ?
)`;
const CLEAR = "DELETE FROM entries WHERE datasource_id = ?";
// `instr` rather than LIKE, so `%` and `_` in the query match themselves.
const SEARCH = `WITH matching AS (
  SELECT id, sql, started_at, duration_ms, outcome, row_count, message, parameters, source, client,
    row_number() OVER (PARTITION BY sql ORDER BY started_at DESC, id DESC) AS recency,
    count(*) OVER (PARTITION BY sql) AS runs
  FROM entries
  WHERE datasource_id = ? AND instr(lower(sql), lower(?)) > 0
)
SELECT sql, started_at, duration_ms, outcome, row_count, message, parameters, source, client, runs
FROM matching WHERE recency = 1
ORDER BY started_at DESC, id DESC
LIMIT ?`;

const RECENT_RUNS = `SELECT datasource_id, started_at, duration_ms, outcome, row_count, source, warnings
FROM entries ORDER BY started_at DESC, id DESC LIMIT ?`;

interface RunRow {
  readonly datasource_id: string;
  readonly started_at: number;
  readonly duration_ms: number;
  readonly outcome: HistoryOutcome;
  readonly row_count: number | null;
  readonly source: HistorySource;
  readonly warnings: number | null;
}

interface SearchRow {
  readonly sql: string;
  readonly started_at: number;
  readonly duration_ms: number;
  readonly outcome: HistoryOutcome;
  readonly row_count: number | null;
  readonly message: string | null;
  readonly parameters: string | null;
  readonly source: HistorySource;
  readonly client: string | null;
  readonly runs: number;
}

function parametersOf(text: string | null): HistoryParameters | null {
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const values: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" || value === null) values[name] = value;
    }
    return values;
  } catch {
    return null;
  }
}

/** Opens `path` as this schema, creating it in an empty file; throws when the file holds anything else. */
function openAsSchema(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    // A file that is not SQLite at all fails here, on the first read.
    const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    if (version === 0 && tables.length === 0) {
      database.exec(CREATE_SCHEMA);
      return database;
    }
    const migration = MIGRATIONS[version];
    if (migration !== undefined && tablesMatch(database, migration.columns)) database.exec(migration.script);
    else if (version !== SCHEMA_VERSION) throw new Error(`history schema version ${String(version)}`);
    if (!tablesMatch(database, COLUMNS)) throw new Error("history columns differ from this schema");
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
}

function tablesMatch(database: DatabaseSync, expected: readonly string[]): boolean {
  const columns = (database.prepare("PRAGMA table_info(entries)").all() as { name: string }[]).map((c) => c.name);
  return columns.join() === expected.join();
}

function moveAside(path: string, now: () => number): string {
  const backup = `${path}${CORRUPT_SUFFIX}${String(now())}`;
  renameSync(path, backup);
  for (const suffix of COMPANION_SUFFIXES) {
    if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${backup}${suffix}`);
  }
  return backup;
}

/**
 * The query history file (decision 030). A file that does not open as this schema is moved to
 * `<path>.corrupt-<ms>` and a fresh one takes its place, as `datasources.json` is.
 */
export function openQueryHistory(path: string, options: QueryHistoryOptions = {}): QueryHistory {
  const limit = options.limit ?? HISTORY_LIMIT;
  const now = options.now ?? Date.now;
  let database: DatabaseSync;
  let recoveredFrom: string | null = null;
  try {
    database = openAsSchema(path);
  } catch (cause) {
    if (path === MEMORY_PATH || !existsSync(path)) throw cause;
    recoveredFrom = moveAside(path, now);
    database = openAsSchema(path);
  }
  if (path !== MEMORY_PATH) database.exec("PRAGMA journal_mode = WAL");

  const insert: StatementSync = database.prepare(INSERT);
  const count = database.prepare(COUNT);
  const prune = database.prepare(PRUNE);
  const clear = database.prepare(CLEAR);
  const search = database.prepare(SEARCH);
  const recentRuns = database.prepare(RECENT_RUNS);

  return {
    recoveredFrom,
    record(entry) {
      database.exec("BEGIN");
      try {
        insert.run(
          entry.datasourceId,
          entry.sql,
          entry.startedAt,
          entry.durationMs,
          entry.outcome,
          entry.rowCount,
          entry.message,
          entry.source,
          entry.parameters == null ? null : JSON.stringify(entry.parameters),
          entry.warnings ?? null,
          entry.client ?? null,
        );
        const { n } = count.get(entry.datasourceId) as { n: number };
        if (n > limit) prune.run(entry.datasourceId, n - limit);
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    search(datasourceId, query, max = HISTORY_SEARCH_LIMIT) {
      const rows = search.all(datasourceId, query, max) as unknown as SearchRow[];
      return rows.map((row) => ({
        sql: row.sql,
        lastStartedAt: row.started_at,
        lastDurationMs: row.duration_ms,
        lastOutcome: row.outcome,
        lastRowCount: row.row_count,
        lastMessage: row.message,
        lastParameters: parametersOf(row.parameters),
        lastSource: row.source,
        lastClient: row.client,
        runs: row.runs,
      }));
    },
    clear(datasourceId) {
      clear.run(datasourceId);
    },
    recentRuns(max) {
      const rows = recentRuns.all(max) as unknown as RunRow[];
      return rows.map((row) => ({
        datasourceId: row.datasource_id,
        startedAt: row.started_at,
        durationMs: row.duration_ms,
        outcome: row.outcome,
        rowCount: row.row_count,
        source: row.source,
        warnings: row.warnings,
      }));
    },
    close() {
      database.close();
    },
  };
}
