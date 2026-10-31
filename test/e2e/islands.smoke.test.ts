/**
 * Plan 132's live test: the editor and the tool windows drawn as islands on the window frame, in a
 * dark, a light and a ported theme and at both densities, and Window style switching to Classic
 * and back live; then the audit's fixes: an edge where a ported frame is capped, a coloured
 * console's square tint frame, the gutters' hover and focus bar, and inward focus rings. SQLite in memory, so it needs only a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/132 bun run test:smoke:headless test/e2e/islands.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbar,
  newProfile,
  openConsoleOn,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  showServices,
  SMOKE_ENABLED,
  setWindowSize,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("132");

/** `frameColors` of the built-in Dark and Light themes. */
const DARK_FRAME = "rgb(45, 47, 50)";
const LIGHT_FRAME = "rgb(232, 233, 235)";
const DARK_CANVAS = "rgb(30, 31, 34)";
const DARK_PANEL = "rgb(43, 45, 48)";
const COMFORTABLE_RADIUS = "10px";
const COMPACT_RADIUS = "8px";
const ISLAND = "xpath=ancestor::div[contains(@class, 'rounded-island')][1]";
const SAMPLE_QUERY = "SELECT 1 AS id, 'islands' AS style";
const PORTED_THEME = "jetbrains-dark";
/** Ported palettes whose frame stops short of 1.20:1 to keep their muted text readable. */
const CAPPED_THEMES = [
  { theme: "dracula-dark", evidence: "07-islands-capped-dark" },
  { theme: "tokyonight-light", evidence: "08-islands-capped-light" },
] as const;
const TINTED = "Tinted";
const TINT_FRAME = ".border-ds-red";
const GUTTER = "[role=separator].w-island-gap";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

/** The few DOM members the evaluations touch; the e2e program is compiled without the DOM lib. */
interface Styled {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(
        element: Styled,
        pseudo?: string,
      ): {
        readonly backgroundColor: string;
        readonly borderTopLeftRadius: string;
        readonly borderBottomLeftRadius: string;
        readonly borderBottomWidth: string;
        readonly borderTopColor: string;
        readonly borderTopWidth: string;
        readonly outlineStyle: string;
        readonly outlineOffset: string;
        getPropertyValue(name: string): string;
      };
    };
  };
}

interface Look {
  readonly background: string;
  readonly radius: string;
  readonly bottomEdge: string;
}

async function lookOf(locator: Locator): Promise<Look> {
  return locator.evaluate((element: Styled) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      background: style.backgroundColor,
      radius: style.borderTopLeftRadius,
      bottomEdge: style.borderBottomWidth,
    };
  });
}

async function styleOf(
  locator: Locator,
  property: "borderTopColor" | "borderTopWidth" | "borderBottomLeftRadius" | "outlineStyle" | "outlineOffset",
): Promise<string> {
  return locator.evaluate(
    (element: Styled, name) => element.ownerDocument.defaultView.getComputedStyle(element)[name],
    property,
  );
}

async function barOf(locator: Locator): Promise<string> {
  return locator.evaluate(
    (element: Styled) => element.ownerDocument.defaultView.getComputedStyle(element, "::after").backgroundColor,
  );
}

/** A colour variable as the browser resolves it, `rgb(…)`, read off a probe element's background. */
async function resolvedColor(page: Page, variable: string): Promise<string> {
  return page.locator("html").evaluate((element: Styled & { style: { backgroundColor: string } }, name) => {
    const before = element.style.backgroundColor;
    element.style.backgroundColor = `var(${name})`;
    const value = element.ownerDocument.defaultView.getComputedStyle(element).backgroundColor;
    element.style.backgroundColor = before;
    return value;
  }, variable);
}

