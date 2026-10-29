import type { CancelReach, ServerTimeout } from "@table-craft/plugin-api";
import type { ServerIdentity } from "@table-craft/plugin-api/sql";
import { MYSQL_FLAVOUR, TIDB_FLAVOUR } from "./functions/ranges.js";

/** The first TiDB release with Global Kill on by default, whose connection ids are cluster-wide. */
const TIDB_GLOBAL_KILL = [6, 1] as const;

/** The leading `major.minor[.patch]` of a version string. */
const MYSQL_RELEASE = /^(\d+)\.(\d+)(?:\.(\d+))?/;
/**
 * TiDB's `VERSION()` reads like `8.0.11-TiDB-v7.5.1`: a MySQL version, then its own after the
 * marker.
 */
const TIDB_RELEASE = /-TiDB-v(\d+)\.(\d+)(?:\.(\d+))?/i;
/** MariaDB's `VERSION()` reads like `10.11.8-MariaDB-log`; its number is not a MySQL release. */
const MARIADB_VERSION = /-MariaDB/i;
/** The MySQL release MariaDB's handshake puts before its own, `5.5.5-10.11.8-MariaDB`, for old clients. */
const MARIADB_HANDSHAKE_PREFIX = /^5\.5\.5-/;

function release(match: RegExpExecArray): number[] {
  return match
    .slice(1)
    .filter((part): part is string => part !== undefined)
    .map(Number);
}

/** The servers the MySQL plugin speaks to; each is a manifest `brands` id, the session's `serverBrand`. */
export const MYSQL_SERVER_KINDS = ["mysql", "mariadb", "tidb"] as const;

export type MysqlServerKind = (typeof MYSQL_SERVER_KINDS)[number];

/** Which server answered, and its own release: TiDB's after its marker, MariaDB's past the handshake prefix. */
export interface ServerDialect {
  readonly kind: MysqlServerKind;
  /** `[major, minor]` or `[major, minor, patch]`; null when the version is unreadable. */
  readonly version: readonly number[] | null;
}

/** The one reading of `VERSION()` every server-specific choice of this plugin starts from. */
export function serverDialect(serverVersion: string | null): ServerDialect {
  if (serverVersion === null) return { kind: "mysql", version: null };
  const tidb = TIDB_RELEASE.exec(serverVersion);
  if (tidb !== null) return { kind: "tidb", version: release(tidb) };
  if (MARIADB_VERSION.test(serverVersion)) {
    const mariadb = MYSQL_RELEASE.exec(serverVersion.replace(MARIADB_HANDSHAKE_PREFIX, ""));
    return { kind: "mariadb", version: mariadb === null ? null : release(mariadb) };
  }
  const mysql = MYSQL_RELEASE.exec(serverVersion);
  return { kind: "mysql", version: mysql === null ? null : release(mysql) };
}

/**
 * Which function list applies: TiDB by its own release, else MySQL, MariaDB included; null when the
 * version is unreadable.
 */
export function serverIdentity(serverVersion: string): ServerIdentity | null {
  const { kind, version } = serverDialect(serverVersion);
  if (version === null) return null;
  return { flavour: kind === "tidb" ? TIDB_FLAVOUR : MYSQL_FLAVOUR, version: [...version] };
}

export function isTidb(serverVersion: string | null): boolean {
  return serverDialect(serverVersion).kind === "tidb";
}

/** The first MySQL releases with `EXPLAIN FORMAT=TREE` and with `EXPLAIN ANALYZE`. */
const MYSQL_TREE = [8, 0, 16] as const;
const MYSQL_ANALYZE = [8, 0, 18] as const;

function atLeast(version: readonly number[], wanted: readonly number[]): boolean {
  for (const [index, part] of wanted.entries()) {
    const have = version[index] ?? 0;
    if (have !== part) return have > part;
  }
  return true;
}

/** What a server's EXPLAIN speaks. */
export interface ExplainDialect {
  /** TiDB prints its plan as rows of a table. */
  readonly tidb: boolean;
  readonly tree: boolean;
  /** How the server runs and times a statement: MySQL's `EXPLAIN ANALYZE`, MariaDB's `ANALYZE FORMAT=JSON`, or not at all. */
  readonly analyze: "explainAnalyze" | "analyzeJson" | null;
}

/** An unreadable version is taken for a current MySQL, as before servers were told apart. */
export function explainDialect(serverVersion: string | null): ExplainDialect {
  const dialect = serverDialect(serverVersion);
  if (dialect.kind === "tidb") return { tidb: true, tree: false, analyze: "explainAnalyze" };
  if (dialect.kind === "mariadb") return { tidb: false, tree: false, analyze: "analyzeJson" };
  const version = dialect.version ?? MYSQL_ANALYZE;
  return {
    tidb: false,
    tree: atLeast(version, MYSQL_TREE),
    analyze: atLeast(version, MYSQL_ANALYZE) ? "explainAnalyze" : null,
  };
}

/**
 * The statement that stops a running query of another connection, or `null` when no statement
 * stops it safely (decision 058).
 *
 * Before Global Kill, a TiDB connection id is unique to one TiDB server only, and the second
 * connection a kill needs may reach another server behind the load balancer, where the same id
 * belongs to someone else's session. TiDB 4 also ignores `KILL QUERY`, answering with a warning.
 */
export function killStatementFor(serverVersion: string | null, connectionId: number): string | null {
  const globalKill = tidbGlobalKill(serverVersion);
  if (globalKill === null) return `KILL QUERY ${String(connectionId)}`;
  return globalKill ? `KILL TIDB QUERY ${String(connectionId)}` : null;
}

/** How `cancel` names what it sends where `killStatementFor` has no statement: it drops the connection. */
export const CONNECTION_RESET_METHOD = "connection reset";
const KILL_QUERY_METHOD = "KILL QUERY";
const KILL_TIDB_QUERY_METHOD = "KILL TIDB QUERY";

