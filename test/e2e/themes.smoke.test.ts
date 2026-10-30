/**
 * Plan 032's live test: the ported themes and the previewing theme dropdown (decisions 064, 065).
 * Gated, because it needs a display and a fresh build; the contact sheet also needs the
 * `test/db/compose.yml` PostgreSQL:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/032 bun run test:smoke:db:headless test/e2e/themes.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { BUNDLED_THEMES, type BundledThemeId } from "@table-craft/desktop/appearance/themes.js";
import { POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  chooseTheme,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  cornerRadius,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  launchApp,
  newProfile,
  openThemePicker,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  SMOKE_ENABLED,
  seedTheme,
  setWindowSize,
  themePickerOption,
  themePickerTrigger,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("032");
const dropdownEvidence = evidenceFor("129");

const SQLITE_QUERY = "SELECT * FROM customers ORDER BY id";
const POSTGRES_QUERY =
  "-- every theme draws the same console\nSELECT c.id, c.name, o.total, o.placed_at, 'paid' AS status, NULL AS note\nFROM customers c JOIN orders o ON o.customer_id = c.id\nWHERE o.total > 0\nORDER BY o.placed_at;";
const NORD_ACCENT_OVERRIDE = "#bf616a";
/** Four dark and four light, chosen to span the palettes: warm, cool, saturated and muted. */
const CONTACT_SHEET: readonly BundledThemeId[] = [
  "dracula-dark",
  "nord-dark",
  "tokyonight-dark",
  "preman-dark",
  "solarized-light",
  "catppuccin-light",
  "jetbrains-light",
  "flexoki-light",
];

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function picker(page: Page) {
  return page.getByTestId("theme-picker");
}

function filterField(page: Page) {
  return picker(page).getByLabel("Filter themes", { exact: true });
}

/** The few DOM members the evaluations touch; the e2e program is compiled without the DOM lib. */
interface Root {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Root): { getPropertyValue(name: string): string; readonly colorScheme: string };
    };
  };
}

async function cssVariable(page: Page, name: string): Promise<string> {
  return page
    .locator("html")
    .evaluate(
      (element: Root, variable) =>
        element.ownerDocument.defaultView.getComputedStyle(element).getPropertyValue(variable).trim(),
      name,
    );
}

async function colorScheme(page: Page): Promise<string> {
  return page
    .locator("html")
    .evaluate((element: Root) => element.ownerDocument.defaultView.getComputedStyle(element).colorScheme);
}

function canvas(page: Page): Promise<string> {
  return cssVariable(page, "--tc-canvas");
}

async function openAppearance(page: Page): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).waitFor();
  await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
  await themePickerTrigger(page).waitFor();
}

async function closeSettings(page: Page): Promise<void> {
  await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settingsDialog(page).count()).toBe(0);
}

async function optionNames(page: Page): Promise<string[]> {
  const options = await picker(page).getByRole("option").all();
  return Promise.all(options.map(async (option) => (await option.getAttribute("aria-label")) ?? ""));
}

async function highlightedName(page: Page): Promise<string | null> {
  return picker(page).locator('[role="option"][aria-selected="true"]').getAttribute("aria-label");
}

function savedTheme(userDataDir: string): unknown {
  const text = readProfileFile(userDataDir, "settings.json");
  return text === null ? undefined : (JSON.parse(text) as { appearance?: { theme?: unknown } }).appearance?.theme;
}

async function flashGone(page: Page): Promise<void> {
  await expect.poll(() => page.locator(".tc-statement-flash").count()).toBe(0);
}

