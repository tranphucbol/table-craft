import { describe, expect, it } from "vitest";
import { search, setSearchQuery } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import { consoleQuery } from "@table-craft/desktop/renderer/console/find/commands.js";
import { findScopeField } from "@table-craft/desktop/renderer/console/find/findState.js";
import {
  countFailed,
  countMatches,
  counterSpoken,
  counterText,
  MATCH_COUNT_CAP,
} from "@table-craft/desktop/renderer/console/find/matchCount.js";

const TWELVE_IDS = Array.from({ length: 12 }, (_, index) => `id_${String(index)}`).join(", ");

function stateOf(doc: string, anchor = 0, head = anchor): EditorState {
  return EditorState.create({ doc, selection: { anchor, head }, extensions: [search(), findScopeField] });
}

function count(state: EditorState, spec: Parameters<typeof consoleQuery>[1]) {
  const withQuery = state.update({ effects: setSearchQuery.of(consoleQuery(state, spec)) }).state;
  return countMatches(withQuery, consoleQuery(withQuery));
}

describe("console find counter", () => {
  it("givenSelectionOnThirdOfTwelve_whenCounted_thenShowsThreeOfTwelve", () => {
    const third = TWELVE_IDS.indexOf("id_2");
    const result = count(stateOf(TWELVE_IDS, third, third + 3), { search: "id_" });

    expect(counterText(result)).toBe("3/12");
    expect(countFailed(result)).toBe(false);
  });

  it("givenSelectionOnAMatch_whenSpoken_thenReadsAsOfMatches", () => {
    const third = TWELVE_IDS.indexOf("id_2");

    expect(counterSpoken(count(stateOf(TWELVE_IDS, third, third + 3), { search: "id_" }))).toBe("3 of 12 matches");
    expect(counterSpoken(count(stateOf("id_1", 0, 3), { search: "id_" }))).toBe("1 of 1 match");
    expect(counterSpoken(count(stateOf(TWELVE_IDS), { search: "customer" }))).toBe("No matches");
    expect(counterSpoken(count(stateOf(TWELVE_IDS), { search: "id_" }))).toBe("12 matches");
  });

  it("givenCaretOffAMatch_whenCounted_thenShowsQuestionMarkOfTotal", () => {
    expect(counterText(count(stateOf(TWELVE_IDS), { search: "id_" }))).toBe("?/12");
    expect(counterText(count(stateOf("one id_1"), { search: "id_" }))).toBe("?/1");
  });

  it("givenNoMatches_whenCounted_thenShowsZeroOfZero", () => {
    const result = count(stateOf(TWELVE_IDS), { search: "customer" });

    expect(counterText(result)).toBe("0/0");
    expect(countFailed(result)).toBe(true);
  });

  it("givenEmptyQuery_whenCounted_thenShowsNothing", () => {
    const result = count(stateOf(TWELVE_IDS), { search: "" });

    expect(counterText(result)).toBe("");
    expect(countFailed(result)).toBe(false);
  });

  it("givenInvalidRegex_whenCounted_thenShowsBadPattern", () => {
    const result = count(stateOf(TWELVE_IDS), { search: "id_(", regexp: true });

    expect(counterText(result)).toBe("Bad pattern");
    expect(countFailed(result)).toBe(true);
  });

  it("givenMoreThanCap_whenCounted_thenShowsCappedPlus", () => {
    const result = count(stateOf("x".repeat(MATCH_COUNT_CAP + 1)), { search: "x" });

    expect(counterText(result)).toBe("?/10,000+");
    expect(counterSpoken(result)).toBe("more than 10,000 matches");
  });

  it("givenLiteralBackslashN_whenRegexOff_thenNewlinesNotMatched", () => {
    const doc = "a\nb\\nc";

    expect(counterText(count(stateOf(doc), { search: "\\n" }))).toBe("?/1");
    expect(counterText(count(stateOf(doc), { search: "\\n", regexp: true }))).toBe("?/1");
    expect(counterText(count(stateOf("a\nb\nc"), { search: "\\n", regexp: true }))).toBe("?/2");
  });
});
