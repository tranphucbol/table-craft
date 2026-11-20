/**
 * PostgreSQL discovery against the disposable local fixture; creates and drops tc_pr111 databases.
 * Run against a fresh app build and the already-running PostgreSQL fixture (PowerShell):
 * $env:TABLE_CRAFT_SMOKE='1'; $env:TABLE_CRAFT_DATABASES='postgres'; $env:TABLE_CRAFT_PG_PORT='55532'
 * $env:TABLE_CRAFT_EVIDENCE_DIR='docs/evidence/pr-111'
 * bun run test test/e2e/postgresDatabases.smoke.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import postgres from "@table-craft/plugin-postgres";
import { databaseEnabled, POSTGRES_CONFIG } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  dataSourcesDialog,
  editorTabs,
  findAction,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  SMOKE_ENABLED,
  treeNode,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const SOURCE_NAME = "Postgres discovery";
const SIBLING_DATABASE = "postgres";
const SIBLING_NAME = `${SOURCE_NAME} / ${SIBLING_DATABASE}`;
const SESSION_MARKER = "original-session";
const LIMITED_ROLE = "tc_pr111_limited";
const HIDDEN_DATABASE = "tc_pr111_hidden";
const FRESH_DATABASE = "tc_pr111_fresh";
const SESSION_VALUE =
  "current_database() || ':' || pg_backend_pid()::text || ':' || " +
  "COALESCE(current_setting('tablecraft.smoke_database', true), 'unset')";
const capture = evidenceFor("pr-111");

async function captureWindow(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await capture(page, name);
}

async function adminRows(sql: string): Promise<readonly unknown[]> {
  const session = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
  try {
    const result = await session.execute(sql);
    const rows: unknown[] = [];
    for await (const row of result.rows) rows.push(row);
    return rows;
  } finally {
    await session.close();
  }
}

async function adminSql(sql: string): Promise<void> {
  await adminRows(sql);
}

async function ensureDatabase(name: string): Promise<void> {
  if ((await adminRows(`SELECT 1 FROM pg_database WHERE datname = '${name}'`)).length === 0)
    await adminSql(`CREATE DATABASE ${name}`);
}

async function prepareLimitedRole(): Promise<void> {
  await adminSql(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${LIMITED_ROLE}') THEN
      CREATE ROLE ${LIMITED_ROLE} LOGIN PASSWORD '${LIMITED_ROLE}';
    END IF;
  END $$`);
  await ensureDatabase(HIDDEN_DATABASE);
  await adminSql(`REVOKE CONNECT ON DATABASE ${HIDDEN_DATABASE} FROM PUBLIC`);
  await adminSql(`REVOKE CONNECT ON DATABASE ${HIDDEN_DATABASE} FROM ${LIMITED_ROLE}`);
}

describe.runIf(SMOKE_ENABLED && databaseEnabled("postgres"))("PostgreSQL database discovery", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenConnectedPostgres_whenDiscoveredSiblingIsQueried_thenDatabaseAndOriginalSessionStayIndependent",
    async () => {
      await adminSql(`DROP DATABASE IF EXISTS ${FRESH_DATABASE}`);
      await adminSql(`DROP DATABASE IF EXISTS ${HIDDEN_DATABASE}`);
      const userDataDir = newProfile();
      const { password, ...config } = POSTGRES_CONFIG;
      seedDatasources(userDataDir, [
        {
          id: "pg-discovery",
          name: SOURCE_NAME,
          pluginId: "postgres",
          config,
          secretModes: { password: "untilRestart" },
        },
      ]);
      running = await launchApp(null, { userDataDir });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await openConsoleOn(page, SOURCE_NAME);
      await answerSecretPrompt(page, SOURCE_NAME, password);
      await waitUntilReady(page);

      // Discovery belongs to the original connection's Manage Shown Schemas picker.
      await treeNode(page, SIBLING_DATABASE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await treeNode(page, SOURCE_NAME).count()).toBe(1);
      expect(await treeNode(page, SIBLING_NAME).count()).toBe(0);
      await treeNode(page, SOURCE_NAME).click();
      await findAction(page, "Manage Shown Schemas");
      const dialog = page.getByRole("dialog", { name: `Manage Shown Databases — ${SOURCE_NAME}` });
      expect(await dialog.getByRole("checkbox", { name: SIBLING_DATABASE }).isChecked()).toBe(true);
      expect(await dialog.getByRole("checkbox", { name: "template0" }).count()).toBe(0);
      expect(await dialog.getByRole("checkbox", { name: "template1" }).count()).toBe(0);
      await captureWindow(page, "01-picker-databases");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await captureWindow(page, "02-one-connection-root");
      await treeNode(page, SOURCE_NAME).click();
      await findAction(page, "Manage Shown Schemas");
      const selection = page.getByRole("dialog", { name: `Manage Shown Databases — ${SOURCE_NAME}` });
      await selection.getByRole("checkbox", { name: "All databases" }).uncheck();
      await selection.getByRole("checkbox", { name: SIBLING_DATABASE }).uncheck();
      await selection.getByRole("button", { name: "OK" }).click();
      await expect.poll(() => treeNode(page, SIBLING_DATABASE).count()).toBe(0);
      await captureWindow(page, "03-database-hidden");
      await treeNode(page, SOURCE_NAME).click();
      await findAction(page, "Manage Shown Schemas");
      const reopened = page.getByRole("dialog", { name: `Manage Shown Databases — ${SOURCE_NAME}` });
      await reopened.getByRole("checkbox", { name: SIBLING_DATABASE }).check();
      await reopened.getByRole("button", { name: "OK" }).click();
      await treeNode(page, SIBLING_DATABASE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "04-database-shown");
      await runStatement(page, `SELECT set_config('tablecraft.smoke_database', '${SESSION_MARKER}', false)`);
      await runStatement(page, `SELECT ${SESSION_VALUE} AS original_session`);
      await expect
        .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([expect.stringMatching(/^table_craft:\d+:original-session$/)]);
      const [originalSession] = (await gridText(page)).cells;
      expect(originalSession).toBeDefined();
      await runStatement(page, "SELECT current_database()");
      await expect.poll(async () => (await gridText(page)).cells).toEqual(["table_craft"]);
      await captureWindow(page, "05-original-database-query");

      await openConsoleOn(page, SIBLING_DATABASE);
      await expect.poll(() => editorTabs(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      await waitUntilReady(page);
      await runStatement(page, `SELECT ${SESSION_VALUE} AS sibling_session`);
      await expect
        .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([expect.stringMatching(/^postgres:\d+:unset$/)]);
      const [siblingSession] = (await gridText(page)).cells;
      expect(siblingSession?.split(":")[1]).not.toBe(originalSession?.split(":")[1]);
      expect(await editorTabs(page).count()).toBe(2);
      await runStatement(page, "SELECT current_database()");
      await expect.poll(async () => (await gridText(page)).cells).toEqual(["postgres"]);
      await captureWindow(page, "06-discovered-database-query");

      await editorTabs(page)
        .filter({ hasText: `console [${SOURCE_NAME}]` })
        .click();
      await waitUntilReady(page);
      await runStatement(page, `SELECT ${SESSION_VALUE} || ':after' AS original_after`);
      await expect
        .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([`${originalSession}:after`]);
      await expect.poll(() => treeNode(page, SOURCE_NAME).getAttribute("data-state")).toBe("connected");
      await expect.poll(() => treeNode(page, SIBLING_DATABASE).count()).toBe(1);

      const saved = JSON.parse(readProfileFile(userDataDir, "datasources.json") ?? "null") as {
        datasources: { id: string; name: string; config: { database: string } }[];
      };
      expect(saved.datasources.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: "pg-discovery", name: SOURCE_NAME },
      ]);
      expect(saved.datasources[0]?.config.database).toBe(POSTGRES_CONFIG.database);
      await treeNode(page, SOURCE_NAME).click();
      await findAction(page, "Data Source Properties");
      expect(
        await dataSourcesDialog(page).getByRole("listbox", { name: "Data sources" }).getByRole("option").count(),
      ).toBe(1);
      await captureWindow(page, "07-only-original-saved");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRestrictedUser_whenServerChanges_thenPickerOmitsForbiddenDatabaseAndRefreshFindsNewOne",
    async () => {
      await prepareLimitedRole();
      await adminSql(`DROP DATABASE IF EXISTS ${FRESH_DATABASE}`);
      const userDataDir = newProfile();
      const { password: _password, ...config } = POSTGRES_CONFIG;
      seedDatasources(userDataDir, [
        {
          id: "pg-limited",
          name: "Local limited PostgreSQL",
          pluginId: "postgres",
          config: { ...config, user: LIMITED_ROLE },
          secretModes: { password: "never" },
        },
      ]);
      running = await launchApp(null, { userDataDir });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await openConsoleOn(page, "Local limited PostgreSQL");
      await answerSecretPrompt(page, "Local limited PostgreSQL", LIMITED_ROLE);
      await waitUntilReady(page);
      await treeNode(page, "postgres").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await treeNode(page, "Local limited PostgreSQL").click();
      await findAction(page, "Manage Shown Schemas");
      const dialog = page.getByRole("dialog", { name: "Manage Shown Databases — Local limited PostgreSQL" });
      expect(await dialog.getByRole("checkbox", { name: "postgres" }).count()).toBe(1);
      expect(await dialog.getByRole("checkbox", { name: HIDDEN_DATABASE }).count()).toBe(0);
      expect(await dialog.getByRole("checkbox", { name: "template0" }).count()).toBe(0);
      expect(await dialog.getByRole("checkbox", { name: "template1" }).count()).toBe(0);
      await captureWindow(page, "08-restricted-picker");
      await dialog.getByRole("button", { name: "Cancel" }).click();

      await ensureDatabase(FRESH_DATABASE);
      expect(await treeNode(page, FRESH_DATABASE).count()).toBe(0);
      await treeNode(page, "Local limited PostgreSQL").click({ button: "right" });
      await page.getByRole("menuitem", { name: "Synchronize" }).click();
      await treeNode(page, FRESH_DATABASE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "09-new-database-after-refresh");
      await treeNode(page, "Local limited PostgreSQL").click();
      await findAction(page, "Manage Shown Schemas");
      const refreshed = page.getByRole("dialog", { name: "Manage Shown Databases — Local limited PostgreSQL" });
      await expect.poll(() => refreshed.getByRole("checkbox", { name: FRESH_DATABASE }).count()).toBe(1);
      await refreshed.getByRole("button", { name: "Cancel" }).click();
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDiscoveredDatabase_whenReadOnlyChanges_thenSourceRebuildsItsDatabaseEntries",
    async () => {
      const userDataDir = newProfile();
      const { password, ...config } = POSTGRES_CONFIG;
      seedDatasources(userDataDir, [
        {
          id: "pg-read-only",
          name: "Local read-only PostgreSQL",
          pluginId: "postgres",
          config,
          secretModes: { password: "untilRestart" },
        },
      ]);
      running = await launchApp(null, { userDataDir });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await openConsoleOn(page, "Local read-only PostgreSQL");
      await answerSecretPrompt(page, "Local read-only PostgreSQL", password);
      await treeNode(page, "postgres").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await treeNode(page, "Local read-only PostgreSQL").click();
      await findAction(page, "Data Source Properties");
      const properties = dataSourcesDialog(page);
      await properties.getByRole("checkbox", { name: "Refuse writes in this data source's sessions" }).check();
      await captureWindow(page, "10-read-only-setting");
      await properties.getByRole("button", { name: "OK", exact: true }).click();
      await expect.poll(() => treeNode(page, "postgres").count()).toBe(0);
      await treeNode(page, "Local read-only PostgreSQL").click();
      await findAction(page, "Discover Databases");
      await treeNode(page, "postgres").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "11-read-only-databases-rebuilt");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSQLiteConnection_whenManagingShownSchemas_thenSchemaPickerStillWorks",
    async () => {
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [
        { id: "local-sqlite", name: "Local SQLite fixture", pluginId: "sqlite", config: { path: seededSqliteFile() } },
      ]);
      running = await launchApp(null, { userDataDir });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await openConsoleOn(page, "Local SQLite fixture");
      await waitUntilReady(page);
      await treeNode(page, "Local SQLite fixture").click();
      await findAction(page, "Manage Shown Schemas");
      const dialog = page.getByRole("dialog", { name: "Manage Shown Schemas — Local SQLite fixture" });
      await dialog.getByRole("checkbox", { name: "main" }).waitFor();
      expect(await dialog.getByRole("checkbox", { name: "All schemas" }).isChecked()).toBe(true);
      await captureWindow(page, "12-sqlite-schema-picker");
      await dialog.getByRole("checkbox", { name: "All schemas" }).uncheck();
      await dialog.getByRole("checkbox", { name: "main" }).uncheck();
      await dialog.getByRole("checkbox", { name: "main" }).check();
      await dialog.getByRole("button", { name: "OK" }).click();
      await treeNode(page, "main").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    },
    SCENARIO_TIMEOUT_MS,
  );
});
