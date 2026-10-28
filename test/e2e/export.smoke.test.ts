/**
 * Plan 018's live test: background exports to CSV, JSON and XLSX from the result grid and the
 * explorer, their progress in Services and the status bar, Cancel, and a stalled network caught by
 * the watchdog and recovered with Retry. SQLite always runs; PostgreSQL and MySQL need the
 * `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/018 bun run test:smoke:db
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { chaosProxy, type ChaosProxy } from "../support/chaosProxy.js";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { readZip } from "../support/zipReader.js";
import {
  answerExportDialog,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  exportDialog,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("018");

const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

/** Large enough that the export is still running when the scenario looks, at about 140 bytes a row. */
const CANCELLED_ROWS = 10_000_000;
const CANCELLED_SQL = `SELECT g AS id, repeat(md5(g::text), 4) AS label FROM generate_series(1, ${String(CANCELLED_ROWS)}) g`;
const STALLED_ROWS = 200_000;
const STALLED_SQL = `SELECT g AS id, md5(g::text) AS label FROM generate_series(1, ${String(STALLED_ROWS)}) g ORDER BY g`;
/** Slow enough that the stall lands mid-file: the whole result is about 8 MB. */
const SLOW_LINK_BYTES_PER_SECOND = 200_000;
/** The setting's minimum, so the watchdog fires within the scenario. */
const STALL_SECONDS = 10;
const STALL_WAIT_MS = (STALL_SECONDS + 20) * 1_000;
/** Rows the evidence waits for before it looks, so the progress it shows is a real stretch of file. */
const SHOWN_PROGRESS_ROWS = 5_000;
const CHAOS_SCENARIO_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 3;

function services(page: Page) {
  return toolWindow(page, "Services");
}

function exportRows(page: Page, state?: string) {
  const rows = services(page).locator('[role="treeitem"][data-kind="export"]');
  return state === undefined ? rows : rows.and(page.locator(`[data-state="${state}"]`));
}

function exportingStatus(page: Page) {
  return page.getByTestId("status-exporting");
}

function resultToolbarButton(page: Page, name: string) {
  return page.getByRole("toolbar", { name: "Result" }).getByRole("button", { name, exact: true });
}

