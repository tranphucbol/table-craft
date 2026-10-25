import { sqlSplitter } from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";

const plain = sqlSplitter();
const postgres = sqlSplitter({ dollarQuotes: true, nestedBlockComments: true, blockKeywords: ["BEGIN"] });
const mysql = sqlSplitter({
  backslashEscapes: true,
  delimiterCommand: true,
  hashComments: true,
  blockKeywords: ["BEGIN"],
});
const sqlite = sqlSplitter({ blockKeywords: ["BEGIN"] });
const tsql = sqlSplitter({ bracketIdentifiers: true, batchSeparator: "go", nationalStrings: true });
const oracle = sqlSplitter({ batchSeparator: "slash", qQuotes: true, nationalStrings: true });

/** With the new options off, `[`, `/`, `GO`, `N'` and `q'` mean what they meant before decision 100. */
const EXISTING_SCRIPTS = [
  [
    postgres,
    "SELECT arr[1:2], 'a;b' FROM t;\n/\nSELECT 2;\nGO\nSELECT N'x;y'; SELECT q'[a;b]';",
    ["SELECT arr[1:2], 'a;b' FROM t", "/\nSELECT 2", "GO\nSELECT N'x;y'", "SELECT q'[a;b]'"],
  ],
  [mysql, "SELECT `a[;]`, n'x;y' FROM t;\nGO 3\nSELECT 2", ["SELECT `a[;]`, n'x;y' FROM t", "GO 3\nSELECT 2"]],
  [
    sqlite,
    "CREATE TRIGGER t AFTER INSERT ON o BEGIN SELECT 1; END;\n/\nSELECT [a;b]",
    ["CREATE TRIGGER t AFTER INSERT ON o BEGIN SELECT 1; END", "/\nSELECT [a", "b]"],
  ],
] as const;

function statements(split: (text: string) => readonly { sql: string }[], text: string): string[] {
  return split(text).map((span) => span.sql);
}