describe.runIf(SMOKE_ENABLED)("ported themes and the theme dropdown live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, userDataDir?: string): Promise<RunningApp> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenAppearancePage_whenPickerFilteredArrowedAndEscaped_thenHighlightPreviewsAndEscapeReverts",
    async () => {
      const { page, userDataDir } = await launch(sqlite());
      await runStatement(page, SQLITE_QUERY);
      const committed = await canvas(page);
      await openAppearance(page);
      expect(await themePickerTrigger(page).getAttribute("aria-label")).toBe("Theme: Follow system");
      await captureWindow(page, "01-closed");

      await openThemePicker(page);
      expect(await themePickerOption(page, "Follow system").getAttribute("aria-checked")).toBe("true");
      expect(await highlightedName(page)).toBe("Follow system");
      expect((await optionNames(page)).length).toBe(1 + Object.keys(BUNDLED_THEMES).length);
      await captureWindow(page, "02-open");

      await filterField(page).fill("kana");
      expect(await optionNames(page)).toEqual(["Kanagawa Dark", "Kanagawa Light"]);
      await expect.poll(() => canvas(page)).toBe(BUNDLED_THEMES["kanagawa-dark"].colors.canvas);
      await captureWindow(page, "03-filter");

      await filterField(page).press("ArrowDown");
      expect(await highlightedName(page)).toBe("Kanagawa Light");
      await expect.poll(() => canvas(page)).toBe(BUNDLED_THEMES["kanagawa-light"].colors.canvas);
      await filterField(page).press("ArrowDown");
      expect(await highlightedName(page)).toBe("Kanagawa Light");
      await captureWindow(page, "04-preview");

      await filterField(page).press("Escape");
      await expect.poll(() => picker(page).count()).toBe(0);
      expect(await settingsDialog(page).count()).toBe(1);
      await expect.poll(() => canvas(page)).toBe(committed);
      expect(await themePickerTrigger(page).getAttribute("aria-label")).toBe("Theme: Follow system");
      expect(savedTheme(userDataDir) ?? "system").toBe("system");
      await captureWindow(page, "05-reverted");

      await openThemePicker(page);
      await filterField(page).fill("gruvbox light");
      await filterField(page).press("Enter");
      await expect.poll(() => picker(page).count()).toBe(0);
      await expect.poll(() => savedTheme(userDataDir)).toBe("gruvbox-light");
      expect(await canvas(page)).toBe(BUNDLED_THEMES["gruvbox-light"].colors.canvas);
      expect(await themePickerTrigger(page).textContent()).toContain("Light");
      const schemeTag = themePickerTrigger(page).getByText("Light", { exact: true });
      expect(await cornerRadius(schemeTag)).toBe("0px");
      await dropdownEvidence(page, "04-settings-theme");
      await closeSettings(page);
      await flashGone(page);
      await captureWindow(page, "06-gruvbox-light");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenPostgresConsoleAndGrid_whenEachContactSheetThemeChosen_thenItsTokensDrawEverySurface",
    async () => {
      const { page } = await launch({ id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG });
      await runStatement(page, POSTGRES_QUERY);

      for (const id of CONTACT_SHEET) {
        const theme = BUNDLED_THEMES[id];
        await openAppearance(page);
        await chooseTheme(page, theme.name);
        await closeSettings(page);
        await expect.poll(() => canvas(page)).toBe(theme.colors.canvas);
        expect(await cssVariable(page, "--tc-ink")).toBe(theme.colors.ink);
        await page.locator('[data-testid="sql-editor"] .cm-content').click();
        await flashGone(page);
        await captureWindow(page, `07-${id}`);
      }
    },
    SCENARIO_TIMEOUT_MS * 3,
  );

  it(
    "givenUserThemesBasedOnNordLightAndOnAMissingBase_whenListed_thenOneAppliesAndTheOtherIsDisabledWithItsErrors",
    async () => {
      const userDataDir = newProfile();
      seedTheme(userDataDir, "frost", { name: "Frost", base: "nord-light", colors: { accent: NORD_ACCENT_OVERRIDE } });
      seedTheme(userDataDir, "broken", { name: "Broken", base: "sepia" });
      const { page } = await launch(sqlite(), userDataDir);
      await runStatement(page, SQLITE_QUERY);
      await openAppearance(page);
      await openThemePicker(page);

      const broken = themePickerOption(page, "broken.json");
      expect(await broken.getAttribute("aria-disabled")).toBe("true");
      expect(await broken.textContent()).toContain("1 error");
      await broken.hover();
      expect(await highlightedName(page)).toBe("broken.json");
      const errors = await page.getByRole("list", { name: "Errors in broken.json" }).textContent();
      expect(errors).toContain('"sepia" is not a bundled theme');
      await captureWindow(page, "08-user-themes");

      await filterField(page).press("Enter");
      expect(await picker(page).count()).toBe(1);
      await themePickerOption(page, "Frost").click();
      await expect.poll(() => savedTheme(userDataDir)).toBe("user:frost");
      expect(await canvas(page)).toBe(BUNDLED_THEMES["nord-light"].colors.canvas);
      expect(await cssVariable(page, "--tc-accent")).toBe(NORD_ACCENT_OVERRIDE);
      expect(await colorScheme(page)).toBe("light");
      await captureWindow(page, "08-user-theme-frost");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPortedThemeChosen_whenRelaunched_thenItIsDrawnFromTheFirstFrame",
    async () => {
      const userDataDir = newProfile();
      const first = await launch(sqlite(), userDataDir);
      await openAppearance(first.page);
      await chooseTheme(first.page, "Tokyonight Light");
      await expect.poll(() => savedTheme(userDataDir)).toBe("tokyonight-light");
      await closeApp(first.app);
      running = null;

      const { page } = await launch(sqlite(), userDataDir);
      expect(await canvas(page)).toBe(BUNDLED_THEMES["tokyonight-light"].colors.canvas);
      await runStatement(page, SQLITE_QUERY);
      await openAppearance(page);
      expect(await themePickerTrigger(page).getAttribute("aria-label")).toBe("Theme: Tokyonight Light");
      await captureWindow(page, "09-relaunch");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
