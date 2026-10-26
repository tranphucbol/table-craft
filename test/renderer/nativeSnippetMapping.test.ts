import {
  hasNextSnippetField,
  insertCompletionText,
  nextSnippetField,
  prevSnippetField,
  snippet,
} from "@codemirror/autocomplete";
import { history, indentMore, indentWithTab, undo } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { replacingRestOfWord, restOfWordFilter } from "@table-craft/desktop/renderer/console/completionKeys.js";

function editor(template: string) {
  let state = EditorState.create({
    doc: "mg",
    selection: { anchor: 2 },
    extensions: [EditorState.allowMultipleSelections.of(true), history(), restOfWordFilter],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  };
  replacingRestOfWord(() => snippet(template)(view, { label: "mg" }, 0, 2));
  return view;
}

function type(view: ReturnType<typeof editor>, text: string) {
  for (const character of text) {
    view.dispatch(view.state.update({ ...view.state.replaceSelection(character), userEvent: "input.type" }));
  }
}

function ranges(view: ReturnType<typeof editor>) {
  return view.state.selection.ranges.map((range) => [range.from, range.to]);
}

function final(view: ReturnType<typeof editor>, at: number) {
  expect(nextSnippetField(view)).toBe(true);
  expect(ranges(view)).toEqual([[at, at]]);
  expect(hasNextSnippetField(view.state)).toBe(false);
  expect(nextSnippetField(view)).toBe(false);
}

const LINKED = "MGET ${1:first} ${2:second} ${1:first}${0}";

describe("native CodeMirror snippet point mapping", () => {
  it("givenCharacterwiseLinkedEditsAndShiftTabRetyping_whenNavigating_thenKeepsFinalCursorCollapsed", () => {
    const view = editor(LINKED);
    expect(ranges(view)).toEqual([
      [5, 10],
      [18, 23],
    ]);
    type(view, "type_probe:string");
    expect(ranges(view)).toEqual([
      [22, 22],
      [47, 47],
    ]);
    expect(nextSnippetField(view)).toBe(true);
    expect(ranges(view)).toEqual([[23, 29]]);
    type(view, "seed:probe");
    expect(ranges(view)).toEqual([[33, 33]]);
    expect(prevSnippetField(view)).toBe(true);
    expect(ranges(view)).toEqual([
      [5, 22],
      [34, 51],
    ]);
    type(view, "type_probe:string");
    expect(hasNextSnippetField(view.state)).toBe(true);
    expect(ranges(view)).toEqual([
      [22, 22],
      [51, 51],
    ]);
    expect(nextSnippetField(view)).toBe(true);
    expect(ranges(view)).toEqual([[23, 33]]);
    final(view, 51);
    expect(view.state.doc.toString()).toBe("MGET type_probe:string seed:probe type_probe:string");
  });

  it("givenTextIdenticalNormalCompletionAfterCharacterwiseInput_whenAccepted_thenKeepsLinkedNavigation", () => {
    const view = editor(LINKED);
    type(view, "type_probe:string");
    const head = view.state.selection.main.head;
    replacingRestOfWord(() =>
      view.dispatch(
        view.state.update(
          insertCompletionText(view.state, "type_probe:string", head - "type_probe:string".length, head),
        ),
      ),
    );
    expect(ranges(view)).toEqual([
      [22, 22],
      [47, 47],
    ]);
    expect(hasNextSnippetField(view.state)).toBe(true);
    nextSnippetField(view);
    type(view, "seed:probe");
    final(view, 51);
  });

  for (const [name, template, cursor] of [
    ["before first occurrence", "MGET ${0}${1:first} ${2:second} ${1:first}", 5],
    ["after first occurrence", "MGET ${1:first}${0} ${2:second} ${1:first}", 22],
    ["before last occurrence", "MGET ${1:first} ${2:second} ${0}${1:first}", 34],
    ["after last occurrence", LINKED, 51],
  ] as const) {
    it(`givenCursor${name}_whenEditingBothFields_thenPreservesTextualAffinity`, () => {
      const view = editor(template);
      type(view, "type_probe:string");
      nextSnippetField(view);
      type(view, "seed:probe");
      prevSnippetField(view);
      type(view, "type_probe:string");
      expect(nextSnippetField(view)).toBe(true);
      final(view, cursor);
    });
  }

  for (const [template, secondAt, finalAt] of [
    ["${2}${1}${0}", 0, 3],
    ["${0}${1}${2}", 3, 0],
  ] as const) {
    it(`givenCoincidentDistinctEmptyFields${template}_whenTyping_thenUsesTextualNotNumericOrdering`, () => {
      const view = editor(template);
      type(view, "abc");
      expect(nextSnippetField(view)).toBe(true);
      expect(ranges(view)).toEqual([[secondAt, secondAt]]);
      final(view, finalAt);
    });
  }

  for (const template of ["${1}${0}${2}", "${2}${0}${1}"]) {
    it(`givenCoincidentMiddleCursor${template}_whenBothEmptyFieldsAreEdited_thenKeepsCursorBetweenThem`, () => {
      const view = editor(template);
      type(view, "abc");
      expect(nextSnippetField(view)).toBe(true);
      type(view, "def");
      final(view, 3);
      expect(view.state.doc.length).toBe(6);
    });
  }

  it("givenActiveFieldDeletedToEmpty_whenRetyped_thenStillExpandsAsAnEditableField", () => {
    const view = editor("${1:one}|${2:two}${0}");
    view.dispatch(view.state.update(view.state.replaceSelection("")));
    type(view, "abc");
    nextSnippetField(view);
    expect(ranges(view)).toEqual([[4, 7]]);
    prevSnippetField(view);
    expect(ranges(view)).toEqual([[0, 3]]);
    type(view, "xyz");
    nextSnippetField(view);
    view.dispatch(view.state.update(view.state.replaceSelection("")));
    type(view, "def");
    final(view, 7);
  });

  it("givenSelectionOutsideActiveField_whenMoved_thenCancelsSnippet", () => {
    const view = editor("A${1:x}Z${0}Q${2:y}");
    view.dispatch(view.state.update({ selection: { anchor: 0 } }));
    expect(hasNextSnippetField(view.state)).toBe(false);
    expect(nextSnippetField(view)).toBe(false);
  });

  it("givenDeletionAcrossInactiveCursor_whenChanged_thenRetainsTrackDelCancellation", () => {
    const view = editor("A${1:x}Z${0}Q${2:y}");
    view.dispatch(view.state.update({ changes: { from: 2, to: 4 } }));
    expect(hasNextSnippetField(view.state)).toBe(false);
    expect(nextSnippetField(view)).toBe(false);
  });

  it("givenNativeInsertion_whenUndone_thenRemainsOneOperation", () => {
    const view = editor(LINKED);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("mg");
  });

  it("givenCompletedSnippet_whenTabFallsThrough_thenOrdinaryIndentationRemainsAvailable", () => {
    const view = editor("A${1:x} ${0}");
    type(view, "abc");
    final(view, 5);
    expect(indentWithTab.run).toBe(indentMore);
    expect(indentMore(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("  Aabc ");
  });
});
