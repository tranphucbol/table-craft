import {
  CompletionContext,
  type Completion,
  type CompletionResult as EditorCompletionResult,
} from "@codemirror/autocomplete";
import { PostgreSQL } from "@codemirror/lang-sql";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { CompletionResult } from "@table-craft/desktop/engine/protocol.js";
import { completionGlyphMarkup } from "@table-craft/desktop/renderer/console/completionGlyphs.js";
import {
  compareByEngineOrder,
  engineCompletionSource,
  toEditorResult,
  type CompleteCall,
} from "@table-craft/desktop/renderer/console/completionSource.js";

const RESULT: CompletionResult = {
  from: 14,
  to: 14,
  items: [
    { label: "orders", kind: "table", detail: "public", apply: "orders", boost: 30, info: null, caret: null },
    { label: "Line Items", kind: "table", detail: "public", apply: '"Line Items"', boost: 30, info: null, caret: null },
  ],
  validFor: "^[A-Za-z0-9_$]*$",
};

function contextAt(doc: string, explicit: boolean, pos = doc.length): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit);
}

interface Deferred {
  readonly params: Parameters<CompleteCall>[0];
  readonly resolve: (result: CompletionResult) => void;
}

function deferredEngine(): { readonly calls: Deferred[]; readonly call: CompleteCall } {
  const calls: Deferred[] = [];
  return {
    calls,
    call: (params) => new Promise((resolve) => calls.push({ params, resolve })),
  };
}

async function labels(result: EditorCompletionResult | null | Promise<EditorCompletionResult | null>) {
  return (await result)?.options.map((option) => option.label) ?? null;
}

describe("engine completion source", () => {
  it("givenStaleDocumentVersion_whenResponseArrives_thenDropped", async () => {
    const engine = deferredEngine();
    const source = engineCompletionSource({ dialect: () => PostgreSQL, engine: () => engine.call });

    const first = source(contextAt("SELECT * FROM o", true));
    const second = source(contextAt("SELECT * FROM or", true));
    engine.calls[1]?.resolve(RESULT);
    engine.calls[0]?.resolve(RESULT);

    expect(await first).toBeNull();
    expect(await labels(second)).toEqual(["orders", "Line Items"]);
  });

  it("givenEditorLostFocus_whenResponseArrives_thenDropped", async () => {
    const engine = deferredEngine();
    const source = engineCompletionSource({ dialect: () => PostgreSQL, engine: () => engine.call });
    const view = { hasFocus: true };
    const context = new CompletionContext(
      EditorState.create({ doc: "SELECT * FROM o" }),
      "SELECT * FROM o".length,
      false,
      view as EditorView,
    );

    const pending = source(context);
    view.hasFocus = false;
    engine.calls[0]?.resolve(RESULT);

    expect(await pending).toBeNull();
  });

  it("givenDisconnectedDatasource_whenCompleting_thenOffersKeywordsWithoutAskingAnEngine", async () => {
    const source = engineCompletionSource({ dialect: () => PostgreSQL, engine: () => null });

    const offered = await labels(source(contextAt("SEL", true)));

    expect(offered).toContain("SELECT");
  });

  it("givenTypingAfterSpace_whenCompleting_thenAsksNothing", async () => {
    const engine = deferredEngine();
    const source = engineCompletionSource({ dialect: () => PostgreSQL, engine: () => engine.call });

    expect(await source(contextAt("SELECT * FROM ", false))).toBeNull();
    expect(engine.calls).toHaveLength(0);
  });

  it("givenTypingAName_whenCompleting_thenSendsTextOffsetAndScope", async () => {
    const engine = deferredEngine();
    const scope = { path: ["public"], relation: "orders" };
    const source = engineCompletionSource({ dialect: () => PostgreSQL, engine: () => engine.call, scope });

    const pending = source(contextAt("cust", false));
    engine.calls[0]?.resolve({ ...RESULT, from: 0, to: 4 });
    await pending;

    expect(engine.calls[0]?.params).toEqual({ text: "cust", offset: 4, scope });
  });

  it("givenConsoleNamespace_whenCompleting_thenRequestCarriesCurrent", async () => {
    const engine = deferredEngine();
    const source = engineCompletionSource({
      dialect: () => PostgreSQL,
      engine: () => engine.call,
      current: () => ["table_craft", "archive"],
    });

    const pending = source(contextAt("SELECT * FROM o", true));
    engine.calls[0]?.resolve(RESULT);
    await pending;

    expect(engine.calls[0]?.params).toEqual({
      text: "SELECT * FROM o",
      offset: 15,
      current: ["table_craft", "archive"],
    });
  });

  it("givenNoNamespace_whenCompleting_thenRequestOmitsCurrent", async () => {
    const engine = deferredEngine();
    const source = engineCompletionSource({
      dialect: () => PostgreSQL,
      engine: () => engine.call,
      current: () => null,
    });

    const pending = source(contextAt("SELECT * FROM o", true));
    engine.calls[0]?.resolve(RESULT);
    await pending;

    expect(engine.calls[0]?.params).toEqual({ text: "SELECT * FROM o", offset: 15 });
  });

  it("givenEngineFailure_whenCompleting_thenFallsBackToKeywords", async () => {
    const source = engineCompletionSource({
      dialect: () => PostgreSQL,
      engine: () => () => Promise.reject(new Error("gone")),
    });

    expect(await labels(source(contextAt("SEL", true)))).toContain("SELECT");
  });
});

