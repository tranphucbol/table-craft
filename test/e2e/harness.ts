/**
 * Drives the built app under Playwright: launch it against a datasource, run statements, read the
 * grid, and save window screenshots as plan evidence (decision 016). Needs a fresh build of
 * `packages/desktop` and a display.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { expect } from "vitest";

export const SMOKE_ENABLED = process.env["TABLE_CRAFT_SMOKE"] === "1";
/** Set by `bun run test:smoke:db`, which starts the `test/db` containers first. */
export const DATABASES_ENABLED = SMOKE_ENABLED && process.env["TABLE_CRAFT_SMOKE_DATABASES"] === "1";
/** When set, `captureWindow` saves PNGs there; otherwise it does nothing. */
const EVIDENCE_DIR = process.env["TABLE_CRAFT_EVIDENCE_DIR"];
/** Set inside the headless box (plan 031): Linux under Xvfb, as root. */
const HEADLESS = process.env["TABLE_CRAFT_HEADLESS"] === "1";
/**
 * Chromium refuses to run as root with its sandbox, and with no desktop session it would pick the
 * plain-text password store, where `safeStorage` reports no encryption; the box runs gnome-keyring.
 */
const HEADLESS_FLAGS = ["--no-sandbox", "--password-store=gnome-libsecret"] as const;

/**
 * The packaged app's executable to drive instead of `dist/main/main.js` (plan 014), set by
 * `bun run test:smoke:packaged`; `LaunchOptions.executable` overrides it per launch.
 */
export const APP_EXECUTABLE = process.env["TABLE_CRAFT_APP_EXECUTABLE"] || undefined;

export const LAUNCH_TIMEOUT_MS = 30_000;
export const SCENARIO_TIMEOUT_MS = LAUNCH_TIMEOUT_MS * 2;
/** How long `app.close()` may take before `closeApp` kills the app; an unanswered dialog blocks it. */
export const CLOSE_DEADLINE_MS = 10_000;
/** An `afterEach` that closes the app and then cleans up a database needs room for both. */
export const CLOSE_HOOK_TIMEOUT_MS = CLOSE_DEADLINE_MS * 3;

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");
const DESKTOP_ROOT = join(REPOSITORY_ROOT, "packages/desktop");
const MAIN_ENTRY = join(DESKTOP_ROOT, "dist/main/main.js");
const DATASOURCE_ENV = "TABLE_CRAFT_DATASOURCE";
const USER_DATA_ENV = "TABLE_CRAFT_USER_DATA";
const USER_DATA_PREFIX = "table-craft-smoke-";

/** The window's default size, so evidence shows the whole shell (plan 003). */
export const EVIDENCE_WINDOW = { width: 1200, height: 800 } as const;

/** A `TABLE_CRAFT_DATASOURCE` value: the ephemeral datasource of decision 018, never saved. */
export interface Datasource {
  readonly id: string;
  readonly pluginId: string;
  readonly config: unknown;
}

/** The in-memory SQLite database most shell scenarios run against. */
export const SCRATCH: Datasource = { id: "scratch", pluginId: "sqlite", config: { path: ":memory:" } };

/** A datasource as `datasources.json` holds it (plan 004); no secret values. */
export interface SavedDatasource {
  readonly id: string;
  readonly name: string;
  readonly pluginId: string;
  readonly folder?: string | null;
  readonly color?: string | null;
  readonly readOnly?: boolean;
  readonly comment?: string;
  readonly keepAliveSeconds?: number;
  readonly statementTimeoutSeconds?: number;
  /** Plan 117's per-datasource MCP access; absent is off. */
  readonly agentAccess?: "off" | "read" | "ask";
  /** Plan 118's remembered product, a manifest brand id such as `tidb`. */
  readonly brand?: string;
  readonly config: Readonly<Record<string, string | number | boolean>>;
  readonly secretModes?: Readonly<Record<string, "forever" | "untilRestart" | "never">>;
  /** Plan 036's tunnel; its secrets are `ssh.password` and `ssh.passphrase` in `secretModes`. */
  readonly ssh?: {
    readonly enabled: boolean;
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly auth: "password" | "key" | "agent";
    readonly keyPath: string;
  };
}

const DATASOURCES_FILE = "datasources.json";
const DATASOURCES_VERSION = 1;
/** Chromium's flag that keeps `safeStorage` off the real macOS keychain (decision 020). */
const MOCK_KEYCHAIN_FLAG = "--use-mock-keychain";

