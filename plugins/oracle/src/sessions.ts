import oracledb from "oracledb";
import {
  PluginError,
  type ServerSession,
  type ServerSessionState,
  type SessionListing,
  type SessionMonitor,
  type SessionTarget,
} from "@table-craft/plugin-api";
import { messageOf } from "./connect.js";

/**
 * Every session on every instance, each with the statement it runs or ran last. A session's id is
 * `sid,serial#`, the pair `ALTER SYSTEM` names it by; the sid alone is reused. The sessions a
 * blocker id names are spelled the same way. Killed sessions linger until their process notices,
 * so they are left out.
 */
export const SESSIONS_SQL = `
  SELECT TO_CHAR(s.inst_id) AS inst_id,
    s.sid || ',' || s.serial# AS id,
    s.status,
    s.type,
    s.username,
    s.schemaname,
    s.machine,
    s.port,
    NVL(s.module, s.program) AS application,
    TO_CHAR(s.last_call_et * 1000) AS query_ms,
    TO_CHAR(ROUND((SYSDATE - t.start_date) * 86400000)) AS transaction_ms,
    CASE WHEN s.wait_class <> 'Idle' THEN s.wait_class || ': ' || s.event END AS wait,
    (SELECT b.sid || ',' || b.serial# FROM gv$session b
      WHERE b.sid = s.blocking_session AND b.inst_id = s.blocking_instance) AS blocked_by,
    (SELECT MAX(q.sql_text) FROM gv$sql q
      WHERE q.inst_id = s.inst_id AND q.sql_id = NVL(s.sql_id, s.prev_sql_id)) AS query,
    (SELECT COUNT(*) FROM gv$instance) AS instances
  FROM gv$session s
  LEFT JOIN gv$transaction t ON t.inst_id = s.inst_id AND t.addr = s.taddr
  WHERE s.status <> 'KILLED'
  ORDER BY s.type <> 'USER', s.inst_id, s.sid`;

/** This connection, read without any grant: what an account that cannot see `GV$SESSION` still sees. */
export const OWN_SESSION_SQL = `
  SELECT SYS_CONTEXT('USERENV', 'INSTANCE') AS inst_id,
    SYS_CONTEXT('USERENV', 'SID') || ',' || DBMS_DEBUG_JDWP.CURRENT_SESSION_SERIAL AS id,
    'ACTIVE' AS status,
    'USER' AS type,
    SYS_CONTEXT('USERENV', 'SESSION_USER') AS username,
    SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS schemaname,
    SYS_CONTEXT('USERENV', 'HOST') AS machine,
    NULL AS port,
    SYS_CONTEXT('USERENV', 'MODULE') AS application,
    '0' AS query_ms,
    NULL AS transaction_ms,
    NULL AS wait,
    NULL AS blocked_by,
    NULL AS query,
    1 AS instances
  FROM DUAL`;

/** `sid,serial#` of this connection, as `SESSIONS_SQL` lists it. */
export const SERVER_SESSION_ID_SQL = `SELECT SYS_CONTEXT('USERENV', 'SID') || ',' || DBMS_DEBUG_JDWP.CURRENT_SESSION_SERIAL FROM DUAL`;

/** One row of `SESSIONS_SQL`, upper-cased as the server names the columns. */
export interface OracleSessionRow {
  readonly INST_ID: string | null;
  readonly ID: string;
  readonly STATUS: string | null;
  readonly TYPE: string | null;
  readonly USERNAME: string | null;
  readonly SCHEMANAME: string | null;
  readonly MACHINE: string | null;
  readonly PORT: number | null;
  readonly APPLICATION: string | null;
  readonly QUERY_MS: string | null;
  readonly TRANSACTION_MS: string | null;
  readonly WAIT: string | null;
  readonly BLOCKED_BY: string | null;
  readonly QUERY: string | null;
  readonly INSTANCES: number;
}

/** ORA-00942: the account cannot read `GV$SESSION`. */
const NO_VIEW = 942;
const SESSION_ID = /^\d+,\d+$/;
const INSTANCE = /^\d+$/;
const USER_SESSION = "USER";

