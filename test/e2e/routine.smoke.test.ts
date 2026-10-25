/**
 * Plan 046's live test: Execute Routine from the Database pane on PostgreSQL and MySQL, its dialog
 * previewing the call the plugin writes, the result in a new console. Needs the
 * `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/046 bun run test:smoke:db:headless test/e2e/routine.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import {
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("046");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

const PG_CALC_FEE = "calc_fee (amount numeric, rate numeric)";
const PG_CALC_FEE_CURRENCY = "calc_fee (amount numeric, currency text, rate numeric)";
const PG_SETTLE_ORDER = "settle_order (IN order_id integer, OUT total numeric)";
const MYSQL_CALC_FEE = "calc_fee (amount decimal(12,2), rate decimal(6,4))";
const MYSQL_SETTLE_ORDER = "settle_order (order_id int, OUT total decimal(12,2), INOUT note varchar(64))";
const NULL_CELL = "<null>";

function treeRow(page: Page, name: string | RegExp) {
  return toolWindow(page, "Database").getByRole("treeitem", { name, exact: typeof name === "string" });
}

async function openRoutines(page: Page): Promise<void> {
  const group = treeRow(page, /^routines \d+$/).first();
  await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
    await page.keyboard.press("ArrowRight");
  }
}

async function executeRoutine(page: Page, routine: string): Promise<Locator> {
  await openRoutines(page);
  await treeRow(page, routine).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await treeRow(page, routine).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Execute Routine/ }).click();
  return page.getByRole("dialog").filter({ has: page.getByTestId("routine-sql") });
}

async function sqlOf(dialog: Locator): Promise<string> {
  return (await dialog.getByTestId("routine-sql").locator(".cm-line").allTextContents()).join("\n");
}

async function previewed(dialog: Locator, pattern: RegExp): Promise<void> {
  await expect.poll(() => sqlOf(dialog), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(pattern);
}

async function choose(dialog: Locator, button: "Run" | "Open in Console"): Promise<void> {
  const target = dialog.getByRole("button", { name: button, exact: true });
  await expect.poll(() => target.isEnabled()).toBe(true);
  await target.click();
  await dialog.waitFor({ state: "detached" });
}

async function cellsShown(page: Page, expected: readonly string[]): Promise<void> {
  await expect
    .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
    .toEqual(expect.arrayContaining([...expected]));
  await waitUntilReady(page);
}

describe.runIf(DATABASES_ENABLED)("execute routine live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  });

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenRun_whenDialogSubmits_thenConsoleShowsResult",
    async () => {
      const page = await launch(POSTGRES);

      const dialog = await executeRoutine(page, PG_CALC_FEE);
      await dialog.getByLabel("Value of amount", { exact: true }).fill("100");
      await previewed(dialog, /^SELECT \* FROM .*calc_fee["`]?\(CAST\(:amount AS numeric\)\);$/);
      await captureWindow(page, "pg-function-default-dialog");
      await choose(dialog, "Run");

      await cellsShown(page, ["1.50"]);
      await expect(treeRow(page, PG_CALC_FEE_CURRENCY).count()).resolves.toBe(1);
      await captureWindow(page, "pg-function-result");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenProcedureOut_whenRun_thenOutValueShown",
    async () => {
      const page = await launch(POSTGRES);

      const dialog = await executeRoutine(page, PG_SETTLE_ORDER);
      await dialog.getByLabel("Value of order_id", { exact: true }).fill("1");
      await previewed(dialog, /^CALL .*settle_order["`]?\(CAST\(:order_id AS integer\), CAST\(NULL AS numeric\)\);$/);
      await captureWindow(page, "pg-procedure-out-dialog");
      await choose(dialog, "Run");

      await cellsShown(page, ["19.99"]);
      await captureWindow(page, "pg-procedure-out-result");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlProcedureOut_whenRun_thenOutAndInoutValuesShown",
    async () => {
      const page = await launch(MYSQL);

      const dialog = await executeRoutine(page, MYSQL_SETTLE_ORDER);
      await dialog.getByLabel("Value of order_id", { exact: true }).fill("1");
      await dialog.getByLabel("Value of note", { exact: true }).fill("paid");
      await previewed(dialog, /^SET @\w+ = :note;\nCALL .*settle_order["`]?\(:order_id, @\w+, @\w+\);\nSELECT @\w+ AS/);
      await captureWindow(page, "mysql-procedure-out-dialog");
      await choose(dialog, "Run");

      await cellsShown(page, ["19.99", "paid settled"]);
      await captureWindow(page, "mysql-procedure-out-result");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNullToggle_whenRun_thenBindsNull",
    async () => {
      const page = await launch(MYSQL);

      const dialog = await executeRoutine(page, MYSQL_CALC_FEE);
      await dialog.getByLabel("amount is NULL", { exact: true }).check();
      await dialog.getByLabel("Value of rate", { exact: true }).fill("0.02");
      await previewed(dialog, /^SELECT .*calc_fee["`]?\(:amount, :rate\) AS `?calc_fee`?;$/);
      await captureWindow(page, "mysql-null-argument-dialog");
      await choose(dialog, "Run");

      await cellsShown(page, [NULL_CELL]);
      await captureWindow(page, "mysql-null-argument-result");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOpenInConsole_whenChosen_thenSqlNotRun",
    async () => {
      const page = await launch(POSTGRES);

      const dialog = await executeRoutine(page, PG_CALC_FEE_CURRENCY);
      await dialog.getByLabel("Value of amount", { exact: true }).fill("100");
      await dialog.getByLabel("Value of currency", { exact: true }).fill("EUR");
      await dialog.getByLabel("rate is DEFAULT", { exact: true }).uncheck();
      await dialog.getByLabel("Value of rate", { exact: true }).fill("0.02");
      await previewed(dialog, /CAST\(:currency AS text\), CAST\(:rate AS numeric\)\);$/);
      await choose(dialog, "Open in Console");

      await expect
        .poll(() => sqlEditor(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/calc_fee["`]?\(CAST\(:amount AS numeric\), CAST\(:currency AS text\), CAST\(:rate AS numeric\)\);/);
      await waitUntilReady(page);
      expect((await gridText(page)).cells).toEqual([]);
      await captureWindow(page, "pg-open-in-console");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
