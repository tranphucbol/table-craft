import { describe, expect, it } from "vitest";
import type { DatasourceView, LastServer, PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { timeoutExplanation } from "@table-craft/desktop/renderer/model/timeoutExplain.js";
import { POSTGRES_PLUGIN, REDIS_PLUGIN, SQLITE_PLUGIN, view } from "./datasourceViews.js";

const DEFAULT_SECONDS = 120;
const SEEN_AT = 1_800_000_000_000;

const MYSQL_PLUGIN: PluginInfo = {
  ...POSTGRES_PLUGIN,
  id: "mysql",
  name: "MySQL",
  capabilities: ["sql", "cancel", "serverTimeout"],
  brands: [
    { id: "mysql", name: "MySQL" },
    { id: "mariadb", name: "MariaDB" },
    { id: "tidb", name: "TiDB" },
  ],
};
const ORACLE_PLUGIN: PluginInfo = { ...POSTGRES_PLUGIN, id: "oracle", name: "Oracle", brands: [] };
const PG_PLUGIN: PluginInfo = { ...POSTGRES_PLUGIN, capabilities: ["sql", "cancel", "serverTimeout"] };
const REDIS_WITH_CANCEL: PluginInfo = { ...REDIS_PLUGIN, capabilities: ["commands", "keyValue", "cancel"] };

const KILL_QUERY = { method: "KILL QUERY", reaches: "statement" } as const;
const MAX_EXECUTION_TIME = { setting: "max_execution_time", covers: "reads", counts: "statement" } as const;

function seen(lastServer: Omit<LastServer, "seenAt">): LastServer {
  return { ...lastServer, seenAt: SEEN_AT };
}

function explain(plugin: PluginInfo, patch: Partial<DatasourceView> = {}) {
  return timeoutExplanation({
    datasource: view({ id: "ds", name: "Shop", pluginId: plugin.id, ...patch }),
    plugin,
    defaultSeconds: DEFAULT_SECONDS,
  });
}

describe("timeoutExplanation", () => {
  it("givenNeverSeen_whenExplained_thenUnseenAndAsksToConnect", () => {
    const explained = explain(MYSQL_PLUGIN);

    expect(explained).toMatchObject({
      tone: "unseen",
      summary: "Connect or test Shop to see how its timeout is enforced.",
      table: { app: { reads: "unknown", writes: "unknown" }, server: { reads: "unknown", writes: "unknown" } },
      seenAt: null,
      version: null,
    });
  });

  it("givenMysqlReadsOnly_whenExplained_thenWritesStoppedByAppOnly", () => {
    const explained = explain(MYSQL_PLUGIN, {
      lastServer: seen({ version: "8.4.3", timeout: MAX_EXECUTION_TIME, cancel: KILL_QUERY }),
    });

    expect(explained).toMatchObject({
      tone: "covered",
      summary: "TableCraft cancels at 120 s; MySQL also stops reads itself.",
      product: "MySQL",
      version: "8.4.3",
      table: { app: { reads: "stops", writes: "stops" }, server: { reads: "stops", writes: "none" } },
      gaps: { reads: false, writes: false },
      seenAt: SEEN_AT,
    });
    expect(explained.sentences.slice(0, 2)).toEqual([
      "TableCraft sends KILL QUERY at 120 s; MySQL stops the work.",
      "MySQL also stops SELECTs at 120 s with max_execution_time, even if TableCraft quits or loses the network.",
    ]);
  });

  it("givenMariadbAll_whenExplained_thenCovered", () => {
    const explained = explain(MYSQL_PLUGIN, {
      brand: "mariadb",
      lastServer: seen({
        version: "10.11.9-MariaDB",
        timeout: { setting: "max_statement_time", covers: "all", counts: "serverWork" },
        cancel: KILL_QUERY,
      }),
    });

    expect(explained).toMatchObject({
      tone: "covered",
      summary: "TableCraft cancels at 120 s; MariaDB also stops every statement.",
      table: { server: { reads: "stops", writes: "stops" } },
    });
    expect(explained.sentences).toContain(
      "MariaDB also stops every statement at 120 s with max_statement_time, even if TableCraft quits or loses the network.",
    );
  });

  it("givenTidbWithoutGlobalKill_whenExplained_thenServerCoversAndAppDropsConnection", () => {
    const explained = explain(MYSQL_PLUGIN, {
      brand: "tidb",
      lastServer: seen({
        version: "5.7.25-TiDB-v5.4.3",
        timeout: { setting: "max_execution_time", covers: "all", counts: "statement" },
        cancel: { method: "connection reset", reaches: "connection" },
      }),
    });

    expect(explained).toMatchObject({
      tone: "covered",
      summary: "TiDB stops every statement at 120 s; TableCraft can only drop the connection.",
      table: {
        app: { reads: "dropsConnection", writes: "dropsConnection" },
        server: { reads: "stops", writes: "stops" },
      },
    });
  });

  it("givenConnectionReachAndReadsOnly_whenExplained_thenWritesGap", () => {
    const explained = explain(MYSQL_PLUGIN, {
      brand: "tidb",
      lastServer: seen({
        version: "8.0.11-TiDB-v9.0.0",
        timeout: MAX_EXECUTION_TIME,
        cancel: { method: "connection reset", reaches: "connection" },
      }),
    });

    expect(explained.tone).toBe("gap");
    expect(explained.gaps).toEqual({ reads: false, writes: true });
    expect(explained.summary).toBe("Writes on TiDB keep running after 120 s: TableCraft can only drop the connection.");
    expect(explained.sentences).toContain("Writes and other statements are not stopped on the server at 120 s.");
  });

  it("givenRedis_whenExplained_thenGapBlockingOnly", () => {
    const explained = explain(REDIS_WITH_CANCEL, {
      lastServer: seen({ version: "7.4.1", cancel: { method: "CLIENT UNBLOCK", reaches: "blockingCommands" } }),
    });

    expect(explained).toMatchObject({
      tone: "gap",
      summary: "TableCraft stops only blocking Redis commands at 120 s.",
      table: {
        app: { reads: "blockingOnly", writes: "blockingOnly" },
        server: { reads: "none", writes: "none" },
      },
      gaps: { reads: true, writes: true },
    });
    expect(explained.sentences).toContain("Redis has no limit of its own here.");
  });

  it("givenNoServerTimeoutCapability_whenExplained_thenAppOnly", () => {
    const explained = explain(ORACLE_PLUGIN, {
      lastServer: seen({ version: "23.5", cancel: { method: "ALTER SYSTEM CANCEL SQL", reaches: "statement" } }),
    });

    expect(explained).toMatchObject({
      tone: "covered",
      summary: "TableCraft cancels at 120 s; Oracle has no limit of its own here.",
      table: { app: { reads: "stops", writes: "stops" }, server: { reads: "none", writes: "none" } },
    });
    expect(explained.sentences.some((sentence) => sentence.includes("fetch_rows"))).toBe(false);
  });

  it("givenOlderPluginWithoutCancelReach_whenExplained_thenClaimsOnlyCancel", () => {
    const allCovered = explain(PG_PLUGIN, {
      lastServer: seen({
        version: "PostgreSQL 17.2",
        timeout: { setting: "statement_timeout", covers: "all", counts: "statement" },
      }),
    });
    const noServerLimit = explain(POSTGRES_PLUGIN, { lastServer: seen({ version: "PostgreSQL 17.2" }) });

    expect(allCovered).toMatchObject({
      tone: "covered",
      summary: "TableCraft cancels at 120 s.",
      table: { app: { reads: "unknown", writes: "unknown" }, server: { reads: "stops", writes: "stops" } },
    });
    expect(allCovered.sentences[0]).toBe("TableCraft cancels the statement at 120 s.");
    expect(noServerLimit.tone).toBe("gap");
    expect(noServerLimit.summary).toBe(
      "TableCraft cancels at 120 s, but cannot say whether PostgreSQL stops the work.",
    );
  });

  it("givenNoCancel_whenExplained_thenGapRunsToEnd", () => {
    const explained = explain(SQLITE_PLUGIN);

    expect(explained).toMatchObject({
      tone: "gap",
      summary: "SQLite cannot stop a running statement: agents' statements run to the end.",
      table: { app: { reads: "none", writes: "none" }, server: { reads: "none", writes: "none" } },
    });
  });

  it("givenOwnTimeout_whenExplained_thenSourceIsDatasource", () => {
    const own = explain(MYSQL_PLUGIN, {
      agentTimeoutSeconds: 30,
      lastServer: seen({ version: "8.4.3", timeout: MAX_EXECUTION_TIME, cancel: KILL_QUERY }),
    });
    const inherited = explain(MYSQL_PLUGIN);

    expect(own).toMatchObject({ seconds: 30, source: "datasource" });
    expect(own.sentences[0]).toBe("TableCraft sends KILL QUERY at 30 s; MySQL stops the work.");
    expect(inherited).toMatchObject({ seconds: DEFAULT_SECONDS, source: "default" });
  });

  it("givenCountsStatement_whenExplained_thenWarnsAboutFetchRows", () => {
    const counted = explain(MYSQL_PLUGIN, {
      lastServer: seen({ version: "8.4.3", timeout: MAX_EXECUTION_TIME, cancel: KILL_QUERY }),
    });
    const serverWork = explain(MYSQL_PLUGIN, {
      lastServer: seen({
        version: "10.11.9-MariaDB",
        timeout: { setting: "max_statement_time", covers: "all", counts: "serverWork" },
        cancel: KILL_QUERY,
      }),
    });

    expect(counted.sentences.at(-1)).toBe(
      "MySQL counts the limit from when the statement started, so an agent paging a result with fetch_rows past 120 s gets the rest cut off.",
    );
    expect(serverWork.sentences.some((sentence) => sentence.includes("fetch_rows"))).toBe(false);
  });
});