/** How this server's cancel reaches it (decision 131), read from Global Kill as `killStatementFor` is. */
export function cancelReachOf(serverVersion: string | null): CancelReach {
  const globalKill = tidbGlobalKill(serverVersion);
  if (globalKill === null) return { method: KILL_QUERY_METHOD, reaches: "statement" };
  return globalKill
    ? { method: KILL_TIDB_QUERY_METHOD, reaches: "statement" }
    : { method: CONNECTION_RESET_METHOD, reaches: "connection" };
}

/** The first releases with a session statement limit: MySQL's `max_execution_time`, MariaDB's `max_statement_time`. */
const MYSQL_TIMEOUT_SINCE = [5, 7, 8] as const;
const MARIADB_TIMEOUT_SINCE = [10, 1, 1] as const;
/** From TiDB 6.4, `max_execution_time` covers only `SELECT`, as MySQL's does; before, every statement. */
const TIDB_READS_ONLY_SINCE = [6, 4, 0] as const;
const MAX_EXECUTION_TIME = "max_execution_time";
const MAX_STATEMENT_TIME = "max_statement_time";
/** A statement naming either setting may have changed it behind the plugin's back. */
const TIMEOUT_SETTING = /max_(?:execution|statement)_time/i;
/** MySQL's `ER_QUERY_TIMEOUT`, sent when `max_execution_time` stops a `SELECT`. */
const QUERY_TIMEOUT_ERRNO = 3024;
/** MariaDB's `ER_STATEMENT_TIMEOUT`, sent when `max_statement_time` stops a statement. */
const STATEMENT_TIMEOUT_ERRNO = 1969;
/**
 * `ER_QUERY_INTERRUPTED`: what TiDB sends when `max_execution_time` stops a statement, the same
 * errno a `KILL` gives, so only the time it ran tells the two apart.
 */
const QUERY_INTERRUPTED_ERRNO = 1317;
const MS_PER_SECOND = 1000;
const SERVER_NAMES: Record<MysqlServerKind, string> = { mysql: "MySQL", mariadb: "MariaDB", tidb: "TiDB" };

/** What the server stops by itself under its session statement limit (decision 129); null when it has none. */
export function serverTimeoutOf(dialect: ServerDialect): ServerTimeout | null {
  const { kind, version } = dialect;
  if (version === null) return null;
  switch (kind) {
    case "tidb":
      return {
        setting: MAX_EXECUTION_TIME,
        covers: atLeast(version, TIDB_READS_ONLY_SINCE) ? "reads" : "all",
        counts: "statement",
      };
    case "mariadb":
      return atLeast(version, MARIADB_TIMEOUT_SINCE)
        ? { setting: MAX_STATEMENT_TIME, covers: "all", counts: "statement" }
        : null;
    case "mysql":
      return atLeast(version, MYSQL_TIMEOUT_SINCE)
        ? { setting: MAX_EXECUTION_TIME, covers: "reads", counts: "statement" }
        : null;
  }
}

/** The `SET SESSION` that limits statements to `ms`, in the server's own unit; `ms` 0 means unlimited. */
export function serverTimeoutSql(dialect: ServerDialect, ms: number): string {
  if (dialect.kind === "mariadb") return `SET SESSION ${MAX_STATEMENT_TIME} = ${String(ms / MS_PER_SECOND)}`;
  return `SET SESSION ${MAX_EXECUTION_TIME} = ${String(Math.round(ms))}`;
}

/** Reads the session's own limit, which `ownTimeoutMs` turns into milliseconds. */
export function readServerTimeoutSql(dialect: ServerDialect): string {
  return `SELECT @@SESSION.${dialect.kind === "mariadb" ? MAX_STATEMENT_TIME : MAX_EXECUTION_TIME}`;
}

/** The value `readServerTimeoutSql` read, in milliseconds; 0, as the server means it, is unlimited. */
export function ownTimeoutMs(dialect: ServerDialect, value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return dialect.kind === "mariadb" ? Math.round(amount * MS_PER_SECOND) : Math.round(amount);
}

export function namesServerTimeout(sql: string): boolean {
  return TIMEOUT_SETTING.test(sql);
}

/**
 * Whether `errno` is the server stopping a statement at the limit the plugin set, `limitMs`, after
 * it ran `ranMs`; a cancel the plugin asked for is ruled out by the caller.
 */
export function stoppedAtLimit(
  dialect: ServerDialect,
  errno: number | undefined,
  ranMs: number,
  limitMs: number | null,
): boolean {
  if (errno === QUERY_TIMEOUT_ERRNO || errno === STATEMENT_TIMEOUT_ERRNO) return true;
  return dialect.kind === "tidb" && errno === QUERY_INTERRUPTED_ERRNO && limitMs !== null && ranMs >= limitMs;
}

/** "TiDB stopped the statement at its 120 s limit (max_execution_time)." */
export function stoppedAtLimitMessage(dialect: ServerDialect, limitMs: number | null): string {
  const setting = serverTimeoutOf(dialect)?.setting ?? MAX_EXECUTION_TIME;
  const limit = limitMs === null ? "" : ` ${String(limitMs / MS_PER_SECOND)} s`;
  return `${SERVER_NAMES[dialect.kind]} stopped the statement at its${limit} limit (${setting}).`;
}

/** Whether a TiDB server's connection ids are cluster-wide; null when the server is not TiDB. */
export function tidbGlobalKill(serverVersion: string | null): boolean | null {
  const { kind, version } = serverDialect(serverVersion);
  if (kind !== "tidb" || version === null) return null;
  return atLeast(version, TIDB_GLOBAL_KILL);
}
