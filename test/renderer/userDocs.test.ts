import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { API_VERSION, CAPABILITIES, MANIFEST_FILE } from "@table-craft/plugin-api";
import { PLUGIN_CATALOG } from "@table-craft/desktop/main/pluginStore/catalog.js";
import { BUILT_IN_PLUGINS } from "../../packages/desktop/vite.plugins.config.js";
import { ALL_ACTIONS } from "@table-craft/desktop/renderer/actions/allActions.js";
import { formatChord } from "@table-craft/desktop/renderer/actions/chords.js";
import {
  BUILT_IN_THEME_IDS,
  BUNDLED_THEME_IDS,
  BUNDLED_THEMES,
  DENSITIES,
  PORTED_THEME_IDS,
} from "@table-craft/desktop/appearance/themes.js";
import { MOTION_CHOICES } from "@table-craft/desktop/appearance/motion.js";
import {
  DEFAULT_SETTINGS,
  EXPORT_STALL_SECONDS_RANGE,
  FETCH_ALL_CAP_RANGE,
  BLOB_LIMIT_MB_RANGE,
  FONT_SIZE_RANGE,
  FORMAT_STYLES,
  INDENT_WIDTH_RANGE,
  KEYWORD_CASES,
  LINES_BETWEEN_STATEMENTS_RANGE,
  MCP_TIMEOUT_SECONDS_RANGE,
  NULL_TEXT_LENGTH,
  PAGE_ROWS_RANGE,
  STATEMENT_TIMEOUT_SECONDS_RANGE,
  SESSIONS_REFRESH_SECONDS_RANGE,
  type NumberRange,
} from "@table-craft/desktop/settings/settings.js";

const ROOT = resolve(import.meta.dirname, "../..");
const README = "README.md";
const CONTRIBUTING = "CONTRIBUTING.md";
const GUIDE_DIRECTORY = "docs/guide";
const README_LINE_BUDGET = 200;
const MEDIA_DIRECTORY = "docs/media";
const HEADING = /^(#{1,6}) (.+)$/;
const FENCE = "```";
const MARKDOWN = ".md";
const VERIFY_SCRIPTS = ["lint", "format:check", "typecheck", "test"];
const USER_THEME_CHOICE = "user:<file stem>";
const RANGE_DASH = "–";
const MIN_SHORTCUT_ROWS = 25;

const RANGES: Readonly<Record<string, NumberRange>> = {
  "editor.format.indentWidth": INDENT_WIDTH_RANGE,
  "editor.format.linesBetweenStatements": LINES_BETWEEN_STATEMENTS_RANGE,
  "data.nullText": NULL_TEXT_LENGTH,
  "data.pageRows": PAGE_ROWS_RANGE,
  "data.fetchAllCap": FETCH_ALL_CAP_RANGE,
  "data.exportStallSeconds": EXPORT_STALL_SECONDS_RANGE,
  "data.blobLimitMb": BLOB_LIMIT_MB_RANGE,
  "console.statementTimeoutSeconds": STATEMENT_TIMEOUT_SECONDS_RANGE,
  "console.sessionsRefreshSeconds": SESSIONS_REFRESH_SECONDS_RANGE,
  "mcp.statementTimeoutSeconds": MCP_TIMEOUT_SECONDS_RANGE,
};

/** GitHub's heading anchor: lower case, punctuation dropped, each space a hyphen. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

function guidePages(): string[] {
  return readdirSync(join(ROOT, GUIDE_DIRECTORY))
    .filter((file) => file.endsWith(MARKDOWN))
    .sort()
    .map((file) => `${GUIDE_DIRECTORY}/${file}`);
}

/** README, CONTRIBUTING and every guide page, as paths from the repo root. */
function userDocs(): string[] {
  return [README, CONTRIBUTING, ...guidePages()];
}

/** A path written in `file`, as a path from the repo root, the way GitHub resolves it. */
function fromRoot(file: string, target: string): string {
  return relative(ROOT, resolve(ROOT, dirname(file), target));
}

interface Heading {
  readonly line: number;
  readonly level: number;
  readonly title: string;
}

function headings(markdown: string): Heading[] {
  let inFence = false;
  return markdown.split("\n").flatMap((text, line) => {
    if (text.startsWith(FENCE)) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(text);
    return match === null ? [] : [{ line, level: match[1]?.length ?? 0, title: match[2] ?? "" }];
  });
}

function headingSlugs(markdown: string): Set<string> {
  return new Set(headings(markdown).map((heading) => slug(heading.title)));
}

/** The text under the heading `title` at any level, up to the next heading of the same or a higher level. */
function section(file: string, title: string): string {
  const markdown = read(file);
  const all = headings(markdown);
  const start = all.findIndex((heading) => heading.title === title);
  expect(start, `${file} has a "${title}" heading`).toBeGreaterThanOrEqual(0);
  const { line, level } = all[start] as Heading;
  const end = all.slice(start + 1).find((heading) => heading.level <= level)?.line;
  return markdown.split("\n").slice(line, end).join("\n");
}

function images(markdown: string): string[] {
  return [
    ...[...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1] ?? ""),
    ...[...markdown.matchAll(/<img src="([^"]+)"/g)].map((match) => match[1] ?? ""),
  ];
}

