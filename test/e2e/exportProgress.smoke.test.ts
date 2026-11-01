/**
 * Plan 138's live test: the Exports chip in the status bar (name, rows or percent, bar, clock and
 * Cancel), its popover with Cancel All, the grid toolbar's Cancel for a cursor export, the done
 * flash and a failure that stays until it is seen. SQLite always runs; MySQL needs the
 * `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/138 bun run test:smoke:db:headless test/e2e/exportProgress.smoke.test.ts
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
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
  showServices,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureNow = evidenceFor("138");
/**
 * Run in the page: popovers fade in, so a capture waits for every finite animation; the spinner
 * and the indeterminate bar loop forever and are left out.
 */
const ANIMATIONS_FINISHED =
  "Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished))";

async function captureWindow(page: Page, name: string): Promise<void> {
  await page.evaluate(ANIMATIONS_FINISHED);
  await captureNow(page, name);
}

const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
/** In memory the export cannot re-run its statement elsewhere, so it drains the console's cursor. */
const IN_MEMORY_SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: ":memory:" } };

const ENDLESS_SQL =
  "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i, hex(randomblob(64)) AS label FROM n";
/** Fewer rows than the first page, so the console's result is complete and the export knows its total. */
const SLOW_ROWS = 300;
/**
 * Each row outgrows MySQL's 16 KiB `net_buffer_length`, so the server sends it as soon as its
 * SLEEP ends instead of the whole result at once, and the export's progress moves.
 */
const ROW_PAD_BYTES = 20_000;
const SLOW_MYSQL_SQL = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(SLOW_ROWS)}) SELECT i, SLEEP(0.02) AS s, REPEAT('x', ${String(ROW_PAD_BYTES)}) AS pad FROM n`;
/** Fails mid-file: the first page reads fine, the re-run export breaks on its first malformed JSON. */
const BROKEN_AFTER_ROWS = 150_000;
const BROKEN_SQL = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(BROKEN_AFTER_ROWS * 2)}) SELECT i, CASE WHEN i < ${String(BROKEN_AFTER_ROWS)} THEN i ELSE json('not json ' || i) END AS v FROM n`;
const BIG_TABLE = "big";
const BIG_TABLE_ROWS = 3_000_000;
/** Rows the evidence waits for before it looks, so what it shows is a real stretch of file. */
const SHOWN_PROGRESS_ROWS = 5_000;
const SHOWN_PERCENT = 10;
const CLOCK_TEXT = /^\d+:\d\d$/;

function chip(page: Page) {
  return page.getByTestId("status-exporting");
}

function chipLabel(page: Page) {
  return page.getByTestId("status-exporting-label");
}

function popover(page: Page) {
  return page.getByTestId("exports-popover");
}

function resultToolbarButton(page: Page, name: string) {
  return page.getByRole("toolbar", { name: "Result" }).getByRole("button", { name, exact: true });
}

function servicesExports(page: Page, state: string) {
  return toolWindow(page, "Services").locator(`[role="treeitem"][data-kind="export"][data-state="${state}"]`);
}

/** The rows a label such as `big.csv · 412,300 rows` names, or 0. */
function rowsIn(text: string | null): number {
  const match = /([\d,]+) rows/.exec(text ?? "");
  return match === null ? 0 : Number(match[1]?.replaceAll(",", ""));
}

function percentIn(text: string | null): number {
  const match = /(\d+)%$/.exec(text ?? "");
  return match === null ? 0 : Number(match[1]);
}

