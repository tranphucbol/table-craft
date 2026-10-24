import {
  BUNDLED_THEMES,
  isBrokenUserTheme,
  isBuiltInThemeId,
  type ColorScheme,
  type ColorTokens,
  type Theme,
  type UserThemeEntry,
} from "@table-craft/desktop/appearance/themes.js";
import type { ThemeChoice } from "@table-craft/desktop/settings/settings.js";

/** One row of the theme picker (decision 065). */
export interface ThemePickerOption {
  readonly choice: ThemeChoice;
  readonly name: string;
  /** Who made the palette, for a ported theme. */
  readonly source: string | null;
  readonly licence: string | null;
  /** `null` for Follow system and a broken file, which have no colours of their own. */
  readonly colors: ColorTokens | null;
  readonly colorScheme: ColorScheme | null;
  /** A user theme file that did not validate: listed, never chosen. */
  readonly errors: readonly string[] | null;
}

export interface ThemePickerGroup {
  readonly label: string;
  readonly options: readonly ThemePickerOption[];
}

export const FOLLOW_SYSTEM_NAME = "Follow system";

function bundledOption(theme: Theme): ThemePickerOption {
  return {
    choice: theme.id,
    name: theme.name,
    source: theme.source ?? null,
    licence: theme.licence ?? null,
    colors: theme.colors,
    colorScheme: theme.colorScheme,
    errors: null,
  };
}

function userOption(entry: UserThemeEntry): ThemePickerOption {
  if (isBrokenUserTheme(entry)) {
    return {
      choice: entry.id,
      name: entry.file,
      source: null,
      licence: null,
      colors: null,
      colorScheme: null,
      errors: entry.errors,
    };
  }
  return {
    choice: entry.id,
    name: entry.name,
    source: null,
    licence: null,
    colors: entry.colors,
    colorScheme: BUNDLED_THEMES[entry.base].colorScheme,
    errors: null,
  };
}

const byName = (a: ThemePickerOption, b: ThemePickerOption) => a.name.localeCompare(b.name);

/**
 * The picker's list: Follow system, TableCraft's own, the ported dark and light themes by name,
 * then the user's, each narrowed to the options whose name or source contains `filter`, ignoring
 * case. Groups left empty are dropped.
 */
export function themePickerGroups(
  bundled: readonly Theme[],
  userThemes: readonly UserThemeEntry[],
  filter: string,
): ThemePickerGroup[] {
  const needle = filter.trim().toLowerCase();
  const matches = (option: ThemePickerOption) =>
    option.name.toLowerCase().includes(needle) || (option.source ?? "").toLowerCase().includes(needle);
  const own = bundled.filter((theme) => isBuiltInThemeId(theme.id)).map(bundledOption);
  const ported = bundled
    .filter((theme) => !isBuiltInThemeId(theme.id))
    .map(bundledOption)
    .sort(byName);
  const follow: ThemePickerOption = {
    choice: "system",
    name: FOLLOW_SYSTEM_NAME,
    source: null,
    licence: null,
    colors: null,
    colorScheme: null,
    errors: null,
  };
  return [
    { label: FOLLOW_SYSTEM_NAME, options: [follow] },
    { label: "TableCraft", options: own },
    { label: "Dark", options: ported.filter((option) => option.colorScheme === "dark") },
    { label: "Light", options: ported.filter((option) => option.colorScheme === "light") },
    { label: "Your themes", options: userThemes.map(userOption) },
  ]
    .map((group) => ({ ...group, options: group.options.filter(matches) }))
    .filter((group) => group.options.length > 0);
}

/** The option the picker shows as chosen, or a stand-in for a choice no longer listed. */
export function chosenOption(
  choice: ThemeChoice,
  bundled: readonly Theme[],
  userThemes: readonly UserThemeEntry[],
): ThemePickerOption {
  const all = themePickerGroups(bundled, userThemes, "").flatMap((group) => group.options);
  return (
    all.find((option) => option.choice === choice) ?? {
      choice,
      name: choice.replace(/^user:/, ""),
      source: null,
      licence: null,
      colors: null,
      colorScheme: null,
      errors: ["This theme is no longer in the themes folder."],
    }
  );
}
