import { describe, expect, it } from "vitest";
import { FILL_HOVER_SHADE, FILL_PRESS_SHADE, fillShades, shadeOver } from "@table-craft/desktop/appearance/press.js";
import {
  BUILT_IN_THEMES,
  BUNDLED_THEME_IDS,
  BUNDLED_THEMES,
  contrastRatio,
  DARK_COLORS,
} from "@table-craft/desktop/appearance/themes.js";

const WCAG_AA_TEXT = 4.5;
/** Plan 114: the pressed accent keeps at most this share of its resting luminance, a step the eye sees. */
const VISIBLE_STEP = 0.75;
/** WCAG's flare term: a ratio against black is `(L + 0.05) / 0.05`. */
const FLARE = 0.05;

function luminance(color: string): number {
  return contrastRatio(color, "#000000") * FLARE - FLARE;
}

function pressedContrast(fill: "accent" | "danger") {
  return BUNDLED_THEME_IDS.map((id) => {
    const { colors } = BUNDLED_THEMES[id];
    const pressed = shadeOver(colors[fill], fillShades(colors[fill], colors.accentInk).press);
    return { id, ratio: contrastRatio(colors.accentInk, pressed) };
  });
}

describe("filled button press shade", () => {
  it("givenAccentAndPressShade_whenShaded_thenMatchesSrgbComposite", () => {
    expect(shadeOver("#78a6fb", 0.16)).toBe("#658bd3");
    expect(shadeOver("#fff", 0.5)).toBe("#808080");
    expect(shadeOver("#123456", 0)).toBe("#123456");
    expect(shadeOver("#ffffff80", 1)).toBe("#000000");
  });

  it("givenEveryBundledTheme_whenAccentPressed_thenAccentInkKeepsAa", () => {
    expect(pressedContrast("accent").filter(({ ratio }) => ratio < WCAG_AA_TEXT)).toEqual([]);
  });

  it("givenEveryBundledTheme_whenDangerPressed_thenAccentInkKeepsAa", () => {
    expect(pressedContrast("danger").filter(({ ratio }) => ratio < WCAG_AA_TEXT)).toEqual([]);
  });

  it("givenDarkTheme_whenAccentPressed_thenDarkerThanRestByAVisibleStep", () => {
    const rest = luminance(DARK_COLORS.accent);
    const pressed = luminance(
      shadeOver(DARK_COLORS.accent, fillShades(DARK_COLORS.accent, DARK_COLORS.accentInk).press),
    );

    expect(pressed).toBeLessThanOrEqual(rest * VISIBLE_STEP);
  });

  it("givenBuiltInAccents_whenShaded_thenFullShadeKeepsAaSoNoneIsCapped", () => {
    for (const { colors } of Object.values(BUILT_IN_THEMES)) {
      expect(fillShades(colors.accent, colors.accentInk)).toEqual({ hover: FILL_HOVER_SHADE, press: FILL_PRESS_SHADE });
    }
  });

  it("givenFullShadeWouldCostAa_whenShaded_thenCappedAndHoverKeepsItsProportion", () => {
    const shades = fillShades(DARK_COLORS.danger, DARK_COLORS.accentInk);

    expect(contrastRatio(DARK_COLORS.accentInk, shadeOver(DARK_COLORS.danger, FILL_PRESS_SHADE))).toBeLessThan(
      WCAG_AA_TEXT,
    );
    expect(shades.press).toBeGreaterThan(0);
    expect(shades.press).toBeLessThan(FILL_PRESS_SHADE);
    expect(shades.hover / shades.press).toBeCloseTo(FILL_HOVER_SHADE / FILL_PRESS_SHADE, 10);
  });

  it("givenLabelAlreadyBelowAa_whenShaded_thenNoShade", () => {
    expect(fillShades("#777777", "#888888")).toEqual({ hover: 0, press: 0 });
  });
});
