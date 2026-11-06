/**
 * Plan 155's live test: a result drawn as a chart in the console and the table editor, on SQLite,
 * MySQL, TiDB and PostgreSQL when `TABLE_CRAFT_DATABASES` selects it. The SQLite scenarios run in
 * every smoke run; the others need the `test/db/compose.yml` servers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/155 bun run test:smoke:db:headless:postgres test/e2e/chart.smoke.test.ts
 *
 * Every query makes its own rows, so nothing here writes to the shared fixtures.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, TIDB_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { setTheme } from "./diagramLive.js";
import {
  activeEditorTab,
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("155");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const TIDB: Datasource = { id: "tidb", pluginId: "mysql", config: TIDB_CONFIG };
const PNG_SIGNATURE = "89504e470d0a1a0a";
const TABLES_GROUP = "tables 6";

/** Sales per country, one row each: three bars, three slices. */
const BY_COUNTRY = `SELECT 'VN' AS country, 1200.50 AS total UNION ALL SELECT 'US', 900 UNION ALL SELECT 'DE', 315.25`;

/** Two series over ten days. */
const SQLITE_DAYS = `WITH RECURSIVE d(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM d WHERE n < 9)
SELECT date('2024-01-01', '+' || n || ' days') AS day, 10 + n * 3 AS orders, 50 + (n % 4) * 20 AS refunds FROM d`;

/** A thousand rows, two pages: the chart plots the first until Fetch All reads the rest. */
const SQLITE_THOUSAND = `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 1000)
SELECT (n * 7919) % 997 / 10.0 AS amount FROM r`;

/** Five trading days as open, high, low, close; two fall. */
const SQLITE_STOCK = `SELECT '2024-03-01' AS day, 10.0 AS open, 12.5 AS high, 9.5 AS low, 12.0 AS close
UNION ALL SELECT '2024-03-04', 12.0, 13.0, 10.5, 11.0
UNION ALL SELECT '2024-03-05', 11.0, 14.0, 10.8, 13.6
UNION ALL SELECT '2024-03-06', 13.6, 13.9, 12.0, 12.2
UNION ALL SELECT '2024-03-07', 12.2, 15.1, 12.0, 14.8`;

const POSTGRES_DAYS = `SELECT d::date AS day, (10 + n * 3)::int AS orders, (50 + (n % 4) * 20)::numeric(10,2) AS refunds
FROM generate_series(0, 29) AS n, LATERAL (SELECT DATE '2024-01-01' + n AS d) AS days ORDER BY day`;

const POSTGRES_THOUSAND = `SELECT round((random() * 40 + (n % 50))::numeric, 2) AS amount FROM generate_series(1, 1000) AS n`;

/** NULL and text where numbers belong: those rows are left out and counted. */
const NULL_GAPS = `SELECT 'a' AS label, 4 AS amount UNION ALL SELECT 'b', NULL UNION ALL SELECT 'c', 9 UNION ALL SELECT 'd', NULL`;

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

function chart(page: Page) {
  return page.locator('[data-testid="chart-view"] [role="img"]');
}

function status(page: Page) {
  return page.getByTestId("chart-status");
}

function chartButton(page: Page) {
  return page.getByRole("button", { name: "Show Chart", exact: true }).first();
}

/** The chart's refresh delay, the engine round trip and the animation, with apps running beside it. */
const DRAW_TIMEOUT_MS = 5_000;
/** One wheel notch toward the reader zooms the plot in. */
const ZOOM_WHEEL_PX = 300;

/** Waits until the last change has drawn, animation included. */
async function settled(page: Page): Promise<void> {
  await expect.poll(() => chart(page).getAttribute("data-chart-settled"), { timeout: DRAW_TIMEOUT_MS }).toBe("true");
}

async function showChart(page: Page, kind: string): Promise<void> {
  await chartButton(page).click();
  await expect.poll(() => chart(page).getAttribute("data-chart-kind"), { timeout: LAUNCH_TIMEOUT_MS }).toBe(kind);
  await settled(page);
}

async function pickKind(page: Page, kind: string): Promise<void> {
  await page.locator(`[data-chart-kind-option="${kind}"]`).click();
  await expect.poll(() => chart(page).getAttribute("data-chart-kind"), { timeout: DRAW_TIMEOUT_MS }).toBe(kind);
  await settled(page);
}

async function answerSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog: dialogs }, picked) => {
    dialogs.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: picked });
  }, path);
}

function fileHead(path: string): string {
  try {
    return readFileSync(path)
      .subarray(0, PNG_SIGNATURE.length / 2)
      .toString("hex");
  } catch {
    return "";
  }
}

