import { describe, expect, it } from "vitest";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  chordOfKey,
  NEEDS_MODIFIER,
  recordChord,
  withReassigned,
  type RecordTarget,
} from "@table-craft/desktop/renderer/dialogs/chordRecorder.js";
import { keydown } from "./support.js";

const noop = () => undefined;
const RUN = defineAction({ id: "console.run", title: "Run", category: "Console", shortcut: "Mod+Enter", run: noop });
const FORMAT = defineAction({
  id: "console.format",
  title: "Reformat Code",
  category: "Console",
  shortcut: "Mod+Alt+L",
  run: noop,
});
const DROP = defineAction({
  id: "database.drop",
  title: "Drop",
  category: "Database",
  shortcut: "Mod+Backspace",
  shortcutRegion: ["database"],
  run: noop,
});
const GRID_DELETE = defineAction({
  id: "grid.delete",
  title: "Delete Rows",
  category: "Result Grid",
  shortcut: "Mod+Shift+Backspace",
  shortcutRegion: ["grid"],
  run: noop,
});
const ACTIONS: readonly AnyAction[] = [RUN, FORMAT, DROP, GRID_DELETE];

function targetFor(action: AnyAction, platform: RecordTarget["platform"] = "mac"): RecordTarget {
  return { actions: ACTIONS, overrides: {}, platform, action };
}

describe("chordRecorder", () => {
  it("givenClash_whenRecord_thenOffersReassign", () => {
    const target = targetFor(FORMAT);

    const recorded = recordChord(keydown({ key: "Enter", metaKey: true }), target);

    expect(recorded).toMatchObject({ kind: "accepted", chord: "Mod+Enter" });
    if (recorded.kind !== "accepted") return;
    expect(recorded.clashes.map((action) => action.id)).toEqual(["console.run"]);
    expect(withReassigned(target, recorded.chord, recorded.clashes)).toEqual({
      "console.run": [],
      "console.format": ["Mod+Alt+L", "Mod+Enter"],
    });
  });

  it("givenOtherRegion_whenRecord_thenNoClash", () => {
    const recorded = recordChord(keydown({ key: "Backspace", metaKey: true }), targetFor(GRID_DELETE));

    expect(recorded).toMatchObject({ kind: "accepted", chord: "Mod+Backspace", clashes: [] });
  });

  it("givenReservedChord_whenRecord_thenRefused", () => {
    expect(recordChord(keydown({ key: "q", metaKey: true }), targetFor(RUN))).toEqual({
      kind: "refused",
      reason: "⌘Q belongs to Quit TableCraft.",
    });
    expect(recordChord(keydown({ key: "F4", altKey: true }), targetFor(RUN, "other"))).toMatchObject({
      kind: "refused",
    });
  });

  it("givenBareLetter_whenRecord_thenRefused", () => {
    expect(recordChord(keydown({ key: "a" }), targetFor(RUN))).toEqual({ kind: "refused", reason: NEEDS_MODIFIER });
    expect(recordChord(keydown({ key: "A", shiftKey: true }), targetFor(RUN))).toEqual({
      kind: "refused",
      reason: NEEDS_MODIFIER,
    });
    expect(recordChord(keydown({ key: "F6" }), targetFor(RUN))).toMatchObject({ kind: "accepted", chord: "F6" });
  });

  it("givenEditorChord_whenRecord_thenAcceptedWithNote", () => {
    const recorded = recordChord(keydown({ key: "d", metaKey: true }), targetFor(FORMAT));

    expect(recorded).toEqual({
      kind: "accepted",
      chord: "Mod+D",
      clashes: [],
      editorNote: "Doesn't work in the SQL editor, where ⌘D is Select Next Occurrence.",
    });
  });

  it("givenModifierOnly_whenRecord_thenWaits", () => {
    expect(recordChord(keydown({ key: "Meta", metaKey: true }), targetFor(RUN))).toEqual({ kind: "waiting" });
    expect(recordChord(keydown({ key: "Escape" }), targetFor(RUN))).toEqual({ kind: "cancelled" });
  });

  it("givenHeldChord_whenRecord_thenRefusedAsAlreadyThere", () => {
    expect(recordChord(keydown({ key: "Enter", metaKey: true }), targetFor(RUN))).toEqual({
      kind: "refused",
      reason: "⌘↩ is already Run's shortcut.",
    });
  });

  it("givenCtrlOnEachPlatform_whenChordOfKey_thenSpelledAsActionsDeclare", () => {
    const pressed = keydown({ key: "Enter", ctrlKey: true });

    expect(chordOfKey(pressed, "mac")).toBe("Ctrl+Enter");
    expect(chordOfKey(pressed, "other")).toBe("Mod+Enter");
    expect(chordOfKey(keydown({ key: "k", metaKey: true }), "other")).toBeNull();
  });
});
