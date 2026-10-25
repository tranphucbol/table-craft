import { describe, expect, it } from "vitest";
import { contractSql } from "@table-craft/plugin-api/testing";

const DIGITS = Array.from({ length: 10 }, (_, digit) => `SELECT ${digit} AS n`).join(" UNION ALL ");
const LARGE_RESULT_BEFORE_053 =
  `SELECT a.n + 10 * b.n + 100 * c.n + 1000 * d.n + 10000 * e.n AS n FROM ` +
  ["a", "b", "c", "d", "e"].map((alias) => `(${DIGITS}) ${alias}`).join(" CROSS JOIN ");

describe("contract sql", () => {
  it("givenDefaultContractSql_whenExistingPluginsRun_thenUnchanged", () => {
    const sql = contractSql({});

    expect(sql.select("1 AS one")).toBe("SELECT 1 AS one");
    expect(sql.largeResult).toBe(LARGE_RESULT_BEFORE_053);
    expect(sql.explainJoin).toBe(
      "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 10",
    );
    expect(sql.dropTableIfExists("t")).toBe("DROP TABLE IF EXISTS t");
    expect(sql.temporaryTable("p", "n INTEGER")).toEqual({ create: "CREATE TEMPORARY TABLE p (n INTEGER)", name: "p" });
    expect(sql.begin).toBe("BEGIN");
    expect(sql.sharedScripts.map((script) => script.text)).toContain("SELECT 'a;b' AS s; SELECT 2 AS n");
  });

  it("givenOracleSelect_whenLargeResultDefaulted_thenEveryDigitSelectsFromDual", () => {
    const sql = contractSql({ sql: { select: (expressions) => `SELECT ${expressions} FROM DUAL` } });

    expect(sql.largeResult.match(/FROM DUAL/g)).toHaveLength(50);
  });
});
