/**
 * Plan 006's live test: the SQL console against PostgreSQL, MySQL and SQLite, from the
 * `test/db/compose.yml` databases. Gated, because it needs a display, a fresh build and the
 * containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/006 bun run test:smoke:db
 */
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  closeApp,
  commitButton,
  computedOpacity,
  DATABASES_ENABLED,
  editorTabs,
  enginePids,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  iconSpin,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbarButton,
  newProfile,
  openConsoleOn,
  pressChord,
  readProfileFile,
  rollbackButton,
  runAllButton,
  runButton,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  sqlEditor,
  toolWindow,
  treeNode,
  type Datasource,
  type LaunchOptions,
  type RunningApp,
  waitUntilReady,
  waitUntilSpinning,
} from "./harness.js";

const captureWindow = evidenceFor("006");
const captureSelection = evidenceFor("113");
const captureSpinner = evidenceFor("112");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

/** The plan's driving script: two reads around a write that has a WHERE. */
const DRIVING_SCRIPT = [
  "SELECT * FROM customers;",
  "UPDATE orders SET total = total + 1 WHERE id = 1;",
  "SELECT count(*) FROM orders;",
].join("\n");
const UNDO_DRIVING_UPDATE = "UPDATE orders SET total = total - 1 WHERE id = 1";
const PROBE_ORDER_ID = 9001;
const INSERT_PROBE_ORDER = `INSERT INTO orders (id, customer_id, total, placed_at) VALUES (${String(PROBE_ORDER_ID)}, 1, 10, '2026-01-01 00:00:00')`;
const COUNT_PROBE_ORDER = `SELECT count(*) AS n FROM orders WHERE id = ${String(PROBE_ORDER_ID)}`;
const DELETE_PROBE_ORDER = `DELETE FROM orders WHERE id = ${String(PROBE_ORDER_ID)}`;
const COUNT_ORDERS = "SELECT count(*) AS n FROM orders";
const SMOKE_FUNCTION = "console_smoke_add";
const SMOKE_TABLE = "console_smoke_new";
const DOLLAR_QUOTED_SCRIPT = [
  `CREATE OR REPLACE FUNCTION ${SMOKE_FUNCTION}(a integer, b integer) RETURNS integer AS $$`,
  "BEGIN",
  "  RETURN a + b; -- a semicolon inside the body",
  "END;",
  "$$ LANGUAGE plpgsql;",
  `SELECT ${SMOKE_FUNCTION}(2, 3) AS sum;`,
].join("\n");
/** The autosave debounce (500 ms) with room for the write. */
const AUTOSAVE_WAIT_MS = 5_000;
/** A page expression, because this program has no DOM lib. */
const FOCUSED_IN_EDITOR = "document.activeElement?.closest('.cm-editor') != null";
/** Whether the first `SELECT` token is painted in another colour than the plain text around it. */
const KEYWORD_IS_COLOURED = `(() => {
  const content = document.querySelector('.cm-content');
  const keyword = [...document.querySelectorAll('.cm-line span')].find((span) => span.textContent === 'SELECT');
  if (!content || !keyword) return false;
  return getComputedStyle(keyword).color !== getComputedStyle(content).color;
})()`;
/** Counts far enough that SQLite is still busy when the spinner is checked (as `motion.smoke` does). */
const LONG_QUERY =
  "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 500000000) SELECT count(*) FROM g";
const IN_MEMORY_SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: ":memory:" } };
/** Records, from now on, whether any button ever turns `aria-busy`; read back with `BUSY_SEEN`. */
const WATCH_BUSY = `(() => {
  window.__busySeen = false;
  new MutationObserver((records) => {
    if (records.some((record) => record.target.getAttribute('aria-busy') === 'true')) window.__busySeen = true;
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
})()`;
const BUSY_SEEN = "window.__busySeen === true";
/** Past the spinner's 300 ms delay (plan 112 decision 3), with room for a render. */
const PAST_SPINNER_DELAY_MS = 1_000;

/** Runs `statements` straight through the plugin, outside the app, one at a time. */
async function asOwner(plugin: DatasourcePlugin, config: unknown, statements: readonly string[]): Promise<void> {
  const session = await plugin.connect(config, { readOnly: false });
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) {
        // Drained so the statement completes before the next.
      }
    }
  } finally {
    await session.close();
  }
}

