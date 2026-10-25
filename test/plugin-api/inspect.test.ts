import type { CompletionCatalog, Problem, QuickFix } from "@table-craft/plugin-api";
import { quoteIdentifierWith, SQL_FUNCTIONS, SQL_KEYWORDS, sqlInspector } from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";
import { fakeCatalog } from "../support/completionCatalog.js";

const MYSQL_RESERVED = new Set([...SQL_KEYWORDS, "ORDER", "GROUP", "SELECT", "KEY", "DUAL"]);

const mysql = sqlInspector({
  dialect: { backslashEscapes: true, hashComments: true },
  identifierFolding: "none",
  plainIdentifier: /^[A-Za-z_][A-Za-z0-9_$]*$/,
  quoteIdentifier: quoteIdentifierWith("`"),
  keywords: SQL_KEYWORDS,
  functions: SQL_FUNCTIONS,
  reservedWords: MYSQL_RESERVED,
});

const postgres = sqlInspector({
  dialect: { dollarQuotes: true, nestedBlockComments: true, namespaceStatements: ["searchPath"] },
  identifierFolding: "lower",
  plainIdentifier: /^[a-z_][a-z0-9_$]*$/,
  quoteIdentifier: quoteIdentifierWith('"'),
  keywords: SQL_KEYWORDS,
  functions: SQL_FUNCTIONS,
  reservedWords: new Set(SQL_KEYWORDS),
});

type Inspector = typeof mysql;

function inspect(text: string, inspector: Inspector = mysql, catalog: CompletionCatalog = fakeCatalog()) {
  return inspector.inspect({ text }, catalog);
}

/** Each problem as `id: covered text`, in text order. */
function marks(text: string, problems: readonly Problem[]): string[] {
  return problems.map((problem) => `${problem.inspection}: ${text.slice(problem.from, problem.to)}`);
}

function only(problems: readonly Problem[], inspection: string): Problem {
  const found = problems.filter((problem) => problem.inspection === inspection);
  expect(found).toHaveLength(1);
  const [problem] = found;
  if (problem === undefined) throw new Error(`no ${inspection}`);
  return problem;
}

function fix(problem: Problem, title?: string): QuickFix {
  const found = title === undefined ? problem.fixes[0] : problem.fixes.find((entry) => entry.title === title);
  if (found === undefined) throw new Error(`no fix ${title ?? ""} on ${problem.message}`);
  return found;
}

function applied(text: string, quickFix: QuickFix): string {
  return [...quickFix.edits]
    .sort((left, right) => right.from - left.from)
    .reduce((result, edit) => result.slice(0, edit.from) + edit.insert + result.slice(edit.to), text);
}

const SCREENSHOT = "select * from order WHERE order by order_no asc;";

