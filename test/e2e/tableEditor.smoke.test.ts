/**
 * Plan 008's live test: the table data editor against PostgreSQL, MySQL and SQLite, from the
 * `test/db/compose.yml` databases and a seeded SQLite file. Gated, because it needs a display, a
 * fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/008 bun run test:smoke:db
 *
 * The containers are shared with `test:db` and the other suites, so every scenario that writes
 * puts `orders` and `edit_probe` back as the fixture seeds them.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatasourcePlugin } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  DATABASES_ENABLED,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  startStatement,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("008");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const TABLES_GROUP = "tables 6";
const VIEWS_GROUP = "views 1";

/** `orders` and `edit_probe` as the fixture seeds them; ids are explicit so sequences do not matter. */
const RESET_STATEMENTS = [
  "DELETE FROM orders WHERE id > 0",
  "INSERT INTO orders (id, customer_id, total, placed_at) VALUES (1, 1, 19.99, '2024-02-29 09:00:00'), (2, 1, 5.00, '2024-03-01 10:30:00'), (3, 2, 120.50, '2024-03-02 16:45:00')",
  "DELETE FROM edit_probe WHERE id > 2",
  `UPDATE edit_probe SET label = 'first', qty = 1, note = NULL, doc = '{"tags": ["a"]}' WHERE id = 1`,
  "UPDATE edit_probe SET label = 'second', qty = 2, note = 'kept', doc = NULL WHERE id = 2",
] as const;

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

async function resetFixtures(): Promise<void> {
  if (!WITHOUT_POSTGRES) await asOwner(postgres, POSTGRES_CONFIG, RESET_STATEMENTS);
  await asOwner(mysql, MYSQL_CONFIG, RESET_STATEMENTS);
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string) {
  return explorer(page).getByRole("treeitem", { name, exact: true });
}

function editor(page: Page) {
  return page.getByTestId("table-editor");
}

