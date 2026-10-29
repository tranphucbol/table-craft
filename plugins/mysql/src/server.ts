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

/** The servers the MySQL plugin speaks to. */
export type MysqlServerKind = "mysql" | "mariadb" | "tidb";

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

/** Whether a TiDB server's connection ids are cluster-wide; null when the server is not TiDB. */
export function tidbGlobalKill(serverVersion: string | null): boolean | null {
  const { kind, version } = serverDialect(serverVersion);
  if (kind !== "tidb" || version === null) return null;
  return atLeast(version, TIDB_GLOBAL_KILL);
}
