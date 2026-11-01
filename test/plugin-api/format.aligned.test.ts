import type { FormatOptions, SqlLanguage } from "@table-craft/plugin-api";
import mysqlPlugin from "@table-craft/plugin-mysql";
import postgresPlugin from "@table-craft/plugin-postgres";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import { describe, expect, it } from "vitest";
import { GOLDEN, GOLDEN_MESSY, GOLDEN_ONE_LINE } from "../support/alignedGolden.js";

function languageOf(plugin: { readonly language?: SqlLanguage }): SqlLanguage {
  if (plugin.language === undefined) throw new Error("the plugin has no language");
  return plugin.language;
}

const postgres = languageOf(postgresPlugin);
const mysql = languageOf(mysqlPlugin);
const sqlite = languageOf(sqlitePlugin);
const ALIGNED: FormatOptions = {
  style: "aligned",
  keywordCase: "upper",
  indentWidth: 2,
  linesBetweenStatements: 1,
  alignAliases: true,
};

const lines = (...rows: string[]): string => rows.join("\n");

/** Every input the property tests run, per dialect; each `aligned` call above them adds its own. */
const FIXTURES: (readonly [SqlLanguage, string])[] = [
  [mysql, GOLDEN_ONE_LINE],
  [mysql, GOLDEN_MESSY],
  [mysql, GOLDEN],
];

function fixture(language: SqlLanguage, sql: string): string {
  FIXTURES.push([language, sql]);
  return sql;
}

function aligned(language: SqlLanguage, sql: string, options: Partial<FormatOptions> = {}): string {
  return language.format(fixture(language, sql), { ...ALIGNED, ...options });
}

describe("format (aligned style): the reference query", () => {
  it("givenTheGoldenOnOneLineLowerCase_whenFormattedAsMysql_thenTheGoldenByteForByte", () => {
    expect(aligned(mysql, GOLDEN_ONE_LINE)).toBe(GOLDEN);
  });

  it("givenTheGoldenWithMessySpacing_whenFormattedAsMysql_thenTheGoldenByteForByte", () => {
    expect(aligned(mysql, GOLDEN_MESSY)).toBe(GOLDEN);
  });

  it("givenTheGolden_whenFormattedAsMysql_thenUnchanged", () => {
    expect(aligned(mysql, GOLDEN)).toBe(GOLDEN);
  });
});

