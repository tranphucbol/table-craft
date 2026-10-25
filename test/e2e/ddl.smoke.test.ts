/**
 * Plan 010's live test: DDL tabs, Quick Documentation and the SQL Generator against PostgreSQL,
 * MySQL and SQLite, from the `test/db/compose.yml` databases and seeded SQLite files. Gated, because
 * it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/010 bun run test:smoke:db
 *
 * The one scenario that alters a shared table puts it back; the inserting one runs on a SQLite copy.
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  runAllButton,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  startStatement,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("010");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const TABLES_GROUP = "tables 6";
const VIEWS_GROUP = "views 1";
const ADDED_COLUMN = "ALTER TABLE orders ADD COLUMN note text";
const DROPPED_COLUMN = "ALTER TABLE orders DROP COLUMN IF EXISTS note";

/** Where the console's caret sits in its first line, read from the DOM selection CodeMirror keeps in sync. */
const CARET_OFFSET = `(() => {
  const selection = document.getSelection();
  const line = document.querySelector('[data-testid="sql-editor"] .cm-line');
  if (!selection || !line || selection.anchorNode === null) return -1;
  const range = document.createRange();
  range.setStart(line, 0);
  range.setEnd(selection.anchorNode, selection.anchorOffset);
  return range.toString().length;
})()`;

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string) {
  return explorer(page).getByRole("treeitem", { name, exact: true });
}

async function expand(page: Page, name: string): Promise<void> {
  const target = treeRow(page, name);
  await target.click();
  if ((await target.getAttribute("aria-expanded")) !== "true") await page.keyboard.press("ArrowRight");
  await expect.poll(() => target.getAttribute("aria-expanded")).toBe("true");
}

/** Expands `group` and selects `relation` under it, leaving focus in the Database pane. */
async function selectRelation(page: Page, relation: string, group = TABLES_GROUP): Promise<void> {
  await expand(page, group);
  await treeRow(page, relation).click();
  await expect.poll(() => treeRow(page, relation).getAttribute("aria-selected")).toBe("true");
}

function ddlTabs(page: Page) {
  return editorTabs(page).filter({ has: page.locator('[data-tab-kind="ddl"]') });
}

function consoleTabs(page: Page) {
  return editorTabs(page).filter({ has: page.locator('[data-tab-kind="console"]') });
}

async function linesOf(page: Page, testId: string): Promise<string> {
  return (await page.getByTestId(testId).locator(".cm-line").allTextContents()).join("\n");
}

function ddlText(page: Page): Promise<string> {
  return linesOf(page, "ddl-text");
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

/** Replaces the console's text with `sql` and puts the caret at `caret`. */
async function typeAt(page: Page, sql: string, caret: number): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  for (let step = sql.length; step > caret; step--) await page.keyboard.press("ArrowLeft");
  await expect.poll(() => page.evaluate<number>(CARET_OFFSET)).toBe(caret);
}

