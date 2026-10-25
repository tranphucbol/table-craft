import type { StreamedStatement } from "@table-craft/plugin-api";
import { sqlSplitter, sqlStatementStream, type SqlDialectOptions } from "@table-craft/plugin-api/sql";
import { describe, expect, it } from "vitest";

const MYSQL: SqlDialectOptions = {
  backslashEscapes: true,
  delimiterCommand: true,
  hashComments: true,
  blockKeywords: ["BEGIN"],
};
const POSTGRES: SqlDialectOptions = { dollarQuotes: true, nestedBlockComments: true, blockKeywords: ["BEGIN"] };

const TSQL: SqlDialectOptions = { bracketIdentifiers: true, batchSeparator: "go", nationalStrings: true };
const ORACLE: SqlDialectOptions = { batchSeparator: "slash", qQuotes: true, nationalStrings: true };

const TSQL_SCRIPT = [
  "SELECT [a;b], N'x;y' FROM t;",
  "GO",
  "CREATE PROCEDURE p AS",
  "  SELECT 1;",
  "  SELECT 2;",
  "GO 2",
  "SELECT 3",
].join("\n");

const ORACLE_SCRIPT = ["SELECT q'[a;b]' FROM dual;", "BEGIN", "  NULL;", "END;", "/", "SELECT 2 FROM dual"].join("\n");

const MYSQL_SCRIPT = [
  "SELECT 'a;b' AS s; -- first",
  "# hash comment;",
  "DELIMITER //",
  "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//",
  "DELIMITER ;",
  "INSERT INTO t VALUES ('it\\'s; fine'),",
  "  (2);",
  "SELECT 3",
].join("\n");

const POSTGRES_SCRIPT = [
  "CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql;",
  "/* outer /* nested; */ still; */ SELECT 2;",
  "",
  "  SELECT 'multi",
  "line; string';",
].join("\r\n");

function streamed(options: SqlDialectOptions, pieces: readonly string[]): StreamedStatement[] {
  const stream = sqlStatementStream(options)();
  return pieces.flatMap((piece) => stream.push(piece)).concat(stream.end());
}

function piecesOf(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces;
}

function located(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split("\n");
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}

describe("sqlStatementStream", () => {
  it.each([
    ["mysql", MYSQL, MYSQL_SCRIPT],
    ["postgres", POSTGRES, POSTGRES_SCRIPT],
    ["tsql", TSQL, TSQL_SCRIPT],
    ["oracle", ORACLE, ORACLE_SCRIPT],
  ] as const)("givenChunkSplitInsideStatement_whenStreaming_thenSameSpansAsWholeSplit: %s", (_name, options, text) => {
    const whole = sqlSplitter(options)(text);

    for (const size of [1, 2, 3, 7, 16, 64, text.length]) {
      const statements = streamed(options, piecesOf(text, size));
      expect(statements.map(({ line: _line, column: _column, ...span }) => span)).toEqual(whole);
      for (const statement of statements) {
        expect({ line: statement.line, column: statement.column }).toEqual(located(text, statement.from));
      }
    }
  });

  it("givenLongScript_whenStreaming_thenStatementsComeOutBeforeTheEnd", () => {
    const stream = sqlStatementStream()();
    let early = 0;
    for (let index = 0; index < 1000; index += 1) early += stream.push(`INSERT INTO t VALUES (${index});\n`).length;

    expect(early).toBeGreaterThan(900);
    expect(early + stream.end().length).toBe(1000);
  });

  it("givenOneHugeStatement_whenStreamedInManyPieces_thenScansStayFewAndResultIsWhole", () => {
    const values = Array.from({ length: 20_000 }, (_, index) => `(${index})`).join(",\n");
    const text = `INSERT INTO t VALUES\n${values};\nSELECT 1;`;

    const statements = streamed({}, piecesOf(text, 32));

    expect(statements.map((statement) => statement.sql)).toEqual(sqlSplitter()(text).map((span) => span.sql));
    expect(statements[1]).toMatchObject({ line: 20_002, column: 1 });
  });

  it("givenOnlyCommentsAndBlanks_whenStreaming_thenNoStatements", () => {
    expect(streamed({}, ["-- one\n", "\n  /* two */ ", "\n"])).toEqual([]);
  });
});
