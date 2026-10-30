/**
 * Plan 024's live test: New Table, Modify Table, Rename, Truncate and Drop from the Database pane,
 * each previewed as the plugin's DDL before it runs. SQLite always runs; PostgreSQL and MySQL need
 * the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/024 bun run test:smoke:db
 */
import { DatabaseSync } from "node:sqlite";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  chooseOption,
} from "./harness.js";

const captureWindow = evidenceFor("024");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

const TABLE = "object_live";
const RENAMED = "object_renamed";
const VIEW = "object_live_view";
const RENAMED_VIEW = "object_renamed_view";
const PARENT = "object_parent";
const CHILD = "object_child";
const POSTGRES_CLEANUP = [
  `DROP VIEW IF EXISTS public.${VIEW}, public.${RENAMED_VIEW}`,
  `DROP TABLE IF EXISTS public.${CHILD}, public.${PARENT}, public.${TABLE}, public.${RENAMED} CASCADE`,
];
const MYSQL_CLEANUP = [`DROP TABLE IF EXISTS ${TABLE}`];

type Plugin = typeof postgres;

function sqlite(path: string): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path } };
}

/** Runs each statement as the fixture's owner outside the app and answers the last one's rows. */
async function asOwner(plugin: Plugin, config: object, ...statements: string[]): Promise<unknown[][]> {
  const session = await plugin.connect(config, { readOnly: false });
  try {
    let rows: unknown[][] = [];
    for (const sql of statements) {
      const result = await session.execute(sql);
      rows = [];
      for await (const row of result.rows) rows.push([...row]);
    }
    return rows;
  } finally {
    await session.close();
  }
}

function postgresOwner(...statements: string[]): Promise<unknown[][]> {
  return asOwner(postgres, POSTGRES_CONFIG, ...statements);
}

function mysqlOwner(...statements: string[]): Promise<unknown[][]> {
  return asOwner(mysql, MYSQL_CONFIG, ...statements);
}

function sqliteRun(path: string, ...statements: string[]): unknown[] {
  const database = new DatabaseSync(path);
  try {
    let rows: unknown[] = [];
    for (const sql of statements) rows = database.prepare(sql).all();
    return rows;
  } finally {
    database.close();
  }
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string | RegExp) {
  return explorer(page).getByRole("treeitem", { name, exact: typeof name === "string" });
}

/** Opens the first `<label> N` group if it is closed. */
async function openGroup(page: Page, label: string): Promise<void> {
  const group = treeRow(page, new RegExp(`^${label} \\d+$`)).first();
  await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
    await page.keyboard.press("ArrowRight");
  }
}

async function fromMenu(page: Page, row: string, item: RegExp): Promise<void> {
  await treeRow(page, row).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await treeRow(page, row).click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
}

function designer(page: Page): Locator {
  return page.getByRole("dialog").filter({ has: page.getByTestId("design-name") });
}

function changeDialog(page: Page): Locator {
  return page
    .getByRole("dialog")
    .filter({ has: page.getByTestId("object-ddl") })
    .filter({ hasNot: page.getByTestId("design-name") });
}

async function ddlOf(dialog: Locator): Promise<string> {
  return (await dialog.getByTestId("object-ddl").locator(".cm-line").allTextContents()).join("\n");
}

