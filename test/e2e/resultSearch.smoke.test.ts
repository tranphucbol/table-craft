/**
 * Plan 023's live test: find and the local filter in console and table results, against
 * PostgreSQL, MySQL and SQLite. Gated, because it needs a display, a fresh build and the
 * containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/023 bun run test:smoke:db
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES, serverSkipped } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  answerExportDialog,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  exportDialog,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { applyFilter } from "./workflows.js";

const captureWindow = evidenceFor("023");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const DATABASES: readonly { name: string; datasource: () => Datasource }[] = [
  { name: "postgres", datasource: () => POSTGRES },
  { name: "mysql", datasource: () => MYSQL },
  { name: "sqlite", datasource: sqlite },
];

/**
 * 10,000 rows in every dialect: `n` 1..10,000, `name` 'Alpha' on every tenth row (1,000 rows, 50
 * in the first 500-row page) and `note` NULL where the tens digit is 3.
 */
const TEN_THOUSAND = [
  "WITH d(v) AS (SELECT 0 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4",
  "UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)",
  "SELECT a.v * 1000 + b.v * 100 + c.v * 10 + e.v + 1 AS n,",
  "CASE WHEN e.v = 0 THEN 'Alpha' ELSE 'beta' END AS name,",
  "CASE WHEN c.v = 3 THEN NULL ELSE 'note' END AS note",
  "FROM d a, d b, d c, d e ORDER BY n",
].join(" ");
const ALPHA_ROWS = 1_000;
const ALPHA_IN_FIRST_PAGE = 50;
/** The last Alpha row, n = 9,991, in the second-to-last window. */
const LAST_ALPHA_INDEX = 9_990;

function toolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Result" });
}

function toolbarButton(page: Page, name: string) {
  return toolbar(page).getByRole("button", { name, exact: true });
}

function resultState(page: Page) {
  return page.getByTestId("result-state");
}

function findBar(page: Page) {
  return page.getByRole("search", { name: "Find in result" });
}

function findInput(page: Page) {
  return page.getByTestId("find-input");
}

function findStatus(page: Page) {
  return page.getByTestId("find-status");
}

function findScope(page: Page) {
  return page.getByTestId("find-scope");
}

function chips(page: Page) {
  return page.getByTestId("filter-chip");
}

function header(page: Page, name: string) {
  return page.locator(`[role="columnheader"][data-column-name="${name}"]`);
}