async function query(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  // Closes the completion popup typing opened, which would cover the grid in the evidence.
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function exportResult(page: Page, path: string): Promise<void> {
  await resultToolbarButton(page, "Export Data…").click();
  await answerExportDialog(page, path, "CSV");
}

/** A seeded SQLite file with a table large enough that its export is still running when the test looks. */
function bigSqliteFile(): string {
  const path = seededSqliteFile();
  const database = new DatabaseSync(path);
  try {
    database.exec(
      `CREATE TABLE ${BIG_TABLE} AS WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${String(BIG_TABLE_ROWS)}) SELECT i AS id, printf('row %08d', i) AS label FROM n`,
    );
  } finally {
    database.close();
  }
  return path;
}

describe.runIf(SMOKE_ENABLED)("export progress and cancel live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** In the Dark theme, the one the plan's mockup was drawn in, so the evidence compares with it. */
  async function launch(datasource: Datasource): Promise<Page> {
    const userDataDir = newProfile();
    scratch.push(userDataDir);
    seedSettings(userDataDir, { version: 1, appearance: { theme: "dark" } });
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await showServices(running.page);
    return running.page;
  }

  function folder(): string {
    const path = mkdtempSync(join(tmpdir(), "table-craft-export-progress-"));
    scratch.push(path);
    return path;
  }

  function sqliteFile(path: string): Datasource {
    scratch.push(dirname(path));
    return { id: "lite", pluginId: "sqlite", config: { path } };
  }

  it.runIf(DATABASES_ENABLED)(
    "givenCompleteMysqlResult_whenExported_thenChipShowsPercentAndClockThenFlashesDone",
    async () => {
      const page = await launch(MYSQL);
      const path = join(folder(), "slow.csv");
      await query(page, SLOW_MYSQL_SQL);
      await exportResult(page, path);

      await expect
        .poll(async () => percentIn(await chipLabel(page).textContent()), { timeout: LAUNCH_TIMEOUT_MS })
        .toBeGreaterThanOrEqual(SHOWN_PERCENT);
      expect(await chipLabel(page).textContent()).toMatch(/^slow\.csv · \d+%$/);
      expect(await page.getByTestId("status-exporting-clock").textContent()).toMatch(CLOCK_TEXT);
      expect(await chip(page).getByRole("progressbar").getAttribute("aria-valuenow")).not.toBeNull();
      await captureWindow(page, "01-chip-percent");

      await expect
        .poll(() => chipLabel(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^slow\.csv · 300 rows · [\d.]+ m?s$/);
      expect(await chip(page).getAttribute("data-tone")).toBe("done");
      await captureWindow(page, "06-done-flash");

      await chip(page).click();
      const row = popover(page).getByTestId("exports-popover-row");
      await expect.poll(() => row.getAttribute("data-state")).toBe("done");
      await expect(row.getByTestId("exports-row-reveal").isVisible()).resolves.toBe(true);
      await captureWindow(page, "06-done-popover");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenInMemoryCursor_whenExported_thenGridAndChipShowRowsAndGridCancelFreesIt",
    async () => {
      const page = await launch(IN_MEMORY_SQLITE);
      const directory = folder();
      await query(page, ENDLESS_SQL);
      await exportResult(page, join(directory, "endless.csv"));

      const draining = page.getByTestId("result-exporting");
      await expect
        .poll(async () => rowsIn(await draining.textContent()), { timeout: LAUNCH_TIMEOUT_MS })
        .toBeGreaterThan(SHOWN_PROGRESS_ROWS);
      expect(await chipLabel(page).textContent()).toMatch(/^endless\.csv · [\d,]+ rows$/);
      expect(await chip(page).getByRole("progressbar").getAttribute("data-indeterminate")).not.toBeNull();
      await captureWindow(page, "02-chip-cursor");

      await page.getByTestId("result-exporting-cancel").click();
      await expect.poll(() => draining.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await expect.poll(() => page.getByTestId("result-state").textContent()).toMatch(/· export cancelled$/);
      await expect.poll(() => chip(page).count()).toBe(0);
      await servicesExports(page, "cancelled").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(readdirSync(directory)).toEqual([]);
      await captureWindow(page, "05-grid-cancel");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOneRunningExport_whenChipCancelClicked_thenCancelledAndNoFileLeft",
    async () => {
      const page = await launch(sqliteFile(seededSqliteFile()));
      const directory = folder();
      await query(page, ENDLESS_SQL);
      await exportResult(page, join(directory, "endless.csv"));

      await expect
        .poll(async () => rowsIn(await chipLabel(page).textContent()), { timeout: LAUNCH_TIMEOUT_MS })
        .toBeGreaterThan(SHOWN_PROGRESS_ROWS);
      await page.getByTestId("status-exporting-cancel").click();

      await expect.poll(() => chip(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await servicesExports(page, "cancelled").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(readdirSync(directory)).toEqual([]);
      await captureWindow(page, "03-chip-cancel");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoRunningExports_whenPopoverOpened_thenBothListedAndCancelAllStopsThem",
    async () => {
      const page = await launch(sqliteFile(seededSqliteFile()));
      const directory = folder();
      await query(page, ENDLESS_SQL);
      await exportResult(page, join(directory, "first.csv"));
      await exportResult(page, join(directory, "second.csv"));

      await expect.poll(() => chipLabel(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("2 exports");
      expect(await page.getByTestId("status-exporting-cancel").count()).toBe(0);
      await chip(page).click();
      const rows = popover(page).getByTestId("exports-popover-row");
      await expect.poll(() => rows.count()).toBe(2);
      await expect
        .poll(async () => rowsIn(await rows.last().getByTestId("exports-row-detail").textContent()), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toBeGreaterThan(SHOWN_PROGRESS_ROWS);
      await expect.poll(() => rows.first().getByTestId("exports-row-detail").textContent()).toMatch(/rows\/s/);
      await captureWindow(page, "04-popover");

      await popover(page).getByRole("button", { name: "Cancel All Exports" }).click();
      await expect.poll(() => servicesExports(page, "cancelled").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      expect(readdirSync(directory)).toEqual([]);
      await captureWindow(page, "04-popover-cancelled-all");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenExportFailsMidFile_whenFinished_thenChipStaysRedUntilPopoverOpened",
    async () => {
      const page = await launch(sqliteFile(seededSqliteFile()));
      await query(page, BROKEN_SQL);
      await exportResult(page, join(folder(), "broken.csv"));

      await expect
        .poll(() => chipLabel(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("Export failed · broken.csv");
      expect(await chip(page).getAttribute("data-tone")).toBe("failed");
      await captureWindow(page, "06-failed-chip");

      await chip(page).click();
      await expect
        .poll(() => popover(page).getByTestId("exports-popover-row").getAttribute("data-state"))
        .toBe("failed");
      expect(await chipLabel(page).textContent()).toBe("Export failed · broken.csv");
      await captureWindow(page, "06-failed-popover");
      await page.keyboard.press("Escape");
      await expect.poll(() => chip(page).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLargeTableInExplorer_whenExported_thenChipShowsRowsAndCancelStopsIt",
    async () => {
      const page = await launch(sqliteFile(bigSqliteFile()));
      const directory = folder();
      const database = toolWindow(page, "Database");
      const group = database.getByRole("treeitem", { name: /^tables \d+$/ });
      await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      if ((await group.getAttribute("aria-expanded")) !== "true") {
        await group.click();
        await page.keyboard.press("ArrowRight");
      }
      await database.getByRole("treeitem", { name: BIG_TABLE, exact: true }).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Export Data/ }).click();
      const dialog = exportDialog(page);
      await dialog.getByRole("radio", { name: "CSV", exact: true }).click();
      await dialog.getByTestId("export-file").fill(join(directory, "big.csv"));
      await dialog.getByRole("button", { name: "Export", exact: true }).click();

      await expect
        .poll(async () => rowsIn(await chipLabel(page).textContent()), { timeout: LAUNCH_TIMEOUT_MS })
        .toBeGreaterThan(SHOWN_PROGRESS_ROWS);
      expect(await chipLabel(page).textContent()).toMatch(/^big\.csv · [\d,]+ rows$/);
      await captureWindow(page, "07-table-export");

      await page.getByTestId("status-exporting-cancel").click();
      await servicesExports(page, "cancelled").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(readdirSync(directory)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
