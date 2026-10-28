/**
 * Plan 055's live test: the SQL Server plugin against the `test/db/compose.yml` SQL Server 2022.
 * Gated, because it needs a display, a fresh build and the container:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/055 bun run test:smoke:db:headless:mssql test/e2e/mssql.smoke.test.ts
 *
 * The suite makes and drops `mssql_live`; `edit_probe` is reset after the edit scenario.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Session } from "@table-craft/plugin-api";
import mssql from "@table-craft/plugin-mssql";
import { MSSQL_CONFIG, MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_MSSQL } from "../support/databases.js";
import { FOREIGN_DIALECT_SOURCES, writeImportFixture } from "../support/import/fixtures.js";
import { pluginPackageName, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  consoleToolbar,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  sqlEditor,
  startStatement,
  testConnection,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { builtRelease } from "./pluginFixtures.js";

const captureWindow = evidenceFor("055");

const SQL_SERVER: Datasource = { id: "mssql", pluginId: "mssql", config: MSSQL_CONFIG };
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
const DOWNLOADED_NAME = "billing-sqlserver";
const LIVE_TABLE = "mssql_live";
const HOLDING_UPDATE = `UPDATE ${LIVE_TABLE} SET n = n + 1 WHERE id = 1`;
const BLOCKED_UPDATE = `UPDATE ${LIVE_TABLE} SET n = n + 10 WHERE id = 1`;
const EDIT_PROBE_RESET = "UPDATE edit_probe SET label = N'first' WHERE id = 1";
const EDITED_LABEL = "edited live";
const SETTLE_ORDER = "settle_order (@order_id int, @total decimal(12,2) OUTPUT)";
const JOIN_SQL = "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 10";
const GO_SCRIPT = [
  "CREATE TABLE #live_go (n int)",
  "GO",
  "INSERT INTO #live_go (n) VALUES (1)",
  "GO 3",
  "SELECT COUNT(*) AS inserted FROM #live_go",
].join("\n");
const TWO_RESULT_SETS = "SELECT 1 AS first_set\nSELECT 2 AS second_set";
const VALUES_SQL =
  "SELECT CAST(1 AS bit) AS flag, CAST('12345678901234567890.123456789' AS decimal(38, 9)) AS exact, " +
  "CAST('2024-02-29 13:45:30.1234567' AS datetime2(7)) AS moment, " +
  "CAST('2024-02-29 13:45:30.1234567 +05:30' AS datetimeoffset(7)) AS zoned, 0xDEADBEEF AS payload";
const PRINT_TEXT = "hello from SQL Server";
const ERROR_SCRIPT = "SELECT 1 AS ok;\nPRINT 'before'\nPRINT 'still before'\n  SELECT * FROM no_such_table;";
/** CodeMirror ignores Enter for its default `interactionDelay` after the popup opens. */
const INTERACTION_DELAY_MS = 75;
const BASIC_COMPLETION = "Control+Space";

async function onServer(statements: readonly string[]): Promise<void> {
  const session = await mssql.connect(mssql.connectionSchema.parse(MSSQL_CONFIG), { readOnly: false });
  try {
    for (const sql of statements) await drain(session, sql);
  } finally {
    await session.close();
  }
}

async function drain(session: Session, sql: string): Promise<void> {
  const result = await session.execute(sql);
  for await (const row of result.rows) void row;
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string | RegExp) {
  return explorer(page).getByRole("treeitem", { name, exact: typeof name === "string" });
}

async function expand(page: Page, name: string | RegExp): Promise<void> {
  const target = treeRow(page, name).first();
  await target.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await target.getAttribute("aria-expanded")) === "true") return;
  await target.click();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => target.getAttribute("aria-expanded")).toBe("true");
}

function resultTab(page: Page, title: string) {
  return page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: title });
}

