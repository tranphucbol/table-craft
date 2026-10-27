import type { ServerIdentity } from "@table-craft/plugin-api/sql";
import { MYSQL_FLAVOUR, TIDB_FLAVOUR } from "./functions/ranges.js";

/**
 * TiDB's `VERSION()` reads like `8.0.11-TiDB-v7.5.1`: a MySQL version, then its own after the
 * marker.
 */
const TIDB_VERSION = /-TiDB-v(\d+)\.(\d+)/i;

/** The first TiDB release with Global Kill on by default, whose connection ids are cluster-wide. */
const TIDB_GLOBAL_KILL = { major: 6, minor: 1 } as const;

/** The leading `major.minor[.patch]` of a version string, TiDB's after its marker. */
const MYSQL_RELEASE = /^(\d+)\.(\d+)(?:\.(\d+))?/;
const TIDB_RELEASE = /-TiDB-v(\d+)\.(\d+)(?:\.(\d+))?/i;

function release(match: RegExpExecArray): number[] {
  return match
    .slice(1)
    .filter((part): part is string => part !== undefined)
    .map(Number);
}

/** Which function list applies: TiDB by its own release, else MySQL; null when the version is unreadable. */
export function serverIdentity(serverVersion: string): ServerIdentity | null {
  const tidb = TIDB_RELEASE.exec(serverVersion);
  if (tidb !== null) return { flavour: TIDB_FLAVOUR, version: release(tidb) };
  const mysql = MYSQL_RELEASE.exec(serverVersion);
  return mysql === null ? null : { flavour: MYSQL_FLAVOUR, version: release(mysql) };
}

export function isTidb(serverVersion: string | null): boolean {
  return serverVersion !== null && TIDB_VERSION.test(serverVersion);
}

/** MariaDB's `VERSION()` reads like `10.11.8-MariaDB-log`; its number is not a MySQL release. */
const MARIADB_VERSION = /-MariaDB/i;
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
  if (isTidb(serverVersion)) return { tidb: true, tree: false, analyze: "explainAnalyze" };
  if (serverVersion !== null && MARIADB_VERSION.test(serverVersion)) {
    return { tidb: false, tree: false, analyze: "analyzeJson" };
  }
  const mysql = serverVersion === null ? null : MYSQL_RELEASE.exec(serverVersion);
  const version = mysql === null ? [...MYSQL_ANALYZE] : release(mysql);
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
  const tidb = serverVersion === null ? null : TIDB_VERSION.exec(serverVersion);
  if (tidb === null) return null;
  const major = Number(tidb[1]);
  const minor = Number(tidb[2]);
  return major > TIDB_GLOBAL_KILL.major || (major === TIDB_GLOBAL_KILL.major && minor >= TIDB_GLOBAL_KILL.minor);
}
