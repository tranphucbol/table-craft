/**
 * TiDB's `VERSION()` reads like `8.0.11-TiDB-v7.5.1`: a MySQL version, then its own after the
 * marker.
 */
const TIDB_VERSION = /-TiDB-v(\d+)\.(\d+)/i;

/** The first TiDB release with Global Kill on by default, whose connection ids are cluster-wide. */
const TIDB_GLOBAL_KILL = { major: 6, minor: 1 } as const;

export function isTidb(serverVersion: string | null): boolean {
  return serverVersion !== null && TIDB_VERSION.test(serverVersion);
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
  const tidb = serverVersion === null ? null : TIDB_VERSION.exec(serverVersion);
  if (tidb === null) return `KILL QUERY ${String(connectionId)}`;
  const major = Number(tidb[1]);
  const minor = Number(tidb[2]);
  const globalKill =
    major > TIDB_GLOBAL_KILL.major || (major === TIDB_GLOBAL_KILL.major && minor >= TIDB_GLOBAL_KILL.minor);
  return globalKill ? `KILL TIDB QUERY ${String(connectionId)}` : null;
}
