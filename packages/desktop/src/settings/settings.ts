/**
 * The preferences in `<userData>/settings.json` (decision 032): the type, every default and every
 * range, in one pure module main and the renderer share. Parsing is by hand, field by field, so
 * that the renderer, which never loads zod, can use it too.
 */
import {
  isBundledThemeId,
  type BundledThemeId,
  type DensityId,
  type UserThemeId,
} from "@table-craft/desktop/appearance/themes.js";
import { isWindowStyle, type WindowStyle } from "@table-craft/desktop/appearance/islands.js";
import { isMotionChoice, type MotionChoice } from "@table-craft/desktop/appearance/motion.js";
import { isUpdateChannelSetting, type UpdateChannelSetting } from "@table-craft/desktop/settings/channel.js";
import type { McpKnownClient } from "@table-craft/desktop/settings/mcp.js";

export const SETTINGS_VERSION = 1;

export type ThemeChoice = "system" | BundledThemeId | UserThemeId;

export interface FontSetting {
  /** `null` is the built-in stack; a family is written ahead of it, so a missing font falls back. */
  readonly family: string | null;
  readonly sizePx: number;
}

export interface FontSettings {
  readonly ui: FontSetting;
  readonly editor: FontSetting;
  readonly grid: FontSetting;
}

/** What colour a datasource logo takes: its brand's, fitted to the theme, or the theme's muted ink. */
export const BRAND_ICON_COLORS = ["brand", "gray"] as const;

export type BrandIconColor = (typeof BRAND_ICON_COLORS)[number];

export interface AppearanceSettings {
  readonly theme: ThemeChoice;
  readonly density: DensityId;
  readonly fonts: FontSettings;
  /** How much the window animates (plan 109); `system` follows `prefers-reduced-motion`. */
  readonly motion: MotionChoice;
  /** Islands draws the editor and tool windows as cards on a frame; classic butts them together (decision 141). */
  readonly windowStyle: WindowStyle;
  /** Frame the window with the operating system's title bar; main reads it at window creation. */
  readonly systemTitleBar: boolean;
  /** Draw each data source's database logo instead of the generic glyph (decision 128). */
  readonly brandIcons: boolean;
  readonly brandIconColor: BrandIconColor;
}

export interface DataSettings {
  /** What a NULL cell draws. */
  readonly nullText: string;
  /** Tint every second grid row; off by default, the selection and the row lines carry the eye (plan 130 decision 8). */
  readonly stripedRows: boolean;
  /** Group the integer digits of a number column with `,`; display only. */
  readonly groupDigits: boolean;
  /** Open text values holding a JSON object or array formatted in the value panel (plan 126). */
  readonly detectJson: boolean;
  /** Rows a statement reads before it stops, and Fetch Next Page adds. */
  readonly pageRows: number;
  /** Rows Fetch All reads at most. */
  readonly fetchAllCap: number;
  /** Seconds an export waits for the next row before it fails as stalled (decision 040). */
  readonly exportStallSeconds: number;
  /** Which selection aggregates the grid's status line shows, in `AGGREGATE_NAMES` order (plan 043). */
  readonly aggregates: readonly AggregateName[];
  /** The largest file, in MiB, Load from File puts into a bytes cell. */
  readonly blobLimitMb: number;
  readonly watchRetention: number;
}

/** The selection aggregates the grid can show, in the order it shows them. */
export const AGGREGATE_NAMES = ["count", "distinct", "sum", "avg", "min", "max"] as const;
export type AggregateName = (typeof AGGREGATE_NAMES)[number];

/** Mirrors `KEYWORD_CASES` in plugin-api. */
export const KEYWORD_CASES = ["upper", "lower", "preserve"] as const;

export type KeywordCase = (typeof KEYWORD_CASES)[number];

/** Mirrors `FORMAT_STYLES` in plugin-api (decision 061). */
export const FORMAT_STYLES = ["aligned", "standard"] as const;

export type FormatStyle = (typeof FORMAT_STYLES)[number];

