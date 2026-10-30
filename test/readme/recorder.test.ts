import { describe, expect, it } from "vitest";
import { badgeText, playwrightKeys } from "./pace.js";
import { alignedLists, concatList } from "./recorder.js";

describe("README recorder", () => {
  it("givenFrameTimestamps_whenConcatListWritten_thenEachFrameLastsUntilTheNext", () => {
    const list = concatList(
      [
        { file: "frame-00000.png", timestamp: 100 },
        { file: "frame-00001.png", timestamp: 100.25 },
        { file: "frame-00002.png", timestamp: 101 },
      ],
      102.5,
    );

    expect(list.script.split("\n")).toEqual([
      "ffconcat version 1.0",
      "file 'frame-00000.png'",
      "duration 0.250",
      "file 'frame-00001.png'",
      "duration 0.750",
      "file 'frame-00002.png'",
      "duration 1.500",
      "file 'frame-00002.png'",
      "",
    ]);
    expect(list.seconds).toBeCloseTo(2.5);
  });

  it("givenMaxFrameSeconds_whenConcatListWritten_thenLongerFramesAreShortened", () => {
    const list = concatList(
      [
        { file: "frame-00000.png", timestamp: 100 },
        { file: "frame-00001.png", timestamp: 109 },
      ],
      109.5,
      2,
    );

    expect(list.script).toContain("duration 2.000");
    expect(list.script).toContain("duration 0.500");
    expect(list.seconds).toBeCloseTo(2.5);
  });

  it("givenTwoSources_whenListsAligned_thenBothShareOneShortenedTimeline", () => {
    const [terminal, window] = alignedLists(
      [
        [
          { file: "t0.png", timestamp: 99 },
          { file: "t1.png", timestamp: 100.5 },
          { file: "t2.png", timestamp: 108 },
        ],
        [{ file: "w0.png", timestamp: 101 }],
      ],
      100,
      109,
      2,
    );

    expect(terminal?.script.split("\n")).toEqual([
      "ffconcat version 1.0",
      "file 't0.png'",
      "duration 0.500",
      "file 't1.png'",
      "duration 2.500",
      "file 't2.png'",
      "duration 1.000",
      "file 't2.png'",
      "",
    ]);
    expect(window?.script.split("\n")).toEqual([
      "ffconcat version 1.0",
      "file 'w0.png'",
      "duration 4.000",
      "file 'w0.png'",
      "",
    ]);
    expect(terminal?.seconds).toBeCloseTo(4);
    expect(window?.seconds).toBeCloseTo(4);
  });

  it("givenChord_whenBadgeTextBuilt_thenPlatformGlyphsAreUsed", () => {
    expect(badgeText("Mod+Shift+E", "mac")).toBe("⇧⌘E");
    expect(badgeText("Mod+Shift+E", "other")).toBe("Ctrl+Shift+E");
    expect(badgeText("Shift Shift", "mac")).toBe("⇧⇧");
    expect(playwrightKeys("Mod+Alt+G")).toBe("ControlOrMeta+Alt+G");
  });
});