describe("sqlSplitter", () => {
  it("givenThreeStatements_whenSplit_thenSpansCoverEachWithoutDelimiter", () => {
    const text =
      "SELECT * FROM customers;\nUPDATE orders SET total = total + 1 WHERE id = 1;\nSELECT count(*) FROM orders;";

    const spans = plain(text);

    expect(spans.map((span) => span.sql)).toEqual([
      "SELECT * FROM customers",
      "UPDATE orders SET total = total + 1 WHERE id = 1",
      "SELECT count(*) FROM orders",
    ]);
    for (const span of spans) expect(text.slice(span.from, span.to)).toBe(span.sql);
  });

  it("givenSemicolonInsideString_whenSplit_thenOneStatement", () => {
    expect(statements(plain, "SELECT 'a;b', 'it''s; fine' FROM t; SELECT 2")).toEqual([
      "SELECT 'a;b', 'it''s; fine' FROM t",
      "SELECT 2",
    ]);
  });

  it("givenSemicolonInsideQuotedIdentifier_whenSplit_thenOneStatement", () => {
    expect(statements(plain, 'SELECT 1 AS "a;b", 2 AS `c;d`; SELECT 3')).toEqual([
      'SELECT 1 AS "a;b", 2 AS `c;d`',
      "SELECT 3",
    ]);
  });

  it("givenSemicolonInsideLineAndBlockComment_whenSplit_thenOneStatement", () => {
    expect(statements(plain, "SELECT 1 -- not; here\n, 2 /* nor; here */ FROM t; SELECT 3")).toEqual([
      "SELECT 1 -- not; here\n, 2 /* nor; here */ FROM t",
      "SELECT 3",
    ]);
  });

  it("givenCommentsBetweenStatements_whenSplit_thenTheyBelongToNoStatement", () => {
    const text = "SELECT 1;\n-- a note\n/* another */\nSELECT 2;";

    expect(plain(text).map((span) => span.from)).toEqual([0, text.indexOf("SELECT 2")]);
  });

  it("givenEmptyStatements_whenSplit_thenDropped", () => {
    expect(statements(plain, ";;  ; SELECT 1;; -- only a comment\n; /* and this */ ;")).toEqual(["SELECT 1"]);
    expect(plain("   \n ")).toEqual([]);
  });

  it("givenNoTrailingDelimiter_whenSplit_thenLastStatementRunsToItsLastToken", () => {
    expect(statements(plain, "SELECT 1;\nSELECT 2  \n  ")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("givenAstralCharacters_whenSplit_thenOffsetsAreUtf16", () => {
    const text = "SELECT '🌍'; SELECT '世界'";

    const spans = plain(text);

    expect(spans[1]).toEqual({ from: 13, to: 24, sql: "SELECT '世界'" });
    expect(spans[0]?.to).toBe("SELECT '🌍'".length);
  });

  it("givenDollarQuotedFunctionBody_whenSplitAsPostgres_thenOneStatement", () => {
    const body = "CREATE FUNCTION f() RETURNS int AS $body$ BEGIN RETURN 1; END; $body$ LANGUAGE plpgsql";

    expect(statements(postgres, `${body};\nSELECT f();`)).toEqual([body, "SELECT f()"]);
    expect(statements(postgres, "DO $$ BEGIN PERFORM 1; END $$; SELECT 2")).toEqual([
      "DO $$ BEGIN PERFORM 1; END $$",
      "SELECT 2",
    ]);
  });

  it("givenPositionalParameter_whenSplitAsPostgres_thenNotADollarQuote", () => {
    expect(statements(postgres, "SELECT $1; SELECT a$b$ FROM t; SELECT 3")).toEqual([
      "SELECT $1",
      "SELECT a$b$ FROM t",
      "SELECT 3",
    ]);
  });

  it("givenNestedBlockComment_whenSplitAsPostgres_thenOneComment", () => {
    expect(statements(postgres, "/* outer /* inner; */ still; */ SELECT 1; SELECT 2")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("givenEscapeString_whenSplitAsPostgres_thenBackslashEscapesTheQuote", () => {
    expect(statements(postgres, "SELECT E'it\\'s;'; SELECT 2")).toEqual(["SELECT E'it\\'s;'", "SELECT 2"]);
  });

  it("givenBeginAtomicBody_whenSplitAsPostgres_thenOneStatement", () => {
    const create =
      "CREATE FUNCTION one() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT CASE WHEN true THEN 1 END; END";

    expect(statements(postgres, `${create};\nBEGIN;\nSELECT 2;\nCOMMIT;`)).toEqual([
      create,
      "BEGIN",
      "SELECT 2",
      "COMMIT",
    ]);
  });

  it("givenBackslashEscapedQuote_whenSplitAsMysql_thenOneStatement", () => {
    expect(statements(mysql, "SELECT 'it\\'s;'; SELECT \"a\\\";\"; SELECT 3")).toEqual([
      "SELECT 'it\\'s;'",
      'SELECT "a\\";"',
      "SELECT 3",
    ]);
  });

  it("givenHashComment_whenSplitAsMysql_thenIgnored", () => {
    expect(statements(mysql, "# a; note\nSELECT 1; # trailing; note\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("givenDelimiterCommand_whenSplitAsMysql_thenUsesNewDelimiter", () => {
    const text = [
      "DELIMITER //",
      "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//",
      "DELIMITER ;",
      "CALL p();",
      "DELIMITER $$",
      "CREATE FUNCTION f() RETURNS int DETERMINISTIC BEGIN RETURN 1; END$$",
    ].join("\n");

    expect(statements(mysql, text)).toEqual([
      "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END",
      "CALL p()",
      "CREATE FUNCTION f() RETURNS int DETERMINISTIC BEGIN RETURN 1; END",
    ]);
  });

  it("givenProcedureBodyWithoutDelimiter_whenSplitAsMysql_thenBodyStaysWhole", () => {
    const create =
      "CREATE PROCEDURE p() BEGIN IF 1 THEN SELECT 1; END IF; WHILE 0 DO SELECT 2; END WHILE; CASE WHEN 1 THEN SELECT 3; END CASE; END";

    expect(statements(mysql, `${create};\nBEGIN;\nCOMMIT`)).toEqual([create, "BEGIN", "COMMIT"]);
  });

  it("givenTriggerBody_whenSplitAsSqlite_thenOneStatement", () => {
    const trigger =
      "CREATE TRIGGER t AFTER INSERT ON orders BEGIN UPDATE customers SET name = name WHERE id = NEW.customer_id; SELECT CASE WHEN 1 THEN 1 END; END";

    expect(statements(sqlite, `${trigger};\nSELECT 1;`)).toEqual([trigger, "SELECT 1"]);
  });

  it("givenColumnNamedBegin_whenSplit_thenNoBodyOpens", () => {
    expect(statements(sqlite, "CREATE TABLE t (begin int); SELECT 1")).toEqual([
      "CREATE TABLE t (begin int)",
      "SELECT 1",
    ]);
    expect(statements(sqlite, "SELECT begin FROM t; SELECT 2")).toEqual(["SELECT begin FROM t", "SELECT 2"]);
  });

  it("givenUnterminatedString_whenSplit_thenRestIsOneStatement", () => {
    expect(statements(plain, "SELECT 1; SELECT 'open; SELECT 3")).toEqual(["SELECT 1", "SELECT 'open; SELECT 3"]);
  });

  it("givenBracketIdentifierWithSemicolon_whenSplit_thenOneStatement", () => {
    expect(statements(tsql, "SELECT [a;b], [c]];d] FROM [t;]; SELECT 2")).toEqual([
      "SELECT [a;b], [c]];d] FROM [t;]",
      "SELECT 2",
    ]);
  });

  it("givenGoLine_whenSplit_thenSeparatorDropped", () => {
    const text = "SELECT 1\nGO\nSELECT 2;\n  go  -- next batch\nSELECT 3\nSELECT go FROM t";

    expect(tsql(text)).toEqual([
      { from: 0, to: 8, sql: "SELECT 1" },
      { from: 12, to: 20, sql: "SELECT 2" },
      { from: 42, to: text.length, sql: "SELECT 3\nSELECT go FROM t" },
    ]);
  });

  it("givenGoWithCount_whenSplit_thenRepeatOnSpan", () => {
    expect(tsql("INSERT INTO t DEFAULT VALUES\nGO 3\nSELECT 1\nGO")).toEqual([
      { from: 0, to: 28, sql: "INSERT INTO t DEFAULT VALUES", repeat: 3 },
      { from: 34, to: 42, sql: "SELECT 1" },
    ]);
  });

  it("givenGoInsideStringOrComment_whenSplit_thenNoSeparator", () => {
    expect(statements(tsql, "SELECT 'a\nGO\nb' /*\nGO\n*/ FROM t")).toEqual(["SELECT 'a\nGO\nb' /*\nGO\n*/ FROM t"]);
  });

  it("givenProcedureWithoutBeginBeforeGo_whenSplitAsTsql_thenBodyRunsToTheSeparator", () => {
    const create = "CREATE OR ALTER PROCEDURE p AS\n  SELECT 1;\n  SELECT 2;";

    expect(statements(tsql, `${create}\nGO\nSELECT 3; SELECT 4`)).toEqual([create, "SELECT 3", "SELECT 4"]);
  });

  it("givenSlashAfterPlsqlBlock_whenSplit_thenBlockKeepsItsSemicolons", () => {
    const procedure = "CREATE OR REPLACE PROCEDURE p IS\n  n NUMBER;\nBEGIN\n  IF n > 0 THEN n := 1; END IF;\nEND;";
    const block = "DECLARE\n  x NUMBER;\nBEGIN\n  NULL;\nEND;";
    const text = `${procedure}\n/\n${block}\n /\nSELECT 1 FROM dual;\nALTER PROCEDURE p COMPILE;\nSELECT 4\n/ 2 FROM dual`;

    expect(statements(oracle, text)).toEqual([
      procedure,
      block,
      "SELECT 1 FROM dual",
      "ALTER PROCEDURE p COMPILE",
      "SELECT 4\n/ 2 FROM dual",
    ]);
  });

  it("givenQQuoteWithSemicolon_whenSplit_thenOneStatement", () => {
    expect(statements(oracle, "SELECT q'[it's; ]here]', Q'{a;}', nq'!b;'!' FROM dual; SELECT 2 FROM dual")).toEqual([
      "SELECT q'[it's; ]here]', Q'{a;}', nq'!b;'!' FROM dual",
      "SELECT 2 FROM dual",
    ]);
  });

  it("givenNationalString_whenSplit_thenOneStatement", () => {
    expect(statements(tsql, "SELECT N'a;b', n'c''d;'; SELECT 2")).toEqual(["SELECT N'a;b', n'c''d;'", "SELECT 2"]);
  });

  it("givenOptionsOff_whenSplitExistingScripts_thenIdenticalSpans", () => {
    for (const [split, text, expected] of EXISTING_SCRIPTS) expect(statements(split, text)).toEqual(expected);
  });
});