function resultTab(page: Page, title: string) {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title}$`) });
}

function output(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

/** Runs one row-returning statement and waits for its grid. */
async function query(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  // Closes the completion popup typing opened, which would cover the grid in the evidence.
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** The rows the running export reports in its Services row, read from its progress text. */
async function exportedRows(page: Page): Promise<number> {
  const text = (await exportRows(page).first().getByTestId("export-progress").textContent()) ?? "";
  const match = /^([\d,]+) /.exec(text);
  return match === null ? 0 : Number(match[1]?.replaceAll(",", ""));
}

function lineCount(path: string): number {
  return readFileSync(path, "utf8").split("\n").length;
}

describe.runIf(SMOKE_ENABLED)("streaming export live test", () => {
  let running: RunningApp | null = null;
  let proxy: ChaosProxy | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await proxy?.close();
    proxy = null;
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function launch(datasource: Datasource, userDataDir?: string): Promise<Page> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  function folder(): string {
    const path = mkdtempSync(join(tmpdir(), "table-craft-export-"));
    scratch.push(path);
    return path;
  }

  it(
    "givenGridResult_whenExportedAsXlsxWithoutAColumn_thenWorkbookHoldsTheRestAndServicesShowsDone",
    async () => {
      const page = await launch(sqlite());
      const path = join(folder(), "customers.xlsx");
      await query(page, "SELECT * FROM customers ORDER BY id");

      await resultToolbarButton(page, "Export Data…").click();
      const dialog = exportDialog(page);
      await dialog.getByRole("radio", { name: "Excel (XLSX)", exact: true }).click();
      await dialog.getByTestId("export-columns").getByRole("checkbox", { name: "email", exact: true }).uncheck();
      await dialog.getByTestId("export-file").fill(path);
      await captureWindow(page, "export-dialog");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();

      await exportRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await exportRows(page).first().getAttribute("aria-label")).toMatch(/^customers\.xlsx, done, 2 rows/);
      const sheet = readZip(readFileSync(path)).entries.find((entry) => entry.name === "xl/worksheets/sheet1.xml");
      const xml = sheet?.text() ?? "";
      expect(xml).toContain("Ada Lovelace");
      expect(xml).toContain("Grace Hopper");
      expect(xml).not.toContain("email");
      expect(xml).not.toContain("ada@example.com");
      await captureWindow(page, "xlsx-done-services");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIntegersPastExcelDigits_whenExportedAsXlsx_thenCellsKeepEveryDigit",
    async () => {
      const page = await launch(sqlite());
      const path = join(folder(), "long-integers.xlsx");
      await query(
        page,
        "SELECT 1234567890123456 AS sixteen, 9007199254740993 AS past_double, 123456789012345 AS fifteen",
      );

      await resultToolbarButton(page, "Export Data…").click();
      const dialog = exportDialog(page);
      await dialog.getByRole("radio", { name: "Excel (XLSX)", exact: true }).click();
      await dialog.getByTestId("export-file").fill(path);
      await dialog.getByRole("button", { name: "Export", exact: true }).click();

      await exportRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const sheet = readZip(readFileSync(path)).entries.find((entry) => entry.name === "xl/worksheets/sheet1.xml");
      const xml = sheet?.text() ?? "";
      expect(xml).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">1234567890123456</t></is></c>');
      expect(xml).toContain('<c r="B2" t="inlineStr"><is><t xml:space="preserve">9007199254740993</t></is></c>');
      expect(xml).toContain('<c r="C2"><v>123456789012345</v></c>');
      await captureWindow(page, "xlsx-long-integers");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenLongPostgresExport_whenCancelledFromServices_thenCancelledAndNoFileLeft",
    async () => {
      const page = await launch({ id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG });
      const directory = folder();
      const path = join(directory, "series.csv");
      await query(page, CANCELLED_SQL);

      await resultToolbarButton(page, "Export Data…").click();
      await answerExportDialog(page, path, "CSV");

      await exportRows(page, "running").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => exportedRows(page), { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThan(SHOWN_PROGRESS_ROWS);
      await expect(exportingStatus(page).textContent()).resolves.toMatch(/^Exporting 1/);
      // The console is free while the export re-runs its statement on a session of its own.
      await expect(runAllButton(page).isEnabled()).resolves.toBe(true);
      await captureWindow(page, "export-running");

      await exportRows(page, "running").locator('[data-action="export.cancel"]').click();
      await exportRows(page, "cancelled").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await exportRows(page).first().getAttribute("aria-label")).toMatch(
        /^series\.csv, cancelled, [\d,]+ rows before it stopped/,
      );
      expect(readdirSync(directory)).toEqual([]);
      await expect.poll(() => exportingStatus(page).count()).toBe(0);
      await resultTab(page, "Output").click();
      await expect.poll(() => output(page).textContent()).toContain("Export cancelled.");
      await captureWindow(page, "export-cancelled");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenNetworkStallsMidExport_whenWatchdogFires_thenFailedWithRowsWrittenAndRetrySucceeds",
    async () => {
      proxy = await chaosProxy({ host: POSTGRES_CONFIG.host, port: POSTGRES_CONFIG.port });
      const userDataDir = newProfile();
      scratch.push(userDataDir);
      seedSettings(userDataDir, { version: 1, data: { exportStallSeconds: STALL_SECONDS } });
      const page = await launch(
        { id: "pg", pluginId: "postgres", config: { ...POSTGRES_CONFIG, host: proxy.host, port: proxy.port } },
        userDataDir,
      );
      const directory = folder();
      const path = join(directory, "stalled.csv");
      await query(page, STALLED_SQL);

      proxy.bytesPerSecond = SLOW_LINK_BYTES_PER_SECOND;
      await resultToolbarButton(page, "Export Data…").click();
      await answerExportDialog(page, path, "CSV");
      await expect.poll(() => exportedRows(page), { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThan(SHOWN_PROGRESS_ROWS);
      proxy.stall();

      await exportRows(page, "failed").waitFor({ timeout: STALL_WAIT_MS });
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
      await resultTab(page, "Output").click();
      await expect
        .poll(() => output(page).textContent())
        .toMatch(/The server sent nothing for 10 seconds.*rows were written before it stopped\./);
      await captureWindow(page, "export-stalled");

      proxy.resume();
      proxy.bytesPerSecond = 0;
      await exportRows(page, "failed").locator('[data-action="export.retry"]').click();
      await exportRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(lineCount(path)).toBe(STALLED_ROWS + 2);
      expect(readdirSync(directory)).toEqual(["stalled.csv"]);
      await captureWindow(page, "export-retried");
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenMysqlTableInExplorer_whenExportedAsJson_thenEveryRowWritten",
    async () => {
      const page = await launch(MYSQL);
      const path = join(folder(), "orders.json");
      const database = toolWindow(page, "Database");
      const group = database.getByRole("treeitem", { name: /^tables \d+$/ });
      await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      if ((await group.getAttribute("aria-expanded")) !== "true") {
        await group.click();
        await page.keyboard.press("ArrowRight");
      }
      await database.getByRole("treeitem", { name: "orders", exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Export Data/ }).click();
      const dialog = exportDialog(page);
      await dialog.getByRole("radio", { name: "JSON", exact: true }).click();
      await dialog.getByTestId("export-file").fill(path);
      await captureWindow(page, "explorer-export-dialog");
      await dialog.getByRole("button", { name: "Export", exact: true }).click();

      await exportRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const rows = JSON.parse(readFileSync(path, "utf8")) as unknown[];
      expect(rows).toHaveLength(3);
      await captureWindow(page, "explorer-export-done");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
