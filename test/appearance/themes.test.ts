import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_THEME_IDS,
  BUNDLED_THEMES,
  contrastRatio,
  DARK_COLORS,
  isBuiltInThemeId,
  LIGHT_COLORS,
  overrideColors,
  PORTED_THEMES,
  resolveTheme,
  type UserThemeEntry,
} from "@table-craft/desktop/appearance/themes.js";
import {
  familyOf,
  PALETTE_DIRECTORY,
  readAttribution,
  renderThemeModules,
  THEME_DIRECTORY,
} from "../../packages/desktop/scripts/generate-themes.js";
import { contrastViolations, tintViolations } from "../../packages/desktop/scripts/theme-audit.js";

/** Six palettes per theme through prettier; the default 5 s is close on a loaded CI runner. */
const GENERATOR_TIMEOUT_MS = 30_000;

const LIGHT_SYSTEM = { prefersDark: false, prefersMoreContrast: false };
const DARK_SYSTEM = { prefersDark: true, prefersMoreContrast: false };

describe("contrast", () => {
  it("givenBlackOnWhite_whenMeasured_thenTwentyOneToOne", () => {
    expect(contrastRatio("#000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000ff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  it("givenEveryBundledTheme_whenAudited_thenEveryContrastPairPasses", () => {
    const failures = BUNDLED_THEME_IDS.flatMap((id) => contrastViolations({ ...BUNDLED_THEMES[id], id }));

    expect(BUNDLED_THEME_IDS).toHaveLength(46);
    expect(failures).toEqual([]);
  });

  it("givenEveryBundledTheme_whenTintsCompared_thenEachPairIsAtLeastTheMinimumApart", () => {
    const failures = BUNDLED_THEME_IDS.flatMap((id) =>
      tintViolations({ ...BUNDLED_THEMES[id], id }, { onPanel: !isBuiltInThemeId(id) }),
    );

    expect(failures).toEqual([]);
  });

  it("givenHighContrast_whenAudited_thenOnlyItHoldsInkToAaa", () => {
    expect(BUNDLED_THEME_IDS.filter((id) => BUNDLED_THEMES[id].contrast === "aaa")).toEqual(["highContrast"]);
  });
});

describe("ported themes", () => {
  it(
    "givenGeneratedThemeModules_whenGeneratorReruns_thenOutputIsByteIdentical",
    async () => {
      const modules = await renderThemeModules();

      for (const [file, contents] of modules) {
        expect(await readFile(join(THEME_DIRECTORY, file), "utf8"), file).toBe(contents);
      }
      expect(modules.size).toBe(Object.keys(PORTED_THEMES).length + 1);
    },
    GENERATOR_TIMEOUT_MS,
  );

  it("givenPaletteNotice_whenThemesListed_thenEveryThemeSourceHasALicenceRow", async () => {
    const attribution = readAttribution(await readFile(join(PALETTE_DIRECTORY, "NOTICE"), "utf8"));

    for (const theme of Object.values(PORTED_THEMES)) {
      const row = attribution.get(familyOf(theme.id, attribution.keys()));
      expect(row, theme.id).toEqual({ source: theme.source, licence: theme.licence });
      expect(theme.licence, theme.id).toMatch(/^(MIT|Apache-2\.0)$/);
    }
  });

  it("givenMonoPlusPalette_whenFamilyFound_thenTheLongestMatchWins", () => {
    expect(familyOf("mono-plus-dark", ["mono", "mono-plus"])).toBe("mono-plus");
    expect(() => familyOf("sepia-dark", ["mono"])).toThrow(/NOTICE/);
  });
});

describe("theme resolution", () => {
  const userThemes: UserThemeEntry[] = [
    {
      id: "user:solar",
      name: "Solar",
      base: "light",
      colors: overrideColors(LIGHT_COLORS, { canvas: "#fdf6e3", syntax: { keyword: "#859900" } }),
    },
    { id: "user:broken", file: "broken.json", errors: ["colors.canvas: not a colour"] },
  ];

  it("givenUserThemeOverridingTwoTokens_whenResolved_thenRestComeFromBase", () => {
    const { theme, notice } = resolveTheme("user:solar", DARK_SYSTEM, userThemes);

    expect(notice).toBeNull();
    expect(theme.colorScheme).toBe("light");
    expect(theme.colors).toEqual({
      ...LIGHT_COLORS,
      canvas: "#fdf6e3",
      syntax: { ...LIGHT_COLORS.syntax, keyword: "#859900" },
    });
  });

  it("givenSystemChoice_whenSystemChanges_thenFollowsSchemeAndContrast", () => {
    expect(resolveTheme("system", LIGHT_SYSTEM, []).theme.id).toBe("light");
    expect(resolveTheme("system", DARK_SYSTEM, []).theme.id).toBe("dark");
    expect(resolveTheme("system", { prefersDark: false, prefersMoreContrast: true }, []).theme.id).toBe("highContrast");
  });

  it("givenPortedThemeChoice_whenResolved_thenItIsUsed", () => {
    const { theme, notice } = resolveTheme("gruvbox-dark", LIGHT_SYSTEM, []);

    expect(notice).toBeNull();
    expect(theme).toBe(BUNDLED_THEMES["gruvbox-dark"]);
    expect(theme.source).toBe("gruvbox, morhetz");
  });

  it("givenUserThemeBasedOnNordLight_whenResolved_thenSchemeAndContrastComeFromNord", () => {
    const nord = BUNDLED_THEMES["nord-light"];
    const { theme } = resolveTheme("user:frost", DARK_SYSTEM, [
      {
        id: "user:frost",
        name: "Frost",
        base: "nord-light",
        colors: overrideColors(nord.colors, { accent: "#5e81ac" }),
      },
    ]);

    expect(theme).toMatchObject({ colorScheme: "light", contrast: "aa" });
    expect(theme.colors).toEqual({ ...nord.colors, accent: "#5e81ac" });
  });

  it("givenChosenUserThemeBrokenOrGone_whenResolved_thenDarkWithNotice", () => {
    const broken = resolveTheme("user:broken", LIGHT_SYSTEM, userThemes);
    const gone = resolveTheme("user:gone", LIGHT_SYSTEM, userThemes);

    expect(broken.theme.colors).toBe(DARK_COLORS);
    expect(broken.notice).toContain("broken.json");
    expect(gone.theme.colors).toBe(DARK_COLORS);
    expect(gone.notice).toContain("gone");
  });
});
