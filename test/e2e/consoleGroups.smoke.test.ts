/**
 * TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/109 bun run test:smoke:headless test/e2e/consoleGroups.smoke.test.ts
 */
import { execFileSync } from "node:child_process";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbarButton,
  openConsoleOn,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("109");
const FIRST_SQL = "SELECT 111 AS left_value, 'first console' AS source";
const SECOND_SQL = "SELECT 222 AS right_value, 'second console' AS source";
const UPDATED_FIRST_SQL = "SELECT 333 AS focused_left, 'first updated' AS source";
const UPDATED_SECOND_SQL = "SELECT 444 AS focused_right, 'second updated' AS source";
const MOUSE_STEPS = 12;
const DRAG_START_PX = 20;
const RESIZE_PX = 80;
const SIZE_TOLERANCE_PX = 3;
const EDGE_FRACTION = 0.08;
const TAB_DRAG_INSET_PX = 12;
const NATIVE_EVENT_INTERVAL_SECONDS = "0.1";

type Side = "Left" | "Right";

// Electron's native drag loop blocks CDP mouse dispatch; XTest drives the real pointer instead.
function nativeMouse() {
  const window = execFileSync("xdotool", ["getactivewindow"], { encoding: "utf8" }).trim();
  return {
    move(x: number, y: number) {
      execFileSync("xdotool", [
        "mousemove",
        "--window",
        window,
        String(Math.round(x)),
        String(Math.round(y)),
        "sleep",
        NATIVE_EVENT_INTERVAL_SECONDS,
      ]);
    },
    down() {
      execFileSync("xdotool", ["mousedown", "1", "sleep", NATIVE_EVENT_INTERVAL_SECONDS]);
    },
    up() {
      execFileSync("xdotool", ["mouseup", "1"]);
    },
  };
}

function groups(page: Page): Locator {
  return page.getByTestId("editor-group");
}

function tabs(group: Locator): Locator {
  return group.getByRole("tablist", { name: "Editor tabs", exact: true }).getByRole("tab");
}

function editor(group: Locator): Locator {
  return group.getByRole("textbox", { name: "SQL console", exact: true });
}

function groupWithTab(page: Page, label: string): Locator {
  return groups(page).filter({
    has: page.getByRole("tablist", { name: "Editor tabs", exact: true }).getByRole("tab").filter({ hasText: label }),
  });
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error("The editor group control is not laid out.");
  return bounds;
}

