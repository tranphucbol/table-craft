/**
 * Plan 011's live test: query history, the Services session tree and reopening closed consoles
 * against PostgreSQL, MySQL and SQLite, from the `test/db/compose.yml` databases and seeded SQLite
 * files. Gated, because it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/011 bun run test:smoke:db
 *
 * History is kept only for saved datasources (decision 030), so the history scenarios seed
 * `datasources.json`; the Services ones run on the ephemeral datasource. The one scenario that
 * writes puts `orders` back.
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  sqlEditor,
  startStatement,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
  showServices,
} from "./harness.js";
import { applyFilter } from "./workflows.js";

const captureWindow = evidenceFor("011");
const capture014 = evidenceFor("014");

const PASSWORD = POSTGRES_CONFIG.password;
const { password: _postgresPassword, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;
const { password: _mysqlPassword, ...MYSQL_PLAIN } = MYSQL_CONFIG;

const SAVED_POSTGRES: SavedDatasource = {
  id: "pg",
  name: "pg",
  pluginId: "postgres",
  config: { ...POSTGRES_PLAIN, sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};
const SAVED_MYSQL: SavedDatasource = {
  id: "mysql",
  name: "mysql",
  pluginId: "mysql",
  config: { ...MYSQL_PLAIN, sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};

function savedSqlite(): SavedDatasource {
  return { id: "sqlite", name: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const TABLES_GROUP = "tables 6";
/** Console text autosaves after a pause (plan 004); the scenario that closes a console waits it out. */
const AUTOSAVE_WAIT_MS = 5_000;

const CUSTOMERS_SQL = "SELECT * FROM customers ORDER BY id";
const ORDERS_SQL = "SELECT * FROM orders ORDER BY id";
const ORDER_COUNT_SQL = "SELECT count(*) AS n FROM orders";
const THREE_STATEMENTS = [CUSTOMERS_SQL, ORDERS_SQL, ORDER_COUNT_SQL];
const SLEEP_SQL = "SELECT pg_sleep(2)";
/** More rows than one page (500), so the first answer leaves the cursor open. */
const PAGING_SQL = "SELECT g AS n FROM generate_series(1, 5000) g";
const RESTORE_ORDER_ONE = "UPDATE orders SET total = 19.99 WHERE id = 1";
const TIME_OF_DAY = /\d{2}:\d{2}:\d{2}/;
const DURATION = /\d+ ms|\d+\.\d s/;

async function restoreOrders(): Promise<void> {
  const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
  try {
    const result = await session.execute(RESTORE_ORDER_ONE);
    for await (const _row of result.rows) {
      // Drained so the statement completes before the session closes.
    }
  } finally {
    await session.close();
  }
}

function historyDialog(page: Page, datasource: string) {
  return page.getByRole("dialog", { name: `Query History: ${datasource}` });
}

function historyEntries(page: Page, datasource: string) {
  return historyDialog(page, datasource).getByRole("option");
}

function entryLabels(page: Page, datasource: string): Promise<(string | null)[]> {
  return ariaLabels(historyEntries(page, datasource));
}