async function rootVariable(page: Page, name: string): Promise<string> {
  return page
    .locator("html")
    .evaluate(
      (element: Styled, variable) =>
        element.ownerDocument.defaultView.getComputedStyle(element).getPropertyValue(variable).trim(),
      name,
    );
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function windowStyleChoice(page: Page, label: string) {
  return settingsDialog(page)
    .getByRole("radiogroup", { name: "Window style", exact: true })
    .getByRole("radio", { name: label, exact: true });
}

describe.runIf(SMOKE_ENABLED)("islands live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  });

  async function launch(appearance?: object): Promise<RunningApp> {
    const userDataDir = newProfile();
    if (appearance !== undefined) seedSettings(userDataDir, { version: 1, appearance });
    running = await launchApp(undefined, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  /** Runs a query and opens Services, so every island the default layout has is on screen. */
  async function fillWindow(page: Page): Promise<void> {
    await sqlEditor(page).fill(SAMPLE_QUERY);
    await sqlEditor(page).press("Escape");
    await runAllButton(page).click();
    await waitUntilReady(page);
    await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await showServices(page);
  }

  it(
    "givenDefaultSettings_whenWindowOpens_thenToolWindowsAreIslandsOnTheFrame",
    async () => {
      const { page } = await launch({ theme: "dark" });
      await fillWindow(page);

      expect((await lookOf(mainToolbar(page))).background).toBe(DARK_FRAME);
      expect((await lookOf(mainToolbar(page))).bottomEdge).toBe("0px");
      for (const title of ["Database", "Services"]) {
        const island = await lookOf(toolWindow(page, title).locator(ISLAND));
        expect(island).toMatchObject({ background: DARK_CANVAS, radius: COMFORTABLE_RADIUS });
      }
      expect((await lookOf(toolWindow(page, "Database"))).background).toBe(DARK_CANVAS);
      await captureWindow(page, "01-islands-dark");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLightTheme_whenWindowOpens_thenFrameIsDarkerThanIslands",
    async () => {
      const { page } = await launch({ theme: "light" });
      await fillWindow(page);

      expect((await lookOf(mainToolbar(page))).background).toBe(LIGHT_FRAME);
      await captureWindow(page, "02-islands-light");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCompactDensity_whenWindowOpens_thenIslandsTighten",
    async () => {
      const { page } = await launch({ theme: "dark", density: "compact" });
      await fillWindow(page);

      expect(await rootVariable(page, "--tc-island-gap")).toBe("4px");
      expect((await lookOf(toolWindow(page, "Database").locator(ISLAND))).radius).toBe(COMPACT_RADIUS);
      await captureWindow(page, "03-islands-compact");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPortedTheme_whenWindowOpens_thenFrameDerivedFromItsPalette",
    async () => {
      const { page } = await launch({ theme: PORTED_THEME });
      await fillWindow(page);

      const frame = await rootVariable(page, "--tc-frame");
      expect(frame).not.toBe(await rootVariable(page, "--tc-canvas"));
      await captureWindow(page, "04-islands-ported");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIslands_whenClassicChosenInSettings_thenFlatPanesReturnLive",
    async () => {
      const { page } = await launch({ theme: "dark" });
      await fillWindow(page);
      await pressChord(page, ",");
      await settingsDialog(page).waitFor();
      await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
      await expect.poll(() => windowStyleChoice(page, "Islands").isChecked()).toBe(true);
      await captureWindow(page, "05-settings-window-style");

      await windowStyleChoice(page, "Classic").check();
      await expect.poll(() => rootVariable(page, "--tc-island-radius")).toBe("0px");
      await page.keyboard.press("Escape");
      await settingsDialog(page).waitFor({ state: "detached" });
      expect(await toolWindow(page, "Database").locator(ISLAND).count()).toBe(0);
      expect(await lookOf(mainToolbar(page))).toMatchObject({ background: DARK_PANEL, bottomEdge: "1px" });
      await captureWindow(page, "06-classic");

      await pressChord(page, ",");
      await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
      await windowStyleChoice(page, "Islands").check();
      await expect.poll(() => rootVariable(page, "--tc-island-radius")).toBe(COMFORTABLE_RADIUS);
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const { theme, evidence } of CAPPED_THEMES) {
    it(
      `givenCappedFrame_${theme}_whenWindowOpens_thenIslandsDrawTheBorder`,
      async () => {
        const { page } = await launch({ theme });
        await fillWindow(page);

        const island = toolWindow(page, "Database").locator(ISLAND);
        expect(await styleOf(island, "borderTopWidth")).toBe("1px");
        expect(await styleOf(island, "borderTopColor")).toBe(await resolvedColor(page, "--tc-border"));
        await captureWindow(page, evidence);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "givenBuiltInDark_whenWindowOpens_thenIslandEdgeIsItsOwnColour",
    async () => {
      const { page } = await launch({ theme: "dark" });

      const island = toolWindow(page, "Database").locator(ISLAND);
      expect(await styleOf(island, "borderTopColor")).toBe(DARK_CANVAS);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenColouredDatasource_whenConsoleOpens_thenTintFrameStaysSquareAboveResults",
    async () => {
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, appearance: { theme: "dark" } });
      seedDatasources(userDataDir, [
        { id: "tinted", name: TINTED, pluginId: "sqlite", color: "red", config: { path: ":memory:" } },
      ]);
      running = await launchApp(null, { userDataDir });
      const { page } = running;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await openConsoleOn(page, TINTED);
      await waitUntilReady(page);
      await fillWindow(page);

      expect(await styleOf(page.locator(TINT_FRAME).first(), "borderBottomLeftRadius")).toBe("0px");
      await captureWindow(page, "09-tinted-console");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenGutter_whenHoveredThenFocusedFromKeyboard_thenCentredBarShows",
    async () => {
      const { page } = await launch({ theme: "dark" });
      await fillWindow(page);
      const gutter = page.locator(GUTTER).first();

      expect(await barOf(gutter)).toBe(TRANSPARENT);
      await gutter.hover();
      await expect.poll(() => barOf(gutter)).not.toBe(TRANSPARENT);
      await captureWindow(page, "10-gutter-hover");

      await page.mouse.move(0, 0);
      await page.keyboard.press("Shift");
      await gutter.focus();
      await expect.poll(() => barOf(gutter)).toBe(await resolvedColor(page, "--tc-accent"));
      await captureWindow(page, "11-gutter-focus");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEditorTab_whenFocusedFromKeyboard_thenRingDrawsInsideTheIsland",
    async () => {
      const { page } = await launch({ theme: "dark" });
      await fillWindow(page);
      const tab = page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab").first();

      await page.keyboard.press("Shift");
      await tab.focus();
      const strip = tab.locator("xpath=..");
      await expect.poll(() => styleOf(strip, "outlineStyle")).toBe("solid");
      expect(await styleOf(strip, "outlineOffset")).toBe("-2px");
      await captureWindow(page, "12-tab-focus");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