async function ready(group: Locator): Promise<void> {
  const run = group
    .getByRole("toolbar", { name: "Console toolbar", exact: true })
    .getByRole("button", { name: "Run", exact: true });
  await expect.poll(() => run.isEnabled(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
}

async function result(group: Locator, header: string, value: string): Promise<void> {
  await expect
    .poll(() => group.getByRole("columnheader", { name: header, exact: true }).isVisible(), {
      timeout: LAUNCH_TIMEOUT_MS,
    })
    .toBe(true);
  await expect
    .poll(() => group.getByRole("gridcell").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
    .toContain(value);
  await ready(group);
}

async function openTwoConsoles(running: RunningApp): Promise<{ first: string; second: string }> {
  const { page } = running;
  await setWindowSize(running.app, EVIDENCE_WINDOW);
  await waitUntilReady(page);
  await expect.poll(() => groups(page).count()).toBe(1);
  const first = (await tabs(groups(page).first()).innerText()).trim();
  await runStatement(page, FIRST_SQL);
  await openConsoleOn(page, "scratch");
  await expect.poll(() => tabs(groups(page).first()).count()).toBe(2);
  await waitUntilReady(page);
  const second = (await tabs(groups(page).first()).last().innerText()).trim();
  expect(second).not.toBe(first);
  await runStatement(page, SECOND_SQL);
  return { first, second };
}

async function assertSplit(page: Page, first: string, second: string, side: Side): Promise<void> {
  await expect.poll(() => groups(page).count()).toBe(2);
  const original = groupWithTab(page, first);
  const moved = groupWithTab(page, second);
  expect(await original.getAttribute("data-group-id")).not.toBe(await moved.getAttribute("data-group-id"));
  expect(await original.getAttribute("data-group-id")).toBeTruthy();
  expect(await moved.getAttribute("data-group-id")).toBeTruthy();
  expect(await tabs(original).count()).toBe(1);
  expect(await tabs(moved).count()).toBe(1);
  expect(await editor(original).isVisible()).toBe(true);
  expect(await editor(moved).isVisible()).toBe(true);
  await result(original, "left_value", "111");
  await result(moved, "right_value", "222");
  const originalBox = await box(original);
  const movedBox = await box(moved);
  if (side === "Left") expect(movedBox.x + movedBox.width).toBeLessThanOrEqual(originalBox.x + SIZE_TOLERANCE_PX);
  else expect(originalBox.x + originalBox.width).toBeLessThanOrEqual(movedBox.x + SIZE_TOLERANCE_PX);
}

async function splitByMenu(page: Page, label: string, side: Side): Promise<void> {
  await tabs(groupWithTab(page, label)).filter({ hasText: label }).click({ button: "right" });
  const item = page.getByRole("menuitem", { name: `Split ${side}`, exact: true });
  await item.waitFor();
  await captureWindow(page, `groups-context-split-${side.toLowerCase()}`);
  await item.click();
}

async function dragToEdge(page: Page, label: string, side: Side): Promise<void> {
  const group = groupWithTab(page, label);
  const source = await box(tabs(group).filter({ hasText: label }).locator(".."));
  const destination = await box(group);
  const x = source.x + TAB_DRAG_INSET_PX;
  const y = source.y + source.height / 2;
  const edgeX = destination.x + destination.width * (side === "Left" ? EDGE_FRACTION : 1 - EDGE_FRACTION);
  const edgeY = destination.y + destination.height / 2;
  const mouse = nativeMouse();
  try {
    mouse.move(x, y);
    mouse.down();
    mouse.move(x + DRAG_START_PX, y + DRAG_START_PX);
    mouse.move(edgeX, edgeY);
    await captureWindow(page, "groups-native-drag-diagnostic");
    const target = page.getByTestId(`editor-drop-${side.toLowerCase()}`);
    await target.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    const drop = await box(target);
    const targetX = drop.x + drop.width / 2;
    const targetY = drop.y + drop.height / 2;
    mouse.move(targetX, targetY);
    await captureWindow(page, `groups-drag-${side.toLowerCase()}-affordance`);
  } finally {
    mouse.up();
  }
}

async function moveToStrip(page: Page, sourceGroup: Locator, targetGroup: Locator): Promise<void> {
  const source = await box(tabs(sourceGroup).locator(".."));
  const target = await box(targetGroup.getByRole("tablist", { name: "Editor tabs", exact: true }));
  const x = source.x + TAB_DRAG_INSET_PX;
  const y = source.y + source.height / 2;
  const targetX = target.x + target.width / 2;
  const targetY = target.y + target.height / 2;
  const mouse = nativeMouse();
  try {
    mouse.move(x, y);
    mouse.down();
    mouse.move(x + DRAG_START_PX, y + DRAG_START_PX);
    mouse.move(targetX, targetY);
    await page.getByTestId("editor-drop-left").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  } finally {
    mouse.up();
  }
}

describe.runIf(SMOKE_ENABLED)("SQL console editor groups smoke", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  for (const side of ["Left", "Right"] as const) {
    it(
      `givenTwoConsoles_whenContextSplit${side}_thenQueriesAndFocusRoutingRemainIndependentAndClosingCollapses`,
      async () => {
        running = await launchApp();
        const { page } = running;
        const { first, second } = await openTwoConsoles(running);
        await splitByMenu(page, second, side);
        await assertSplit(page, first, second, side);
        await captureWindow(page, `groups-menu-${side.toLowerCase()}-independent-results`);

        const original = groupWithTab(page, first);
        const moved = groupWithTab(page, second);
        await editor(original).fill(UPDATED_FIRST_SQL);
        await pressChord(page, "Enter");
        await result(original, "focused_left", "333");
        await result(moved, "right_value", "222");
        expect(await editor(moved).innerText()).toBe(SECOND_SQL);

        await editor(moved).fill(UPDATED_SECOND_SQL);
        await mainToolbarButton(page, "Run").click();
        await result(moved, "focused_right", "444");
        await result(original, "focused_left", "333");
        expect(await editor(original).innerText()).toBe(UPDATED_FIRST_SQL);
        await captureWindow(page, `groups-menu-${side.toLowerCase()}-focus-routing`);

        const separator = page.getByRole("separator", { name: "Editor groups", exact: true });
        const left = groups(page).first();
        const right = groups(page).last();
        const leftBefore = await box(left);
        const rightBefore = await box(right);
        const divider = await box(separator);
        const x = divider.x + divider.width / 2;
        const y = divider.y + divider.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        try {
          await page.mouse.move(x + RESIZE_PX, y, { steps: MOUSE_STEPS });
        } finally {
          await page.mouse.up();
        }
        await expect
          .poll(async () => (await box(left)).width)
          .toBeGreaterThan(leftBefore.width + RESIZE_PX - SIZE_TOLERANCE_PX);
        expect((await box(right)).width).toBeLessThan(rightBefore.width - RESIZE_PX + SIZE_TOLERANCE_PX);
        await result(original, "focused_left", "333");
        await result(moved, "focused_right", "444");
        await captureWindow(page, `groups-${side.toLowerCase()}-resized`);

        await tabs(moved).click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Close Tab(?:\s|$)/ }).click();
        await expect.poll(() => groups(page).count()).toBe(1);
        expect(await separator.count()).toBe(0);
        expect(await tabs(groups(page).first()).count()).toBe(1);
        await result(groupWithTab(page, first), "focused_left", "333");
        await captureWindow(page, `groups-${side.toLowerCase()}-closed-collapse`);
      },
      SCENARIO_TIMEOUT_MS * 2,
    );

    it.skipIf(process.env["TABLE_CRAFT_HEADLESS"] !== "1")(
      `givenTwoConsoles_whenTabDragged${side}AndBack_thenSplitExecutesIndependentlyAndEmptyGroupCollapses`,
      async () => {
        running = await launchApp();
        const { page } = running;
        const { first, second } = await openTwoConsoles(running);
        await dragToEdge(page, second, side);
        await assertSplit(page, first, second, side);
        const original = groupWithTab(page, first);
        const moved = groupWithTab(page, second);
        await editor(moved).fill(UPDATED_SECOND_SQL);
        await pressChord(page, "Enter");
        await result(moved, "focused_right", "444");
        await result(original, "left_value", "111");
        await captureWindow(page, `groups-drag-${side.toLowerCase()}-independent-results`);

        await moveToStrip(page, moved, original);
        await expect.poll(() => groups(page).count()).toBe(1);
        expect(await page.getByRole("separator", { name: "Editor groups", exact: true }).count()).toBe(0);
        const remaining = groups(page).first();
        expect(await tabs(remaining).count()).toBe(2);
        await tabs(remaining).filter({ hasText: first }).click();
        await result(remaining, "left_value", "111");
        expect(await editor(remaining).innerText()).toBe(FIRST_SQL);
        await tabs(remaining).filter({ hasText: second }).click();
        await result(remaining, "focused_right", "444");
        expect(await editor(remaining).innerText()).toBe(UPDATED_SECOND_SQL);
        await captureWindow(page, `groups-drag-${side.toLowerCase()}-merged-collapse`);
      },
      SCENARIO_TIMEOUT_MS * 2,
    );
  }
});
