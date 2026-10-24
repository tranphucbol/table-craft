import { randomUUID } from "node:crypto";
import type mysql from "mysql2";
import {
  PluginError,
  type ServerSession,
  type ServerSessionState,
  type SessionListing,
  type SessionMonitor,
  type SessionTarget,
} from "@table-craft/plugin-api";
import { tidbGlobalKill } from "./server.js";

/** Numbers as text: ids pass 2^53 on TiDB, and the readers own parsing. */
export const MYSQL_PROCESSLIST_SQL = `
  SELECT CAST(ID AS CHAR) AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command,
    CAST(TIME AS CHAR) AS time, STATE AS state, INFO AS info
  FROM information_schema.PROCESSLIST
  ORDER BY ID`;

/** Needs `PROCESS`; without it the listing cannot tell idle from idle in transaction. */
export const MYSQL_TRANSACTIONS_SQL = `
  SELECT CAST(trx_mysql_thread_id AS CHAR) AS id,
    CAST(TIMESTAMPDIFF(MICROSECOND, trx_started, NOW(6)) DIV 1000 AS CHAR) AS ms
  FROM information_schema.INNODB_TRX`;

/** MySQL 8.0's lock waits, by thread; `threads` maps each thread to its connection id. */
export const MYSQL_LOCK_WAITS_SQL = `
  SELECT CAST(r.PROCESSLIST_ID AS CHAR) AS waiting, CAST(b.PROCESSLIST_ID AS CHAR) AS blocking
  FROM performance_schema.data_lock_waits w
  JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
  JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID`;

/** The `sys` schema's view over the same, also on MySQL 5.7. */
export const SYS_LOCK_WAITS_SQL = `
  SELECT CAST(waiting_pid AS CHAR) AS waiting, CAST(blocking_pid AS CHAR) AS blocking
  FROM sys.innodb_lock_waits`;

/**
 * `TxnStart` reads like `10-24 11:41:44.593(469982800666427392)`, the TSO in brackets; the
 * server's clock comes along so the age needs no client clock.
 */
export const TIDB_PROCESSLIST_SQL = `
  SELECT INSTANCE AS instance, CAST(ID AS CHAR) AS id, USER AS user, HOST AS host, DB AS db,
    COMMAND AS command, CAST(TIME AS CHAR) AS time, STATE AS state, INFO AS info, TxnStart AS txn_start,
    CAST(FLOOR(UNIX_TIMESTAMP(NOW(3)) * 1000) AS CHAR) AS now_ms
  FROM information_schema.CLUSTER_PROCESSLIST
  ORDER BY INSTANCE, ID`;

/**
 * The account and whether it holds `PROCESS`, without which the process list holds only its own
 * threads. TiDB spells privileges in mixed case.
 */
export const PROCESS_PRIVILEGE_SQL = `
  SELECT CURRENT_USER() AS me, (SELECT COUNT(*) FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = CONCAT('''', SUBSTRING_INDEX(CURRENT_USER(), '@', 1), '''@''',
      SUBSTRING_INDEX(CURRENT_USER(), '@', -1), '''')
    AND UPPER(PRIVILEGE_TYPE) = 'PROCESS') > 0 AS process`;

export interface ProcessRow {
  readonly id: string;
  readonly user: string | null;
  readonly host: string | null;
  readonly db: string | null;
  readonly command: string | null;
  readonly time: string | null;
  readonly state: string | null;
  readonly info: string | null;
}

export interface TidbProcessRow extends ProcessRow {
  readonly instance: string | null;
  readonly txn_start: string | null;
  readonly now_ms: string | null;
}

export interface LockWait {
  readonly waiting: string | null;
  readonly blocking: string | null;
}

const MS_PER_SECOND = 1000;
/** A TSO's low bits are a logical counter; the rest is physical milliseconds since the epoch. */
const TSO_LOGICAL_BITS = 18n;
const TSO = /\((\d+)\)\s*$/;

const RUNNING_COMMANDS: ReadonlySet<string> = new Set(["Query", "Execute"]);
const SLEEP_COMMAND = "Sleep";
const SYSTEM_COMMANDS: ReadonlySet<string> = new Set(["Daemon", "Binlog Dump", "Binlog Dump GTID"]);
const SYSTEM_USERS: ReadonlySet<string> = new Set(["event_scheduler", "system user"]);

function nonEmpty(text: string | null): string | null {
  return text === null || text === "" ? null : text;
}

function seconds(text: string | null): number | null {
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value * MS_PER_SECOND : null;
}

function stateOf(
  command: string | null,
  blockedBy: readonly string[] | null,
  inTransaction: boolean,
): ServerSessionState {
  if (command !== null && RUNNING_COMMANDS.has(command)) return (blockedBy?.length ?? 0) > 0 ? "blocked" : "active";
  if (command === SLEEP_COMMAND) return inTransaction ? "idleInTransaction" : "idle";
  return "other";
}

export function isSystemProcess(row: ProcessRow): boolean {
  return (
    (row.command !== null && SYSTEM_COMMANDS.has(row.command)) || (row.user !== null && SYSTEM_USERS.has(row.user))
  );
}

