/**
 * Plan 004's live test: saved datasources, the Data Sources dialog, secrets, read-only, folders and
 * engine lifecycle, against the `test/db/compose.yml` databases. Gated, because it needs a display,
 * a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/004 bun run test:smoke:db
 */
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, withWrongPassword, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  contentSize,
  DATABASES_ENABLED,
  dataSourcesDialog,
  datasourceStatus,
  editorTabs,
  enginePids,
  EVIDENCE_WINDOW,
  evidenceFor,
  fillNewDatasource,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  secretPrompt,
  seedDatasources,
  setWindowSize,
  testConnection,
  toolWindow,
  treeNode,
  waitUntilReady,
  type DatasourceForm,
  type RunningApp,
  type SavedDatasource,
  optionValue,
} from "./harness.js";

const captureWindow = evidenceFor("004");

const PASSWORD = POSTGRES_CONFIG.password;
const { password: _postgresPassword, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;
const { password: _mysqlPassword, ...MYSQL_PLAIN } = MYSQL_CONFIG;

const POSTGRES_FORM: DatasourceForm = {
  kind: "PostgreSQL",
  name: "pg",
  fields: {
    Host: POSTGRES_CONFIG.host,
    Port: String(POSTGRES_CONFIG.port),
    Database: POSTGRES_CONFIG.database,
    User: POSTGRES_CONFIG.user,
  },
  password: PASSWORD,
};

const MYSQL_WRONG_FORM: DatasourceForm = {
  kind: "MySQL",
  name: "mysql",
  fields: {
    Host: MYSQL_CONFIG.host,
    Port: String(MYSQL_CONFIG.port),
    Database: MYSQL_CONFIG.database,
    User: MYSQL_CONFIG.user,
  },
  password: withWrongPassword(MYSQL_CONFIG).password,
};

function postgres(overrides: Partial<SavedDatasource> = {}): SavedDatasource {
  return {
    id: "pg",
    name: "pg",
    pluginId: "postgres",
    config: { ...POSTGRES_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
    ...overrides,
  };
}

function mysql(overrides: Partial<SavedDatasource> = {}): SavedDatasource {
  return {
    id: "mysql",
    name: "mysql",
    pluginId: "mysql",
    config: { ...MYSQL_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
    ...overrides,
  };
}

function sqlite(overrides: Partial<SavedDatasource> = {}): SavedDatasource {
  return { id: "sqlite", name: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() }, ...overrides };
}

const ENGINE_EXITED = "failed: engine exited";
const READ_ONLY_INSERT = "INSERT INTO customers (id, name, email) VALUES (999, 'Read Only', 'ro@example.com')";

describe.runIf(DATABASES_ENABLED)("datasources live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasources: readonly SavedDatasource[] = [], userDataDir = newProfile()) {
    seedDatasources(userDataDir, datasources);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor();
    return running;
  }

  async function relaunch(userDataDir: string) {
    await closeApp(running?.app);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor();
    return running;
  }

  async function connected(name: string) {
    const page = running?.page;
    if (page === undefined) throw new Error("The app is not running.");
    await expect
      .poll(() => treeNode(page, name).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
      .toBe("connected");
  }

  it(
    "givenNoDatasources_whenLaunched_thenDatabasePaneShowsTheEmptyState",
    async () => {
      const { app, page } = await launch();

      expect(await contentSize(app)).toEqual(EVIDENCE_WINDOW);
      await expect.poll(() => page.getByText("No data sources.").isVisible()).toBe(true);
      expect(await page.getByRole("button", { name: /^New Data Source \(/ }).isVisible()).toBe(true);
      expect(await editorTabs(page).count()).toBe(0);
      await captureWindow(page, "empty-state");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenNewPostgresForm_whenTestConnectionClicked_thenSucceedsWithServerVersionAndTime",
    async () => {
      const { page } = await launch();
      await fillNewDatasource(page, POSTGRES_FORM);
      const dialog = dataSourcesDialog(page);
      expect(await optionValue(dialog.getByLabel("Save password"))).toBe("forever");
      await captureWindow(page, "new-datasource-form");

      const result = await testConnection(page);

      expect(result.ok).toBe(true);
      expect(result.text).toMatch(/^Succeeded · PostgreSQL \d+(\.\d+)* · limit: statement_timeout · \d+ ms$/);
      await captureWindow(page, "test-connection-ok");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlWrongPassword_whenTestConnectionClicked_thenFailsWithThePluginsError",
    async () => {
      const { page } = await launch();
      await fillNewDatasource(page, MYSQL_WRONG_FORM);

      const result = await testConnection(page);

      expect(result.ok).toBe(false);
      expect(result.text).toMatch(/Could not connect.*Access denied.*Check that the database is running/);
      await captureWindow(page, "test-connection-failed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenDatasourcesInFolders_whenEachConnected_thenTreeNestsFoldersAndShowsStatuses",
    async () => {
      const { page } = await launch([
        postgres({ folder: "Docker/Main", color: "blue" }),
        mysql({ folder: "Docker/Main", color: "orange" }),
        sqlite({ folder: "Local", color: "green" }),
      ]);

      for (const name of ["pg", "mysql", "sqlite"]) {
        await treeNode(page, name).click({ button: "right" });
        await page.getByRole("menuitem", { name: /^Connect/ }).click();
        if (name !== "sqlite") await answerSecretPrompt(page, name, PASSWORD);
        await connected(name);
      }

      const rows: string[] = [];
      const datasourceRows = toolWindow(page, "Database").locator(
        '[role="treeitem"]:is([data-kind="folder"], [data-kind="datasource"])',
      );
      for (const item of await datasourceRows.all()) {
        rows.push(`${(await item.getAttribute("aria-level")) ?? ""} ${(await item.getAttribute("aria-label")) ?? ""}`);
      }
      expect(rows).toEqual([
        "1 Docker, folder",
        "2 Main, folder",
        "3 mysql, connected",
        "3 pg, connected",
        "1 Local, folder",
        "2 sqlite, connected",
      ]);
      await treeNode(page, "pg").click();
      await expect.poll(() => datasourceStatus(page).textContent()).toMatch(/^pg · connected · PostgreSQL \d/);
      await captureWindow(page, "folders-connected");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenForeverPassword_whenRelaunched_thenDatasourceRestoredAndConnectsWithoutRetyping",
    async () => {
      const { page, userDataDir } = await launch();
      await fillNewDatasource(page, POSTGRES_FORM);
      await dataSourcesDialog(page).getByRole("button", { name: "OK", exact: true }).click();
      await treeNode(page, "pg").waitFor();

      const saved = JSON.parse(readProfileFile(userDataDir, "datasources.json") ?? "null") as {
        datasources: readonly { config: Record<string, unknown>; secretModes: Record<string, string> }[];
      };
      expect(saved.datasources).toHaveLength(1);
      expect(saved.datasources[0]?.config).not.toHaveProperty("password");
      expect(saved.datasources[0]?.secretModes).toEqual({ password: "forever" });
      const secrets = readProfileFile(userDataDir, "secrets.json");
      expect(secrets).not.toBeNull();
      expect(secrets).not.toContain(PASSWORD);

      const again = await relaunch(userDataDir);
      await openConsoleOn(again.page, "pg");
      await waitUntilReady(again.page);
      expect(await secretPrompt(again.page, "pg").count()).toBe(0);
      await runStatement(again.page, "SELECT current_user AS who");
      expect((await gridText(again.page)).cells).toEqual([POSTGRES_CONFIG.user]);
      await connected("pg");
      await captureWindow(again.page, "relaunch-restored");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenReadOnlyRedDatasource_whenInsertRun_thenRefusedAndConsoleTinted",
    async () => {
      const { page } = await launch([postgres({ name: "pg-prod", readOnly: true, color: "red" })]);
      await openConsoleOn(page, "pg-prod");
      await answerSecretPrompt(page, "pg-prod", PASSWORD);
      await waitUntilReady(page);

      await runStatement(page, READ_ONLY_INSERT);

      await expect.poll(() => consoleAlert(page).textContent()).toMatch(/read-only transaction/);
      expect(await activeEditorTab(page).getAttribute("data-color")).toBe("red");
      expect(await page.getByTestId("console").getAttribute("data-color")).toBe("red");
      expect(await activeEditorTab(page).getByLabel("read-only").count()).toBe(1);
      await captureWindow(page, "read-only-red");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNeverSavedPassword_whenConnectedTwice_thenPromptsEachTime",
    async () => {
      const { page } = await launch([mysql({ secretModes: { password: "never" } })]);
      await openConsoleOn(page, "mysql");

      const prompt = secretPrompt(page, "mysql");
      await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await prompt.getByLabel("Password").fill(PASSWORD);
      await captureWindow(page, "secret-prompt");
      await prompt.getByRole("button", { name: "Connect", exact: true }).click();
      await waitUntilReady(page);
      await runStatement(page, "SELECT 1 AS one");
      expect((await gridText(page)).cells).toEqual(["1"]);

      await pressChord(page, "F2");
      await expect.poll(() => treeNode(page, "mysql").getAttribute("data-state")).toBe("disconnected");
      await treeNode(page, "mysql").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Connect/ }).click();
      await answerSecretPrompt(page, "mysql", PASSWORD);
      await connected("mysql");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresAndMysqlConsoles_whenEachRuns_thenResultsStaySeparateAndStatusFollowsTab",
    async () => {
      const { app, page } = await launch([postgres(), mysql()]);
      await openConsoleOn(page, "pg");
      await answerSecretPrompt(page, "pg", PASSWORD);
      await waitUntilReady(page);
      await runStatement(page, "SELECT 'from postgres' AS source");
      await openConsoleOn(page, "mysql");
      await answerSecretPrompt(page, "mysql", PASSWORD);
      await waitUntilReady(page);
      await runStatement(page, "SELECT 'from mysql' AS source");

      expect(await editorTabs(page).allTextContents()).toEqual(["console [pg]", "console [mysql]"]);
      expect((await gridText(page)).cells).toEqual(["from mysql"]);
      await expect.poll(() => datasourceStatus(page).textContent()).toMatch(/^mysql · connected · MySQL \d/);

      await editorTabs(page).filter({ hasText: "console [pg]" }).click();
      await expect.poll(async () => (await gridText(page)).cells).toEqual(["from postgres"]);
      await expect.poll(() => datasourceStatus(page).textContent()).toMatch(/^pg · connected · PostgreSQL \d/);
      expect(await enginePids(app)).toHaveLength(2);
      await captureWindow(page, "two-datasources");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenConnectedPostgres_whenModF2Pressed_thenDisconnectedAndEngineProcessGone",
    async () => {
      const { app, page } = await launch([postgres()]);
      await openConsoleOn(page, "pg");
      await answerSecretPrompt(page, "pg", PASSWORD);
      await waitUntilReady(page);
      await runStatement(page, "SELECT 1 AS one");
      expect(await enginePids(app)).toHaveLength(1);

      await pressChord(page, "F2");

      await expect.poll(() => treeNode(page, "pg").getAttribute("data-state")).toBe("disconnected");
      await expect.poll(() => enginePids(app), { timeout: LAUNCH_TIMEOUT_MS }).toHaveLength(0);
      await expect.poll(() => page.getByText("Disconnected; Run reconnects.").isVisible()).toBe(true);
      await captureWindow(page, "disconnected");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenConnectedMysql_whenEngineKilled_thenNodeFailsAndConnectBringsItBack",
    async () => {
      const { app, page } = await launch([mysql()]);
      await openConsoleOn(page, "mysql");
      await answerSecretPrompt(page, "mysql", PASSWORD);
      await waitUntilReady(page);
      const [pid] = await enginePids(app);
      expect(pid).toBeDefined();

      process.kill(pid ?? 0, "SIGKILL");

      await expect
        .poll(() => treeNode(page, "mysql").getAttribute("aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`mysql, ${ENGINE_EXITED}`);
      expect(await consoleAlert(page).textContent()).toMatch(/^Engine exited \(code \d+\)\./);
      expect(await page.getByText("Disconnected; Run reconnects.").count()).toBe(0);
      await captureWindow(page, "engine-crashed");

      await treeNode(page, "mysql").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Connect/ }).click();
      await connected("mysql");
      await waitUntilReady(page);
      await runStatement(page, "SELECT 1 AS one");
      expect((await gridText(page)).cells).toEqual(["1"]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteWithConsoles_whenDeletedAndConfirmed_thenConsolesCloseAndItStaysGone",
    async () => {
      const { page, userDataDir } = await launch([sqlite()]);
      await openConsoleOn(page, "sqlite");
      await waitUntilReady(page);
      await openConsoleOn(page, "sqlite");
      await expect.poll(() => editorTabs(page).count()).toBe(2);

      await treeNode(page, "sqlite").click();
      await page.keyboard.press("Delete");
      const confirm = page.getByRole("dialog", { name: "Delete Data Source" });
      await confirm.waitFor();
      const prompt = await confirm.textContent();
      expect(prompt).toContain("Its 2 open consoles will close.");
      expect(prompt).not.toContain("password");
      await captureWindow(page, "deleted");
      await confirm.getByRole("button", { name: "Delete", exact: true }).click();

      await expect.poll(() => editorTabs(page).count()).toBe(0);
      await expect.poll(() => page.getByText("No data sources.").isVisible()).toBe(true);

      const again = await relaunch(userDataDir);
      await expect.poll(() => again.page.getByText("No data sources.").isVisible()).toBe(true);
      expect(readProfileFile(userDataDir, "datasources.json")).not.toContain('"sqlite"');
    },
    SCENARIO_TIMEOUT_MS,
  );
});
