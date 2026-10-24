import {
  autocompletion,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult as EditorCompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { keywordCompletionSource, type SQLDialect } from "@codemirror/lang-sql";
import type { Extension } from "@codemirror/state";
import type {
  CompletionResult,
  CompletionScope,
  CurrentNamespace,
  EngineCalls,
} from "@table-craft/desktop/engine/protocol.js";
import { tabAcceptsCompletion } from "@table-craft/desktop/renderer/console/completionKeys.js";
import { renderCompletionGlyph } from "@table-craft/desktop/renderer/console/completionGlyphs.js";
import { signatureHint, type SignatureCall } from "@table-craft/desktop/renderer/console/signatureHint.js";
import { connectionOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

/** How long typing waits before asking the engine; ⌃Space asks at once (plan 009 decision 11). */
export const COMPLETION_TYPING_DELAY_MS = 80;
/** Typing opens the popup only after a name character, a quote or a dot; elsewhere ⌃Space does. */
const TYPING_TRIGGER = /[\w$."`]$/;
/** CodeMirror's own icon slot, before the label, as the Database pane puts a glyph before a name. */
const GLYPH_POSITION = 20;
/** CodeMirror's user event for an accepted completion, which the Tab filter extends. */
const COMPLETE_EVENT = "input.complete";

export type CompleteCall = (params: EngineCalls["completion.complete"]["params"]) => Promise<CompletionResult>;

export interface CompletionTarget {
  readonly dialect: () => SQLDialect;
  /** The engine to ask, or null while the datasource is not connected: completion never connects. */
  readonly engine: () => CompleteCall | null;
  /** The relation a table editor's WHERE or ORDER BY bar filters (plan 009 decision 16). */
  readonly scope?: CompletionScope;
  /** The console's namespace, which unqualified names complete in (decision 048); null for the catalog's. */
  readonly current?: () => CurrentNamespace;
  /** The engine to ask for the call at the caret; without it the editor shows no parameter hint. */
  readonly signature?: () => SignatureCall | null;
}

/** Where the engine put each option; lang-sql's keywords have none. */
const engineRanks = new WeakMap<Completion, number>();

/**
 * Breaks CodeMirror's score ties by the engine's order, so columns keep their table order rather
 * than CodeMirror's default alphabetical one (plan 009 decision 12).
 */
export function compareByEngineOrder(left: Completion, right: Completion): number {
  const byRank =
    (engineRanks.get(left) ?? Number.MAX_SAFE_INTEGER) - (engineRanks.get(right) ?? Number.MAX_SAFE_INTEGER);
  return byRank === 0 ? left.label.localeCompare(right.label) : byRank;
}

/** Inserts `text` over the typed word and puts the caret `caret` characters into it, as one completion. */
function applyWithCaret(text: string, caret: number): Completion["apply"] {
  return (view, completion, from, to) => {
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + caret },
      scrollIntoView: true,
      userEvent: COMPLETE_EVENT,
      annotations: pickedCompletion.of(completion),
    });
  };
}

export function toEditorResult(result: CompletionResult): EditorCompletionResult {
  const options = result.items.map((item, rank): Completion => {
    const apply =
      item.caret !== null && item.caret < item.apply.length
        ? { apply: applyWithCaret(item.apply, item.caret) }
        : item.apply === item.label
          ? {}
          : { apply: item.apply };
    const option: Completion = {
      label: item.label,
      type: item.kind,
      boost: item.boost,
      ...(item.detail === null ? {} : { detail: item.detail }),
      ...(item.info === null ? {} : { info: item.info }),
      ...apply,
    };
    engineRanks.set(option, rank);
    return option;
  });
  return {
    from: result.from,
    to: result.to,
    options,
    ...(result.validFor === null ? {} : { validFor: new RegExp(result.validFor) }),
  };
}

/**
 * Asks the engine while the datasource is connected and lang-sql's keywords otherwise. A
 * response to a request a newer one has overtaken is dropped (plan 009 decision 11).
 */
export function engineCompletionSource(target: CompletionTarget): CompletionSource {
  let latest = 0;
  const keywords = (context: CompletionContext) => keywordCompletionSource(target.dialect(), true)(context);
  return async (context) => {
    const call = target.engine();
    if (call === null) return keywords(context);
    if (!context.explicit && context.matchBefore(TYPING_TRIGGER) === null) return null;
    latest += 1;
    const request = latest;
    const current = target.current?.() ?? null;
    const params = {
      text: context.state.doc.toString(),
      offset: context.pos,
      ...(target.scope === undefined ? {} : { scope: target.scope }),
      ...(current === null ? {} : { current }),
    };
    let result: CompletionResult;
    try {
      result = await call(params);
    } catch {
      return request === latest && !context.aborted ? keywords(context) : null;
    }
    // CodeMirror closes the popup on blur only if it is already open, so an answer arriving after
    // the editor lost focus (a click on Run, a dialog) would open it over whatever took focus.
    if (request !== latest || context.aborted || context.view?.hasFocus === false) return null;
    return toEditorResult(result);
  };
}

/** The datasource's engine while it is connected; null otherwise, so completion starts nothing. */
export function connectedEngine(datasourceId: () => string | undefined): () => CompleteCall | null {
  return () => {
    const id = datasourceId();
    if (id === undefined) return null;
    const datasources = useDatasources.getState();
    if (connectionOf(datasources, id).status !== "connected") return null;
    return async (params) => (await datasources.connect(id)).call("completion.complete", params);
  };
}

/**
 * Autocompletion with the engine source, the app's glyphs, the typing delay and Tab to accept,
 * then the parameter hint, after it so Escape closes the popup before the hint.
 */
export function completion(target: CompletionTarget): Extension {
  const { signature, scope } = target;
  return [
    autocompletion({
      override: [engineCompletionSource(target)],
      icons: false,
      activateOnTypingDelay: COMPLETION_TYPING_DELAY_MS,
      compareCompletions: compareByEngineOrder,
      addToOptions: [{ render: renderCompletionGlyph, position: GLYPH_POSITION }],
    }),
    tabAcceptsCompletion,
    signature === undefined ? [] : signatureHint(scope === undefined ? { signature } : { signature, scope }),
  ];
}
