/**
 * Plan 110's live test: a copy button confirms with a check, the Database tree scrolls sideways
 * to a long name, New Console no longer shares New Data Source's glyph, and a held button looks
 * pressed. SQLite in memory, so it needs only a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/110 bun run test:smoke:headless test/e2e/uiFeedback.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  CLOSE_HOOK_TIMEOUT_MS,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedDatasources,
  SMOKE_ENABLED,
  setWindowSize,
  sqlEditor,
  toolWindow,
  treeNode,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("110");

const LONG_NAME = `orders_archive_${"partitioned_by_month_".repeat(4)}eu_west`;
const QUERY = "SELECT 1 AS id, 'TableCraft' AS name";
/** Past the 100 ms release fade; the press itself lands on its first frame (plan 114). */
const PRESS_SETTLE_MS = 250;

/** The DOM members these scenarios read; the e2e program has no DOM lib. */
interface Box {
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollLeft: number;
  scrollTo(options: { readonly left: number }): void;
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Box): {
        readonly boxShadow: string;
        readonly scale: string;
        readonly scrollbarWidth: string;
      };
    };
  };
}

function databaseToolbarButton(page: Page, name: string): Locator {
  return page
    .getByRole("toolbar", { name: "Database toolbar", exact: true })
    .getByRole("button", { name, exact: true });
}

function treeScroller(page: Page): Locator {
  return toolWindow(page, "Database").getByTestId("database-tree-scroll");
}

describe.runIf(SMOKE_ENABLED)("copy confirmation, tree scroll, console icon and pressed buttons live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(): Promise<Page> {
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [{ id: "long", name: LONG_NAME, pluginId: "sqlite", config: { path: ":memory:" } }]);
    running = await launchApp(SCRATCH, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenResultCell_whenCopyClicked_thenButtonShowsCheckThenReturns",
    async () => {
      const page = await launch();
      await sqlEditor(page).fill(QUERY);
      await sqlEditor(page).press("Escape");
      await runAllButton(page).click();
      await waitUntilReady(page);
      await page.locator('[role="gridcell"][data-row="0"][data-col="1"]').click();
      const copy = page.getByRole("toolbar", { name: "Result" }).getByRole("button", { name: "Copy", exact: true });

      await copy.click();

      await expect.poll(() => copy.getAttribute("data-copied")).toBe("");
      await page.mouse.move(0, 0);
      await captureWindow(page, "01-copy-confirmed");
      expect(await running?.app.evaluate(({ clipboard }) => clipboard.readText())).toBe("TableCraft");
      await expect.poll(() => copy.getAttribute("data-copied"), { timeout: LAUNCH_TIMEOUT_MS }).toBeNull();
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLongDatasourceName_whenTreeScrolledRight_thenNameEndShowsWithNoHorizontalBar",
    async () => {
      const page = await launch();
      const scroller = treeScroller(page);
      await treeNode(page, LONG_NAME).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "02-tree-before-scroll");

      const overflow = await scroller.evaluate((element: Box) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeGreaterThan(0);
      const bar = await scroller.evaluate(
        (element: Box) => element.ownerDocument.defaultView.getComputedStyle(element).scrollbarWidth,
      );
      expect(bar).toBe("none");
      await scroller.evaluate((element: Box) => element.scrollTo({ left: element.scrollWidth }));

      await expect.poll(() => scroller.evaluate((element: Box) => element.scrollLeft)).toBeGreaterThan(0);
      await captureWindow(page, "03-tree-scrolled-right");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDatabaseToolbar_whenIconsRead_thenNewConsoleDiffersFromNewDataSource",
    async () => {
      const page = await launch();
      const console = databaseToolbarButton(page, "New Console");
      const datasource = databaseToolbarButton(page, "New Data Source…");

      const [consoleGlyph, datasourceGlyph] = await Promise.all([
        console.locator("svg").innerHTML(),
        datasource.locator("svg").innerHTML(),
      ]);

      expect(consoleGlyph).not.toBe(datasourceGlyph);
      await console.hover();
      await page.getByRole("tooltip").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "04-new-console-icon");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEnabledButton_whenHeld_thenTintedAndShrunkUntilReleased",
    async () => {
      const page = await launch();
      const button = databaseToolbarButton(page, "New Data Source…");
      const box = await button.boundingBox();
      if (box === null) throw new Error("The New Data Source button is not shown.");
      const pressedStyle = () =>
        button.evaluate((element: Box) => {
          const style = element.ownerDocument.defaultView.getComputedStyle(element);
          return { shadow: style.boxShadow, scale: style.scale };
        });

      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(PRESS_SETTLE_MS);
      const held = await pressedStyle();
      await captureWindow(page, "05-button-held");
      await page.mouse.move(0, 0);
      await page.mouse.up();
      await page.waitForTimeout(PRESS_SETTLE_MS);
      const released = await pressedStyle();

      expect(held.shadow).toContain("inset");
      expect(held.scale).not.toBe("none");
      expect(released.shadow).toBe("none");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
