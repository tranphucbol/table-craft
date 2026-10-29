import type { CancelReach, ServerTimeout } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView, PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { datasourceBrand } from "@table-craft/desktop/renderer/model/brand.js";
import { SERVER_COVERS_TEXT } from "@table-craft/desktop/renderer/model/format.js";

/** How far a statement is stopped at the limit, for one row of the coverage table. */
export type Coverage = "stops" | "dropsConnection" | "blockingOnly" | "none" | "unknown";

export type TimeoutTone = "covered" | "gap" | "unseen";

export interface CoverageRow {
  readonly reads: Coverage;
  readonly writes: Coverage;
}

/** What an agent's statement timeout does on one data source (decision 131). */
export interface TimeoutExplanation {
  readonly tone: TimeoutTone;
  /** One line, for the (i)'s title and its accessible description. */
  readonly summary: string;
  readonly seconds: number;
  /** The data source's own agent timeout, or Settings › MCP Server's statement timeout. */
  readonly source: "datasource" | "default";
  /** The brand's name, else the plugin's. */
  readonly product: string;
  readonly version: string | null;
  readonly table: { readonly app: CoverageRow; readonly server: CoverageRow };
  /** Whether each column has no row that stops the statement. */
  readonly gaps: { readonly reads: boolean; readonly writes: boolean };
  readonly sentences: readonly string[];
  readonly seenAt: number | null;
}

export interface TimeoutExplanationInput {
  readonly datasource: DatasourceView;
  readonly plugin: PluginInfo | undefined;
  /** Settings › MCP Server's statement timeout, in seconds. */
  readonly defaultSeconds: number;
}

/**
 * What a `fetch_rows` page past the limit hits, since agents keep up to `MAX_OPEN_RESULTS` results
 * open (`mcp/queryTools.ts`).
 */
const FETCH_ROWS_SENTENCE = (product: string, seconds: string) =>
  `${product} counts the limit from when the statement started, so an agent paging a result with fetch_rows past ${seconds} gets the rest cut off.`;
const SERVER_ALONE_SENTENCE = ", even if TableCraft quits or loses the network.";

function row(coverage: Coverage): CoverageRow {
  return { reads: coverage, writes: coverage };
}

function appRow(plugin: PluginInfo | undefined, cancel: CancelReach | undefined, seen: boolean): CoverageRow {
  if (plugin !== undefined && !plugin.capabilities.includes("cancel")) return row("none");
  if (!seen || cancel === undefined) return row("unknown");
  if (cancel.reaches === "statement") return row("stops");
  return row(cancel.reaches === "connection" ? "dropsConnection" : "blockingOnly");
}

function serverRow(
  plugin: PluginInfo | undefined,
  timeout: ServerTimeout | null | undefined,
  seen: boolean,
): CoverageRow {
  if (plugin !== undefined && !plugin.capabilities.includes("serverTimeout")) return row("none");
  if (!seen || timeout === undefined) return row("unknown");
  if (timeout === null) return row("none");
  return { reads: "stops", writes: timeout.covers === "all" ? "stops" : "none" };
}

function isGap(app: Coverage, server: Coverage): boolean {
  return app !== "stops" && server !== "stops" && !(app === "unknown" && server === "unknown");
}

function seconds(value: number): string {
  return `${String(value)} s`;
}

interface Facts {
  readonly name: string;
  readonly product: string;
  readonly limit: string;
  readonly app: CoverageRow;
  readonly server: CoverageRow;
  readonly gaps: TimeoutExplanation["gaps"];
}

function summaryOf({ name, product, limit, app, server, gaps }: Facts, unseen: boolean): string {
  if (unseen) return `Connect or test ${name} to see how its timeout is enforced.`;
  const serverAll = server.reads === "stops" && server.writes === "stops";
  const serverReads = server.reads === "stops" && server.writes !== "stops";
  const serverNone = server.reads === "none" && server.writes === "none";
  if (app.reads === "none" && serverNone) {
    return `${product} cannot stop a running statement: agents' statements run to the end.`;
  }
  if (app.reads === "blockingOnly" && serverNone) {
    return `TableCraft stops only blocking ${product} commands at ${limit}.`;
  }
  if (app.reads === "dropsConnection") {
    if (serverAll) return `${product} stops every statement at ${limit}; TableCraft can only drop the connection.`;
    const what = serverReads ? "Writes" : "Statements";
    return `${what} on ${product} keep running after ${limit}: TableCraft can only drop the connection.`;
  }
  if (app.reads === "stops") {
    if (serverAll) return `TableCraft cancels at ${limit}; ${product} also stops every statement.`;
    if (serverReads) return `TableCraft cancels at ${limit}; ${product} also stops reads itself.`;
    if (serverNone) return `TableCraft cancels at ${limit}; ${product} has no limit of its own here.`;
    return `TableCraft cancels at ${limit}.`;
  }
  if (app.reads === "unknown" && (gaps.reads || gaps.writes)) {
    return `TableCraft cancels at ${limit}, but cannot say whether ${product} stops the work.`;
  }
  if (gaps.reads && gaps.writes) return `Nothing stops a statement on ${product} at ${limit}.`;
  if (gaps.writes) return `Writes on ${product} keep running after ${limit}.`;
  return `TableCraft cancels at ${limit}.`;
}

