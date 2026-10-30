/**
 * The shell against in-memory SQLite: tool windows, Find Action, the native menu and layout
 * persistence (plan 003). Gated, because it needs a display and a fresh build:
 *
 *   bun run test:smoke
 *
 * With `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/003` it also saves the SQLite live-test PNGs.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  datasourceStatus,
  editorTabs,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("003");
const captureCorner = evidenceFor("127");

/** A button in the tab strip's right corner (plan 127). */
function cornerButton(page: Page, name: string) {
  return page.getByTestId("tab-strip-corner").getByRole("button", { name, exact: true });
}

function cornerMenu(page: Page, name: string) {
  return page.getByRole("menu", { name, exact: true });
}

/** How far the Database tool window's edge is dragged, in CSS pixels. */
const RESIZE_DRAG_PX = 120;
/** Panel sizes round-trip through percentages, so allow a pixel either way. */
const RESIZE_TOLERANCE_PX = 2;
const MENU_PATH = ["View", "Tool Windows", "Services"] as const;

async function clickMenuItem(running: RunningApp, path: readonly string[]): Promise<void> {
  await running.app.evaluate(({ Menu }, labels) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    for (const [index, label] of labels.entries()) {
      const item = items.find((candidate) => candidate.label === label);
      if (item === undefined) throw new Error(`No menu item "${label}".`);
      if (index === labels.length - 1) {
        // Electron types `click` as `Function`; it runs the template's handler.
        (item.click as () => void)();
        return;
      }
      items = item.submenu?.items ?? [];
    }
  }, path);
}

describe.runIf(SMOKE_ENABLED)("shell smoke", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenLaunch_whenShellRenders_thenBothToolWindowsAndOneConsoleShow",
    async () => {
      running = await launchApp();
      const { page } = running;
      await waitUntilReady(page);

      await expect.poll(() => toolWindow(page, "Database").isVisible()).toBe(true);
      expect(await toolWindow(page, "Services").isVisible()).toBe(true);
      expect(await editorTabs(page).allTextContents()).toEqual(["console [scratch]"]);
      await expect.poll(() => datasourceStatus(page).textContent()).toMatch(/^scratch · connected · SQLite \d/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDatabaseShown_whenModOnePressedTwice_thenItHidesThenShows",
    async () => {
      running = await launchApp();
      const { page } = running;
      await waitUntilReady(page);

      await pressChord(page, "1");
      await expect.poll(() => toolWindow(page, "Database").count()).toBe(0);
      await pressChord(page, "1");
      await expect.poll(() => toolWindow(page, "Database").count()).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFindAction_whenNewConsoleChosen_thenSecondTabOpensActive",
    async () => {
      running = await launchApp();
      const { page } = running;
      await waitUntilReady(page);

      await findAction(page, "new console");

      await expect.poll(() => editorTabs(page).count()).toBe(2);
      expect(await activeEditorTab(page).textContent()).toBe("console_1 [scratch]");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenConsole_whenCornerPlusClicked_thenNewConsoleOnSameDatasource",
    async () => {
      running = await launchApp();
      const { page } = running;
      await waitUntilReady(page);

      await cornerButton(page, "New Console").click();

      await expect.poll(() => editorTabs(page).count()).toBe(2);
      expect(await activeEditorTab(page).textContent()).toBe("console_1 [scratch]");
      await captureCorner(page, "corner");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenThreeTabs_whenOpenTabsPicked_thenThatTabActivates",
    async () => {
      running = await launchApp();
      const { page } = running;
      await waitUntilReady(page);
      await cornerButton(page, "New Console").click();
      await cornerButton(page, "New Console").click();
      await expect.poll(() => editorTabs(page).count()).toBe(3);

      await cornerButton(page, "Open Tabs").click();
      const rows = cornerMenu(page, "Open Tabs").getByRole("menuitemradio");
      expect(await rows.allTextContents()).toEqual(["console [scratch]", "console_1 [scratch]", "console_2 [scratch]"]);
      expect(await rows.nth(2).getAttribute("aria-checked")).toBe("true");
      await captureCorner(page, "open-tabs");
      await rows.first().click();

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console [scratch]");
      expect(await cornerMenu(page, "Open Tabs").count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoTabs_whenTabActionsCloseOthers_thenOneTabLeft",
    async () => {
      running = await launchApp();
      const { page } = running;
      await waitUntilReady(page);
      await cornerButton(page, "New Console").click();
      await expect.poll(() => editorTabs(page).count()).toBe(2);

      await cornerButton(page, "Tab Actions").click();
      const items = cornerMenu(page, "Tab Actions").getByRole("menuitem");
      expect(await items.allTextContents()).toEqual([
        "Close Other Tabs",
        "Close All Tabs",
        "Reopen Closed Tab",
        "Split Right",
        "Unsplit",
      ]);
      await captureCorner(page, "tab-actions");
      await items.filter({ hasText: "Close Other Tabs" }).click();

      await expect.poll(() => editorTabs(page).allTextContents()).toEqual(["console_1 [scratch]"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNativeMenu_whenServicesClicked_thenServicesTogglesOnce",
    async () => {
      running = await launchApp();
      const { page } = running;
      await waitUntilReady(page);

      await clickMenuItem(running, MENU_PATH);
      await expect.poll(() => toolWindow(page, "Services").count()).toBe(0);
      await captureWindow(page, "menu-dispatch");
      await clickMenuItem(running, MENU_PATH);
      await expect.poll(() => toolWindow(page, "Services").count()).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenResizedDatabaseAndClosedServices_whenRelaunched_thenLayoutRestored",
    async () => {
      running = await launchApp();
      let { page } = running;
      await waitUntilReady(page);
      const before = await toolWindow(page, "Database").boundingBox();
      const handle = await page.getByRole("separator").first().boundingBox();
      if (before === null || handle === null) throw new Error("The Database tool window is not laid out.");

      const y = handle.y + handle.height / 2;
      await page.mouse.move(handle.x + handle.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + RESIZE_DRAG_PX, y, { steps: 10 });
      await page.mouse.up();
      await pressChord(page, "8");
      await expect.poll(() => toolWindow(page, "Services").count()).toBe(0);
      const resized = await toolWindow(page, "Database").boundingBox();
      expect(resized?.width ?? 0).toBeGreaterThan(before.width + RESIZE_DRAG_PX / 2);

      const { userDataDir } = running;
      await closeApp(running.app);
      running = await launchApp(undefined, { userDataDir });
      page = running.page;
      await waitUntilReady(page);

      await expect.poll(() => toolWindow(page, "Database").isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      expect(await toolWindow(page, "Services").count()).toBe(0);
      const restored = await toolWindow(page, "Database").boundingBox();
      expect(Math.abs((restored?.width ?? 0) - (resized?.width ?? 0))).toBeLessThanOrEqual(RESIZE_TOLERANCE_PX);
      await captureWindow(page, "layout-restored");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