/** How Reformat Code lays SQL out (decisions 042, 061); sent as the plugin's `FormatOptions`. */
export interface FormatSettings {
  readonly style: FormatStyle;
  readonly keywordCase: KeywordCase;
  readonly indentWidth: number;
  /** Blank lines between two statements. */
  readonly linesBetweenStatements: number;
  /** Pad aliased select items so `AS` lines up; the aligned style only. */
  readonly alignAliases: boolean;
}

/** Live SQL inspections in the console (plan 108 decision 6). */
export interface InspectionSettings {
  /** The master switch: off, the console asks for no problems at all. */
  readonly enabled: boolean;
  /** Inspection ids, such as `SqlRedundantAlias`, the plugin skips. */
  readonly disabled: readonly string[];
}

export interface EditorSettings {
  readonly format: FormatSettings;
  readonly inspections: InspectionSettings;
}

/** Mirrors `ON_ERROR_CHOICES` in the engine protocol (decision 083). */
export const RUN_ALL_ON_ERROR_CHOICES = ["ask", "stop", "continue"] as const;

export type RunAllOnError = (typeof RUN_ALL_ON_ERROR_CHOICES)[number];

export interface ConsoleSettings {
  /** Prompt for `:name`, `?` and `$1` before a run and bind the values (decision 043); off runs SQL verbatim. */
  readonly parameters: boolean;
  /**
   * How long a console statement may run before the engine cancels it; 0 for no limit. A data
   * source's own timeout overrides it (decision 054).
   */
  readonly statementTimeoutSeconds: number;
  /** How often a Sessions tab with Auto-refresh on lists the server's sessions again (plan 045). */
  readonly sessionsRefreshSeconds: number;
  /** What a run of more than one statement, and Run SQL Script, does when a statement fails (decision 083). */
  readonly runAllOnError: RunAllOnError;
}

/** The levels Settings → Advanced offers; `error` and `warn` are always written (plan 017 decision 3). */
export const LOG_LEVEL_CHOICES = ["info", "debug"] as const;
export type LogLevelChoice = (typeof LOG_LEVEL_CHOICES)[number];

export interface LogSettings {
  /** `debug` adds every engine request envelope to the log; applies without a restart. */
  readonly level: LogLevelChoice;
}

export interface UpdateSettings {
  /** Look for a new version after launch and every 2 hours; installing always waits for a click (plan 020). */
  readonly checkAutomatically: boolean;
  /** Which releases updates and plugins come from (plan 124); resolve with `effectiveChannel`. */
  readonly channel: UpdateChannelSetting;
}

export interface PluginSettings {
  /** The npm registry downloadable plugins come from (decision 110); https, or http on this machine. */
  readonly registryUrl: string;
}

export interface McpSettings {
  /** Off by default: no port is opened until the user turns the server on (decision 126). */
  readonly enabled: boolean;
  /** Bound on 127.0.0.1 only. */
  readonly port: number;
  /** The most rows one `run_query` or `fetch_rows` answer carries. */
  readonly rowCap: number;
  /** How long an agent's statement may run; the database stops it there too where it can (decision 129). */
  readonly statementTimeoutSeconds: number;
  /** Client names the user allowed or blocked; a name not listed waits for an answer (decision 127). */
  readonly clients: readonly McpKnownClient[];
  /** A system notification and a dock badge while an agent waits and no window is focused (decision 143). */
  readonly notifications: boolean;
}

export interface Settings {
  readonly version: typeof SETTINGS_VERSION;
  readonly appearance: AppearanceSettings;
  readonly editor: EditorSettings;
  readonly console: ConsoleSettings;
  readonly data: DataSettings;
  readonly log: LogSettings;
  readonly updates: UpdateSettings;
  readonly plugins: PluginSettings;
  readonly mcp: McpSettings;
}

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

/** Null when plugins may be downloaded from `url`: https anywhere, plain http only from this machine. */
export function registryUrlError(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Enter a registry address such as https://registry.npmjs.org.";
  }
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.includes(parsed.hostname)) return null;
  return "The registry address must start with https:// (plain http only for this machine).";
}

export type FontRole = keyof FontSettings;

export interface NumberRange {
  readonly min: number;
  readonly max: number;
}

