/**
 * Plan 152's live test: DuckDB as a downloaded plugin with a native binding (decision 156), on a
 * database file, a Parquet file and a zstd CSV the scenarios write with DuckDB itself, and the
 * SQLite savepoints that became a capability. DuckDB and SQLite are files, so no server is needed:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/152 bun run test:smoke:headless test/e2e/duckdb.smoke.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import duckdb from "@table-craft/plugin-duckdb";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { pluginPackageName, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import {
  activeEditorTab,
  chooseOption,
  cancelButton,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  consoleAlert,
  dataSourcesDialog,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  optionValue,
  openConsoleOn,
  pressChord,
  rollbackButton,
  runAllButton,
  runButton,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  showServices,
  SMOKE_ENABLED,
  sqlEditor,
  startStatement,
  testConnection,
  toolWindow,
  treeNode,
  waitUntilReady,
  waitUntilSpinning,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { builtNativeRelease, HOST_PLATFORM } from "./pluginFixtures.js";

const captureWindow = evidenceFor("152");
const DUCKDB = "duckdb";
const ANALYSIS = "analysis.duckdb";
const ORDERS_PARQUET = "orders.parquet";
const EVENTS_CSV_ZST = "events.csv.zst";
const ORDER_ROWS = 10_000;
const EVENT_ROWS = 25_000;
const NO_OPTIONAL_ROOT = { TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" };
/** Far longer than the scenario: the cancel, not the statement, has to end it. */
const LONG_COUNT = "SELECT count(*) AS n FROM range(60000000) a, range(1000000) b WHERE a.range * b.range = -1";
const CANCEL_DEADLINE_MS = 5_000;

interface AnalysisFiles {
  readonly directory: string;
  readonly database: string;
  readonly parquet: string;
  readonly csvZst: string;
}

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** A database file of customers and orders, and a Parquet and a zstd CSV written from it by DuckDB. */
async function analysisFiles(): Promise<AnalysisFiles> {
  const directory = mkdtempSync(join(tmpdir(), "table-craft-duckdb-live-"));
  const files = {
    directory,
    database: join(directory, ANALYSIS),
    parquet: join(directory, ORDERS_PARQUET),
    csvZst: join(directory, EVENTS_CSV_ZST),
  };
  const session = await duckdb.connect(
    { path: files.database, readOnlyFile: false, downloadExtensions: false },
    { readOnly: false },
  );
  try {
    for (const sql of [
      "CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL)",
      "INSERT INTO customers SELECT range, 'customer ' || range FROM range(1, 51)",
      "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, status VARCHAR NOT NULL, total DECIMAL(10, 2) NOT NULL)",
      `INSERT INTO orders SELECT range, range % 50 + 1, ['new', 'paid', 'shipped'][range % 3 + 1], (range % 997) / 10 FROM range(1, ${String(ORDER_ROWS + 1)})`,
      `COPY orders TO ${literal(files.parquet)} (FORMAT parquet)`,
      `COPY (SELECT range AS id, range % ${String(ORDER_ROWS)} + 1 AS order_id, ['view', 'click', 'buy'][range % 3 + 1] AS kind FROM range(${String(EVENT_ROWS)})) TO ${literal(files.csvZst)} (FORMAT csv, HEADER, COMPRESSION zstd)`,
    ]) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) void _row;
    }
  } finally {
    await session.close();
  }
  return files;
}

function on(id: string, path: string): Datasource {
  return { id, pluginId: DUCKDB, config: { path, readOnlyFile: false, downloadExtensions: false } };
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string | RegExp) {
  return explorer(page).getByRole("treeitem", { name, exact: typeof name === "string" });
}

async function expand(page: Page, row: Locator): Promise<void> {
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await row.click();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded")).toBe("true");
}

