import type { ResultPaging } from "@table-craft/desktop/engine/protocol.js";
import { formatCount } from "@table-craft/desktop/renderer/model/format.js";
import {
  PAGE_ROWS_RANGE,
  STATEMENT_TIMEOUT_SECONDS_RANGE,
  pageRowsError,
  type NumberRange,
} from "@table-craft/desktop/settings/settings.js";

/** How many rows a console's run reads (plan 141 decision 2). */
export type RowsChoice =
  { readonly kind: "default" } | { readonly kind: "page"; readonly pageRows: number } | { readonly kind: "all" };

/** How long a console's statement may run (plan 141 decision 2). */
export type TimeoutChoice =
  { readonly kind: "default" } | { readonly kind: "seconds"; readonly seconds: number } | { readonly kind: "none" };

/** One console's overrides of the run limits (decision 148); Default follows Settings. */
export interface RunSettings {
  readonly rows: RowsChoice;
  readonly timeout: TimeoutChoice;
}

export const DEFAULT_RUN_SETTINGS: RunSettings = { rows: { kind: "default" }, timeout: { kind: "default" } };

/** 0 is None, a choice of its own, so a custom timeout starts at one second. */
export const RUN_TIMEOUT_RANGE: NumberRange = { min: 1, max: STATEMENT_TIMEOUT_SECONDS_RANGE.max };

export const RUN_ROWS_RANGE: NumberRange = PAGE_ROWS_RANGE;

export function runRowsError(pageRows: number): string | null {
  return pageRowsError(pageRows);
}

export function runTimeoutError(seconds: number): string | null {
  if (!Number.isInteger(seconds)) return "The timeout must be a whole number.";
  if (seconds < RUN_TIMEOUT_RANGE.min || seconds > RUN_TIMEOUT_RANGE.max) {
    return `The timeout must be between ${formatCount(RUN_TIMEOUT_RANGE.min)} and ${formatCount(RUN_TIMEOUT_RANGE.max)} seconds.`;
  }
  return null;
}

/**
 * The paging a run sends: a custom page size raises the Fetch All limit to at least itself, since
 * the engine refuses a page larger than the cap.
 */
export function pagingWith(base: ResultPaging, rows: RowsChoice): ResultPaging {
  if (rows.kind !== "page") return base;
  return { pageRows: rows.pageRows, fetchAllCap: Math.max(base.fetchAllCap, rows.pageRows) };
}

/** Whether a run fetches the rest of its result as soon as it opens (plan 141 decision 4). */
export function fetchesAll(settings: RunSettings): boolean {
  return settings.rows.kind === "all";
}

/** The seconds a statement may run, 0 for none: the console's choice over `base` (decision 148). */
export function timeoutWith(base: number, timeout: TimeoutChoice): number {
  if (timeout.kind === "seconds") return timeout.seconds;
  if (timeout.kind === "none") return 0;
  return base;
}

export const CONSOLE_TIMEOUT_HINT =
  "This console's own timeout stopped it; raise it in Run Settings, or set it back to Default.";

/**
 * The engine's timeout hint points at the data source and Settings, which a console's own timeout
 * overrides, so following it would change nothing.
 */
export function withRunSettingsHint<E extends { readonly code: string; readonly hint: string | null }>(
  error: E,
  timeout: TimeoutChoice,
): E {
  if (error.code !== "statementTimedOut" || timeout.kind !== "seconds") return error;
  return { ...error, hint: CONSOLE_TIMEOUT_HINT };
}

/** Whether a failure carries the hint `withRunSettingsHint` gave it, so it can offer Run Settings. */
export function causedByRunSettings(error: { readonly hint: string | null }): boolean {
  return error.hint === CONSOLE_TIMEOUT_HINT;
}

export function isDefaultRunSettings(settings: RunSettings): boolean {
  return settings.rows.kind === "default" && settings.timeout.kind === "default";
}

/**
 * The settings as they act: a custom value equal to what Default gives changes nothing, so the
 * gear marks no override for it.
 */
export function effectiveRunSettings(
  settings: RunSettings,
  defaults: { readonly pageRows: number; readonly timeoutSeconds: number },
): RunSettings {
  const { rows, timeout } = settings;
  const sameTimeout = timeoutWith(defaults.timeoutSeconds, timeout) === defaults.timeoutSeconds;
  return {
    rows: rows.kind === "page" && rows.pageRows === defaults.pageRows ? { kind: "default" } : rows,
    timeout: sameTimeout ? { kind: "default" } : timeout,
  };
}

function rowsText(rows: RowsChoice): string | null {
  if (rows.kind === "page") return `Page size ${formatCount(rows.pageRows)}`;
  if (rows.kind === "all") return "All rows";
  return null;
}

function timeoutText(timeout: TimeoutChoice): string | null {
  if (timeout.kind === "seconds") return `Timeout ${formatCount(timeout.seconds)} s`;
  if (timeout.kind === "none") return "No timeout";
  return null;
}

/** What the gear's tooltip names while the console overrides anything; null at Default. */
export function runSettingsSummary(settings: RunSettings): string | null {
  const parts = [rowsText(settings.rows), timeoutText(settings.timeout)].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
