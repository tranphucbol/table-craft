import { describe, expect, it } from "vitest";
import { formatChord, keyOf, matches, parseChord } from "@table-craft/desktop/renderer/actions/chords.js";
import { isChord, menuAccelerator, reservedOwner } from "@table-craft/desktop/settings/chords.js";
import { keydown } from "./support.js";

describe("chords", () => {
  it("givenModShiftF_whenMenuAccelerator_thenCmdOrCtrlShiftF", () => {
    expect(menuAccelerator("Mod+Shift+F")).toBe("CmdOrCtrl+Shift+F");
    expect(menuAccelerator("Shift+Alt+Ctrl+ArrowUp")).toBe("Ctrl+Alt+Shift+Up");
    expect(menuAccelerator("Shift Shift")).toBeNull();
  });

  it("givenReservedChord_whenAskedOnEachPlatform_thenOwnerNamedOnlyWhereTaken", () => {
    expect(reservedOwner("Mod+Q", "mac")).toBe("Quit TableCraft");
    expect(reservedOwner("Mod+Q", "other")).toBeNull();
    expect(reservedOwner("Alt+F4", "other")).toBe("Close Window");
  });

  it("givenChordSpellings_whenChecked_thenOnlyParseableOnesAreChords", () => {
    expect(isChord("Mod+Alt+L")).toBe(true);
    expect(isChord("Shift Shift")).toBe(true);
    expect(isChord("Hyper+X")).toBe(false);
    expect(isChord(42)).toBe(false);
  });

  it("givenModShiftA_whenFormattedOnMac_thenReadsCmdShiftA", () => {
    expect(formatChord("Mod+Shift+A", "mac")).toBe("⇧⌘A");
  });

  it("givenModShiftA_whenFormattedOnLinux_thenReadsCtrlShiftA", () => {
    expect(formatChord("Mod+Shift+A", "other")).toBe("Ctrl+Shift+A");
  });

  it("givenSpecialKeys_whenFormatted_thenUsePlatformGlyphs", () => {
    expect(formatChord("Mod+Enter", "mac")).toBe("⌘↩");
    expect(formatChord("Shift Shift", "mac")).toBe("⇧⇧");
    expect(formatChord("Shift Shift", "other")).toBe("Double Shift");
    expect(formatChord("Escape", "other")).toBe("Esc");
  });

  it("givenModChord_whenParsed_thenModIsMetaOnMacAndCtrlElsewhere", () => {
    expect(parseChord("Mod+1", "mac")).toMatchObject({ meta: true, ctrl: false, key: "1" });
    expect(parseChord("Mod+1", "other")).toMatchObject({ meta: false, ctrl: true, key: "1" });
  });

  it("givenMalformedChord_whenParsed_thenThrowsWithTheExpectedSpelling", () => {
    expect(() => parseChord("Shift+", "mac")).toThrow(/Mod\+Shift\+A/);
    expect(() => parseChord("Shift Alt", "mac")).toThrow(/double-tap/);
  });

  it("givenShiftedBracket_whenMatched_thenPhysicalKeyCounts", () => {
    const event = keydown({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true });

    expect(keyOf(event)).toBe("]");
    expect(matches(parseChord("Mod+Shift+]", "mac"), event)).toBe(true);
    expect(matches(parseChord("Mod+]", "mac"), event)).toBe(false);
  });
});