function cell(page: Page, row: number, column: number) {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

function currentMatch(page: Page) {
  return page.locator('[role="gridcell"][data-match="current"]');
}

/** Whether `target` is drawn wholly inside the grid's scroller, below its header row. */
async function insideGrid(page: Page, target: Locator): Promise<boolean> {
  const scroller = await page.getByRole("grid").boundingBox();
  const header = await page.getByRole("columnheader").first().boundingBox();
  const box = await target.boundingBox();
  if (scroller === null || header === null || box === null) return false;
  return box.y >= header.y + header.height - 1 && box.y + box.height <= scroller.y + scroller.height + 1;
}

async function columnValues(page: Page, column: number): Promise<string[]> {
  return columnSnapshot(page.locator(`[role="gridcell"][data-col="${String(column)}"]`));
}

async function query(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  // Closes the completion popup typing opened, which would cover the grid in the evidence.
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Opens the find bar from the grid with ⌘F/Ctrl+F and types `text`. */
async function find(page: Page, text: string): Promise<void> {
  await cell(page, 0, 0).click();
  await pressChord(page, "F");
  await findInput(page).waitFor();
  await findInput(page).fill(text);
}

/** Picks a local filter entry from a column header's menu, for the focused row's value. */
async function headerFilter(page: Page, column: string, entry: string): Promise<void> {
  await header(page, column).click({ button: "right" });
  await page.getByRole("menuitem", { name: entry, exact: true }).click();
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

describe.runIf(DATABASES_ENABLED)("result find and local filter live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(async () => {
    await closeRunning();
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<RunningApp> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  for (const { name, datasource } of DATABASES) {
    it.skipIf(serverSkipped(datasource().pluginId))(
      `givenTenThousandRows_whenFoundOnThe${name}Grid_thenCountHighlightAndStepsAcrossWindows`,
      async () => {
        const { page } = await launch(datasource());
        await query(page, TEN_THOUSAND);
        await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");

        await find(page, "alpha");
        await expect.poll(() => findStatus(page).textContent()).toBe(`1 of ${String(ALPHA_IN_FIRST_PAGE)}`);
        expect(await findScope(page).textContent()).toContain("Searched 500 fetched rows");
        await expect.poll(() => currentMatch(page).getAttribute("data-row")).toBe("0");
        await expect.poll(() => page.locator('[role="gridcell"][data-match="match"]').count()).toBeGreaterThan(0);

        await findInput(page).press("Enter");
        await expect.poll(() => findStatus(page).textContent()).toBe(`2 of ${String(ALPHA_IN_FIRST_PAGE)}`);
        await expect.poll(() => currentMatch(page).getAttribute("data-row")).toBe("10");
        await findInput(page).press("Shift+Enter");
        await expect.poll(() => findStatus(page).textContent()).toBe(`1 of ${String(ALPHA_IN_FIRST_PAGE)}`);
        await captureWindow(page, `find-first-page-${name}`);

        await findScope(page).getByRole("button", { name: "Search All Rows", exact: true }).click();
        await expect
          .poll(() => findStatus(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
          .toBe(`1 of ${ALPHA_ROWS.toLocaleString("en-US")}`);
        expect(await resultState(page).textContent()).toBe("10,000 rows");
        expect(await findScope(page).count()).toBe(0);

        const started = Date.now();
        await findInput(page).fill("ALPHA");
        await expect.poll(() => findStatus(page).textContent()).toBe(`1 of ${ALPHA_ROWS.toLocaleString("en-US")}`);
        console.info(`find over 10,000 rows on ${name}: ${String(Date.now() - started)} ms, typing settle included`);

        await findInput(page).press("Shift+Enter");
        await expect.poll(() => findStatus(page).textContent()).toBe("1,000 of 1,000");
        await expect.poll(() => currentMatch(page).getAttribute("data-row")).toBe(String(LAST_ALPHA_INDEX));
        await expect.poll(() => insideGrid(page, currentMatch(page))).toBe(true);
        await captureWindow(page, `find-across-windows-${name}`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "givenFindBar_whenCaseRegexAndWholeCellToggled_thenCountsFollowAndBadRegexSaysWhy",
    async () => {
      const { page } = await launch(MYSQL);
      await query(page, TEN_THOUSAND);
      await find(page, "alpha");
      await expect.poll(() => findStatus(page).textContent()).toBe("1 of 50");

      await findBar(page).getByRole("button", { name: "Match Case", exact: true }).click();
      await expect.poll(() => findStatus(page).textContent()).toBe("No matches");
      await findInput(page).fill("Alpha");
      await expect.poll(() => findStatus(page).textContent()).toBe("1 of 50");

      await findInput(page).fill("^(Al|be)");
      await findBar(page).getByRole("button", { name: "Regular Expression", exact: true }).click();
      await expect.poll(() => findStatus(page).textContent()).toBe("1 of 500");
      await findInput(page).fill("(Al");
      await expect.poll(() => findStatus(page).textContent()).toContain("Invalid regular expression");
      expect(await resultState(page).textContent()).toBe("500+ rows");
      await captureWindow(page, "invalid-regex");

      await findInput(page).fill("not");
      await findBar(page).getByRole("button", { name: "Regular Expression", exact: true }).click();
      await expect.poll(() => findStatus(page).textContent()).toBe("1 of 450");
      await findBar(page).getByRole("button", { name: "Whole Cell", exact: true }).click();
      await expect.poll(() => findStatus(page).textContent()).toBe("No matches");
      await findInput(page).fill("note");
      await expect.poll(() => findStatus(page).textContent()).toBe("1 of 450");
      await captureWindow(page, "case-regex-whole-cell");

      await findBar(page).getByRole("button", { name: "Filter Rows", exact: true }).click();
      await expect.poll(() => resultState(page).textContent()).toBe("450 of 500+ rows · filtered locally");
      await captureWindow(page, "filter-rows");

      await findInput(page).press("Escape");
      await expect.poll(() => findBar(page).count()).toBe(0);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenHeaderMenu_whenFilteredByValueAndIsNull_thenChipsHideRowsUntilCleared",
    async () => {
      const { page } = await launch(sqlite());
      await query(page, TEN_THOUSAND);

      await cell(page, 0, 1).click();
      await headerFilter(page, "name", "Filter by This Value");
      await expect.poll(() => resultState(page).textContent()).toBe("50 of 500+ rows · filtered locally");
      expect(await chips(page).allTextContents()).toEqual([expect.stringContaining("name = Alpha")]);
      expect(await columnValues(page, 1)).toSatisfy((names: string[]) => names.every((text) => text === "Alpha"));

      await cell(page, 3, 2).click();
      expect(await cell(page, 3, 2).textContent()).toBe("<null>");
      await headerFilter(page, "note", "Is NULL");
      await expect.poll(() => resultState(page).textContent()).toBe("5 of 500+ rows · filtered locally");
      expect(await columnValues(page, 0)).toEqual(["31", "131", "231", "331", "431"]);
      await captureWindow(page, "filter-chips");

      await page.getByRole("button", { name: "Remove note IS NULL", exact: true }).click();
      await expect.poll(() => resultState(page).textContent()).toBe("50 of 500+ rows · filtered locally");
      await cell(page, 0, 1).click();
      await headerFilter(page, "name", "Exclude This Value");
      await expect.poll(() => resultState(page).textContent()).toBe("0 of 500+ rows · filtered locally");
      await page.getByTestId("filter-chips").getByRole("button", { name: "Clear", exact: true }).click();
      await expect.poll(() => chips(page).count()).toBe(0);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenLocalFilter_whenCopiedAndExported_thenVisibleRowsOnlyOrTheWholeResult",
    async () => {
      const { app, page } = await launch(POSTGRES);
      const folder = mkdtempSync(join(tmpdir(), "table-craft-search-"));
      scratch.push(folder);
      await query(page, TEN_THOUSAND);
      await cell(page, 0, 1).click();
      await headerFilter(page, "name", "Filter by This Value");
      await expect.poll(() => resultState(page).textContent()).toBe("50 of 500+ rows · filtered locally");

      await cell(page, 0, 0).click();
      await pressChord(page, "A");
      await pressChord(page, "C");
      await expect.poll(async () => (await clipboardText(app)).split("\n").length).toBe(ALPHA_IN_FIRST_PAGE + 2);
      const copied = (await clipboardText(app)).split("\n");
      expect(copied.slice(0, 3)).toEqual(["n,name,note", "1,Alpha,note", "11,Alpha,note"]);

      await toolbarButton(page, "Export Data…").click();
      const dialog = exportDialog(page);
      await dialog.waitFor();
      expect(await dialog.getByRole("radio", { name: "Visible rows only (50)", exact: true }).isChecked()).toBe(true);
      expect(await dialog.getByTestId("export-note").textContent()).toContain("local filter keeps");
      await captureWindow(page, "export-visible-only");
      const shown = join(folder, "shown.csv");
      await answerExportDialog(page, shown);
      await expect
        .poll(() => readFileSync(shown, "utf8").split("\n").length, { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(ALPHA_IN_FIRST_PAGE + 2);

      await toolbarButton(page, "Export Data…").click();
      await dialog.waitFor();
      await dialog.getByRole("radio", { name: "Whole result", exact: true }).click();
      const whole = join(folder, "whole.csv");
      await answerExportDialog(page, whole);
      await expect
        .poll(
          () => {
            try {
              return readFileSync(whole, "utf8").split("\n").length;
            } catch {
              return 0;
            }
          },
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toBe(10_000 + 2);
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const { name, datasource } of DATABASES) {
    it.skipIf(serverSkipped(datasource().pluginId))(
      `givenTableEditorOn${name}_whenLocalFilterBesideWhere_thenRowsHiddenLocallyAndLabelled`,
      async () => {
        const { page } = await launch(datasource());
        const explorer = toolWindow(page, "Database");
        const tables = explorer.getByRole("treeitem", { name: "tables 6", exact: true });
        await tables.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await tables.click();
        await page.keyboard.press("ArrowRight");
        await explorer.getByRole("treeitem", { name: "orders", exact: true }).click();
        await page.keyboard.press("F4");
        await expect.poll(() => activeEditorTab(page).textContent()).toContain("orders");
        const editor = page.getByTestId("table-editor");
        await editor.locator('[role="gridcell"][data-row="0"][data-col="0"]').waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await applyFilter(page, "total > 1", "id");
        await expect.poll(() => columnValues(page, 0)).toEqual(["1", "2", "3"]);

        await cell(page, 0, 1).click();
        await headerFilter(page, "customer_id", "Filter by This Value");
        await expect.poll(() => columnValues(page, 0)).toEqual(["1", "2"]);
        expect(await page.getByTestId("filter-chips").textContent()).toContain("Local filter (fetched rows):");
        expect(await page.getByTestId("filter-chips").textContent()).toContain("customer_id = 1");

        await find(page, "2");
        await expect.poll(() => findStatus(page).textContent()).toBe("1 of 3");
        await captureWindow(page, `table-local-filter-${name}`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});
