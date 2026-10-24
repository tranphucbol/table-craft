import type pg from "pg";
import {
  PluginError,
  type ServerSession,
  type ServerSessionState,
  type SessionListing,
  type SessionMonitor,
  type SessionTarget,
} from "@table-craft/plugin-api";

/**
 * Every column as text, so the reader owns parsing whatever type parsers the client carries.
 * Query time is how long the current statement has run, or how long the last one ran on an idle
 * backend, by the server's clock (`clock_timestamp`, not the transaction's frozen `now`).
 */
export const SESSIONS_SQL = `
  SELECT a.pid::text AS id,
    a.state,
    a.usename::text AS "user",
    a.datname::text AS database,
    CASE WHEN a.client_addr IS NOT NULL THEN host(a.client_addr) || ':' || a.client_port::text
      WHEN a.client_port = -1 THEN 'local socket' END AS client,
    a.application_name AS application,
    round(extract(epoch FROM CASE WHEN a.state = 'active' THEN clock_timestamp() - a.query_start
      ELSE a.state_change - a.query_start END) * 1000)::bigint::text AS query_ms,
    round(extract(epoch FROM clock_timestamp() - a.xact_start) * 1000)::bigint::text AS transaction_ms,
    CASE WHEN a.wait_event IS NOT NULL THEN coalesce(a.wait_event_type || ': ', '') || a.wait_event END AS wait,
    array_to_string(pg_blocking_pids(a.pid), ',') AS blocked_by,
    a.query,
    a.backend_type,
    current_user::text AS me
  FROM pg_stat_activity a
  ORDER BY a.backend_type <> 'client backend', a.pid`;

/** One row of `SESSIONS_SQL`. */
export interface PostgresSessionRow {
  readonly id: string;
  readonly state: string | null;
  readonly user: string | null;
  readonly database: string | null;
  readonly client: string | null;
  readonly application: string | null;
  readonly query_ms: string | null;
  readonly transaction_ms: string | null;
  readonly wait: string | null;
  readonly blocked_by: string | null;
  readonly query: string | null;
  readonly backend_type: string | null;
  readonly me: string;
}

/** What `pg_stat_activity` shows in place of another user's columns without `pg_read_all_stats`. */
const INSUFFICIENT_PRIVILEGE = "<insufficient privilege>";
const CLIENT_BACKEND = "client backend";
const IDLE_IN_TRANSACTION = /^idle in transaction/;

const STATES: ReadonlyMap<string, ServerSessionState> = new Map([
  ["active", "active"],
  ["idle", "idle"],
]);

function nonEmpty(text: string | null): string | null {
  return text === null || text === "" ? null : text;
}

function milliseconds(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function stateOf(raw: string | null, blocked: boolean): ServerSessionState {
  if (raw === null) return "other";
  if (raw === "active" && blocked) return "blocked";
  if (IDLE_IN_TRANSACTION.test(raw)) return "idleInTransaction";
  return STATES.get(raw) ?? "other";
}

export function cancelStatement(id: string): string {
  return `SELECT pg_cancel_backend(${id})`;
}

export function terminateStatement(id: string): string {
  return `SELECT pg_terminate_backend(${id})`;
}

export function readPostgresSession(row: PostgresSessionRow): ServerSession {
  const hidden = row.query === INSUFFICIENT_PRIVILEGE;
  const blockedBy = row.blocked_by === null || hidden ? null : row.blocked_by.split(",").filter((id) => id !== "");
  const system = row.backend_type !== null && row.backend_type !== CLIENT_BACKEND;
  return {
    id: row.id,
    instance: null,
    state: stateOf(row.state, (blockedBy?.length ?? 0) > 0),
    rawState: row.state ?? (system ? row.backend_type : null),
    user: row.user,
    database: row.database,
    client: row.client,
    application: nonEmpty(row.application),
    queryMs: milliseconds(row.query_ms),
    transactionMs: milliseconds(row.transaction_ms),
    waitEvent: row.wait,
    blockedBy,
    query: hidden ? null : nonEmpty(row.query),
    system,
    // Background workers are the server's own; stopping one is never a client's business.
    cancel: system ? null : cancelStatement(row.id),
    terminate: system ? null : terminateStatement(row.id),
  };
}

export function readPostgresSessions(rows: readonly PostgresSessionRow[]): SessionListing {
  const me = rows[0]?.me ?? "";
  const hidden = rows.some((row) => row.query === INSUFFICIENT_PRIVILEGE);
  return {
    sessions: rows.map(readPostgresSession),
    notes: hidden
      ? [`Other users' sessions show no state, query or client: ask for GRANT pg_read_all_stats TO ${me} to see them.`]
      : [],
  };
}

const PID = /^\d+$/;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Lists on the session's own client, queued behind whatever else it runs; stops on a fresh
 * connection, so stopping the listing session itself still answers.
 */
export function postgresSessions(client: pg.Client, open: () => Promise<pg.Client>): SessionMonitor {
  async function stop(target: SessionTarget, statement: (id: string) => string, verb: string): Promise<void> {
    if (!PID.test(target.id))
      throw new PluginError("statementFailed", `"${target.id}" is not a PostgreSQL backend pid.`);
    let stopped: unknown;
    const connection = await open();
    try {
      stopped = (await connection.query<[unknown]>({ text: statement(target.id), rowMode: "array" })).rows[0]?.[0];
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    } finally {
      await connection.end().catch(() => undefined);
    }
    if (stopped !== true) {
      throw new PluginError(
        "statementFailed",
        `Could not ${verb} session ${target.id}: it is no longer on the server. Refresh the list.`,
      );
    }
  }

  return {
    list: async () => {
      try {
        return readPostgresSessions((await client.query<PostgresSessionRow>(SESSIONS_SQL)).rows);
      } catch (cause) {
        throw new PluginError("introspectionFailed", messageOf(cause), { cause });
      }
    },
    cancelSession: (target) => stop(target, cancelStatement, "cancel the query of"),
    terminateSession: (target) => stop(target, terminateStatement, "terminate"),
  };
}
