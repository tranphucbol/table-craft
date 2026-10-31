/**
 * The colour, font and density tokens every surface draws from (decision 012), and the built-in
 * themes, as pure data. Main imports this for the window's first paint and the renderer for
 * everything else, so it may touch neither the DOM, Node, electron nor zod (decision 032). The
 * ported themes are generated into `themes/` by `scripts/generate-themes.ts` (decision 064).
 */
import type { ContrastLevel } from "./contrast.js";
import { frameColors, type FrameColors, type WindowStyle } from "./islands.js";
import { MOTION, type MotionTokens } from "./motion.js";
import { PORTED_THEME_IDS, PORTED_THEMES, type PortedThemeId } from "./themes/index.js";

export * from "./contrast.js";
export * from "./islands.js";
export { PORTED_THEME_IDS, PORTED_THEMES, type PortedThemeId } from "./themes/index.js";

/** Mirrors `DATASOURCE_COLORS` in the bridge; a datasource stores the name, the theme the value. */
export type DatasourceTint = "red" | "orange" | "yellow" | "green" | "blue" | "violet";

export interface ColorTokens {
  readonly canvas: string;
  readonly panel: string;
  readonly raised: string;
  readonly border: string;
  readonly ink: string;
  readonly inkMuted: string;
  /** Links, focus rings and selected list items as text, and primary buttons as a fill. */
  readonly accent: string;
  /** Text on an `accent` fill. */
  readonly accentInk: string;
  readonly danger: string;
  /** A healthy state: the connected datasource's dot. */
  readonly success: string;
  readonly gridStripe: string;
  /** Behind the grid's selected cells; stronger than `selection`, which marks hover. */
  readonly gridSelection: string;
  /** A NULL cell's `<null>`, set in italics so it never reads as the string (plan 007 decision 16). */
  readonly gridNull: string;
  /** Behind a table editor cell whose pending value differs from the database's (plan 008 decision 10). */
  readonly editModified: string;
  /** Behind a row added in the table editor and not yet submitted. */
  readonly editInserted: string;
  /** Behind a row marked for deletion, whose text is also struck through. */
  readonly editDeleted: string;
  /** The pressed stripe button and the hovered row; one step above `panel`. */
  readonly selection: string;
  /** Behind the characters speed search matched in a tree row. */
  readonly searchMatch: string;
  /** A primary or unique key's glyph in the Database pane; foreign keys use `accent`. */
  readonly keyIcon: string;
  /** Something to look at that is not a failure: a skipped statement, a cancelled run. */
  readonly warning: string;
  /** Behind the statement the console just ran, fading out (plan 006 decision 7). */
  readonly statementFlash: string;
  /** A plan node's share of its root's cost or time, as a thin bar in its cell (plan 012 decision 11). */
  readonly planBar: string;
  /** Behind the banner an analysed plan opens with: the statement ran (plan 012 decision 12). */
  readonly analysedBanner: string;
  /** The tints a datasource can carry (decision 011): its swatch, tab and console border. */
  readonly datasource: Readonly<Record<DatasourceTint, string>>;
  readonly syntax: SyntaxColorTokens;
}

/** The SQL editor's highlighting; anything without a token draws in `ink`. */
export interface SyntaxColorTokens {
  readonly keyword: string;
  readonly string: string;
  readonly number: string;
  readonly comment: string;
  /** Quoted identifiers: `"order"`, `` `order` ``. */
  readonly identifier: string;
  readonly operator: string;
  /** Bind parameters and variables: `$1`, `:name`, `@var`. */
  readonly variable: string;
  /** Behind the bracket matching the one at the caret; text on it draws in `ink`. */
  readonly bracketMatch: string;
}

export interface FontToken {
  readonly family: string;
  readonly sizePx: number;
}

export interface FontTokens {
  readonly ui: FontToken;
  readonly editor: FontToken;
  readonly grid: FontToken;
}

