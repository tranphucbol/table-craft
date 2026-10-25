import { FORMAT_STYLES, type FormatOptions, type SqlLanguage } from "@table-craft/plugin-api";
import { sqlFormatter } from "@table-craft/plugin-api/sql";
import mysqlPlugin from "@table-craft/plugin-mysql";
import postgresPlugin from "@table-craft/plugin-postgres";
import sqlitePlugin from "@table-craft/plugin-sqlite";
import { describe, expect, it } from "vitest";

function languageOf(plugin: { readonly language?: SqlLanguage }): SqlLanguage {
  if (plugin.language === undefined) throw new Error("the plugin has no language");
  return plugin.language;
}

const postgres = languageOf(postgresPlugin);
const mysql = languageOf(mysqlPlugin);
const sqlite = languageOf(sqlitePlugin);
const DEFAULTS: FormatOptions = {
  style: "standard",
  keywordCase: "upper",
  indentWidth: 2,
  linesBetweenStatements: 1,
  alignAliases: true,
};

describe("format (standard style)", () => {
  it("givenOneLineSelect_whenFormatted_thenOneClausePerLine", () => {
    for (const language of [postgres, mysql, sqlite]) {
      expect(language.format("select id, name from customers where id = 1", DEFAULTS)).toBe(
        "SELECT\n  id,\n  name\nFROM\n  customers\nWHERE\n  id = 1",
      );
    }
  });

  it("givenCommentsAndLiterals_whenFormatted_thenKeptByteForByte", () => {
    const comment = "-- keep  this :x\n";
    const block = "/* and   this\n     one */";
    const literal = "'it''s  a:b  ? $1'";
    const quoted = '"Odd  Name"';
    for (const language of [postgres, mysql, sqlite]) {
      const formatted = language.format(`${comment}select ${literal}, ${quoted} ${block} from t`, DEFAULTS);
      for (const piece of [comment.trimEnd(), block, literal, quoted]) expect(formatted).toContain(piece);
    }
    expect(postgres.format("select $$ a  ; b $$", DEFAULTS)).toContain("$$ a  ; b $$");
    expect(mysql.format("select 'a\\'  b' # hash  comment", DEFAULTS)).toContain("'a\\'  b' # hash  comment");
  });

  it("givenParameters_whenFormatted_thenKeptWhole", () => {
    expect(postgres.format("select * from t where a = :id and b = $1 and c = x::int", DEFAULTS)).toContain(
      "a = :id\n  AND b = $1\n  AND c = x::INT",
    );
    expect(mysql.format("select * from t where a = :id and b = ?", DEFAULTS)).toContain("a = :id\n  AND b = ?");
  });

  it("givenOptions_whenFormatted_thenKeywordCaseIndentAndBlankLinesFollow", () => {
    const options: FormatOptions = { ...DEFAULTS, keywordCase: "lower", indentWidth: 4, linesBetweenStatements: 2 };
    expect(sqlite.format("SELECT a FROM t; SELECT b FROM u;", options)).toBe(
      "select\n    a\nfrom\n    t;\n\n\nselect\n    b\nfrom\n    u;",
    );
    expect(sqlite.format("Select a From t", { ...DEFAULTS, keywordCase: "preserve" })).toBe("Select\n  a\nFrom\n  t");
  });

  it("givenUnbalancedText_whenFormatted_thenThrowsFirstLineOfReason", () => {
    for (const language of [postgres, mysql, sqlite]) {
      expect(() => language.format("select (( from", DEFAULTS)).toThrow(/^Parse error[^\n]*$/);
      expect(() => language.format("select 'unterminated", DEFAULTS)).toThrow(/^Parse error[^\n]*$/);
    }
  });

  it("givenDelimiterScript_whenFormattedAsMysql_thenRefused", () => {
    const script = "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END //\nDELIMITER ;";
    expect(() => mysql.format(script, DEFAULTS)).toThrow(/DELIMITER/);
    expect(mysql.format("select 'DELIMITER //'", DEFAULTS)).toBe("SELECT\n  'DELIMITER //'");
  });
});