async function linesOf(page: Page, testId: string): Promise<string> {
  return (await page.getByTestId(testId).locator(".cm-line").allTextContents()).join("\n");
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

function services(page: Page) {
  return toolWindow(page, "Services");
}

function serviceRow(page: Page, kind: "datasource" | "session" | "execution") {
  return services(page).locator(`[role="treeitem"][data-kind="${kind}"]`);
}

function treeRow(page: Page, name: string) {
  return toolWindow(page, "Database").getByRole("treeitem", { name, exact: true });
}

async function openTable(page: Page, name: string): Promise<void> {
  const group = treeRow(page, TABLES_GROUP);
  await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
    await page.keyboard.press("ArrowRight");
  }
  await treeRow(page, name).click();
  await page.keyboard.press("F4");
  await expect.poll(() => activeEditorTab(page).textContent()).toContain(name);
  await tableCell(page, 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

function tableCell(page: Page, row: number, column: number) {
  return page
    .getByTestId("table-editor")
    .locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

/** Runs `statements` as one Run All and waits until Services shows each of them succeeded. */
async function runScript(page: Page, statements: readonly string[]): Promise<void> {
  const succeeded = serviceRow(page, "execution").and(page.locator('[data-state="success"]'));
  const before = await succeeded.count();
  await startStatement(page, statements.map((sql) => `${sql};`).join("\n"));
  await expect.poll(() => succeeded.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(before + statements.length);
  await waitUntilReady(page);
}

async function ariaLabels(rows: Locator): Promise<(string | null)[]> {
  const labels: (string | null)[] = [];
  for (const row of await rows.all()) labels.push(await row.getAttribute("aria-label"));
  return labels;
}

describe.runIf(DATABASES_ENABLED)("query history and Services live test", () => {
  let running: RunningApp | null = null;

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(closeRunning, CLOSE_HOOK_TIMEOUT_MS);

  /** Launches on the profile's saved datasources only. */
  async function launchSaved(userDataDir: string): Promise<Page> {
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await showServices(running.page);
    return running.page;
  }

  async function launchWith(datasources: readonly SavedDatasource[]): Promise<Page> {
    const userDataDir = newProfile();
    seedDatasources(userDataDir, datasources);
    return launchSaved(userDataDir);
  }

  async function launchEphemeral(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await showServices(running.page);
    return running.page;
  }

  /** Opens a console on the saved datasource `name`, typing its password when it has one. */
  async function consoleOn(page: Page, name: string): Promise<void> {
    await openConsoleOn(page, name);
    if (name !== "sqlite") await answerSecretPrompt(page, name, PASSWORD);
    await waitUntilReady(page);
  }

  /** Opens Query History with ⌘⌥E and waits for its first answer. */
  async function openHistory(page: Page, datasource: string): Promise<void> {
    await pressChord(page, "Alt+E");
    await historyDialog(page, datasource).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect
      .poll(
        async () =>
          (await historyEntries(page, datasource).count()) +
          (await historyDialog(page, datasource)
            .getByText(/^No statements yet\.$|^Nothing matches\.$/)
            .count()),
      )
      .toBeGreaterThan(0);
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenThreeStatementsRun_whenQueryHistoryOpened_thenNewestFirstWithTimeDurationRowsAndOutcome",
    async () => {
      const page = await launchWith([SAVED_POSTGRES]);
      await consoleOn(page, "pg");
      await runScript(page, THREE_STATEMENTS);

      await openHistory(page, "pg");

      expect(await entryLabels(page, "pg")).toEqual([ORDER_COUNT_SQL, ORDERS_SQL, CUSTOMERS_SQL]);
      const first = historyEntries(page, "pg").first();
      expect(await first.textContent()).toMatch(new RegExp(`1 row.*(${DURATION.source}).*${TIME_OF_DAY.source}`));
      expect(await historyEntries(page, "pg").nth(1).textContent()).toContain("3 rows");
      expect(await first.locator('[data-outcome="success"]').count()).toBe(1);
      expect(await linesOf(page, "history-preview")).toBe(ORDER_COUNT_SQL);
      await captureWindow(page, "history-dialog");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenHistory_whenSearchingOrders_thenOnlyMatchingStatementsListed",
    async () => {
      const page = await launchWith([SAVED_POSTGRES]);
      await consoleOn(page, "pg");
      await runScript(page, THREE_STATEMENTS);
      await openHistory(page, "pg");

      await historyDialog(page, "pg").getByRole("combobox", { name: "Search history" }).fill("ORDERS");

      await expect.poll(() => entryLabels(page, "pg")).toEqual([ORDER_COUNT_SQL, ORDERS_SQL]);
      await captureWindow(page, "history-search");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenHistoryEntry_whenEnterPressedInAConsole_thenInsertedAtCaretAndRunnable",
    async () => {
      const page = await launchWith([SAVED_POSTGRES]);
      await consoleOn(page, "pg");
      await runScript(page, THREE_STATEMENTS);
      await sqlEditor(page).fill("");
      await openHistory(page, "pg");
      const search = historyDialog(page, "pg").getByRole("combobox", { name: "Search history" });
      await search.fill("customers");
      await expect.poll(() => entryLabels(page, "pg")).toEqual([CUSTOMERS_SQL]);

      await search.press("Enter");

      await historyDialog(page, "pg").waitFor({ state: "detached" });
      await expect.poll(() => editorText(page)).toBe(CUSTOMERS_SQL);
      await pressChord(page, "Enter");
      await expect.poll(async () => (await gridText(page)).headers).toContain("email");
      expect((await gridText(page)).cells).toContain("Ada Lovelace");
      await captureWindow(page, "history-insert");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlHistory_whenRelaunched_thenStatementsStillListed",
    async () => {
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [SAVED_MYSQL]);
      let page = await launchSaved(userDataDir);
      await consoleOn(page, "mysql");
      await runStatement(page, CUSTOMERS_SQL);
      await runStatement(page, ORDER_COUNT_SQL);
      await closeRunning();

      page = await launchSaved(userDataDir);
      // The restored console's editor focuses itself when it mounts, which can land after the tree
      // click; the dialog would then offer Insert rather than Open in Console.
      await waitUntilReady(page);
      await treeNode(page, "mysql").click();
      await openHistory(page, "mysql");

      expect(await entryLabels(page, "mysql")).toEqual([ORDER_COUNT_SQL, CUSTOMERS_SQL]);
      expect(await historyDialog(page, "mysql").getByRole("button", { name: "Open in Console" }).count()).toBe(1);
      await captureWindow(page, "history-persists");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenSqliteStatementFailed_whenQueryHistoryOpened_thenErrorOutcomeAndMessage",
    async () => {
      const page = await launchWith([savedSqlite()]);
      await consoleOn(page, "sqlite");
      await runStatement(page, "SELECT name FROM customers ORDER BY id");
      await runStatement(page, "SELECT * FROM no_such_table");

      await openHistory(page, "sqlite");

      const failed = historyEntries(page, "sqlite").first();
      expect(await failed.getAttribute("aria-label")).toBe("SELECT * FROM no_such_table");
      expect(await failed.locator('[data-outcome="error"]').count()).toBe(1);
      expect(await page.getByTestId("history-message").textContent()).toContain("no such table");
      await captureWindow(page, "history-error");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlHistory_whenOpenedFromTheDatasourceMenu_thenEnterOpensANewConsoleWithTheText",
    async () => {
      const page = await launchWith([SAVED_MYSQL]);
      await consoleOn(page, "mysql");
      await runStatement(page, CUSTOMERS_SQL);
      await sqlEditor(page).fill("");

      await treeNode(page, "mysql").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Query History…/ }).click();
      await historyDialog(page, "mysql").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => entryLabels(page, "mysql")).toEqual([CUSTOMERS_SQL]);
      expect(await historyDialog(page, "mysql").getByRole("button", { name: "Open in Console" }).count()).toBe(1);
      await page.keyboard.press("Enter");

      await expect.poll(() => editorTabs(page).allTextContents()).toEqual(["console [mysql]", "console_1 [mysql]"]);
      expect(await activeEditorTab(page).textContent()).toBe("console_1 [mysql]");
      await expect.poll(() => editorText(page)).toBe(CUSTOMERS_SQL);
      await waitUntilReady(page);
      await captureWindow(page, "history-from-pane");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenTableSubmitted_whenQueryHistoryOpened_thenTheGeneratedScriptIsOneEntry",
    async () => {
      const page = await launchWith([SAVED_POSTGRES]);
      try {
        await consoleOn(page, "pg");
        await openTable(page, "orders");
        await applyFilter(page, "", "id");
        await expect.poll(() => tableCell(page, 0, 0).textContent()).toBe("1");
        await tableCell(page, 0, 2).click();
        await page.keyboard.press("Enter");
        const field = page.getByTestId("table-editor").locator("[data-editing] input");
        await field.fill("25.00");
        await field.press("Enter");
        await page.getByTestId("table-editor").getByRole("button", { name: "Submit", exact: true }).click();
        await expect.poll(() => page.getByTestId("table-notice").textContent()).toBe("Submitted 1 statement");

        await openHistory(page, "pg");

        const script = `UPDATE "public"."orders" SET "total" = '25.00' WHERE "id" = 1;`;
        expect(await entryLabels(page, "pg")).toEqual([script]);
        expect(await linesOf(page, "history-preview")).toBe(script);
        expect(await historyEntries(page, "pg").first().textContent()).toContain("1 row");
        await captureWindow(page, "history-table-submit");
      } finally {
        await restoreOrders();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenConsoleAndTableTabs_whenServicesShown_thenSessionsUnderTheDatasourceWithExecutions",
    async () => {
      const page = await launchEphemeral(POSTGRES);
      await runScript(page, [CUSTOMERS_SQL, ORDER_COUNT_SQL]);
      await openTable(page, "orders");

      await expect.poll(() => ariaLabels(serviceRow(page, "session"))).toEqual(["console, idle", "orders, idle"]);
      expect(await serviceRow(page, "datasource").getAttribute("aria-label")).toBe("pg");
      await expect
        .poll(() => ariaLabels(serviceRow(page, "execution")))
        .toEqual([`${ORDER_COUNT_SQL}, success`, `${CUSTOMERS_SQL}, success`, "Load rows, success"]);
      expect(await serviceRow(page, "execution").first().textContent()).toMatch(
        new RegExp(`1 row.*(${DURATION.source}).*${TIME_OF_DAY.source}`),
      );
      expect(await serviceRow(page, "execution").nth(1).textContent()).toContain("2 rows");
      await captureWindow(page, "services-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenSleepRunning_whenServicesShown_thenElapsedTicksThenSuccessInAboutTwoSeconds",
    async () => {
      const page = await launchEphemeral(POSTGRES);

      await startStatement(page, SLEEP_SQL);

      const execution = serviceRow(page, "execution").first();
      await expect.poll(() => execution.getAttribute("data-state")).toBe("running");
      expect(await serviceRow(page, "session").getAttribute("data-state")).toBe("running");
      const duration = execution.getByTestId("execution-duration");
      await expect.poll(() => duration.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/^1\.\d{3} s$/);
      await captureWindow(page, "services-running");
      await expect.poll(() => execution.getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("success");
      expect(await duration.textContent()).toMatch(/^2\.\d s$/);
      expect(await serviceRow(page, "session").getAttribute("data-state")).toBe("idle");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoSqliteConsoles_whenTheFirstSessionClicked_thenItsTabIsActive",
    async () => {
      const page = await launchEphemeral(sqlite());
      await runStatement(page, "SELECT name FROM customers ORDER BY id");
      await pressChord(page, "Shift+L");
      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console_1 [lite]");
      await waitUntilReady(page);

      await services(page)
        .getByRole("treeitem", { name: /^console,/ })
        .click();

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console [lite]");
      await expect.poll(async () => (await gridText(page)).cells).toEqual(["Ada Lovelace", "Grace Hopper"]);
      expect(await serviceRow(page, "session").first().getAttribute("aria-selected")).toBe("true");
      await captureWindow(page, "services-activate");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlConsoleClosedWithText_whenOpenClosedConsole_thenListedWithPreviewAndRestored",
    async () => {
      const page = await launchWith([SAVED_MYSQL]);
      await consoleOn(page, "mysql");
      await pressChord(page, "Shift+L");
      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console_1 [mysql]");
      await waitUntilReady(page);
      const kept = `-- kept for later\n${ORDERS_SQL}`;
      await sqlEditor(page).fill(kept);
      await expect.poll(() => editorText(page)).toBe(kept);
      await pressChord(page, "W");
      await expect.poll(() => editorTabs(page).allTextContents()).toEqual(["console [mysql]"]);

      await treeNode(page, "mysql").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Open Closed Console…/ }).click();

      const picker = page.getByRole("dialog", { name: "Open Closed Console: mysql" });
      await picker.waitFor({ timeout: AUTOSAVE_WAIT_MS });
      await expect.poll(() => ariaLabels(picker.getByRole("option"))).toEqual(["console_1"]);
      await expect.poll(() => linesOf(page, "closed-console-preview")).toBe(kept);
      await captureWindow(page, "reopen-console");
      await page.keyboard.press("Enter");

      await expect.poll(() => editorTabs(page).allTextContents()).toEqual(["console [mysql]", "console_1 [mysql]"]);
      expect(await activeEditorTab(page).textContent()).toBe("console_1 [mysql]");
      await expect.poll(() => editorText(page)).toBe(kept);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteHistory_whenClearHistoryConfirmed_thenTheListIsEmpty",
    async () => {
      const page = await launchWith([savedSqlite()]);
      await consoleOn(page, "sqlite");
      await runStatement(page, "SELECT name FROM customers ORDER BY id");
      await openHistory(page, "sqlite");
      expect(await historyEntries(page, "sqlite").count()).toBe(1);

      await historyDialog(page, "sqlite").getByRole("button", { name: "Clear History…" }).click();
      const confirm = page.getByRole("dialog", { name: "Clear Query History" });
      await confirm.waitFor();
      expect(await confirm.textContent()).toContain("Clear the query history of sqlite? This cannot be undone.");
      await confirm.getByRole("button", { name: "Clear", exact: true }).click();

      await historyDialog(page, "sqlite").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect
        .poll(() => historyDialog(page, "sqlite").getByText("No statements yet.", { exact: true }).count())
        .toBe(1);
      expect(await historyEntries(page, "sqlite").count()).toBe(0);
      await captureWindow(page, "history-cleared");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEphemeralDatasource_whenRunAndQueryHistoryOpened_thenNothingRecorded",
    async () => {
      const page = await launchEphemeral(sqlite());
      await runStatement(page, "SELECT name FROM customers ORDER BY id");

      await openHistory(page, "lite");

      expect(await historyEntries(page, "lite").count()).toBe(0);
      expect(await historyDialog(page, "lite").getByText("No statements yet.", { exact: true }).count()).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  /*
   * Plan 014's loose ends (decision 18 b–d): what Services and the history say after Fetch All, a
   * confirmation and a failed submit. Their evidence belongs to plan 014.
   */

  it.skipIf(WITHOUT_POSTGRES)(
    "givenFetchAll_whenFinished_thenServicesRowShowsAllRows",
    async () => {
      const page = await launchEphemeral(POSTGRES);
      await startStatement(page, PAGING_SQL);
      const execution = serviceRow(page, "execution").first();
      await expect.poll(() => execution.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/(^|\D)500 rows/);

      await page
        .getByRole("toolbar", { name: "Result" })
        .getByRole("button", { name: "Fetch All", exact: true })
        .click();

      await expect.poll(() => execution.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("5000 rows");
      await expect.poll(() => page.getByTestId("result-state").textContent()).toBe("5,000 rows");
      await capture014(page, "services-fetch-all");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDestructiveConfirmOpen_whenStatusRead_thenWaitingForConfirmation",
    async () => {
      const page = await launchEphemeral(sqlite());
      await startStatement(page, "DELETE FROM orders");
      const confirm = page.getByRole("dialog", { name: "Run a destructive statement?" });
      await confirm.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      expect(await page.getByTestId("console").getByText("Waiting for confirmation…", { exact: true }).count()).toBe(1);
      // The open dialog hides the window from the accessibility tree, so these rows are found by CSS.
      const behindDialog = page.locator('section[aria-label="Services"] [role="treeitem"]');
      expect(await ariaLabels(behindDialog.and(page.locator('[data-kind="session"]')))).toEqual([
        "console, waiting for confirmation…",
      ]);
      expect(await behindDialog.and(page.locator('[data-kind="execution"]')).count()).toBe(0);
      await capture014(page, "waiting-confirm");

      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => ariaLabels(serviceRow(page, "session"))).toEqual(["console, idle"]);
      expect(await page.getByTestId("console").getByText("Waiting for confirmation…", { exact: true }).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenTableSubmitFails_whenHistoryOpened_thenErrorEntryWithScript",
    async () => {
      const page = await launchWith([SAVED_POSTGRES]);
      await consoleOn(page, "pg");
      await openTable(page, "orders");
      await applyFilter(page, "", "id");
      await expect.poll(() => tableCell(page, 0, 0).textContent()).toBe("1");
      await tableCell(page, 0, 2).click();
      await page.keyboard.press("Enter");
      const field = page.getByTestId("table-editor").locator("[data-editing] input");
      await field.fill("-1");
      await field.press("Enter");
      await page.getByTestId("table-editor").getByRole("button", { name: "Submit", exact: true }).click();
      // orders_total_nonnegative refuses it, so nothing changes and nothing needs restoring.
      await expect
        .poll(() => page.getByTestId("table-error").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("orders_total_nonnegative");

      await openHistory(page, "pg");

      const script = `UPDATE "public"."orders" SET "total" = '-1' WHERE "id" = 1;`;
      expect(await entryLabels(page, "pg")).toEqual([script]);
      expect(await historyEntries(page, "pg").first().locator('[data-outcome="error"]').count()).toBe(1);
      expect(await linesOf(page, "history-preview")).toBe(script);
      await capture014(page, "history-failed-submit");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