/**
 * Writes `datasources.json` into a profile before launch. Secret values cannot be seeded: they
 * are encrypted by the launched app's own `safeStorage`, so scenarios type them into the dialog.
 */
export function seedDatasources(userDataDir: string, datasources: readonly SavedDatasource[]): void {
  const records = datasources.map((datasource) => ({
    folder: null,
    color: null,
    readOnly: false,
    comment: "",
    secretModes: {},
    ...datasource,
  }));
  writeFileSync(
    join(userDataDir, DATASOURCES_FILE),
    JSON.stringify({ version: DATASOURCES_VERSION, datasources: records }, null, 2),
  );
}

const SETTINGS_FILE = "settings.json";
const THEMES_DIRECTORY = "themes";

/** Writes `settings.json` into a profile before launch; a string is written as is, for a corrupt file. */
export function seedSettings(userDataDir: string, settings: object | string): void {
  const text = typeof settings === "string" ? settings : JSON.stringify(settings, null, 2);
  writeFileSync(join(userDataDir, SETTINGS_FILE), text);
}

/** Writes `<userData>/themes/<name>.json`; a string is written as is, for a broken theme. */
export function seedTheme(userDataDir: string, name: string, theme: object | string): void {
  const directory = join(userDataDir, THEMES_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), typeof theme === "string" ? theme : JSON.stringify(theme, null, 2));
}

const USER_PLUGINS_DIRECTORY = "plugins";

/** Writes a user plugin into `<userData>/plugins/<directory>/`, one file per `files` entry. */
export function seedPlugin(userDataDir: string, directory: string, files: Readonly<Record<string, string>>): void {
  const root = join(userDataDir, USER_PLUGINS_DIRECTORY, directory);
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
}

export function newProfile(): string {
  return mkdtempSync(join(tmpdir(), USER_DATA_PREFIX));
}

export interface RunningApp {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** The profile directory; pass it to `launchApp` again to relaunch with the same layout. */
  readonly userDataDir: string;
}

export interface LaunchOptions {
  /** Defaults to a fresh temporary directory, so nothing persists between launches. */
  readonly userDataDir?: string;
  /**
   * An app executable to launch with no entry argument, such as the packaged app; defaults to
   * `TABLE_CRAFT_APP_EXECUTABLE`, else the `electron` binary running `dist/main/main.js`.
   */
  readonly executable?: string;
  /** Variables added to the launch environment, such as plan 020's update overrides. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Use the login keychain instead of the mock one; only plan 020's live test sets it, to see what
   * an update does to stored passwords, and only with a build whose keychain item is its own.
   */
  readonly systemKeychain?: boolean;
}

export interface GridText {
  readonly headers: readonly string[];
  readonly cells: readonly string[];
}

/** The `electron` package exports the path of the binary it installed, downloading it on first use. */
function electronBinary(): string {
  return createRequire(join(DESKTOP_ROOT, "package.json"))("electron") as string;
}

/**
 * Launches the app with `datasource` as its ephemeral datasource, which opens a console on it;
 * null launches with only what the profile's `datasources.json` holds.
 */
export async function launchApp(
  datasource: Datasource | null = SCRATCH,
  options: LaunchOptions = {},
): Promise<RunningApp> {
  const env = { ...process.env } as Record<string, string>;
  delete env[DATASOURCE_ENV];
  if (datasource !== null) env[DATASOURCE_ENV] = JSON.stringify(datasource);
  const userDataDir = options.userDataDir ?? newProfile();
  env[USER_DATA_ENV] = userDataDir;
  Object.assign(env, options.env);
  const executable = options.executable ?? APP_EXECUTABLE;
  const entry = executable === undefined ? [MAIN_ENTRY] : [];
  const mockKeychain = process.platform === "darwin" && options.systemKeychain !== true;
  const flags = [...(mockKeychain ? [MOCK_KEYCHAIN_FLAG] : []), ...(HEADLESS ? HEADLESS_FLAGS : [])];
  const args = [...flags, ...entry];
  const app = await _electron.launch({ executablePath: executable ?? electronBinary(), args, env });
  const page = await app.firstWindow();
  return { app, page, userDataDir };
}

/**
 * Closes the app, and kills its process when `app.close()` has not finished within
 * `CLOSE_DEADLINE_MS`, so a dialog left open by a failed scenario never hangs the next one.
 */
