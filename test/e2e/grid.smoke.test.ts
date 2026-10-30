/**
 * Plan 007's live test: the result grid against PostgreSQL, MySQL and SQLite, from the
 * `test/db/compose.yml` databases and a seeded SQLite file. Gated, because it needs a display, a
 * fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/007 bun run test:smoke:db
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerExportDialog,
  closeApp,
  columnSnapshot,
  cornerRadius,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  optionValue,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  chooseOption,
} from "./harness.js";

const captureWindow = evidenceFor("007");
const dropdownEvidence = evidenceFor("129");
const VALUE_PANEL_DRAG_PX = 100;
/**
 * Narrower than the evidence window, still wide enough that the dragged panel stays under 70 % of
 * the result area and the rows keep their 240 px.
 */
const NARROW_WINDOW = { width: 1100, height: EVIDENCE_WINDOW.height } as const;

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const PAGING_ROWS = 50_000;
/** The plan's paging fixture. */
const POSTGRES_PAGING = `SELECT g AS n, md5(g::text) AS hash FROM generate_series(1, ${String(PAGING_ROWS)}) g`;
/** More rows than Fetch All takes, so the fetch stops at the cap. */
const SQLITE_PAST_CAP = [
  "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 150000)",
  "SELECT n, printf('row %06d', n) AS label FROM g",
].join(" ");
/** The fixture's orders plus totals that sort wrongly as text, and a NULL. */
const POSTGRES_TOTALS = [
  "SELECT id, total FROM orders",
  "UNION ALL SELECT 4, 99.50",
  "UNION ALL SELECT 5, 100.00",
  "UNION ALL SELECT 6, NULL",
  "ORDER BY id",
].join(" ");
const BIG_BYTES = 2048;
const POSTGRES_VALUES = `SELECT id, doc, payload, decode(repeat('ab', ${String(BIG_BYTES)}), 'hex') AS big FROM type_probe WHERE id = 1`;
/** A row is `--spacing-row`, 24 px; a window is 500 rows. */
const WINDOW_HEIGHT_PX = 500 * 24;
const MAX_LOADED_WINDOWS = 20;
const SCROLL_STOPS = 30;

function toolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Result" });
}

function toolbarButton(page: Page, name: string) {
  return toolbar(page).getByRole("button", { name, exact: true });
}

function resultState(page: Page) {
  return page.getByTestId("result-state");
}

function grid(page: Page) {
  return page.getByRole("grid");
}

function header(page: Page, name: string) {
  return page.locator(`[role="columnheader"][data-column-name="${name}"]`);
}

