/**
 * Plan 022's live test: completion follows `USE` on MySQL and `SET search_path` on PostgreSQL, run
 * in the console or written above the caret, and the console toolbar shows where the console is.
 * Gated, because it needs a display, a fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/022 bun run test:smoke:db
 *
 * Nothing here writes to the shared databases; `USE` and `SET` change only the console's session.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  startStatement,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("022");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

const TABLES_GROUP = "tables 6";
/** Basic Completion, CodeMirror's `Ctrl-Space` on every platform. */
const BASIC_COMPLETION = "Control+Space";
const FROM = "SELECT * FROM ";

function namespaceLabel(page: Page) {
  return page.getByTestId("console-namespace");
}

async function labelText(page: Page): Promise<string | null> {
  return (await namespaceLabel(page).count()) === 0 ? null : namespaceLabel(page).textContent();
}

/**
 * Whether the label sits inside the toolbar's datasource span rather than past its truncation: a
 * long error beside it once squeezed it out of sight (found live, plan 022).
 */
async function labelShown(page: Page): Promise<boolean> {
  const label = await namespaceLabel(page).boundingBox();
  const owner = await page.getByTestId("console-datasource").boundingBox();
  if (label === null || owner === null) return false;
  return label.width > 0 && label.x >= owner.x && label.x + label.width <= owner.x + owner.width + 1;
}

function popup(page: Page) {
  return page.locator(".cm-tooltip-autocomplete");
}

async function optionLabels(page: Page): Promise<string[]> {
  return popup(page).locator(".cm-completionLabel").allTextContents();
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

/** Replaces the console's text with `sql` and asks for completion at its end. */
async function completeAtEnd(page: Page, sql: string): Promise<string[]> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
  // Filling can open a typing popup; close it so the explicit request below is the one shown.
  await page.keyboard.press("Escape");
  await pressChord(page, "End");
  await page.keyboard.press(BASIC_COMPLETION);
  await popup(page).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return optionLabels(page);
}

/** Runs a statement that returns no rows and waits until the label shows `expected`. */
async function switchTo(page: Page, sql: string, expected: string): Promise<void> {
  await startStatement(page, sql);
  await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(expected);
  await waitUntilReady(page);
}

describe.runIf(DATABASES_ENABLED)("completion follows the console's namespace live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await toolWindow(running.page, "Database")
      .getByRole("treeitem", { name: TABLES_GROUP, exact: true })
      .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  it(
    "givenMysqlUseRun_whenCompletingAfterFrom_thenTheOtherDatabasesTables",
    async () => {
      const page = await launch(MYSQL);
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("table_craft");

      await switchTo(page, "USE archive;", "archive");
      const labels = await completeAtEnd(page, FROM);

      expect(labels).toContain("old_orders");
      expect(labels).not.toContain("customers");
      await captureWindow(page, "01-mysql-use-run");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlScriptWithUnrunUse_whenCompletingBelowIt_thenTheUsedDatabasesTables",
    async () => {
      const page = await launch(MYSQL);
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("table_craft");

      const labels = await completeAtEnd(page, `USE archive;\n\n${FROM}`);

      expect(labels).toContain("old_orders");
      expect(labels).not.toContain("customers");
      // The script's USE has not run, so the console is still where it was.
      expect(await labelText(page)).toBe("table_craft");
      await captureWindow(page, "02-mysql-script-use");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresSearchPathSet_whenCompletingAfterFrom_thenTheArchiveSchemasTables",
    async () => {
      const page = await launch(POSTGRES);
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("public");

      await switchTo(page, "SET search_path TO archive, public;", "archive");
      const labels = await completeAtEnd(page, FROM);

      expect(labels).toContain("old_orders");
      expect(labels).not.toContain("customers");
      expect(await namespaceLabel(page).getAttribute("title")).toBe("table_craft.archive");
      await captureWindow(page, "03-postgres-search-path");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlUseRun_whenReconnected_thenTheLabelIsTheNewSessionsDatabase",
    async () => {
      const page = await launch(MYSQL);
      await switchTo(page, "USE archive;", "archive");

      await pressChord(page, "F2");
      await expect.poll(() => treeNode(page, "mysql").getAttribute("data-state")).toBe("disconnected");
      await expect.poll(() => labelText(page)).toBeNull();
      await runStatement(page, "SELECT 1 AS one");

      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("table_craft");
      expect(await completeAtEnd(page, FROM)).toContain("customers");
      await page.keyboard.press("Escape");
      await captureWindow(page, "04-label-reset");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlUseOfMissingDatabase_whenRun_thenErrorAndNamespaceUnchanged",
    async () => {
      const page = await launch(MYSQL);
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("table_craft");

      await runStatement(page, "USE no_such_database;");

      expect(await consoleAlert(page).textContent()).toMatch(/no_such_database/);
      expect(await labelText(page)).toBe("table_craft");
      expect(await labelShown(page)).toBe(true);
      const labels = await completeAtEnd(page, FROM);
      expect(labels).toContain("customers");
      expect(labels).not.toContain("old_orders");
      await captureWindow(page, "05-use-missing");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
