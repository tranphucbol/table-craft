/**
 * Plan 108's live test: the console marks SQL problems as you type, before anything runs; Alt+Enter
 * lists their fixes, applying one rewrites the text, and Suppress for statement silences one with a
 * `-- noinspection` comment. Also captures the table editor's Submit and Preview icons. SQLite only:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/108 bun run test:smoke:headless test/e2e/inspections.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("108");

const SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };

const MISSPELT = "ordrs";
const UNRESOLVED = `select * from ${MISSPELT};`;
const FIXED = "select * from orders;";
const EMPTY_WHERE_AND_ASC = "select * from orders where order by id asc;";
const SUPPRESSED_PREFIX = "-- noinspection SqlResolve";
/** Longer than the renderer's typing delay plus a round trip, so a problem that stays away stays away. */
const SETTLE_MS = 1_500;

function problems(page: Page, severity: "error" | "warning" | "weak") {
  return sqlEditor(page).locator(`.tc-problem-${severity}`);
}

function popup(page: Page) {
  return page.getByRole("listbox", { name: "Context actions" });
}

async function editorText(page: Page): Promise<string> {
  return (await sqlEditor(page).locator(".cm-line").allTextContents()).join("\n");
}

async function typeSql(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
}

/** Puts the caret inside the first problem of `severity` and opens Show Context Actions. */
async function openContextActions(page: Page, severity: "error" | "weak"): Promise<void> {
  await problems(page, severity).first().click();
  await page.mouse.move(0, 0);
  await sqlEditor(page).press("Alt+Enter");
  await popup(page).waitFor();
}

describe.runIf(SMOKE_ENABLED)("SQL inspections live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(): Promise<Page> {
    running = await launchApp(SQLITE);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenMisspeltTable_whenTypedThenAltEnterAndDidYouMean_thenMarkedUnrunAndFixed",
    async () => {
      const page = await launch();
      await typeSql(page, UNRESOLVED);

      await expect
        .poll(() => problems(page, "error").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([MISSPELT]);
      expect(await page.getByRole("log", { name: "Output" }).locator("[data-tone]").count()).toBe(0);
      await captureWindow(page, "unresolved-table-marked");

      await openContextActions(page, "error");
      const rows = await popup(page).getByRole("option").allTextContents();
      expect(rows[0]).toBe("Did you mean 'orders'?");
      expect(rows).toEqual(expect.arrayContaining(["Suppress for statement"]));
      await captureWindow(page, "alt-enter-did-you-mean");

      await sqlEditor(page).press("Enter");
      await popup(page).waitFor({ state: "detached" });
      await expect.poll(() => editorText(page)).toBe(FIXED);
      await page.keyboard.type("X");
      await expect.poll(() => editorText(page)).toBe(FIXED.replace("orders", "ordersX"));
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(SETTLE_MS);
      expect(await problems(page, "error").count()).toBe(0);
      await captureWindow(page, "did-you-mean-applied");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEmptyWhereAndRedundantAsc_whenTyped_thenErrorAndWeakMarksWithHoverMessage",
    async () => {
      const page = await launch();
      await typeSql(page, EMPTY_WHERE_AND_ASC);

      await expect
        .poll(() => problems(page, "weak").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(["asc"]);
      await expect.poll(() => problems(page, "error").count()).toBeGreaterThan(0);
      expect((await problems(page, "error").allTextContents()).join(" ").toLowerCase()).toContain("where");
      await captureWindow(page, "empty-where-and-redundant-asc");

      await problems(page, "error").first().hover();
      const tooltip = page.locator(".tc-problem-tooltip");
      await tooltip.waitFor();
      expect((await tooltip.locator(".tc-problem-message").allTextContents()).join(" ")).toMatch(/expected/i);
      expect(await tooltip.locator(".tc-problem-fix").count()).toBeGreaterThan(0);
      await captureWindow(page, "problem-hover");

      await page.mouse.move(0, 0);
      await tooltip.waitFor({ state: "detached" });
      await openContextActions(page, "weak");
      expect((await popup(page).getByRole("option").allTextContents())[0]).toMatch(/asc/i);
      await captureWindow(page, "alt-enter-redundant-asc");
      await sqlEditor(page).press("Enter");
      await expect.poll(() => editorText(page)).not.toContain(" asc");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUnresolvedTable_whenSuppressedForStatement_thenNoinspectionCommentAndMarkGone",
    async () => {
      const page = await launch();
      await typeSql(page, UNRESOLVED);
      await expect.poll(() => problems(page, "error").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);

      await openContextActions(page, "error");
      await popup(page).getByRole("option", { name: "Suppress for statement", exact: true }).click();

      await expect.poll(() => editorText(page)).toBe(`${SUPPRESSED_PREFIX}\n${UNRESOLVED}`);
      await page.waitForTimeout(SETTLE_MS);
      expect(await problems(page, "error").count()).toBe(0);
      await captureWindow(page, "suppressed-for-statement");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPendingEditInTableEditor_whenLookingAtToolbar_thenSubmitAndPreviewIconsShow",
    async () => {
      const page = await launch();
      const explorer = toolWindow(page, "Database");
      const group = explorer.getByRole("treeitem", { name: "tables 6", exact: true });
      await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      if ((await group.getAttribute("aria-expanded")) !== "true") {
        await group.click();
        await page.keyboard.press("ArrowRight");
      }
      await explorer.getByRole("treeitem", { name: "edit_probe", exact: true }).click();
      await page.keyboard.press("F4");
      await expect.poll(() => activeEditorTab(page).textContent()).toContain("edit_probe");
      const editor = page.getByTestId("table-editor");
      const cell = editor.locator('[role="gridcell"][data-row="0"][data-col="1"]');
      await cell.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await cell.click();
      await page.keyboard.press("Enter");
      const field = editor.locator("[data-editing] input");
      await field.waitFor();
      await field.fill("changed");
      await field.press("Enter");
      await expect.poll(() => editor.getByTestId("pending-changes").textContent()).toBe("1 pending change");

      const submit = editor.getByRole("button", { name: "Submit", exact: true });
      const preview = editor.getByRole("button", { name: "Preview Pending Changes", exact: true });
      expect(await submit.isEnabled()).toBe(true);
      expect(await preview.isEnabled()).toBe(true);
      expect(await submit.locator("svg").first().isVisible()).toBe(true);
      expect(await preview.locator("svg").first().isVisible()).toBe(true);
      await captureWindow(page, "table-editor-submit-preview-icons");

      // Reverted so closing the app is not held up asking what to do with the change.
      await findAction(page, "Revert All");
      await expect.poll(() => editor.getByTestId("pending-changes").count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