export interface DensityTokens {
  readonly rowHeightPx: number;
  readonly cellPaddingPx: number;
  readonly gapPx: number;
  readonly gridColumnMaxWidthPx: number;
  /** The result grid's value panel, beside its rows. */
  readonly valuePanelWidthPx: number;
  readonly consoleHeightPx: number;
  /** The tool-window stripes at either edge of the window. */
  readonly stripeWidthPx: number;
  readonly tabHeightPx: number;
  /** The main toolbar, which is the window's title bar; the macOS traffic lights centre in it. */
  readonly titleBarHeightPx: number;
  readonly statusBarHeightPx: number;
  readonly iconPx: number;
  readonly paletteWidthPx: number;
  /** The Data Sources and Settings dialogs. */
  readonly dialogWidthPx: number;
  readonly dialogHeightPx: number;
  /** The list or page list inside them. */
  readonly dialogListWidthPx: number;
  /** A form label's widest; a longer one wraps rather than pushing its field over. */
  readonly dialogLabelMaxPx: number;
  /** Quick Documentation's popover, at most this big; its columns list scrolls. */
  readonly popoverWidthPx: number;
  readonly popoverHeightPx: number;
  /** The SQL Generator dialog. */
  readonly generatorWidthPx: number;
  /** Query History and Open Closed Console: a searchable list over a preview (plan 011). */
  readonly pickerWidthPx: number;
  /** The picker's list; the preview takes the same again. */
  readonly pickerListHeightPx: number;
  /** The plan view's details strip, beside its tree. */
  readonly planDetailsWidthPx: number;
  /** The plan bar's thickness under a Cost or Time cell. */
  readonly planBarHeightPx: number;
  /** The frame showing between two islands, and around them (decision 141). */
  readonly islandGapPx: number;
  readonly islandRadiusPx: number;
}

export interface Appearance {
  readonly colors: ColorTokens;
  readonly fonts: FontTokens;
  readonly density: DensityTokens;
  readonly motion: MotionTokens;
  readonly windowStyle: WindowStyle;
  readonly frame: FrameColors;
}

/** TableCraft's own themes, the ones Follow system chooses between. */
export type BuiltInThemeId = "dark" | "light" | "highContrast";
/** Every theme the app ships: its own and the ported ones. */
export type BundledThemeId = BuiltInThemeId | PortedThemeId;
export type ColorScheme = "dark" | "light";
export type UserThemeId = `user:${string}`;
export type ThemeId = BundledThemeId | UserThemeId;

export interface Theme {
  readonly id: ThemeId;
  readonly name: string;
  /** Native scrollbars, form controls and `nativeTheme` follow this. */
  readonly colorScheme: ColorScheme;
  /** What its audit holds it to (decision 064). */
  readonly contrast: ContrastLevel;
  /** Who made the palette, for a ported theme; shown beside its name. */
  readonly source?: string;
  readonly licence?: string;
  readonly colors: ColorTokens;
}

export const SYSTEM_UI_FONT = `system-ui, -apple-system, "Segoe UI", sans-serif`;
export const SYSTEM_MONO_FONT = `"JetBrains Mono", Menlo, Consolas, monospace`;

/** Darcula-like. */
export const DARK_COLORS: ColorTokens = {
  canvas: "#1e1f22",
  panel: "#2b2d30",
  raised: "#393b40",
  border: "#43454a",
  ink: "#dfe1e5",
  inkMuted: "#a6a9b1",
  accent: "#78a6fb",
  accentInk: "#1e1f22",
  danger: "#fa6675",
  success: "#5fb865",
  gridStripe: "#26282b",
  gridSelection: "#214283",
  gridNull: "#868a91",
  editModified: "#2f4a6b",
  editInserted: "#2f4d34",
  editDeleted: "#4d2f33",
  selection: "#2e436e",
  searchMatch: "#6b5a1e",
  keyIcon: "#d9a343",
  warning: "#e0a84a",
  statementFlash: "#2c3427",
  planBar: "#4f80c9",
  analysedBanner: "#4a3d22",
  datasource: {
    red: "#c75450",
    orange: "#d08b46",
    yellow: "#c9ae4a",
    green: "#5e9f62",
    blue: "#4f80c9",
    violet: "#9670c7",
  },
  syntax: {
    keyword: "#cf8e6d",
    string: "#6aab73",
    number: "#2aacb8",
    comment: "#868a91",
    identifier: "#c77dbb",
    operator: "#bcbec4",
    variable: "#56a8f5",
    bracketMatch: "#43454a",
  },
};

/** IntelliJ Light-like. */
export const LIGHT_COLORS: ColorTokens = {
  canvas: "#ffffff",
  panel: "#f7f8fa",
  raised: "#ebecf0",
  border: "#d3d5db",
  ink: "#1f2023",
  inkMuted: "#5a5d6b",
  accent: "#2b63d9",
  accentInk: "#ffffff",
  danger: "#c7222d",
  success: "#1f7a35",
  gridStripe: "#f5f6f8",
  gridSelection: "#c9dafc",
  gridNull: "#6f737a",
  editModified: "#dce8fc",
  editInserted: "#dcf2df",
  editDeleted: "#fbe0e2",
  selection: "#dfe1e5",
  searchMatch: "#f6e39a",
  keyIcon: "#b07d14",
  warning: "#8a5a00",
  statementFlash: "#e1f1d3",
  planBar: "#4a7fe0",
  analysedBanner: "#faecd0",
  datasource: {
    red: "#e05a55",
    orange: "#e08a3e",
    yellow: "#d4b032",
    green: "#4e9a55",
    blue: "#4a7fe0",
    violet: "#9a6fd1",
  },
  syntax: {
    keyword: "#0033b3",
    string: "#067d17",
    number: "#1750eb",
    comment: "#6f737a",
    identifier: "#871094",
    operator: "#080808",
    variable: "#9e5a00",
    bracketMatch: "#d3e1fb",
  },
};

