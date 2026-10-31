/**
 * Plan 013's live test: the Settings dialog, themes, fonts, density, editor zoom, data formats and
 * paging, against SQLite, PostgreSQL and MySQL from the `test/db/compose.yml` databases. Gated,
 * because it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/013 bun run test:smoke:db
 *
 * Playwright's Electron page reports `prefers-color-scheme: light` until a test emulates otherwise,
 * whatever the machine's own scheme, so "Follow system" opens Light here.
 */
import { readdirSync } from "node:fs";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  chooseTheme,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  computedOpacity,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openThemePicker,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  seedTheme,
  setWindowSize,
  sqlEditor,
  themePickerOption,
  themePickerTrigger,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  chooseOption,
  showServices,
} from "./harness.js";

const captureWindow = evidenceFor("013");
const dropdownEvidence = evidenceFor("129");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const DARK_CANVAS = "#1e1f22";
const LIGHT_CANVAS = "#ffffff";
const HIGH_CONTRAST_CANVAS = "#000000";
const USER_CANVAS = "#002b36";
const USER_PANEL = "#073642";

const COMPACT_ROW_PX = 20;
/** The Editor page lists every SQL inspection, so it scrolls inside the dialog. */
const SCROLLING_TAB = "Editor";
const SERIES_ROWS = 5_000;
const SERIES = `SELECT g AS n FROM generate_series(1, ${String(SERIES_ROWS)}) g`;
const SMALL_PAGE = 100;
const PAGE_PROBE_ROWS = 250;
const TABLES_GROUP_WITH_PROBE = "tables 7";
const PAGE_PROBE_SETUP = [
  "DROP TABLE IF EXISTS page_probe",
  "CREATE TABLE page_probe (id int PRIMARY KEY)",
  [
    "INSERT INTO page_probe (id)",
    "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < " + String(PAGE_PROBE_ROWS) + ")",
    "SELECT n FROM g",
  ].join(" "),
] as const;
const PAGE_PROBE_TEARDOWN = ["DROP TABLE IF EXISTS page_probe"] as const;

const HIGHLIGHTED_SQL = "SELECT id, name, 'literal' AS kind, 42 AS answer FROM customers -- a comment";
const ZOOM_SQL = "SELECT id, name FROM customers WHERE id > 1";
const ZOOMED_EDITOR_PX = 15;
const DEFAULT_EDITOR_PX = 13;
const DEFAULT_GRID_PX = 12;
const CHOSEN_EDITOR_PX = 16;
/** Installed on every macOS; the scenario falls back to the first monospace family elsewhere. */
const PREFERRED_MONOSPACE = "Courier New";
const NULL_SYMBOL = "∅";

async function asOwner(plugin: DatasourcePlugin, config: unknown, statements: readonly string[]): Promise<void> {
  const session = await plugin.connect(config, { readOnly: false });
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) {
        // Drained so the statement completes before the next.
      }
    }
  } finally {
    await session.close();
  }
}

/**
 * The few DOM members these checks read inside the page. The root program has no DOM lib, so the
 * page functions name their element's shape themselves.
 */
interface Box {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

interface Style {
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly backgroundColor: string;
  readonly colorScheme: string;
  getPropertyValue(name: string): string;
}

interface Styled {
  readonly parentElement: Styled | null;
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Styled): Style;
      readonly innerWidth: number;
      readonly innerHeight: number;
    };
  };
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function settingsTab(page: Page, name: string) {
  return settingsDialog(page).getByRole("tablist", { name: "Settings pages" }).getByRole("tab", { name, exact: true });
}

async function openSettings(page: Page, tab = "Appearance"): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).waitFor();
  await settingsTab(page, tab).click();
  await expect.poll(() => settingsTab(page, tab).getAttribute("aria-selected")).toBe("true");
}

async function closeSettings(page: Page): Promise<void> {
  await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settingsDialog(page).count()).toBe(0);
}

/** Replaces a settings field's text; the dialog saves each valid keystroke. */
async function fillSetting(page: Page, label: string, value: string): Promise<void> {
  const field = settingsDialog(page).getByLabel(label, { exact: true });
  await field.fill(value);
  await expect.poll(() => field.getAttribute("aria-invalid")).toBe("false");
}