function cell(page: Page | Locator, row: number, column: number) {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

async function columnValues(page: Page, column: number): Promise<string[]> {
  return columnSnapshot(page.locator(`[role="gridcell"][data-col="${String(column)}"]`));
}

async function query(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  // Closes the completion popup typing opened, which would cover the grid in the evidence.
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await page.getByRole("columnheader").or(consoleAlert(page)).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await waitUntilReady(page);
}

async function text(locator: Locator): Promise<string> {
  return (await locator.count()) === 0 ? "" : ((await locator.first().textContent()) ?? "");
}

function resultTab(page: Page, title: string) {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title.replace(/[()]/g, "\\$&")}$`) });
}

function outputText(page: Page): Promise<string> {
  return text(page.getByRole("log", { name: "Output" }));
}

function resultState(page: Page) {
  return page.getByTestId("result-state");
}

function planRows(page: Page) {
  return page.getByRole("treegrid").locator("tbody").getByRole("row");
}

async function planShown(page: Page, title: string): Promise<void> {
  await resultTab(page, title).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await planRows(page).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await waitUntilReady(page);
}

function editField(page: Page) {
  return page.locator("[data-editing] input");
}

async function editCell(scope: Page | Locator, page: Page, row: number, column: number, value: string): Promise<void> {
  await cell(scope, row, column).click();
  await page.keyboard.press("Enter");
  await editField(page).waitFor();
  await editField(page).fill(value);
  await editField(page).press("Enter");
  await expect.poll(() => editField(page).count()).toBe(0);
}

async function chooseTransactionMode(page: Page, mode: "auto" | "manual"): Promise<void> {
  const select = page.getByLabel("Transaction mode", { exact: true });
  await expect.poll(() => select.isEnabled()).toBe(true);
  await chooseOption(select, mode);
  await expect.poll(() => optionValue(select)).toBe(mode);
}

describe.runIf(SMOKE_ENABLED)("DuckDB live test", () => {
  let running: RunningApp | null = null;
  let registry: LoopbackRegistry | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await registry?.close();
    registry = null;
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function files(): Promise<AnalysisFiles> {
    const made = await analysisFiles();
    scratch.push(made.directory);
    return made;
  }

  async function launch(datasource: Datasource | null, userDataDir?: string): Promise<Page> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenNoOptionalPlugins_whenDuckdbDownloadedFromThePicker_thenTheHostPackageInstallsAndConnects",
    async () => {
      const { database } = await files();
      const packageName = `${pluginPackageName(DUCKDB)}-${HOST_PLATFORM}`;
      registry = await startRegistry({ [packageName]: [builtNativeRelease(DUCKDB, "1.0.0")] });
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, plugins: { registryUrl: registry.url } });
      running = await launchApp(null, { userDataDir, env: NO_OPTIONAL_ROOT });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      const { page } = running;
      await explorer(page).getByRole("button", { name: "New Data Source…", exact: true }).first().click();
      const dialog = dataSourcesDialog(page);
      const download = dialog
        .getByRole("list", { name: "Database kinds" })
        .locator(`button[data-download="${DUCKDB}"]`);
      await expect.poll(() => download.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/DuckDB.*Download/);
      await download.click();

      await dialog.getByLabel("File", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS * 2 });
      expect(registry.requests).toContain(`/${packageName.replace("/", "%2f")}`);
      await dialog.getByLabel("Name", { exact: true }).fill("analysis");
      await dialog.getByLabel("File", { exact: true }).fill(database);
      const result = await testConnection(page);
      expect(result.ok).toBe(true);
      expect(result.text).toContain("DuckDB");
      await captureWindow(page, "01-install");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenParquetFile_whenOpened_thenTheTreeShowsItsViewAndAGroupByFillsTheGrid",
    async () => {
      const { parquet } = await files();
      const page = await launch(on("orders-parquet", parquet));

      await query(
        page,
        "SELECT status, count(*) AS orders, sum(total) AS total FROM orders GROUP BY status ORDER BY status",
      );
      await expect.poll(() => columnValues(page, 0)).toEqual(["new", "paid", "shipped"]);
      await expect.poll(() => columnValues(page, 1)).toEqual(["3333", "3334", "3333"]);
      await expand(page, treeNode(page, "orders-parquet"));
      const views = treeRow(page, /^views \d+$/).first();
      await expand(page, views);
      await treeRow(page, /^orders/)
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "02-parquet");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenZstdCsv_whenJoinedToParquetOrders_thenRowsPagePastTheFirstWindow",
    async () => {
      const { parquet, csvZst } = await files();
      const page = await launch(on("orders-parquet", parquet));

      await query(
        page,
        `SELECT e.id, e.kind, o.status, o.total FROM read_csv(${literal(csvZst)}) e JOIN orders o ON o.id = e.order_id ORDER BY e.id`,
      );
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");
      await page
        .getByRole("toolbar", { name: "Result" })
        .getByRole("button", { name: "Fetch Next Page", exact: true })
        .click();
      await expect.poll(() => resultState(page).textContent()).toBe("1,000+ rows");
      await page
        .getByRole("toolbar", { name: "Result" })
        .getByRole("button", { name: "Fetch All", exact: true })
        .click();
      await expect
        .poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`${EVENT_ROWS.toLocaleString("en-US")} rows`);
      await captureWindow(page, "03-csv-zst");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDatabaseFile_whenACellIsEditedInTheTableEditorAndSubmitted_thenItIsStored",
    async () => {
      const { database } = await files();
      const page = await launch(on("analysis-file", database));

      await expand(page, treeNode(page, "analysis-file"));
      await expand(page, treeRow(page, "main").first());
      await expand(page, treeRow(page, /^tables \d+$/).first());
      await treeRow(page, /^customers/)
        .first()
        .click();
      await page.keyboard.press("F4");
      await expect.poll(() => activeEditorTab(page).textContent()).toContain("customers");
      const editor = page.getByTestId("table-editor");
      await cell(editor, 0, 1).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await editCell(editor, page, 0, 1, "Ada Lovelace");
      await editor.getByRole("button", { name: "Submit", exact: true }).click();
      await expect.poll(() => editor.getByTestId("table-notice").textContent()).toBe("Submitted 1 statement");
      await expect.poll(() => cell(editor, 0, 1).textContent()).toBe("Ada Lovelace");
      await captureWindow(page, "04-edit");

      await editorTabs(page).first().click();
      await query(page, "SELECT name FROM customers WHERE id = 1");
      await expect.poll(() => columnValues(page, 0)).toEqual(["Ada Lovelace"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenStructListAndHugeint_whenSelected_thenJsonCellsAndTheValuePanelShowsThem",
    async () => {
      const page = await launch(on("memory", ":memory:"));

      await query(page, "SELECT {'a': 1, 'b': [true, NULL]} AS s, [1, 2] AS l, 12345678901234567890::HUGEINT AS h");
      await expect.poll(() => cell(page, 0, 2).textContent()).toBe("12345678901234567890");
      await cell(page, 0, 0).click();
      const panel = page.getByRole("complementary", { name: "Value" });
      if ((await panel.count()) === 0) await page.keyboard.press("Shift+Enter");
      await panel.waitFor();
      await expect.poll(() => text(panel)).toContain('"a"');
      await captureWindow(page, "05-values");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenParquetAggregate_whenExplainedAndAnalysed_thenPlanTreesShowTheScan",
    async () => {
      const { parquet } = await files();
      const page = await launch(on("orders-parquet", parquet));
      const sql = "SELECT status, count(*) AS n FROM orders WHERE customer_id = 3 GROUP BY status";
      await sqlEditor(page).fill(sql);
      await sqlEditor(page).press("Escape");

      await pressChord(page, "Shift+E");
      await planShown(page, "Plan");
      await expect
        .poll(async () => (await planRows(page).allTextContents()).join("\n"))
        .toMatch(/PARQUET_SCAN|READ_PARQUET/);

      await page.getByRole("button", { name: "Explain Analyse", exact: true }).click();
      await planShown(page, "Plan (analysed)");
      await expect.poll(() => text(page.getByRole("treegrid").locator("thead"))).toContain("Actual Rows");
      await captureWindow(page, "06-plan");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLongCount_whenCancelled_thenItStopsAndTheConsoleRunsAgain",
    async () => {
      const page = await launch(on("memory", ":memory:"));

      await startStatement(page, LONG_COUNT);
      await expect.poll(() => cancelButton(page).isEnabled()).toBe(true);
      await waitUntilSpinning(runButton(page));
      const started = Date.now();
      await cancelButton(page).click();
      await waitUntilReady(page);
      expect(Date.now() - started).toBeLessThan(CANCEL_DEADLINE_MS);
      await resultTab(page, "Output").click();
      await expect.poll(() => outputText(page)).toContain("Cancelled");
      await captureWindow(page, "07-cancel");

      await query(page, "SELECT 42 AS after_cancel");
      await expect.poll(() => columnValues(page, 0)).toEqual(["42"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFileOpenInOneDatasource_whenASecondDatasourceOpensIt_thenTheLockMessageNamesTheHolder",
    async () => {
      const { database } = await files();
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [
        {
          id: "analysis-copy",
          name: "analysis-copy",
          pluginId: DUCKDB,
          config: { path: database, readOnlyFile: false, downloadExtensions: false },
        },
      ]);
      const page = await launch(on("analysis", database), userDataDir);
      await query(page, "SELECT count(*) AS n FROM orders");

      await openConsoleOn(page, "analysis-copy");
      await expect
        .poll(() => text(page.getByText(/is open in .+ \(PID \d+\)/)), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/analysis\.duckdb is open in .+ \(PID \d+\)/);
      await captureWindow(page, "08-lock");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCsvFile_whenImportedIntoANewTable_thenTheTableHoldsItsRows",
    async () => {
      const { database, directory } = await files();
      const csv = join(directory, "people.csv");
      writeFileSync(csv, "id,name,city\n1,Ada,London\n2,Grace,Arlington\n3,Edsger,Nuenen\n");
      const page = await launch(on("analysis-file", database));
      await showServices(page);

      await expand(page, treeNode(page, "analysis-file"));
      await expand(page, treeRow(page, "main").first());
      await treeRow(page, "main").first().click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Import Data into New Table/ }).click();
      const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("import-file") });
      await dialog.waitFor();
      await dialog.getByTestId("import-file").fill(csv);
      await dialog.getByTestId("import-preview").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => dialog.getByTestId("import-table").inputValue()).toBe("people");
      const importButton = dialog.getByRole("button", { name: "Import", exact: true });
      await expect.poll(() => importButton.isEnabled()).toBe(true);
      await importButton.click();
      await dialog.waitFor({ state: "detached" });
      const done = toolWindow(page, "Services").locator('[role="treeitem"][data-kind="import"][data-state="done"]');
      await done.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await query(page, "SELECT * FROM people ORDER BY id");
      await expect.poll(() => columnValues(page, 1)).toEqual(["Ada", "Grace", "Edsger"]);
      await captureWindow(page, "10-import");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteManualConsole_whenOneOfTwoEditsIsRefused_thenOnlyTheEditsAreUndoneAndEarlierWorkStays",
    async () => {
      const page = await launch({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      await chooseTransactionMode(page, "manual");
      await query(
        page,
        "INSERT INTO customers (id, name, email) VALUES (3, 'Edsger Dijkstra', 'edsger@example.com') RETURNING id",
      );
      await query(page, "SELECT * FROM orders ORDER BY id");
      await page.getByRole("button", { name: "Add Row", exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await editCell(page, page, 0, 2, "25.00");
      await editCell(page, page, 1, 2, "-1");
      await page.getByRole("button", { name: "Submit", exact: true }).click();
      await expect.poll(() => text(page.getByTestId("result-edit-error"))).toContain("CHECK constraint failed");
      expect(await page.getByText("transaction open", { exact: true }).count()).toBe(1);
      await captureWindow(page, "11-savepoints");

      await sqlEditor(page).fill("SELECT count(*) AS n FROM customers");
      await sqlEditor(page).press("Escape");
      await runAllButton(page).click();
      await page.getByRole("dialog").getByRole("button", { name: "Discard", exact: true }).click();
      await waitUntilReady(page);
      await expect.poll(() => columnValues(page, 0)).toEqual(["3"]);
      await rollbackButton(page).click();
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoManualConsolesOnOneFile_whenBothUpdateOneRow_thenTheSecondConflictsAndRollbackClearsIt",
    async () => {
      const { database } = await files();
      const page = await launch(on("analysis", database));
      const update = "UPDATE orders SET total = total + 1 WHERE id = 1";

      await chooseTransactionMode(page, "manual");
      await startStatement(page, update);
      await expect.poll(() => page.getByText("transaction open", { exact: true }).count()).toBe(1);
      await waitUntilReady(page);

      await pressChord(page, "Shift+L");
      await expect.poll(() => editorTabs(page).count()).toBe(2);
      await waitUntilReady(page);
      await chooseTransactionMode(page, "manual");
      await query(page, "SELECT total FROM orders WHERE id = 1");
      await expect.poll(() => page.getByText("transaction open", { exact: true }).count()).toBe(1);
      await startStatement(page, update);
      await expect.poll(() => text(consoleAlert(page)), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Conflict on update");
      await waitUntilReady(page);
      await captureWindow(page, "12-conflict");

      await rollbackButton(page).click();
      await expect.poll(() => page.getByText("transaction open", { exact: true }).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