export const FONT_SIZE_RANGE: NumberRange = { min: 8, max: 32 };
export const PAGE_ROWS_RANGE: NumberRange = { min: 10, max: 10_000 };
export const FETCH_ALL_CAP_RANGE: NumberRange = { min: 1_000, max: 1_000_000 };
export const EXPORT_STALL_SECONDS_RANGE: NumberRange = { min: 10, max: 3_600 };
export const BLOB_LIMIT_MB_RANGE: NumberRange = { min: 1, max: 128 };
export const WATCH_RETENTION_RANGE: NumberRange = { min: 1_000, max: 100_000 };
export function watchRetentionError(value: number): string | null {
  return rangeError(value, WATCH_RETENTION_RANGE, "Watch retention");
}
export const NULL_TEXT_LENGTH: NumberRange = { min: 1, max: 16 };
export const INDENT_WIDTH_RANGE: NumberRange = { min: 1, max: 8 };
export const LINES_BETWEEN_STATEMENTS_RANGE: NumberRange = { min: 0, max: 5 };
/** 0 is no limit; the top is one day. */
export const STATEMENT_TIMEOUT_SECONDS_RANGE: NumberRange = { min: 0, max: 86_400 };
/** 0 turns keepalive off; the top is the two hours an OS waits by default (decision 054). */
export const KEEPALIVE_SECONDS_RANGE: NumberRange = { min: 0, max: 7_200 };
export const SESSIONS_REFRESH_SECONDS_RANGE: NumberRange = { min: 1, max: 3_600 };
export const DEFAULT_KEEPALIVE_SECONDS = 30;
/** Above the well-known ports, so binding never needs privileges. */
export const MCP_PORT_RANGE: NumberRange = { min: 1_024, max: 65_535 };
/** The top matches `fetch_rows`'s own limit: more rows than this only fill an agent's context. */
export const MCP_ROW_CAP_RANGE: NumberRange = { min: 1, max: 1_000 };
/** An agent waits on every call, so its statements always have a limit; the top is an hour. */
export const MCP_TIMEOUT_SECONDS_RANGE: NumberRange = { min: 1, max: 3_600 };
/** Longer than any installed family's name; guards a hand-edited file, not a real font. */
export const FONT_FAMILY_MAX_LENGTH = 128;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  appearance: {
    theme: "system",
    density: "comfortable",
    fonts: {
      ui: { family: null, sizePx: 13 },
      editor: { family: null, sizePx: 13 },
      grid: { family: null, sizePx: 12 },
    },
    motion: "system",
    windowStyle: "islands",
    systemTitleBar: false,
    brandIcons: true,
    brandIconColor: "brand",
  },
  editor: {
    format: { style: "aligned", keywordCase: "upper", indentWidth: 2, linesBetweenStatements: 1, alignAliases: true },
    inspections: { enabled: true, disabled: [] },
  },
  console: {
    parameters: true,
    statementTimeoutSeconds: 0,
    sessionsRefreshSeconds: 5,
    runAllOnError: "ask",
  },
  data: {
    nullText: "<null>",
    stripedRows: false,
    groupDigits: false,
    detectJson: true,
    pageRows: 500,
    fetchAllCap: 100_000,
    exportStallSeconds: 120,
    aggregates: AGGREGATE_NAMES,
    blobLimitMb: 16,
    watchRetention: 10_000,
  },
  log: {
    level: "info",
  },
  updates: {
    checkAutomatically: true,
    channel: "auto",
  },
  plugins: {
    registryUrl: DEFAULT_REGISTRY_URL,
  },
  mcp: {
    enabled: false,
    port: 47_820,
    rowCap: 100,
    statementTimeoutSeconds: 120,
    clients: [],
    notifications: true,
  },
};

const DENSITY_IDS: readonly DensityId[] = ["comfortable", "compact"];
const USER_THEME_PREFIX = "user:";

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function inRange(value: unknown, range: NumberRange): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= range.min && value <= range.max;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  if (typeof value !== "string") return false;
  if (value === "system" || isBundledThemeId(value)) return true;
  return value.startsWith(USER_THEME_PREFIX) && value.length > USER_THEME_PREFIX.length;
}