/** Waits out the run's statement flash, so a capture shows the theme's own editor background. */
async function flashGone(page: Page): Promise<void> {
  await expect.poll(() => page.locator(".tc-statement-flash").count()).toBe(0);
}

/** Waits until the font lists are filled, so a capture shows the dialog as the user sees it. */
async function fontsListed(page: Page): Promise<void> {
  await expect
    .poll(() => settingsDialog(page).getByText("Listing fonts…").count(), { timeout: LAUNCH_TIMEOUT_MS })
    .toBe(0);
}

async function cssVariable(page: Page, name: string): Promise<string> {
  return page
    .locator("html")
    .evaluate(
      (element: Styled, variable) =>
        element.ownerDocument.defaultView.getComputedStyle(element).getPropertyValue(variable).trim(),
      name,
    );
}

async function colorScheme(page: Page): Promise<string> {
  return page
    .locator("html")
    .evaluate((element: Styled) => element.ownerDocument.defaultView.getComputedStyle(element).colorScheme);
}

function canvas(page: Page): Promise<string> {
  return cssVariable(page, "--tc-canvas");
}

/** The colour painted behind `locator`: its own background, or its nearest ancestor's that has one. */
async function backgroundOf(locator: Locator): Promise<string> {
  return locator.first().evaluate((element: Styled) => {
    const transparent = "rgba(0, 0, 0, 0)";
    for (let current: Styled | null = element; current !== null; current = current.parentElement) {
      const colour = current.ownerDocument.defaultView.getComputedStyle(current).backgroundColor;
      if (colour !== transparent) return colour;
    }
    return transparent;
  });
}

async function fontOf(page: Page, selector: string): Promise<{ family: string; size: string }> {
  return page
    .locator(selector)
    .first()
    .evaluate((element: Styled) => {
      const style = element.ownerDocument.defaultView.getComputedStyle(element);
      return { family: style.fontFamily, size: style.fontSize };
    });
}

/** The saved `settings.json`, or null when there is none. */
function savedSettings(
  userDataDir: string,
): { appearance: Record<string, unknown>; data: Record<string, unknown> } | null {
  const text = readProfileFile(userDataDir, "settings.json");
  return text === null
    ? null
    : (JSON.parse(text) as { appearance: Record<string, unknown>; data: Record<string, unknown> });
}

async function windowBackground(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor() ?? "");
}

/** Clicks the native menu's Settings… item, wherever this platform puts it. */
async function clickMenuSettings(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? []) ?? [];
    const settings = items.find((item) => item.label === "Settings…");
    if (settings === undefined) throw new Error("The application menu has no Settings… item.");
    (settings.click as () => void)();
  });
}

function grid(page: Page) {
  return page.getByRole("grid");
}

