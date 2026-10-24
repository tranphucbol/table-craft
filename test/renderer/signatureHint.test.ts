import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { SignatureHelp } from "@table-craft/desktop/engine/protocol.js";
import { activeParameter, hintLines, typedTrigger } from "@table-craft/desktop/renderer/console/signatureHint.js";

const SUBSTR: SignatureHelp = {
  name: "substr",
  summary: "Part of a string.",
  signatures: [
    { parameters: [{ name: "str" }, { name: "start" }], returns: "string" },
    { parameters: [{ name: "str" }, { name: "start" }, { name: "length", optional: true }], returns: "string" },
  ],
  argument: 2,
  from: 7,
  to: 14,
};

function rendered(help: SignatureHelp): { text: string; active: string[]; fits: boolean }[] {
  return hintLines(help).map((line) => ({
    text: line.segments.map((segment) => segment.text).join(""),
    active: line.segments.filter((segment) => segment.active).map((segment) => segment.text),
    fits: line.fits,
  }));
}

describe("signature hint", () => {
  it("givenOverloads_whenRendered_thenEachLineAndTheActiveParameterMarked", () => {
    expect(rendered(SUBSTR)).toEqual([
      { text: "substr(str, start) → string", active: [], fits: false },
      { text: "substr(str, start, [length]) → string", active: ["[length]"], fits: true },
    ]);
  });

  it("givenVariadicLastParameter_whenArgumentsPastIt_thenItStaysActive", () => {
    const concat = { parameters: [{ name: "str", variadic: true }], returns: "string" };

    expect(activeParameter(concat, 0)).toBe(0);
    expect(activeParameter(concat, 4)).toBe(0);
    expect(activeParameter({ parameters: [{ name: "x" }], returns: "number" }, 1)).toBe(-1);
  });

  it("givenNoParameters_whenRendered_thenFitsWithNothingActive", () => {
    const now = { ...SUBSTR, name: "now", argument: 0, signatures: [{ parameters: [], returns: "datetime" }] };

    expect(rendered(now)).toEqual([{ text: "now() → datetime", active: [], fits: true }]);
  });

  it("givenTypedOpenParenOrComma_whenChecked_thenTriggers", () => {
    const start = EditorState.create({ doc: "SELECT upper" });
    const paren = start.update({
      changes: { from: 12, insert: "(" },
      selection: { anchor: 13 },
      userEvent: "input.type",
    });
    const comma = paren.state.update({
      changes: { from: 13, insert: "a," },
      selection: { anchor: 15 },
      userEvent: "input.type",
    });

    expect(typedTrigger(paren.state, [paren])).toBe(true);
    expect(typedTrigger(comma.state, [comma])).toBe(true);
  });

  it("givenOtherTypingOrProgrammaticChange_whenChecked_thenNoTrigger", () => {
    const start = EditorState.create({ doc: "SELECT upper(" });
    const letter = start.update({
      changes: { from: 13, insert: "a" },
      selection: { anchor: 14 },
      userEvent: "input.type",
    });
    const restored = start.update({ changes: { from: 13, insert: "," }, selection: { anchor: 14 } });
    const moved = start.update({ selection: { anchor: 13 }, userEvent: "select" });

    expect(typedTrigger(letter.state, [letter])).toBe(false);
    expect(typedTrigger(restored.state, [restored])).toBe(false);
    expect(typedTrigger(moved.state, [moved])).toBe(false);
  });
});