function cell(page: Page, row: number, column: number) {
  return editor(page).locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

/** The loaded cells of one visible column, top to bottom. */
async function columnValues(page: Page, column: number): Promise<string[]> {
  return columnSnapshot(editor(page).locator(`[role="gridcell"][data-col="${String(column)}"]`));
}

function editorButton(page: Page, name: string) {
  return editor(page).getByRole("button", { name, exact: true });
}

function pending(page: Page) {
  return editor(page).getByTestId("pending-changes");
}

function notice(page: Page) {
  return editor(page).getByTestId("table-notice");
}

function filterBar(page: Page, bar: "where" | "order-by") {
  return editor(page).getByTestId(`filter-${bar}`).locator(".cm-content");
}

function dialog(page: Page) {
  return page.getByRole("dialog");
}

/** Opens a relation's data from the Database pane: select its row, press F4. */
async function openFromTree(page: Page, name: string, group = TABLES_GROUP): Promise<void> {
  const groupRow = treeRow(page, group);
  await groupRow.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await groupRow.getAttribute("aria-expanded")) !== "true") {
    await groupRow.click();
    await page.keyboard.press("ArrowRight");
  }
  await treeRow(page, name).click();
  await page.keyboard.press("F4");
  await expect.poll(() => activeEditorTab(page).textContent()).toContain(name);
  await cell(page, 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Writes `text` into a cell through the inline editor: select, Enter, type, Enter. */
async function editCell(page: Page, row: number, column: number, text: string): Promise<void> {
  await cell(page, row, column).click();
  await page.keyboard.press("Enter");
  const field = editor(page).locator("[data-editing] input");
  await field.waitFor();
  await field.fill(text);
  await field.press("Enter");
  await expect.poll(() => field.count()).toBe(0);
}

async function applyFilter(page: Page, where: string, orderBy = ""): Promise<void> {
  await filterBar(page, "where").fill(where);
  await filterBar(page, "order-by").fill(orderBy);
  await filterBar(page, "order-by").press("Enter");
}

/**
 * Sorts by key on the server: PostgreSQL returns an updated row last without ORDER BY, so the
 * scenarios that edit and re-read pin the order first.
 */
async function orderById(page: Page): Promise<void> {
  await filterBar(page, "order-by").fill("id");
  await filterBar(page, "order-by").press("Enter");
  await expect.poll(() => editor(page).getByTestId("filter-order-by").getAttribute("data-invalid")).toBe("false");
}

describe.runIf(DATABASES_ENABLED)("table data editor live test", () => {
  let running: RunningApp | null = null;

  beforeAll(resetFixtures);
  afterAll(resetFixtures);

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(async () => {
    await closeRunning();
    await resetFixtures();
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null, userDataDir?: string): Promise<Page> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrdersInTheTree_whenF4_thenTableTabOpensWithRowsInAutoCommit",
    async () => {
      const page = await launch(POSTGRES);

      await openFromTree(page, "orders");

      expect(await activeEditorTab(page).textContent()).toBe("orders [pg]");
      expect(await columnValues(page, 0)).toEqual(["1", "2", "3"]);
      expect(await editor(page).getByTestId("tx-mode").textContent()).toBe("Tx: Auto");
      expect(await editor(page).getByTestId("read-only-banner").count()).toBe(0);
      await captureWindow(page, "open-table");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrders_whenWhereAndOrderByApplied_thenServerFiltersAndSorts",
    async () => {
      const page = await launch(POSTGRES);
      await openFromTree(page, "orders");

      await applyFilter(page, "total > 10", "placed_at desc");

      await expect.poll(() => columnValues(page, 0)).toEqual(["3", "1"]);
      await captureWindow(page, "where-order");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlOrders_whenWhereRefused_thenErrorUnderTheBarAndRowsKept",
    async () => {
      const page = await launch(MYSQL);
      await openFromTree(page, "orders");

      await applyFilter(page, "no_such_column > 1");

      const error = editor(page).getByTestId("query-error");
      await expect.poll(() => error.textContent()).toContain("no_such_column");
      expect(await columnValues(page, 0)).toEqual(["1", "2", "3"]);
      expect(await editor(page).getByTestId("filter-where").getAttribute("data-invalid")).toBe("true");
      // The empty ORDER BY took no part, so only WHERE is marked.
      expect(await editor(page).getByTestId("filter-order-by").getAttribute("data-invalid")).toBe("false");
      await captureWindow(page, "where-error");
    },
    SCENARIO_TIMEOUT_MS,
  );

  /** Updates order 1's total, deletes order 2 and inserts order 4: three pending changes. */
  async function bufferThreeChanges(page: Page): Promise<void> {
    await orderById(page);
    await editCell(page, 0, 2, "25.00");
    await cell(page, 1, 0).click();
    await pressChord(page, "Backspace");
    await editorButton(page, "Add Row").click();
    await editCell(page, 3, 0, "4");
    await editCell(page, 3, 1, "2");
    await editCell(page, 3, 2, "7.50");
    await editCell(page, 3, 3, "2024-03-03 08:00:00");
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrders_whenCellEditedRowInsertedAndRowDeleted_thenThreeHighlightsAndThreePending",
    async () => {
      const page = await launch(POSTGRES);
      await openFromTree(page, "orders");

      await bufferThreeChanges(page);

      await expect.poll(() => pending(page).textContent()).toBe("3 pending changes");
      expect(await cell(page, 0, 2).getAttribute("data-edit")).toBe("modified");
      expect(await cell(page, 1, 0).getAttribute("data-edit")).toBe("deleted");
      expect(await cell(page, 3, 0).getAttribute("data-edit")).toBe("inserted");
      expect(await cell(page, 0, 2).textContent()).toBe("25.00");
      await captureWindow(page, "pending-changes");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenThreePendingChanges_whenPreviewedAndSubmitted_thenDeleteUpdateInsertRunAndRowsReread",
    async () => {
      const page = await launch(POSTGRES);
      await openFromTree(page, "orders");
      await bufferThreeChanges(page);

      await pressChord(page, "Shift+P");

      const statements = dialog(page).getByRole("list", { name: "Statements" }).getByRole("listitem");
      await expect.poll(() => statements.count()).toBe(3);
      const texts = await statements.allTextContents();
      expect(texts[0]).toContain(`DELETE FROM "public"."orders" WHERE "id" = 2`);
      expect(texts[1]).toContain(`UPDATE "public"."orders" SET "total" = '25.00' WHERE "id" = 1`);
      expect(texts[2]).toContain(`INSERT INTO "public"."orders"`);
      expect(texts[2]).toContain("'2024-03-03 08:00:00'");
      await captureWindow(page, "preview-submit");

      await dialog(page).getByRole("button", { name: "Submit" }).click();

      await expect.poll(() => notice(page).textContent()).toBe("Submitted 3 statements");
      await expect.poll(() => columnValues(page, 0)).toEqual(["1", "3", "4"]);
      expect(await columnValues(page, 2)).toEqual(["25.00", "120.50", "7.50"]);
      expect(await pending(page).count()).toBe(0);
      expect(await editor(page).locator("[data-edit]").count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlEditProbe_whenSetNullSetDefaultAndEmptyInsertSubmitted_thenDefaultsApplied",
    async () => {
      const page = await launch(MYSQL);
      await openFromTree(page, "edit_probe");

      await cell(page, 0, 2).click();
      await pressChord(page, "Alt+N");
      await cell(page, 1, 1).click();
      await pressChord(page, "Alt+D");
      await editorButton(page, "Add Row").click();
      await expect.poll(() => cell(page, 0, 2).textContent()).toBe("<null>");
      await expect.poll(() => cell(page, 1, 1).textContent()).toBe("<default>");
      await expect.poll(() => pending(page).textContent()).toBe("3 pending changes");
      await editorButton(page, "Submit").click();

      await expect.poll(() => notice(page).textContent()).toBe("Submitted 3 statements");
      await expect.poll(() => columnValues(page, 1)).toEqual(["first", "new", "new"]);
      expect(await columnValues(page, 2)).toEqual(["<null>", "2", "1"]);
      await captureWindow(page, "null-default");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPendingUpdate_whenRowDeletedFromConsoleThenSubmitted_thenRolledBackNamingTheStatement",
    async () => {
      const page = await launch(POSTGRES);
      await openFromTree(page, "orders");
      await orderById(page);
      await editCell(page, 1, 2, "6.00");
      await editCell(page, 2, 2, "121.00");

      await editorTabs(page).filter({ hasText: "console [pg]" }).click();
      await startStatement(page, "DELETE FROM orders WHERE id = 3");
      await expect.poll(() => page.getByRole("log", { name: "Output" }).textContent()).toContain("1 row affected");
      await editorTabs(page).filter({ hasText: "orders [pg]" }).click();
      await editorButton(page, "Submit").click();

      const error = editor(page).getByTestId("table-error");
      await expect.poll(() => error.textContent()).toContain("Statement 2 affected 0 rows");
      expect(await pending(page).textContent()).toBe("2 pending changes");
      await captureWindow(page, "rejected-rollback");
      // The first update ran inside the rolled-back transaction, so order 2 keeps its total.
      await editor(page).getByRole("toolbar", { name: "Result" }).getByRole("button", { name: "Rerun" }).click();
      await dialog(page).getByRole("button", { name: "Discard" }).click();
      await expect.poll(() => columnValues(page, 2)).toEqual(["19.99", "5.00"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteEditProbePending_whenRevertSelectedThenRevertAll_thenValuesBackAndNothingPending",
    async () => {
      const page = await launch(sqlite());
      await openFromTree(page, "edit_probe");
      await editCell(page, 0, 1, "changed");
      await editCell(page, 1, 1, "also changed");
      await editorButton(page, "Add Row").click();
      await expect.poll(() => pending(page).textContent()).toBe("3 pending changes");

      await cell(page, 0, 1).click();
      await pressChord(page, "Alt+Z");

      await expect.poll(() => cell(page, 0, 1).textContent()).toBe("first");
      expect(await cell(page, 0, 1).getAttribute("data-edit")).toBeNull();
      expect(await pending(page).textContent()).toBe("2 pending changes");

      await findAction(page, "Revert All");

      await expect.poll(() => pending(page).count()).toBe(0);
      expect(await columnValues(page, 1)).toEqual(["first", "second"]);
      expect(await editor(page).locator("[data-edit]").count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteEditProbe_whenRowDuplicatedAndSubmitted_thenCopyGetsTheNextId",
    async () => {
      const page = await launch(sqlite());
      await openFromTree(page, "edit_probe");

      await cell(page, 0, 1).click();
      await pressChord(page, "D");
      await expect.poll(() => cell(page, 2, 0).textContent()).toBe("<default>");
      expect(await cell(page, 2, 1).textContent()).toBe("first");
      await editorButton(page, "Submit").click();

      await expect.poll(() => columnValues(page, 0)).toEqual(["1", "2", "3"]);
      expect(await columnValues(page, 1)).toEqual(["first", "second", "first"]);
      await captureWindow(page, "duplicate-row");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenNoKeyTableAndView_whenOpened_thenReadOnlyWithTheReason",
    async () => {
      const page = await launch(POSTGRES);

      await openFromTree(page, "customer_totals", VIEWS_GROUP);
      await expect
        .poll(() => editor(page).getByTestId("read-only-banner").textContent())
        .toContain("Views are read-only.");
      await openFromTree(page, "no_key_probe");

      const banner = editor(page).getByTestId("read-only-banner");
      await expect
        .poll(() => banner.textContent())
        .toContain("No primary key or non-null unique key identifies a row.");
      await cell(page, 0, 0).click();
      await page.keyboard.press("Enter");
      expect(await editor(page).locator("[data-editing]").count()).toBe(0);
      expect(await editorButton(page, "Add Row").isDisabled()).toBe(true);
      await captureWindow(page, "read-only-table");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenReadOnlySqliteDatasource_whenTableOpened_thenEditorIsReadOnly",
    async () => {
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [
        { id: "local", name: "local", pluginId: "sqlite", readOnly: true, config: { path: seededSqliteFile() } },
      ]);
      const page = await launch(null, userDataDir);
      await openConsoleOn(page, "local");
      await waitUntilReady(page);

      await openFromTree(page, "edit_probe");

      await expect
        .poll(() => editor(page).getByTestId("read-only-banner").textContent())
        .toContain("The datasource is read-only.");
      expect(await activeEditorTab(page).textContent()).toBe("edit_probe [local]");
      await cell(page, 0, 1).dblclick();
      expect(await editor(page).locator("[data-editing]").count()).toBe(0);
      await captureWindow(page, "read-only-datasource");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrderOfGrace_whenGoToReferencedRow_thenCustomersOpenFilteredToHer",
    async () => {
      const page = await launch(POSTGRES);
      await openFromTree(page, "orders");

      await cell(page, 2, 1).click();
      await pressChord(page, "B");

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("customers [pg]");
      await expect.poll(() => columnValues(page, 1)).toEqual(["Grace Hopper"]);
      await expect.poll(() => filterBar(page, "where").textContent()).toBe(`"id" = 2`);
      await captureWindow(page, "fk-go-to");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlCustomerAda_whenShowReferencingRows_thenHerOrdersOpen",
    async () => {
      const page = await launch(MYSQL);
      await openFromTree(page, "customers");

      await cell(page, 0, 1).click({ button: "right" });
      await page.getByRole("menuitem", { name: "Show Referencing Rows…" }).click();
      await dialog(page).getByRole("button", { name: "orders (customer_id)" }).click();

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("orders [mysql]");
      await expect.poll(() => columnValues(page, 0)).toEqual(["1", "2"]);
      await expect.poll(() => filterBar(page, "where").textContent()).toBe("`customer_id` = 1");
      await captureWindow(page, "fk-referencing");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPendingChange_whenTabClosed_thenAskedToSubmitDiscardOrCancel",
    async () => {
      const page = await launch(POSTGRES);
      await openFromTree(page, "orders");
      await editCell(page, 0, 2, "20.00");

      await pressChord(page, "W");

      await expect.poll(() => dialog(page).getByRole("heading").textContent()).toBe("Pending changes");
      const buttons = await dialog(page).getByRole("button").allTextContents();
      expect(buttons).toEqual(expect.arrayContaining(["Submit", "Discard", "Cancel"]));
      await captureWindow(page, "close-pending");

      await dialog(page).getByRole("button", { name: "Cancel" }).click();
      expect(await activeEditorTab(page).textContent()).toBe("orders [pg]");
      await pressChord(page, "W");
      await dialog(page).getByRole("button", { name: "Discard" }).click();
      await expect.poll(() => editorTabs(page).allTextContents()).toEqual(["console [pg]"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenJsonCell_whenEditedInValuePanelAndSubmitted_thenNewDocumentStored",
    async () => {
      const page = await launch(POSTGRES);
      await openFromTree(page, "edit_probe");
      await orderById(page);

      await cell(page, 0, 4).click();
      await page.keyboard.press("Shift+Enter");
      const value = page.getByTestId("value-editor").locator(".cm-content");
      await expect.poll(() => value.textContent()).toContain('"tags"');
      await value.fill('{"tags": ["a", "b"], "kept": true}');
      await pressChord(page, "Enter");

      await expect.poll(() => pending(page).textContent()).toBe("1 pending change");
      expect(await cell(page, 0, 4).getAttribute("data-edit")).toBe("modified");
      await captureWindow(page, "value-panel-edit");
      await editorButton(page, "Submit").click();

      await expect.poll(() => notice(page).textContent()).toBe("Submitted 1 statement");
      await expect.poll(() => cell(page, 0, 4).textContent()).toBe('{"kept": true, "tags": ["a", "b"]}');
    },
    SCENARIO_TIMEOUT_MS,
  );
});
