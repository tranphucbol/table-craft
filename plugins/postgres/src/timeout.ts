import type { ServerTimeout } from "@table-craft/plugin-api";

/**
 * PostgreSQL's `statement_timeout` covers every statement and, measured against PostgreSQL 17,
 * keeps counting while a `pg-cursor` result waits to be read: the cursor's `Execute` is sent
 * without a `Sync`, so the statement is still running (decision 129).
 */
export const POSTGRES_SERVER_TIMEOUT: ServerTimeout = { setting: "statement_timeout", covers: "all", counts: "statement" };

export const READ_TIMEOUT_SQL = "SHOW statement_timeout";
export const SET_TIMEOUT_SQL = "SELECT set_config('statement_timeout', $1, false)";
/** SQLSTATE `in_failed_sql_transaction`: the transaction refuses everything until it ends. */
export const FAILED_TRANSACTION = "25P02";

/** A statement naming the setting may have changed it behind the plugin's back. */
const TIMEOUT_SETTING = /statement_timeout/i;

export function namesServerTimeout(sql: string): boolean {
  return TIMEOUT_SETTING.test(sql);
}

/** `SHOW`'s units for a time setting, in milliseconds; a bare number is milliseconds already. */
const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|min|h|d)?$/;

/** `SHOW statement_timeout` as milliseconds: `5s`, `1min`, `250ms`, `0`; anything unreadable is 0, no limit. */
export function postgresDurationMs(text: string): number {
  const match = DURATION.exec(text.trim());
  if (match === null) return 0;
  return Math.round(Number(match[1]) * (UNIT_MS[match[2] ?? "ms"] ?? 1));
}