async function previewed(dialog: Locator, pattern: RegExp): Promise<string> {
  try {
    await expect.poll(() => ddlOf(dialog), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(pattern);
  } catch (error) {
    throw new Error(`No preview matching ${String(pattern)} in: ${(await dialog.textContent()) ?? ""}`, {
      cause: error,
    });
  }
  return ddlOf(dialog);
}

function statementsIn(ddl: string): string[] {
  return ddl
    .split(/;\s*\n?/)
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

async function addColumn(dialog: Locator, name: string, type: string): Promise<void> {
  await dialog.getByRole("button", { name: "Add Column", exact: true }).click();
  const added = dialog.getByLabel(/^Name of column_\d+$/).last();
  await added.fill(name);
  await dialog.getByLabel(`Type of ${name}`, { exact: true }).fill(type);
}

async function apply(dialog: Locator, button = "Apply"): Promise<void> {
  const confirm = dialog.getByRole("button", { name: button, exact: true });
  await expect.poll(() => confirm.isEnabled()).toBe(true);
  await confirm.click();
  await dialog.waitFor({ state: "detached" });
}

/** The rename prompt, then the previewed change. */
async function renameTo(page: Page, name: string): Promise<Locator> {
  const prompt = page.getByRole("dialog").filter({ hasText: /^Rename/ });
  await prompt.getByRole("textbox").fill(name);
  await prompt.getByRole("button", { name: "Preview", exact: true }).click();
  return changeDialog(page);
}

function notice(page: Page): Locator {
  return page.getByRole("dialog").filter({ hasText: "Could not change the database" });
}

describe.runIf(SMOKE_ENABLED)("object management live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    if (DATABASES_ENABLED) {
      if (!WITHOUT_POSTGRES) await postgresOwner(...POSTGRES_CLEANUP);
      await mysqlOwner(...MYSQL_CLEANUP);
    }
  });

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenPostgresSchema_whenNewTableDesigned_thenPreviewedAndCreatedWithKeyIndexAndForeignKey",
    async () => {
      await postgresOwner(...POSTGRES_CLEANUP);
      const page = await launch(POSTGRES);

      await fromMenu(page, "public", /^New Table/);
      const dialog = designer(page);
      await dialog.getByTestId("design-name").fill(TABLE);
      await addColumn(dialog, "label", "varchar(40)");
      await addColumn(dialog, "customer_id", "integer");
      await dialog.getByTestId("design-tab-indexes").click();
      await dialog.getByRole("button", { name: "Add Index", exact: true }).click();
      await dialog.getByLabel("Columns of index 1", { exact: true }).fill("label");
      await dialog.getByTestId("design-tab-foreignKeys").click();
      await dialog.getByRole("button", { name: "Add Foreign Key", exact: true }).click();
      await dialog.getByLabel("Columns of foreign key 1", { exact: true }).fill("customer_id");
      await chooseOption(dialog.getByLabel("Table foreign key 1 references", { exact: true }), { label: "customers" });
      const ddl = await previewed(dialog, /REFERENCES .*customers/);
      expect(ddl).toMatch(new RegExp(`CREATE TABLE .*${TABLE}`));
      expect(ddl).toMatch(/PRIMARY KEY/);
      expect(ddl).toMatch(new RegExp(`CREATE INDEX .*${TABLE}_idx1`));
      await expect(dialog.getByTestId("object-notes").textContent()).resolves.toContain("Runs in one transaction");
      await captureWindow(page, "pg-new-table-designer");
      await apply(dialog);

      await treeRow(page, TABLE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(
        await postgresOwner(
          `SELECT constraint_type FROM information_schema.table_constraints WHERE table_name = '${TABLE}' AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY') ORDER BY constraint_type`,
        ),
      ).toEqual([["FOREIGN KEY"], ["PRIMARY KEY"]]);
      expect(await postgresOwner(`SELECT indexname FROM pg_indexes WHERE indexname = '${TABLE}_idx1'`)).toEqual([
        [`${TABLE}_idx1`],
      ]);
      await captureWindow(page, "pg-new-table-created");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenPostgresTable_whenColumnAddedRetypedAndDropped_thenOnlyThoseAltersRun",
    async () => {
      await postgresOwner(
        ...POSTGRES_CLEANUP,
        `CREATE TABLE public.${TABLE} (id integer PRIMARY KEY, label varchar(40) NOT NULL, note text)`,
        `INSERT INTO public.${TABLE} VALUES (1, 'kept', 'gone')`,
      );
      const page = await launch(POSTGRES);
      await openGroup(page, "tables");

      await fromMenu(page, TABLE, /^Modify Table/);
      const dialog = designer(page);
      await dialog.getByLabel("Type of label", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await addColumn(dialog, "added", "text");
      await dialog.getByLabel("Type of label", { exact: true }).fill("varchar(80)");
      await dialog.getByRole("button", { name: "Remove note", exact: true }).click();
      const ddl = await previewed(dialog, /DROP COLUMN/);
      const statements = statementsIn(ddl);
      expect(statements).toHaveLength(3);
      expect(statements.join("\n")).toMatch(/ALTER TABLE .* ADD COLUMN added text/);
      expect(statements.join("\n")).toMatch(/ALTER COLUMN label TYPE varchar\(80\)/);
      expect(statements.join("\n")).toMatch(/ALTER TABLE .* DROP COLUMN note/);
      await captureWindow(page, "pg-modify-table-preview");
      await apply(dialog);

      await expect
        .poll(() =>
          postgresOwner(
            `SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = '${TABLE}' ORDER BY ordinal_position`,
          ),
        )
        .toEqual([
          ["id", "integer", null],
          ["label", "character varying", 80],
          ["added", "text", null],
        ]);
      expect(await postgresOwner(`SELECT label FROM public.${TABLE}`)).toEqual([["kept"]]);
      await captureWindow(page, "pg-modify-table-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenPostgresTableAndView_whenRenamed_thenTreeShowsNewNames",
    async () => {
      await postgresOwner(
        ...POSTGRES_CLEANUP,
        `CREATE TABLE public.${TABLE} (id integer PRIMARY KEY)`,
        `CREATE VIEW public.${VIEW} AS SELECT id FROM public.${TABLE}`,
      );
      const page = await launch(POSTGRES);
      await openGroup(page, "tables");

      await fromMenu(page, TABLE, /^Rename/);
      const dialog = await renameTo(page, RENAMED);
      await previewed(dialog, new RegExp(`ALTER TABLE .*${TABLE}"? RENAME TO ${RENAMED}`));
      await captureWindow(page, "pg-rename-table-preview");
      await apply(dialog, "Rename");
      await treeRow(page, RENAMED).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect(treeRow(page, TABLE).count()).resolves.toBe(0);

      await openGroup(page, "views");
      await treeRow(page, VIEW).click();
      await page.keyboard.press("Shift+F6");
      const viewDialog = await renameTo(page, RENAMED_VIEW);
      await previewed(viewDialog, new RegExp(`ALTER VIEW .*${VIEW}"? RENAME TO ${RENAMED_VIEW}`));
      await apply(viewDialog, "Rename");
      await treeRow(page, RENAMED_VIEW).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(
        await postgresOwner(
          `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'object_%' ORDER BY table_name`,
        ),
      ).toEqual([[RENAMED], [RENAMED_VIEW]]);
      await captureWindow(page, "pg-rename-view-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenReferencedPostgresTable_whenTruncatedAndDroppedWithCascade_thenConfirmedAndDependentsFollow",
    async () => {
      await postgresOwner(
        ...POSTGRES_CLEANUP,
        `CREATE TABLE public.${PARENT} (id integer PRIMARY KEY)`,
        `CREATE TABLE public.${CHILD} (id integer PRIMARY KEY, parent_id integer REFERENCES public.${PARENT} (id))`,
        `INSERT INTO public.${PARENT} VALUES (1), (2), (3)`,
        `INSERT INTO public.${CHILD} VALUES (1, 1)`,
      );
      const page = await launch(POSTGRES);
      await openGroup(page, "tables");

      await fromMenu(page, PARENT, /^Truncate/);
      const truncate = changeDialog(page);
      await expect.poll(() => truncate.textContent()).toMatch(/3 rows/);
      await previewed(truncate, new RegExp(`^TRUNCATE TABLE .*${PARENT}"?;$`));
      await truncate.getByRole("checkbox", { name: /^Cascade/ }).check();
      await previewed(truncate, /CASCADE;$/);
      await captureWindow(page, "pg-truncate-confirm");
      await apply(truncate, "Truncate");
      await expect.poll(() => postgresOwner(`SELECT count(*)::int FROM public.${PARENT}`)).toEqual([[0]]);
      expect(await postgresOwner(`SELECT count(*)::int FROM public.${CHILD}`)).toEqual([[0]]);

      await treeRow(page, PARENT).click();
      await pressChord(page, "Backspace");
      const drop = changeDialog(page);
      await previewed(drop, new RegExp(`^DROP TABLE .*${PARENT}"?;$`));
      await drop.getByRole("checkbox", { name: /^Cascade/ }).check();
      await previewed(drop, /CASCADE;$/);
      await captureWindow(page, "pg-drop-confirm");
      await apply(drop, "Drop");
      await expect.poll(() => treeRow(page, PARENT).count()).toBe(0);
      expect(
        await postgresOwner(
          `SELECT count(*)::int FROM information_schema.table_constraints WHERE table_name = '${CHILD}' AND constraint_type = 'FOREIGN KEY'`,
        ),
      ).toEqual([[0]]);
      await captureWindow(page, "pg-drop-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenPostgresChangeWhoseSecondStatementFails_whenApplied_thenErrorShownAndNothingApplied",
    async () => {
      await postgresOwner(...POSTGRES_CLEANUP, `CREATE TABLE public.${TABLE} (id integer PRIMARY KEY)`);
      const page = await launch(POSTGRES);
      await openGroup(page, "tables");

      await fromMenu(page, TABLE, /^Modify Table/);
      const dialog = designer(page);
      await dialog.getByLabel("Type of id", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await addColumn(dialog, "extra", "text");
      await dialog.getByTestId("design-tab-indexes").click();
      await dialog.getByRole("button", { name: "Add Index", exact: true }).click();
      await dialog.getByLabel("Name of index 1", { exact: true }).fill("customers");
      await dialog.getByLabel("Columns of index 1", { exact: true }).fill("extra");
      await previewed(dialog, /CREATE INDEX customers/);
      await apply(dialog);

      await notice(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect(notice(page).textContent()).resolves.toMatch(/Statement 2 failed.*Nothing was changed/);
      await captureWindow(page, "pg-failed-change");
      expect(
        await postgresOwner(
          `SELECT column_name FROM information_schema.columns WHERE table_name = '${TABLE}' ORDER BY ordinal_position`,
        ),
      ).toEqual([["id"]]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenMysqlDatabase_whenTableCreatedThenModified_thenImplicitCommitNotedAndOneAlterRuns",
    async () => {
      await mysqlOwner(...MYSQL_CLEANUP);
      const page = await launch(MYSQL);

      await fromMenu(page, "table_craft", /^New Table/);
      const create = designer(page);
      await create.getByTestId("design-name").fill(TABLE);
      await addColumn(create, "label", "varchar(40)");
      await addColumn(create, "customer_id", "int");
      await create.getByTestId("design-tab-foreignKeys").click();
      await create.getByRole("button", { name: "Add Foreign Key", exact: true }).click();
      await create.getByLabel("Columns of foreign key 1", { exact: true }).fill("customer_id");
      await chooseOption(create.getByLabel("Table foreign key 1 references", { exact: true }), { label: "customers" });
      await previewed(create, /REFERENCES .*customers/);
      await expect(create.getByTestId("object-notes").textContent()).resolves.toMatch(/commits each DDL statement/);
      await captureWindow(page, "mysql-new-table-designer");
      await apply(create);
      await treeRow(page, TABLE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await fromMenu(page, TABLE, /^Modify Table/);
      const modify = designer(page);
      await modify.getByLabel("Type of label", { exact: true }).fill("varchar(80)");
      await addColumn(modify, "added", "text");
      const statements = statementsIn(await previewed(modify, /ADD COLUMN/));
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/^ALTER TABLE .*CHANGE COLUMN `?label`? `?label`? varchar\(80\).*,\s*ADD COLUMN/s);
      await captureWindow(page, "mysql-modify-table-preview");
      await apply(modify);

      await expect
        .poll(() =>
          mysqlOwner(
            `SELECT column_name, column_type FROM information_schema.columns WHERE table_schema = 'table_craft' AND table_name = '${TABLE}' ORDER BY ordinal_position`,
          ),
        )
        .toEqual([
          ["id", "int"],
          ["label", "varchar(80)"],
          ["customer_id", "int"],
          ["added", "text"],
        ]);
      await captureWindow(page, "mysql-modify-table-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteTable_whenColumnTypeChanged_thenRebuiltWithRowsKeptAndAFailedRebuildChangesNothing",
    async () => {
      const database = seededSqliteFile();
      sqliteRun(
        database,
        `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, label TEXT NOT NULL, customer_id INTEGER REFERENCES customers (id))`,
        `CREATE INDEX ${TABLE}_label_idx ON ${TABLE} (label)`,
        `INSERT INTO ${TABLE} VALUES (1, 'kept', 1)`,
      );
      const page = await launch(sqlite(database));
      await openGroup(page, "tables");

      await fromMenu(page, TABLE, /^Modify Table/);
      const failing = designer(page);
      await failing.getByLabel("Type of label", { exact: true }).fill("VARCHAR(80)");
      await failing.getByTestId("design-tab-indexes").click();
      await failing.getByRole("button", { name: "Add Index", exact: true }).click();
      await failing.getByLabel("Name of index 2", { exact: true }).fill("customers");
      await failing.getByLabel("Columns of index 2", { exact: true }).fill("customer_id");
      await previewed(failing, /CREATE INDEX .*customers"? ON/);
      await apply(failing);
      await notice(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "sqlite-failed-rebuild");
      await notice(page).getByRole("button", { name: "OK", exact: true }).click();
      expect(sqliteRun(database, `SELECT type FROM pragma_table_info('${TABLE}') WHERE name = 'label'`)).toEqual([
        { type: "TEXT" },
      ]);

      await fromMenu(page, TABLE, /^Modify Table/);
      const dialog = designer(page);
      await dialog.getByLabel("Type of label", { exact: true }).fill("VARCHAR(80)");
      const ddl = await previewed(dialog, /__table_craft_new/);
      expect(ddl).toMatch(/^PRAGMA foreign_keys = OFF;/);
      expect(ddl).toMatch(/INSERT INTO .*\nSELECT /);
      expect(ddl).toMatch(/foreign_key_check/);
      await expect(dialog.getByTestId("object-notes").textContent()).resolves.toMatch(/rebuil/i);
      await captureWindow(page, "sqlite-rebuild-preview");
      await apply(dialog);

      await expect
        .poll(() => sqliteRun(database, `SELECT type FROM pragma_table_info('${TABLE}') WHERE name = 'label'`))
        .toEqual([{ type: "VARCHAR(80)" }]);
      expect(sqliteRun(database, `SELECT id, label, customer_id FROM ${TABLE}`)).toEqual([
        { id: 1, label: "kept", customer_id: 1 },
      ]);
      expect(
        sqliteRun(database, `SELECT name FROM sqlite_master WHERE tbl_name = '${TABLE}' AND type = 'index'`),
      ).toEqual([{ name: `${TABLE}_label_idx` }]);
      await captureWindow(page, "sqlite-rebuild-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOpenSqliteTableEditor_whenTableDropped_thenEditorClosesWithNotice",
    async () => {
      const database = seededSqliteFile();
      sqliteRun(
        database,
        `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, label TEXT)`,
        `INSERT INTO ${TABLE} VALUES (1, 'a')`,
      );
      const page = await launch(sqlite(database));
      await openGroup(page, "tables");
      await treeRow(page, TABLE).click();
      await page.keyboard.press("F4");
      await page
        .getByRole("tab", { name: new RegExp(TABLE) })
        .first()
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await fromMenu(page, TABLE, /^Drop/);
      const drop = changeDialog(page);
      await expect.poll(() => drop.textContent()).toMatch(/1 row/);
      await expect(drop.getByRole("checkbox", { name: /^Cascade/ }).count()).resolves.toBe(0);
      await previewed(drop, new RegExp(`^DROP TABLE .*${TABLE}"?;$`));
      await captureWindow(page, "sqlite-drop-confirm");
      await apply(drop, "Drop");

      const closed = page.getByRole("dialog").filter({ hasText: "Table editor closed" });
      await closed.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "sqlite-drop-editor-closed");
      await closed.getByRole("button", { name: "OK", exact: true }).click();
      await expect(page.getByRole("tab", { name: new RegExp(TABLE) }).count()).resolves.toBe(0);
      expect(sqliteRun(database, `SELECT name FROM sqlite_master WHERE name = '${TABLE}'`)).toEqual([]);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
