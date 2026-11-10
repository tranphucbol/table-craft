import { describe, expect, it } from "vitest";
import { sqlRowLimiter } from "@table-craft/plugin-api/sql";

const MYSQL = sqlRowLimiter({ backslashEscapes: true, hashComments: true, delimiterCommand: true }, "limit");
const POSTGRES = sqlRowLimiter({ dollarQuotes: true, nestedBlockComments: true }, "limit");
const ORACLE = sqlRowLimiter({ qQuotes: true, nationalStrings: true, batchSeparator: "slash" }, "fetchFirst");
const MSSQL = sqlRowLimiter({ bracketIdentifiers: true, variables: true, batchSeparator: "go" }, "top");

describe("sqlRowLimiter", () => {
  it("givenPlainSelect_whenLimited_thenLimitIsAppended", () => {
    expect(MYSQL.limit("SELECT * FROM orders", 501)).toEqual({
      sql: "SELECT * FROM orders LIMIT 501",
      inserted: { offset: 20, length: 10 },
    });
  });

  it("givenTrailingSemicolonAndComment_whenLimited_thenLimitGoesBeforeThem", () => {
    expect(MYSQL.limit("SELECT * FROM orders ; -- all of them", 5)?.sql).toBe(
      "SELECT * FROM orders LIMIT 5 ; -- all of them",
    );
  });

  it("givenOrderBy_whenLimited_thenLimitFollowsTheOrder", () => {
    expect(POSTGRES.limit("select id from t order by id desc", 10)?.sql).toBe(
      "select id from t order by id desc LIMIT 10",
    );
  });

  it("givenWithClause_whenLimited_thenTheMainSelectIsLimited", () => {
    expect(POSTGRES.limit("WITH a AS (SELECT 1 AS x LIMIT 3) SELECT x FROM a", 2)?.sql).toBe(
      "WITH a AS (SELECT 1 AS x LIMIT 3) SELECT x FROM a LIMIT 2",
    );
  });

  it("givenLimitInsideSubquery_whenLimited_thenTheOuterSelectIsLimited", () => {
    expect(MYSQL.limit("SELECT * FROM (SELECT id FROM t LIMIT 3) s", 2)?.sql).toBe(
      "SELECT * FROM (SELECT id FROM t LIMIT 3) s LIMIT 2",
    );
  });

  it("givenUnion_whenLimitedWithLimit_thenTheWholeResultIsLimited", () => {
    expect(MYSQL.limit("SELECT 1 UNION ALL SELECT 2", 1)?.sql).toBe("SELECT 1 UNION ALL SELECT 2 LIMIT 1");
  });

  it.each([
    ["an own LIMIT", "SELECT * FROM t LIMIT 10"],
    ["an own OFFSET", "SELECT * FROM t OFFSET 10"],
    ["an own FETCH", "SELECT * FROM t FETCH FIRST 3 ROWS ONLY"],
    ["INTO", "SELECT * INTO copy FROM t"],
    ["a locking read", "SELECT * FROM t FOR UPDATE"],
    ["LOCK IN SHARE MODE", "SELECT * FROM t LOCK IN SHARE MODE"],
    ["a data-modifying CTE", "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"],
    ["another verb", "UPDATE t SET a = 1"],
    ["a CTE feeding an insert", "WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a"],
    ["SHOW", "SHOW TABLES"],
    ["a parenthesised select", "(SELECT 1)"],
    ["two statements", "SELECT 1; SELECT 2"],
    ["nothing", "  -- only a comment"],
  ])("givenStatementWith %s_whenLimited_thenNull", (_what, sql) => {
    expect(MYSQL.limit(sql, 5)).toBeNull();
  });

  it("givenLimitWordInAString_whenLimited_thenStillLimited", () => {
    expect(MYSQL.limit("SELECT 'LIMIT 3' AS label FROM t", 4)?.sql).toBe("SELECT 'LIMIT 3' AS label FROM t LIMIT 4");
  });

  it("givenOracleSelect_whenLimited_thenFetchFirstIsAppended", () => {
    expect(ORACLE.limit("SELECT * FROM emp ORDER BY id;", 501)?.sql).toBe(
      "SELECT * FROM emp ORDER BY id FETCH FIRST 501 ROWS ONLY;",
    );
  });

  it("givenSqlServerSelect_whenLimited_thenTopFollowsSelect", () => {
    expect(MSSQL.limit("SELECT * FROM [orders]", 501)).toEqual({
      sql: "SELECT TOP (501) * FROM [orders]",
      inserted: { offset: 6, length: 10 },
    });
  });

  it("givenSqlServerDistinct_whenLimited_thenTopFollowsDistinct", () => {
    expect(MSSQL.limit("select distinct a from t", 3)?.sql).toBe("select distinct TOP (3) a from t");
  });

  it("givenSqlServerWith_whenLimited_thenTheMainSelectGetsTop", () => {
    expect(MSSQL.limit("WITH a AS (SELECT 1 AS x) SELECT x FROM a", 3)?.sql).toBe(
      "WITH a AS (SELECT 1 AS x) SELECT TOP (3) x FROM a",
    );
  });

  it.each([
    ["an own TOP", "SELECT TOP 10 * FROM t"],
    ["an own TOP after DISTINCT", "SELECT DISTINCT TOP (10) a FROM t"],
    ["a union", "SELECT 1 UNION SELECT 2"],
    ["OFFSET FETCH", "SELECT * FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY"],
  ])("givenSqlServerStatementWith %s_whenLimited_thenNull", (_what, sql) => {
    expect(MSSQL.limit(sql, 5)).toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN])("givenRows %s_whenLimited_thenRangeError", (rows) => {
    expect(() => MYSQL.limit("SELECT 1", rows)).toThrow(RangeError);
  });
});
