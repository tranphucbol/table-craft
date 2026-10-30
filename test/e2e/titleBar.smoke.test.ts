/**
 * Plan 015's live test: the frameless window and its main toolbar, against SQLite, PostgreSQL and
 * MySQL from the `test/db/compose.yml` databases. Gated, because it needs a display, a fresh build
 * and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/015 bun run test:smoke:db
 *
 * `page.screenshot` captures the web contents alone, without the traffic lights main draws over
 * them (decision 034), so the macOS scenarios also capture the window itself with `screencapture`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chromium, type Browser, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  contentSize,
  DATABASES_ENABLED,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbar,
  mainToolbarButton,
  newProfile,
  openConsoleOn,
  paletteInput,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  sqlEditor,
  startStatement,
  toolWindow,
  waitUntilReady,
  windowTitle,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
  chooseTheme,
  chooseOption,
  optionValue,
} from "./harness.js";

const PLAN = "015";
const captureWindow = evidenceFor(PLAN);
const captureActivity = evidenceFor("127");
const EVIDENCE_DIR = process.env["TABLE_CRAFT_EVIDENCE_DIR"];
const MAC = process.platform === "darwin";

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const { password: PASSWORD, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;
const { password: _mysqlPassword, ...MYSQL_PLAIN } = MYSQL_CONFIG;
const SAVED: readonly SavedDatasource[] = [
  {
    id: "pg",
    name: "pg",
    pluginId: "postgres",
    color: "blue",
    config: { ...POSTGRES_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
  },
  {
    id: "mysql",
    name: "mysql",
    pluginId: "mysql",
    color: "green",
    config: { ...MYSQL_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
  },
  { id: "sqlite", name: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } },
];

const COMFORTABLE_BAR_PX = 40;
const COMPACT_BAR_PX = 32;
const TRAFFIC_LIGHT_INSET_PX = 76;
const GAP_PX = 8;
/** `windowChrome`'s positions: x 12, y (bar − 14) / 2. */
const LIGHTS_COMFORTABLE = { x: 12, y: 13 };
const LIGHTS_COMPACT = { x: 12, y: 9 };
/** The traffic lights' centre may sit this far off the bar's, in CSS pixels. */
const CENTRE_TOLERANCE_PX = 1.5;
const LIGHT_PANEL = "rgb(247, 248, 250)";
const DARK_PANEL = "rgb(43, 45, 48)";
const SLEEP_SQL = "SELECT pg_sleep(30)";
/** `formatDuration`'s seconds, which the capsule ticks once a second. */
const ELAPSED = /^\d+\.\d s$/;
const CANCEL_DEADLINE_MS = 10_000;
const TOTAL_SQL = "SELECT total FROM orders WHERE id = 1";
const UPDATE_SQL = "UPDATE orders SET total = total + 1 WHERE id = 1";
const FOCUSED_IN_EDITOR = "document.activeElement?.closest('.cm-editor') != null";
const FULL_SCREEN_TIMEOUT_MS = 10_000;
const RELAUNCH_TIMEOUT_MS = 30_000;
/** Chromium writes the port `--remote-debugging-port=0` chose here, in the profile directory. */
const DEVTOOLS_PORT_FILE = "DevToolsActivePort";
/** The shortest title bar macOS draws above a framed window's contents (32 px on macOS 27). */
const MAC_TITLE_BAR_PX = 28;

/** The few DOM members these checks read inside the page; the root program has no DOM lib. */
interface Style {
  getPropertyValue(name: string): string;
  readonly paddingLeft: string;
  readonly backgroundColor: string;
}

interface Styled {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: Styled): Style;
      readonly innerHeight: number;
      readonly outerHeight: number;
    };
  };
}