export function fontFamilyError(family: string): string | null {
  if (family.trim() === "") return "Enter a font family name.";
  if (family.length > FONT_FAMILY_MAX_LENGTH)
    return `A font family name is at most ${FONT_FAMILY_MAX_LENGTH} characters.`;
  // eslint-disable-next-line no-control-regex -- a control character would break the CSS font-family it is written into
  if (/[\u0000-\u001f;{}]/.test(family))
    return "A font family name cannot contain control characters, ';', '{' or '}'.";
  return null;
}

function rangeError(value: number, range: NumberRange, what: string): string | null {
  if (!Number.isInteger(value)) return `${what} must be a whole number.`;
  if (value < range.min || value > range.max) {
    return `${what} must be between ${range.min.toLocaleString("en-US")} and ${range.max.toLocaleString("en-US")}.`;
  }
  return null;
}

export function fontSizeError(sizePx: number): string | null {
  return rangeError(sizePx, FONT_SIZE_RANGE, "Font size");
}

export function pageRowsError(pageRows: number): string | null {
  return rangeError(pageRows, PAGE_ROWS_RANGE, "Page size");
}

export function fetchAllCapError(fetchAllCap: number, pageRows: number): string | null {
  const error = rangeError(fetchAllCap, FETCH_ALL_CAP_RANGE, "The Fetch All limit");
  if (error !== null) return error;
  return fetchAllCap < pageRows ? "The Fetch All limit must be at least the page size." : null;
}

export function indentWidthError(indentWidth: number): string | null {
  return rangeError(indentWidth, INDENT_WIDTH_RANGE, "Indent width");
}

export function linesBetweenStatementsError(lines: number): string | null {
  return rangeError(lines, LINES_BETWEEN_STATEMENTS_RANGE, "Blank lines between statements");
}

export function exportStallSecondsError(seconds: number): string | null {
  return rangeError(seconds, EXPORT_STALL_SECONDS_RANGE, "The export stall timeout");
}

export function statementTimeoutSecondsError(seconds: number): string | null {
  return rangeError(seconds, STATEMENT_TIMEOUT_SECONDS_RANGE, "The statement timeout");
}

export function keepAliveSecondsError(seconds: number): string | null {
  return rangeError(seconds, KEEPALIVE_SECONDS_RANGE, "The keepalive interval");
}

export function sessionsRefreshSecondsError(seconds: number): string | null {
  return rangeError(seconds, SESSIONS_REFRESH_SECONDS_RANGE, "The Sessions refresh interval");
}

/** The well-formed entries, the first per name. */
function knownClients(entries: readonly unknown[]): readonly McpKnownClient[] {
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const { name, allowed } = record(entry);
    if (typeof name !== "string" || name === "" || typeof allowed !== "boolean" || seen.has(name)) return [];
    seen.add(name);
    return [{ name, allowed }];
  });
}

export function mcpPortError(port: number): string | null {
  return rangeError(port, MCP_PORT_RANGE, "The port");
}

export function mcpRowCapError(rowCap: number): string | null {
  return rangeError(rowCap, MCP_ROW_CAP_RANGE, "The row limit");
}

export function mcpTimeoutError(seconds: number): string | null {
  return rangeError(seconds, MCP_TIMEOUT_SECONDS_RANGE, "The statement timeout");
}

export function nullTextError(nullText: string): string | null {
  if (nullText.length < NULL_TEXT_LENGTH.min || nullText.length > NULL_TEXT_LENGTH.max) {
    return `NULL text must be ${NULL_TEXT_LENGTH.min} to ${NULL_TEXT_LENGTH.max} characters.`;
  }
  return null;
}

function readFont(value: unknown, fallback: FontSetting): FontSetting {
  const font = record(value);
  const family = typeof font.family === "string" && fontFamilyError(font.family) === null ? font.family : null;
  const sizePx = inRange(font.sizePx, FONT_SIZE_RANGE) ? font.sizePx : fallback.sizePx;
  return { family, sizePx };
}

