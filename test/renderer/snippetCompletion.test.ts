import {
  CompletionContext,
  hasNextSnippetField,
  nextSnippetField,
  prevSnippetField,
  type Completion,
} from "@codemirror/autocomplete";
import { history, undo } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { replacingRestOfWord, restOfWordFilter } from "@table-craft/desktop/renderer/console/completionKeys.js";
import { engineCompletionSource } from "@table-craft/desktop/renderer/console/completionSource.js";
import {
  applySnippet,
  snippetSource,
  snippetPreview,
} from "@table-craft/desktop/renderer/console/snippetCompletion.js";
import type { TextSnippet } from "@table-craft/desktop/snippets/snippets.js";

const ITEM: TextSnippet = {
  id: "select",
  name: "Select rows",
  prefix: "sel",
  body: "SELECT * FROM ${table}${cursor};",
  scope: { kind: "all" },
};

function editor(doc = "sel", at = doc.length) {
  let state = EditorState.create({
    doc,
    selection: { anchor: at },
    extensions: [EditorState.allowMultipleSelections.of(true), history(), restOfWordFilter],
  });
  return {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction | TransactionSpec) {
      state = transaction instanceof Transaction ? transaction.state : state.update(transaction).state;
    },
  };
}

function expand(body: string, view = editor(), from = 0, to = view.state.selection.main.head) {
  const apply = applySnippet(body);
  if (typeof apply !== "function") throw new Error("Expected snippet apply function");
  apply(view, { label: "sel" }, from, to);
  return view;
}

function selected(view: ReturnType<typeof editor>) {
  return view.state.selection.ranges.map((range) => view.state.sliceDoc(range.from, range.to));
}

function context(doc: string, pos = doc.length) {
  return new CompletionContext(EditorState.create({ doc, extensions: [sql({ dialect: PostgreSQL })] }), pos, false);
}

describe("text snippet fields", () => {
  it("givenPlaceholdersAndEscapes_whenPreviewed_thenMatchesInitialInsertedText", () => {
    for (const body of [
      ITEM.body,
      "${field} ${field} ${cursor} ${2}",
      "\\${field} \\\\${field} {json}",
      "",
      "${unterminated",
    ]) {
      expect(snippetPreview(body)).toBe(expand(body).state.doc.toString());
    }
  });
  it("givenNamedFields_whenExpanded_thenRepeatedNamesAreLinkedAndNavigateInTextOrder", () => {
    const view = expand("${table} ${schema} ${table} ${custom}");
    expect(selected(view)).toEqual(["table", "table"]);
    view.dispatch(view.state.update(view.state.replaceSelection("orders")));
    expect(view.state.doc.toString()).toBe("orders schema orders custom");
    expect(nextSnippetField(view)).toBe(true);
    expect(selected(view)).toEqual(["schema"]);
    expect(prevSnippetField(view)).toBe(true);
    expect(selected(view)).toEqual(["orders", "orders"]);
    nextSnippetField(view);
    nextSnippetField(view);
    expect(selected(view)).toEqual(["custom"]);
    nextSnippetField(view);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    expect(hasNextSnippetField(view.state)).toBe(false);
  });

  it("givenCursorInMiddleAndNumericNames_whenNavigating_thenCursorIsLastAndZeroWidth", () => {
    const view = expand("${table}${cursor} ${2} ${schema}");
    expect(selected(view)).toEqual(["table"]);
    nextSnippetField(view);
    expect(selected(view)).toEqual(["2"]);
    nextSnippetField(view);
    expect(selected(view)).toEqual(["schema"]);
    nextSnippetField(view);
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe("table".length);
    expect(nextSnippetField(view)).toBe(false);
  });

  it("givenLiteralBracesBackslashesAndEscapedFields_whenExpanded_thenPreservesSQLText", () => {
    const body = String.raw`SELECT '{"a":1}', '\\path\{x\}', '#{literal}', '\${table}', ` + "${table}";
    const view = expand(body);
    expect(view.state.doc.toString()).toBe(
      String.raw`SELECT '{"a":1}', '\\path\{x\}', '#{literal}', '` + "${table}', table",
    );
    expect(selected(view)).toEqual(["table"]);
  });

  it("givenCursorOnly_whenExpanded_thenSelectsItsPositionWithoutAnActiveSnippet", () => {
    const view = expand("SELECT ${cursor} FROM t");
    expect(view.state.doc.toString()).toBe("SELECT  FROM t");
    expect(view.state.selection.main.head).toBe("SELECT ".length);
    expect(nextSnippetField(view)).toBe(false);
  });

  it("givenTabReplacementInsideWord_whenExpanded_thenFieldsStaySelectedAndUndoIsOneStep", () => {
    const view = editor("sel_old WHERE true", 3);
    replacingRestOfWord(() => expand(ITEM.body, view));
    expect(view.state.doc.toString()).toBe("SELECT * FROM table; WHERE true");
    expect(selected(view)).toEqual(["table"]);
    nextSnippetField(view);
    expect(view.state.selection.main.head).toBe("SELECT * FROM table".length);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("sel_old WHERE true");
  });

  it("givenEnterReplacement_whenExpanded_thenKeepsIdentifierSuffix", () => {
    const view = expand(ITEM.body, editor("sel_old", 3));
    expect(view.state.doc.toString()).toBe("SELECT * FROM table;_old");
    expect(selected(view)).toEqual(["table"]);
  });
});