describe("sqlInspector", () => {
  it("givenTheScreenshotQuery_whenInspectingMysql_thenEmptyWhereReservedOrderAndRedundantAsc", async () => {
    const problems = await inspect(SCREENSHOT);

    expect(marks(SCREENSHOT, problems)).toEqual([
      "SqlReservedWordAsName: order",
      "SqlSyntax: WHERE",
      "SqlRedundantOrderingDirection: asc",
    ]);
    expect(problems.map((problem) => problem.severity)).toEqual(["error", "error", "weak"]);
    expect(problems.map((problem) => problem.message)).toEqual([
      "'order' is a reserved word; quote it",
      "Expression expected",
      "Redundant ordering direction",
    ]);
  });

  it("givenValidStatements_whenInspecting_thenNoProblems", async () => {
    const text = [
      "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 10 ORDER BY o.id DESC",
      "WITH t AS (SELECT id, name AS label FROM customers) SELECT label FROM t",
      "SELECT d.amount FROM (SELECT o.total AS amount FROM orders o) d",
      "SELECT total AS amount FROM orders GROUP BY amount HAVING count(*) > 1",
      "SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND name = 'x')",
      "SELECT id FROM orders JOIN order_totals USING (id)",
      "INSERT INTO orders (id, total) SELECT id, 1 FROM customers ON DUPLICATE KEY UPDATE total = VALUES(total)",
      "UPDATE orders SET total = NULL WHERE id = 1",
      "DELETE FROM orders WHERE id IS NULL",
      "SELECT * FROM orders FOR UPDATE",
      "SELECT 1 FROM DUAL",
      "SELECT CAST(total AS CHAR), @x, :p FROM orders",
      "SELECT * FROM archive.old_orders",
      "SELECT * FROM `Line Items`",
    ].join(";\n");

    expect(marks(text, await inspect(text))).toEqual([]);
  });

  describe("SqlSyntax", () => {
    it("givenWhereFollowedByOrderBy_whenInspecting_thenExpressionExpectedAndRemoveFixes", async () => {
      const text = "SELECT * FROM orders WHERE ORDER BY id";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(problem).toMatchObject({ message: "Expression expected", severity: "error" });
      expect(fix(problem).title).toBe("Remove empty WHERE clause");
      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders ORDER BY id");
    });

    it("givenWhereAtTheEnd_whenRemovingEmptyClause_thenTheKeywordAndItsSpaceGo", async () => {
      const text = "DELETE FROM orders WHERE;";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(applied(text, fix(problem))).toBe("DELETE FROM orders;");
    });

    it("givenOrderByWithNothingAfter_whenInspecting_thenBothWordsMarked", async () => {
      const text = "SELECT * FROM orders ORDER BY";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(text.slice(problem.from, problem.to)).toBe("ORDER BY");
      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders");
    });

    it("givenSelectWithNoList_whenInspecting_thenErrorWithoutFix", async () => {
      const text = "SELECT DISTINCT FROM orders";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(text.slice(problem.from, problem.to)).toBe("SELECT DISTINCT");
      expect(problem.fixes).toEqual([]);
    });

    it("givenTrailingCommaBeforeFrom_whenInspecting_thenRemoveCommaFix", async () => {
      const text = "SELECT id, FROM orders";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(problem.message).toBe("Trailing comma before FROM");
      expect(applied(text, fix(problem))).toBe("SELECT id FROM orders");
    });

    it("givenUnclosedParenthesis_whenInspecting_thenAddClosingParenthesisFix", async () => {
      const text = "SELECT count(id FROM orders;";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(problem.message).toBe("')' expected");
      expect(applied(text, fix(problem))).toBe("SELECT count(id FROM orders);");
    });

    it("givenStrayClosingParenthesis_whenInspecting_thenRemoveFix", async () => {
      const text = "SELECT id) FROM orders";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(problem.message).toBe("Unexpected ')'");
      expect(applied(text, fix(problem))).toBe("SELECT id FROM orders");
    });

    it("givenUnterminatedString_whenInspecting_thenUnclosedLiteralWithClosingFix", async () => {
      const text = "SELECT * FROM orders WHERE id = 'abc";
      const problem = only(await inspect(text), "SqlSyntax");

      expect(problem.message).toBe("Unclosed string literal");
      expect(applied(text, fix(problem))).toBe(`${text}'`);
    });

    it("givenUnterminatedQuotedNameAndComment_whenInspecting_thenEachNamed", async () => {
      expect((await inspect("SELECT `abc")).map((problem) => problem.message)).toContain("Unclosed quoted identifier");
      expect((await inspect("SELECT 1; /* note")).map((problem) => problem.message)).toEqual(["Unclosed comment"]);
    });

    it("givenQuoteInsideStringOrComment_whenInspecting_thenNothingUnclosed", async () => {
      const text = "SELECT 'it''s (' FROM orders -- ( unmatched\n;";

      expect(await inspect(text)).toEqual([]);
    });
  });

  describe("SqlResolve", () => {
    it("givenUnknownTable_whenInspecting_thenUnresolvedWithDidYouMean", async () => {
      const text = "SELECT * FROM ordrs";
      const problem = only(await inspect(text), "SqlResolve");

      expect(problem.message).toBe("Unable to resolve table 'ordrs'");
      expect(problem.fixes.map((entry) => entry.title)).toEqual(["Did you mean 'orders'?"]);
      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders");
    });

    it("givenTableOfAnotherNamespace_whenInspecting_thenQualifyFix", async () => {
      const text = "SELECT * FROM old_orders";
      const problem = only(await inspect(text), "SqlResolve");

      expect(applied(text, fix(problem, "Qualify with 'archive'"))).toBe("SELECT * FROM archive.old_orders");
    });

    it("givenSearchPathBeforeStatement_whenInspecting_thenResolvesInThatNamespace", async () => {
      expect(await inspect("SET search_path TO archive; SELECT customer_id FROM old_orders", postgres)).toEqual([]);
    });

    it("givenUnknownSchema_whenInspecting_thenUnresolvedSchemaWithDidYouMean", async () => {
      const text = "SELECT * FROM archiv.old_orders";
      const problem = only(await inspect(text), "SqlResolve");

      expect(problem.message).toBe("Unable to resolve schema 'archiv'");
      expect(applied(text, fix(problem))).toBe("SELECT * FROM archive.old_orders");
    });

    it("givenUnknownColumn_whenInspecting_thenUnresolvedColumnWithDidYouMean", async () => {
      const text = "SELECT totl FROM orders";
      const problem = only(await inspect(text), "SqlResolve");

      expect(problem.message).toBe("Unable to resolve column 'totl'");
      expect(applied(text, fix(problem))).toBe("SELECT total FROM orders");
    });

    it("givenUnknownQualifiedColumn_whenInspecting_thenUnresolvedColumnOfThatSource", async () => {
      const text = "SELECT c.emial FROM customers c";
      const problem = only(await inspect(text), "SqlResolve");

      expect(problem.message).toBe("Unable to resolve column 'emial'");
      expect(applied(text, fix(problem))).toBe("SELECT c.email FROM customers c");
    });

    it("givenUnknownQualifier_whenInspecting_thenUnresolvedTableWithAliasSuggestion", async () => {
      const text = "SELECT x.id FROM orders o";
      const problem = only(await inspect(text), "SqlResolve");

      expect(problem.message).toBe("Unable to resolve table 'x'");
      expect(applied(text, fix(problem))).toBe("SELECT o.id FROM orders o");
    });

    it("givenUnknownColumnOfDerivedTableOrCte_whenInspecting_thenUnresolved", async () => {
      const derived = "SELECT d.nope FROM (SELECT id FROM orders) d";
      const cte = "WITH t AS (SELECT id FROM orders) SELECT nope FROM t";

      expect(marks(derived, await inspect(derived))).toEqual(["SqlResolve: nope"]);
      expect(marks(cte, await inspect(cte))).toEqual(["SqlResolve: nope"]);
    });

    it("givenUnknownInsertColumn_whenInspecting_thenUnresolved", async () => {
      const text = "INSERT INTO orders (id, totl) VALUES (1, 2)";

      expect(marks(text, await inspect(text))).toEqual(["SqlResolve: totl"]);
    });

    it("givenAnUnknownSource_whenInspecting_thenItsColumnsAreNotReported", async () => {
      const text = "SELECT anything FROM orders JOIN generate_series(1, 3) g ON TRUE";

      expect((await inspect(text)).filter((problem) => problem.inspection === "SqlResolve")).toEqual([]);
    });

    it("givenPostgresFolding_whenInspecting_thenQuotedCaseMattersAndUnquotedFolds", async () => {
      const text = 'SELECT Total, "Total" FROM Orders';

      expect(marks(text, await inspect(text, postgres))).toEqual(['SqlResolve: "Total"']);
    });
  });

  describe("SqlAmbiguousColumn", () => {
    it("givenColumnInTwoSources_whenInspecting_thenAmbiguousWithQualifyFixes", async () => {
      const text = "SELECT id FROM orders o JOIN customers c ON c.id = o.customer_id";
      const problem = only(await inspect(text), "SqlAmbiguousColumn");

      expect(problem.message).toBe("Column reference 'id' is ambiguous");
      expect(problem.fixes.map((entry) => applied(text, entry).slice(0, "SELECT o.id".length))).toEqual([
        "SELECT o.id",
        "SELECT c.id",
      ]);
    });
  });

  describe("SqlReservedWordAsName", () => {
    it("givenReservedTableName_whenQuoting_thenDialectQuotes", async () => {
      const text = "SELECT * FROM group";
      const problem = only(await inspect(text), "SqlReservedWordAsName");

      expect(applied(text, fix(problem))).toBe("SELECT * FROM `group`");
    });

    it("givenReservedNameInPostgres_whenQuoting_thenQuotesItsFoldedSpelling", async () => {
      const text = "UPDATE ORDER SET x = 1 WHERE y = 2";
      const problem = only(await inspect(text, postgres), "SqlReservedWordAsName");

      expect(applied(text, fix(problem))).toBe('UPDATE "order" SET x = 1 WHERE y = 2');
    });

    it("givenReservedWordInInsertColumns_whenInspecting_thenReported", async () => {
      const text = "INSERT INTO orders (id, key) VALUES (1, 2)";

      expect(marks(text, await inspect(text))).toEqual(["SqlReservedWordAsName: key"]);
    });
  });

  describe("SqlInsertValues", () => {
    it("givenRowShorterThanColumnList_whenInspecting_thenEachBadRowReported", async () => {
      const text = "INSERT INTO orders (id, total) VALUES (1, 2), (3), (4, 5, 6)";
      const problems = (await inspect(text)).filter((problem) => problem.inspection === "SqlInsertValues");

      expect(marks(text, problems)).toEqual(["SqlInsertValues: (3)", "SqlInsertValues: (4, 5, 6)"]);
      expect(problems.map((problem) => problem.message)).toEqual([
        "Expected 2 values, found 1",
        "Expected 2 values, found 3",
      ]);
    });
  });

  describe("SqlWithoutWhere", () => {
    it("givenDeleteWithoutWhere_whenInspecting_thenWarningWithWherePlaceholder", async () => {
      const text = "DELETE FROM orders;";
      const problem = only(await inspect(text), "SqlWithoutWhere");

      expect(problem).toMatchObject({ severity: "warning", message: "DELETE without WHERE affects all rows" });
      expect(applied(text, fix(problem))).toBe("DELETE FROM orders WHERE ;");
      expect(fix(problem).caret).toBe("DELETE FROM orders WHERE ".length);
    });

    it("givenUpdateWithOrderBy_whenAddingWhere_thenPlaceholderGoesBeforeOrderBy", async () => {
      const text = "UPDATE orders SET total = 1 ORDER BY id LIMIT 1";
      const problem = only(await inspect(text), "SqlWithoutWhere");

      expect(applied(text, fix(problem))).toBe("UPDATE orders SET total = 1 WHERE  ORDER BY id LIMIT 1");
      expect(fix(problem).caret).toBe("UPDATE orders SET total = 1 WHERE ".length);
    });
  });

  describe("SqlNullComparison", () => {
    it("givenEqualsNull_whenInspecting_thenReplaceWithIsNull", async () => {
      const text = "SELECT * FROM orders WHERE total = NULL";
      const problem = only(await inspect(text), "SqlNullComparison");

      expect(problem.message).toBe("'= NULL' is never true; use IS NULL");
      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders WHERE total IS NULL");
    });

    it("givenNotEqualsNull_whenInspecting_thenReplaceWithIsNotNull", async () => {
      const text = "SELECT * FROM orders WHERE total <> NULL OR total != NULL";
      const problems = (await inspect(text)).filter((problem) => problem.inspection === "SqlNullComparison");

      expect(problems.map((problem) => fix(problem).title)).toEqual([
        "Replace with IS NOT NULL",
        "Replace with IS NOT NULL",
      ]);
    });
  });

  describe("SqlConstantCondition", () => {
    it("givenOneEqualsOne_whenInspecting_thenAlwaysTrueAndRemoveWhere", async () => {
      const text = "SELECT * FROM orders WHERE 1 = 1";
      const problem = only(await inspect(text), "SqlConstantCondition");

      expect(problem.message).toBe("Condition '1 = 1' is always true");
      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders");
    });

    it("givenTrueJoinedByAnd_whenRemoving_thenTheAndGoesWithIt", async () => {
      const text = "SELECT * FROM orders WHERE id BETWEEN 1 AND 2 AND TRUE";
      const problem = only(await inspect(text), "SqlConstantCondition");

      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders WHERE id BETWEEN 1 AND 2");
    });

    it("givenAlwaysFalseLiteralComparison_whenInspecting_thenReportedWithoutFix", async () => {
      const problem = only(await inspect("SELECT * FROM orders WHERE 'a' = 'b'"), "SqlConstantCondition");

      expect(problem).toMatchObject({ message: "Condition ''a' = 'b'' is always false", fixes: [] });
    });
  });

  describe("SqlUnusedCte", () => {
    it("givenUnusedCte_whenRemoving_thenTheWithClauseGoes", async () => {
      const text = "WITH t AS (SELECT 1) SELECT * FROM orders";
      const problem = only(await inspect(text), "SqlUnusedCte");

      expect(problem.message).toBe("CTE 't' is never used");
      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders");
    });

    it("givenSecondCteUnused_whenRemoving_thenItsCommaGoes", async () => {
      const text = "WITH a AS (SELECT 1), b AS (SELECT * FROM a) SELECT * FROM a";
      const problem = only(await inspect(text), "SqlUnusedCte");

      expect(applied(text, fix(problem))).toBe("WITH a AS (SELECT 1) SELECT * FROM a");
    });
  });

  describe("SqlDuplicateAlias", () => {
    it("givenTwoSourcesWithOneAlias_whenInspecting_thenSecondReported", async () => {
      const text = "SELECT * FROM orders o JOIN customers o ON TRUE";
      const problem = only(await inspect(text), "SqlDuplicateAlias");

      expect(problem).toMatchObject({ message: "Duplicate table alias 'o'", from: text.lastIndexOf("o ON") });
    });
  });

  describe("weak inspections", () => {
    it("givenAscInOrderBy_whenRemoving_thenDirectionGoes", async () => {
      const text = "SELECT * FROM orders ORDER BY id ASC, total";
      const problem = only(await inspect(text), "SqlRedundantOrderingDirection");

      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders ORDER BY id, total");
    });

    it("givenAliasEqualToTable_whenRemoving_thenAliasGoes", async () => {
      const text = "SELECT * FROM orders AS orders";
      const problem = only(await inspect(text), "SqlRedundantAlias");

      expect(problem).toMatchObject({ severity: "weak", message: "Redundant alias 'orders'" });
      expect(applied(text, fix(problem))).toBe("SELECT * FROM orders");
    });

    it("givenElseNull_whenRemoving_thenCaseEndsWithoutIt", async () => {
      const text = "SELECT CASE WHEN id = 1 THEN 'a' ELSE NULL END FROM orders";
      const problem = only(await inspect(text), "SqlRedundantElseNull");

      expect(applied(text, fix(problem))).toBe("SELECT CASE WHEN id = 1 THEN 'a' END FROM orders");
    });
  });

  describe("suppression and robustness", () => {
    it("givenNoinspectionComment_whenInspecting_thenSuppressed", async () => {
      const text = [
        "-- noinspection SqlResolve, SqlWithoutWhere",
        "DELETE FROM nope;",
        "",
        "-- noinspection SqlResolve",
        "",
        "SELECT nope FROM orders;",
      ].join("\n");

      expect(marks(text, await inspect(text))).toEqual(["SqlResolve: nope"]);
    });

    it("givenDisabledInspection_whenInspecting_thenSkipped", async () => {
      const problems = await mysql.inspect(
        { text: SCREENSHOT, disabled: ["SqlRedundantOrderingDirection"] },
        fakeCatalog(),
      );

      expect(problems.map((problem) => problem.inspection)).not.toContain("SqlRedundantOrderingDirection");
    });

    it("givenUnreadableSql_whenInspecting_thenNoThrow", async () => {
      const texts = [
        ")))(((",
        "SELECT FROM WHERE ((( ' \" ` /* ",
        "WITH WITH AS AS ( SELECT",
        "INSERT INTO (",
        "UPDATE SET WHERE",
        ". . , , ; ; ",
        "SELECT a.b.c.d. FROM . JOIN ON USING (",
        "\u0000\uffff$$ $tag$ unterminated",
        "",
      ];
      for (const text of texts) {
        for (const inspector of [mysql, postgres]) {
          const problems = await inspect(text, inspector);
          for (const problem of problems) {
            expect(problem.from).toBeGreaterThanOrEqual(0);
            expect(problem.to).toBeLessThanOrEqual(text.length);
          }
        }
      }
    });

    it("givenCatalogThatRejects_whenInspecting_thenNoResolveProblems", async () => {
      const failing: CompletionCatalog = {
        current: ["db"],
        server: { version: null },
        namespaces: () => Promise.reject(new Error("down")),
        relations: () => Promise.reject(new Error("down")),
        referencing: () => Promise.reject(new Error("down")),
      };

      const problems = await inspect("SELECT nope FROM ordrs", mysql, failing);

      expect(problems).toEqual([]);
    });

    it("givenEmptyCatalog_whenInspecting_thenNoResolveProblems", async () => {
      const text = "SELECT nope, x.y FROM ordrs o JOIN zz.missing m ON m.a = o.b";

      const problems = await inspect(text, mysql, fakeCatalog(new Map()));

      expect(problems.map((problem) => problem.inspection)).not.toContain("SqlAmbiguousColumn");
      expect(marks(text, problems)).toEqual([]);
    });
  });
});