function readFormat(value: unknown, fallback: FormatSettings): FormatSettings {
  const format = record(value);
  return {
    style: FORMAT_STYLES.includes(format.style as FormatStyle) ? (format.style as FormatStyle) : fallback.style,
    keywordCase: KEYWORD_CASES.includes(format.keywordCase as KeywordCase)
      ? (format.keywordCase as KeywordCase)
      : fallback.keywordCase,
    indentWidth: inRange(format.indentWidth, INDENT_WIDTH_RANGE) ? format.indentWidth : fallback.indentWidth,
    linesBetweenStatements: inRange(format.linesBetweenStatements, LINES_BETWEEN_STATEMENTS_RANGE)
      ? format.linesBetweenStatements
      : fallback.linesBetweenStatements,
    alignAliases: typeof format.alignAliases === "boolean" ? format.alignAliases : fallback.alignAliases,
  };
}

/** Longer than any inspection id; guards a hand-edited file. */
const INSPECTION_ID_MAX_LENGTH = 64;
const INSPECTION_ID = /^\w+$/;

/**
 * Ids are kept even when this build does not know them, since a newer plugin may report its own;
 * anything that cannot be an id is dropped, and repeats are dropped.
 */
function readInspections(value: unknown, fallback: InspectionSettings): InspectionSettings {
  const inspections = record(value);
  const ids = Array.isArray(inspections.disabled)
    ? inspections.disabled.filter(
        (id): id is string => typeof id === "string" && id.length <= INSPECTION_ID_MAX_LENGTH && INSPECTION_ID.test(id),
      )
    : fallback.disabled;
  return {
    enabled: typeof inspections.enabled === "boolean" ? inspections.enabled : fallback.enabled,
    disabled: [...new Set(ids)],
  };
}

/** `settings` with inspection `id` turned on or off; the master switch is left as it is. */
export function withInspection(settings: Settings, id: string, enabled: boolean): Settings {
  const { inspections } = settings.editor;
  const others = inspections.disabled.filter((disabled) => disabled !== id);
  const disabled = enabled ? others : [...others, id];
  return { ...settings, editor: { ...settings.editor, inspections: { ...inspections, disabled } } };
}

/**
 * A settings document from anything, each field on its own: a field that is missing, of the wrong
 * type or out of range reads as its default, and the others are kept (plan 013 decision 1).
 */