describe("format (aligned style): the rules", () => {
  it("givenLowerCaseKeywordsAndMixedCaseNames_whenFormatted_thenOnlyKeywordsAreCased", () => {
    expect(aligned(postgres, "select Name, COUNT(*) from Users")).toBe("SELECT Name,\n       COUNT(*)\nFROM Users");
    expect(aligned(postgres, "SELECT a FROM t", { keywordCase: "lower" })).toBe("select a\nfrom t");
    expect(aligned(postgres, "Select a From t", { keywordCase: "preserve" })).toBe("Select a\nFrom t");
  });

  it("givenExplainPrefixes_whenFormatted_thenThePrefixStandsOnItsOwnLine", () => {
    expect(aligned(mysql, "explain analyze select 1")).toBe("EXPLAIN ANALYZE\nSELECT 1");
    expect(aligned(mysql, "explain format=json select a from t")).toBe("EXPLAIN FORMAT=json\nSELECT a\nFROM t");
    expect(aligned(mysql, "describe select a from t")).toBe("DESCRIBE\nSELECT a\nFROM t");
  });

  it("givenEveryClause_whenFormatted_thenTheFirstItemSharesTheKeywordLine", () => {
    expect(
      aligned(
        mysql,
        "select a, count(*) from t where x = 1 group by a, b having count(*) > 1 order by a desc limit 10",
      ),
    ).toBe(
      lines(
        "SELECT a,",
        "       count(*)",
        "FROM t",
        "WHERE x = 1",
        "GROUP BY a, b",
        "HAVING count(*) > 1",
        "ORDER BY a DESC",
        "LIMIT 10",
      ),
    );
  });

  it("givenSelectDistinct_whenFormatted_thenItemsAlignAfterTheModifier", () => {
    expect(aligned(mysql, "select distinct a, b from t")).toBe("SELECT DISTINCT a,\n                b\nFROM t");
    expect(aligned(postgres, "select distinct on (a) a, b from t")).toBe(
      "SELECT DISTINCT ON (a) a,\n                       b\nFROM t",
    );
  });

  it("givenAliases_whenFormatted_thenAsLinesUpAndUnaliasedItemsAreNotPadded", () => {
    expect(aligned(postgres, "select a as x, longer_name as y, plain, b c from t")).toBe(
      lines("SELECT a           AS x,", "       longer_name AS y,", "       plain,", "       b c", "FROM t"),
    );
  });

  it("givenAlignAliasesOff_whenFormatted_thenNoPadding", () => {
    expect(aligned(postgres, "select a as x, longer_name as y from t", { alignAliases: false })).toBe(
      lines("SELECT a AS x,", "       longer_name AS y", "FROM t"),
    );
  });

  it("givenAnExpressionPastTheAliasLimit_whenFormatted_thenItNeitherPadsNorIsPaddedTo", () => {
    const long = `concat(${Array.from({ length: 12 }, (_, i) => `column_${i}`).join(", ")})`;
    expect(aligned(postgres, `select a as x, ${long} as y, bb as z from t`)).toBe(
      lines("SELECT a  AS x,", `       ${long} AS y,`, "       bb AS z", "FROM t"),
    );
  });

  it("givenCallsAndLists_whenFormatted_thenCallsStayWholeAndInListsChop", () => {
    expect(aligned(mysql, "select f( a ,b ,  g(c) ) from t where x in ( 1,2 , 3 )")).toBe(
      lines("SELECT f(a, b, g(c))", "FROM t", "WHERE x IN (1,", "            2,", "            3)"),
    );
  });

  it("givenAnInList_whenFormatted_thenOneValuePerLineUnderTheFirst", () => {
    expect(aligned(mysql, "select * from orders where order_id in (1001, 1002, 1003);")).toBe(
      lines(
        "SELECT *",
        "FROM orders",
        "WHERE order_id IN (1001,",
        "                   1002,",
        "                   1003);",
      ),
    );
  });

  it("givenANotInListAfterAnOperator_whenFormatted_thenChoppedUnderTheFirstValue", () => {
    expect(aligned(postgres, "select a from t where a = 1 and status not in ('NEW', 'PAID')")).toBe(
      lines("SELECT a", "FROM t", "WHERE a = 1", "  AND status NOT IN ('NEW',", "                     'PAID')"),
    );
  });

  it("givenASingleValueIn_whenFormatted_thenInline", () => {
    expect(aligned(sqlite, "select a from t where status not in ('DONE') and b in (?)")).toBe(
      lines("SELECT a", "FROM t", "WHERE status NOT IN ('DONE')", "  AND b IN (?)"),
    );
  });

  it("givenATupleInList_whenFormatted_thenOneTuplePerLine", () => {
    expect(aligned(mysql, "select * from t where (a, b) in ((1, 2), (3, 4))")).toBe(
      lines("SELECT *", "FROM t", "WHERE (a, b) IN ((1, 2),", "                 (3, 4))"),
    );
  });

  it("givenAnInListWithALineComment_whenFormatted_thenTheCommentStaysAndValuesAlign", () => {
    expect(aligned(mysql, "select * from t where x in (1, -- first\n2, 3)")).toBe(
      lines("SELECT *", "FROM t", "WHERE x IN (1, -- first", "            2,", "            3)"),
    );
  });

  it("givenAnInListInsideCase_whenFormatted_thenTheCaseExpands", () => {
    expect(aligned(postgres, "select case when a in (1, 2) then 'x' else 'y' end as k from t")).toBe(
      lines(
        "SELECT CASE",
        "         WHEN a IN (1,",
        "                    2) THEN 'x'",
        "         ELSE 'y'",
        "       END AS k",
        "FROM t",
      ),
    );
  });

  it("givenTableHintsAndSeveralTables_whenFormatted_thenHintsStayAndTablesAlign", () => {
    expect(aligned(mysql, "select * from t1 as a use index (i), t2 force index (j) where a.x = t2.x")).toBe(
      lines("SELECT *", "FROM t1 AS a USE INDEX (i),", "     t2 FORCE INDEX (j)", "WHERE a.x = t2.x"),
    );
    expect(aligned(postgres, "select * from only t tablesample system (10)")).toBe(
      "SELECT *\nFROM ONLY t TABLESAMPLE system(10)",
    );
  });

  it("givenJoins_whenFormatted_thenEachJoinAlignsWithTheFirstTableAndOnConditionsAlignUnderOn", () => {
    expect(aligned(postgres, "select * from a join b on b.id = a.id and b.x = 1 left join only c on c.id = a.id")).toBe(
      lines(
        "SELECT *",
        "FROM a",
        "     JOIN b ON b.id = a.id",
        "            AND b.x = 1",
        "     LEFT JOIN ONLY c ON c.id = a.id",
      ),
    );
  });

  it("givenWhereAndHaving_whenFormatted_thenOperatorsRightAlignToTheKeyword", () => {
    expect(
      aligned(mysql, "select a from t where a = 1 and b = 2 or c = 3 group by a having x > 1 and y > 2 or z > 3"),
    ).toBe(
      lines(
        "SELECT a",
        "FROM t",
        "WHERE a = 1",
        "  AND b = 2",
        "   OR c = 3",
        "GROUP BY a",
        "HAVING x > 1",
        "   AND y > 2",
        "    OR z > 3",
      ),
    );
  });

  it("givenShortGroups_whenFormatted_thenTheyStayInline", () => {
    expect(aligned(sqlite, "select a from t where a = ? and (b = 1 or c = 2) and (d = 1)")).toBe(
      lines("SELECT a", "FROM t", "WHERE a = ?", "  AND (b = 1 OR c = 2)", "  AND (d = 1)"),
    );
  });

  it("givenALongGroup_whenFormattedWithIndentFour_thenInnerConditionsIndentFourAndTheOperatorTrails", () => {
    const left = `a_rather_long_column_name = CONCAT(${Array.from({ length: 8 }, (_, i) => `'value_${i}'`).join(", ")})`;
    const right = `another_long_column_name = CONCAT(${Array.from({ length: 8 }, (_, i) => `'other_${i}'`).join(", ")})`;
    expect(aligned(mysql, `select a from t where x = 1 and (${left} or ${right})`, { indentWidth: 4 })).toBe(
      lines("SELECT a", "FROM t", "WHERE x = 1", "  AND (", `      ${left} OR`, `      ${right})`),
    );
  });

  it("givenSubqueries_whenFormatted_thenTheyLayOutAtTheColumnAfterTheParenthesis", () => {
    expect(
      aligned(
        mysql,
        "select * from (select a, b from t where x = 1) as s join (select 1) q on q.a = s.a where s.a in (select a from u where y = 2) and exists (select 1 from v)",
      ),
    ).toBe(
      lines(
        "SELECT *",
        "FROM (SELECT a,",
        "             b",
        "      FROM t",
        "      WHERE x = 1) AS s",
        "     JOIN (SELECT 1) q ON q.a = s.a",
        "WHERE s.a IN (SELECT a",
        "              FROM u",
        "              WHERE y = 2)",
        "  AND EXISTS (SELECT 1",
        "              FROM v)",
      ),
    );
  });

  it("givenCtes_whenFormatted_thenBodiesAlignAndTheQueryStartsAtColumnZero", () => {
    expect(
      aligned(postgres, "with a as (select id from users where active), b as (select * from orders) select * from a"),
    ).toBe(
      lines(
        "WITH a AS (SELECT id",
        "           FROM users",
        "           WHERE active),",
        "     b AS (SELECT *",
        "           FROM orders)",
        "SELECT *",
        "FROM a",
      ),
    );
  });

  it("givenSetOperators_whenFormatted_thenEachStandsOnItsOwnLine", () => {
    expect(aligned(mysql, "select a from t union all select b from u union select c from v order by 1")).toBe(
      lines("SELECT a", "FROM t", "UNION ALL", "SELECT b", "FROM u", "UNION", "SELECT c", "FROM v", "ORDER BY 1"),
    );
  });

  it("givenCase_whenFormatted_thenShortStaysInlineAndLongGoesOneWhenPerLine", () => {
    expect(aligned(mysql, "select case a when 1 then 'x' else 'y' end from t")).toBe(
      "SELECT CASE a WHEN 1 THEN 'x' ELSE 'y' END\nFROM t",
    );
    expect(
      aligned(
        postgres,
        "select a.id, case when b.total > 100 then 'big' when b.total > 10 then 'medium' else 'small' end as size from a",
      ),
    ).toBe(
      lines(
        "SELECT a.id,",
        "       CASE",
        "         WHEN b.total > 100 THEN 'big'",
        "         WHEN b.total > 10 THEN 'medium'",
        "         ELSE 'small'",
        "       END AS size",
        "FROM a",
      ),
    );
  });

  it("givenInserts_whenFormatted_thenRowsAlignAndTheTailFollows", () => {
    expect(
      aligned(
        postgres,
        "insert into t (a,b) values (1,2), (3,4) on conflict (a) do update set b = excluded.b returning a",
      ),
    ).toBe(
      lines(
        "INSERT INTO t (a, b)",
        "VALUES (1, 2),",
        "       (3, 4)",
        "ON CONFLICT (a) DO UPDATE SET b = excluded.b",
        "RETURNING a",
      ),
    );
    expect(aligned(mysql, "insert into t (a,b) values (1,2) on duplicate key update b = values(b), a = 3")).toBe(
      lines(
        "INSERT INTO t (a, b)",
        "VALUES (1, 2)",
        "ON DUPLICATE KEY UPDATE b = values(b),",
        "                        a = 3",
      ),
    );
    expect(aligned(mysql, "insert into t (a) select a from u where x = 1")).toBe(
      lines("INSERT INTO t (a)", "SELECT a", "FROM u", "WHERE x = 1"),
    );
  });

  it("givenUpdateAndDelete_whenFormatted_thenAssignmentsAlignOnEquals", () => {
    expect(aligned(postgres, "update t set a = 1, bbb = 'x' where id = $1 returning *")).toBe(
      lines("UPDATE t", "SET a   = 1,", "    bbb = 'x'", "WHERE id = $1", "RETURNING *"),
    );
    expect(aligned(postgres, "delete from t where a = 1 returning id")).toBe(
      "DELETE FROM t\nWHERE a = 1\nRETURNING id",
    );
  });

  it("givenSeveralStatements_whenFormatted_thenSemicolonsGlueAndBlankLinesSeparate", () => {
    expect(aligned(mysql, "select 1 ; select 2;")).toBe("SELECT 1;\n\nSELECT 2;");
    expect(aligned(mysql, "select 1; select 2", { linesBetweenStatements: 0 })).toBe("SELECT 1;\nSELECT 2");
  });

  it("givenCommentsInEveryPosition_whenFormatted_thenTheyKeepTheirPlaces", () => {
    expect(
      aligned(
        mysql,
        "-- head\nselect a, -- first\n b /* blk */ from t -- after\nwhere x = 1; -- tail\n/* x */ select 2",
      ),
    ).toBe(
      lines(
        "-- head",
        "SELECT a, -- first",
        "       b /* blk */",
        "FROM t -- after",
        "WHERE x = 1; -- tail",
        "",
        "/* x */",
        "SELECT 2",
      ),
    );
    const block = "/* one\n   two */";
    expect(aligned(postgres, `select a from t ${block}`)).toContain(block);
  });

  it("givenPlaceholdersAndVariables_whenFormatted_thenEachPassesThroughWhole", () => {
    expect(aligned(postgres, "select a from t where a = :id and b = $1 and c = x::int")).toBe(
      lines("SELECT a", "FROM t", "WHERE a = :id", "  AND b = $1", "  AND c = x::int"),
    );
    expect(aligned(mysql, "select `a`, @x := @x + 1 as n, @@version from t limit 10, 20")).toBe(
      lines("SELECT `a`,", "       @x := @x + 1 AS n,", "       @@version", "FROM t", "LIMIT 10, 20"),
    );
  });
});

