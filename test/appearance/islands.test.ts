import { describe, expect, it } from "vitest";
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  BUNDLED_THEME_IDS,
  BUNDLED_THEMES,
  contrastRatio,
  frameColors,
  ISLAND_MIN_CONTRAST,
  requiredContrast,
  titleBarColor,
  windowBackground,
  type ContrastKind,
} from "@table-craft/desktop/appearance/themes.js";

/** What draws on the frame: the toolbar's title and icons, the status bar's text. */
const ON_FRAME: readonly { readonly token: "ink" | "inkMuted"; readonly kind: ContrastKind }[] = [
  { token: "ink", kind: "ink" },
  { token: "inkMuted", kind: "text" },
];

function luminanceOrder(color: string, than: string): "lighter" | "darker" {
  return contrastRatio(color, "#000000") > contrastRatio(than, "#000000") ? "lighter" : "darker";
}

describe("island frame", () => {
  it("givenBuiltInTheme_whenFrameDerived_thenFrameHoldsJetBrainsFloor", () => {
    const failures = BUILT_IN_THEME_IDS.filter((id) => {
      const theme = BUILT_IN_THEMES[id];
      return contrastRatio(frameColors(theme).frame, theme.colors.canvas) < ISLAND_MIN_CONTRAST;
    });

    expect(failures).toEqual([]);
  });

  it("givenEveryBundledTheme_whenFrameDerived_thenFrameSeparatesAtLeastAsPanelDid", () => {
    const failures = BUNDLED_THEME_IDS.filter((id) => {
      const theme = BUNDLED_THEMES[id];
      const { canvas, panel } = theme.colors;
      return contrastRatio(frameColors(theme).frame, canvas) < contrastRatio(panel, canvas);
    });

    expect(failures).toEqual([]);
  });

  it("givenEveryBundledTheme_whenFrameDerived_thenInkReadsOnFrame", () => {
    const failures = BUNDLED_THEME_IDS.flatMap((id) => {
      const theme = BUNDLED_THEMES[id];
      const { frame, frameRaised } = frameColors(theme);
      return ON_FRAME.flatMap(({ token, kind }) =>
        [frame, frameRaised]
          .filter((surface) => contrastRatio(theme.colors[token], surface) < requiredContrast(theme.contrast, kind))
          .map((surface) => `${id}: ${token} on ${surface}`),
      );
    });

    expect(failures).toEqual([]);
  });

  it("givenDarkScheme_whenFrameDerived_thenFrameIsLighterThanCanvas", () => {
    const theme = BUILT_IN_THEMES.dark;

    expect(luminanceOrder(frameColors(theme).frame, theme.colors.canvas)).toBe("lighter");
  });

  it("givenLightScheme_whenFrameDerived_thenFrameIsDarkerThanCanvas", () => {
    const theme = BUILT_IN_THEMES.light;

    expect(luminanceOrder(frameColors(theme).frame, theme.colors.canvas)).toBe("darker");
  });

  it("givenPanelAlreadyApart_whenFrameDerived_thenFrameIsPanel", () => {
    const theme = BUILT_IN_THEMES.dark;
    const colors = { ...theme.colors, panel: "#3c3f41" };

    expect(frameColors({ ...theme, colors }).frame).toBe("#3c3f41");
  });

  it("givenBuiltInTheme_whenFrameDerived_thenHoverStandsOutAsMuchAsOnPanel", () => {
    const failures = BUILT_IN_THEME_IDS.filter((id) => {
      const theme = BUILT_IN_THEMES[id];
      const { frame, frameRaised } = frameColors(theme);
      return contrastRatio(frameRaised, frame) < contrastRatio(theme.colors.raised, theme.colors.panel);
    });

    expect(failures).toEqual([]);
  });

  it("givenBuiltInTheme_whenFrameDerived_thenIslandHasNoVisibleEdge", () => {
    const edged = BUILT_IN_THEME_IDS.filter((id) => {
      const theme = BUILT_IN_THEMES[id];
      return frameColors(theme).islandEdge !== theme.colors.canvas;
    });

    expect(edged).toEqual([]);
  });

  it("givenFrameCappedForReadability_whenFrameDerived_thenIslandDrawsTheBorder", () => {
    const theme = BUNDLED_THEMES["dracula-dark"];
    const { frame, islandEdge } = frameColors(theme);

    expect(contrastRatio(frame, theme.colors.canvas)).toBeLessThan(ISLAND_MIN_CONTRAST);
    expect(islandEdge).toBe(theme.colors.border);
  });

  it("givenEveryBundledTheme_whenFrameDerived_thenIslandStandsApartByToneOrEdge", () => {
    const failures = BUNDLED_THEME_IDS.filter((id) => {
      const theme = BUNDLED_THEMES[id];
      const { frame, islandEdge } = frameColors(theme);
      return contrastRatio(frame, theme.colors.canvas) < ISLAND_MIN_CONTRAST && islandEdge !== theme.colors.border;
    });

    expect(failures).toEqual([]);
  });

  it("givenClassic_whenWindowPainted_thenCanvasAndPanelAsBefore", () => {
    const theme = BUILT_IN_THEMES.light;
    const { frame } = frameColors(theme);

    expect(windowBackground(theme, "classic")).toBe(theme.colors.canvas);
    expect(titleBarColor(theme, "classic")).toBe(theme.colors.panel);
    expect(windowBackground(theme, "islands")).toBe(frame);
    expect(titleBarColor(theme, "islands")).toBe(frame);
  });
});
