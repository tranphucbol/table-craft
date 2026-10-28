import { errorPositionOf, offsetOfPosition, PluginError } from "@table-craft/plugin-api";
import { serverErrorPosition as mssqlErrorPosition } from "@table-craft/plugin-mssql/errorPosition";
import { syntaxErrorPosition } from "@table-craft/plugin-mysql/errorPosition";
import { serverErrorPosition } from "@table-craft/plugin-postgres/errorPosition";
import { sqliteErrorPosition } from "@table-craft/plugin-sqlite/errorPosition";
import { describe, expect, it } from "vitest";

const MYSQL_PREFIX =
  "You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use";
const TIDB_PREFIX =
  "You have an error in your SQL syntax; check the manual that corresponds to your TiDB version for the right syntax to use";

describe("error positions in the contract", () => {
  it("givenPositionInOptions_whenReadAcrossBundles_thenShapeChecked", () => {
    expect(errorPositionOf(new PluginError("statementFailed", "x", { position: { offset: 3 } }))).toEqual({
      offset: 3,
    });
    expect(errorPositionOf(new PluginError("statementFailed", "x", { position: { line: 2, column: 4 } }))).toEqual({
      line: 2,
      column: 4,
    });
    expect(errorPositionOf(new PluginError("statementFailed", "x"))).toBeUndefined();
    const foreign = Object.assign(new Error("x"), {
      name: "PluginError",
      code: "statementFailed",
      position: { offset: -1 },
    });
    expect(errorPositionOf(foreign)).toBeUndefined();
    expect(errorPositionOf(new Error("x"))).toBeUndefined();
  });

  it("givenLineAndColumn_whenOffset_thenCountsFromLineStartAndClamps", () => {
    const text = "SELECT 1;\nSELECT x\nFROM t";
    expect(offsetOfPosition(text, { line: 2, column: 8 })).toBe(text.indexOf("x"));
    expect(offsetOfPosition(text, { line: 2, column: 99 })).toBe(text.indexOf("\nFROM"));
    expect(offsetOfPosition(text, { line: 9, column: 1 })).toBe(text.length);
    expect(offsetOfPosition(text, { offset: 999 })).toBe(text.length);
  });
});

describe("postgres error position", () => {
  it("givenPgSyntaxError_whenRun_thenPositionPointsAtToken", () => {
    const sql = "SELECT 1 FROM";
    expect(serverErrorPosition(sql, { position: "14" })).toEqual({ offset: 13 });
    expect(serverErrorPosition("SELECT id, FROM t", { position: "12" })).toEqual({ offset: 11 });
  });

  it("givenAstralCharactersBefore_whenConverted_thenUtf16Offset", () => {
    const sql = "SELECT '😀😀' frm";
    expect(serverErrorPosition(sql, { position: "13" })).toEqual({ offset: sql.indexOf("frm") });
  });

  it("givenNoPosition_whenRead_thenUndefined", () => {
    expect(serverErrorPosition("SELECT 1", {})).toBeUndefined();
    expect(serverErrorPosition("SELECT 1", { position: "0" })).toBeUndefined();
    expect(serverErrorPosition("SELECT 1", null)).toBeUndefined();
  });
});

describe("mysql error position", () => {
  it("givenMysqlNearFragment_whenRun_thenLineAndColumnFound", () => {
    const sql = "SELECT id,\n  name\nFRM customers WHERE id = 1";
    const message = `${MYSQL_PREFIX} near 'customers WHERE id = 1' at line 3`;
    expect(syntaxErrorPosition(sql, message)).toEqual({ offset: sql.indexOf("customers") });
  });

  it("givenTruncatedFragment_whenFound_thenSearchedFromItsLine", () => {
    const sql = "SELECT a FROM t;\nSELECT a FROM t WHERE ((((";
    const message = `${MYSQL_PREFIX} near 'FROM t WHERE ((' at line 2`;
    expect(syntaxErrorPosition(sql, message)).toEqual({ offset: sql.lastIndexOf("FROM") });
  });

  it("givenEmptyFragment_whenRun_thenEndOfStatement", () => {
    const sql = "SELECT * FROM t WHERE  ";
    expect(syntaxErrorPosition(sql, `${MYSQL_PREFIX} near '' at line 1`)).toEqual({ offset: sql.trimEnd().length });
  });

  it("givenFragmentNotInText_whenRun_thenLineStart", () => {
    expect(syntaxErrorPosition("SELECT 1\nSELECT 2", `${MYSQL_PREFIX} near 'zzz' at line 2`)).toEqual({
      line: 2,
      column: 1,
    });
  });

  it("givenTidbLineColumnNear_whenRun_thenFragmentFound", () => {
    const sql = "SELECT a\nFROM t WHER a = 1";
    const message = `${TIDB_PREFIX} line 2 column 12 near "a = 1" `;
    expect(syntaxErrorPosition(sql, message)).toEqual({ offset: sql.indexOf("a = 1") });
  });

  it("givenOtherError_whenRun_thenNoPosition", () => {
    expect(syntaxErrorPosition("SELECT nme FROM t", "Unknown column 'nme' in 'field list'")).toBeUndefined();
  });
});

describe("sqlite error position", () => {
  it("givenUniqueToken_whenNear_thenPointsAtIt", () => {
    const sql = "SELECT a\nFROM t\nWHER a = 1";
    expect(sqliteErrorPosition(sql, 'near "WHER": syntax error')).toEqual({ offset: sql.indexOf("WHER") });
  });

  it("givenTokenOnceOrTwice_whenNear_thenOnlyUniqueOnePointedAt", () => {
    expect(sqliteErrorPosition("SELECT a, a b c FROM t", 'near "c": syntax error')).toEqual({ offset: 14 });
    expect(sqliteErrorPosition("SELECT t.a FROM t t2 t3", 'near "t3": syntax error')).toEqual({ offset: 21 });
    expect(sqliteErrorPosition("SELECT a FROM t, t t", 'near "t": syntax error')).toBeUndefined();
  });

  it("givenMissingNames_whenUnique_thenPointsAtThem", () => {
    expect(sqliteErrorPosition("SELECT nme FROM t", "no such column: nme")).toEqual({ offset: 7 });
    expect(sqliteErrorPosition("SELECT * FROM ordrs", "no such table: main.ordrs")).toEqual({ offset: 14 });
  });

  it("givenIncompleteInput_whenRun_thenEndOfStatement", () => {
    expect(sqliteErrorPosition("SELECT (1 ", "incomplete input")).toEqual({ offset: 9 });
  });
});

describe("mssql error positions", () => {
  it("givenErrorOnLineThree_whenRead_thenFirstTextOfThatLine", () => {
    expect(mssqlErrorPosition("PRINT 1\nPRINT 2\n    SELECT * FROM nope", { lineNumber: 3, procName: "" })).toEqual({
      line: 3,
      column: 5,
    });
  });

  it("givenErrorInsideProcedure_whenRead_thenNoPosition", () => {
    expect(mssqlErrorPosition("EXEC p", { lineNumber: 7, procName: "p" })).toBeUndefined();
  });

  it("givenLineBeyondText_whenRead_thenNoPosition", () => {
    expect(mssqlErrorPosition("SELECT 1", { lineNumber: 4 })).toBeUndefined();
    expect(mssqlErrorPosition("SELECT 1", { lineNumber: 0 })).toBeUndefined();
  });
});