async function styleOf(locator: Locator): Promise<{ appRegion: string; paddingLeft: string; background: string }> {
  return locator.first().evaluate((element: Styled) => {
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return {
      appRegion: style.getPropertyValue("app-region") || style.getPropertyValue("-webkit-app-region"),
      paddingLeft: style.paddingLeft,
      background: style.backgroundColor,
    };
  });
}

/** How much taller the window is than its web contents: the OS title bar, or 0 without one. */
async function frameHeight(page: Page): Promise<number> {
  return page.locator("html").evaluate((element: Styled) => {
    const view = element.ownerDocument.defaultView;
    return view.outerHeight - view.innerHeight;
  });
}

async function toolbarHeight(page: Page): Promise<number> {
  return (await mainToolbar(page).boundingBox())?.height ?? 0;
}

async function trafficLights(app: ElectronApplication): Promise<{ x: number; y: number } | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window === undefined || process.platform !== "darwin" ? null : window.getWindowButtonPosition();
  });
}

function datasourceWidget(page: Page) {
  return mainToolbar(page).getByRole("button", { name: "Data source", exact: true });
}

function datasourceList(page: Page) {
  return page.getByRole("dialog", { name: "Switch data source", exact: true });
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function transactionBadge(page: Page) {
  return page.getByText("transaction open", { exact: true });
}

/** The title bar's capsule: what the active console is doing (plan 127). */
function activityCapsule(page: Page) {
  return mainToolbar(page).getByTestId("activity-capsule");
}

async function chooseTransactionMode(page: Page, mode: "auto" | "manual"): Promise<void> {
  const select = page.getByLabel("Transaction mode", { exact: true });
  await expect.poll(() => select.isEnabled()).toBe(true);
  await chooseOption(select, mode);
  await expect.poll(() => optionValue(select)).toBe(mode);
}

async function openAppearance(page: Page): Promise<void> {
  await mainToolbarButton(page, "Settings…").click();
  await settingsDialog(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await settingsDialog(page).getByRole("tab", { name: "Appearance", exact: true }).click();
}

async function closeSettings(page: Page): Promise<void> {
  await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settingsDialog(page).count()).toBe(0);
}

interface NativeCapture {
  /** The traffic lights' vertical centre in CSS pixels from the window's top. */
  readonly lightsCentre: number;
  /** The capture scaled to the window's CSS size, as PNG. */
  readonly png: Buffer;
}

/**
 * The window as the window server draws it, traffic lights included, by `screencapture -l` on its
 * window id. Null when it cannot capture (no screen-recording permission gives a blank image).
 */
async function captureNativeWindow(app: ElectronApplication): Promise<NativeCapture | null> {
  const windowId = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.focus();
    return window?.getMediaSourceId().split(":")[1] ?? "";
  });
  const directory = mkdtempSync(join(tmpdir(), "table-craft-capture-"));
  const path = join(directory, "window.png");
  try {
    execFileSync("screencapture", ["-x", "-o", `-l${windowId}`, path]);
  } catch {
    return null;
  }
  try {
    const measured = await app.evaluate(({ BrowserWindow, nativeImage }, file) => {
      const window = BrowserWindow.getAllWindows()[0];
      const image = nativeImage.createFromPath(file);
      const { width, height } = image.getSize();
      if (window === undefined || width === 0) return null;
      const scale = width / window.getBounds().width;
      const bitmap = image.toBitmap();
      const pixel = (x: number, y: number) => {
        const offset = (y * width + x) * 4;
        return [bitmap[offset + 2] ?? 0, bitmap[offset + 1] ?? 0, bitmap[offset] ?? 0];
      };
      // The close button's centre column; the toolbar's colour is read above the button, clear of
      // the window's rounded, transparent corner.
      const column = Math.round((12 + 7) * scale);
      const background = pixel(column, Math.round(2 * scale));
      const differs = (y: number) => {
        const [r = 0, g = 0, b = 0] = pixel(column, y);
        const [br = 0, bg = 0, bb = 0] = background;
        return Math.max(Math.abs(r - br), Math.abs(g - bg), Math.abs(b - bb)) > 24;
      };
      // The first run of rows unlike the toolbar is the close button; the border and the tab strip
      // below it differ too, so the run ends at the first row like the toolbar again.
      let top = Math.round(2 * scale);
      while (top < height && !differs(top)) top++;
      let bottom = top;
      while (bottom < height && differs(bottom)) bottom++;
      if (top === height) return null;
      const centre = (top + bottom) / 2 / scale;
      const scaled = image.resize({ width: window.getBounds().width, quality: "best" });
      return { lightsCentre: centre, png: scaled.toPNG().toString("base64") };
    }, path);
    return measured === null ? null : { lightsCentre: measured.lightsCentre, png: Buffer.from(measured.png, "base64") };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Where a native capture named `name` goes, under the same gate as `evidenceFor`; null when off. */
function nativeEvidencePath(name: string): string | null {
  if (EVIDENCE_DIR === undefined || EVIDENCE_DIR === "" || basename(EVIDENCE_DIR) !== PLAN) return null;
  const directory = resolve(EVIDENCE_DIR);
  mkdirSync(directory, { recursive: true });
  return join(directory, `${name}.png`);
}

function saveNativeEvidence(capture: NativeCapture, name: string): void {
  const path = nativeEvidencePath(name);
  if (path !== null) writeFileSync(path, capture.png);
}

interface Screened {
  readonly ownerDocument: {
    readonly defaultView: {
      readonly screenX: number;
      readonly screenY: number;
      readonly outerWidth: number;
      readonly outerHeight: number;
    };
  };
}

/**
 * Captures the screen under the page's window, OS title bar included, at CSS scale. For the app
 * `app.relaunch()` started, which Playwright reaches over CDP alone, so main cannot name its window.
 */
async function captureScreenUnder(page: Page, name: string): Promise<void> {
  const path = nativeEvidencePath(name);
  if (path === null) return;
  const bounds = await page.locator("html").evaluate((element: Screened) => {
    const view = element.ownerDocument.defaultView;
    return [view.screenX, view.screenY, view.outerWidth, view.outerHeight];
  });
  execFileSync("screencapture", ["-x", `-R${bounds.join(",")}`, path]);
  execFileSync("sips", ["--resampleWidth", String(bounds[2] ?? 0), path], { stdio: "ignore" });
}

async function expectLightsCentred(app: ElectronApplication, barPx: number, evidence?: string): Promise<void> {
  const capture = await captureNativeWindow(app);
  if (capture === null) return;
  if (evidence !== undefined) saveNativeEvidence(capture, evidence);
  expect(Math.abs(capture.lightsCentre - barPx / 2)).toBeLessThanOrEqual(CENTRE_TOLERANCE_PX);
}

describe.runIf(DATABASES_ENABLED)("frameless window live test", () => {
  let running: RunningApp | null = null;
  let relaunched: { browser: Browser; pid: number } | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    const second = relaunched;
    relaunched = null;
    if (second !== null) await stopRelaunched(second);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null, userDataDir?: string): Promise<RunningApp> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running;
  }

  it(
    "givenLaunch_whenShown_thenMainToolbarIsTheTitleBar",
    async () => {
      const { app, page } = await launch(sqlite());

      const box = await mainToolbar(page).boundingBox();
      expect(box?.y).toBe(0);
      expect(box?.height).toBe(COMFORTABLE_BAR_PX);
      expect(await frameHeight(page)).toBe(0);
      expect(await contentSize(app)).toEqual(EVIDENCE_WINDOW);
      await expect.poll(() => page.getByTestId("window-title").textContent()).toBe("console [lite]");
      await expect.poll(() => windowTitle(app)).toBe("console [lite] — TableCraft");
      for (const name of ["Run", "Search Everywhere", "Settings…"]) {
        expect(await mainToolbarButton(page, name).isVisible()).toBe(true);
      }
      const style = await styleOf(mainToolbar(page));
      if (MAC) {
        expect(style.paddingLeft).toBe(`${String(TRAFFIC_LIGHT_INSET_PX)}px`);
        expect(await mainToolbarButton(page, "Main Menu").count()).toBe(0);
      } else {
        expect(await mainToolbarButton(page, "Main Menu").isVisible()).toBe(true);
      }
      await captureWindow(page, "toolbar");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(MAC)(
    "givenMac_whenWindowCaptured_thenTrafficLightsCentredInTheToolbar",
    async () => {
      const { app } = await launch(sqlite());

      expect(await trafficLights(app)).toEqual(LIGHTS_COMFORTABLE);
      await expectLightsCentred(app, COMFORTABLE_BAR_PX, "chrome-macos");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresConsole_whenActive_thenWindowTitledByTabAndDatasource",
    async () => {
      const { app, page } = await launch(POSTGRES);

      await expect.poll(() => windowTitle(app)).toBe("console [pg] — TableCraft");
      expect(await page.getByTestId("window-title").textContent()).toBe("console [pg]");
      expect(await datasourceWidget(page).textContent()).toBe("pg");
      await captureWindow(page, "title");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenThreeDatasources_whenChosenInTheWidget_thenItsConsoleActivatesOrOneOpens",
    async () => {
      const userDataDir = newProfile();
      seedDatasources(userDataDir, SAVED);
      const { page } = await launch(null, userDataDir);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      for (const name of ["pg", "mysql"]) {
        await openConsoleOn(page, name);
        await answerSecretPrompt(page, name, PASSWORD);
        await waitUntilReady(page);
      }
      await editorTabs(page).first().click();
      await expect.poll(() => datasourceWidget(page).textContent()).toBe("pg");

      await datasourceWidget(page).click();
      const rows = datasourceList(page).getByRole("button");
      await expect
        .poll(() => rows.allTextContents())
        .toEqual(["pgconnected", "mysqlconnected", "sqlitedisconnected", "New Data Source…", "Data Sources…"]);
      await captureWindow(page, "widget");
      await rows.filter({ hasText: /^mysql/ }).click();

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console [mysql]");
      expect(await editorTabs(page).count()).toBe(2);
      expect(await datasourceWidget(page).textContent()).toBe("mysql");

      await datasourceWidget(page).click();
      await datasourceList(page)
        .getByRole("button")
        .filter({ hasText: /^sqlite/ })
        .click();
      await expect.poll(() => activeEditorTab(page).textContent()).toBe("console [sqlite]");
      expect(await editorTabs(page).count()).toBe(3);
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenCaretInEditor_whenToolbarRunClicked_thenStatementRunsAndCaretStays",
    async () => {
      const { page } = await launch(POSTGRES);
      await sqlEditor(page).fill("SELECT 1 AS one");
      await sqlEditor(page).click();
      await expect.poll(() => page.evaluate(FOCUSED_IN_EDITOR)).toBe(true);

      await mainToolbarButton(page, "Run").click();

      await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await gridText(page)).toEqual({ headers: ["one"], cells: ["1"] });
      expect(await page.evaluate(FOCUSED_IN_EDITOR)).toBe(true);
      await captureWindow(page, "run");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenSleepingStatement_whenToolbarCancelClicked_thenCancelled",
    async () => {
      const { page } = await launch(POSTGRES);
      const cancel = mainToolbarButton(page, "Cancel");

      await startStatement(page, SLEEP_SQL);
      await expect.poll(() => cancel.isEnabled()).toBe(true);
      expect(await activityCapsule(page).getAttribute("data-kind")).toBe("running");
      await expect.poll(() => activityCapsule(page).textContent()).toMatch(ELAPSED);
      await captureWindow(page, "cancel");
      await captureActivity(page, "capsule-running");
      const clickedAt = Date.now();
      await cancel.click();

      await consoleAlert(page).waitFor({ timeout: CANCEL_DEADLINE_MS });
      expect(Date.now() - clickedAt).toBeLessThan(CANCEL_DEADLINE_MS);
      expect(await consoleAlert(page).textContent()).toContain("The statement was cancelled.");
      await waitUntilReady(page);
      await expect.poll(() => cancel.count()).toBe(0);
      expect(await activityCapsule(page).count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenManualModeUpdate_whenToolbarRollbackClicked_thenRowUnchanged",
    async () => {
      const { page } = await launch(MYSQL);
      await runStatement(page, TOTAL_SQL);
      const before = (await gridText(page)).cells;
      await chooseTransactionMode(page, "manual");

      await startStatement(page, UPDATE_SQL);
      await expect.poll(() => transactionBadge(page).count()).toBe(1);
      await waitUntilReady(page);
      const rollback = mainToolbarButton(page, "Rollback");
      expect(await mainToolbarButton(page, "Commit").isEnabled()).toBe(true);
      expect(await activityCapsule(page).getAttribute("data-kind")).toBe("transaction");
      expect(await activityCapsule(page).textContent()).toBe("Tx open");
      await captureWindow(page, "rollback");
      await captureActivity(page, "capsule-transaction");
      await rollback.click();

      await expect.poll(() => transactionBadge(page).count()).toBe(0);
      expect(await activityCapsule(page).count()).toBe(0);
      expect(await rollback.count()).toBe(0);
      await runStatement(page, TOTAL_SQL);
      expect((await gridText(page)).cells).toEqual(before);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenToolbar_whenSearchEverywhereThenSettingsClicked_thenEachOpens",
    async () => {
      const { page } = await launch(sqlite());

      await mainToolbarButton(page, "Search Everywhere").click();
      await paletteInput(page, "Search Everywhere").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.keyboard.press("Escape");
      await expect.poll(() => paletteInput(page, "Search Everywhere").count()).toBe(0);

      await openAppearance(page);
      expect(await settingsDialog(page).getByLabel("Use system title bar", { exact: true }).isChecked()).toBe(false);
      await captureWindow(page, "settings");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLightThenCompact_whenChosen_thenToolbarRecoloursAndShrinksWithLightsCentred",
    async () => {
      const userDataDir = newProfile();
      seedSettings(userDataDir, { version: 1, appearance: { theme: "dark" } });
      const { app, page } = await launch(sqlite(), userDataDir);
      expect((await styleOf(mainToolbar(page))).background).toBe(DARK_PANEL);
      await openAppearance(page);

      await chooseTheme(page, "Light");
      await settingsDialog(page).getByRole("radio", { name: "Compact", exact: true }).check();
      await closeSettings(page);

      await expect.poll(() => toolbarHeight(page)).toBe(COMPACT_BAR_PX);
      expect((await styleOf(mainToolbar(page))).background).toBe(LIGHT_PANEL);
      if (MAC) {
        await expect.poll(() => trafficLights(app)).toEqual(LIGHTS_COMPACT);
        await expectLightsCentred(app, COMPACT_BAR_PX, "compact-light-native");
      }
      await captureWindow(page, "compact-light");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(MAC)(
    "givenFullScreen_whenEnteredAndLeft_thenInsetDropsAndReturns",
    async () => {
      const { app, page } = await launch(sqlite());
      const inset = async () => (await styleOf(mainToolbar(page))).paddingLeft;

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(true));
      await expect.poll(inset, { timeout: FULL_SCREEN_TIMEOUT_MS }).toBe(`${String(GAP_PX)}px`);
      await captureWindow(page, "fullscreen");

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setFullScreen(false));
      await expect.poll(inset, { timeout: FULL_SCREEN_TIMEOUT_MS }).toBe(`${String(TRAFFIC_LIGHT_INSET_PX)}px`);
      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen()), {
          timeout: FULL_SCREEN_TIMEOUT_MS,
        })
        .toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenToolbar_whenStyled_thenItDragsTheWindowAndItsControlsDoNot",
    async () => {
      const { page } = await launch(sqlite());

      expect((await styleOf(mainToolbar(page))).appRegion).toBe("drag");
      for (const control of [
        datasourceWidget(page),
        mainToolbarButton(page, "Run"),
        mainToolbarButton(page, "Search Everywhere"),
        mainToolbarButton(page, "Settings…"),
      ]) {
        expect((await styleOf(control)).appRegion).toBe("no-drag");
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSystemTitleBarChosen_whenRestartNowClicked_thenRelaunchedFramedWithTheSettingKept",
    async () => {
      const userDataDir = newProfile();
      // Playwright's page reports a light scheme whatever the host's; naming the theme makes the
      // title bar macOS draws agree with the page.
      seedSettings(userDataDir, { version: 1, appearance: { theme: "light" } });
      const first = await launch(sqlite(), userDataDir);
      await openAppearance(first.page);
      await settingsDialog(first.page).getByLabel("Use system title bar", { exact: true }).check();
      await expect
        .poll(() => readProfileFile(userDataDir, "settings.json"), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain('"systemTitleBar": true');
      const portFile = join(userDataDir, DEVTOOLS_PORT_FILE);
      rmSync(portFile, { force: true });
      const exited = new Promise<void>((settle) => first.app.process().once("exit", () => settle()));

      await settingsDialog(first.page).getByRole("button", { name: "Restart Now", exact: true }).click();
      await exited;
      running = null;
      relaunched = await connectRelaunched(portFile);

      const page = relaunched.browser.contexts()[0]?.pages()[0];
      if (page === undefined) throw new Error("The relaunched app has no window.");
      await mainToolbar(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const style = await styleOf(mainToolbar(page));
      expect(style.appRegion).not.toBe("drag");
      expect(style.paddingLeft).toBe(`${String(GAP_PX)}px`);
      expect(await mainToolbarButton(page, "Main Menu").count()).toBe(0);
      if (MAC) expect(await frameHeight(page)).toBeGreaterThanOrEqual(MAC_TITLE_BAR_PX);
      expect(readProfileFile(userDataDir, "settings.json")).toContain('"systemTitleBar": true');
      await waitUntilReady(page);
      await captureWindow(page, "system-title");
      if (MAC) {
        await page.bringToFront();
        await captureScreenUnder(page, "system-title-native");
      }
    },
    SCENARIO_TIMEOUT_MS * 2,
  );
});

/**
 * Attaches to the app `app.relaunch()` started: it inherits Playwright's `--remote-debugging-port=0`,
 * so it writes the port it chose to the profile, and Playwright can drive it over CDP.
 */
async function connectRelaunched(portFile: string): Promise<{ browser: Browser; pid: number }> {
  await expect.poll(() => existsSync(portFile), { timeout: RELAUNCH_TIMEOUT_MS }).toBe(true);
  const port = readFileSync(portFile, "utf8").split("\n")[0] ?? "";
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const session = await browser.newBrowserCDPSession();
  const info = (await session.send("SystemInfo.getProcessInfo")) as {
    processInfo: readonly { type: string; id: number }[];
  };
  const pid = info.processInfo.find((process) => process.type === "browser")?.id;
  if (pid === undefined) throw new Error("The relaunched app reports no browser process.");
  await expect.poll(() => browser.contexts()[0]?.pages().length ?? 0, { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);
  return { browser, pid };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopRelaunched({ browser, pid }: { browser: Browser; pid: number }): Promise<void> {
  await browser.close().catch(() => undefined);
  if (alive(pid)) process.kill(pid, "SIGTERM");
  try {
    await expect.poll(() => alive(pid), { timeout: LAUNCH_TIMEOUT_MS }).toBe(false);
  } catch {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
}
