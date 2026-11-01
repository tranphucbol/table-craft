import { describe, expect, it } from "vitest";
import { SearchQuery } from "@codemirror/search";
import { EditorSelection, EditorState } from "@codemirror/state";
import { openingQuery, PREFILL_LIMIT } from "@table-craft/desktop/renderer/console/find/prefill.js";

const DOC = "select a.id from orders a;\nselect b.id from items b;";
const LAST = new SearchQuery({ search: "previous" });
const LAST_REGEX = new SearchQuery({ search: "prev.*", regexp: true });

function selecting(doc: string, from: number, to: number): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(from, to) });
}

describe("opening the console find bar", () => {
  it("givenSingleLineSelection_whenOpened_thenQueryIsSelection", () => {
    const from = DOC.indexOf("orders");

    expect(openingQuery(selecting(DOC, from, from + 6), LAST)).toEqual({ search: "orders", inSelection: null });
  });

  it("givenSingleLineSelectionAndRegexOn_whenOpened_thenQueryEscaped", () => {
    const from = DOC.indexOf("a.id");

    expect(openingQuery(selecting(DOC, from, from + 4), LAST_REGEX).search).toBe("a\\.id");
  });

  it("givenMultiLineSelection_whenOpened_thenInSelectionOnAndQueryKept", () => {
    expect(openingQuery(selecting(DOC, 3, DOC.length - 2), LAST)).toEqual({
      search: "previous",
      inSelection: [{ from: 3, to: DOC.length - 2 }],
    });
  });

  it("givenNoSelection_whenOpened_thenLastQueryKept", () => {
    expect(openingQuery(selecting(DOC, 4, 4), LAST)).toEqual({ search: "previous", inSelection: null });
  });

  it("givenLongSingleLineSelection_whenOpened_thenLastQueryKept", () => {
    const doc = "x".repeat(PREFILL_LIMIT + 1);

    expect(openingQuery(selecting(doc, 0, doc.length), LAST).search).toBe("previous");
  });
});
