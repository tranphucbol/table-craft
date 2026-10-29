import {
  cancelReachOf,
  CONNECTION_RESET_METHOD,
  killStatementFor,
  MYSQL_SERVER_KINDS,
  ownTimeoutMs,
  serverDialect,
  serverTimeoutOf,
  serverTimeoutSql,
  stoppedAtLimit,
  stoppedAtLimitMessage,
} from "@table-craft/plugin-mysql/server";
import { describe, expect, it } from "vitest";
import { MYSQL_MANIFEST } from "../support/manifests.js";

const CONNECTION_ID = 42;

describe("mysql server dialect", () => {
  it("givenMysql_whenDialect_thenMysqlWithRelease", () => {
    expect(serverDialect("8.4.3")).toEqual({ kind: "mysql", version: [8, 4, 3] });
    expect(serverDialect("5.7.44-log")).toEqual({ kind: "mysql", version: [5, 7, 44] });
  });

  it("givenMariadb_whenDialect_thenMariadbWithItsOwnRelease", () => {
    expect(serverDialect("10.11.8-MariaDB-log")).toEqual({ kind: "mariadb", version: [10, 11, 8] });
    expect(serverDialect("11.4.2-MariaDB-ubu2404")).toEqual({ kind: "mariadb", version: [11, 4, 2] });
  });

  it("givenMariadbHandshakePrefix_whenDialect_thenReleasePastPrefix", () => {
    expect(serverDialect("5.5.5-10.11.8-MariaDB")).toEqual({ kind: "mariadb", version: [10, 11, 8] });
  });

  it("givenTidb_whenDialect_thenTidbWithItsOwnRelease", () => {
    expect(serverDialect("5.7.25-TiDB-v4.0.14")).toEqual({ kind: "tidb", version: [4, 0, 14] });
    expect(serverDialect("8.0.11-TiDB-v7.5")).toEqual({ kind: "tidb", version: [7, 5] });
  });

  it("givenUnreadableOrNull_whenDialect_thenMysqlWithoutRelease", () => {
    expect(serverDialect("unknown")).toEqual({ kind: "mysql", version: null });
    expect(serverDialect(null)).toEqual({ kind: "mysql", version: null });
  });
});

describe("mysql server brand", () => {
  it("givenTidbVersion_whenServerBrand_thenTidb", () => {
    expect(serverDialect("8.0.11-TiDB-v7.5.1").kind).toBe("tidb");
  });

  it("givenMariadbVersion_whenServerBrand_thenMariadb", () => {
    expect(serverDialect("5.5.5-10.11.8-MariaDB").kind).toBe("mariadb");
  });

  it("givenMysqlOrNullVersion_whenServerBrand_thenMysql", () => {
    expect(serverDialect("8.4.3").kind).toBe("mysql");
    expect(serverDialect(null).kind).toBe("mysql");
  });

  it("givenServerKinds_whenComparedWithManifestBrands_thenSameIdsDefaultFirst", () => {
    expect(MYSQL_MANIFEST.brands?.map((brand) => brand.id)).toEqual([...MYSQL_SERVER_KINDS]);
    expect(MYSQL_MANIFEST.brands?.[0]?.id).toBe(serverDialect(null).kind);
  });
});

describe("mysql kill statement", () => {
  it("givenMysql_whenKillStatement_thenKillQuery", () => {
    expect(killStatementFor("8.4.3", CONNECTION_ID)).toBe("KILL QUERY 42");
  });

  it("givenUnknownVersion_whenKillStatement_thenKillQuery", () => {
    expect(killStatementFor(null, CONNECTION_ID)).toBe("KILL QUERY 42");
  });

  it("givenTidbWithGlobalKill_whenKillStatement_thenKillTidbQuery", () => {
    expect(killStatementFor("8.0.11-TiDB-v6.1.0", CONNECTION_ID)).toBe("KILL TIDB QUERY 42");
    expect(killStatementFor("8.0.11-TiDB-v7.5.1", CONNECTION_ID)).toBe("KILL TIDB QUERY 42");
  });

  it("givenTidbBeforeGlobalKill_whenKillStatement_thenNone", () => {
    expect(killStatementFor("5.7.25-TiDB-v4.0.14", CONNECTION_ID)).toBeNull();
    expect(killStatementFor("5.7.25-TiDB-v6.0.0", CONNECTION_ID)).toBeNull();
  });

  it("givenEachDialect_whenCancelReachRead_thenMatchesKillStatement", () => {
    const versions = [
      "8.4.3",
      "10.11.10-MariaDB",
      "5.7.25-TiDB-v4.0.14",
      "5.7.25-TiDB-v6.0.0",
      "8.0.11-TiDB-v6.1.0",
      "8.0.11-TiDB-v7.5.1",
    ];
    for (const version of versions) {
      const kill = killStatementFor(version, CONNECTION_ID);
      const reach = cancelReachOf(version);
      if (kill === null) {
        expect(reach).toEqual({ method: CONNECTION_RESET_METHOD, reaches: "connection" });
      } else {
        expect(reach.reaches).toBe("statement");
        expect(kill).toBe(`${reach.method} ${String(CONNECTION_ID)}`);
      }
    }
  });
});

