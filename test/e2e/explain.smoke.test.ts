/**
 * Plan 012's live test: Explain Plan and Explain Analyse against PostgreSQL, MySQL and SQLite, from
 * the `test/db/compose.yml` databases and a seeded SQLite file. Gated, because it needs a display, a
 * fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/012 bun run test:smoke:db
 *
 * The scenarios that analyse or refuse a write check `orders` afterwards; every scenario puts
 * `orders` back regardless, so a failure leaves the fixture as the next suite expects it.
 */
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  cornerRadius,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  paletteInput,
  paletteRows,
  pressChord,
  rollbackButton,
  runAllButton,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  sqlEditor,
  toolWindow,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
  waitUntilReady,
  chooseOption,
  optionValue,
  showServices,
} from "./harness.js";

const captureWindow = evidenceFor("012");
const dropdownEvidence = evidenceFor("129");
/** More than a row's height, so a row and its time bar sit under the header. */
const PLAN_SCROLL_PX = 40;
/** The header's bottom line, where a time bar hangs from its cell. */
const HEADER_EDGE_PX = 2;

/** The members the plan header check touches; the e2e program has no DOM lib. */
interface Scrollable {
  scrollTop: number;
}

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const { password: _postgresPassword, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;
const SAVED_POSTGRES: SavedDatasource = {
  id: "pg",
  name: "pg",
  pluginId: "postgres",
  config: { ...POSTGRES_PLAIN, sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};

const JOIN_SQL = "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 10";
/** Four joins in one plan: more rows than the result pane shows, so the tree scrolls. */
const TALL_PLAN_SQL = Array.from({ length: 4 }, () => JOIN_SQL).join(" UNION ALL ");
/**
 * PostgreSQL picks a nested loop once autovacuum has analysed the three-row fixtures and a hash
 * join on a freshly seeded container, which estimates rows from pages.
 */
const JOIN_NODE_TYPE = /"Node Type": "(Nested Loop|Hash Join|Merge Join)"/;
const TOUCH_ORDER_ONE = "UPDATE orders SET total = total WHERE id = 1";
const ZERO_ORDER_ONE = "UPDATE orders SET total = 0 WHERE id = 1";
const ORDER_ONE_TOTAL = "SELECT total FROM orders WHERE id = 1";
const ORDER_ONE_TOTAL_VALUE = "19.99";
const RESTORE_ORDER_ONE = `UPDATE orders SET total = ${ORDER_ONE_TOTAL_VALUE} WHERE id = 1`;
const COUNT_ORDERS = "SELECT count(*) AS n FROM orders";
const ORDER_COUNT = "3";
const ANALYSE_DELETE = "EXPLAIN ANALYZE DELETE FROM orders";
const CREATE_TABLE = "CREATE TABLE t (id int)";

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

/** The first cell of `sql`'s first row, read outside the app. */
async function firstCell(plugin: DatasourcePlugin, config: unknown, sql: string): Promise<string> {
  const session = await plugin.connect(config, { readOnly: true });
  try {
    const result = await session.execute(sql);
    let value: unknown = null;
    for await (const row of result.rows) {
      value ??= row[0];
    }
    return typeof value === "object" && value !== null && "text" in value ? String(value.text) : String(value);
  } finally {
    await session.close();
  }
}

function explainButton(page: Page) {
  return page.getByRole("button", { name: "Explain Plan", exact: true });
}

function analyseButton(page: Page) {
  return page.getByRole("button", { name: "Explain Analyse", exact: true });
}

function resultTabs(page: Page) {
  return page.getByRole("tablist", { name: "Results" }).getByRole("tab");
}

function resultTab(page: Page, title: string) {
  return resultTabs(page).filter({ hasText: new RegExp(`^${title.replace(/[()]/g, "\\$&")}$`) });
}

function outputEntries(page: Page) {
  return page.getByRole("log", { name: "Output" }).locator("[data-tone]");
}

function planTree(page: Page) {
  return page.getByRole("treegrid");
}

function planRows(page: Page) {
  return planTree(page).locator("tbody").getByRole("row");
}

/** Each column of the plan tree, by header, as the text of its cells top to bottom. */
async function planColumns(page: Page): Promise<Record<string, string[]>> {
  const headers = await planTree(page).locator("thead th").allTextContents();
  const columns: Record<string, string[]> = {};
  for (const [index, header] of headers.entries()) {
    columns[header] = await planRows(page)
      .locator(`td:nth-child(${String(index + 1)})`)
      .allTextContents();
  }
  return columns;
}

function transactionBadge(page: Page) {
  return page.getByText("transaction open", { exact: true });
}

async function chooseTransactionMode(page: Page, mode: "auto" | "manual"): Promise<void> {
  const select = page.getByLabel("Transaction mode", { exact: true });
  await expect.poll(() => select.isEnabled()).toBe(true);
  await chooseOption(select, mode);
  await expect.poll(() => optionValue(select)).toBe(mode);
}

/** Replaces the console's text; the caret ends after the last character, inside the statement. */
async function typeStatement(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect
    .poll(async () => (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n"))
    .toBe(sql);
}

/** Waits for a plan tab titled `title` to show its tree. */
async function planShown(page: Page, title: string): Promise<void> {
  await resultTab(page, title).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await planRows(page).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await waitUntilReady(page);
}

/** Whether `inner` ends at or before `outer`'s right edge, so none of it is cut off or scrolled away. */
async function rightEdgeWithin(inner: Locator, outer: Locator): Promise<boolean> {
  const [innerBox, outerBox] = await Promise.all([inner.boundingBox(), outer.boundingBox()]);
  if (innerBox === null || outerBox === null) return false;
  return innerBox.x + innerBox.width <= outerBox.x + outerBox.width + 1;
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

describe.runIf(DATABASES_ENABLED)("Explain Plan and Explain Analyse live test", () => {
  let running: RunningApp | null = null;

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(async () => {
    await closeRunning();
    if (!WITHOUT_POSTGRES)
      await asOwner(postgres, POSTGRES_CONFIG, [RESTORE_ORDER_ONE, "DROP TABLE IF EXISTS public.t"]);
    await asOwner(mysql, MYSQL_CONFIG, [RESTORE_ORDER_ONE]);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  /** Types the join and presses ⇧⌘E in the editor. */
  async function explainJoin(page: Page): Promise<void> {
    await typeStatement(page, JOIN_SQL);
    await pressChord(page, "Shift+E");
    await planShown(page, "Plan");
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenJoinOnPostgres_whenShiftModE_thenPlanTabWithOperationsRowsAndCost",
    async () => {
      const page = await launch(POSTGRES);

      await explainJoin(page);

      expect(await resultTabs(page).allTextContents()).toEqual(["Output", "Plan"]);
      expect(await resultTab(page, "Plan").getAttribute("aria-selected")).toBe("true");
      const columns = await planColumns(page);
      expect(Object.keys(columns)).toEqual(["Operation", "Rows (est.)", "Cost (est.)"]);
      expect(columns["Operation"]?.length).toBeGreaterThan(1);
      expect(columns["Operation"]?.join("\n")).toMatch(/orders o/);
      expect(columns["Rows (est.)"]?.every((cell) => /^\d/.test(cell))).toBe(true);
      expect(columns["Cost (est.)"]?.every((cell) => /^\d/.test(cell))).toBe(true);
      expect(await page.getByTestId("plan-bar").count()).toBeGreaterThan(0);
      expect(await page.getByTestId("plan-banner").count()).toBe(0);
      await captureWindow(page, "plan-pg");
      await resultTab(page, "Output").click();
      expect(await outputEntries(page).last().textContent()).toMatch(/Explained in \d+ ms/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenJoinOnMysql_whenShiftModE_thenTreeReadFromFormatTree",
    async () => {
      const page = await launch(MYSQL);

      await explainJoin(page);

      const columns = await planColumns(page);
      expect(columns["Operation"]?.[0]).toContain("Nested loop inner join");
      expect(columns["Operation"]?.join("\n")).toMatch(/Table scan on o/);
      expect(columns["Cost (est.)"]?.every((cell) => /^\d/.test(cell))).toBe(true);
      expect(await planRows(page).nth(1).getAttribute("aria-level")).toBe("2");
      // Regressions: a long MySQL operation pushed the numbers out of view, and the extra toolbar
      // buttons pushed the datasource name past the window's edge.
      expect(
        await rightEdgeWithin(
          planTree(page).getByRole("columnheader", { name: "Cost (est.)" }),
          planTree(page).locator(".."),
        ),
      ).toBe(true);
      expect(await rightEdgeWithin(page.getByTestId("console-datasource"), page.getByTestId("console"))).toBe(true);
      await page.getByRole("button", { name: "Raw", exact: true }).click();
      await expect
        .poll(() => page.getByTestId("plan-raw").locator(".cm-line").first().textContent())
        .toContain("-> Nested loop inner join");
      await page.getByRole("button", { name: "Tree", exact: true }).click();
      await planRows(page).first().waitFor();
      await captureWindow(page, "plan-mysql");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAnalysedPlanScrolled_whenHeaderHitTested_thenHeaderOnTop",
    async () => {
      const page = await launch(MYSQL);
      const mode = page.getByLabel("Transaction mode", { exact: true });
      expect(await cornerRadius(mode)).toBe("0px");
      await expect.poll(() => mode.isEnabled()).toBe(true);
      await mode.click();
      await page.getByRole("listbox").getByRole("option", { name: "Tx: Manual" }).waitFor();
      await dropdownEvidence(page, "05-tx-mode");
      await page.keyboard.press("Escape");
      await page.getByRole("listbox").waitFor({ state: "hidden" });
      await typeStatement(page, TALL_PLAN_SQL);
      await sqlEditor(page).press("Escape");

      await analyseButton(page).click();
      await planShown(page, "Plan (analysed)");
      const scroller = planTree(page).locator("..");
      await scroller.evaluate((element: Scrollable, top) => {
        element.scrollTop = top;
      }, PLAN_SCROLL_PX);
      await expect.poll(() => scroller.evaluate((element: Scrollable) => element.scrollTop)).toBeGreaterThan(0);

      for (const name of ["Rows (est.)", "Time (ms)"]) {
        const box = await planTree(page).getByRole("columnheader", { name }).boundingBox();
        if (box === null) throw new Error(`The ${name} header is not on screen.`);
        const x = box.x + box.width / 2;
        const y = box.y + box.height - HEADER_EDGE_PX;
        expect(
          await page.evaluate(`document.elementFromPoint(${String(x)}, ${String(y)})?.closest("thead") != null`),
        ).toBe(true);
      }
      expect(await cornerRadius(page.getByRole("group", { name: "Plan view" }))).toBe("0px");
      await dropdownEvidence(page, "01-plan-header");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenJoinOnSqlite_whenShiftModE_thenTreeFromQueryPlanWithoutEstimateColumns",
    async () => {
      const page = await launch(sqlite());

      await explainJoin(page);

      const columns = await planColumns(page);
      expect(columns["Operation"]).toEqual(["SCAN o", "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)"]);
      expect(Object.keys(columns)).toEqual(["Operation"]);
      await captureWindow(page, "plan-sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresPlan_whenTheOrdersScanSelected_thenDetailsListItsFilterAndProperties",
    async () => {
      const page = await launch(POSTGRES);
      await explainJoin(page);

      await planRows(page).filter({ hasText: "orders o" }).click();

      const details = page.getByTestId("plan-details");
      await expect.poll(() => details.locator("h3").textContent()).toMatch(/orders o/);
      const names = await details.locator("dt").allTextContents();
      expect(names).toContain("Filter");
      expect(names.length).toBeGreaterThan(3);
      expect(await details.textContent()).toContain("(total > '10'::numeric)");
      expect(await planRows(page).filter({ hasText: "orders o" }).getAttribute("aria-selected")).toBe("true");
      await captureWindow(page, "plan-details");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresPlan_whenRawShownAndCopied_thenThePrintedJsonOnTheClipboard",
    async () => {
      const page = await launch(POSTGRES);
      await explainJoin(page);

      await page.getByRole("button", { name: "Raw", exact: true }).click();
      const raw = page.getByTestId("plan-raw");
      await raw.waitFor();
      // CodeMirror renders only the lines in view, so the screen shows the start of the text.
      const shown = await raw.locator(".cm-line").allTextContents();
      await page.getByRole("button", { name: "Copy Raw Plan", exact: true }).click();

      await expect.poll(() => clipboardText(running?.app as ElectronApplication)).toMatch(/^\[/);
      const copied = await clipboardText(running?.app as ElectronApplication);
      expect(JSON.parse(copied)).toEqual([expect.objectContaining({ Plan: expect.any(Object) as unknown })]);
      expect(copied.split("\n").slice(0, shown.length)).toEqual(shown);
      expect(shown.join("\n")).toMatch(JOIN_NODE_TYPE);
      expect(await page.getByRole("button", { name: "Raw", exact: true }).getAttribute("aria-pressed")).toBe("true");
      await captureWindow(page, "plan-raw");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenSelectOnPostgres_whenExplainAnalyse_thenNoQuestionAndAnalysedPlanWithActualsAndBanner",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, JOIN_SQL);

      await analyseButton(page).click();
      await planShown(page, "Plan (analysed)");

      expect(await page.getByRole("dialog").count()).toBe(0);
      const columns = await planColumns(page);
      expect(Object.keys(columns)).toEqual([
        "Operation",
        "Rows (est.)",
        "Cost (est.)",
        "Actual Rows",
        "Time (ms)",
        "Loops",
      ]);
      expect(columns["Actual Rows"]?.[0]).toBe("2");
      expect(columns["Time (ms)"]?.every((cell) => /^\d/.test(cell))).toBe(true);
      expect(columns["Loops"]?.every((cell) => /^\d/.test(cell))).toBe(true);
      expect(await page.getByTestId("plan-banner").textContent()).toBe("Explain Analyse ran this statement.");
      expect(await page.getByTestId("plan-summary").textContent()).toMatch(/Planning Time: .* ms · .*Execution Time/);
      await captureWindow(page, "analyse-select");
      await resultTab(page, "Output").click();
      expect(await outputEntries(page).last().textContent()).toMatch(/Analysed in \d+ ms/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenUpdateInAutoMode_whenExplainAnalyse_thenAsksSayingItWillBeCommitted",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, TOUCH_ORDER_ONE);

      await analyseButton(page).click();

      const dialog = page.getByRole("dialog", { name: "Explain Analyse runs this statement" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.textContent()).toContain("Its changes will be committed.");
      expect(await dialog.textContent()).toContain(TOUCH_ORDER_ONE);
      expect(await dialog.getByRole("button", { name: "Run and Explain", exact: true }).count()).toBe(1);
      await captureWindow(page, "analyse-confirm-auto");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await expect.poll(() => outputEntries(page).last().textContent()).toContain("Cancelled; nothing ran.");
      expect(await resultTabs(page).allTextContents()).toEqual(["Output"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenManualMode_whenUpdateAnalysedAndRolledBack_thenPlanShownTransactionOpenAndOrdersUnchanged",
    async () => {
      const page = await launch(POSTGRES);
      await chooseTransactionMode(page, "manual");
      await typeStatement(page, ZERO_ORDER_ONE);

      await analyseButton(page).click();
      const dialog = page.getByRole("dialog", { name: "Explain Analyse runs this statement" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.textContent()).toContain(
        "Its changes stay in the open transaction until you commit or roll back.",
      );
      await dialog.getByRole("button", { name: "Run and Explain", exact: true }).click();
      await planShown(page, "Plan (analysed)");

      expect(await page.getByTestId("plan-banner").textContent()).toBe(
        "Explain Analyse ran this statement. Its changes are in the open transaction.",
      );
      expect((await planColumns(page))["Operation"]?.[0]).toContain("ModifyTable");
      await expect.poll(() => transactionBadge(page).count()).toBe(1);
      // Regression: with both explain buttons the manual-mode toolbar pushed this badge past the edge.
      expect(await rightEdgeWithin(transactionBadge(page), page.getByTestId("console"))).toBe(true);
      // The evidence shows the plan and the open transaction; what Rollback leaves is asserted below.
      await captureWindow(page, "analyse-rollback");
      await page.getByRole("button", { name: "Pin Plan (analysed)", exact: true }).click();
      await rollbackButton(page).click();
      await expect.poll(() => transactionBadge(page).count()).toBe(0);

      await runStatement(page, ORDER_ONE_TOTAL);
      expect((await gridText(page)).cells).toEqual([ORDER_ONE_TOTAL_VALUE]);
      // In manual mode the SELECT opened a transaction of its own; end it before the evidence.
      await rollbackButton(page).click();
      await expect.poll(() => transactionBadge(page).count()).toBe(0);
      expect(await firstCell(postgres, POSTGRES_CONFIG, ORDER_ONE_TOTAL)).toBe(ORDER_ONE_TOTAL_VALUE);
      expect(await resultTabs(page).allTextContents()).toEqual(["Output", "Plan (analysed)", "Result 1"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUpdateOnMysql_whenExplainAnalyse_thenRefusedInOutputAndNothingAskedOrRun",
    async () => {
      const page = await launch(MYSQL);
      await typeStatement(page, ZERO_ORDER_ONE);

      await analyseButton(page).click();

      await expect.poll(() => outputEntries(page).count()).toBe(1);
      const entry = outputEntries(page).first();
      expect(await entry.getAttribute("data-tone")).toBe("warning");
      expect(await entry.textContent()).toContain(
        "MySQL analyses only SELECT or TABLE statements; use Explain Plan for this UPDATE.",
      );
      expect(await page.getByRole("dialog").count()).toBe(0);
      expect(await resultTabs(page).allTextContents()).toEqual(["Output"]);
      expect(await firstCell(mysql, MYSQL_CONFIG, ORDER_ONE_TOTAL)).toBe(ORDER_ONE_TOTAL_VALUE);
      await captureWindow(page, "analyse-refused");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqlite_whenConsoleShownAndPaletteSearched_thenExplainAnalyseAbsent",
    async () => {
      const page = await launch(sqlite());

      expect(await explainButton(page).count()).toBe(1);
      expect(await analyseButton(page).count()).toBe(0);
      await pressChord(page, "Shift+A");
      await paletteInput(page, "Find Action").fill("Explain");

      await expect.poll(() => paletteRows(page).count()).toBeGreaterThan(0);
      const rows = await paletteRows(page).allTextContents();
      expect(rows.some((row) => row.includes("Explain Plan"))).toBe(true);
      expect(rows.some((row) => row.includes("Explain Analyse"))).toBe(false);
      await captureWindow(page, "sqlite-no-analyse");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenCreateTableOnPostgres_whenExplainPlan_thenRefusedInOutputWithTheReason",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, CREATE_TABLE);

      await explainButton(page).click();

      await expect.poll(() => outputEntries(page).count()).toBe(1);
      const entry = outputEntries(page).first();
      expect(await entry.getAttribute("data-tone")).toBe("warning");
      expect(await entry.textContent()).toContain("PostgreSQL cannot explain a CREATE statement.");
      expect(await resultTabs(page).allTextContents()).toEqual(["Output"]);
      expect(await firstCell(postgres, POSTGRES_CONFIG, "SELECT to_regclass('public.t') IS NULL")).toBe("true");
      await captureWindow(page, "explain-refused");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenExplainAnalyzeDelete_whenRun_thenDestructiveConfirmationAndDecliningDeletesNothing",
    async () => {
      const page = await launch(POSTGRES);
      await typeStatement(page, ANALYSE_DELETE);

      await runAllButton(page).click();

      const dialog = page.getByRole("dialog", { name: "Run a destructive statement?" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.textContent()).toContain(ANALYSE_DELETE);
      expect(await dialog.textContent()).toContain("EXPLAIN ANALYZE runs it: DELETE without WHERE");
      await captureWindow(page, "run-analyse-delete");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await expect.poll(() => outputEntries(page).last().textContent()).toContain("Cancelled; nothing ran.");
      expect(await firstCell(postgres, POSTGRES_CONFIG, COUNT_ORDERS)).toBe(ORDER_COUNT);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenExplainOnSavedPostgres_whenServicesAndQueryHistoryShown_thenLabelAndTheExplainTextSent",
    async () => {
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [SAVED_POSTGRES]);
      running = await launchApp(null, { userDataDir });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      const page = running.page;
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await openConsoleOn(page, "pg");
      await answerSecretPrompt(page, "pg", POSTGRES_CONFIG.password);
      await waitUntilReady(page);

      await explainJoin(page);

      const execution = (await showServices(page)).locator('[role="treeitem"][data-kind="execution"]');
      await expect.poll(() => execution.first().getAttribute("aria-label")).toBe(`Explain: ${JOIN_SQL}, success`);
      await pressChord(page, "Alt+E");
      const history = page.getByRole("dialog", { name: "Query History: pg" });
      await history.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect
        .poll(() => history.getByRole("option").first().getAttribute("aria-label"))
        .toBe(`EXPLAIN (FORMAT JSON) ${JOIN_SQL}`);
      await captureWindow(page, "explain-history");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