function cell(page: Page, row: number, column: number) {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

/**
 * The few DOM members these checks read inside the page. The root program has no DOM lib, so the
 * page functions name their element's shape themselves.
 */
interface Box {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  querySelectorAll(selector: string): Iterable<Box>;
  readonly ownerDocument: {
    readonly defaultView: { getComputedStyle(element: Box): { readonly fontStyle: string; readonly color: string } };
  };
}

/** Whether a header draws its name cut short; the header must fit its name, glyph and sort mark. */
async function headerClipped(page: Page, name: string): Promise<boolean> {
  return header(page, name).evaluate(
    (element: Box) =>
      element.scrollWidth > element.clientWidth ||
      [...element.querySelectorAll("span")].some((span) => span.scrollWidth > span.clientWidth),
  );
}

async function columnNames(page: Page): Promise<string[]> {
  const headers = await page.locator('[role="columnheader"]').all();
  return Promise.all(headers.map(async (element) => (await element.getAttribute("data-column-name")) ?? ""));
}

/** The loaded cells of one visible column, top to bottom. */
async function columnValues(page: Page, column: number): Promise<string[]> {
  return columnSnapshot(page.locator(`[role="gridcell"][data-col="${String(column)}"]`));
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

async function runAll(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  // Closes the completion popup typing opened, which would cover the grid in the evidence.
  await sqlEditor(page).press("Escape");
  await runAllButton(page).click();
  await waitUntilReady(page);
}

/** Runs one row-returning statement and waits for its grid. */
async function query(page: Page, sql: string): Promise<void> {
  await runAll(page, sql);
  await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

/** Shows the copied text in the editor, so the evidence has it. */
async function pasteIntoEditor(page: Page): Promise<void> {
  // Focus, not click: the completion popup from typing the query may cover the editor.
  await sqlEditor(page).focus();
  await pressChord(page, "A");
  await pressChord(page, "V");
}

async function dragBy(page: Page, target: ReturnType<Page["locator"]>, dx: number): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) throw new Error("The drag target is not on screen.");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

async function widthOf(target: ReturnType<Page["locator"]>): Promise<number> {
  const box = await target.boundingBox();
  return box?.width ?? 0;
}

async function loadedWindows(page: Page): Promise<number> {
  return Number(await page.locator("[data-loaded-windows]").getAttribute("data-loaded-windows"));
}

describe.runIf(DATABASES_ENABLED)("result grid live test", () => {
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
  });

  async function launch(datasource: Datasource): Promise<RunningApp> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenFiftyThousandRows_whenFetchNextThenAll_thenFirstPageThenNextThenEverything",
    async () => {
      const { page } = await launch(POSTGRES);
      await query(page, POSTGRES_PAGING);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");

      await toolbarButton(page, "Fetch Next Page").click();
      await expect.poll(() => resultState(page).textContent()).toBe("1,000+ rows");

      await toolbarButton(page, "Fetch All").click();
      await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("50,000 rows");
      expect(await toolbarButton(page, "Fetch All").isDisabled()).toBe(true);
      await grid(page).evaluate((element: Box) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => cell(page, PAGING_ROWS - 1, 0).textContent()).toBe(String(PAGING_ROWS));
      const lastNumber = cell(page, PAGING_ROWS - 1, 0);
      expect(await lastNumber.evaluate((element: Box) => element.scrollWidth > element.clientWidth)).toBe(false);
      await captureWindow(page, "paged-fetch");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOpenCursor_whenSameConsoleRunsAnotherStatement_thenFirstResultSaysFetchingStopped",
    async () => {
      const { page } = await launch(POSTGRES);
      await query(page, POSTGRES_PAGING);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");
      await page.getByRole("button", { name: "Pin Result 1" }).click();

      await query(page, "SELECT 1 AS one");
      await resultTab(page, "Result 1").click();

      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows · fetching stopped");
      expect(await toolbarButton(page, "Fetch Next Page").isDisabled()).toBe(true);
      expect(await toolbarButton(page, "Rerun").isEnabled()).toBe(true);
      await captureWindow(page, "cursor-closed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDecimalTotals_whenSortedDescending_thenNumericOrderNullFirst",
    async () => {
      const { page } = await launch(POSTGRES);
      await query(page, POSTGRES_TOTALS);

      await header(page, "total").click();
      await header(page, "total").click();

      await expect.poll(() => header(page, "total").getAttribute("aria-sort")).toBe("descending");
      await expect.poll(() => columnValues(page, 1)).toEqual(["<null>", "120.50", "100.00", "99.50", "19.99", "5.00"]);
      expect(await resultState(page).textContent()).toBe("6 rows");
      expect(await headerClipped(page, "id")).toBe(false);
      expect(await headerClipped(page, "total")).toBe(false);
      await captureWindow(page, "sort-decimal");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOrders_whenAltClickAddsSecondKey_thenTiesOrderedBySecondKey",
    async () => {
      const { page } = await launch(MYSQL);
      await query(page, "SELECT customer_id, id, total FROM orders");

      await header(page, "customer_id").click();
      await header(page, "id").click({ modifiers: ["Alt"] });
      await header(page, "id").click({ modifiers: ["Alt"] });

      await expect.poll(() => columnValues(page, 1)).toEqual(["2", "1", "3"]);
      expect(await columnValues(page, 0)).toEqual(["1", "1", "2"]);
      expect(await header(page, "customer_id").locator("[data-sort-position]").textContent()).toBe("1");
      expect(await header(page, "id").locator("[data-sort-position]").textContent()).toBe("2");
      expect(await header(page, "id").getAttribute("aria-sort")).toBe("descending");
      expect(await headerClipped(page, "customer_id")).toBe(false);
      expect(await headerClipped(page, "id")).toBe(false);
      await captureWindow(page, "sort-two-keys");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCustomers_whenColumnResizedHiddenAndShownAgain_thenWiderThenGoneThenBack",
    async () => {
      const { page } = await launch(sqlite());
      await query(page, "SELECT * FROM customers");
      const before = await widthOf(header(page, "name"));

      await dragBy(page, header(page, "name").locator("[data-resize-handle]"), 160);
      await header(page, "email").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Hide Column" }).click();

      await expect.poll(() => columnNames(page)).toEqual(["id", "name"]);
      expect(await widthOf(header(page, "name"))).toBeGreaterThan(before + 100);
      await captureWindow(page, "columns-resize-hide");

      await header(page, "id").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Show All Columns" }).click();
      await expect.poll(() => columnNames(page)).toEqual(["id", "name", "email"]);
      expect(await widthOf(header(page, "name"))).toBeGreaterThan(before + 100);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDraggedRectangle_whenModC_thenCsvWithHeaderOnClipboard",
    async () => {
      const { app, page } = await launch(POSTGRES);
      await query(page, "SELECT * FROM customers ORDER BY id");

      const from = await cell(page, 0, 0).boundingBox();
      const to = await cell(page, 1, 2).boundingBox();
      if (from === null || to === null) throw new Error("The cells are not on screen.");
      await page.mouse.move(from.x + 4, from.y + 4);
      await page.mouse.down();
      await page.mouse.move(to.x + 4, to.y + 4, { steps: 6 });
      await page.mouse.up();
      expect(await page.locator('[role="gridcell"][aria-selected="true"]').count()).toBe(6);
      await pressChord(page, "C");

      await expect
        .poll(() => clipboardText(app))
        .toBe("id,name,email\n1,Ada Lovelace,ada@example.com\n2,Grace Hopper,grace@example.com\n");
      await pasteIntoEditor(page);
      await captureWindow(page, "copy-csv");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTypeProbeRows_whenCopiedAsSqlInserts_thenBackticksAndHexBytes",
    async () => {
      const { app, page } = await launch(MYSQL);
      await query(page, "SELECT * FROM type_probe ORDER BY id");
      await chooseOption(toolbar(page).getByLabel("Extractor"), { label: "SQL Inserts" });

      await cell(page, 0, 0).click();
      await pressChord(page, "A");
      await pressChord(page, "C");

      await expect.poll(() => clipboardText(app)).toMatch(/^INSERT INTO MY_TABLE \(`id`, `small_int`/);
      const text = await clipboardText(app);
      expect(text).toContain("X'deadbeef'");
      expect(text).toContain("'héllo, 世界 🌍'");
      expect(text.trimEnd().split("\n")).toHaveLength(2);
      await pasteIntoEditor(page);
      await captureWindow(page, "copy-sql-insert");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTypeProbe_whenCopiedAsJsonThenMarkdown_thenEachFormat",
    async () => {
      const { app, page } = await launch(sqlite());
      await query(page, "SELECT id, big_int, exact_decimal, doc, payload FROM type_probe ORDER BY id");
      const extractor = toolbar(page).getByLabel("Extractor");

      await chooseOption(extractor, { label: "JSON" });
      await cell(page, 0, 0).click();
      await pressChord(page, "A");
      await pressChord(page, "C");
      await expect.poll(() => clipboardText(app)).toMatch(/^\[\n/);
      const json = JSON.parse(await clipboardText(app)) as Record<string, unknown>[];
      expect(json[0]).toEqual({
        id: 1,
        big_int: "9007199254740993",
        exact_decimal: "1234567890123456.7890",
        doc: { a: 1, b: [true, null] },
        payload: "0xdeadbeef",
      });

      await chooseOption(extractor, { label: "Markdown" });
      await cell(page, 0, 0).click();
      await pressChord(page, "A");
      await pressChord(page, "C");
      await expect.poll(() => clipboardText(app)).toMatch(/^\| id \| big_int \|/);
      const markdown = await clipboardText(app);
      expect(markdown.split("\n")[1]).toBe("| --- | --- | --- | --- | --- |");

      await sqlEditor(page).fill(`${JSON.stringify(json[0])}\n\n${markdown}`);
      await captureWindow(page, "copy-json-markdown");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenExtractorDropdown_whenOpenedAndTypedJ_thenInAppListboxAndJsonChosen",
    async () => {
      const { page } = await launch(sqlite());
      await query(page, "SELECT * FROM customers");
      const extractor = toolbar(page).getByLabel("Extractor");
      expect(await cornerRadius(extractor)).toBe("0px");

      await extractor.click();
      const list = page.getByRole("listbox");
      await list.waitFor();
      expect(await list.getByRole("option").allTextContents()).toContain("JSON");
      await dropdownEvidence(page, "03-extractor");
      await page.keyboard.press("j");
      await list.locator('[role="option"][data-value="json"][data-highlighted]').waitFor();
      await page.keyboard.press("Enter");

      await list.waitFor({ state: "detached" });
      expect(await optionValue(extractor)).toBe("json");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenValuePanel_whenHandleDraggedAndRelaunched_thenPanelWidensAndKeepsItsWidth",
    async () => {
      const userDataDir = newProfile();
      scratch.push(userDataDir);
      running = await launchApp(sqlite(), { userDataDir });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      let { page } = running;
      await waitUntilReady(page);
      await query(page, "SELECT * FROM customers");
      await cell(page, 0, 1).click();
      await page.keyboard.press("Shift+Enter");
      const panel = (current: Page) => current.getByRole("complementary", { name: "Value" });
      await panel(page).waitFor();
      const before = await widthOf(panel(page));

      await dragBy(page, page.getByRole("separator", { name: "Value panel" }), -VALUE_PANEL_DRAG_PX);

      await expect.poll(() => widthOf(panel(page))).toBeGreaterThan(before + VALUE_PANEL_DRAG_PX / 2);
      const widened = await widthOf(panel(page));
      await dropdownEvidence(page, "02-value-panel");

      await setWindowSize(running.app, NARROW_WINDOW);
      await expect.poll(async () => Math.abs((await widthOf(panel(page))) - widened)).toBeLessThanOrEqual(1);

      await closeRunning();
      running = await launchApp(sqlite(), { userDataDir });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      page = running.page;
      await waitUntilReady(page);
      await query(page, "SELECT * FROM customers");
      await panel(page).waitFor();
      expect(Math.abs((await widthOf(panel(page))) - widened)).toBeLessThanOrEqual(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenFirstPageShown_whenExported_thenFileHasEveryRow",
    async () => {
      const { page } = await launch(POSTGRES);
      const folder = mkdtempSync(join(tmpdir(), "table-craft-export-"));
      scratch.push(folder);
      const path = join(folder, "paging.csv");
      await query(page, POSTGRES_PAGING);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");

      await toolbarButton(page, "Export Data…").click();
      await answerExportDialog(page, path);

      await resultTab(page, "Output").click();
      await expect
        .poll(() => output(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain(`50,000 rows exported to ${path}`);
      const lines = readFileSync(path, "utf8").split("\n");
      expect(lines.at(-1)).toBe("");
      expect(lines).toHaveLength(PAGING_ROWS + 2);
      expect(lines[0]).toBe("n,hash");
      await captureWindow(page, "export-csv");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTsvExtractor_whenExported_thenFileIsTabSeparated",
    async () => {
      const { page } = await launch(sqlite());
      const folder = mkdtempSync(join(tmpdir(), "table-craft-export-"));
      scratch.push(folder);
      const path = join(folder, "customers.tsv");
      await query(page, "SELECT * FROM customers ORDER BY id");

      await chooseOption(toolbar(page).getByLabel("Extractor"), { label: "TSV" });
      await toolbarButton(page, "Export Data…").click();
      await answerExportDialog(page, path);

      await resultTab(page, "Output").click();
      await expect
        .poll(() => output(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain(`2 rows exported to ${path}`);
      expect(readFileSync(path, "utf8")).toBe(
        "id\tname\temail\n1\tAda Lovelace\tada@example.com\n2\tGrace Hopper\tgrace@example.com\n",
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenJsonAndBytes_whenValuePanelShown_thenPrettyJsonAndHexWithCount",
    async () => {
      const { page } = await launch(POSTGRES);
      await query(page, POSTGRES_VALUES);

      await cell(page, 0, 1).click();
      await page.keyboard.press("Shift+Enter");
      const panel = page.getByRole("complementary", { name: "Value" });
      await expect.poll(() => panel.getByTestId("value-editor").textContent()).toContain('"a": 1');
      await captureWindow(page, "value-panel");

      await cell(page, 0, 3).click();
      await expect.poll(() => panel.getByTestId("value-bytes").textContent()).toContain("ab ab ab");
      expect(await panel.textContent()).toContain(`32 of ${BIG_BYTES.toLocaleString("en-US")} bytes shown`);
      await captureWindow(page, "value-panel-bytes");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNullAndNullLookingText_whenShown_thenOnlyTheNullIsMuted",
    async () => {
      const { page } = await launch(sqlite());
      await query(page, "SELECT NULL AS missing, '<null>' AS looks_null, '' AS empty");

      expect(await cell(page, 0, 0).textContent()).toBe("<null>");
      expect(await cell(page, 0, 1).textContent()).toBe("<null>");
      expect(await cell(page, 0, 0).getAttribute("data-null")).toBe("true");
      expect(await cell(page, 0, 1).getAttribute("data-null")).toBeNull();
      const style = (index: number) =>
        cell(page, 0, index).evaluate((element: Box) => {
          const computed = element.ownerDocument.defaultView.getComputedStyle(element);
          return `${computed.fontStyle} ${computed.color}`;
        });
      expect(await style(0)).not.toBe(await style(1));
      await captureWindow(page, "null-display");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOpenCursor_whenDisconnected_thenStaleBannerAndRerunReconnects",
    async () => {
      const { page } = await launch(POSTGRES);
      await query(page, POSTGRES_PAGING);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");

      await treeNode(page, "pg").click();
      await pressChord(page, "F2");

      const banner = page.getByRole("status").filter({ hasText: "Results from a closed connection" });
      await expect.poll(() => banner.isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      expect(await cell(page, 0, 0).textContent()).toBe("1");
      expect(await toolbarButton(page, "Fetch Next Page").isDisabled()).toBe(true);
      await captureWindow(page, "stale-result");

      await toolbarButton(page, "Rerun").click();
      await expect.poll(() => banner.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows");
      expect(await toolbarButton(page, "Fetch Next Page").isEnabled()).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenCappedFetchAll_whenScrolledDownAndBack_thenAtMostTwentyWindowsLoaded",
    async () => {
      const { page } = await launch(sqlite());
      await query(page, SQLITE_PAST_CAP);

      await toolbarButton(page, "Fetch All").click();
      await expect
        .poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("100,000+ rows · fetch cap reached");

      const height = await grid(page).evaluate((element: Box) => element.scrollHeight);
      const stops = Array.from({ length: SCROLL_STOPS }, (_, index) => (index * height) / (SCROLL_STOPS - 1));
      let most = 0;
      for (const top of [...stops, ...stops.reverse()]) {
        await grid(page).evaluate((element: Box, to: number) => {
          element.scrollTop = to;
        }, top);
        const row = Math.min(Math.floor(top / (WINDOW_HEIGHT_PX / 500)), 99_999);
        await expect.poll(() => cell(page, row, 0).textContent()).not.toBe("…");
        most = Math.max(most, await loadedWindows(page));
      }

      expect(most).toBeLessThanOrEqual(MAX_LOADED_WINDOWS);
      expect(await cell(page, 0, 0).textContent()).toBe("1");
      await captureWindow(page, "scroll-eviction");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenResizedHiddenSortedColumns_whenRerun_thenLayoutKept",
    async () => {
      const { page } = await launch(MYSQL);
      await query(page, "SELECT id, customer_id, total, placed_at FROM orders");
      await dragBy(page, header(page, "total").locator("[data-resize-handle]"), 120);
      const width = await widthOf(header(page, "total"));
      await header(page, "placed_at").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Hide Column" }).click();
      await header(page, "total").click();
      await header(page, "total").click();
      await expect.poll(() => columnValues(page, 2)).toEqual(["120.50", "19.99", "5.00"]);

      await cell(page, 0, 0).click();
      await pressChord(page, "R");
      await waitUntilReady(page);
      await resultTab(page, "Output").click();
      await expect
        .poll(() => output(page).locator("[data-tone]").filter({ hasText: "3 rows retrieved" }).count())
        .toBe(2);
      await resultTab(page, "Result 1").click();

      await expect.poll(() => columnNames(page)).toEqual(["id", "customer_id", "total"]);
      expect(await header(page, "total").getAttribute("aria-sort")).toBe("descending");
      await expect.poll(() => columnValues(page, 2)).toEqual(["120.50", "19.99", "5.00"]);
      expect(Math.abs((await widthOf(header(page, "total"))) - width)).toBeLessThan(2);
      await captureWindow(page, "rerun-keeps-layout");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