/** Black with white ink and saturated accents. */
export const HIGH_CONTRAST_COLORS: ColorTokens = {
  canvas: "#000000",
  panel: "#0a0a0a",
  raised: "#1c1c1c",
  border: "#b0b0b0",
  ink: "#ffffff",
  inkMuted: "#d4d4d4",
  accent: "#66b2ff",
  accentInk: "#000000",
  danger: "#ff7070",
  success: "#5bf15b",
  gridStripe: "#0f0f0f",
  gridSelection: "#0f3d8c",
  gridNull: "#c4c4c4",
  editModified: "#12305c",
  editInserted: "#0f3d16",
  editDeleted: "#4a1015",
  selection: "#1f3a66",
  searchMatch: "#6b5a00",
  keyIcon: "#ffd23f",
  warning: "#ffd23f",
  statementFlash: "#2b4a10",
  planBar: "#66b2ff",
  analysedBanner: "#4a3a00",
  datasource: {
    red: "#ff5c5c",
    orange: "#ff9f40",
    yellow: "#ffe04d",
    green: "#4dd65a",
    blue: "#4da6ff",
    violet: "#c78bff",
  },
  syntax: {
    keyword: "#ff9e5e",
    string: "#6ee26e",
    number: "#4de0f0",
    comment: "#c4c4c4",
    identifier: "#ff8cf0",
    operator: "#ffffff",
    variable: "#7cc4ff",
    bracketMatch: "#3b3b3b",
  },
};

export const BUILT_IN_THEMES: Readonly<Record<BuiltInThemeId, Theme>> = {
  dark: { id: "dark", name: "Dark", colorScheme: "dark", contrast: "aa", colors: DARK_COLORS },
  light: { id: "light", name: "Light", colorScheme: "light", contrast: "aa", colors: LIGHT_COLORS },
  highContrast: {
    id: "highContrast",
    name: "High contrast",
    colorScheme: "dark",
    contrast: "aaa",
    colors: HIGH_CONTRAST_COLORS,
  },
};

export const BUILT_IN_THEME_IDS = ["dark", "light", "highContrast"] as const satisfies readonly BuiltInThemeId[];

export function isBuiltInThemeId(value: string): value is BuiltInThemeId {
  return (BUILT_IN_THEME_IDS as readonly string[]).includes(value);
}

export const BUNDLED_THEMES: Readonly<Record<BundledThemeId, Theme>> = { ...BUILT_IN_THEMES, ...PORTED_THEMES };

export const BUNDLED_THEME_IDS: readonly BundledThemeId[] = [...BUILT_IN_THEME_IDS, ...PORTED_THEME_IDS];

export function isBundledThemeId(value: string): value is BundledThemeId {
  return Object.hasOwn(BUNDLED_THEMES, value);
}

export const DEFAULT_FONTS: FontTokens = {
  ui: { family: SYSTEM_UI_FONT, sizePx: 13 },
  editor: { family: SYSTEM_MONO_FONT, sizePx: 13 },
  grid: { family: SYSTEM_MONO_FONT, sizePx: 12 },
};

export const COMFORTABLE_DENSITY: DensityTokens = {
  rowHeightPx: 24,
  cellPaddingPx: 8,
  gapPx: 8,
  gridColumnMaxWidthPx: 320,
  valuePanelWidthPx: 360,
  consoleHeightPx: 128,
  stripeWidthPx: 36,
  tabHeightPx: 32,
  titleBarHeightPx: 40,
  statusBarHeightPx: 24,
  iconPx: 16,
  paletteWidthPx: 576,
  dialogWidthPx: 1040,
  dialogHeightPx: 720,
  dialogListWidthPx: 240,
  dialogLabelMaxPx: 200,
  popoverWidthPx: 480,
  popoverHeightPx: 360,
  generatorWidthPx: 640,
  pickerWidthPx: 720,
  pickerListHeightPx: 220,
  planDetailsWidthPx: 320,
  planBarHeightPx: 3,
  // JetBrains' Islands: the gap is `Island.borderWidth` less one, the radius half `Island.arc`.
  islandGapPx: 5,
  islandRadiusPx: 10,
};

