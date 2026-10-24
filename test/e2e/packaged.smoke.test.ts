/**
 * Plan 014's packaged-app suite: the unpacked app electron-builder produced, not the development
 * build, so the bundles in `app.asar`, the plugins in `<resources>/plugins` and the bundled drivers
 * are what run. Plan 015 adds the title bar check CI runs on every platform, so Windows and Linux
 * show the main-menu button and the caption-button overlay. Runs only when
 * `TABLE_CRAFT_APP_EXECUTABLE` names that app:
 *
 *   bun run test:smoke:packaged        # SQLite only, as CI runs it
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/014 bun run test:smoke:packaged:db
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { appVersion, systemGit } from "../../packages/desktop/scripts/version.js";
import { MYSQL_CONFIG, POSTGRES_CONFIG } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  APP_EXECUTABLE,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbar,
  mainToolbarButton,
  newProfile,
  openConsoleOn,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  treeNode,
  waitUntilReady,
  chooseTheme,
  themePickerTrigger,
} from "./harness.js";
import type { RunningApp, SavedDatasource } from "./harness.js";
import { DAILY_LOOP_STEPS, dailyLoop, stubSaveDialog } from "./workflows.js";

const captureWindow = evidenceFor("014");
const LOOP_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 3;
const BUILT_IN_KINDS = ["MySQL", "PostgreSQL", "SQLite"];
/** Not the default on a light-mode host, so the relaunched window shows it was kept. */
const CHOSEN_THEME = "Dark";
const CHOSEN_THEME_ID = "dark";
const PASSWORD = POSTGRES_CONFIG.password;

/** `windowChrome`'s position for the comfortable density's 40 px toolbar (plan 015). */
const MAC_TRAFFIC_LIGHTS = { x: 12, y: 13 };

interface TitleBarArea {
  readonly visible: boolean;
  readonly x: number;
  readonly width: number;
  readonly windowWidth: number;
}

/** A page expression, because this program has no DOM lib: where Windows and Linux leave the toolbar. */
const TITLE_BAR_AREA = `(() => {
  const overlay = navigator.windowControlsOverlay;
  const rect = overlay?.getTitlebarAreaRect();
  return { visible: overlay?.visible ?? false, x: rect?.x ?? 0, width: rect?.width ?? 0, windowWidth: innerWidth };
})()`;

