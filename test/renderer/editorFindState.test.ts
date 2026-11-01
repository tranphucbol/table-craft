import { describe, expect, it } from "vitest";
import { search, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { consoleQuery } from "@table-craft/desktop/renderer/console/find/commands.js";
import {
  excludeRange,
  findScope,
  findScopeField,
  patchFindScope,
  scopeTest,
} from "@table-craft/desktop/renderer/console/find/findState.js";

const DOC = "select a from t;\nselect b from u;\nselect c from v;";
const SECOND_LINE = { from: DOC.indexOf("select b"), to: DOC.indexOf("select c") };

function stateOf(doc: string = DOC): EditorState {
  return EditorState.create({ doc, extensions: [search({ literal: true }), findScopeField] });
}

function scoped(state: EditorState): EditorState {
  return state.update({ effects: patchFindScope.of({ inSelection: [SECOND_LINE] }) }).state;
}

describe("console find scope", () => {
  it("givenInSelectionRange_whenTextInsertedBefore_thenRangeShifts", () => {
    const state = scoped(stateOf()).update({ changes: { from: 0, insert: "-- note\n" } }).state;

    expect(findScope(state).inSelection).toEqual([{ from: SECOND_LINE.from + 8, to: SECOND_LINE.to + 8 }]);
  });

  it("givenInSelectionRange_whenTypedAtItsEnd_thenRangeGrows", () => {
    const state = scoped(stateOf()).update({ changes: { from: SECOND_LINE.to, insert: "x" } }).state;

    expect(findScope(state).inSelection).toEqual([{ from: SECOND_LINE.from, to: SECOND_LINE.to + 1 }]);
  });

  it("givenExcludedMatch_whenQueryChanges_thenExclusionsClear", () => {
    let state = stateOf();
    state = state.update({ effects: setSearchQuery.of(consoleQuery(state, { search: "select" })) }).state;
    state = state.update({ effects: excludeRange.of({ from: 0, to: 6 }) }).state;
    expect(findScope(state).excluded).toHaveLength(1);

    state = state.update({ effects: setSearchQuery.of(consoleQuery(state, { search: "from" })) }).state;

    expect(findScope(state).excluded).toEqual([]);
  });

  it("givenExcludedMatch_whenReplacementTyped_thenExclusionsKept", () => {
    let state = stateOf();
    state = state.update({ effects: setSearchQuery.of(consoleQuery(state, { search: "select" })) }).state;
    state = state.update({ effects: excludeRange.of({ from: 0, to: 6 }) }).state;

    state = state.update({ effects: setSearchQuery.of(consoleQuery(state, { replace: "SELECT" })) }).state;

    expect(findScope(state).excluded).toEqual([{ from: 0, to: 6 }]);
  });

  it("givenInSelectionRange_whenScopeFilterTested_thenMatchesOutsideRejected", () => {
    const state = scoped(stateOf());
    const inside = DOC.indexOf("select b");

    expect(scopeTest("select", state, 0, 6)).toBe(false);
    expect(scopeTest("select", state, inside, inside + 6)).toBe(true);
  });

  it("givenExcludedMatch_whenScopeFilterTested_thenRejected", () => {
    const state = stateOf().update({ effects: excludeRange.of({ from: 0, to: 6 }) }).state;

    expect(scopeTest("select", state, 0, 6)).toBe(false);
    expect(scopeTest("select", state, 17, 23)).toBe(true);
  });

  it("givenRangeDeleted_whenMapped_thenRangeDropped", () => {
    let state = scoped(stateOf()).update({ effects: excludeRange.of({ from: 0, to: 6 }) }).state;

    state = state.update({ changes: [{ from: 0, to: 6 }, SECOND_LINE] }).state;

    expect(findScope(state).inSelection).toEqual([]);
    expect(findScope(state).excluded).toEqual([]);
  });

  it("givenRangesPastTheEnd_whenPatched_thenClampedToTheDocument", () => {
    const state = stateOf("abc").update({ effects: patchFindScope.of({ inSelection: [{ from: 1, to: 99 }] }) }).state;

    expect(findScope(state).inSelection).toEqual([{ from: 1, to: 3 }]);
  });
});