/** DataGrip's Compact Mode: tighter rows and gutters, every panel size as comfortable. */
export const COMPACT_DENSITY: DensityTokens = {
  ...COMFORTABLE_DENSITY,
  rowHeightPx: 20,
  cellPaddingPx: 6,
  gapPx: 6,
  titleBarHeightPx: 32,
  // JetBrains' compact 3 px reads as a seam rather than a gap at 20 px rows.
  islandGapPx: 4,
  islandRadiusPx: 8,
};

/** The width the macOS traffic lights take at x = 12 (they end near 72 px), plus a margin. */
export const TRAFFIC_LIGHT_INSET_PX = 76;
export const EDITOR_TOOLTIP_RADIUS_PX = 6;

export type DensityId = "comfortable" | "compact";

export const DENSITIES: Readonly<Record<DensityId, DensityTokens>> = {
  comfortable: COMFORTABLE_DENSITY,
  compact: COMPACT_DENSITY,
};

export const DEFAULT_APPEARANCE: Appearance = {
  colors: DARK_COLORS,
  fonts: DEFAULT_FONTS,
  density: COMFORTABLE_DENSITY,
  motion: MOTION.full,
  windowStyle: "islands",
  frame: frameColors(BUILT_IN_THEMES.dark),
};

/** Every colour token a user theme may override; `syntax` and `datasource` are partial in turn. */
export interface ColorOverrides extends Partial<Omit<ColorTokens, "syntax" | "datasource">> {
  readonly syntax?: Partial<SyntaxColorTokens>;
  readonly datasource?: Partial<Readonly<Record<DatasourceTint, string>>>;
}

export function overrideColors(base: ColorTokens, overrides: ColorOverrides): ColorTokens {
  const { syntax, datasource, ...flat } = overrides;
  return {
    ...base,
    ...flat,
    syntax: { ...base.syntax, ...syntax },
    datasource: { ...base.datasource, ...datasource },
  };
}

/** A file in `<userData>/themes/` that validated, resolved over its base by main. */
export interface UserTheme {
  readonly id: UserThemeId;
  readonly name: string;
  readonly base: BundledThemeId;
  readonly colors: ColorTokens;
}

/** A file in `<userData>/themes/` that did not validate: listed, never chosen (decision 032). */
export interface BrokenUserTheme {
  readonly id: UserThemeId;
  readonly file: string;
  readonly errors: readonly string[];
}

export type UserThemeEntry = UserTheme | BrokenUserTheme;

export function isBrokenUserTheme(entry: UserThemeEntry): entry is BrokenUserTheme {
  return "errors" in entry;
}

export function userThemeId(fileStem: string): UserThemeId {
  return `user:${fileStem}`;
}

/** What the operating system asks for; `"system"` follows it. */
export interface SystemAppearance {
  readonly prefersDark: boolean;
  readonly prefersMoreContrast: boolean;
}

export interface ResolvedTheme {
  readonly theme: Theme;
  /** Why the chosen theme was not used, when it was not. */
  readonly notice: string | null;
}

/** The theme choice of `settings.json` (`"system"`, a bundled id or `user:<stem>`) made concrete. */
export function resolveTheme(
  choice: string,
  system: SystemAppearance,
  userThemes: readonly UserThemeEntry[],
): ResolvedTheme {
  if (choice === "system") {
    const id = system.prefersMoreContrast ? "highContrast" : system.prefersDark ? "dark" : "light";
    return { theme: BUILT_IN_THEMES[id], notice: null };
  }
  if (isBundledThemeId(choice)) return { theme: BUNDLED_THEMES[choice], notice: null };
  const entry = userThemes.find((candidate) => candidate.id === choice);
  if (entry === undefined) {
    return {
      theme: BUILT_IN_THEMES.dark,
      notice: `Theme "${choice.replace(/^user:/, "")}" is no longer in the themes folder, so Dark is used. Choose another theme in Settings.`,
    };
  }
  if (isBrokenUserTheme(entry)) {
    return {
      theme: BUILT_IN_THEMES.dark,
      notice: `Theme file ${entry.file} has errors, so Dark is used. Fix the file and choose Reload Themes in Settings.`,
    };
  }
  return {
    theme: {
      id: entry.id,
      name: entry.name,
      colorScheme: BUNDLED_THEMES[entry.base].colorScheme,
      contrast: BUNDLED_THEMES[entry.base].contrast,
      colors: entry.colors,
    },
    notice: null,
  };
}