function milliseconds(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function stateOf(row: OracleSessionRow): ServerSessionState {
  if (row.BLOCKED_BY !== null) return "blocked";
  if (row.STATUS === "ACTIVE") return "active";
  if (row.STATUS === "INACTIVE") return row.TRANSACTION_MS === null ? "idle" : "idleInTransaction";
  return "other";
}

/** `ALTER SYSTEM` names a session `'sid,serial#'`, and `'sid,serial#,@instance'` on another instance. */
function sessionText(id: string, instance: string | null): string {
  return instance === null ? `'${id}'` : `'${id},@${instance}'`;
}

export function cancelStatement(id: string, instance: string | null): string {
  return `ALTER SYSTEM CANCEL SQL ${sessionText(id, instance)}`;
}

export function terminateStatement(id: string, instance: string | null): string {
  return `ALTER SYSTEM KILL SESSION ${sessionText(id, instance)} IMMEDIATE`;
}

export function readOracleSession(row: OracleSessionRow): ServerSession {
  const instance = row.INSTANCES > 1 ? row.INST_ID : null;
  const system = row.TYPE !== USER_SESSION;
  return {
    id: row.ID,
    instance,
    state: stateOf(row),
    rawState: row.STATUS,
    user: row.USERNAME,
    database: row.SCHEMANAME,
    client:
      row.MACHINE === null
        ? null
        : row.PORT === null || row.PORT === 0
          ? row.MACHINE
          : `${row.MACHINE}:${String(row.PORT)}`,
    application: row.APPLICATION,
    queryMs: milliseconds(row.QUERY_MS),
    transactionMs: milliseconds(row.TRANSACTION_MS),
    waitEvent: row.WAIT,
    blockedBy: row.BLOCKED_BY === null ? [] : [row.BLOCKED_BY],
    query: row.QUERY,
    system,
    // Background processes are the instance's own; killing one can take the instance down.
    cancel: system ? null : cancelStatement(row.ID, instance),
    terminate: system ? null : terminateStatement(row.ID, instance),
  };
}

export function hiddenSessionsNote(user: string): string {
  return `Only this session is listed: the account cannot read GV$SESSION. Ask for GRANT SELECT_CATALOG_ROLE TO ${user} to see the others.`;
}

async function rowsOf(connection: oracledb.Connection, sql: string): Promise<OracleSessionRow[]> {
  const result = await connection.execute<OracleSessionRow>(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return result.rows ?? [];
}

/**
 * Lists on the session's own connection, queued behind whatever else it runs; stops on a fresh
 * connection, so stopping the listing session itself still answers.
 */
export function oracleSessions(
  connection: oracledb.Connection,
  open: () => Promise<oracledb.Connection>,
): SessionMonitor {
  async function stop(
    target: SessionTarget,
    statement: (id: string, instance: string | null) => string,
  ): Promise<void> {
    if (!SESSION_ID.test(target.id))
      throw new PluginError("statementFailed", `"${target.id}" is not an Oracle session id (sid,serial#).`);
    if (target.instance !== null && !INSTANCE.test(target.instance))
      throw new PluginError("statementFailed", `"${target.instance}" is not an Oracle instance number.`);
    const stopper = await open();
    try {
      await stopper.execute(statement(target.id, target.instance));
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    } finally {
      await stopper.close().catch(() => undefined);
    }
  }

  return {
    list: async (): Promise<SessionListing> => {
      try {
        return { sessions: (await rowsOf(connection, SESSIONS_SQL)).map(readOracleSession), notes: [] };
      } catch (cause) {
        if ((cause as { errorNum?: number }).errorNum !== NO_VIEW) {
          throw new PluginError("introspectionFailed", messageOf(cause), { cause });
        }
      }
      try {
        const own = await rowsOf(connection, OWN_SESSION_SQL);
        return { sessions: own.map(readOracleSession), notes: [hiddenSessionsNote(own[0]?.USERNAME ?? "this user")] };
      } catch (cause) {
        throw new PluginError("introspectionFailed", messageOf(cause), { cause });
      }
    },
    cancelSession: (target) => stop(target, cancelStatement),
    terminateSession: (target) => stop(target, terminateStatement),
  };
}
