import { describe, expect, it } from "vitest";
import { BUNDLED_THEMES, LIGHT_COLORS, type UserThemeEntry } from "@table-craft/desktop/appearance/themes.js";
import { chosenOption, themePickerGroups } from "@table-craft/desktop/renderer/model/themePicker.js";
import { steppedIndex } from "@table-craft/desktop/renderer/ui/ListPicker.js";

const BUNDLED = Object.values(BUNDLED_THEMES);
const USER_THEMES: UserThemeEntry[] = [
  { id: "user:frost", name: "Frost", base: "nord-light", colors: LIGHT_COLORS },
  { id: "user:broken", file: "broken.json", errors: ["base: not a theme", "colors.canvass: unknown"] },
];

function names(filter: string) {
  return themePickerGroups(BUNDLED, USER_THEMES, filter).map((group) => [
    group.label,
    group.options.map((option) => option.name),
  ]);
}

describe("theme picker", () => {
  it("givenNoFilter_whenGrouped_thenFollowSystemOwnDarkLightAndUserThemesInOrder", () => {
    const groups = themePickerGroups(BUNDLED, USER_THEMES, "");

    expect(groups.map((group) => group.label)).toEqual(["Follow system", "TableCraft", "Dark", "Light", "Your themes"]);
    expect(groups[1]?.options.map((option) => option.choice)).toEqual(["dark", "light", "highContrast"]);
    expect(groups[2]?.options).toHaveLength(22);
    expect(groups[3]?.options).toHaveLength(21);
    const dark = groups[2]?.options.map((option) => option.name) ?? [];
    expect(dark).toEqual([...dark].sort((a, b) => a.localeCompare(b)));
    expect(groups.flatMap((group) => group.options)).toHaveLength(1 + 46 + 2);
  });

  it("givenFilterKana_whenGrouped_thenOnlyKanagawaDarkAndLightRemain", () => {
    expect(names("KANA")).toEqual([
      ["Dark", ["Kanagawa Dark"]],
      ["Light", ["Kanagawa Light"]],
    ]);
  });

  it("givenFilterMatchingASource_whenGrouped_thenThemesFromItRemain", () => {
    expect(names("morhetz")).toEqual([
      ["Dark", ["Gruvbox Dark"]],
      ["Light", ["Gruvbox Light"]],
    ]);
  });

  it("givenFilterMatchingNothing_whenGrouped_thenNoGroupsAndAnEmptyMessage", () => {
    expect(themePickerGroups(BUNDLED, USER_THEMES, "zzz")).toEqual([]);
  });

  it("givenBrokenUserTheme_whenGrouped_thenItIsListedDisabled", () => {
    const user = themePickerGroups(BUNDLED, USER_THEMES, "").at(-1);

    expect(user?.options.map((option) => [option.name, option.errors])).toEqual([
      ["Frost", null],
      ["broken.json", ["base: not a theme", "colors.canvass: unknown"]],
    ]);
    expect(user?.options[0]?.colorScheme).toBe("light");
  });

  it("givenHighlightOnLastOption_whenArrowDown_thenItStaysOnLast", () => {
    const count = themePickerGroups(BUNDLED, USER_THEMES, "").flatMap((group) => group.options).length;

    expect(steppedIndex(count, count - 1, "ArrowDown")).toBe(count - 1);
    expect(steppedIndex(count, 0, "ArrowUp")).toBe(0);
  });

  it("givenChoiceGoneFromTheFolder_whenChosenShown_thenAStandInSaysSo", () => {
    expect(chosenOption("gruvbox-dark", BUNDLED, []).source).toBe("gruvbox, morhetz");
    expect(chosenOption("user:gone", BUNDLED, [])).toMatchObject({ name: "gone", colors: null });
  });
});