function appSentence(product: string, limit: string, app: CoverageRow, cancel: CancelReach | undefined): string {
  switch (app.reads) {
    case "stops":
      return `TableCraft sends ${cancel?.method ?? "a cancel"} at ${limit}; ${product} stops the work.`;
    case "dropsConnection":
      return `TableCraft can only drop the connection at ${limit}; ${product} may keep running the statement.`;
    case "blockingOnly":
      return `TableCraft sends ${cancel?.method ?? "a cancel"} at ${limit}, which stops only commands that wait for data; others run to the end.`;
    case "none":
      return `TableCraft cannot cancel a statement on ${product}; it runs to the end.`;
    case "unknown":
      return `TableCraft cancels the statement at ${limit}.`;
  }
}

function serverSentence(product: string, limit: string, timeout: ServerTimeout | null | undefined): string | null {
  if (timeout === undefined) return null;
  if (timeout === null) return `${product} has no limit of its own here.`;
  return `${product} also stops ${SERVER_COVERS_TEXT[timeout.covers]} at ${limit} with ${timeout.setting}${SERVER_ALONE_SENTENCE}`;
}

function gapSentence(limit: string, gaps: TimeoutExplanation["gaps"]): string | null {
  if (gaps.reads && gaps.writes) return `No statement is sure to stop at ${limit}.`;
  if (gaps.writes) return `Writes and other statements are not stopped on the server at ${limit}.`;
  if (gaps.reads) return `Reads are not stopped on the server at ${limit}.`;
  return null;
}

/**
 * How an agent's statement timeout is enforced on a data source, from its plugin's capabilities and
 * what its server last reported (`lastServer`). Never branches on a plugin or brand id (decision
 * 007): every product name comes from the manifest.
 */
export function timeoutExplanation({
  datasource,
  plugin,
  defaultSeconds,
}: TimeoutExplanationInput): TimeoutExplanation {
  const own = datasource.agentTimeoutSeconds;
  const limitSeconds = own ?? defaultSeconds;
  const limit = seconds(limitSeconds);
  const product =
    datasourceBrand({ connectionBrand: null, storedBrand: datasource.brand, brands: plugin?.brands })?.name ??
    plugin?.name ??
    datasource.pluginId;
  const last = datasource.lastServer;
  const seen = last !== undefined;
  const cancels = plugin?.capabilities.includes("cancel") ?? true;
  const unseen = !seen && cancels;
  const app = appRow(plugin, last?.cancel, seen);
  const server = serverRow(plugin, last?.timeout, seen);
  const gaps = unseen
    ? { reads: false, writes: false }
    : { reads: isGap(app.reads, server.reads), writes: isGap(app.writes, server.writes) };
  const facts: Facts = { name: datasource.name, product, limit, app, server, gaps };
  const tone: TimeoutTone = unseen ? "unseen" : gaps.reads || gaps.writes ? "gap" : "covered";
  const timeout = plugin?.capabilities.includes("serverTimeout") === false ? null : last?.timeout;
  const sentences = unseen
    ? [`TableCraft has not reached ${datasource.name} yet, so it cannot say what stops a statement there.`]
    : [
        appSentence(product, limit, app, last?.cancel),
        serverSentence(product, limit, timeout),
        gapSentence(limit, gaps),
        timeout?.counts === "statement" ? FETCH_ROWS_SENTENCE(product, limit) : null,
      ].filter((sentence): sentence is string => sentence !== null);
  return {
    tone,
    summary: summaryOf(facts, unseen),
    seconds: limitSeconds,
    source: own === undefined ? "default" : "datasource",
    product,
    version: last?.version ?? null,
    table: { app, server },
    gaps,
    sentences,
    seenAt: last?.seenAt ?? null,
  };
}
