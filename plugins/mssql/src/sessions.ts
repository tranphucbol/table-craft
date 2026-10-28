import {
  PluginError,
  type ServerSession,
  type ServerSessionState,
  type SessionListing,
  type SessionMonitor,
  type SessionTarget,
} from "@table-craft/plugin-api";
import type { Reader } from "./introspect.js";

/** Whether the login sees every session; `VIEW SERVER PERFORMANCE STATE` is SQL Server 2022's narrower form. */
const SEES_ALL_SQL =
  "HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') = 1 OR HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER PERFORMANCE STATE') = 1";

/**
 * The query shown is the session's input buffer, the batch as the client sent it: the SQL handles
 * name the auto-parameterized form, `(@1 int)UPDATE [t] set …`, which no one typed.
 */
function sessionsSelect(full: boolean): string {
  return `SELECT CAST(s.session_id AS varchar(10)) AS id,
  s.status,
  r.status AS request_status,
  s.login_name AS login,
  DB_NAME(COALESCE(r.database_id, s.database_id)) AS database_name,
  ${full ? "COALESCE(c.client_net_address + COALESCE(':' + CAST(c.client_tcp_port AS varchar(5)), ''), s.host_name)" : "s.host_name"} AS client,
  s.program_name AS application,
  CASE WHEN r.start_time IS NOT NULL THEN DATEDIFF_BIG(millisecond, r.start_time, SYSDATETIME())
    WHEN s.last_request_end_time >= s.last_request_start_time
      THEN DATEDIFF_BIG(millisecond, s.last_request_start_time, s.last_request_end_time) END AS query_ms,
  ${full ? "DATEDIFF_BIG(millisecond, tx.began, SYSDATETIME())" : "CAST(NULL AS bigint)"} AS transaction_ms,
  r.wait_type,
  r.blocking_session_id,
  ${full ? "COALESCE(ib.event_info, t.text)" : "CAST(NULL AS nvarchar(max))"} AS query,
  s.is_user_process,
  s.open_transaction_count,
  ${full ? 1 : 0} AS sees_all,
  SUSER_SNAME() AS me
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id${
    full
      ? `
OUTER APPLY (SELECT TOP (1) client_net_address, client_tcp_port, most_recent_sql_handle
  FROM sys.dm_exec_connections WHERE session_id = s.session_id ORDER BY connect_time) c
OUTER APPLY (SELECT MIN(at.transaction_begin_time) AS began
  FROM sys.dm_tran_session_transactions st
  JOIN sys.dm_tran_active_transactions at ON at.transaction_id = st.transaction_id
  WHERE st.session_id = s.session_id) tx
OUTER APPLY sys.dm_exec_input_buffer(s.session_id, NULL) ib
OUTER APPLY sys.dm_exec_sql_text(COALESCE(c.most_recent_sql_handle, r.sql_handle)) t`
      : ""
  }
ORDER BY s.is_user_process DESC, s.session_id;`;
}

/**
 * Every session with its running request, if any. Without `VIEW SERVER STATE` the session DMVs show
 * only the caller's own sessions and the connection, transaction and text ones refuse outright, so
 * that branch reads the first two alone.
 */
export const SESSIONS_SQL = `IF ${SEES_ALL_SQL}
${sessionsSelect(true)}
ELSE
${sessionsSelect(false)}`;

/** One row of `SESSIONS_SQL`, as tedious reads it. */
interface SessionRow {
  readonly id: string;
  readonly status: string | null;
  readonly request_status: string | null;
  readonly login: string | null;
  readonly database_name: string | null;
  readonly client: string | null;
  readonly application: string | null;
  readonly query_ms: string | number | null;
  readonly transaction_ms: string | number | null;
  readonly wait_type: string | null;
  readonly blocking_session_id: number | null;
  readonly query: string | null;
  readonly is_user_process: boolean;
  readonly open_transaction_count: number | null;
  readonly sees_all: number;
  readonly me: string;
}

