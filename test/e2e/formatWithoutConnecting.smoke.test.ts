/**
 * Plan 142's live test: Reformat Code on a console whose datasource is not connected starts the
 * engine for the dialect alone, logs in to nothing, asks for no password, and a later Connect logs
 * in through that same engine (decision 149). Gated, because it needs a display, a fresh build and
 * the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/142 bun run test:smoke:db:headless:postgres test/e2e/formatWithoutConnecting.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, withWrongPassword, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  enginePids,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  secretPrompt,
  seedDatasources,
  seedSettings,
  setWindowSize,
  sqlEditor,
  toolWindow,
  treeNode,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("142");

const { password: MYSQL_PASSWORD, ...MYSQL_PLAIN } = MYSQL_CONFIG;
const { password: _postgresPassword, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;
const WRONG_PASSWORD = withWrongPassword(MYSQL_CONFIG).password;
/** A port nothing listens on, so any login attempt would fail loudly. */
const CLOSED_PORT = 1;
/** The secret prompt captured mid-fade otherwise. */
const NO_MOTION = { version: 1, appearance: { motion: "off" } } as const;
/** The renderer's `REFORMAT_FAILED`; its store module needs a window, so the suite repeats the text. */
const REFORMAT_FAILED = "Could not reformat";

const UNFORMATTED = "select id, name from customers where id = 2 and name like 'G%'";
const FORMATTED = "SELECT id,\n       name\nFROM customers\nWHERE id = 2\n  AND name LIKE 'G%'";