/** What stops a session's query and what ends it, in the server's flavour; null where nothing safely does. */
export interface KillStatements {
  readonly cancel: (id: string) => string | null;
  readonly terminate: (id: string) => string | null;
}

export const MYSQL_KILL: KillStatements = {
  cancel: (id) => `KILL QUERY ${id}`,
  terminate: (id) => `KILL ${id}`,
};

/** TiDB's own spelling, so a MySQL-protocol proxy in front never takes it for its own `KILL`. */
export function tidbKill(globalKill: boolean): KillStatements {
  return {
    // TiDB before Global Kill answers KILL TIDB QUERY with a warning and stops nothing (decision 058).
    cancel: (id) => (globalKill ? `KILL TIDB QUERY ${id}` : null),
    terminate: (id) => `KILL TIDB ${id}`,
  };
}

function waitsByWaiter(waits: readonly LockWait[]): Map<string, string[]> {
  const byWaiter = new Map<string, string[]>();
  for (const { waiting, blocking } of waits) {
    if (waiting === null || blocking === null) continue;
    const blockers = byWaiter.get(waiting) ?? [];
    if (!blockers.includes(blocking)) blockers.push(blocking);
    byWaiter.set(waiting, blockers);
  }
  return byWaiter;
}

/**
 * MySQL's process list, with the transaction ages and lock waits read beside it; either is null
 * when the account cannot read it.
 */
export function readMysqlSessions(
  rows: readonly ProcessRow[],
  transactions: ReadonlyMap<string, number> | null,
  waits: readonly LockWait[] | null,
): ServerSession[] {
  const blockers = waits === null ? null : waitsByWaiter(waits);
  return rows.map((row) => {
    const blockedBy = blockers === null ? null : (blockers.get(row.id) ?? []);
    const transactionMs = transactions?.get(row.id) ?? null;
    return readProcess(row, {
      instance: null,
      blockedBy,
      transactionMs,
      inTransaction: transactionMs !== null,
      kill: MYSQL_KILL,
    });
  });
}

/** One `CLUSTER_PROCESSLIST` row; TiDB reports no lock waits by session here. */
export function readTidbSession(row: TidbProcessRow, globalKill: boolean): ServerSession {
  const started = tsoMilliseconds(row.txn_start);
  const now = row.now_ms === null ? null : Number(row.now_ms);
  const transactionMs = started === null || now === null || !Number.isFinite(now) ? null : Math.max(0, now - started);
  // TiDB's STATE is the connection's server-status bit flags, a number such as 2, not a wait.
  return readProcess(
    { ...row, state: null },
    {
      instance: row.instance,
      blockedBy: null,
      transactionMs,
      inTransaction: started !== null,
      kill: tidbKill(globalKill),
    },
  );
}

function tsoMilliseconds(txnStart: string | null): number | null {
  const tso = txnStart === null ? undefined : TSO.exec(txnStart)?.[1];
  if (tso === undefined || tso === "0") return null;
  return Number(BigInt(tso) >> TSO_LOGICAL_BITS);
}

function readProcess(
  row: ProcessRow,
  extra: {
    readonly instance: string | null;
    readonly blockedBy: readonly string[] | null;
    readonly transactionMs: number | null;
    readonly inTransaction: boolean;
    readonly kill: KillStatements;
  },
): ServerSession {
  const running = row.command !== null && RUNNING_COMMANDS.has(row.command);
  const system = isSystemProcess(row);
  return {
    id: row.id,
    instance: extra.instance,
    state: stateOf(row.command, extra.blockedBy, extra.inTransaction),
    rawState: row.command,
    user: row.user,
    database: row.db,
    client: nonEmpty(row.host),
    application: null,
    // TIME counts the current command; a sleeping thread's last query time is not kept.
    queryMs: running ? seconds(row.time) : null,
    transactionMs: extra.transactionMs,
    waitEvent: running ? nonEmpty(row.state) : null,
    blockedBy: extra.blockedBy,
    query: nonEmpty(row.info),
    system,
    cancel: system ? null : extra.kill.cancel(row.id),
    terminate: system ? null : extra.kill.terminate(row.id),
  };
}

export function processNote(account: string): string {
  return `Only your own threads are listed: ask for GRANT PROCESS ON *.* TO ${account} to see everyone's.`;
}

export function lockWaitNote(account: string): string {
  return `Blocked by is unavailable: ask for GRANT SELECT ON performance_schema.* TO ${account}.`;
}

export const TIDB_LOCK_WAIT_NOTE = "TiDB does not report here which session blocks which, so Blocked by is empty.";
export const TIDB_CANCEL_NOTE =
  "This TiDB version cannot cancel another session's query, and ends a terminated idle connection only when it next sends a statement.";

/** `root@%` as a grant names it: `'root'@'%'`. */
export function grantee(currentUser: string): string {
  const at = currentUser.lastIndexOf("@");
  if (at < 0) return `'${currentUser}'`;
  return `'${currentUser.slice(0, at)}'@'${currentUser.slice(at + 1)}'`;
}