const SESSION_ID = /^\d+$/;
/** A request's status while it runs or waits; `background` belongs to a server worker. */
const ACTIVE_REQUESTS: ReadonlySet<string> = new Set(["running", "runnable", "suspended", "rollback"]);

function nonEmpty(text: string | null): string | null {
  return text === null || text.trim() === "" ? null : text;
}

/** `datetime` rounds to 1/300 s, so a request that just started can look a few milliseconds ahead. */
function milliseconds(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : null;
}

function stateOf(row: SessionRow, blocked: boolean): ServerSessionState {
  if (row.request_status !== null && ACTIVE_REQUESTS.has(row.request_status)) return blocked ? "blocked" : "active";
  if (row.status === "sleeping") return (row.open_transaction_count ?? 0) > 0 ? "idleInTransaction" : "idle";
  return "other";
}

export function terminateStatement(id: string): string {
  return `KILL ${id}`;
}

function readSession(row: SessionRow): ServerSession {
  const blocker = row.blocking_session_id ?? 0;
  const blocked = blocker > 0;
  const system = !row.is_user_process;
  return {
    id: row.id,
    instance: null,
    state: stateOf(row, blocked),
    rawState: row.request_status ?? row.status,
    user: nonEmpty(row.login),
    database: row.database_name,
    client: nonEmpty(row.client),
    application: nonEmpty(row.application),
    queryMs: milliseconds(row.query_ms),
    transactionMs: milliseconds(row.transaction_ms),
    waitEvent: nonEmpty(row.wait_type),
    blockedBy: row.request_status === null ? [] : blocked ? [String(blocker)] : [],
    query: nonEmpty(row.query),
    system,
    // `KILL` ends the session; SQL Server has no statement that stops only another session's request.
    cancel: null,
    terminate: system ? null : terminateStatement(row.id),
  };
}

function records(rows: readonly unknown[][], names: readonly string[]): SessionRow[] {
  return rows.map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])) as unknown as SessionRow);
}

function quotedLogin(login: string): string {
  return `[${login.replaceAll("]", "]]")}]`;
}

export function readSessions(rows: readonly SessionRow[]): SessionListing {
  const first = rows[0];
  const seesAll = first === undefined || first.sees_all === 1;
  return {
    sessions: rows.map(readSession),
    notes: seesAll
      ? []
      : [
          `Only this login's sessions are listed: ask for GRANT VIEW SERVER STATE TO ${quotedLogin(first.me)} ` +
            "(VIEW SERVER PERFORMANCE STATE from SQL Server 2022) to see every session.",
        ],
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Lists on the session's own connection, in turn with its other requests; kills on a fresh one,
 * since SQL Server refuses `KILL` of the caller's own session.
 */
export function mssqlSessions(
  read: Reader,
  fresh: <T>(work: (read: Reader) => Promise<T>) => Promise<T>,
): SessionMonitor {
  return {
    list: async () => {
      try {
        const [set] = await read(SESSIONS_SQL);
        if (set === undefined) return { sessions: [], notes: [] };
        return readSessions(
          records(
            set.rows,
            set.columns.map((column) => column.colName),
          ),
        );
      } catch (cause) {
        throw new PluginError("introspectionFailed", messageOf(cause), { cause });
      }
    },
    cancelSession: (target: SessionTarget) =>
      Promise.reject(
        new PluginError(
          "statementFailed",
          `SQL Server cannot stop only the statement of session ${target.id}; terminate the session instead.`,
        ),
      ),
    terminateSession: async (target: SessionTarget) => {
      if (!SESSION_ID.test(target.id)) {
        throw new PluginError("statementFailed", `"${target.id}" is not a SQL Server session id.`);
      }
      try {
        await fresh((other) => other(terminateStatement(target.id)));
      } catch (cause) {
        throw new PluginError("statementFailed", messageOf(cause), { cause });
      }
    },
  };
}
