/**
 * Copying one cell puts its bare value on the clipboard, more than one keeps the extractor, and
 * double-clicking a console result cell opens the Value panel. SQLite in memory, so it needs only a
 * display and a fresh build:
 *
 *   bun run test:smoke
 */
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  SMOKE_ENABLED,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("cellCopy");

const REFUND_ID = "261023000002437";
const NOTE = 'a,"b"';
const TWO_CELLS = `SELECT ${REFUND_ID} AS refund_id, 'a,"b"' AS note`;
/** `hex(zeroblob(n))` is 2n zeros: a value far wider than its cell. */
const LONG_ZEROS = 1000;
const LONG_TEXT = `start-${"0".repeat(LONG_ZEROS * 2)}-end`;
const LONG_QUERY = `SELECT 'start-' || hex(zeroblob(${String(LONG_ZEROS)})) || '-end' AS long_text`;

function cell(page: Page, row: number, column: number) {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

function valuePanel(page: Page) {
  return page.getByRole("complementary", { name: "Value" });
}

async function query(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

async function clearClipboard(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ clipboard }) => clipboard.clear());
}

describe.runIf(SMOKE_ENABLED)("single-cell copy and double-click value live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  });

  async function launch(): Promise<RunningApp> {
    running = await launchApp();
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenOneCellSelected_whenModC_thenBareValueOnClipboard",
    async () => {
      const { app, page } = await launch();
      await query(page, TWO_CELLS);

      await clearClipboard(app);
      await cell(page, 0, 0).click();
      await pressChord(page, "C");
      await expect.poll(() => clipboardText(app)).toBe(REFUND_ID);

      await clearClipboard(app);
      await cell(page, 0, 1).click();
      await pressChord(page, "C");
      await expect.poll(() => clipboardText(app)).toBe(NOTE);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoCellsSelected_whenModC_thenExtractorWithHeader",
    async () => {
      const { app, page } = await launch();
      await query(page, TWO_CELLS);

      await clearClipboard(app);
      await cell(page, 0, 0).click();
      await cell(page, 0, 1).click({ modifiers: ["Shift"] });
      await pressChord(page, "C");
      await expect.poll(() => clipboardText(app)).toBe(`refund_id,note\n${REFUND_ID},"a,""b"""\n`);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLongText_whenCellDoubleClicked_thenValuePanelShowsAllOfIt",
    async () => {
      const { page } = await launch();
      await query(page, LONG_QUERY);
      expect(await valuePanel(page).count()).toBe(0);

      await cell(page, 0, 0).dblclick();
      await expect.poll(() => valuePanel(page).isVisible()).toBe(true);
      await expect.poll(() => valuePanel(page).getByTestId("value-text").textContent()).toBe(LONG_TEXT);
      await captureWindow(page, "cell-dblclick-value");

      await cell(page, 0, 0).dblclick();
      await expect.poll(() => valuePanel(page).isVisible()).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
