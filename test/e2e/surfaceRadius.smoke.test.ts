/**
 * Plan 144's live test: dialogs and the palette round like the islands, menus, popovers and the SQL
 * completion list round to one popover radius with their rows nested inside, tooltips stay tight,
 * and Classic keeps its radii. SQLite only (the seeded file for completion), so it needs only a
 * display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/144 bun run test:smoke:headless test/e2e/surfaceRadius.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLASSIC_DIALOG_RADIUS_PX,
  CLASSIC_POPOVER_RADIUS_PX,
  COMFORTABLE_DENSITY,
  COMPACT_DENSITY,
  ISLANDS_POPOVER_RADIUS_PX,
  TOOLTIP_RADIUS_PX,
} from "@table-craft/desktop/appearance/themes.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  cornerRadius,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openThemePicker,
  paletteInput,
  pressChord,
  pressDoubleShift,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";

const captureWindow = evidenceFor("144");
const COMPLETION = ".cm-tooltip-autocomplete";
const COMPLETION_SQL = "SELECT * FROM ";
const SEEDED_SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
const TOOLTIP_SURFACE = ".rounded-tooltip";
const NEW_CONSOLE = "New Console";

/** The few DOM members the evaluation touches; the e2e program is compiled without the DOM lib. */
interface Padded {
  readonly ownerDocument: {
    readonly defaultView: { getComputedStyle(element: Padded): { readonly paddingTop: string } };
  };
}

function px(value: number): string {
  return `${String(value)}px`;
}

async function paddingOf(locator: Locator): Promise<string> {
  return locator.evaluate((element: Padded) => element.ownerDocument.defaultView.getComputedStyle(element).paddingTop);
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function palette(page: Page) {
  return page.getByRole("dialog").filter({ has: paletteInput(page, "Search Everywhere") });
}

function databaseToolbarButton(page: Page, name: string): Locator {
  return page
    .getByRole("toolbar", { name: "Database toolbar", exact: true })
    .getByRole("button", { name, exact: true });
}

describe.runIf(SMOKE_ENABLED)("floating surface radius live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(appearance: object, datasource?: Datasource): Promise<Page> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, appearance });
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  async function openSettings(page: Page): Promise<Locator> {
    await pressChord(page, ",");
    await settingsDialog(page).waitFor();
    await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
    return settingsDialog(page);
  }

  async function openExplorerMenu(page: Page): Promise<Locator> {
    await toolWindow(page, "Database").getByRole("treeitem").first().click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor();
    return menu;
  }

  it(
    "givenIslands_whenSettingsOpens_thenDialogRoundsLikeTheIslands",
    async () => {
      const page = await launch({ theme: "dark" });
      const dialog = await openSettings(page);

      await expect.poll(() => cornerRadius(dialog)).toBe(px(COMFORTABLE_DENSITY.islandRadiusPx));
      await captureWindow(page, "01-settings-comfortable");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCompactIslands_whenSettingsOpens_thenDialogRoundsLikeTheIslands",
    async () => {
      const page = await launch({ theme: "dark", density: "compact" });
      const dialog = await openSettings(page);

      await expect.poll(() => cornerRadius(dialog)).toBe(px(COMPACT_DENSITY.islandRadiusPx));
      await captureWindow(page, "02-settings-compact");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIslands_whenPaletteOpens_thenPaletteRoundsLikeTheIslands",
    async () => {
      const page = await launch({ theme: "dark" });
      await pressDoubleShift(page);
      await paletteInput(page, "Search Everywhere").fill("se");

      await expect.poll(() => cornerRadius(palette(page))).toBe(px(COMFORTABLE_DENSITY.islandRadiusPx));
      await captureWindow(page, "03-palette");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIslands_whenExplorerMenuOpens_thenMenuRoundsEightAndRowsNestInside",
    async () => {
      const page = await launch({ theme: "dark" });
      const menu = await openExplorerMenu(page);
      const row = menu.getByRole("menuitem").first();
      await row.hover();

      await expect.poll(() => cornerRadius(menu)).toBe(px(ISLANDS_POPOVER_RADIUS_PX));
      const inset = Number.parseFloat(await paddingOf(menu));
      const rowRadius = Number.parseFloat(await cornerRadius(row));
      expect(inset + rowRadius).toBe(ISLANDS_POPOVER_RADIUS_PX);
      await captureWindow(page, "04-context-menu");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIslands_whenCompletionOpens_thenItRoundsLikeTheEditorMenu",
    async () => {
      const page = await launch({ theme: "dark" }, SEEDED_SQLITE);
      await sqlEditor(page).fill(COMPLETION_SQL);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Control+Space");
      const completion = page.locator(COMPLETION);
      await completion.getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await expect.poll(() => cornerRadius(completion)).toBe(px(ISLANDS_POPOVER_RADIUS_PX));
      await captureWindow(page, "05-completion");

      await page.keyboard.press("Escape");
      await sqlEditor(page).click({ button: "right" });
      const menu = page.getByRole("menu");
      await menu.waitFor();
      expect(await cornerRadius(menu)).toBe(px(ISLANDS_POPOVER_RADIUS_PX));
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIslands_whenThemePickerOpens_thenPopoverRoundsEight",
    async () => {
      const page = await launch({ theme: "dark" });
      const dialog = await openSettings(page);
      await openThemePicker(page);

      await expect.poll(() => cornerRadius(page.getByTestId("theme-picker"))).toBe(px(ISLANDS_POPOVER_RADIUS_PX));
      expect(await cornerRadius(dialog)).toBe(px(COMFORTABLE_DENSITY.islandRadiusPx));
      await captureWindow(page, "06-theme-popover");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIslands_whenTooltipShows_thenTooltipRoundsFour",
    async () => {
      const page = await launch({ theme: "dark" });
      await databaseToolbarButton(page, NEW_CONSOLE).hover();
      const tooltip = page.locator(TOOLTIP_SURFACE).first();
      await tooltip.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await expect.poll(() => cornerRadius(tooltip)).toBe(px(TOOLTIP_RADIUS_PX));
      await captureWindow(page, "07-tooltip");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenClassic_whenSettingsAndMenuOpen_thenRadiiAreClassic",
    async () => {
      const page = await launch({ theme: "dark", windowStyle: "classic" });
      const menu = await openExplorerMenu(page);

      await expect.poll(() => cornerRadius(menu)).toBe(px(CLASSIC_POPOVER_RADIUS_PX));
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      const dialog = await openSettings(page);
      await expect.poll(() => cornerRadius(dialog)).toBe(px(CLASSIC_DIALOG_RADIUS_PX));
      await captureWindow(page, "08-classic");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLightIslands_whenThemePickerOpensInSettings_thenLadderHolds",
    async () => {
      const page = await launch({ theme: "light" });
      const dialog = await openSettings(page);
      await openThemePicker(page);

      await expect.poll(() => cornerRadius(dialog)).toBe(px(COMFORTABLE_DENSITY.islandRadiusPx));
      expect(await cornerRadius(page.getByTestId("theme-picker"))).toBe(px(ISLANDS_POPOVER_RADIUS_PX));
      await captureWindow(page, "09-light");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
