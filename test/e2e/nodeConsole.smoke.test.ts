/**
 * Plan 153's live test: New Console on a node of the Database pane opens a console already in the
 * database or schema holding that node, on MySQL, PostgreSQL, SQL Server and SQLite. Gated, because
 * it needs a display, a fresh build and the `test/db/compose.yml` servers:
 *
 *   TABLE_CRAFT_DATABASES=mysql,tidb,postgres,mssql TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/153 \
 *     bun test/e2e/docker/headless.ts --databases test/e2e/nodeConsole.smoke.test.ts
 *
 * Every scenario only reads the seeded `archive` namespace (test/db/schema/).
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MSSQL_CONFIG, MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_MSSQL, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("153");

const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const SQL_SERVER: Datasource = { id: "mssql", pluginId: "mssql", config: MSSQL_CONFIG };

const DATABASE = "table_craft";
const ARCHIVE = "archive";
const ARCHIVE_TABLE = "old_orders";
const ARCHIVE_TABLES = "tables 1";
/** SQL Server switches databases, and `USE` lands on the database with its default schema. */
const SQL_SERVER_DEFAULT = `${DATABASE}.dbo`;
const NEW_CONSOLE = /^New Console/;
const SQL_SCRIPTS = "SQL Scripts";
const TO_CONSOLE = "Generate DDL to Console";

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string) {
  return explorer(page).getByRole("treeitem", { name, exact: true });
}

function datasourceRow(page: Page) {
  return explorer(page).locator('[role="treeitem"][data-kind="datasource"]');
}

function consoleTabs(page: Page) {
  return editorTabs(page).filter({ has: page.locator('[data-tab-kind="console"]') });
}

function namespaceLabel(page: Page) {
  return page.getByTestId("console-namespace");
}

async function labelText(page: Page): Promise<string | null> {
  return (await namespaceLabel(page).count()) === 0 ? null : namespaceLabel(page).textContent();
}

function labelTitle(page: Page): Promise<string | null> {
  return namespaceLabel(page).getAttribute("title");
}

/** Expands `name` and waits for its children to show `child`. */
async function expand(page: Page, name: string, child: string): Promise<void> {
  const row = treeRow(page, name).first();
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await row.click();
  if ((await row.getAttribute("aria-expanded")) !== "true") await page.keyboard.press("ArrowRight");
  await treeRow(page, child).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Chooses New Console on `row`'s context menu and waits for the new console to settle. */
async function newConsoleOn(page: Page, row: ReturnType<typeof treeRow>): Promise<void> {
  const before = await consoleTabs(page).count();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: NEW_CONSOLE }).click();
  await expect.poll(() => consoleTabs(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(before + 1);
  await waitUntilReady(page);
}

/** Shows the archive table: the namespace node, its tables group, then the table. */
async function revealArchiveTable(page: Page, parent: string | null): Promise<void> {
  if (parent !== null) await expand(page, parent, ARCHIVE);
  await expand(page, ARCHIVE, ARCHIVE_TABLES);
  await expand(page, ARCHIVE_TABLES, ARCHIVE_TABLE);
}

describe.runIf(DATABASES_ENABLED)("new console in the node's namespace live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenMysqlTableInAnotherDatabase_whenNewConsoleFromItsMenu_thenConsoleRunsInThatDatabase",
    async () => {
      const page = await launch(MYSQL);
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(DATABASE);
      await revealArchiveTable(page, null);

      await newConsoleOn(page, treeRow(page, ARCHIVE_TABLE));

      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(ARCHIVE);
      await sqlEditor(page).click();
      await page.keyboard.type(`SELECT * FROM ${ARCHIVE_TABLE}`);
      await runAllButton(page).click();
      await waitUntilReady(page);
      expect(await consoleAlert(page).count()).toBe(0);
      await captureWindow(page, "01-mysql-table");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlDatabaseNodeOrDatasource_whenNewConsole_thenThatDatabaseOrTheDefault",
    async () => {
      const page = await launch(MYSQL);
      await treeRow(page, ARCHIVE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await newConsoleOn(page, treeRow(page, ARCHIVE));
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(ARCHIVE);
      await captureWindow(page, "02-mysql-database");

      await newConsoleOn(page, datasourceRow(page));
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(DATABASE);
      await captureWindow(page, "03-mysql-datasource");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresTableInAnotherSchema_whenNewConsole_thenThatSchemaAndTheDatabaseNodeKeepsTheDefault",
    async () => {
      const page = await launch(POSTGRES);
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("public");
      await revealArchiveTable(page, null);

      await newConsoleOn(page, treeRow(page, ARCHIVE_TABLE));
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(ARCHIVE);
      expect(await namespaceLabel(page).getAttribute("title")).toBe(`${DATABASE}.${ARCHIVE}`);
      await captureWindow(page, "04-postgres-table");

      await newConsoleOn(page, treeRow(page, DATABASE));
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe("public");
      expect(await consoleAlert(page).count()).toBe(0);
      await captureWindow(page, "05-postgres-database");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_MSSQL)(
    "givenSqlServerSchemaTable_whenNewConsoleOrDdlToConsole_thenConsoleInItsDatabase",
    async () => {
      const page = await launch(SQL_SERVER);
      await expect.poll(() => labelTitle(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(SQL_SERVER_DEFAULT);
      await revealArchiveTable(page, null);

      await newConsoleOn(page, treeRow(page, ARCHIVE_TABLE));
      await expect.poll(() => labelTitle(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(SQL_SERVER_DEFAULT);
      expect(await consoleAlert(page).count()).toBe(0);
      await captureWindow(page, "06-mssql-table");

      const before = await consoleTabs(page).count();
      await treeRow(page, ARCHIVE).click({ button: "right" });
      await page.getByRole("menuitem", { name: SQL_SCRIPTS }).click();
      await page.getByRole("menuitem", { name: TO_CONSOLE }).click();
      await expect.poll(() => consoleTabs(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(before + 1);
      await waitUntilReady(page);
      await expect.poll(() => labelTitle(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(SQL_SERVER_DEFAULT);
      expect(await consoleAlert(page).count()).toBe(0);
      // `USE` lands on the database's default schema, inside the target: no warning (found live).
      expect(await page.getByText(/The session is in/).count()).toBe(0);
      await sqlEditor(page).press("Escape");
      await captureWindow(page, "07-mssql-ddl");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteTable_whenNewConsole_thenConsoleOpensWithoutASwitch",
    async () => {
      const page = await launch({ id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } });
      await expand(page, "tables 6", "customers");

      await newConsoleOn(page, treeRow(page, "customers"));

      expect(await namespaceLabel(page).count()).toBe(0);
      expect(await consoleAlert(page).count()).toBe(0);
      expect(await page.getByText(/currentNamespace/).count()).toBe(0);
      await captureWindow(page, "08-sqlite-table");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