/** The colour of the canvas pixel under the first series, read in the page. */
async function canvasHasInk(page: Page): Promise<boolean> {
  return chart(page)
    .locator("canvas")
    .first()
    .evaluate(
      (canvas: {
        getContext(kind: "2d"): { getImageData(...area: number[]): { data: ArrayLike<number> } } | null;
        width: number;
        height: number;
      }) => {
        const context = canvas.getContext("2d");
        if (context === null) return false;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        for (let index = 3; index < data.length; index += 4) if ((data[index] ?? 0) > 0) return true;
        return false;
      },
    );
}

describe.runIf(SMOKE_ENABLED)("chart view", () => {
  let running: RunningApp | null = null;
  let scratch = "";

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "table-craft-155-"));
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource?: Datasource): Promise<RunningApp> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenGroupedQuery_whenChartShown_thenBarPerCategoryThenPie",
    async () => {
      const { page } = await launch();
      await runStatement(page, BY_COUNTRY);

      await showChart(page, "bar");

      expect(await chart(page).getAttribute("aria-label")).toBe("Bar chart of total by country, 3 bars");
      expect(await chart(page).getAttribute("data-chart-points")).toBe("3");
      expect(await canvasHasInk(page)).toBe(true);
      await expect.poll(() => status(page).textContent()).toBe("Plotting 3 rows");

      await pickKind(page, "pie");
      expect(await chart(page).getAttribute("aria-label")).toBe("Pie chart of total by country, 3 slices");
      await captureWindow(page, "02-bar-then-pie-sqlite");

      await chartButton(page).click();
      await expect.poll(() => page.getByTestId("chart-view").count()).toBe(0);
      await expect.poll(() => page.getByRole("gridcell").first().textContent()).toBe("VN");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTimeSeries_whenChartShown_thenLineWithTwoSeries",
    async () => {
      const { page } = await launch();
      await runStatement(page, SQLITE_DAYS);
      await page.getByRole("gridcell").first().click();

      await pressChord(page, "Alt+C");

      // SQLite types an expression's date as text, so the suggestion is bars per day.
      await expect.poll(() => chart(page).getAttribute("data-chart-kind")).toBe("bar");
      await pickKind(page, "line");
      expect(await chart(page).getAttribute("data-chart-series")).toBe("2");
      expect(await chart(page).getAttribute("data-chart-points")).toBe("10");
      await captureWindow(page, "01-line-over-time-sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOhlcColumns_whenChartShown_thenCandles",
    async () => {
      const { page } = await launch();
      await runStatement(page, SQLITE_STOCK);

      await showChart(page, "bar");
      await pickKind(page, "stock");

      expect(await chart(page).getAttribute("aria-label")).toBe(
        "Stock chart of open, high, low, close by day, 5 candles",
      );
      expect(await canvasHasInk(page)).toBe(true);
      await captureWindow(page, "04-stock");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPartialResult_whenFetchAll_thenChartGrows",
    async () => {
      const { page } = await launch();
      await runStatement(page, SQLITE_THOUSAND);

      await showChart(page, "histogram");
      await expect.poll(() => status(page).textContent()).toContain("Plotting 500 rows");
      expect(await status(page).textContent()).toContain("more on the server");

      await page.getByRole("button", { name: "Fetch All", exact: true }).first().click();

      await expect.poll(() => chart(page).getAttribute("data-chart-rows")).toBe("1000");
      expect(await status(page).textContent()).toBe("Plotting 1,000 rows");
      await chooseOption(page.getByTestId("chart-bins"), "20");
      await expect.poll(() => chart(page).getAttribute("data-chart-points")).toBe("20");
      await settled(page);
      await captureWindow(page, "03-histogram-fetch-all-sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenChart_whenRerun_thenChartStaysWithSpec",
    async () => {
      const { page } = await launch();
      await runStatement(page, BY_COUNTRY);
      await showChart(page, "bar");
      await pickKind(page, "pie");

      await page.getByRole("button", { name: "Rerun", exact: true }).first().click();

      await expect.poll(() => chart(page).getAttribute("data-chart-kind")).toBe("pie");
      expect(await chart(page).getAttribute("data-chart-points")).toBe("3");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenChart_whenThemeSwitched_thenRepaintedWithoutReload",
    async () => {
      const { page } = await launch();
      await runStatement(page, SQLITE_DAYS);
      await showChart(page, "bar");
      await pickKind(page, "area");
      await setTheme(page, "Dark");
      await settled(page);
      await captureWindow(page, "07-themes-dark");

      await setTheme(page, "Light");

      await settled(page);
      await expect.poll(() => canvasHasInk(page)).toBe(true);
      expect(await chart(page).getAttribute("data-chart-kind")).toBe("area");
      await captureWindow(page, "07-themes-light");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenChart_whenExportedAsPng_thenFileWritten",
    async () => {
      const running = await launch();
      const { page } = running;
      await runStatement(page, BY_COUNTRY);
      await showChart(page, "bar");
      const path = join(scratch, "by-country.png");
      await answerSaveDialog(running.app, path);

      await page.getByRole("button", { name: "Export Chart as PNG…" }).click();

      await expect.poll(() => fileHead(path)).toBe(PNG_SIGNATURE);
      await captureWindow(page, "08-export-png");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOnlyText_whenChartShown_thenNothingToPlot",
    async () => {
      const { page } = await launch();
      await runStatement(page, "SELECT 'a' AS name UNION ALL SELECT 'b'");

      await chartButton(page).click();

      await page.getByText("Nothing to plot: the result has no numeric column.").waitFor();
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTableEditor_whenChartShown_thenPagePlotted",
    async () => {
      const { page } = await launch(sqlite());
      await openTable(page, "orders");

      await showChart(page, "bar");

      expect(await chart(page).getAttribute("data-chart-rows")).not.toBeNull();
      await captureWindow(page, "06-table-editor-sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );
});

async function openTable(page: Page, name: string): Promise<void> {
  const explorer = toolWindow(page, "Database");
  const group = explorer.getByRole("treeitem", { name: TABLES_GROUP, exact: true });
  await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
    await page.keyboard.press("ArrowRight");
  }
  await explorer.getByRole("treeitem", { name, exact: true }).click();
  await page.keyboard.press("F4");
  await expect.poll(() => activeEditorTab(page).textContent()).toContain(name);
  await page.getByTestId("table-editor").getByRole("gridcell").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

describe.runIf(DATABASES_ENABLED)("chart view on servers", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<RunningApp> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresTimeSeries_whenChartShown_thenLineOverDates",
    async () => {
      const { page } = await launch(POSTGRES);
      await runStatement(page, POSTGRES_DAYS);

      await showChart(page, "line");

      expect(await chart(page).getAttribute("aria-label")).toBe("Line chart of orders, refunds by day, 60 points");
      expect(await canvasHasInk(page)).toBe(true);
      await captureWindow(page, "01-line-over-time");

      const resetZoom = page.getByRole("button", { name: "Reset Chart Zoom" });
      await expect.poll(() => resetZoom.count()).toBe(0);
      await chart(page).hover();
      await page.mouse.wheel(0, -ZOOM_WHEEL_PX);
      await expect.poll(() => resetZoom.count(), { timeout: DRAW_TIMEOUT_MS }).toBe(1);
      await captureWindow(page, "09-zoomed");
      await resetZoom.click();
      await expect.poll(() => resetZoom.count(), { timeout: DRAW_TIMEOUT_MS }).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresThousandRows_whenFetchAll_thenHistogramOfEveryRow",
    async () => {
      const { page } = await launch(POSTGRES);
      await runStatement(page, POSTGRES_THOUSAND);
      await showChart(page, "histogram");
      await expect.poll(() => status(page).textContent()).toContain("more on the server");

      await page.getByRole("button", { name: "Fetch All", exact: true }).first().click();

      await expect.poll(() => chart(page).getAttribute("data-chart-rows")).toBe("1000");
      await settled(page);
      await captureWindow(page, "03-histogram-fetch-all");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlGroupedQuery_whenChartShown_thenBarThenPie",
    async () => {
      const { page } = await launch(MYSQL);
      await runStatement(page, BY_COUNTRY);

      await showChart(page, "bar");
      expect(await chart(page).getAttribute("aria-label")).toBe("Bar chart of total by country, 3 bars");
      await pickKind(page, "pie");

      expect(await chart(page).getAttribute("data-chart-points")).toBe("3");
      await captureWindow(page, "02-bar-then-pie");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTidbNulls_whenChartShown_thenSkippedRowsCounted",
    async () => {
      const { page } = await launch(TIDB);
      await runStatement(page, NULL_GAPS);

      await showChart(page, "bar");

      await expect
        .poll(() => status(page).textContent())
        .toBe("Plotting 4 rows · 2 rows skipped: NULL or not a number");
      // A label whose only value is NULL keeps its place on the axis with no bar.
      expect(await chart(page).getAttribute("aria-label")).toBe("Bar chart of amount by label, 4 bars");
      await captureWindow(page, "05-skipped");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlTable_whenChartShown_thenEditorPagePlotted",
    async () => {
      const { page } = await launch(MYSQL);
      await openTable(page, "orders");

      await showChart(page, "line");
      await pickKind(page, "bar");
      await chooseOption(page.getByTestId("chart-aggregate"), "count");

      await expect.poll(() => chart(page).getAttribute("aria-label")).toMatch(/^Bar chart of count of /u);
      await settled(page);
      await captureWindow(page, "06-table-editor");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