export async function closeApp(app: ElectronApplication | null | undefined): Promise<void> {
  if (app === null || app === undefined) return;
  let timer: NodeJS.Timeout | undefined;
  const closed = app.close().then(
    () => true,
    () => true,
  );
  const late = new Promise<false>((settle) => {
    timer = setTimeout(() => settle(false), CLOSE_DEADLINE_MS);
  });
  const inTime = await Promise.race([closed, late]);
  clearTimeout(timer);
  if (!inTime) app.process().kill("SIGKILL");
}

export async function setWindowSize(app: ElectronApplication, size: { width: number; height: number }): Promise<void> {
  await app.evaluate(({ BrowserWindow }, { width, height }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(width, height);
  }, size);
}

/**
 * The window's content size; evidence must match `EVIDENCE_WINDOW`. With the main toolbar as the
 * title bar (decision 034) it is the whole window; with "Use system title bar" it excludes the OS's.
 */
export async function contentSize(app: ElectronApplication): Promise<{ width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => {
    const [width = 0, height = 0] = BrowserWindow.getAllWindows()[0]?.getContentSize() ?? [];
    return { width, height };
  });
}

/** The active console's own toolbar; Run, Cancel, Commit and Rollback are also in the main one. */
export function consoleToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Console toolbar", exact: true }).filter({ visible: true });
}

/** The window's title bar (decision 034). */
export function mainToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Main toolbar", exact: true });
}

export function mainToolbarButton(page: Page, name: string) {
  return mainToolbar(page).getByRole("button", { name, exact: true });
}

/** What the OS calls the window: Mission Control, the Dock menu, the taskbar. */
export async function windowTitle(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? "");
}

/** Exact, because other controls' names contain "Run" (e.g. a palette row "Run ⌘↩"). */
export function runButton(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: "Run", exact: true });
}

export function cancelButton(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: "Cancel", exact: true });
}

export function commitButton(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: "Commit", exact: true });
}

export function rollbackButton(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: "Rollback", exact: true });
}

/** Resolves once the session is open and Run is enabled. */
export async function waitUntilReady(page: Page): Promise<void> {
  const run = runButton(page);
  await expect.poll(() => run.isEnabled(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
}

export function runAllButton(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: "Run All", exact: true });
}

/** The few DOM members `iconSpin` touches; the e2e program is compiled without the DOM lib. */
interface StyledElement {
  readonly ownerDocument: {
    readonly defaultView: {
      getComputedStyle(element: StyledElement): {
        readonly animationName: string;
        readonly animationPlayState: string;
        readonly opacity: string;
      };
    };
  };
}

/** The CSS animation on a button's icon: `spin` while it is busy (plan 112), `none` for its own glyph. */
export async function iconSpin(button: Locator): Promise<{ readonly name: string; readonly state: string }> {
  return button.locator("svg").evaluate((element: StyledElement) => {
    const computed = element.ownerDocument.defaultView.getComputedStyle(element);
    return { name: computed.animationName, state: computed.animationPlayState };
  });
}

/** The computed opacity of `element`: `"1"` for a busy button, which is disabled but not dimmed. */
export async function computedOpacity(element: Locator): Promise<string> {
  return element.evaluate((node: StyledElement) => node.ownerDocument.defaultView.getComputedStyle(node).opacity);
}

/** Resolves once `button` shows its busy spinner: `aria-busy` and a spinning icon (plan 112). */
export async function waitUntilSpinning(button: Locator): Promise<void> {
  await expect.poll(() => button.getAttribute("aria-busy"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("true");
  expect((await iconSpin(button)).name).toBe("spin");
}

/** Asserts `button` is back to its own glyph: no `aria-busy`, no spin. */
export async function expectNotSpinning(button: Locator): Promise<void> {
  expect(await button.getAttribute("aria-busy")).toBeNull();
  expect((await iconSpin(button)).name).toBe("none");
}

/** The console's CodeMirror editor, by the accessible name its content carries. */
export function sqlEditor(page: Page) {
  return page.getByRole("textbox", { name: "SQL console", exact: true });
}

/**
 * Replaces the console's text with `sql` and presses Run All, without waiting for the answer. Run
 * All, because Run takes only the statement at the caret (plan 006).
 */
export async function startStatement(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await runAllButton(page).click();
}

/** Runs a row-returning or failing `sql` and resolves once its grid or its error is shown. */
export async function runStatement(page: Page, sql: string): Promise<void> {
  await startStatement(page, sql);
  await page.getByRole("columnheader").or(consoleAlert(page)).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await waitUntilReady(page);
}

export async function gridText(page: Page): Promise<GridText> {
  return {
    headers: await page.getByRole("columnheader").allTextContents(),
    cells: await page.getByRole("gridcell").allTextContents(),
  };
}

interface CellSnapshot {
  readonly row: number;
  readonly text: string;
}

/** The part of a DOM element `columnSnapshot` reads; the root program has no DOM lib. */
interface CellElement {
  getAttribute(name: string): string | null;
  readonly textContent: string | null;
}

/**
 * The texts of `cells`, a grid's cells of one column, ordered by `data-row`. Read in one snapshot:
 * listing them and then reading each races a re-render, and a cell gone in between makes its read
 * wait out Playwright's 30 s default before the poll retries (found live, plan 014).
 */
export async function columnSnapshot(cells: Locator): Promise<string[]> {
  const entries = await cells.evaluateAll((elements: readonly CellElement[]): CellSnapshot[] =>
    elements.map((element) => ({
      row: Number(element.getAttribute("data-row")),
      text: element.textContent ?? "",
    })),
  );
  return entries.sort((left, right) => left.row - right.row).map((entry) => entry.text);
}

export function exportDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByTestId("export-file") });
}

