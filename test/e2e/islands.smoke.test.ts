/**
 * Plan 132's live test: the editor and the tool windows drawn as islands on the window frame, in a
 * dark, a light and a ported theme and at both densities, and Window style switching to Classic
 * and back live. SQLite in memory, so it needs only a display and a fresh build:
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
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
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

/** The few DOM members the evaluations touch; the e2e program is compiled without the DOM lib. */
interface Styled {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Styled): {
        readonly backgroundColor: string;
        readonly borderTopLeftRadius: string;
        readonly borderBottomWidth: string;
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

      expect(await rootVariable(page, "--tc-island-gap")).toBe("3px");
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
});