describe("console snippet source", () => {
  const items: TextSnippet[] = [
    ITEM,
    { ...ITEM, id: "pg", scope: { kind: "sql", highlight: "postgresql" } },
    { ...ITEM, id: "mysql", scope: { kind: "sql", highlight: "mysql" } },
  ];
  const source = snippetSource({
    snippets: () => items,
    plugin: () => ({ id: "database", capabilities: ["sql"], highlight: "postgresql" }),
  });

  it("givenAbbreviation_whenCompleting_thenOffersGlobalAndMatchingHighlightOnly", async () => {
    expect((await source(context("se")))?.options).toHaveLength(2);
    expect(await source(context("unrelated"))).toBeNull();
    expect(await source(context("SELECT "))).toBeNull();
  });

  it("givenCommandsWithSQLHighlight_whenCompleting_thenOffersOnlyAllScope", async () => {
    const commands = snippetSource({
      snippets: () => items,
      plugin: () => ({ id: "commands", capabilities: ["commands"], highlight: "postgresql" }),
    });
    expect((await commands(context("sel")))?.options).toHaveLength(1);
  });

  it("givenUnknownHighlightWithSQLCapability_whenCompleting_thenOffersGlobalSnippets", async () => {
    const custom = snippetSource({
      snippets: () => items,
      plugin: () => ({ id: "custom", capabilities: ["sql"], highlight: "custom" }),
    });
    expect((await custom(context("sel")))?.options).toHaveLength(1);
  });

  it("givenTwoOfflineCommandPluginsWithSameUnknownHighlight_whenCompleting_thenIsolatesScopesAndLabels", async () => {
    const snippets: TextSnippet[] = [
      ITEM,
      { ...ITEM, id: "sql", scope: { kind: "sql" } },
      { ...ITEM, id: "first", scope: { kind: "plugin", pluginId: "first" } },
      { ...ITEM, id: "second", scope: { kind: "plugin", pluginId: "second" } },
    ];
    let plugin = { id: "first", name: "First console", capabilities: ["commands"], highlight: "unknown" };
    const offline = snippetSource({ snippets: () => snippets, plugin: () => plugin });
    const engine = engineCompletionSource({ dialect: () => null, engine: () => null });
    expect(await engine(context("sel"))).toBeNull();
    const first = (await offline(context("sel")))?.options ?? [];
    expect(first.map((option) => option.detail)).toEqual([
      "Select rows · All consoles",
      "Select rows · First console (first)",
    ]);
    plugin = { ...plugin, id: "second", name: "Second console" };
    expect((await offline(context("sel")))?.options.map((option) => option.detail)).toEqual([
      "Select rows · All consoles",
      "Select rows · Second console (second)",
    ]);
    plugin = { ...plugin, capabilities: ["sql"] };
    expect((await offline(context("sel")))?.options).toHaveLength(3);
    plugin = { ...plugin, capabilities: [] };
    expect(await offline(context("sel"))).toBeNull();
  });

  it("givenNoDatasourceMetadata_whenCompleting_thenOffersNothing", async () => {
    const missing = snippetSource({ snippets: () => [ITEM], plugin: () => undefined });
    expect(await missing(context("sel"))).toBeNull();
  });

  it("givenCommandJSONSnippet_whenExpanded_thenPreservesBracesAndLinkedFields", () => {
    const view = expand('PUT {"id":"${key}","nested":{"ref":"${key}"}}${cursor}');
    expect(view.state.doc.toString()).toBe('PUT {"id":"key","nested":{"ref":"key"}}');
    expect(selected(view)).toEqual(["key", "key"]);
    nextSnippetField(view);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("givenStringsCommentsAndQuotedNames_whenCompleting_thenSuppressesSnippets", async () => {
    for (const doc of ["SELECT 'sel", "-- sel", "/* sel", 'SELECT "sel']) {
      expect(await source(context(doc))).toBeNull();
    }
  });

  it("givenSnippetAndSQLSources_whenCompleting_thenKeepsBoth", async () => {
    const ctx = context("sel");
    const keywords = engineCompletionSource({ dialect: () => PostgreSQL, engine: () => null });
    expect((await keywords(ctx))?.options.map((item) => item.label)).toContain("SELECT");
    const options = (await source(ctx))?.options;
    expect(options?.map((item) => item.label)).toContain("sel");
    const view = editor();
    const option = options?.[0] as Completion;
    if (typeof option.apply !== "function") throw new Error("Expected a native snippet completion");
    option.apply(view as unknown as EditorView, option, 0, 3);
    expect(selected(view)).toEqual(["table"]);
  });
});