/**
 * Answers the Export Data dialog (plan 018): picks `format` by its label when given, types `path`
 * and starts the export. The task then runs in the background; wait on Output or Services.
 */
export async function answerExportDialog(page: Page, path: string, format?: string): Promise<void> {
  const dialog = exportDialog(page);
  await dialog.waitFor();
  if (format !== undefined) await dialog.getByRole("radio", { name: format, exact: true }).click();
  await dialog.getByTestId("export-file").fill(path);
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

export function consoleAlert(page: Page) {
  return page.getByRole("alert");
}

/** A tool window by title, e.g. "Database"; absent from the page while hidden. */
export function toolWindow(page: Page, title: string) {
  return page.getByRole("region", { name: title, exact: true });
}

export function editorTabs(page: Page) {
  return page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab");
}

export function activeEditorTab(page: Page) {
  return page.getByRole("tablist", { name: "Editor tabs" }).getByRole("tab", { selected: true });
}

export function datasourceStatus(page: Page) {
  return page.getByTestId("status-datasource");
}

/** Presses a chord with the platform's Mod (⌘ on macOS, Ctrl elsewhere), e.g. `pressChord(page, "Shift+A")`. */
export async function pressChord(page: Page, keys: string): Promise<void> {
  await page.keyboard.press(`ControlOrMeta+${keys}`);
}

/** Two Shift taps, well inside the double-tap window. */
export async function pressDoubleShift(page: Page): Promise<void> {
  await page.keyboard.press("Shift");
  await page.keyboard.press("Shift");
}

export function paletteInput(page: Page, mode: "Find Action" | "Search Everywhere") {
  return page.getByRole("textbox", { name: mode, exact: true });
}

export function paletteRows(page: Page) {
  return page.getByRole("listbox", { name: "Results" }).getByRole("option");
}

/** Opens Find Action, types `query` and runs the top result. */
export async function findAction(page: Page, query: string): Promise<void> {
  await pressChord(page, "Shift+A");
  await paletteInput(page, "Find Action").fill(query);
  await page.keyboard.press("Enter");
}

/** The Data Sources dialog (plan 004). */
export function dataSourcesDialog(page: Page) {
  return page.getByRole("dialog", { name: "Data Sources" });
}

/** A datasource or folder row in the Database tool window, by its visible name. */
export function treeNode(page: Page, name: string) {
  return toolWindow(page, "Database")
    .getByRole("treeitem")
    .filter({ has: page.getByText(name, { exact: true }) });
}

export interface DatasourceForm {
  /** The plugin's display name in the kind picker, e.g. "PostgreSQL". */
  readonly kind: string;
  readonly name: string;
  /** Plain connection fields by label, e.g. `{ Host: "127.0.0.1", Port: "55432" }`. */
  readonly fields: Readonly<Record<string, string>>;
  readonly password?: string;
  readonly passwordMode?: "forever" | "untilRestart" | "never";
  readonly folder?: string;
}

/** Opens the Data Sources dialog from the Database toolbar, picks `form.kind` and fills the form. */
export async function fillNewDatasource(page: Page, form: DatasourceForm): Promise<void> {
  await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
  const dialog = dataSourcesDialog(page);
  await dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: form.kind }).click();
  await dialog.getByLabel("Name", { exact: true }).fill(form.name);
  if (form.folder !== undefined) await dialog.getByLabel("Folder", { exact: true }).fill(form.folder);
  for (const [label, value] of Object.entries(form.fields)) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  if (form.password !== undefined) await dialog.getByLabel("Password", { exact: true }).fill(form.password);
  if (form.passwordMode !== undefined) {
    await dialog.getByLabel("Save password", { exact: true }).selectOption(form.passwordMode);
  }
}

