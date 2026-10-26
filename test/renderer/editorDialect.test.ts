import { MSSQL, MySQL, PLSQL, PostgreSQL, SQLite, StandardSQL } from "@codemirror/lang-sql";
import { describe, expect, it } from "vitest";
import { language, StringStream } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
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
    expect(highlighterOf({ capabilities: ["commands"], highlight: "redis" })).toBe(redisLanguage);
    expect(keywordDialectOf({ capabilities: ["commands"], highlight: "redis" })).toBeNull();
    expect(keywordDialectOf({ capabilities: ["sql"], highlight: "mysql" })).toBe(MySQL);
  });

  it("givenUnknownOrMisleadingCommandHighlight_whenEditorBuilt_thenUsesPlainTextAndNoSQLKeywords", () => {
    for (const highlight of ["unknown", "mysql", null]) {
      const plugin = { capabilities: ["commands"], highlight };
      expect(keywordDialectOf(plugin)).toBeNull();
      expect(EditorState.create({ extensions: [highlighterOf(plugin)] }).facet(language)).toBeNull();
    }
    for (const plugin of [undefined, { capabilities: [], highlight: "mysql" }]) {
      expect(keywordDialectOf(plugin)).toBeNull();
      expect(EditorState.create({ extensions: [highlighterOf(plugin)] }).facet(language)).toBeNull();
    }
  });

  it("givenUnknownSQLHighlight_whenEditorBuilt_thenUsesStandardSQL", () => {
    const plugin = { capabilities: ["sql"], highlight: "unknown" };
    expect(keywordDialectOf(plugin)).toBe(StandardSQL);
    expect(EditorState.create({ extensions: [highlighterOf(plugin)] }).facet(language)).not.toBeNull();
  });

  it("givenCapabilityChangeWithUnchangedHighlight_whenReconfigured_thenChangesLanguageWithoutLosingUndo", () => {
    const compartment = new Compartment();
    const sqlPlugin = { capabilities: ["sql"], highlight: "mysql" };
    const commandPlugin = { ...sqlPlugin, capabilities: ["commands"] };
    let state = EditorState.create({
      doc: "before",
      extensions: [history(), compartment.of(highlighterOf(sqlPlugin))],
    });
    state = state.update({ changes: { from: 0, to: 6, insert: "after" } }).state;
    state = state.update({ effects: compartment.reconfigure(highlighterOf(commandPlugin)) }).state;
    expect(state.facet(language)).toBeNull();
    expect(keywordDialectOf(commandPlugin)).toBeNull();
    expect(
      undo({
        state,
        dispatch: (transaction) => {
          state = transaction.state;
        },
      }),
    ).toBe(true);
    expect(state.doc.toString()).toBe("before");
    state = state.update({ effects: compartment.reconfigure(highlighterOf(sqlPlugin)) }).state;
    expect(state.facet(language)).not.toBeNull();
    expect(keywordDialectOf(sqlPlugin)).toBe(MySQL);
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
