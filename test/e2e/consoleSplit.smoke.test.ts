/**
 * The console's editor and results split by a draggable separator, remembered across launches
 * (plan 060). Gated, because it needs a display and a fresh build:
 *
 *   bun run test:smoke:headless test/e2e/consoleSplit.smoke.test.ts
 *
 * With `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/060` it also saves the live-test PNGs.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("060");

const EDITOR_PANEL = "console-editor";
const RESULTS_PANEL = "console-results";
const QUERY = "SELECT 1 AS n, 'resizable' AS label";
/** How far the separator is dragged, in CSS pixels. */
const DRAG_PX = 150;
/** Far enough to pass the bottom of an 800-pixel window. */
const OVERSHOOT_PX = 2_000;
/** Panel sizes round-trip through percentages, so allow a pixel either way. */
const TOLERANCE_PX = 2;
const ARROW_PRESSES = 3;
/** `MIN_CONSOLE_PANE_PERCENT` in `state/layout.ts`. */
const MIN_PANE_FRACTION = 0.1;
const MOUSE_STEPS = 10;

function consoleSeparator(page: Page) {
  return page.locator(`[role="separator"][aria-controls="${EDITOR_PANEL}"]`);
}

async function height(page: Page, panel: string): Promise<number> {
  const box = await page.getByTestId(panel).boundingBox();
  if (box === null) throw new Error(`The ${panel} panel is not laid out.`);
  return box.height;
}

async function dragSeparator(page: Page, dy: number): Promise<void> {
  const box = await consoleSeparator(page).boundingBox();
  if (box === null) throw new Error("The console separator is not laid out.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: MOUSE_STEPS });
  await page.mouse.up();
}

async function openConsoleWithResult(running: RunningApp): Promise<Page> {
  const { page } = running;
  await setWindowSize(running.app, EVIDENCE_WINDOW);
  await waitUntilReady(page);
  await runStatement(page, QUERY);
  return page;
}

describe.runIf(SMOKE_ENABLED)("console split smoke", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenConsole_whenSeparatorDraggedDown_thenEditorGrowsAndResultsShrink",
    async () => {
      running = await launchApp();
      const page = await openConsoleWithResult(running);
      const editorBefore = await height(page, EDITOR_PANEL);
      const resultsBefore = await height(page, RESULTS_PANEL);
      expect(Math.abs(editorBefore - resultsBefore)).toBeLessThanOrEqual(TOLERANCE_PX);
      await captureWindow(page, "split-default");

      await dragSeparator(page, DRAG_PX);

      await expect.poll(() => height(page, EDITOR_PANEL)).toBeGreaterThan(editorBefore + DRAG_PX - TOLERANCE_PX);
      expect(await height(page, RESULTS_PANEL)).toBeLessThan(resultsBefore - DRAG_PX + TOLERANCE_PX);
      expect(await page.getByRole("columnheader", { name: "label" }).isVisible()).toBe(true);
      await captureWindow(page, "split-dragged-down");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDraggedSplit_whenRelaunched_thenSplitKept",
    async () => {
      running = await launchApp();
      let page = await openConsoleWithResult(running);
      await dragSeparator(page, -DRAG_PX);
      await expect
        .poll(async () => (await height(page, RESULTS_PANEL)) - (await height(page, EDITOR_PANEL)))
        .toBeGreaterThan(DRAG_PX);
      const resized = await height(page, EDITOR_PANEL);

      const { userDataDir } = running;
      await closeApp(running.app);
      running = await launchApp(undefined, { userDataDir });
      page = await openConsoleWithResult(running);

      await expect
        .poll(async () => Math.abs((await height(page, EDITOR_PANEL)) - resized), { timeout: LAUNCH_TIMEOUT_MS })
        .toBeLessThanOrEqual(TOLERANCE_PX);
      await captureWindow(page, "split-restored");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFocusedSeparator_whenArrowUpPressed_thenEditorShrinks",
    async () => {
      running = await launchApp();
      const page = await openConsoleWithResult(running);
      const separator = consoleSeparator(page);
      const before = Number(await separator.getAttribute("aria-valuenow"));
      const editorBefore = await height(page, EDITOR_PANEL);

      await separator.focus();
      for (let press = 0; press < ARROW_PRESSES; press += 1) await page.keyboard.press("ArrowUp");

      await expect.poll(async () => Number(await separator.getAttribute("aria-valuenow"))).toBeLessThan(before);
      expect(await height(page, EDITOR_PANEL)).toBeLessThan(editorBefore);
      await captureWindow(page, "split-keyboard");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSeparatorDraggedPastTheEnd_whenReleased_thenResultsKeepTheirMinimum",
    async () => {
      running = await launchApp();
      const page = await openConsoleWithResult(running);
      const total = (await height(page, EDITOR_PANEL)) + (await height(page, RESULTS_PANEL));

      await dragSeparator(page, OVERSHOOT_PX);

      await expect.poll(() => height(page, RESULTS_PANEL)).toBeLessThan(total / 2);
      expect(await height(page, RESULTS_PANEL)).toBeGreaterThanOrEqual(total * MIN_PANE_FRACTION - TOLERANCE_PX);
      expect(await page.getByRole("tablist", { name: "Results" }).isVisible()).toBe(true);
      await captureWindow(page, "split-results-minimum");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
