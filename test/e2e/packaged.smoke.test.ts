/**
 * Plan 014's packaged-app suite: the unpacked app electron-builder produced, not the development
 * build, so the bundles in `app.asar`, the plugins in `<resources>/plugins` and the bundled drivers
 * are what run. Plan 015 adds the title bar check CI runs on every platform, so Windows and Linux
 * show the main-menu button and the caption-button overlay; plan 036 connects through the compose
 * SSH bastion once, since ssh2 is inlined with its native modules stubbed. PostgreSQL is not in the
 * bundle (plan 057), so its scenarios seed the built plugin into the profile's managed folder. Runs only when
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
import {
  MYSQL_CONFIG,
  POSTGRES_BEHIND_BASTION,
  POSTGRES_CONFIG,
  SSH_BASTION,
  WITHOUT_POSTGRES,
} from "../support/databases.js";
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
  secretPrompt,
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
import { seedManagedPlugin } from "./pluginFixtures.js";
import { DAILY_LOOP_STEPS, dailyLoop, stubSaveDialog } from "./workflows.js";

const captureWindow = evidenceFor("014");
const captureTunnel = evidenceFor("036");
const LOOP_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 3;
/** One picker row per brand (plan 118): the MySQL plugin names MySQL, MariaDB and TiDB. */
const BUILT_IN_KINDS = ["MariaDB", "MySQL", "SQLite", "TiDB"];
/** Downloaded on demand (plans 057 and 058): absent from the bundle, offered in the picker. */
const DOWNLOADABLE_KINDS = ["oracle", "postgres", "redis", "mssql"];
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
const SAVED_POSTGRES_BEHIND_BASTION: SavedDatasource = {
  id: "pg-ssh",
  name: "pg-ssh",
  pluginId: "postgres",
  config: { ...POSTGRES_PLAIN, ...POSTGRES_BEHIND_BASTION, sslMode: "disable" },
  secretModes: { password: "untilRestart", "ssh.password": "untilRestart" },
  ssh: {
    enabled: true,
    host: SSH_BASTION.host,
    port: SSH_BASTION.port,
    user: SSH_BASTION.user,
    auth: "password",
    keyPath: "",
  },
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
    if (datasources.some((saved) => saved.pluginId === "postgres")) seedManagedPlugin(userDataDir, "postgres");
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running;
  }

  it(
    "givenPackagedApp_whenLaunched_thenBuiltInPluginsAvailableAndOptionalOnesOfferedForDownload",
    async () => {
      const { app, page } = await launchSaved([]);
      expect(await app.evaluate(({ app: electron }) => electron.isPackaged)).toBe(true);

      await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();

      const list = dataSourcesDialog(page).getByRole("list", { name: "Database kinds" });
      const kinds = list.locator("button:not([data-download])");
      await expect.poll(() => kinds.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(BUILT_IN_KINDS.length);
      expect([...(await kinds.allTextContents())].sort()).toEqual(BUILT_IN_KINDS);
      for (const kind of await kinds.all()) expect(await kind.isEnabled()).toBe(true);
      const downloads = list.locator("button[data-download]");
      const offered = await Promise.all((await downloads.all()).map((button) => button.getAttribute("data-download")));
      expect(offered).toEqual(DOWNLOADABLE_KINDS);
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

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
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

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenPackagedApp_whenPostgresBehindSshBastion_thenSelectOneReturnsThroughTunnel",
    async () => {
      const saved = SAVED_POSTGRES_BEHIND_BASTION;
      const { page } = await launchSaved([saved]);
      await openConsoleOn(page, saved.name);

      const prompt = secretPrompt(page, saved.name);
      await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await prompt.getByLabel("Password", { exact: true }).fill(PASSWORD);
      await prompt.getByLabel("SSH password", { exact: true }).fill(SSH_BASTION.password);
      await prompt.getByRole("button", { name: "Connect", exact: true }).click();
      const hostKey = page.getByRole("dialog", { name: "Unknown SSH host key" });
      await hostKey.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await hostKey.getByTestId("host-key-fingerprint").textContent()).toBe(SSH_BASTION.fingerprint);
      await hostKey.getByRole("button", { name: "Trust", exact: true }).click();
      await waitUntilReady(page);

      await runStatement(page, "SELECT 1 AS one");

      expect(await gridText(page)).toEqual({ headers: ["one"], cells: ["1"] });
      await captureTunnel(page, "13-packaged-select-through-tunnel");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