describe("format (aligned style): the fallback", () => {
  it("givenDdlBesideDml_whenFormatted_thenDdlGetsTheStandardLayoutAndDmlTheAlignedOne", () => {
    const standard = mysql.format("create table t (a int primary key, b varchar(10))", {
      ...ALIGNED,
      style: "standard",
    });
    expect(aligned(mysql, "create table t (a int primary key, b varchar(10)); update t set a = 1 where b = 'x'")).toBe(
      `${standard};\n\nUPDATE t\nSET a = 1\nWHERE b = 'x'`,
    );
  });

  it("givenGarbage_whenFormatted_thenItFailsLikeTheStandardLayout", () => {
    expect(() => aligned(mysql, "garbage here (((")).toThrow(/^Parse error/);
  });

  it("givenADelimiterScript_whenFormatted_thenRefused", () => {
    expect(() => aligned(mysql, "DELIMITER //\nselect 1//")).toThrow(/DELIMITER/);
  });
});

describe("format (aligned style): properties over every fixture", () => {
  const squash = (sql: string): string => sql.replace(/\s+/g, "").toUpperCase();

  it("givenEveryFixture_whenFormattedTwice_thenTheSecondPassChangesNothing", () => {
    for (const [language, sql] of FIXTURES) {
      let once: string;
      try {
        once = language.format(sql, ALIGNED);
      } catch {
        continue;
      }
      expect(language.format(once, ALIGNED), sql).toBe(once);
    }
  });

  it("givenEveryFixture_whenFormatted_thenOnlyWhitespaceAndKeywordCaseChange", () => {
    for (const [language, sql] of FIXTURES) {
      let once: string;
      try {
        once = language.format(sql, ALIGNED);
      } catch {
        continue;
      }
      expect(squash(once), sql).toBe(squash(sql));
    }
  });
});