function cell(page: Page, row: number, column: number) {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

function toolbarButton(page: Page, name: string) {
  return page.getByRole("toolbar", { name: "Result" }).getByRole("button", { name, exact: true });
}

function resultState(page: Page) {
  return page.getByTestId("result-state");
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

/** Whether the dialog lies wholly inside the window, so nothing of it is cut off at 1200×800. */
async function dialogInsideWindow(page: Page): Promise<boolean> {
  const box = await settingsDialog(page).boundingBox();
  const viewport = await page.locator("html").evaluate((element: Styled) => ({
    width: element.ownerDocument.defaultView.innerWidth,
    height: element.ownerDocument.defaultView.innerHeight,
  }));
  return (
    box !== null &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height
  );
}

/** Whether the open page fits its panel without scrolling. */
async function pageFits(page: Page): Promise<boolean> {
  return settingsDialog(page)
    .getByRole("tabpanel")
    .evaluate((element: Box) => element.scrollHeight <= element.clientHeight);
}

describe.runIf(DATABASES_ENABLED)("settings and appearance live test", () => {
  let running: RunningApp | null = null;

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(async () => {
    await closeRunning();
    await asOwner(mysql, MYSQL_CONFIG, PAGE_PROBE_TEARDOWN);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, userDataDir?: string): Promise<RunningApp> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenConsole_whenModCommaThenAppMenu_thenSettingsOpensOnAppearance",
    async () => {
      const { app, page } = await launch(sqlite());

      await pressChord(page, ",");
      await settingsDialog(page).waitFor();
      expect(await settingsTab(page, "Appearance").getAttribute("aria-selected")).toBe("true");
      for (const tab of ["Editor", "Data Editor", "Appearance"]) {
        await settingsTab(page, tab).click();
        expect(await dialogInsideWindow(page)).toBe(true);
        if (tab !== SCROLLING_TAB) expect({ tab, fits: await pageFits(page) }).toEqual({ tab, fits: true });
      }
      await closeSettings(page);

      await clickMenuSettings(app);
      await settingsDialog(page).waitFor();
      expect(await settingsTab(page, "Appearance").getAttribute("aria-selected")).toBe("true");
      await fontsListed(page);
      await captureWindow(page, "settings-appearance");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenExplorerConsoleGridAndServices_whenLightChosen_thenAllRestyleAndFileSaysLight",
    async () => {
      const { page, userDataDir } = await launch(sqlite());
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => canvas(page)).toBe(DARK_CANVAS);
      await runStatement(page, "SELECT * FROM customers ORDER BY id");
      await showServices(page);
      const surfaces = [
        toolWindow(page, "Database").getByRole("treeitem"),
        page.locator('[data-testid="sql-editor"] .cm-content'),
        cell(page, 0, 1),
        toolWindow(page, "Services").getByRole("treeitem"),
      ];
      const before = await Promise.all(surfaces.map(backgroundOf));

      await openSettings(page);
      await chooseTheme(page, "Light");
      await expect.poll(() => canvas(page)).toBe(LIGHT_CANVAS);
      await closeSettings(page);

      const after = await Promise.all(surfaces.map(backgroundOf));
      for (const [index, colour] of after.entries()) expect(colour).not.toBe(before[index]);
      expect(await colorScheme(page)).toBe("light");
      expect(savedSettings(userDataDir)?.appearance["theme"]).toBe("light");
      await flashGone(page);
      await captureWindow(page, "theme-light");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenQueryResultAndHighlightedConsole_whenHighContrastChosen_thenBlackCanvasWhiteInk",
    async () => {
      const { page, userDataDir } = await launch(sqlite());
      await runStatement(page, HIGHLIGHTED_SQL);

      await openSettings(page);
      await chooseTheme(page, "High contrast");
      await closeSettings(page);

      await expect.poll(() => canvas(page)).toBe(HIGH_CONTRAST_CANVAS);
      expect(await cssVariable(page, "--tc-ink")).toBe("#ffffff");
      expect(await colorScheme(page)).toBe("dark");
      expect(savedSettings(userDataDir)?.appearance["theme"]).toBe("highContrast");
      await sqlEditor(page).click();
      await flashGone(page);
      await captureWindow(page, "theme-high-contrast");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFollowSystem_whenPageEmulatesLightThenDarkThenMoreContrast_thenAppFollowsWithoutReopening",
    async () => {
      const { page } = await launch(sqlite());
      await runStatement(page, "SELECT * FROM customers ORDER BY id");
      await openSettings(page);
      expect(await themePickerTrigger(page).getAttribute("aria-label")).toBe("Theme: Follow system");
      await closeSettings(page);

      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => canvas(page)).toBe(LIGHT_CANVAS);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => canvas(page)).toBe(DARK_CANVAS);
      await page.emulateMedia({ contrast: "more" });
      await expect.poll(() => canvas(page)).toBe(HIGH_CONTRAST_CANVAS);
      await page.emulateMedia({ contrast: "no-preference" });
      await expect.poll(() => canvas(page)).toBe(DARK_CANVAS);
      await flashGone(page);
      await captureWindow(page, "theme-system");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenValidAndInvalidUserThemes_whenListed_thenValidAppliesAndInvalidShowsErrorsUnchoosable",
    async () => {
      const userDataDir = newProfile();
      seedTheme(userDataDir, "solarized", {
        name: "My Solarized",
        base: "dark",
        colors: { canvas: USER_CANVAS, panel: USER_PANEL },
      });
      seedTheme(userDataDir, "broken", { name: "Broken", base: "sepia", colors: { canvass: "#fff" } });
      const { page } = await launch(sqlite(), userDataDir);
      await runStatement(page, "SELECT * FROM customers ORDER BY id");

      await openSettings(page);
      const before = await canvas(page);
      await openThemePicker(page);
      const broken = themePickerOption(page, "broken.json");
      expect(await broken.getAttribute("aria-disabled")).toBe("true");
      expect(await broken.textContent()).toContain("2 errors");
      await broken.hover();
      const errors = await page.getByRole("list", { name: "Errors in broken.json" }).textContent();
      expect(errors).toContain("sepia");
      expect(errors).toContain("canvass");
      await broken.click({ force: true });
      expect(await broken.getAttribute("aria-checked")).toBe("false");
      expect(await canvas(page)).toBe(before);

      await chooseTheme(page, "My Solarized");
      await expect.poll(() => canvas(page)).toBe(USER_CANVAS);
      expect(await cssVariable(page, "--tc-panel")).toBe(USER_PANEL);
      expect(await cssVariable(page, "--tc-ink")).toBe("#dfe1e5");
      expect(savedSettings(userDataDir)?.appearance["theme"]).toBe("user:solarized");
      await fontsListed(page);
      await flashGone(page);
      await captureWindow(page, "theme-user");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEditorFontPage_whenMonospaceFamilyAndSizeChosen_thenConsoleUsesThemAndGridKeepsItsOwn",
    async () => {
      const { page, userDataDir } = await launch(sqlite());
      await runStatement(page, "SELECT * FROM customers ORDER BY id");

      await openSettings(page, "Editor");
      const family = page.locator('[aria-label="Editor font"]');
      await family.click();
      const list = page.getByRole("listbox");
      await expect.poll(() => list.getByRole("group").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      expect(await list.getByRole("group", { name: "Monospace", exact: true }).count()).toBe(1);
      expect(await list.getByRole("group", { name: "Proportional", exact: true }).count()).toBe(1);
      const monospace = await list
        .getByRole("group", { name: "Monospace", exact: true })
        .getByRole("option")
        .allTextContents();
      const chosen = monospace.includes(PREFERRED_MONOSPACE) ? PREFERRED_MONOSPACE : (monospace[0] ?? "");
      expect(chosen).not.toBe("");
      await expect.poll(() => computedOpacity(list)).toBe("1");
      await dropdownEvidence(page, "04-settings-font");
      await chooseOption(family, { label: chosen });
      await fillSetting(page, "Size", String(CHOSEN_EDITOR_PX));
      await closeSettings(page);

      const editor = await fontOf(page, '[data-testid="sql-editor"] .cm-content');
      expect(editor.family).toContain(chosen);
      expect(editor.size).toBe(`${String(CHOSEN_EDITOR_PX)}px`);
      const gridFont = await fontOf(page, '[role="gridcell"][data-row="0"][data-col="0"]');
      expect(gridFont.family).not.toContain(chosen);
      expect(gridFont.size).toBe(`${String(DEFAULT_GRID_PX)}px`);
      expect(savedSettings(userDataDir)?.appearance["fonts"]).toMatchObject({
        editor: { family: chosen, sizePx: CHOSEN_EDITOR_PX },
      });
      await flashGone(page);
      await captureWindow(page, "fonts");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenCompactDensity_whenFiveThousandRowsScrolledToEnd_thenRowsAreTwentyPixelsAndLastRowLinesUp",
    async () => {
      const { page } = await launch(POSTGRES);
      await openSettings(page);
      await settingsDialog(page).getByRole("radio", { name: "Compact", exact: true }).check();
      await expect.poll(() => cssVariable(page, "--tc-row-height")).toBe(`${String(COMPACT_ROW_PX)}px`);
      await closeSettings(page);

      await runStatement(page, SERIES);
      await toolbarButton(page, "Fetch All").click();
      await expect
        .poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`${SERIES_ROWS.toLocaleString("en-US")} rows`);
      await grid(page).evaluate((element: Box) => {
        element.scrollTop = element.scrollHeight;
      });
      const last = cell(page, SERIES_ROWS - 1, 0);
      await expect.poll(() => last.textContent()).toBe(String(SERIES_ROWS));
      const [lastBox, previousBox, gridBox] = await Promise.all([
        last.boundingBox(),
        cell(page, SERIES_ROWS - 2, 0).boundingBox(),
        grid(page).boundingBox(),
      ]);
      if (lastBox === null || previousBox === null || gridBox === null)
        throw new Error("The last rows are not on screen.");
      expect(lastBox.height).toBe(COMPACT_ROW_PX);
      expect(lastBox.y - previousBox.y).toBe(COMPACT_ROW_PX);
      const gridBottom = gridBox.y + gridBox.height;
      const lastBottom = lastBox.y + lastBox.height;
      expect(lastBottom).toBeLessThanOrEqual(gridBottom + 1);
      expect(gridBottom - lastBottom).toBeLessThan(COMPACT_ROW_PX);
      const treeRow = await toolWindow(page, "Database").getByRole("treeitem").first().boundingBox();
      expect(treeRow?.height).toBe(COMPACT_ROW_PX);
      await flashGone(page);
      await captureWindow(page, "density-compact");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenConsole_whenModEqualTwiceMinusOnceZero_thenEditorGrowsShrinksResetsAndTreeStillCollapses",
    async () => {
      const { page, userDataDir } = await launch(sqlite());
      const editorSize = async () => (await fontOf(page, '[data-testid="sql-editor"] .cm-content')).size;
      await sqlEditor(page).fill(ZOOM_SQL);
      expect(await editorSize()).toBe(`${String(DEFAULT_EDITOR_PX)}px`);

      await pressChord(page, "Equal");
      await pressChord(page, "Equal");
      await expect.poll(editorSize).toBe(`${String(ZOOMED_EDITOR_PX)}px`);
      await expect
        .poll(() => savedSettings(userDataDir)?.appearance["fonts"])
        .toMatchObject({
          editor: { sizePx: ZOOMED_EDITOR_PX },
        });
      await captureWindow(page, "editor-zoom");
      await pressChord(page, "Minus");
      await expect.poll(editorSize).toBe(`${String(ZOOMED_EDITOR_PX - 1)}px`);
      await pressChord(page, "Digit0");
      await expect.poll(editorSize).toBe(`${String(DEFAULT_EDITOR_PX)}px`);

      const tree = toolWindow(page, "Database");
      const expanded = tree.locator('[role="treeitem"][aria-expanded="true"]');
      await expect.poll(() => expanded.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThan(0);
      await tree.getByRole("treeitem").first().click();
      await pressChord(page, "Minus");
      await expect.poll(() => expanded.count()).toBe(0);
      expect(await editorSize()).toBe(`${String(DEFAULT_EDITOR_PX)}px`);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenNullSymbolAndGrouping_whenQueried_thenGridShowsThemAndCopyKeepsRawText",
    async () => {
      const { app, page } = await launch(POSTGRES);
      await openSettings(page, "Data Editor");
      await fillSetting(page, "NULL text", NULL_SYMBOL);
      await settingsDialog(page)
        .getByRole("checkbox", { name: /Group digits/ })
        .check();
      await closeSettings(page);

      await runStatement(page, "SELECT 1234567 AS n, NULL::text AS v, -1234.5 AS d");
      await expect.poll(() => cell(page, 0, 0).textContent()).toBe("1,234,567");
      expect(await cell(page, 0, 1).textContent()).toBe(NULL_SYMBOL);
      expect(await cell(page, 0, 2).textContent()).toBe("-1,234.5");

      await cell(page, 0, 0).click();
      await cell(page, 0, 2).click({ modifiers: ["Shift"] });
      await pressChord(page, "C");
      await expect.poll(() => clipboardText(app)).toBe("n,v,d\n1234567,,-1234.5\n");
      await flashGone(page);
      await captureWindow(page, "data-formats");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPageSizeHundred_whenQueriedAndFetchedAndTableOpened_thenPagesHoldHundred",
    async () => {
      await asOwner(mysql, MYSQL_CONFIG, PAGE_PROBE_SETUP);
      const userDataDir = newProfile();
      const { page } = await launch(POSTGRES, userDataDir);
      await openSettings(page, "Data Editor");
      await fillSetting(page, "Page size", String(SMALL_PAGE));
      await closeSettings(page);

      await runStatement(page, SERIES);
      await expect.poll(() => resultState(page).textContent()).toBe(`${String(SMALL_PAGE)}+ rows`);
      await toolbarButton(page, "Fetch Next Page").click();
      await expect.poll(() => resultState(page).textContent()).toBe(`${String(SMALL_PAGE * 2)}+ rows`);
      await closeRunning();

      const mysqlPage = (await launch(MYSQL, userDataDir)).page;
      const tree = toolWindow(mysqlPage, "Database");
      const group = tree.getByRole("treeitem", { name: TABLES_GROUP_WITH_PROBE, exact: true });
      await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      if ((await group.getAttribute("aria-expanded")) !== "true") {
        await group.click();
        await mysqlPage.keyboard.press("ArrowRight");
      }
      await tree.getByRole("treeitem", { name: "page_probe", exact: true }).click();
      await mysqlPage.keyboard.press("F4");
      await expect.poll(() => activeEditorTab(mysqlPage).textContent()).toContain("page_probe");
      const editor = mysqlPage.getByTestId("table-editor");
      await expect
        .poll(() => editor.getByTestId("result-state").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`${String(SMALL_PAGE)}+ rows`);
      await captureWindow(mysqlPage, "page-size");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenChangedSettings_whenRelaunched_thenThemeFontsDensityAndFormatsKeptFromTheFirstFrame",
    async () => {
      const userDataDir = newProfile();
      const first = await launch(sqlite(), userDataDir);
      await openSettings(first.page);
      await chooseTheme(first.page, "Light");
      await first.page.getByRole("radio", { name: "Compact", exact: true }).check();
      await settingsTab(first.page, "Editor").click();
      await fillSetting(first.page, "Size", String(CHOSEN_EDITOR_PX));
      await settingsTab(first.page, "Data Editor").click();
      await fillSetting(first.page, "NULL text", NULL_SYMBOL);
      await closeSettings(first.page);
      await expect.poll(() => savedSettings(userDataDir)?.data["nullText"]).toBe(NULL_SYMBOL);
      await closeRunning();

      const { app, page } = await launch(sqlite(), userDataDir);
      expect(await windowBackground(app)).toBe(LIGHT_CANVAS.toUpperCase());
      await page.emulateMedia({ colorScheme: "dark" });
      expect(await canvas(page)).toBe(LIGHT_CANVAS);
      expect(await cssVariable(page, "--tc-row-height")).toBe(`${String(COMPACT_ROW_PX)}px`);
      expect((await fontOf(page, '[data-testid="sql-editor"] .cm-content')).size).toBe(`${String(CHOSEN_EDITOR_PX)}px`);
      await runStatement(page, "SELECT NULL AS missing");
      await expect.poll(() => cell(page, 0, 0).textContent()).toBe(NULL_SYMBOL);
      await flashGone(page);
      await captureWindow(page, "settings-persist");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenCorruptSettingsFile_whenLaunched_thenSetAsideWithNoticeAndDefaults",
    async () => {
      const userDataDir = newProfile();
      seedSettings(userDataDir, '{"version": 1, "appearance": ');
      const { page } = await launch(sqlite(), userDataDir);

      const notice = page.getByTestId("settings-notice");
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await notice.textContent()).toContain("settings.json could not be read");
      const message = await notice.getByText("settings.json could not be read").boundingBox();
      const dismiss = await notice.getByRole("button", { name: "Dismiss" }).boundingBox();
      expect(dismiss?.y).toBeGreaterThanOrEqual((message?.y ?? 0) + (message?.height ?? 0));
      const asideFiles = readdirSync(userDataDir).filter((name) => /^settings\.json\.corrupt-\d+$/.test(name));
      expect(asideFiles).toHaveLength(1);
      expect(readProfileFile(userDataDir, "settings.json")).toBeNull();
      expect(await canvas(page)).toBe(LIGHT_CANVAS);
      expect(await cssVariable(page, "--tc-row-height")).toBe("24px");
      await captureWindow(page, "settings-corrupt");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