/** The Test Connection outcome once it has arrived. */
export async function testConnection(page: Page): Promise<{ ok: boolean; text: string }> {
  const dialog = dataSourcesDialog(page);
  await dialog.getByRole("button", { name: "Test Connection" }).click();
  const result = dialog.getByTestId("test-result");
  await result.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return { ok: (await result.getAttribute("data-ok")) === "true", text: (await result.textContent()) ?? "" };
}

/** The password prompt a connect raises when no secret is stored (decision 020). */
export function secretPrompt(page: Page, datasourceName: string) {
  return page.getByRole("dialog", { name: `Connect to ${datasourceName}` });
}

export async function answerSecretPrompt(page: Page, datasourceName: string, password: string): Promise<void> {
  const prompt = secretPrompt(page, datasourceName);
  await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await prompt.getByLabel("Password", { exact: true }).fill(password);
  await prompt.getByRole("button", { name: "Connect", exact: true }).click();
  await prompt.waitFor({ state: "detached" });
}

/** Selects the datasource's tree node and opens a console on it (`Mod+Shift+L`). */
export async function openConsoleOn(page: Page, datasourceName: string): Promise<void> {
  await treeNode(page, datasourceName).click();
  await pressChord(page, "Shift+L");
}

const ENGINE_SERVICE_PREFIX = "table-craft-engine-";

/** The pids of the engine utility processes main has running, read from main itself. */
export async function enginePids(app: ElectronApplication): Promise<readonly number[]> {
  return app.evaluate(
    ({ app: electronApp }, prefix) =>
      electronApp
        .getAppMetrics()
        .filter((metric) => metric.name?.startsWith(prefix) === true)
        .map((metric) => metric.pid),
    ENGINE_SERVICE_PREFIX,
  );
}

/** Settings → Appearance's theme dropdown (decision 065); the Settings dialog must be open. */
export function themePickerTrigger(page: Page) {
  return page.getByTestId("theme-picker-trigger");
}

export function themePickerOption(page: Page, name: string) {
  return page.getByTestId("theme-picker").getByRole("option", { name, exact: true });
}

export async function openThemePicker(page: Page): Promise<void> {
  if ((await themePickerTrigger(page).getAttribute("aria-expanded")) !== "true") await themePickerTrigger(page).click();
  await page.getByTestId("theme-picker").waitFor();
}

/** Opens the dropdown, picks `name` and waits for the trigger to show it. */
export async function chooseTheme(page: Page, name: string): Promise<void> {
  await openThemePicker(page);
  await themePickerOption(page, name).click();
  await expect.poll(() => themePickerTrigger(page).getAttribute("aria-label")).toBe(`Theme: ${name}`);
}

export function readProfileFile(userDataDir: string, file: string): string | null {
  const path = join(userDataDir, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export type CaptureWindow = (page: Page, name: string) => Promise<void>;

/**
 * A capture for plan `plan`'s live test: it saves the window as `<EVIDENCE_DIR>/<name>.png` at CSS
 * pixel scale, but only when `EVIDENCE_DIR` is that plan's folder (`docs/evidence/<plan>`), so
 * regenerating one plan's evidence never writes another plan's screenshots into it.
 */
export function evidenceFor(plan: string): CaptureWindow {
  return async (page, name) => {
    if (EVIDENCE_DIR === undefined || EVIDENCE_DIR === "" || basename(EVIDENCE_DIR) !== plan) return;
    const directory = resolve(REPOSITORY_ROOT, EVIDENCE_DIR);
    mkdirSync(directory, { recursive: true });
    await page.screenshot({ path: join(directory, `${name}.png`), scale: "css" });
  };
}

export type WriteEvidence = (file: string, text: string) => void;

/** Like `evidenceFor`, for text evidence such as a log excerpt: writes `<EVIDENCE_DIR>/<file>`. */
export function evidenceTextFor(plan: string): WriteEvidence {
  return (file, text) => {
    if (EVIDENCE_DIR === undefined || EVIDENCE_DIR === "" || basename(EVIDENCE_DIR) !== plan) return;
    const directory = resolve(REPOSITORY_ROOT, EVIDENCE_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, file), text);
  };
}