describe("format: optimizer hints", () => {
  const HINTED =
    "select /*+ USE_INDEX(order_events_202601, order_events_shop_id) */ * from order_events_202601 limit 10";

  it.each(FORMAT_STYLES)("given%sStyle_whenHintedSelectFormatted_thenHintStaysRightAfterTheVerb", (style) => {
    expect(mysql.format(HINTED, { ...DEFAULTS, style })).toMatch(
      /^SELECT\s+\/\*\+ USE_INDEX\(order_events_202601, order_events_shop_id\) \*\//,
    );
  });
});

describe("format: the PL/SQL and T-SQL dialects (decision 100)", () => {
  const tsql = sqlFormatter({
    dialect: "transactsql",
    lexer: { bracketIdentifiers: true, batchSeparator: "go", nationalStrings: true },
    parameters: ["named"],
  });
  const plsql = sqlFormatter({
    dialect: "plsql",
    lexer: { batchSeparator: "slash", qQuotes: true, nationalStrings: true },
    parameters: ["named"],
  });
  const TSQL_STATEMENT =
    "select [o].[id], c.name as [Customer Name], N'café' as label from dbo.orders o join dbo.customers c on c.id = o.customer_id where o.total > :min order by o.id";
  const PLSQL_STATEMENT =
    "select o.id, c.name as customer, q'[it's]' as label from orders o join customers c on c.id = o.customer_id where o.total > :min order by o.id";

  it("givenPlsqlAndTransactsql_whenFormatted_thenGoldenMatches", () => {
    expect(tsql.format(TSQL_STATEMENT, { ...DEFAULTS, style: "aligned" })).toBe(
      [
        "SELECT [o].[id],",
        "       c.name  AS [Customer Name],",
        "       N'café' AS label",
        "FROM dbo.orders o",
        "     JOIN dbo.customers c ON c.id = o.customer_id",
        "WHERE o.total > :min",
        "ORDER BY o.id",
      ].join("\n"),
    );
    expect(tsql.format(TSQL_STATEMENT, DEFAULTS)).toBe(
      [
        "SELECT",
        "  [o].[id],",
        "  c.name AS [Customer Name],",
        "  N'café' AS label",
        "FROM",
        "  dbo.orders o",
        "  JOIN dbo.customers c ON c.id = o.customer_id",
        "WHERE",
        "  o.total > :min",
        "ORDER BY",
        "  o.id",
      ].join("\n"),
    );
    expect(plsql.format(PLSQL_STATEMENT, { ...DEFAULTS, style: "aligned" })).toBe(
      [
        "SELECT o.id,",
        "       c.name    AS customer,",
        "       q'[it's]' AS label",
        "FROM orders o",
        "     JOIN customers c ON c.id = o.customer_id",
        "WHERE o.total > :min",
        "ORDER BY o.id",
      ].join("\n"),
    );
    expect(plsql.format(PLSQL_STATEMENT, DEFAULTS)).toBe(
      [
        "SELECT",
        "  o.id,",
        "  c.name AS customer,",
        "  q'[it's]' AS label",
        "FROM",
        "  orders o",
        "  JOIN customers c ON c.id = o.customer_id",
        "WHERE",
        "  o.total > :min",
        "ORDER BY",
        "  o.id",
      ].join("\n"),
    );
  });

  it("givenBatchSeparatorLine_whenFormatted_thenRefused", () => {
    expect(() => tsql.format("select 1\nGO\nselect 2", DEFAULTS)).toThrow(/batch separator/);
    expect(() => plsql.format("begin null; end;\n/", DEFAULTS)).toThrow(/batch separator/);
    expect(tsql.format("select 'GO'", DEFAULTS)).toBe("SELECT\n  'GO'");
  });
});