const ID = /^\d+$/;
/**
 * How many fresh connections a pre-Global-Kill terminate tries before giving up on reaching the
 * session's server: behind a load balancer over four servers, 20 tries all miss 0.3% of the time.
 */
const INSTANCE_ATTEMPTS = 20;

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function rows<T>(connection: mysql.Connection, sql: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    connection.query(sql, (error, result) => {
      if (error === null) resolve(result as T[]);
      else reject(error);
    });
  });
}

function end(connection: mysql.Connection): Promise<void> {
  return new Promise((resolve) => {
    connection.end(() => resolve());
  });
}

async function optional<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch {
    return null;
  }
}

/**
 * The TiDB server `connection` landed on, as `CLUSTER_PROCESSLIST` names it: the connection finds
 * its own row by a nonce, since an id alone may repeat on another server before Global Kill.
 */
export async function tidbInstanceOf(connection: mysql.Connection): Promise<string | null> {
  const nonce = randomUUID();
  const here = await rows<{ instance: string }>(
    connection,
    `SELECT INSTANCE AS instance FROM information_schema.CLUSTER_PROCESSLIST WHERE ID = CONNECTION_ID() AND INFO LIKE '%${nonce}%'`,
  );
  return here[0]?.instance ?? null;
}

/**
 * Lists on the session's own connection, queued behind whatever else it runs; stops on a fresh
 * connection, as `#killQuery` does, so stopping the listing session itself still answers.
 */
export function mysqlSessions(
  connection: mysql.Connection,
  serverVersion: string | null,
  open: () => Promise<mysql.Connection>,
): SessionMonitor {
  const globalKill = tidbGlobalKill(serverVersion);
  const kill = globalKill === null ? MYSQL_KILL : tidbKill(globalKill);

  async function list(): Promise<SessionListing> {
    try {
      const [privilege] = await rows<{ me: string; process: unknown }>(connection, PROCESS_PRIVILEGE_SQL);
      const account = grantee(privilege?.me ?? "");
      const notes: string[] = [];
      if (Number(privilege?.process) !== 1) notes.push(processNote(account));
      if (globalKill !== null) {
        const listed = await rows<TidbProcessRow>(connection, TIDB_PROCESSLIST_SQL);
        notes.push(TIDB_LOCK_WAIT_NOTE);
        if (!globalKill) notes.push(TIDB_CANCEL_NOTE);
        return { sessions: listed.map((row) => readTidbSession(row, globalKill)), notes };
      }
      const listed = await rows<ProcessRow>(connection, MYSQL_PROCESSLIST_SQL);
      const transactions = await optional(rows<{ id: string; ms: string }>(connection, MYSQL_TRANSACTIONS_SQL));
      const waits =
        (await optional(rows<LockWait>(connection, MYSQL_LOCK_WAITS_SQL))) ??
        (await optional(rows<LockWait>(connection, SYS_LOCK_WAITS_SQL)));
      if (waits === null) notes.push(lockWaitNote(account));
      const ages = transactions === null ? null : new Map(transactions.map((row) => [row.id, Number(row.ms)]));
      return { sessions: readMysqlSessions(listed, ages, waits), notes };
    } catch (cause) {
      throw new PluginError("introspectionFailed", messageOf(cause), { cause });
    }
  }

  /**
   * Before Global Kill an id names a session on one TiDB server only, and a fresh connection may
   * land on another behind the load balancer (decision 058). The connection proves where it landed
   * by finding its own row, marked with a nonce, in the cluster's process list.
   */
  async function reach(target: SessionTarget): Promise<mysql.Connection> {
    if (globalKill !== false) return open();
    if (target.instance === null) throw stopFailed(target, "the TiDB server it lives on is unknown");
    for (let attempt = 0; attempt < INSTANCE_ATTEMPTS; attempt += 1) {
      const candidate = await open();
      const here = await tidbInstanceOf(candidate).catch(async (cause: unknown) => {
        await end(candidate);
        throw cause;
      });
      if (here === target.instance) return candidate;
      await end(candidate);
    }
    throw stopFailed(target, `no connection reached its TiDB server ${target.instance}, so nothing was killed`);
  }

  async function stop(target: SessionTarget, statement: string | null): Promise<void> {
    if (!ID.test(target.id)) throw stopFailed(target, "it is not a connection id");
    if (statement === null) throw stopFailed(target, "this server cannot do that safely");
    const killer = await reach(target);
    try {
      await rows(killer, statement);
    } catch (cause) {
      throw new PluginError("statementFailed", messageOf(cause), { cause });
    } finally {
      await end(killer);
    }
  }

  return {
    list,
    cancelSession: (target) => stop(target, kill.cancel(target.id)),
    terminateSession: (target) => stop(target, kill.terminate(target.id)),
  };
}

function stopFailed(target: SessionTarget, reason: string): PluginError {
  return new PluginError("statementFailed", `Session ${target.id} was not stopped: ${reason}.`);
}
