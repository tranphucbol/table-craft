import {
  STATEMENT_CANCELLED_MESSAGE,
  type CurrentNamespace,
  type EngineError,
  type Reconnection,
  type ServerTimeout,
  type StatementKind,
} from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import type { ConsoleSession } from "@table-craft/desktop/renderer/state/consoles.js";
import { ENGINE_EXITED_HINT, type Connection } from "@table-craft/desktop/renderer/state/datasources.js";

const MS_PER_SECOND = 1000;

/** `12 ms` under a second, `1.4 s` above, as DataGrip's Services window shows a run. */
export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${Math.round(ms)} ms`;
  return `${(ms / MS_PER_SECOND).toFixed(1)} s`;
}

function rows(count: number): string {
  return `${count} ${count === 1 ? "row" : "rows"}`;
}

/**
 * An Output line for a statement that ran: `3 rows retrieved in 38 ms`, `500+ rows retrieved` while
 * more wait in the cursor, `1 row affected in 12 ms`, or `completed in 44 ms` for DDL and the rest,
 * whose affected count is the driver's 0, not a fact.
 */
export function executedText(
  summary: {
    readonly columns: readonly unknown[];
    readonly rowCount: number;
    readonly complete: boolean;
    readonly rowsAffected: number | null;
    readonly reply?: { readonly text: string };
  },
  ms: number,
  kind: StatementKind,
): string {
  if (summary.reply !== undefined) return `→ ${summary.reply.text} · ${formatDuration(ms)}`;
  const took = `in ${formatDuration(ms)}`;
  if (summary.columns.length === 0) {
    if (kind !== "write" || summary.rowsAffected === null) return `completed ${took}`;
    return `${rows(summary.rowsAffected)} affected ${took}`;
  }
  if (!summary.complete) return `${formatCount(summary.rowCount)}+ rows retrieved ${took}`;
  return `${rows(summary.rowCount)} retrieved ${took}`;
}

/** The Output line an explain leaves: `Explained in 4 ms`, or `Analysed in 12 ms` when it ran. */
export function explainedText(analyzed: boolean, ms: number): string {
  return `${analyzed ? "Analysed" : "Explained"} in ${formatDuration(ms)}`;
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** `50,000`: grouped the way the grid's row count reads. */
export function formatCount(count: number): string {
  return COUNT_FORMAT.format(count);
}

const BYTES_PER_KIB = 1024;
const BYTE_UNITS = ["bytes", "KB", "MB", "GB"] as const;

/** `812 bytes`, `1.4 MB`. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_KIB && unit < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_KIB;
    unit++;
  }
  return unit === 0 ? `${formatCount(bytes)} bytes` : `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** The Output line an export leaves: `50,000 rows exported to /tmp/a.csv (1.4 MB) in 1.2 s`. */
export function exportedText(exported: {
  readonly path: string;
  readonly rows: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}): string {
  const count = exported.rows === 1 ? "1 row" : `${formatCount(exported.rows)} rows`;
  return `${count} exported to ${exported.path} (${formatBytes(exported.bytes)}) in ${formatDuration(exported.elapsedMs)}`;
}

/**
 * The grid toolbar's row count (plan 007 decision 2): `5,000 rows` when all are fetched,
 * `500+ rows` while the cursor holds more, and why fetching ended when it ended early. While a
 * local filter hides rows (plan 023) it leads with the shown ones: `1,284 of 5,000 rows`.
 */
export function resultStateText(result: {
  readonly rowCount: number;
  readonly complete: boolean;
  readonly cursorOpen: boolean;
  readonly sorted: boolean;
  readonly fetchAllCap: number;
  readonly shown?: number | null;
}): string {
  const count = formatCount(result.rowCount);
  const shown = result.shown ?? null;
  if (shown !== null) {
    const parts = [`${formatCount(shown)} of ${count}${result.complete ? "" : "+"} rows`, "filtered locally"];
    if (!result.complete && !result.cursorOpen) {
      parts.push(result.rowCount >= result.fetchAllCap ? "fetch cap reached" : "fetching stopped");
    }
    if (result.sorted) parts.push("sorted locally");
    return parts.join(" · ");
  }
  if (result.complete) return result.rowCount === 1 ? "1 row" : `${count} rows`;
  const parts = [`${count}+ rows`];
  if (!result.cursorOpen) parts.push(result.rowCount >= result.fetchAllCap ? "fetch cap reached" : "fetching stopped");
  if (result.sorted) parts.push("sorted locally");
  return parts.join(" · ");
}

/** The first line of a statement, as the Output log and result tooltips name it. */
export function firstLine(sql: string): string {
  return sql.trimStart().split("\n", 1)[0]?.trimEnd() ?? "";
}

export type ServiceState = "connecting" | "idle" | "running" | "waiting" | "asking" | "failed" | "disconnected";

/** How a Services session row words its state. */
export const SERVICE_STATE_TEXT: Readonly<Record<ServiceState, string>> = {
  connecting: "connecting",
  idle: "idle",
  running: "running",
  waiting: "waiting for confirmation…",
  asking: "waiting on a failed statement",
  failed: "failed",
  disconnected: "disconnected",
};

/** A console as the Services window lists it. */
export function serviceState(console: ConsoleSession): ServiceState {
  if (console.status === "connecting") return "connecting";
  if (console.status === "running") return "running";
  if (console.status === "confirming") return console.question === null ? "waiting" : "asking";
  if (console.status === "disconnected") return "disconnected";
  if (console.status === "failed" || console.lastRun?.outcome === "failed") return "failed";
  return "idle";
}