export function readSettings(input: unknown): Settings {
  const root = record(input);
  const appearance = record(root.appearance);
  const fonts = record(appearance.fonts);
  const data = record(root.data);
  const editor = record(root.editor);
  const console = record(root.console);
  const log = record(root.log);
  const updates = record(root.updates);
  const plugins = record(root.plugins);
  const mcp = record(root.mcp);
  const defaults = DEFAULT_SETTINGS;
  const pageRows = inRange(data.pageRows, PAGE_ROWS_RANGE) ? data.pageRows : defaults.data.pageRows;
  const fetchAllCap =
    inRange(data.fetchAllCap, FETCH_ALL_CAP_RANGE) && data.fetchAllCap >= pageRows
      ? data.fetchAllCap
      : Math.max(defaults.data.fetchAllCap, pageRows);
  return {
    version: SETTINGS_VERSION,
    appearance: {
      theme: isThemeChoice(appearance.theme) ? appearance.theme : defaults.appearance.theme,
      density: DENSITY_IDS.includes(appearance.density as DensityId)
        ? (appearance.density as DensityId)
        : defaults.appearance.density,
      fonts: {
        ui: readFont(fonts.ui, defaults.appearance.fonts.ui),
        editor: readFont(fonts.editor, defaults.appearance.fonts.editor),
        grid: readFont(fonts.grid, defaults.appearance.fonts.grid),
      },
      motion: isMotionChoice(appearance.motion) ? appearance.motion : defaults.appearance.motion,
      windowStyle: isWindowStyle(appearance.windowStyle) ? appearance.windowStyle : defaults.appearance.windowStyle,
      systemTitleBar:
        typeof appearance.systemTitleBar === "boolean" ? appearance.systemTitleBar : defaults.appearance.systemTitleBar,
      brandIcons: typeof appearance.brandIcons === "boolean" ? appearance.brandIcons : defaults.appearance.brandIcons,
      brandIconColor: BRAND_ICON_COLORS.includes(appearance.brandIconColor as BrandIconColor)
        ? (appearance.brandIconColor as BrandIconColor)
        : defaults.appearance.brandIconColor,
    },
    editor: {
      format: readFormat(editor.format, defaults.editor.format),
      inspections: readInspections(editor.inspections, defaults.editor.inspections),
    },
    console: {
      parameters: typeof console.parameters === "boolean" ? console.parameters : defaults.console.parameters,
      statementTimeoutSeconds: inRange(console.statementTimeoutSeconds, STATEMENT_TIMEOUT_SECONDS_RANGE)
        ? console.statementTimeoutSeconds
        : defaults.console.statementTimeoutSeconds,
      sessionsRefreshSeconds: inRange(console.sessionsRefreshSeconds, SESSIONS_REFRESH_SECONDS_RANGE)
        ? console.sessionsRefreshSeconds
        : defaults.console.sessionsRefreshSeconds,
      runAllOnError: RUN_ALL_ON_ERROR_CHOICES.includes(console.runAllOnError as RunAllOnError)
        ? (console.runAllOnError as RunAllOnError)
        : defaults.console.runAllOnError,
    },
    data: {
      nullText:
        typeof data.nullText === "string" && nullTextError(data.nullText) === null
          ? data.nullText
          : defaults.data.nullText,
      stripedRows: typeof data.stripedRows === "boolean" ? data.stripedRows : defaults.data.stripedRows,
      groupDigits: typeof data.groupDigits === "boolean" ? data.groupDigits : defaults.data.groupDigits,
      detectJson: typeof data.detectJson === "boolean" ? data.detectJson : defaults.data.detectJson,
      pageRows,
      fetchAllCap,
      exportStallSeconds: inRange(data.exportStallSeconds, EXPORT_STALL_SECONDS_RANGE)
        ? data.exportStallSeconds
        : defaults.data.exportStallSeconds,
      aggregates: Array.isArray(data.aggregates)
        ? AGGREGATE_NAMES.filter((name) => (data.aggregates as unknown[]).includes(name))
        : defaults.data.aggregates,
      blobLimitMb: inRange(data.blobLimitMb, BLOB_LIMIT_MB_RANGE) ? data.blobLimitMb : defaults.data.blobLimitMb,
      watchRetention: inRange(data.watchRetention, WATCH_RETENTION_RANGE)
        ? data.watchRetention
        : defaults.data.watchRetention,
    },
    log: {
      level: LOG_LEVEL_CHOICES.includes(log.level as LogLevelChoice)
        ? (log.level as LogLevelChoice)
        : defaults.log.level,
    },
    updates: {
      checkAutomatically:
        typeof updates.checkAutomatically === "boolean"
          ? updates.checkAutomatically
          : defaults.updates.checkAutomatically,
      channel: isUpdateChannelSetting(updates.channel) ? updates.channel : defaults.updates.channel,
    },
    plugins: {
      registryUrl:
        typeof plugins.registryUrl === "string" && registryUrlError(plugins.registryUrl) === null
          ? plugins.registryUrl
          : defaults.plugins.registryUrl,
    },
    mcp: {
      enabled: typeof mcp.enabled === "boolean" ? mcp.enabled : defaults.mcp.enabled,
      port: inRange(mcp.port, MCP_PORT_RANGE) ? mcp.port : defaults.mcp.port,
      rowCap: inRange(mcp.rowCap, MCP_ROW_CAP_RANGE) ? mcp.rowCap : defaults.mcp.rowCap,
      statementTimeoutSeconds: inRange(mcp.statementTimeoutSeconds, MCP_TIMEOUT_SECONDS_RANGE)
        ? mcp.statementTimeoutSeconds
        : defaults.mcp.statementTimeoutSeconds,
      clients: Array.isArray(mcp.clients) ? knownClients(mcp.clients) : defaults.mcp.clients,
      notifications: typeof mcp.notifications === "boolean" ? mcp.notifications : defaults.mcp.notifications,
    },
  };
}

/** The editor font size `steps` px larger, within the range; zoom saves like any other change. */
export function zoomEditorFont(settings: Settings, steps: number): Settings {
  const current = settings.appearance.fonts.editor;
  const sizePx = Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, current.sizePx + steps));
  return withFont(settings, "editor", { ...current, sizePx });
}

export function withFont(settings: Settings, role: FontRole, font: FontSetting): Settings {
  return {
    ...settings,
    appearance: { ...settings.appearance, fonts: { ...settings.appearance.fonts, [role]: font } },
  };
}