function outputEntries(page: Page) {
  return page.getByRole("log", { name: "Output" }).locator("[data-tone]");
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

async function typeStatement(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
}

async function runScript(page: Page, sql: string): Promise<void> {
  await typeStatement(page, sql);
  await runAllButton(page).click();
  await waitUntilReady(page);
}

async function cellsShown(page: Page, expected: readonly string[]): Promise<void> {
  await expect
    .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
    .toEqual(expect.arrayContaining([...expected]));
  await waitUntilReady(page);
}

function popup(page: Page) {
  return page.locator(".cm-tooltip-autocomplete");
}

function option(page: Page, label: string) {
  return popup(page)
    .getByRole("option")
    .filter({ has: page.locator(".cm-completionLabel", { hasText: new RegExp(`^${label}$`) }) });
}

function activeParameter(page: Page) {
  return page.locator(".tc-signature-hint .tc-signature-active");
}

/** True once Enter would accept `label`, as in `functionCompletion.smoke.test.ts`. */
function acceptable(label: string): string {
  return `(() => {
    const popup = document.querySelector('.cm-tooltip-autocomplete');
    if (popup === null) return false;
    const seen = (window.__popupSeen ??= new WeakMap());
    if (!seen.has(popup)) seen.set(popup, performance.now());
    if (performance.now() - seen.get(popup) < ${String(INTERACTION_DELAY_MS)}) return false;
    if (popup.classList.contains('cm-tooltip-autocomplete-disabled')) return false;
    return popup.querySelector('[aria-selected] .cm-completionLabel')?.textContent === ${JSON.stringify(label)};
  })()`;
}

async function completeAfter(page: Page, sql: string): Promise<void> {
  await typeStatement(page, sql);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press(BASIC_COMPLETION);
  await popup(page).getByRole("option").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function accept(page: Page, label: string): Promise<void> {
  await expect.poll(() => page.evaluate<boolean>(acceptable(label)), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
  await page.keyboard.press("Enter");
}

function tableEditor(page: Page) {
  return page.getByTestId("table-editor");
}

function editorCell(page: Page, row: number, column: number) {
  return tableEditor(page).locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

function sessionsView(page: Page) {
  return page.getByTestId("sessions-view");
}

function sessionRow(page: Page, id: string) {
  return page.getByTestId("sessions-grid").locator(`tbody tr[data-session="${id}"]`);
}

function rowWithQuery(page: Page, sql: string) {
  return page.getByTestId("sessions-grid").locator("tbody tr").filter({ hasText: sql });
}

async function cellText(page: Page, row: Locator, column: string): Promise<string> {
  const headers = await page.getByTestId("sessions-grid").locator("thead th").allTextContents();
  return (await row.locator("td").nth(headers.indexOf(column)).textContent()) ?? "";
}

function sessionsButton(page: Page, name: string) {
  return sessionsView(page).getByRole("button", { name, exact: true });
}

function importDialog(page: Page) {
  return page.getByRole("dialog", { name: "Import Data Sources" });
}

describe.runIf(DATABASES_ENABLED)("sql server live test", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;
  let holder: Session | null = null;

  beforeAll(async () => {
    if (WITHOUT_MSSQL) return;
    await onServer([
      `DROP TABLE IF EXISTS ${LIVE_TABLE}`,
      `CREATE TABLE ${LIVE_TABLE} (id int PRIMARY KEY, n int NOT NULL)`,
      `INSERT INTO ${LIVE_TABLE} (id, n) VALUES (1, 0)`,
    ]);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (WITHOUT_MSSQL) return;
    await onServer([`DROP TABLE IF EXISTS ${LIVE_TABLE}`, EDIT_PROBE_RESET]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await registry?.close();
    registry = null;
    await holder?.close().catch(() => undefined);
    holder = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null = SQL_SERVER): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_MSSQL)(
    "givenRegistryFixture_whenSqlServerDownloaded_thenJdbcUrlFillsTheFormAndConnects",
    async () => {
      registry = await startRegistry({ [pluginPackageName("mssql")]: [builtRelease("mssql", "1.0.0")] });
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: registry.url } });
      running = await launchApp(null, { userDataDir, env: NO_OPTIONAL_ROOT });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      const page = running.page;

      await explorer(page).getByRole("button", { name: "New Data Source…", exact: true }).click();
      const form = dataSourcesDialog(page);
      await form.locator('button[data-download="mssql"]').click();
      await form.getByLabel("Instance", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      const url =
        `jdbc:sqlserver://${MSSQL_CONFIG.host}:${String(MSSQL_CONFIG.port)};databaseName=table_craft;` +
        `user=${MSSQL_CONFIG.user};encrypt=true;trustServerCertificate=true;applicationName=TableCraft live`;
      await form.getByLabel("URL", { exact: true }).fill(url);
      await form.getByLabel("URL", { exact: true }).press("Enter");
      await expect.poll(() => form.getByLabel("Host", { exact: true }).inputValue()).toBe(MSSQL_CONFIG.host);
      expect(await form.getByLabel("Port", { exact: true }).inputValue()).toBe(String(MSSQL_CONFIG.port));
      expect(await form.getByLabel("Database", { exact: true }).inputValue()).toBe("table_craft");
      expect(await form.getByLabel("User", { exact: true }).inputValue()).toBe(MSSQL_CONFIG.user);
      await form.getByLabel("Name", { exact: true }).fill(DOWNLOADED_NAME);
      await form.getByLabel("Password", { exact: true }).fill(MSSQL_CONFIG.password);
      expect((await testConnection(page)).ok).toBe(true);
      await captureWindow(page, "01-jdbc-url");
      await form.getByRole("button", { name: "OK", exact: true }).click();
      await form.waitFor({ state: "detached" });

      await openConsoleOn(page, DOWNLOADED_NAME);
      await waitUntilReady(page);
      await runScript(page, "SELECT DB_NAME() AS db, SUSER_SNAME() AS who, APP_NAME() AS app");
      await cellsShown(page, ["table_craft", MSSQL_CONFIG.user, "TableCraft live"]);
      await sqlEditor(page).press("Escape");
      await page.locator(".cm-tooltip-autocomplete").waitFor({ state: "detached" });
      await captureWindow(page, "02-connected");
    },
    SCENARIO_TIMEOUT_MS * 3,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenSqlServer_whenExplored_thenDatabasesSchemasTablesAndRoutines",
    async () => {
      const page = await launch();
      await expand(page, /^table_craft(, (loading|failed))?$/);
      await expand(page, /^dbo(, (loading|failed))?$/);
      await expand(page, /^tables \d+$/);
      await treeRow(page, "Line Items").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expand(page, /^routines \d+$/);
      await treeRow(page, SETTLE_ORDER).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await treeRow(page, /^customer_orders \(/).waitFor();
      await captureWindow(page, "03-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenGoScript_whenRunAll_thenEachBatchRunsAndGoCountRepeats",
    async () => {
      const page = await launch();
      await runScript(page, GO_SCRIPT);
      await cellsShown(page, ["3"]);
      expect((await gridText(page)).headers).toEqual(["inserted"]);
      await captureWindow(page, "04-go-script");

      await runScript(page, TWO_RESULT_SETS);
      await cellsShown(page, ["1"]);
      await resultTab(page, "Output").click();
      await expect
        .poll(() => outputEntries(page).allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining([expect.stringContaining("1 more result set in this batch")]));
      await captureWindow(page, "05-more-result-sets");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenExactTypes_whenSelected_thenGridShowsBitDecimalDatetime2AndBytes",
    async () => {
      const page = await launch();
      await runScript(page, VALUES_SQL);
      await cellsShown(page, [
        "12345678901234567890.123456789",
        "2024-02-29 13:45:30.1234567",
        "2024-02-29 13:45:30.1234567 +05:30",
      ]);
      expect((await gridText(page)).headers).toEqual(["flag", "exact", "moment", "zoned", "payload"]);
      await captureWindow(page, "06-grid-values");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenEditProbe_whenLabelEditedAndSubmitted_thenRowUpdated",
    async () => {
      const page = await launch();
      await expand(page, /^table_craft(, (loading|failed))?$/);
      await expand(page, /^dbo(, (loading|failed))?$/);
      await expand(page, /^tables \d+$/);
      await treeRow(page, "edit_probe").click();
      await page.keyboard.press("F4");
      await expect.poll(() => activeEditorTab(page).textContent()).toContain("edit_probe");
      await editorCell(page, 0, 1).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await editorCell(page, 0, 1).click();
      await page.keyboard.press("Enter");
      const field = tableEditor(page).locator("[data-editing] input");
      await field.waitFor();
      await field.fill(EDITED_LABEL);
      await field.press("Enter");
      await expect.poll(() => field.count()).toBe(0);
      await tableEditor(page).getByRole("button", { name: "Submit", exact: true }).click();
      await expect
        .poll(() => tableEditor(page).getByTestId("table-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("Submitted 1 statement");
      await expect
        .poll(() => columnSnapshot(tableEditor(page).locator('[role="gridcell"][data-col="1"]')))
        .toContain(EDITED_LABEL);
      await captureWindow(page, "07-edit-submitted");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenJoin_whenExplainedAndAnalysed_thenShowplanTrees",
    async () => {
      const page = await launch();
      await typeStatement(page, JOIN_SQL);
      await pressChord(page, "Shift+E");
      await resultTab(page, "Plan").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page
        .getByRole("treegrid")
        .locator("tbody")
        .getByRole("row")
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      await captureWindow(page, "08-explain");

      await typeStatement(page, JOIN_SQL);
      await page.getByRole("button", { name: "Explain Analyse", exact: true }).click();
      await resultTab(page, "Plan (analysed)").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page
        .getByRole("treegrid")
        .locator("tbody")
        .getByRole("row")
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      const headers = await page.getByRole("treegrid").locator("thead th").allTextContents();
      expect(headers).toEqual(expect.arrayContaining(["Actual Rows", "Loops"]));
      await captureWindow(page, "09-explain-analyse");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenPrintAndFailingStatement_whenRun_thenOutputAndLineUnderlined",
    async () => {
      const page = await launch();
      await runScript(page, `PRINT '${PRINT_TEXT}'`);
      await resultTab(page, "Output").click();
      await expect
        .poll(() => outputEntries(page).allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining([expect.stringContaining(PRINT_TEXT)]));
      await captureWindow(page, "10-print-output");

      await typeStatement(page, ERROR_SCRIPT);
      await runAllButton(page).click();
      await expect
        .poll(() => sqlEditor(page).locator(".tc-error-mark").count(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBeGreaterThan(0);
      await waitUntilReady(page);
      await captureWindow(page, "11-error-line");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenLockWait_whenShowSessions_thenBlockedRowAndHolderTerminated",
    async () => {
      holder = await mssql.connect(mssql.connectionSchema.parse(MSSQL_CONFIG), { readOnly: false });
      await drain(holder, "BEGIN TRANSACTION");
      await drain(holder, HOLDING_UPDATE);
      const holderId = holder.serverSessionId ?? "";
      const page = await launch();
      await startStatement(page, BLOCKED_UPDATE);

      await treeNode(page, SQL_SERVER.id).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Show Sessions…/ }).click();
      await expect.poll(() => activeEditorTab(page).textContent()).toBe(`Sessions · ${SQL_SERVER.id}`);
      const blocked = rowWithQuery(page, BLOCKED_UPDATE);
      await expect
        .poll(
          async () => {
            await sessionsButton(page, "Refresh Sessions").click();
            return (await blocked.count()) > 0 ? cellText(page, blocked, "Blocked by") : "";
          },
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toBe(holderId);
      expect(await blocked.getAttribute("data-tone")).toBe("danger");
      await captureWindow(page, "12-sessions-blocked");

      await sessionRow(page, holderId).click();
      await sessionsButton(page, "Terminate Session…").click();
      const dialog = page.getByRole("dialog", { name: "Terminate Session" });
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain(`KILL ${holderId}`);
      await dialog.getByRole("button", { name: "Terminate", exact: true }).click();
      await expect
        .poll(() => page.getByTestId("sessions-status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`Terminated session ${holderId}.`);
      await captureWindow(page, "13-session-terminated");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenProcedureWithOutput_whenExecuteRoutine_thenReturnValueAndOutput",
    async () => {
      const page = await launch();
      await expand(page, /^table_craft(, (loading|failed))?$/);
      await expand(page, /^dbo(, (loading|failed))?$/);
      await expand(page, /^routines \d+$/);
      await treeRow(page, SETTLE_ORDER).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Execute Routine/ }).click();
      const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("routine-sql") });
      await dialog.getByLabel("Value of order_id", { exact: true }).fill("1");
      await expect
        .poll(async () => (await dialog.getByTestId("routine-sql").locator(".cm-line").allTextContents()).join("\n"))
        .toContain("OUTPUT");
      await captureWindow(page, "14-routine-dialog");
      const run = dialog.getByRole("button", { name: "Run", exact: true });
      await expect.poll(() => run.isEnabled()).toBe(true);
      await run.click();
      await dialog.waitFor({ state: "detached" });
      await cellsShown(page, ["0", "19.99"]);
      expect((await gridText(page)).headers).toEqual(["RETURN_VALUE", "total"]);
      await captureWindow(page, "15-routine-result");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenCompletion_whenFunctionsGlobalsAndCast_thenSignaturesBareNamesAndTypeHint",
    async () => {
      const page = await launch();
      await completeAfter(page, "SELECT datea");
      await option(page, "dateadd").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await option(page, "dateadd").locator(".cm-completionDetail").textContent()).toBe(
        "(datepart, number, date) → datetime",
      );
      await captureWindow(page, "16-completion-signature");
      await page.keyboard.press("Escape");

      await completeAfter(page, "SELECT current_timest");
      await accept(page, "current_timestamp");
      await expect.poll(() => editorText(page)).toBe("SELECT current_timestamp");

      await completeAfter(page, "SELECT @@ver");
      await option(page, "@@version").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "17-completion-globals");
      await accept(page, "@@version");
      await expect.poll(() => editorText(page)).toBe("SELECT @@version");

      await typeStatement(page, "SELECT ");
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type("CAST(total AS ");
      await expect.poll(() => activeParameter(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("data_type");
      await captureWindow(page, "18-cast-hint");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenDataGripSqlServerSource_whenImported_thenReadyInThisPlugin",
    async () => {
      const home = writeImportFixture(mkdtempSync(join(tmpdir(), "table-craft-import-home-")), {
        mysql: { host: MYSQL_CONFIG.host, port: MYSQL_CONFIG.port },
        postgres: { host: POSTGRES_CONFIG.host, port: POSTGRES_CONFIG.port },
        passwords: "native",
        platform: process.platform,
        password: MYSQL_CONFIG.password,
        oracleAndSqlServer: true,
      });
      running = await launchApp(null, { userDataDir: newProfile(), env: { HOME: home.home } });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      const page = running.page;
      await toolWindow(page, "Database").waitFor();

      await findAction(page, "Import Data Sources");
      await importDialog(page).getByTestId("import-source-datagrip").click();
      await importDialog(page).getByTestId("import-rows").waitFor();
      const row = importDialog(page)
        .getByTestId("import-row")
        .filter({ has: page.getByText(FOREIGN_DIALECT_SOURCES.sqlServer, { exact: true }) });
      await expect.poll(() => row.getAttribute("data-status")).toBe("ready");
      await expect.poll(() => row.textContent()).toContain("SQL Server");
      await row.scrollIntoViewIfNeeded();
      await captureWindow(page, "19-datagrip-import");
      expect(await consoleToolbar(page).count()).toBeGreaterThanOrEqual(0);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