function manifestName(pluginId: string): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, "plugins", pluginId, MANIFEST_FILE), "utf8")) as { name: string };
  return manifest.name;
}

function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|\s*:?-/.test(line))
    .slice(1)
    .map((line) =>
      line
        .slice(1, -1)
        .split(" | ")
        .map((cell) => cell.trim()),
    );
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

function settingAt(path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], DEFAULT_SETTINGS);
}

function settingPaths(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || "sizePx" in value) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => settingPaths(child, prefix ? `${prefix}.${key}` : key));
}

function rangeText(range: NumberRange): string {
  return `${range.min.toLocaleString("en-US")}${RANGE_DASH}${range.max.toLocaleString("en-US")}`;
}

describe("user docs", () => {
  it("givenUserDocs_whenImagesListed_thenEveryFileExistsRelativeToItsPage", () => {
    for (const file of userDocs()) {
      for (const image of images(read(file))) {
        expect(existsSync(join(ROOT, fromRoot(file, image))), `${file}: ${image} exists`).toBe(true);
      }
    }
  });

  it("givenUserDocs_whenImagesListed_thenMediaHoldsOnlyTheirGifs", () => {
    const shown = new Set(userDocs().flatMap((file) => images(read(file)).map((image) => fromRoot(file, image))));
    const gifs = readdirSync(join(ROOT, MEDIA_DIRECTORY)).map((file) => `${MEDIA_DIRECTORY}/${file}`);

    expect([...gifs].sort(), `${MEDIA_DIRECTORY} holds only the GIFs the user docs show`).toEqual(
      [...shown].filter((image) => image.startsWith(`${MEDIA_DIRECTORY}/`)).sort(),
    );
  });

  it("givenUserDocs_whenLinksListed_thenEveryAnchorMatchesItsTargetsHeading", () => {
    for (const file of userDocs()) {
      const links = [...read(file).matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");
      const local = links.filter((link) => !/^[a-z]+:/.test(link) && !link.endsWith(".gif"));
      for (const link of local) {
        const [path = "", anchor] = link.split("#");
        const target = path === "" ? file : fromRoot(file, path);
        expect(existsSync(join(ROOT, target)), `${file}: ${link} points at a file`).toBe(true);
        if (anchor === undefined) continue;
        if (!target.endsWith(MARKDOWN)) expect.fail(`${file}: ${link} anchors into a file the test cannot check`);
        expect(headingSlugs(read(target)), `${file}: ${link} matches a heading`).toContain(anchor);
      }
    }
  });

  it("givenGuidePages_whenReadmeIndexRead_thenEveryPageIsListedOnce", () => {
    const listed = [...section(README, "Documentation").matchAll(/\]\(([^)#\s]+\.md)\)/g)].map(
      (match) => match[1] ?? "",
    );

    expect([...listed].sort()).toEqual(guidePages());
  });

  it("givenGuidePage_whenRead_thenItHasExactlyOneTitle", () => {
    for (const file of guidePages()) {
      const titles = headings(read(file)).filter((heading) => heading.level === 1);
      expect(
        titles.map((heading) => heading.line),
        `${file} opens with its one # title`,
      ).toEqual([0]);
    }
  });

  it("givenReadme_whenCounted_thenItStaysWithinItsLineBudget", () => {
    const lines = read(README).trimEnd().split("\n").length;

    expect(lines, `README.md is ${String(lines)} lines; move detail into a guide page`).toBeLessThanOrEqual(
      README_LINE_BUDGET,
    );
  });

  it("givenShortcutTable_whenComparedWithRegistry_thenEveryChordMatchesOnBothPlatforms", () => {
    const rows = tableRows(section("docs/guide/shortcuts.md", "Keyboard shortcuts"));

    expect(rows.length).toBeGreaterThanOrEqual(MIN_SHORTCUT_ROWS);
    for (const [title = "", mac = "", other = ""] of rows) {
      const chords = ALL_ACTIONS.filter((action) => action.title === title && action.shortcut !== undefined).map(
        (action) => ({
          mac: `\`${formatChord(action.shortcut ?? "", "mac")}\``,
          other: `\`${formatChord(action.shortcut ?? "", "other")}\``,
        }),
      );
      expect(chords, `Keyboard shortcuts row "${title}"`).toContainEqual({ mac, other });
    }
  });

  it("givenSettingsTable_whenComparedWithDefaults_thenValuesAndDefaultsMatch", () => {
    const rows = tableRows(section("docs/guide/settings.md", "Settings file"));
    const fields = rows.map(([field = ""]) => codeSpans(field)[0] ?? field);

    expect([...fields].sort()).toEqual(
      settingPaths(DEFAULT_SETTINGS, "")
        .filter((path) => path !== "version")
        .sort(),
    );
    for (const [field = "", values = "", fallback = ""] of rows) {
      const path = codeSpans(field)[0] ?? "";
      const value = settingAt(path);
      if (typeof value === "object" && value !== null && "sizePx" in value) {
        expect(fallback, `Settings row ${path}`).toBe(`\`null\`, ${String(value.sizePx)}`);
        expect(values, `Settings row ${path}`).toContain(rangeText(FONT_SIZE_RANGE));
        continue;
      }
      if (Array.isArray(value)) {
        expect(fallback, `Settings row ${path}`).toBe(`\`${JSON.stringify(value)}\``);
        continue;
      }
      expect(fallback.replaceAll("`", "").replaceAll(",", ""), `Settings row ${path}`).toBe(String(value));
      const range = RANGES[path];
      if (range !== undefined) expect(values, `Settings row ${path}`).toContain(rangeText(range));
    }
    const choices = (path: string) => codeSpans(rows.find(([field]) => field === `\`${path}\``)?.[1] ?? "");
    expect(choices("appearance.theme")).toEqual(["system", ...BUILT_IN_THEME_IDS, USER_THEME_CHOICE]);
    expect(choices("appearance.density")).toEqual(Object.keys(DENSITIES));
    expect(choices("appearance.motion")).toEqual(MOTION_CHOICES);
    expect(choices("editor.format.keywordCase")).toEqual(KEYWORD_CASES);
    expect(choices("editor.format.style")).toEqual(FORMAT_STYLES);
  });

  it("givenThemesTable_whenComparedWithBundledThemes_thenEveryThemeIsListedWithItsSource", () => {
    const themes = section("docs/guide/themes.md", "Themes");
    const rows = tableRows(themes);

    expect(rows.map(([, id = ""]) => codeSpans(id)[0])).toEqual([...BUNDLED_THEME_IDS]);
    for (const [name, id = "", scheme, source, licence] of rows) {
      const theme = BUNDLED_THEMES[codeSpans(id)[0] as (typeof BUNDLED_THEME_IDS)[number]];
      expect([name, scheme, source, licence], `Themes row ${id}`).toEqual([
        theme.name,
        theme.colorScheme === "dark" ? "Dark" : "Light",
        theme.source ?? "TableCraft",
        theme.licence ?? "—",
      ]);
    }
    expect(themes).toContain(`${String(PORTED_THEME_IDS.length)} more ported`);
  });

  it("givenPluginsSection_whenCapabilitiesListed_thenTheyEqualCapabilities", () => {
    // The sample is a SQL plugin's manifest; `commands` excludes `sql`, and PostgreSQL has no nodes.
    const NOT_IN_SQL_SAMPLE: readonly string[] = ["commands", "keyValue", "nodes", "serverInfo"];
    const plugins = section("docs/guide/writing-plugins.md", "Capabilities");
    const listed = [...plugins.matchAll(/^- `(\w+)`:/gm)].map((match) => match[1]);
    const manifest = JSON.parse(/```json\n([\s\S]*?)```/.exec(plugins)?.[1] ?? "null") as {
      apiVersion: string;
      capabilities: string[];
    };

    expect(listed).toEqual([...CAPABILITIES]);
    expect(manifest.capabilities).toEqual(CAPABILITIES.filter((capability) => !NOT_IN_SQL_SAMPLE.includes(capability)));
    expect(manifest.apiVersion).toBe(API_VERSION);
  });

  it("givenDatabasesSection_whenRead_thenItNamesTheBuiltInsAndEveryDownloadablePlugin", () => {
    const databases = section("docs/guide/plugins.md", "Databases in the box and on demand");
    const [boxed = ""] = databases.split("ship inside the app");
    const builtIn = BUILT_IN_PLUGINS.map((id) => manifestName(id));

    for (const name of builtIn) expect(boxed, `${name} ships in the box`).toContain(name);
    for (const entry of PLUGIN_CATALOG) {
      expect(boxed, `${entry.name} downloads`).not.toContain(entry.name);
      expect(databases).toContain(`\`${entry.packageName}\``);
    }
  });

  it("givenContributing_whenScriptsListed_thenEveryScriptExistsAndTheFourChecksAreNamed", () => {
    const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const listed = [...read(CONTRIBUTING).matchAll(/\bbun run (\w[\w:-]*)/g)].map((match) => match[1] ?? "");

    expect(listed).toEqual(expect.arrayContaining(["readme:media", ...VERIFY_SCRIPTS]));
    for (const script of listed) expect(Object.keys(scripts), `bun run ${script}`).toContain(script);
  });
});