const READS = { setting: "max_execution_time", covers: "reads", counts: "statement" };
const TIDB_ALL = { setting: "max_execution_time", covers: "all", counts: "statement" };
const MARIADB_ALL = { setting: "max_statement_time", covers: "all", counts: "statement" };

function timeoutOf(serverVersion: string | null) {
  return serverTimeoutOf(serverDialect(serverVersion));
}

describe("mysql server timeout", () => {
  it("givenMysql847_whenDialect_thenMysqlReadsStatement", () => {
    expect(timeoutOf("8.4.7")).toEqual(READS);
    expect(timeoutOf("8.4.3")).toEqual(READS);
  });

  it("givenMysql577_whenDialect_thenNoServerTimeout", () => {
    expect(timeoutOf("5.7.7-log")).toBeNull();
    expect(timeoutOf("5.7.8")).toEqual(READS);
  });

  it("givenMariadb5555Prefix_whenDialect_thenMariadbVersionPastPrefix", () => {
    expect(timeoutOf("10.11.6-MariaDB")).toEqual(MARIADB_ALL);
    expect(timeoutOf("5.5.5-10.0.38-MariaDB")).toBeNull();
  });

  it("givenMariadb1000_whenDialect_thenNoServerTimeout", () => {
    expect(timeoutOf("10.0.0-MariaDB")).toBeNull();
    expect(timeoutOf("10.1.1-MariaDB")).toEqual(MARIADB_ALL);
  });

  it("givenTidb4_whenDialect_thenCoversAll", () => {
    expect(timeoutOf("8.0.11-TiDB-v4.0.16")).toEqual(TIDB_ALL);
    expect(timeoutOf("5.7.25-TiDB-v4.0.14")).toEqual(TIDB_ALL);
  });

  it("givenTidb75_whenDialect_thenCoversReads", () => {
    expect(timeoutOf("8.0.11-TiDB-v7.5.1")).toEqual(READS);
  });

  it("givenUnreadableVersion_whenDialect_thenNoServerTimeout", () => {
    expect(timeoutOf(null)).toBeNull();
  });

  it("givenMariadb_whenTimeoutSql_thenSecondsWithFraction", () => {
    expect(serverTimeoutSql(serverDialect("10.11.6-MariaDB"), 1_500)).toBe("SET SESSION max_statement_time = 1.5");
    expect(ownTimeoutMs(serverDialect("10.11.6-MariaDB"), 2.5)).toBe(2_500);
  });

  it("givenZeroMs_whenTimeoutSql_thenUnlimited", () => {
    expect(serverTimeoutSql(serverDialect("8.4.7"), 0)).toBe("SET SESSION max_execution_time = 0");
    expect(serverTimeoutSql(serverDialect("10.11.6-MariaDB"), 0)).toBe("SET SESSION max_statement_time = 0");
    expect(ownTimeoutMs(serverDialect("5.7.25-TiDB-v4.0.14"), "0")).toBe(0);
  });

  it("givenTidb1317_whenRanPastLimit_thenStoppedAtLimitElseKill", () => {
    const tidb = serverDialect("5.7.25-TiDB-v4.0.14");

    expect(stoppedAtLimit(tidb, 1317, 1_600, 1_500)).toBe(true);
    expect(stoppedAtLimit(tidb, 1317, 900, 1_500)).toBe(false);
    expect(stoppedAtLimit(tidb, 1317, 1_600, null)).toBe(false);
    expect(stoppedAtLimit(serverDialect("8.4.7"), 1317, 1_600, 1_500)).toBe(false);
    expect(stoppedAtLimit(serverDialect("8.4.7"), 3024, 0, null)).toBe(true);
    expect(stoppedAtLimit(serverDialect("10.11.6-MariaDB"), 1969, 0, null)).toBe(true);
    expect(stoppedAtLimitMessage(tidb, 1_500)).toBe(
      "TiDB stopped the statement at its 1.5 s limit (max_execution_time).",
    );
  });
});
