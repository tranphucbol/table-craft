import { describe, expect, it } from "vitest";
import {
  BUNDLED_THEMES,
  isBrokenUserTheme,
  LIGHT_COLORS,
  type UserTheme,
} from "@table-craft/desktop/appearance/themes.js";
import {
  createThemeFolder,
  MAX_THEME_BYTES,
  MAX_THEME_FILES,
  readThemeFile,
  THEMES_DIRECTORY,
} from "@table-craft/desktop/main/themes.js";
import { memoryFiles } from "../support/memoryFiles.js";

const FOLDER = `/profile/${THEMES_DIRECTORY}`;

function errorsOf(text: string): readonly string[] {
  const entry = readThemeFile("broken.json", text);
  return isBrokenUserTheme(entry) ? entry.errors : [];
}

describe("user theme files", () => {
  it("givenValidTheme_whenRead_thenResolvedOverItsBase", () => {
    const entry = readThemeFile(
      "solar.json",
      JSON.stringify({ name: "Solar", base: "light", colors: { accent: "#b58900", syntax: { keyword: "#859900" } } }),
    );

    expect(isBrokenUserTheme(entry)).toBe(false);
    const theme = entry as UserTheme;
    expect(theme).toMatchObject({ id: "user:solar", name: "Solar", base: "light" });
    expect(theme.colors.accent).toBe("#b58900");
    expect(theme.colors.syntax.keyword).toBe("#859900");
    expect(theme.colors.canvas).toBe(LIGHT_COLORS.canvas);
    expect(theme.colors.syntax.string).toBe(LIGHT_COLORS.syntax.string);
  });

  it("givenUnknownToken_whenRead_thenErrorNamesIt", () => {
    const errors = errorsOf(JSON.stringify({ name: "X", base: "dark", colors: { glow: "#fff" } }));

    expect(errors.join(" ")).toContain("glow");
  });

  it("givenBadColour_whenRead_thenErrorNamesTheToken", () => {
    const errors = errorsOf(JSON.stringify({ name: "X", base: "dark", colors: { ink: "red" } }));

    expect(errors).toEqual([expect.stringContaining("colors.ink")]);
  });

  it("givenUserThemeWithMissingBase_whenLoaded_thenItIsBrokenAndNamesTheBase", () => {
    const errors = errorsOf(JSON.stringify({ name: "X", base: "sepia" }));

    expect(errors).toEqual([expect.stringMatching(/^base: "sepia" is not a bundled theme/)]);
  });

  it("givenUserThemeBasedOnNordLight_whenLoaded_thenColorsOverrideNord", () => {
    const entry = readThemeFile(
      "frost.json",
      JSON.stringify({ name: "Frost", base: "nord-light", colors: { accent: "#5e81ac" } }),
    );

    expect(entry).toMatchObject({ id: "user:frost", base: "nord-light" });
    const nord = BUNDLED_THEMES["nord-light"].colors;
    expect((entry as UserTheme).colors).toEqual({ ...nord, accent: "#5e81ac" });
  });

  it("givenNotJson_whenRead_thenSaysSo", () => {
    expect(errorsOf("{ name: ")).toEqual([expect.stringContaining("Not JSON")]);
  });

  it("givenFileTooLarge_whenRead_thenRefusedUnparsed", () => {
    const huge = JSON.stringify({ name: "X", base: "dark", padding: "x".repeat(MAX_THEME_BYTES) });

    expect(errorsOf(huge)).toEqual([expect.stringContaining("larger than")]);
  });

  it("givenFolderWithThemesAndOtherFiles_whenListed_thenJsonFilesOnlyInOrder", async () => {
    const files = memoryFiles({
      [`${FOLDER}/b.json`]: JSON.stringify({ name: "B", base: "dark" }),
      [`${FOLDER}/a.json`]: "nope",
      [`${FOLDER}/notes.txt`]: "ignored",
    });

    const listed = await createThemeFolder({ directory: "/profile", files }).list();

    expect(listed.map((entry) => entry.id)).toEqual(["user:a", "user:b"]);
    expect(listed.map(isBrokenUserTheme)).toEqual([true, false]);
  });

  it("givenMoreFilesThanTheLimit_whenListed_thenTheRestAreListedAsErrors", async () => {
    const initial: Record<string, string> = {};
    for (let index = 0; index <= MAX_THEME_FILES; index += 1) {
      initial[`${FOLDER}/t${String(index).padStart(3, "0")}.json`] = JSON.stringify({
        name: `T${String(index)}`,
        base: "dark",
      });
    }

    const listed = await createThemeFolder({ directory: "/profile", files: memoryFiles(initial) }).list();

    expect(listed).toHaveLength(MAX_THEME_FILES + 1);
    expect(listed.filter(isBrokenUserTheme)).toHaveLength(1);
  });
});
