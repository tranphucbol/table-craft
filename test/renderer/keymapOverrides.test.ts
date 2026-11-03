import { describe, expect, it } from "vitest";
import {
  effectiveShortcuts,
  isModified,
  withAllDefaults,
  withChord,
  withDefault,
  withoutChord,
} from "@table-craft/desktop/renderer/actions/keymapOverrides.js";

const RUN = { id: "console.run", shortcut: "Mod+Enter" };
const FORMAT = { id: "console.format", shortcut: "Mod+Alt+L" };
const ACTIONS = [RUN, FORMAT];

describe("keymapOverrides", () => {
  it("givenOverride_whenEffective_thenReplacesDefault", () => {
    const shortcuts = effectiveShortcuts(ACTIONS, { "console.run": ["Ctrl+Enter", "F5"] });

    expect(shortcuts.get("console.run")).toEqual(["Ctrl+Enter", "F5"]);
    expect(shortcuts.get("console.format")).toEqual(["Mod+Alt+L"]);
  });

  it("givenEmptyOverride_whenEffective_thenNoShortcut", () => {
    expect(effectiveShortcuts(ACTIONS, { "console.format": [] }).get("console.format")).toEqual([]);
  });

  it("givenUnknownActionId_whenEffective_thenIgnored", () => {
    const shortcuts = effectiveShortcuts(ACTIONS, { "gone.action": ["Mod+Enter"] });

    expect([...shortcuts.keys()]).toEqual(["console.run", "console.format"]);
    expect(shortcuts.get("console.run")).toEqual(["Mod+Enter"]);
  });

  it("givenResetAll_whenApplied_thenDefaultsBack", () => {
    const overrides = { "console.run": ["Ctrl+Enter"], "console.format": [], "gone.action": ["F6"] };

    const reset = withAllDefaults(overrides, ACTIONS);

    expect(reset).toEqual({ "gone.action": ["F6"] });
    expect(effectiveShortcuts(ACTIONS, reset).get("console.run")).toEqual(["Mod+Enter"]);
  });

  it("givenChordAddedThenRemoved_whenSaved_thenOverrideDropped", () => {
    const added = withChord({}, RUN, "F5");
    const removed = withoutChord(added, RUN, "F5");

    expect(added).toEqual({ "console.run": ["Mod+Enter", "F5"] });
    expect(removed).toEqual({});
    expect(isModified(removed, RUN)).toBe(false);
  });

  it("givenLastChordRemoved_whenSaved_thenEmptyOverrideKept", () => {
    const removed = withoutChord({}, FORMAT, "Mod+Alt+L");

    expect(removed).toEqual({ "console.format": [] });
    expect(isModified(removed, FORMAT)).toBe(true);
    expect(withDefault(removed, FORMAT.id)).toEqual({});
  });
});