const { password: _postgresPassword, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;
const { password: _mysqlPassword, ...MYSQL_PLAIN } = MYSQL_CONFIG;

const SAVED_POSTGRES: SavedDatasource = {
  id: "pg",
  name: "pg",
  pluginId: "postgres",
  config: { ...POSTGRES_PLAIN, sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};
const SAVED_MYSQL: SavedDatasource = {
  id: "mysql",
  name: "mysql",
  pluginId: "mysql",
  config: { ...MYSQL_PLAIN, sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};

function savedSqlite(): SavedDatasource {
  return { id: "sqlite", name: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

async function openAppearance(page: Page): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
}

/** The theme `settings.json` holds on disk, or null before the first save. */
function savedTheme(userDataDir: string): string | null {
  const text = readProfileFile(userDataDir, "settings.json");
  return text === null ? null : (JSON.parse(text) as { appearance: { theme: string } }).appearance.theme;
}

describe.runIf(SMOKE_ENABLED && APP_EXECUTABLE !== undefined)("packaged app", () => {
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

  async function launchSaved(datasources: readonly SavedDatasource[], userDataDir = newProfile()): Promise<RunningApp> {
    seedDatasources(userDataDir, datasources);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running;
  }

  it(
    "givenPackagedApp_whenLaunched_thenAllBuiltInPluginsAvailable",
    async () => {
      const { app, page } = await launchSaved([]);
      expect(await app.evaluate(({ app: electron }) => electron.isPackaged)).toBe(true);

      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();

      const kinds = dataSourcesDialog(page).getByRole("list", { name: "Database kinds" }).getByRole("button");
      await expect.poll(() => kinds.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(BUILT_IN_KINDS.length);
      expect([...(await kinds.allTextContents())].sort()).toEqual(BUILT_IN_KINDS);
      for (const kind of await kinds.all()) expect(await kind.isEnabled()).toBe(true);
      await captureWindow(page, "packaged-plugins");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPackagedApp_whenLaunched_thenVersionIsTheBuiltOne",
    async () => {
      const version = appVersion(systemGit);
      const { app, page } = await launchSaved([]);

      expect(await app.evaluate(({ app: electron }) => electron.getVersion())).toBe(version);
      await findAction(page, "About TableCraft");
      const about = page.getByRole("dialog").filter({ hasText: `TableCraft ${version}` });
      await about.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await about.textContent()).toMatch(/Electron \d+\.\d+\.\d+ · Chromium \d+/);
      await captureWindow(page, "packaged-about");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenPackagedApp_whenDailyLoopOnSqlite_thenEveryStepSucceeds",
    async () => {
      const saved = savedSqlite();
      const { app, page } = await launchSaved([saved]);
      const folder = mkdtempSync(join(tmpdir(), "table-craft-loop-"));
      scratch.push(folder);
      const exportPath = join(folder, "customers.csv");
      await stubSaveDialog(app, exportPath);

      const steps = await dailyLoop(page, { name: saved.name, namespace: "main", exportPath });

      expect(steps).toEqual(DAILY_LOOP_STEPS);
      await captureWindow(page, "packaged-loop");
    },
    LOOP_TIMEOUT_MS,
  );

  it(
    "givenPackagedApp_whenSettingChangedAndRelaunched_thenKept",
    async () => {
      const userDataDir = newProfile();
      const saved = savedSqlite();
      const first = await launchSaved([saved], userDataDir);
      await openAppearance(first.page);
      await chooseTheme(first.page, CHOSEN_THEME);
      // The option checks before main has written settings.json, and closing kills the app: on
      // the Windows runner the write lost that race (found live, plan 014).
      await expect.poll(() => savedTheme(userDataDir), { timeout: LAUNCH_TIMEOUT_MS }).toBe(CHOSEN_THEME_ID);
      await closeRunning();

      const { page } = await launchSaved([saved], userDataDir);
      await openConsoleOn(page, saved.name);
      await waitUntilReady(page);
      await openAppearance(page);

      await expect.poll(() => themePickerTrigger(page).getAttribute("aria-label")).toBe(`Theme: ${CHOSEN_THEME}`);
      await captureWindow(page, "packaged-relaunch");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenPackagedApp_whenLaunched_thenMainToolbarIsTheTitleBarBesideTheNativeControls",
    async () => {
      const { app, page } = await launchSaved([savedSqlite()]);
      await mainToolbar(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      if (process.platform === "darwin") {
        const lights = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
        );
        expect(lights).toEqual(MAC_TRAFFIC_LIGHTS);
        expect(await mainToolbarButton(page, "Main Menu").count()).toBe(0);
        return;
      }
      await mainToolbarButton(page, "Main Menu").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const overlay = await page.evaluate<TitleBarArea>(TITLE_BAR_AREA);
      expect(overlay.visible).toBe(true);
      expect(overlay.width).toBeLessThan(overlay.windowWidth);
      const settings = await mainToolbarButton(page, "Settings…").boundingBox();
      expect((settings?.x ?? Infinity) + (settings?.width ?? 0)).toBeLessThanOrEqual(overlay.x + overlay.width);
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMenuBarVisible())).toBe(
        false,
      );
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenPackagedApp_whenPostgresAndMysqlConnected_thenSelectOneReturns",
    async () => {
      const { page } = await launchSaved([SAVED_POSTGRES, SAVED_MYSQL]);

      for (const saved of [SAVED_POSTGRES, SAVED_MYSQL]) {
        await openConsoleOn(page, saved.name);
        await answerSecretPrompt(page, saved.name, PASSWORD);
        await waitUntilReady(page);
        await expect.poll(() => activeEditorTab(page).textContent()).toBe(`console [${saved.name}]`);
        await expect.poll(() => treeNode(page, saved.name).getAttribute("data-state")).toBe("connected");

        await runStatement(page, "SELECT 1 AS one");

        expect(await gridText(page)).toEqual({ headers: ["one"], cells: ["1"] });
      }
      await captureWindow(page, "packaged-drivers");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