function sqlite(): SavedDatasource {
  return { id: "lite", name: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const MYSQL: SavedDatasource = {
  id: "mysql",
  name: "mysql",
  pluginId: "mysql",
  config: { ...MYSQL_PLAIN, sslMode: "disable" },
  secretModes: { password: "never" },
};
const POSTGRES: SavedDatasource = {
  id: "pg",
  name: "pg",
  pluginId: "postgres",
  config: { ...POSTGRES_PLAIN, port: CLOSED_PORT, sslMode: "disable" },
  secretModes: { password: "never" },
};

function editorText(page: Page): Promise<string> {
  return page
    .locator('[data-testid="sql-editor"] .cm-line')
    .allTextContents()
    .then((lines) => lines.join("\n"));
}

describe.runIf(DATABASES_ENABLED)("format without connecting live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: SavedDatasource): Promise<RunningApp> {
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [datasource]);
    seedSettings(userDataDir, NO_MOTION);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor();
    return running;
  }

  async function state(page: Page, name: string, expected: string): Promise<void> {
    await expect
      .poll(() => treeNode(page, name).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
      .toBe(expected);
  }

  async function reformat(page: Page): Promise<void> {
    await sqlEditor(page).fill(UNFORMATTED);
    await expect.poll(() => editorText(page)).toBe(UNFORMATTED);
    await pressChord(page, "Alt+L");
    await expect.poll(() => editorText(page)).toBe(FORMATTED);
  }

  /** Connects with the never-kept password, then disconnects, leaving the console open and no engine. */
  async function disconnectedMysqlConsole(): Promise<RunningApp> {
    const app = await launch(MYSQL);
    await openConsoleOn(app.page, "mysql");
    await answerSecretPrompt(app.page, "mysql", MYSQL_PASSWORD);
    await waitUntilReady(app.page);
    await state(app.page, "mysql", "connected");
    await pressChord(app.page, "F2");
    await state(app.page, "mysql", "disconnected");
    await expect.poll(() => enginePids(app.app), { timeout: LAUNCH_TIMEOUT_MS }).toHaveLength(0);
    return app;
  }

  it(
    "givenDisconnectedSqliteConsole_whenModAltL_thenFormatsAndStaysDisconnectedAndRunReusesTheEngine",
    async () => {
      const { app, page } = await launch(sqlite());
      await openConsoleOn(page, "lite");
      await waitUntilReady(page);
      await state(page, "lite", "connected");
      await pressChord(page, "F2");
      await state(page, "lite", "disconnected");
      await expect.poll(() => enginePids(app), { timeout: LAUNCH_TIMEOUT_MS }).toHaveLength(0);

      await reformat(page);

      expect(await consoleAlert(page).count()).toBe(0);
      expect(await treeNode(page, "lite").getAttribute("data-state")).toBe("disconnected");
      const pids = await enginePids(app);
      expect(pids).toHaveLength(1);
      await captureWindow(page, "01-sqlite-disconnected-formatted");

      await runStatement(page, FORMATTED);
      await state(page, "lite", "connected");
      expect((await gridText(page)).cells).toEqual(["2", "Grace Hopper"]);
      expect(await enginePids(app)).toEqual(pids);
      await captureWindow(page, "02-sqlite-run-same-engine");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDisconnectedMysqlWithoutAStoredPassword_whenModAltL_thenNoPromptAndConnectUsesTheSameEngine",
    async () => {
      const { app, page } = await disconnectedMysqlConsole();

      await reformat(page);

      expect(await secretPrompt(page, "mysql").count()).toBe(0);
      expect(await consoleAlert(page).count()).toBe(0);
      expect(await treeNode(page, "mysql").getAttribute("data-state")).toBe("disconnected");
      const pids = await enginePids(app);
      expect(pids).toHaveLength(1);
      await captureWindow(page, "03-mysql-no-prompt-formatted");

      await treeNode(page, "mysql").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Connect/ }).click();
      await secretPrompt(page, "mysql").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "04-mysql-connect-prompts");
      await answerSecretPrompt(page, "mysql", MYSQL_PASSWORD);
      await state(page, "mysql", "connected");
      expect(await enginePids(app)).toEqual(pids);

      await waitUntilReady(page);
      await runStatement(page, "SELECT 1 AS one");
      expect((await gridText(page)).cells).toEqual(["1"]);
      expect(await enginePids(app)).toEqual(pids);
      await page.keyboard.press("Escape");
      await captureWindow(page, "05-mysql-connected-same-engine");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFormattedMysqlConsole_whenConnectWithAWrongPassword_thenFailsStopsTheEngineAndFormatStillWorks",
    async () => {
      const { app, page } = await disconnectedMysqlConsole();
      await reformat(page);
      expect(await enginePids(app)).toHaveLength(1);

      await treeNode(page, "mysql").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Connect/ }).click();
      await answerSecretPrompt(page, "mysql", WRONG_PASSWORD);

      await state(page, "mysql", "failed");
      await expect.poll(() => enginePids(app), { timeout: LAUNCH_TIMEOUT_MS }).toHaveLength(0);
      await captureWindow(page, "06-mysql-wrong-password-engine-stopped");

      await reformat(page);
      expect(await enginePids(app)).toHaveLength(1);
      expect(await secretPrompt(page, "mysql").count()).toBe(0);
      expect(await treeNode(page, "mysql").getAttribute("data-state")).toBe("failed");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresOnAClosedPortAndPromptCancelled_whenModAltL_thenFormatsWithoutPromptOrError",
    async () => {
      const { app, page } = await launch(POSTGRES);
      await openConsoleOn(page, "pg");
      const prompt = secretPrompt(page, "pg");
      await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
      await prompt.waitFor({ state: "detached" });
      await expect.poll(() => enginePids(app), { timeout: LAUNCH_TIMEOUT_MS }).toHaveLength(0);
      const before = await treeNode(page, "pg").getAttribute("data-state");
      const alerts = await consoleAlert(page).allTextContents();

      await reformat(page);

      expect(await secretPrompt(page, "pg").count()).toBe(0);
      expect(await consoleAlert(page).allTextContents()).toEqual(alerts);
      expect(await page.getByText(REFORMAT_FAILED).count()).toBe(0);
      expect(await treeNode(page, "pg").getAttribute("data-state")).toBe(before);
      expect(await enginePids(app)).toHaveLength(1);
      await captureWindow(page, "07-postgres-closed-port-formatted");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