describe("engine result in the editor", () => {
  it("givenItems_whenMapped_thenApplyOnlyWhereItDiffersAndValidForIsARegex", () => {
    const mapped = toEditorResult(RESULT);

    expect(mapped.options).toEqual([
      { label: "orders", type: "table", boost: 30, detail: "public" },
      { label: "Line Items", type: "table", boost: 30, detail: "public", apply: '"Line Items"' },
    ]);
    expect(mapped.validFor).toBeInstanceOf(RegExp);
    expect(toEditorResult({ ...RESULT, validFor: null }).validFor).toBeUndefined();
  });

  it("givenInfoAndCaret_whenMapped_thenInfoShownAndCaretPlaced", () => {
    const upper = {
      label: "upper",
      kind: "function" as const,
      detail: "(str) → string",
      apply: "upper()",
      boost: 0,
      info: "upper(str) → string\n\nThe string in upper case.",
      caret: "upper(".length,
    };
    const now = { ...upper, label: "now", apply: "now()", info: "now() → datetime", caret: null };
    const [option, plain] = toEditorResult({ ...RESULT, from: 7, to: 9, items: [upper, now] }).options;
    expect(option?.info).toBe(upper.info);
    expect(plain?.apply).toBe("now()");

    const state = EditorState.create({ doc: "SELECT up FROM t" });
    const dispatched: TransactionSpec[] = [];
    const view = { dispatch: (spec: TransactionSpec) => dispatched.push(spec) } as unknown as EditorView;
    const apply = option?.apply;
    if (typeof apply !== "function") throw new Error("A caret inside the call needs an apply function.");
    apply(view, option as Completion, 7, 9);
    const after = state.update(...dispatched).state;

    expect(after.doc.toString()).toBe("SELECT upper() FROM t");
    expect(after.selection.main.head).toBe("SELECT upper(".length);
  });

  it("givenTiedScores_whenSorted_thenEngineOrderBeatsTheAlphabet", () => {
    const columns: CompletionResult = {
      ...RESULT,
      items: ["id", "customer_id", "total"].map((label) => ({
        label,
        kind: "column",
        detail: null,
        apply: label,
        boost: 40,
        info: null,
        caret: null,
      })),
    };
    const mapped = toEditorResult(columns).options;
    const keyword = { label: "AND" };

    const sorted = [keyword, ...mapped].sort(compareByEngineOrder).map((option) => option.label);

    expect(sorted).toEqual(["id", "customer_id", "total", "AND"]);
  });

  it("givenEveryKind_whenRendered_thenHasAGlyph", () => {
    const kinds = ["namespace", "table", "view", "column", "alias", "cte", "join", "function", "keyword"];

    for (const kind of kinds) expect(completionGlyphMarkup(kind)).toMatch(/^<svg/);
    expect(completionGlyphMarkup("unknown")).toBeNull();
  });
});
