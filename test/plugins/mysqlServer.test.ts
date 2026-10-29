import { killStatementFor, MYSQL_SERVER_KINDS, serverDialect } from "@table-craft/plugin-mysql/server";
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
});
