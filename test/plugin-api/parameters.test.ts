import type { SqlLanguage } from "@table-craft/plugin-api";
import { sqlParameters } from "@table-craft/plugin-api/sql";
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

function names(language: SqlLanguage, statement: string): string[] {
  return language.parameters(statement).map((parameter) => parameter.name);
}

describe("parameters", () => {
  it("givenNamedParameter_whenDetected_thenNameAndSpan", () => {
    const statement = "SELECT * FROM t WHERE id = :id";
    for (const language of [postgres, mysql, sqlite]) {
      expect(language.parameters(statement)).toEqual([{ name: ":id", from: 27, to: 30, style: "named" }]);
    }
  });

  it("givenCast_whenDetected_thenNone", () => {
    expect(names(postgres, "SELECT x::int, '1'::text, y :: date FROM t")).toEqual([]);
    expect(names(postgres, "SELECT :id::int")).toEqual([":id"]);
  });

  it("givenLiteralsAndComments_whenDetected_thenNone", () => {
    const statement = `SELECT 'a:b', "col:x", 'is ?' -- :x ?\n /* ? :y $1 */ FROM t`;
    for (const language of [postgres, mysql, sqlite]) expect(names(language, statement)).toEqual([]);
    expect(names(mysql, "SELECT `a:b`, 'it\\'s :x' FROM t")).toEqual([]);
    expect(names(mysql, "SELECT 1 # :x ?\nFROM t")).toEqual([]);
    expect(names(postgres, "SELECT E'\\' :x' FROM t")).toEqual([]);
  });

  it("givenDollarBody_whenDetectedOnPostgres_thenNone", () => {
    expect(names(postgres, "CREATE FUNCTION f() RETURNS int AS $$ SELECT $1 + :x $$ LANGUAGE sql")).toEqual([]);
    expect(names(postgres, "SELECT $tag$ :x $1 $tag$, $1")).toEqual(["$1"]);
  });

  it("givenNumbered_whenDetected_thenOnlyOnPostgres", () => {
    expect(names(postgres, "SELECT $1, $2, $1")).toEqual(["$1", "$2", "$1"]);
    expect(names(mysql, "SELECT $1")).toEqual([]);
    expect(names(sqlite, "SELECT $1")).toEqual([]);
  });

  it("givenUserVariable_whenDetectedOnMysql_thenNone", () => {
    expect(names(mysql, "SET @total := 1")).toEqual([]);
    expect(names(mysql, "SELECT @total, :limit")).toEqual([":limit"]);
  });

  it("givenJsonbQuestionMark_whenDetectedOnPostgres_thenNone", () => {
    expect(names(postgres, "SELECT doc ? 'k', doc ?| array['a'] FROM t WHERE id = $1")).toEqual(["$1"]);
  });

  it("givenQuestionMarks_whenDetected_thenNumberedInOrder", () => {
    expect(mysql.parameters("INSERT INTO t VALUES (?, ?)")).toEqual([
      { name: "?1", from: 22, to: 23, style: "positional" },
      { name: "?2", from: 25, to: 26, style: "positional" },
    ]);
    expect(names(sqlite, "SELECT ? WHERE ? > 0")).toEqual(["?1", "?2"]);
  });

  it("givenSliceLabelOrNumber_whenDetected_thenNone", () => {
    expect(names(postgres, "SELECT arr[lo:hi], arr[1:2] FROM t")).toEqual([]);
    expect(names(mysql, "label: LOOP LEAVE label; END LOOP label")).toEqual([]);
    expect(names(mysql, "SELECT :1")).toEqual([]);
  });

  it("givenRepeatedName_whenBoundOnPostgres_thenOneNumberedPlaceholder", () => {
    const bound = postgres.bind("SELECT :a, :b, :a, ':a'", { ":a": "1", ":b": null });
    expect(bound).toEqual({ sql: "SELECT $1, $2, $1, ':a'", params: ["1", null] });
  });

  it("givenNumberedOutOfOrder_whenBoundOnPostgres_thenRenumberedByFirstUse", () => {
    expect(postgres.bind("SELECT $2, $1", { $1: "a", $2: "b" })).toEqual({ sql: "SELECT $1, $2", params: ["b", "a"] });
  });

  it("givenRepeatedName_whenBoundOnMysql_thenOneValuePerOccurrence", () => {
    const bound = mysql.bind("SELECT :a, ?, :a", { ":a": "x", "?1": "y" });
    expect(bound).toEqual({ sql: "SELECT ?, ?, ?", params: ["x", "y", "x"] });
  });

  it("givenNoParameters_whenBound_thenUnchanged", () => {
    expect(sqlite.bind("SELECT ':x'", {})).toEqual({ sql: "SELECT ':x'", params: [] });
  });

  it("givenMissingValue_whenBound_thenRejects", () => {
    expect(() => sqlite.bind("SELECT :a", {})).toThrow(/No value for the parameter :a/);
    expect(() => sqlite.bind("SELECT :toString", {})).toThrow(/:toString/);
  });

  it("givenNoStyles_whenDetected_thenNone", () => {
    const { parameters } = sqlParameters({ dialect: {}, styles: [], native: "positional" });
    expect(parameters("SELECT :a, ?, $1")).toEqual([]);
  });

  it("givenColonNumbered_whenBind_thenColonPlaceholders", () => {
    const { bind } = sqlParameters({ dialect: {}, styles: ["named", "positional"], native: "colonNumbered" });
    expect(bind("SELECT :a, ?, :a FROM dual", { ":a": "x", "?1": "y" })).toEqual({
      sql: "SELECT :1, :2, :3 FROM dual",
      params: ["x", "y", "x"],
    });
  });

  it("givenAtNumbered_whenBind_thenAtPlaceholders", () => {
    const { bind } = sqlParameters({ dialect: { bracketIdentifiers: true }, styles: ["named"], native: "atNumbered" });
    expect(bind("SELECT :a, [:b], :b, :a", { ":a": "x", ":b": "2" })).toEqual({
      sql: "SELECT @p1, [:b], @p2, @p1",
      params: ["x", "2"],
    });
  });
});