const CONNECTION_TEXT = {
  disconnected: "disconnected",
  connecting: "connecting…",
  connected: "connected",
  failed: "failed",
} as const;

/** The tree's word for a connection: `failed: engine exited` when its engine crashed. */
export function connectionText(connection: Connection): string {
  if (connection.status === "failed" && connection.error?.hint === ENGINE_EXITED_HINT) return "failed: engine exited";
  return CONNECTION_TEXT[connection.status];
}

/** `PostgreSQL 17.4`, once a connect has reported a version. */
export function serverText(pluginName: string | null, connection: Connection): string | null {
  if (connection.serverVersion === null) return null;
  return pluginName === null ? connection.serverVersion : `${pluginName} ${connection.serverVersion}`;
}

/** The status bar's datasource item: `pg · connected · PostgreSQL 17.4`, or the connect error. */
export function datasourceText(datasource: DatasourceView, pluginName: string | null, connection: Connection): string {
  if (connection.status === "failed" && connection.error !== null) {
    return `${datasource.name} · ${connection.error.message}`;
  }
  const server = connection.status === "connected" ? serverText(pluginName, connection) : null;
  const parts = [datasource.name, connectionText(connection)];
  if (server !== null) parts.push(server);
  return parts.join(" · ");
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** `just now`, `2 min ago`, `3 h ago`, `2 d ago`; coarse, because the status bar ticks once a minute. */
export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / MS_PER_MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours} h ago`;
  return `${Math.floor(hours / HOURS_PER_DAY)} d ago`;
}

/** The status bar's sync item: `public synchronized (38 ms) · 2 min ago`. */
export function syncText(namespace: string, introspectedAt: number, elapsedMs: number, now: number): string {
  return `${namespace} synchronized (${formatDuration(elapsedMs)}) · ${relativeTime(introspectedAt, now)}`;
}

/** The status bar's sync item for a namespace that failed: what went wrong, then what to do. */
export function syncFailedText(namespace: string, error: EngineError): string {
  return `${namespace} failed: ${error.message} ${error.hint}`;
}

/** A console tab's label (plan 004): `console [pg]`. */
export function tabLabel(title: string, datasourceName: string | undefined): string {
  return datasourceName === undefined ? title : `${title} [${datasourceName}]`;
}

/** A Sessions tab's label (plan 045): `Sessions · pg`, since the tab belongs to the data source, not a console. */
export function sessionsTabLabel(title: string, datasourceName: string | undefined): string {
  return datasourceName === undefined ? title : `${title} · ${datasourceName}`;
}

const RECONNECTED_BECAUSE: Readonly<Record<NonNullable<Reconnection["reason"]> | "lost", string>> = {
  lost: "Reconnected: the connection had been lost.",
  resultNotClosed: "The previous result could not be closed in time; reconnected.",
  sessionBusy: "The session was stuck on an earlier result; reconnected.",
};

/** What Output says for a cancelled statement, with what else the cancel did (decision 058). */
export function cancelledText(error: EngineError): string {
  return error.message === STATEMENT_CANCELLED_MESSAGE ? "Cancelled" : `Cancelled: ${error.message}`;
}

/** What Output says when the engine replaced a session before a statement (decisions 054, 058). */
export function reconnectedText(reconnected: Reconnection): string {
  const lost = RECONNECTED_BECAUSE[reconnected.reason ?? "lost"];
  const where = namespaceLabel(reconnected.namespace)?.title;
  if (!reconnected.namespaceLost) return lost;
  const starts = where === undefined ? "The new session starts" : `The new session starts in ${where}`;
  return `${lost} ${starts}; the USE or search path set earlier no longer applies.`;
}

/**
 * The console toolbar's namespace label (plan 022): the database or schema itself, with the full
 * dotted path as its tooltip; null hides it.
 */
export function namespaceLabel(namespace: CurrentNamespace): { readonly text: string; readonly title: string } | null {
  const text = namespace?.at(-1);
  return namespace === null || text === undefined ? null : { text, title: namespace.join(".") };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/** `14:03:07` in local time: when a Services execution started. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

/** A history entry's time (plan 011 decision 8): `14:03:07` today, `2026-10-21 09:15` before. */
export function historyTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return clockTime(at);
  const day = `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
  return `${day} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
}

/** `12 rows`, `1 row`: a history entry's or execution's count. */
export function rowsText(count: number): string {
  return rows(count);
}

/** "limit: max_execution_time, SELECT only": the setting Test Connection found (decision 129). */
export function serverLimitText(serverTimeout: ServerTimeout): string {
  return `limit: ${serverTimeout.setting}${serverTimeout.covers === "reads" ? ", SELECT only" : ""}`;
}

/** What a server's own limit stops, in words, for Data Sources and Settings › MCP Server (decision 131). */
export const SERVER_COVERS_TEXT: Readonly<Record<ServerTimeout["covers"], string>> = {
  reads: "SELECTs",
  all: "every statement",
};

/**
 * What ticking "Also have the database stop it" does on this server: unknown until a test
 * (`undefined`), nothing on a server without a limit (`null`).
 */
export function serverTimeoutText(serverTimeout: ServerTimeout | null | undefined): string {
  if (serverTimeout === undefined) return "Test the connection to see what the database stops.";
  if (serverTimeout === null) return "This server cannot stop statements by itself; the app still cancels them.";
  const what = SERVER_COVERS_TEXT[serverTimeout.covers];
  return serverTimeout.counts === "statement"
    ? `The database stops ${what} at the limit, counting while rows wait to be read.`
    : `The database stops ${what} that works past the limit.`;
}