function output(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

function outputEntries(page: Page) {
  return output(page).locator("[data-tone]");
}

function resultTabs(page: Page) {
  return page.getByRole("tablist", { name: "Results" }).getByRole("tab");
}

function resultTab(page: Page, title: string) {
  return resultTabs(page).filter({ hasText: new RegExp(`^${title}$`) });
}

function transactionBadge(page: Page) {
  return page.getByText("transaction open", { exact: true });
}

function editorLines(page: Page) {
  return page.locator(".cm-content .cm-line");
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function row(page: Page, name: string | RegExp) {
  return explorer(page).getByRole("treeitem", { name, exact: typeof name === "string" });
}

async function expand(page: Page, name: string): Promise<void> {
  const target = row(page, name);
  await target.click();
  if ((await target.getAttribute("aria-expanded")) !== "true") await page.keyboard.press("ArrowRight");
  await expect.poll(() => target.getAttribute("aria-expanded")).toBe("true");
}

/** Replaces the editor's text; the caret ends after the last character. */
async function typeScript(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
}

async function editorText(page: Page): Promise<string> {
  return (await editorLines(page).allTextContents()).join("\n");
}

/** Runs every statement in the editor (Run All) and waits until the console is idle again. */
async function runAll(page: Page): Promise<void> {
  await runAllButton(page).click();
  await waitUntilReady(page);
}

/** Replaces the editor's text with one row-returning statement, runs it, and returns the grid. */
async function query(page: Page, sql: string) {
  await typeScript(page, sql);
  await runAll(page);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return gridText(page);
}

async function chooseTransactionMode(page: Page, mode: "auto" | "manual"): Promise<void> {
  const select = page.getByLabel("Transaction mode", { exact: true });
  await expect.poll(() => select.isEnabled()).toBe(true);
  await select.selectOption(mode);
  await expect.poll(() => select.inputValue()).toBe(mode);
}

/** Extends the selection by `characters`, one Shift+→ each, as a user would. */
async function selectRight(page: Page, characters: number): Promise<void> {
  for (let typed = 0; typed < characters; typed++) await page.keyboard.press("Shift+ArrowRight");
}

/** Selects from the start of the console's first line through `prefix` at the start of its second. */
async function selectLineOneAndStartOfLineTwo(page: Page, prefix: string): Promise<void> {
  await pressChord(page, "Home");
  await page.keyboard.press("Shift+ArrowDown");
  await selectRight(page, prefix.length);
}

describe.runIf(DATABASES_ENABLED)("SQL console live test", () => {
  let running: RunningApp | null = null;
  let drivingUpdates = 0;

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(async () => {
    await closeRunning();
    const undo = Array.from({ length: drivingUpdates }, () => UNDO_DRIVING_UPDATE);
    drivingUpdates = 0;
    // Every scenario expects the fixture's three tables and its orders, untouched.
    if (!WITHOUT_POSTGRES)
      await asOwner(postgres, POSTGRES_CONFIG, [
        ...undo,
        DELETE_PROBE_ORDER,
        `DROP TABLE IF EXISTS public.${SMOKE_TABLE}`,
        `DROP FUNCTION IF EXISTS ${SMOKE_FUNCTION}(integer, integer)`,
      ]);
    await asOwner(mysql, MYSQL_CONFIG, [DELETE_PROBE_ORDER]);
  });

  async function launch(datasource: Datasource | null, options: LaunchOptions = {}): Promise<Page> {
    running = await launchApp(datasource, options);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenThreeStatementScript_whenTyped_thenHighlightedWithLineNumbers",
    async () => {
      const page = await launch(POSTGRES);

      await typeScript(page, DRIVING_SCRIPT);

      await expect.poll(() => editorLines(page).count()).toBe(3);
      expect(await page.locator(".cm-lineNumbers .cm-gutterElement").allTextContents()).toEqual(
        expect.arrayContaining(["1", "2", "3"]),
      );
      await expect.poll(() => page.evaluate(KEYWORD_IS_COLOURED)).toBe(true);
      await captureWindow(page, "editor-highlighting");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenCaretInSecondStatement_whenModEnter_thenOnlyItRunsAndFlashes",
    async () => {
      const page = await launch(POSTGRES);
      await typeScript(page, DRIVING_SCRIPT);

      await editorLines(page).nth(1).click();
      await pressChord(page, "Enter");
      drivingUpdates++;

      const flash = page.locator(".tc-statement-flash");
      await expect.poll(() => flash.allTextContents()).toEqual(["UPDATE orders SET total = total + 1 WHERE id = 1"]);
      await captureWindow(page, "run-at-caret");
      await waitUntilReady(page);
      await expect.poll(() => outputEntries(page).allTextContents()).toHaveLength(1);
      expect(await outputEntries(page).first().textContent()).toMatch(/UPDATE orders.*1 row affected in \d+ ms/);
      expect(await resultTabs(page).allTextContents()).toEqual(["Output"]);
      await expect.poll(() => flash.count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenAllThreeSelected_whenModEnter_thenOutputLogsThreeAndTwoResultTabsOpen",
    async () => {
      const page = await launch(POSTGRES);
      await typeScript(page, DRIVING_SCRIPT);

      await pressChord(page, "A");
      await pressChord(page, "Enter");
      drivingUpdates++;
      await waitUntilReady(page);

      await expect.poll(() => resultTabs(page).allTextContents()).toEqual(["Output", "Result 1", "Result 2"]);
      expect(await resultTab(page, "Result 2").getAttribute("aria-selected")).toBe("true");
      expect(await resultTab(page, "Result 1").getAttribute("title")).toBe("SELECT * FROM customers");
      expect((await gridText(page)).headers).toEqual(["count"]);
      await resultTab(page, "Output").click();
      const entries = await outputEntries(page).allTextContents();
      expect(entries).toHaveLength(3);
      expect(entries[0]).toMatch(/2 rows retrieved in \d+ ms/);
      expect(entries[1]).toMatch(/1 row affected in \d+ ms/);
      expect(entries[2]).toMatch(/1 row retrieved in \d+ ms/);
      await captureWindow(page, "run-selection");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCommentAndPartOfStatementSelected_whenModEnter_thenOnlySelectedColumnsReturn",
    async () => {
      const page = await launch(MYSQL);
      await typeScript(page, "-- pick one\nSELECT 'b' AS second, 'c' AS third;");

      await selectLineOneAndStartOfLineTwo(page, "SELECT 'b' AS second");
      await pressChord(page, "Enter");
      await waitUntilReady(page);

      await expect.poll(() => resultTabs(page).allTextContents()).toEqual(["Output", "Result 1"]);
      expect(await resultTab(page, "Result 1").getAttribute("title")).toBe("SELECT 'b' AS second");
      expect((await gridText(page)).headers).toEqual(["second"]);
      await captureSelection(page, "run-selection-comment");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSelectionAcrossTwoStatements_whenModEnter_thenEachSelectedPieceRuns",
    async () => {
      const page = await launch(MYSQL);
      await typeScript(page, "SELECT 'a' AS first;\nSELECT 'b' AS second, 'c' AS third;");

      await selectLineOneAndStartOfLineTwo(page, "SELECT 'b' AS second");
      await pressChord(page, "Enter");
      await waitUntilReady(page);

      await expect.poll(() => resultTabs(page).allTextContents()).toEqual(["Output", "Result 1", "Result 2"]);
      expect((await gridText(page)).headers).toEqual(["second"]);
      await resultTab(page, "Result 1").click();
      expect((await gridText(page)).headers).toEqual(["first"]);
      await resultTab(page, "Output").click();
      await expect.poll(() => outputEntries(page).count()).toBe(2);
      await resultTab(page, "Result 2").click();
      await captureSelection(page, "run-selection-partial");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOnlyBlankLineSelected_whenModEnter_thenOutputSaysNothingToRun",
    async () => {
      const page = await launch(MYSQL);
      await typeScript(page, "SELECT 'a' AS first;\n\nSELECT 'b' AS second;");

      await pressChord(page, "Home");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Shift+ArrowDown");
      await pressChord(page, "Enter");
      await waitUntilReady(page);

      await expect.poll(() => outputEntries(page).count()).toBe(1);
      expect(await outputEntries(page).first().textContent()).toMatch(/Nothing to run$/);
      expect(await resultTabs(page).allTextContents()).toEqual(["Output"]);
      await captureSelection(page, "run-selection-empty");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCaretInSecondStatementWithoutSelection_whenModEnter_thenThatStatementRuns",
    async () => {
      const page = await launch(MYSQL);
      await typeScript(page, "SELECT 'a' AS first;\nSELECT 'b' AS second, 'c' AS third;");

      await editorLines(page).nth(1).click();
      await pressChord(page, "Enter");
      await waitUntilReady(page);

      await expect.poll(() => resultTabs(page).allTextContents()).toEqual(["Output", "Result 1"]);
      expect(await resultTab(page, "Result 1").getAttribute("title")).toBe("SELECT 'b' AS second, 'c' AS third");
      expect((await gridText(page)).headers).toEqual(["second", "third"]);
      await captureSelection(page, "run-at-caret");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSelectionLeakingPastStatement_whenExplained_thenPlanIsForTheSelectedText",
    async () => {
      const page = await launch(MYSQL);
      await typeScript(page, "SELECT 1 AS one;\nSELECT * FROM orders WHERE id = 1;");

      await pressChord(page, "Home");
      await page.keyboard.press("End");
      await selectRight(page, "\nSELECT * FROM orders".length);
      await pressChord(page, "Shift+E");

      const plan = resultTab(page, "Plan");
      await plan.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page
        .getByRole("treegrid")
        .locator("tbody")
        .getByRole("row")
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      expect(await plan.getAttribute("title")).toBe("SELECT * FROM orders");
      await captureSelection(page, "explain-selection");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSecondStatementFails_whenRunAll_thenOutputShowsErrorAndThirdSkipped",
    async () => {
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, console: { runAllOnError: "stop" } });
      const page = await launch(MYSQL, { userDataDir });
      await typeScript(page, "SELECT 1 AS one;\nSELECT * FROM no_such_table;\nSELECT 3 AS three;");

      await runAll(page);

      await expect.poll(() => outputEntries(page).count()).toBe(3);
      expect(await outputEntries(page).nth(0).getAttribute("data-tone")).toBe("success");
      expect(await outputEntries(page).nth(1).getAttribute("data-tone")).toBe("error");
      expect(await outputEntries(page).nth(1).textContent()).toContain("no_such_table");
      expect(await outputEntries(page).nth(2).textContent()).toContain("1 statement skipped after the error.");
      expect(await resultTabs(page).allTextContents()).toEqual(["Output", "Result 1"]);
      expect(await resultTab(page, "Output").getAttribute("aria-selected")).toBe("true");
      await captureWindow(page, "batch-stops-on-error");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDeleteWithoutWhere_whenRunAndCancelled_thenConfirmListedItAndNothingRan",
    async () => {
      const page = await launch(MYSQL);
      const before = (await query(page, COUNT_ORDERS)).cells;

      await typeScript(page, "DELETE FROM orders");
      await runAllButton(page).click();

      const dialog = page.getByRole("dialog", { name: "Run a destructive statement?" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.textContent()).toContain("DELETE FROM orders");
      expect(await dialog.textContent()).toContain("DELETE without WHERE");
      await captureWindow(page, "destructive-confirm");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await waitUntilReady(page);

      await expect.poll(() => outputEntries(page).last().textContent()).toContain("Cancelled; nothing ran.");
      expect((await query(page, COUNT_ORDERS)).cells).toEqual(before);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenManualMode_whenInsertThenRollback_thenBadgeShownAndRowGone",
    async () => {
      const page = await launch(POSTGRES);
      await chooseTransactionMode(page, "manual");

      await typeScript(page, INSERT_PROBE_ORDER);
      await runAll(page);
      await expect.poll(() => transactionBadge(page).count()).toBe(1);
      await rollbackButton(page).click();

      await expect.poll(() => transactionBadge(page).count()).toBe(0);
      expect((await query(page, COUNT_PROBE_ORDER)).cells).toEqual(["0"]);
      // In manual mode the SELECT opened a transaction of its own; end it before the evidence.
      await rollbackButton(page).click();
      await expect.poll(() => transactionBadge(page).count()).toBe(0);
      await resultTab(page, "Output").click();
      expect(await outputEntries(page).allTextContents()).toEqual([
        expect.stringMatching(/INSERT INTO orders.*1 row affected/),
        expect.stringContaining("Rolled back"),
        expect.stringMatching(/SELECT count.*1 row retrieved/),
        expect.stringContaining("Rolled back"),
      ]);
      await captureWindow(page, "manual-rollback");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenManualMode_whenInsertThenCommit_thenSecondConsoleSeesTheRow",
    async () => {
      const page = await launch(MYSQL);
      await chooseTransactionMode(page, "manual");
      await typeScript(page, INSERT_PROBE_ORDER);
      await runAll(page);
      await expect.poll(() => transactionBadge(page).count()).toBe(1);

      await openConsoleOn(page, "mysql");
      await expect.poll(() => editorTabs(page).count()).toBe(2);
      await waitUntilReady(page);
      expect((await query(page, COUNT_PROBE_ORDER)).cells).toEqual(["0"]);
      await editorTabs(page).first().click();
      await commitButton(page).click();
      await expect.poll(() => transactionBadge(page).count()).toBe(0);
      await editorTabs(page).nth(1).click();

      expect((await query(page, COUNT_PROBE_ORDER)).cells).toEqual(["1"]);
      await captureWindow(page, "manual-commit");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOpenTransaction_whenConsoleClosed_thenAsksCommitRollbackOrCancel",
    async () => {
      const sqlite: Datasource = { id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
      const page = await launch(sqlite);
      await chooseTransactionMode(page, "manual");
      await typeScript(page, INSERT_PROBE_ORDER);
      await runAll(page);
      await expect.poll(() => transactionBadge(page).count()).toBe(1);

      await pressChord(page, "W");

      const dialog = page.getByRole("dialog", { name: "Open transaction" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.getByRole("button").allTextContents()).toEqual(
        expect.arrayContaining(["Cancel", "Commit", "Rollback"]),
      );
      await captureWindow(page, "close-open-transaction");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      expect(await editorTabs(page).count()).toBe(1);
      expect(await transactionBadge(page).count()).toBe(1);

      await pressChord(page, "W");
      await dialog.getByRole("button", { name: "Rollback", exact: true }).click();
      await expect.poll(() => editorTabs(page).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTypedConsole_whenRelaunched_thenTabAndTextRestoredAndNotConnectedUntilRun",
    async () => {
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [
        { id: "local", name: "local", pluginId: "sqlite", config: { path: seededSqliteFile() } },
      ]);
      let page = await launch(null, { userDataDir });
      await openConsoleOn(page, "local");
      await waitUntilReady(page);
      const sql = "SELECT name FROM customers ORDER BY id";
      await typeScript(page, sql);
      await expect
        .poll(() => readProfileFile(userDataDir, join("consoles", "local", "console.sql")), {
          timeout: AUTOSAVE_WAIT_MS,
        })
        .toBe(sql);
      await closeRunning();

      page = await launch(null, { userDataDir });

      await expect.poll(() => editorTabs(page).allTextContents()).toEqual(["console [local]"]);
      await expect.poll(() => editorText(page)).toBe(sql);
      expect(await treeNode(page, "local").getAttribute("data-state")).toBe("disconnected");
      expect(await enginePids((running as RunningApp).app)).toEqual([]);
      await captureWindow(page, "autosave-restored");
      await runAll(page);
      await expect.poll(async () => (await gridText(page)).cells).toEqual(["Ada Lovelace", "Grace Hopper"]);
      expect(await treeNode(page, "local").getAttribute("data-state")).toBe("connected");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDollarQuotedFunctionBody_whenRunAll_thenRunsAsOneStatement",
    async () => {
      const page = await launch(POSTGRES);
      await typeScript(page, DOLLAR_QUOTED_SCRIPT);

      await runAll(page);

      await expect.poll(async () => (await gridText(page)).cells).toEqual(["5"]);
      await resultTab(page, "Output").click();
      const entries = await outputEntries(page).allTextContents();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatch(/CREATE OR REPLACE FUNCTION.*in \d+ ms/);
      await editorLines(page).first().click();
      await captureWindow(page, "dollar-quoted");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenAutoMode_whenCreateTable_thenTreeShowsItWithoutSynchronize",
    async () => {
      const page = await launch(POSTGRES);
      await row(page, "tables 6").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expand(page, "tables 6");
      await sqlEditor(page).click();

      await typeScript(page, `CREATE TABLE ${SMOKE_TABLE} (id integer PRIMARY KEY)`);
      await runAll(page);

      await expect.poll(() => row(page, SMOKE_TABLE).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);
      expect(await row(page, "tables 7").count()).toBe(1);
      await captureWindow(page, "ddl-refreshes-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrdersInTree_whenDraggedIntoEditor_thenQualifiedNameInsertedAtDrop",
    async () => {
      const page = await launch(POSTGRES);
      await row(page, "tables 6").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expand(page, "tables 6");
      await typeScript(page, "SELECT * FROM ");

      await row(page, "orders").dragTo(editorLines(page).first(), { targetPosition: { x: 400, y: 5 } });

      await expect.poll(() => editorText(page)).toBe('SELECT * FROM "public"."orders"');
      await captureWindow(page, "drag-qualified-name");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLongQuery_whenRun_thenRunRunAllAndTitleBarRunSpin",
    async () => {
      const page = await launch(IN_MEMORY_SQLITE);
      await typeScript(page, LONG_QUERY);

      await pressChord(page, "Enter");

      for (const button of [runButton(page), runAllButton(page), mainToolbarButton(page, "Run")]) {
        await waitUntilSpinning(button);
        expect(await button.isEnabled()).toBe(false);
        expect(await computedOpacity(button)).toBe("1");
      }
      expect(await runButton(page).getAttribute("aria-label")).toBe("Run");
      await captureSpinner(page, "01-spinning");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFastQuery_whenRun_thenRunNeverSpins",
    async () => {
      const page = await launch(IN_MEMORY_SQLITE);
      await typeScript(page, "SELECT 1 AS one");
      await page.evaluate(WATCH_BUSY);

      await pressChord(page, "Enter");
      await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      await page.waitForTimeout(PAST_SPINNER_DELAY_MS);

      expect(await page.evaluate(BUSY_SEEN)).toBe(false);
      expect(await runButton(page).isEnabled()).toBe(true);
      expect((await iconSpin(runButton(page))).name).toBe("none");
      await captureSpinner(page, "02-fast");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMotionOff_whenLongQueryRuns_thenRunSpinnerShownButPaused",
    async () => {
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, appearance: { motion: "off" } });
      const page = await launch(IN_MEMORY_SQLITE, { userDataDir });
      await typeScript(page, LONG_QUERY);

      await pressChord(page, "Enter");

      await expect.poll(() => runButton(page).getAttribute("aria-busy"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("true");
      expect(await iconSpin(runButton(page))).toEqual({ name: "spin", state: "paused" });
      expect(await iconSpin(runAllButton(page))).toEqual({ name: "spin", state: "paused" });
      await captureSpinner(page, "04-off");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPinnedResult_whenRunAgain_thenPinnedStaysAndOthersReplaced",
    async () => {
      const sqlite: Datasource = { id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
      const page = await launch(sqlite);
      await typeScript(page, "SELECT 1 AS first;\nSELECT 2 AS second;");
      await runAll(page);
      await expect.poll(() => resultTabs(page).allTextContents()).toEqual(["Output", "Result 1", "Result 2"]);

      await page.getByRole("button", { name: "Pin Result 1", exact: true }).click();
      await typeScript(page, "SELECT 3 AS third;");
      await runAll(page);

      await expect.poll(() => resultTabs(page).allTextContents()).toEqual(["Output", "Result 1", "Result 2"]);
      expect((await gridText(page)).headers).toEqual(["third"]);
      await resultTab(page, "Result 1").click();
      expect((await gridText(page)).headers).toEqual(["first"]);
      expect(await page.getByRole("button", { name: "Unpin Result 1", exact: true }).getAttribute("aria-pressed")).toBe(
        "true",
      );
      await captureWindow(page, "pinned-result");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenTreeAndEditor_whenEscapeAndCollapseAllPressed_thenEachGoesToItsOwner",
    async () => {
      const page = await launch(POSTGRES);
      await row(page, "tables 6").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await row(page, "public").click();
      await page.keyboard.type("ord");
      const speedSearch = explorer(page).getByRole("status", { name: "Speed search" });
      await expect.poll(() => speedSearch.count()).toBe(1);

      await page.keyboard.press("Escape");
      await expect.poll(() => speedSearch.count()).toBe(0);

      await sqlEditor(page).click();
      await page.keyboard.type("SEL");
      const completion = page.locator(".cm-tooltip-autocomplete");
      await expect.poll(() => completion.count()).toBe(1);
      await captureWindow(page, "keys-coexist");
      await page.keyboard.press("Escape");
      await expect.poll(() => completion.count()).toBe(0);
      expect(await page.evaluate(FOCUSED_IN_EDITOR)).toBe(true);
      expect(await editorText(page)).toBe("SEL");

      await row(page, "public").click();
      await pressChord(page, "-");
      await expect.poll(() => row(page, "public").count()).toBe(0);
      expect(await activeEditorTab(page).textContent()).toBe("console [pg]");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