function output(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

function quickDoc(page: Page) {
  return page.getByTestId("quick-doc");
}

function generator(page: Page, relation: string) {
  return page.getByRole("dialog", { name: `SQL Generator: ${relation}` });
}

/** Opens the SQL Generator on `relation` with ⌘⌥G and waits for the SELECT preview. */
async function openGenerator(page: Page, relation: string): Promise<void> {
  await pressChord(page, "Alt+G");
  await generator(page, relation).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await expect.poll(() => linesOf(page, "generator-preview")).toMatch(/^SELECT /);
  await expect
    .poll(() => generator(page, relation).locator("[data-statement]:focus").getAttribute("data-statement"))
    .toBe("select");
}

async function chooseStatement(page: Page, relation: string, label: string): Promise<void> {
  await generator(page, relation).getByRole("radio", { name: label, exact: true }).click();
  await expect.poll(() => linesOf(page, "generator-preview")).toMatch(new RegExp(`^${label} `));
}

describe.runIf(DATABASES_ENABLED)("DDL and SQL generation live test", () => {
  let running: RunningApp | null = null;

  async function closeRunning(): Promise<void> {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }

  afterEach(closeRunning, CLOSE_HOOK_TIMEOUT_MS);

  /** Launches on `datasource` and waits for its current namespace to be described in the tree. */
  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await treeRow(running.page, TABLES_GROUP).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  /** Selects `relation` in the pane and opens its DDL tab with ⌘B. */
  async function openDdlFromPane(page: Page, relation: string, group = TABLES_GROUP): Promise<void> {
    await selectRelation(page, relation, group);
    await pressChord(page, "B");
    await expect.poll(() => ddlTabs(page).count()).toBe(1);
    await expect.poll(() => page.getByTestId("ddl-status").textContent()).not.toBe("Reading definition…");
    await expect.poll(() => ddlText(page)).not.toBe("");
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrdersInThePane_whenGoToDdl_thenTabShowsForeignKeyIndexAndCheck",
    async () => {
      const page = await launch(POSTGRES);

      await openDdlFromPane(page, "orders");

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("orders [pg]");
      const text = await ddlText(page);
      expect(text).toMatch(/^CREATE TABLE public\.orders \(/);
      expect(text).toContain("FOREIGN KEY (customer_id) REFERENCES customers(id)");
      expect(text).toContain("CONSTRAINT orders_total_nonnegative CHECK (total >= 0::numeric)");
      expect(text).toContain("CREATE INDEX orders_placed_at_idx ON public.orders USING btree (placed_at);");
      await captureWindow(page, "pane-go-to-ddl");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrdersDdlOpen_whenGoToDeclarationOnOrdersInAConsole_thenTheSameTabIsFocused",
    async () => {
      const page = await launch(POSTGRES);
      await openDdlFromPane(page, "orders");
      await consoleTabs(page).first().click();
      await expect.poll(() => activeEditorTab(page).locator('[data-tab-kind="console"]').count()).toBe(1);

      await typeAt(page, "SELECT * FROM orders WHERE total > 10", "SELECT * FROM ord".length);
      await pressChord(page, "B");

      await expect.poll(() => activeEditorTab(page).locator('[data-tab-kind="ddl"]').count()).toBe(1);
      expect(await activeEditorTab(page).textContent()).toBe("orders [pg]");
      expect(await ddlTabs(page).count()).toBe(1);
      expect(await ddlText(page)).toMatch(/^CREATE TABLE public\.orders \(/);
      await captureWindow(page, "console-go-to-ddl");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlOrders_whenGoToDdl_thenShowsShowCreateTableVerbatim",
    async () => {
      const page = await launch(MYSQL);

      await openDdlFromPane(page, "orders");

      const text = await ddlText(page);
      expect(text).toMatch(/^CREATE TABLE `orders` \(/);
      expect(text).toContain("CONSTRAINT `orders_total_nonnegative` CHECK ((`total` >= 0))");
      expect(text).toContain("KEY `orders_placed_at_idx` (`placed_at`)");
      expect(text).toMatch(/\) ENGINE=InnoDB .*;$/);
      await captureWindow(page, "mysql-show-create");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteView_whenGoToDdl_thenShowsItsQuery",
    async () => {
      const page = await launch(sqlite());

      await openDdlFromPane(page, "customer_totals", VIEWS_GROUP);

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("customer_totals [lite]");
      const text = await ddlText(page);
      expect(text).toMatch(/^CREATE VIEW customer_totals AS/);
      expect(text).toContain("LEFT JOIN orders o ON o.customer_id = c.id");
      await captureWindow(page, "sqlite-view");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrdersDdlOpen_whenAColumnIsAddedInAConsole_thenTheTabRefetches",
    async () => {
      const page = await launch(POSTGRES);
      try {
        await openDdlFromPane(page, "orders");
        expect(await ddlText(page)).not.toContain("note text");
        await consoleTabs(page).first().click();

        await sqlEditor(page).fill(ADDED_COLUMN);
        await runAllButton(page).click();
        await expect.poll(() => output(page).textContent()).toContain("ALTER TABLE orders");
        await ddlTabs(page).first().click();

        await expect.poll(() => ddlText(page)).toContain("note text");
        await captureWindow(page, "refetch-after-ddl");
      } finally {
        await consoleTabs(page).first().click();
        await waitUntilReady(page);
        await sqlEditor(page).fill(DROPPED_COLUMN);
        await runAllButton(page).click();
        await expect.poll(() => output(page).textContent()).toContain("DROP COLUMN");
        await waitUntilReady(page);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlOrdersDdl_whenOpenInConsole_thenAConsoleHoldsTheText",
    async () => {
      const page = await launch(MYSQL);
      await openDdlFromPane(page, "orders");
      const definition = await ddlText(page);

      await page.getByRole("button", { name: "Open DDL in Console", exact: true }).click();

      await expect.poll(() => consoleTabs(page).count()).toBe(2);
      await expect.poll(() => activeEditorTab(page).locator('[data-tab-kind="console"]').count()).toBe(1);
      await expect.poll(() => editorText(page)).toBe(definition);
      await captureWindow(page, "open-in-console");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenCustomersInThePane_whenQuickDocumentation_thenCommentColumnsAndIncomingKey",
    async () => {
      const page = await launch(POSTGRES);
      await selectRelation(page, "customers");

      await page.keyboard.press("F1");

      const doc = quickDoc(page);
      await doc.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await doc.getByTestId("quick-doc-name").textContent()).toBe("table_craft.public.customers");
      expect(await doc.getByTestId("quick-doc-comment").textContent()).toBe("People who place orders");
      const names = await doc.getByTestId("quick-doc-column").locator("td:first-child").allTextContents();
      expect(names).toEqual(["id", "name", "email"]);
      expect(await doc.getByTestId("quick-doc-foreign-key").allTextContents()).toEqual([
        expect.stringMatching(/orders_customer_id_fkey: .*orders/),
      ]);
      await captureWindow(page, "quick-doc-relation");
      await page.keyboard.press("Escape");
      await expect.poll(() => doc.count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlCaretOnOTotal_whenQuickDocumentation_thenTypeAndNullability",
    async () => {
      const page = await launch(MYSQL);
      const sql = "SELECT o.total FROM orders o";

      await typeAt(page, sql, "SELECT o.to".length);
      await page.keyboard.press("F1");

      const doc = quickDoc(page);
      await doc.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await doc.getByTestId("quick-doc-name").textContent()).toBe("table_craft.orders.total");
      await expect.poll(() => doc.getByTestId("quick-doc-type").textContent()).toMatch(/^decimal\(12,2\)\s*NOT NULL$/);
      await captureWindow(page, "quick-doc-column");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenLineItemsOnEachDatabase_whenSqlGenerator_thenSelectQuotesItPerDialect",
    async () => {
      const expected: readonly [Datasource, RegExp][] = [
        [POSTGRES, /^SELECT id, sku\nFROM "public"\."Line Items";$/],
        [MYSQL, /^SELECT id, sku\nFROM `table_craft`\.`Line Items`;$/],
        [sqlite(), /^SELECT id, sku\nFROM "main"\."Line Items";$/],
      ];
      for (const [datasource, select] of expected) {
        const page = await launch(datasource);
        await selectRelation(page, "Line Items");

        await openGenerator(page, "Line Items");

        await expect.poll(() => linesOf(page, "generator-preview")).toMatch(select);
        // MySQL's backticks are the case the other two cannot show.
        if (datasource.pluginId === "mysql") await captureWindow(page, "generator-select");
        await closeRunning();
      }
    },
    SCENARIO_TIMEOUT_MS * 3,
  );

  it(
    "givenSqliteOrders_whenGeneratingDropThenCreateAndRunningBoth_thenTheTableIsBackEmpty",
    async () => {
      const page = await launch(sqlite());
      await selectRelation(page, "orders");
      await openGenerator(page, "orders");

      await chooseStatement(page, "orders", "CREATE");
      const create = await linesOf(page, "generator-preview");
      expect(create).toMatch(/^CREATE TABLE orders \(/);
      expect(create).toContain("customer_id INTEGER NOT NULL REFERENCES customers (id)");
      expect(create).toContain("CREATE INDEX orders_placed_at_idx ON orders (placed_at);");
      await chooseStatement(page, "orders", "DROP");
      const drop = await linesOf(page, "generator-preview");
      expect(drop).toBe(`DROP TABLE "main"."orders";`);
      await generator(page, "orders").getByRole("button", { name: "Open in Console", exact: true }).click();
      await expect.poll(() => editorText(page)).toBe(drop);
      await waitUntilReady(page);
      await runAllButton(page).click();
      const confirm = page.getByRole("dialog", { name: "Run a destructive statement?" });
      await confirm.getByRole("button", { name: "Execute", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      await expect.poll(() => output(page).textContent()).toContain(`${drop.replace(/;$/, "")}completed in`);
      // customer_totals reads orders, so this also covers a view that no longer compiles.
      await expect.poll(() => treeRow(page, "orders").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      expect(await treeRow(page, "tables 5").count()).toBe(1);
      expect(await treeRow(page, "views 1").count()).toBe(1);

      await startStatement(page, create);
      await expect.poll(() => treeRow(page, "orders").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);
      await waitUntilReady(page);
      await runStatement(page, "SELECT count(*) AS n FROM orders");

      expect((await gridText(page)).cells).toEqual(["0"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteEditProbe_whenGeneratingInsertAndRunningIt_thenOneRowIsInserted",
    async () => {
      const page = await launch(sqlite());
      await selectRelation(page, "edit_probe");
      await openGenerator(page, "edit_probe");

      await chooseStatement(page, "edit_probe", "INSERT");

      const insert = await linesOf(page, "generator-preview");
      expect(insert).toMatch(
        /^INSERT INTO "main"\."edit_probe" \(label, qty, note, doc\)\nVALUES \('new', 1, NULL, NULL\);$/,
      );
      await generator(page, "edit_probe").getByRole("button", { name: "Open in Console", exact: true }).click();
      await expect.poll(() => editorText(page)).toBe(insert);
      await waitUntilReady(page);
      await runAllButton(page).click();
      await expect.poll(() => output(page).textContent()).toContain("1 row affected");
      await captureWindow(page, "generator-insert");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenOrders_whenGeneratingUpdateAndRunningIt_thenNoRowIsUpdated",
    async () => {
      const page = await launch(POSTGRES);
      await selectRelation(page, "orders");
      await openGenerator(page, "orders");

      await chooseStatement(page, "orders", "UPDATE");

      const update = await linesOf(page, "generator-preview");
      expect(update).toMatch(/\nWHERE id = NULL;$/);
      await generator(page, "orders").getByRole("button", { name: "Open in Console", exact: true }).click();
      await expect.poll(() => editorText(page)).toBe(update);
      await waitUntilReady(page);
      await runAllButton(page).click();
      await expect.poll(() => output(page).textContent()).toContain("0 rows affected");
      await captureWindow(page, "generator-update");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlRelation_whenContextMenu_thenListsDdlDocumentationAndGenerator",
    async () => {
      const page = await launch(MYSQL);
      await expand(page, TABLES_GROUP);

      await treeRow(page, "orders").click({ button: "right" });

      const menu = page.getByRole("menu");
      await menu.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const items = await menu.getByRole("menuitem").allTextContents();
      for (const title of ["Go to DDL", "Quick Documentation", "SQL Generator…"]) {
        expect(items.some((item) => item.startsWith(title))).toBe(true);
      }
      await captureWindow(page, "context-menu");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
