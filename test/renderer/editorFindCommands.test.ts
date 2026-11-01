import { describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { search, setSearchQuery } from "@codemirror/search";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { consoleQuery, replaceEvery, setFindText } from "@table-craft/desktop/renderer/console/find/commands.js";
import {
  excludeRange,
  findScopeField,
  patchFindScope,
  type FindScope,
} from "@table-craft/desktop/renderer/console/find/findState.js";

const DOC = "Customer customer CUSTOMER\ncustomer";

/** Just enough of an `EditorView` for commands that only read the state and dispatch. */
function viewOf(state: EditorState): EditorView {
  const view = {
    state,
    dispatch(...specs: readonly (Transaction | TransactionSpec)[]) {
      const [first] = specs;
      view.state =
        first instanceof Transaction ? first.state : view.state.update(...(specs as TransactionSpec[])).state;
    },
  };
  return view as unknown as EditorView;
}

function finding(spec: Parameters<typeof consoleQuery>[1], scope: Partial<FindScope> = {}): EditorView {
  const state = EditorState.create({ doc: DOC, extensions: [history(), search({ literal: true }), findScopeField] });
  return viewOf(
    state.update({ effects: [setSearchQuery.of(consoleQuery(state, spec)), patchFindScope.of(scope)] }).state,
  );
}

describe("console Replace All", () => {
  it("givenPreserveCase_whenReplaceAll_thenCasesKept", () => {
    const view = finding({ search: "customer", replace: "client" }, { preserveCase: true });

    replaceEvery(view);

    expect(view.state.doc.toString()).toBe("Client client CLIENT\nclient");
  });

  it("givenPreserveCaseAndRegex_whenReplaceAll_thenReplacementAsTyped", () => {
    const view = finding({ search: "customer", replace: "client", regexp: true }, { preserveCase: true });

    replaceEvery(view);

    expect(view.state.doc.toString()).toBe("client client client\nclient");
  });

  it("givenInSelection_whenReplaceAll_thenOnlyInsideReplaced", () => {
    const view = finding({ search: "customer", replace: "client" }, { inSelection: [{ from: 0, to: 26 }] });

    replaceEvery(view);

    expect(view.state.doc.toString()).toBe("client client client\ncustomer");
  });

  it("givenExcludedMatch_whenReplaceAll_thenExcludedKept", () => {
    const view = finding({ search: "customer", replace: "client" });
    view.dispatch({ effects: excludeRange.of({ from: 9, to: 17 }) });

    replaceEvery(view);

    expect(view.state.doc.toString()).toBe("client customer client\nclient");
  });

  it("givenReplaceAll_whenUndone_thenOneUndoRestores", () => {
    const view = finding({ search: "customer", replace: "client" }, { preserveCase: true });
    replaceEvery(view);

    undo(view);

    expect(view.state.doc.toString()).toBe(DOC);
  });
});

describe("typing a console find query", () => {
  function caretAt(anchor: number): EditorView {
    return viewOf(
      EditorState.create({ doc: DOC, selection: { anchor }, extensions: [search({ literal: true }), findScopeField] }),
    );
  }

  it("givenCaretPastFirstMatch_whenQueryTyped_thenNextMatchSelected", () => {
    const view = caretAt(3);

    setFindText(view, "search", "customer");

    expect(view.state.selection.main).toMatchObject({ from: 9, to: 17 });
  });

  it("givenCaretPastLastMatch_whenQueryTyped_thenWrapsToFirst", () => {
    const view = caretAt(DOC.length);

    setFindText(view, "search", "CUSTOMER");

    expect(view.state.selection.main).toMatchObject({ from: 0, to: 8 });
  });

  it("givenReplacementTyped_whenSet_thenSelectionUnchanged", () => {
    const view = caretAt(3);

    setFindText(view, "replace", "client");

    expect(view.state.selection.main).toMatchObject({ from: 3, to: 3 });
  });
});
