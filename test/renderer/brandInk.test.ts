import { describe, expect, it } from "vitest";
import { brandInk } from "@table-craft/desktop/appearance/brandInk.js";
import {
  BUNDLED_THEME_IDS,
  BUNDLED_THEMES,
  contrastRatio,
  DARK_COLORS,
  LIGHT_COLORS,
} from "@table-craft/desktop/appearance/themes.js";
import { BRAND_GLYPHS } from "@table-craft/desktop/renderer/ui/brandIcons.js";

const WCAG_NON_TEXT = 3;
const MARIADB = `#${BRAND_GLYPHS["mariadb"]?.hex ?? ""}`;
const POSTGRESQL = `#${BRAND_GLYPHS["postgresql"]?.hex ?? ""}`;

describe("brand ink", () => {
  it("givenEveryBundledThemeAndLogo_whenFitted_thenNonTextAaOnEverySurface", () => {
    const short = BUNDLED_THEME_IDS.flatMap((id) => {
      const { colors } = BUNDLED_THEMES[id];
      return Object.entries(BRAND_GLYPHS).flatMap(([slug, glyph]) => {
        const ink = brandInk(`#${glyph.hex}`, colors);
        return [colors.canvas, colors.panel, colors.raised, colors.selection]
          .filter((surface) => contrastRatio(ink, surface) < WCAG_NON_TEXT)
          .map((surface) => `${id} ${slug} ${ink} on ${surface}`);
      });
    });

    expect(short).toEqual([]);
  });

  it("givenReadableBrand_whenFitted_thenItsOwnColour", () => {
    expect(brandInk(POSTGRESQL, LIGHT_COLORS)).toBe(POSTGRESQL.toLowerCase());
  });

  it("givenDarkNavyOnDarkTheme_whenFitted_thenLightenedTowardInk", () => {
    const ink = brandInk(MARIADB, DARK_COLORS);

    expect(ink).not.toBe(MARIADB.toLowerCase());
    expect(contrastRatio(ink, DARK_COLORS.panel)).toBeGreaterThanOrEqual(WCAG_NON_TEXT);
    expect(contrastRatio(ink, DARK_COLORS.panel)).toBeLessThan(contrastRatio(DARK_COLORS.ink, DARK_COLORS.panel));
  });

  it("givenNonHexColour_whenFitted_thenThemeInk", () => {
    expect(brandInk("rebeccapurple", DARK_COLORS)).toBe(DARK_COLORS.ink);
  });
});
