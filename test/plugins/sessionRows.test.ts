import { describe, expect, it } from "vitest";
import {
  grantee,
  readMysqlSessions,
  readTidbSession,
  type ProcessRow,
  type TidbProcessRow,
} from "@table-craft/plugin-mysql/sessions";
import {
  readPostgresSession,
  readPostgresSessions,
  type PostgresSessionRow,
} from "@table-craft/plugin-postgres/sessions";

const PG_ROW: PostgresSessionRow = {
  id: "4242",
  state: "active",
  user: "app",
  database: "shop",
  client: "10.0.0.7:51234",
  application: "psql",
  query_ms: "1500",
  transaction_ms: "2000",
  wait: "Timeout: PgSleep",
  blocked_by: "",
  query: "SELECT pg_sleep(60)",
  backend_type: "client backend",
  me: "app",
};

const MYSQL_ROW: ProcessRow = {
  id: "17",
  user: "app",
  host: "10.0.0.7:51234",
  db: "shop",
  command: "Query",
  time: "3",
  state: "User sleep",
  info: "SELECT SLEEP(60)",
};

/** TSO 469982800666427392 is 1792842104593 ms after the epoch, plus a logical counter of 0. */
const TIDB_ROW: TidbProcessRow = {
  ...MYSQL_ROW,
  command: "Sleep",
  state: "2",
  info: null,
  instance: "0.0.0.0:10080",
  txn_start: "10-24 11:41:44.593(469982800666427392)",
  now_ms: "1792842106593",
};

describe("postgres session rows", () => {
  it("givenActiveRow_whenRead_thenEveryFieldTyped", () => {
    expect(readPostgresSession(PG_ROW)).toEqual({
      id: "4242",
      instance: null,
      state: "active",
      rawState: "active",
      user: "app",
      database: "shop",
      client: "10.0.0.7:51234",
      application: "psql",
      queryMs: 1500,
      transactionMs: 2000,
      waitEvent: "Timeout: PgSleep",
      blockedBy: [],
      query: "SELECT pg_sleep(60)",
      system: false,
      cancel: "SELECT pg_cancel_backend(4242)",
      terminate: "SELECT pg_terminate_backend(4242)",
    });
  });

  it("givenBlockingPids_whenRead_thenBlockedWithIds", () => {
    expect(readPostgresSession({ ...PG_ROW, blocked_by: "7,9" })).toMatchObject({
      state: "blocked",
      blockedBy: ["7", "9"],
    });
  });

  it("givenIdleInTransactionAborted_whenRead_thenIdleInTransaction", () => {
    expect(readPostgresSession({ ...PG_ROW, state: "idle in transaction (aborted)" }).state).toBe("idleInTransaction");
  });

  it("givenBackgroundWorker_whenRead_thenSystemWithoutStatements", () => {
    const row = readPostgresSession({ ...PG_ROW, state: null, backend_type: "checkpointer", query: "" });
    expect(row).toMatchObject({ system: true, state: "other", rawState: "checkpointer", query: null });
    expect(row.cancel).toBeNull();
    expect(row.terminate).toBeNull();
  });

  it("givenInsufficientPrivilegeRow_whenRead_thenNote", () => {
    const listing = readPostgresSessions([
      PG_ROW,
      { ...PG_ROW, id: "5", state: null, query: "<insufficient privilege>", blocked_by: null },
    ]);
    expect(listing.sessions[1]).toMatchObject({ query: null, state: "other", blockedBy: null });
    expect(listing.notes).toEqual([expect.stringContaining("GRANT pg_read_all_stats TO app")]);
  });
});

describe("mysql session rows", () => {
  it("givenQueryRow_whenRead_thenActiveWithSecondsAsMilliseconds", () => {
    expect(readMysqlSessions([MYSQL_ROW], new Map(), [])[0]).toEqual({
      id: "17",
      instance: null,
      state: "active",
      rawState: "Query",
      user: "app",
      database: "shop",
      client: "10.0.0.7:51234",
      application: null,
      queryMs: 3000,
      transactionMs: null,
      waitEvent: "User sleep",
      blockedBy: [],
      query: "SELECT SLEEP(60)",
      system: false,
      cancel: "KILL QUERY 17",
      terminate: "KILL 17",
    });
  });

  it("givenLockWaits_whenRead_thenBlockedByEachBlockerOnce", () => {
    const waits = [
      { waiting: "17", blocking: "3" },
      { waiting: "17", blocking: "3" },
      { waiting: "17", blocking: "4" },
    ];
    expect(readMysqlSessions([MYSQL_ROW], null, waits)[0]).toMatchObject({ state: "blocked", blockedBy: ["3", "4"] });
  });

  it("givenSleepWithTransaction_whenRead_thenIdleInTransactionWithAge", () => {
    const row = readMysqlSessions([{ ...MYSQL_ROW, command: "Sleep" }], new Map([["17", 900]]), null)[0];
    expect(row).toMatchObject({ state: "idleInTransaction", transactionMs: 900, queryMs: null, blockedBy: null });
  });

  it("givenEventScheduler_whenRead_thenSystemWithoutStatements", () => {
    const row = readMysqlSessions([{ ...MYSQL_ROW, user: "event_scheduler", command: "Daemon" }], null, null)[0];
    expect(row).toMatchObject({ system: true, state: "other", cancel: null, terminate: null });
  });

  it("givenCurrentUser_whenGrantee_thenQuotedForAGrant", () => {
    expect(grantee("table_craft@%")).toBe("'table_craft'@'%'");
  });
});

describe("tidb session rows", () => {
  it("givenTidbTxnStart_whenRead_thenTransactionAge", () => {
    expect(readTidbSession(TIDB_ROW, false)).toMatchObject({
      instance: "0.0.0.0:10080",
      state: "idleInTransaction",
      transactionMs: 2000,
      blockedBy: null,
    });
  });

  it("givenNoTransaction_whenRead_thenIdle", () => {
    expect(readTidbSession({ ...TIDB_ROW, txn_start: "" }, false)).toMatchObject({
      state: "idle",
      transactionMs: null,
    });
  });

  it("givenTidbBeforeGlobalKill_whenRead_thenNoCancel", () => {
    expect(readTidbSession(TIDB_ROW, false)).toMatchObject({ cancel: null, terminate: "KILL TIDB 17" });
  });

  it("givenTidbWithGlobalKill_whenRead_thenTidbKillStatements", () => {
    expect(readTidbSession(TIDB_ROW, true)).toMatchObject({ cancel: "KILL TIDB QUERY 17", terminate: "KILL TIDB 17" });
  });
});
