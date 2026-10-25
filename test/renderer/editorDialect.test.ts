import { MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL } from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { StringStream } from "@codemirror/language";
import { dialectOf, highlighterOf, keywordDialectOf } from "@table-craft/desktop/renderer/console/Editor.js";
import { redisLanguage, redisParser } from "@table-craft/desktop/renderer/console/highlighters/redis.js";

describe("editor dialect", () => {
  it("givenHighlightPlsqlAndMssql_whenEditorBuilt_thenDialectApplied", () => {
    expect(dialectOf("plsql")).toBe(PLSQL);
    expect(dialectOf("mssql")).toBe(MSSQL);
  });

  it("givenExistingHighlights_whenEditorBuilt_thenDialectsUnchanged", () => {
    expect(dialectOf("postgresql")).toBe(PostgreSQL);
    expect(dialectOf("mysql")).toBe(MySQL);
    expect(dialectOf("sqlite")).toBe(SQLite);
    expect(dialectOf("db2")).toBe(StandardSQL);
    expect(dialectOf(null)).toBe(StandardSQL);
  });

  it("givenHighlightRedis_whenEditorBuilt_thenCommandHighlighterAndNoSqlKeywords", () => {
    expect(highlighterOf("redis")).toBe(redisLanguage);
    expect(keywordDialectOf("redis")).toBeNull();
    expect(keywordDialectOf("mysql")).toBe(MySQL);
  });

  it("givenRedisLine_whenTokenized_thenCommandStringNumberAndComment", () => {
    const tokens = (line: string): string[] => {
      const parser = redisParser;
      const state = parser.startState?.(2) ?? { commandSeen: false };
      const stream = new StringStream(line, 2, 2);
      const found: string[] = [];
      while (!stream.eol()) {
        const style = parser.token(stream, state);
        if (style !== null) found.push(`${style}:${stream.current()}`);
        stream.start = stream.pos;
      }
      return found;
    };
    expect(tokens('HSET user:1 name "Ann \\"A\\"" 42')).toEqual(["keyword:HSET", 'string:"Ann \\"A\\""', "number:42"]);
    expect(tokens("# a comment")).toEqual(["comment:# a comment"]);
  });
});
