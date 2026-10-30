/**
 * What the README media suites share (plan 016, decision 036; plan 061): the demo datasources, the
 * scene runner that records one GIF, and the locators and steps more than one scene uses.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { POSTGRES_CONFIG } from "../support/databases.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  type SavedDatasource,
  seedDatasources,
  seedSettings,
  setWindowSize,
  EVIDENCE_WINDOW,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  waitUntilReady,
} from "../e2e/harness.js";
import {
  type Gif,
  GIF_MAX_BYTES,
  GIFS_MAX_BYTES,
  MEDIA_DIRECTORY,
  type Recording,
  requireFfmpeg,
  startRecording,
} from "./recorder.js";
import { clickAtVisibly, clickVisibly, END_PAUSE_MS, pause, pressVisibly, typeSlowly } from "./pace.js";
import { buildShopSqlite, loadShopPostgres, SHOP_DATABASE } from "./shop.js";

const README_MEDIA_ENABLED = SMOKE_ENABLED && process.env["TABLE_CRAFT_README_MEDIA"] === "1";
/** `README_MEDIA=explain,grid` re-records only those GIFs; unset records all of them. */
const ONLY = (process.env["README_MEDIA"] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");

const SCENE_TIMEOUT_MS = 120_000;
/** Long enough to read a result or a dialog before the scene moves on. */
export const READ_PAUSE_MS = 1_500;
/** Plan 016 decision 20: a GIF a reader watches through, not a screencast to scrub. */
const MAX_GIF_SECONDS = 25;
const GIF_EXTENSION = ".gif";

export const SHOP = "shop";
const SHOP_FILE = "shop.db";
export const NAMESPACE = "public";
export const TABLES_GROUP = "tables 4";
export const PASSWORD = POSTGRES_CONFIG.password;
export const EXPORT_DIRECTORY = "/tmp/table-craft-readme";

export const SHOP_POSTGRES: SavedDatasource = {
  id: "shop",
  name: SHOP,
  pluginId: "postgres",
  color: "green",
  config: {
    host: POSTGRES_CONFIG.host,
    port: POSTGRES_CONFIG.port,
    database: SHOP_DATABASE,
    user: POSTGRES_CONFIG.user,
    sslMode: "disable",
  },
  secretModes: { password: "untilRestart" },
};

function shopSqlite(path: string): SavedDatasource {
  return { id: "shop-db", name: SHOP_FILE, pluginId: "sqlite", color: "blue", config: { path } };
}

/**
 * The GIFs pin Dark (plan 016, Consequences) and full motion (plan 061 decision 10), whatever the
 * recording Mac's appearance and accessibility settings are.
 */
const APPEARANCE = { version: 1, appearance: { theme: "dark", motion: "full" } };

export interface Scene {
  readonly app: ElectronApplication;
  readonly page: Page;
}

const recorded: Gif[] = [];
let sqliteDirectory = "";
let running: ElectronApplication | null = null;
let teardown: (() => Promise<void>) | null = null;

export interface SceneScript {
  /** Off camera: connect, open a console, fill text the reader need not watch typed. */
  readonly setup: (scene: Scene) => Promise<void>;
  /** On camera. */
  readonly run: (scene: Scene) => Promise<void>;
  /** Only the SQLite file is saved, for the scene that adds `shop` itself. */
  readonly withoutShop?: boolean;
  /** Saved after `shop` and `shop.db`, for the scenes about another database. */
  readonly alsoSaved?: readonly SavedDatasource[];
  /** What `shop` is saved with on top of `SHOP_POSTGRES`, such as its agent access. */
  readonly shop?: Partial<SavedDatasource>;
  /** Before launch, ahead of `settings` and `env`: what the app must find running, such as a server. */
  readonly prepare?: () => Promise<void>;
  /** Settings seeded beside the pinned appearance, such as `mcp`. */
  readonly settings?: () => Record<string, unknown>;
  /** Variables the app launches with on top of the harness's, such as a fixture `HOME`. */
  readonly env?: () => Record<string, string>;
  /** Runs once the scene ends, passed or failed, before the app closes: what `setup` opened outside it. */
  readonly teardown?: () => Promise<void>;
  /** The longest any frame is held in the GIF, for a scene that waits on something outside the app. */
  readonly maxFrameSeconds?: number;
  /** For a scene that waits on something slower than the app, such as a model. */
  readonly timeoutMs?: number;
  /** Records more than the app's window, such as a terminal beside it; the window alone otherwise. */
  readonly record?: (scene: Scene) => Promise<Recording>;
}

export function scene(name: string, script: SceneScript) {
  const { setup, run, withoutShop = false, alsoSaved = [], shop = {}, settings, env, maxFrameSeconds } = script;
  const skipped = ONLY.length > 0 && !ONLY.includes(name);
  it.skipIf(skipped)(
    name,
    async () => {
      loadShopPostgres();
      teardown = script.teardown ?? null;
      await script.prepare?.();
      const profile = newProfile();
      const sqlite = shopSqlite(join(sqliteDirectory, SHOP_FILE));
      const saved = { ...SHOP_POSTGRES, ...shop };
      seedDatasources(profile, [...(withoutShop ? [sqlite] : [saved, sqlite]), ...alsoSaved]);
      seedSettings(profile, { ...APPEARANCE, ...settings?.() });
      const { app, page } = await launchApp(null, { userDataDir: profile, env: env?.() ?? {} });
      running = app;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const recording = await failureShot(page, name, async () => {
        await setup({ app, page });
        await pause(page);
        const started = await (script.record?.({ app, page }) ?? startRecording(app, page));
        await run({ app, page });
        return started;
      });
      await pause(page, END_PAUSE_MS);
      const gif = await recording.stop(name, maxFrameSeconds);
      recorded.push(gif);
      expect(statSync(gif.path).size).toBe(gif.bytes);
      expect(gif.bytes, `${name}.gif is ${String(gif.bytes)} bytes`).toBeLessThanOrEqual(GIF_MAX_BYTES);
      expect(gif.seconds, `${name}.gif lasts ${gif.seconds.toFixed(1)} s`).toBeLessThanOrEqual(MAX_GIF_SECONDS);
    },
    script.timeoutMs ?? SCENE_TIMEOUT_MS,
  );
}

async function failureShot<T>(page: Page, name: string, steps: () => Promise<T>): Promise<T> {
  try {
    return await steps();
  } catch (error) {
    await page.screenshot({ path: join(tmpdir(), `table-craft-readme-${name}-failure.png`) });
    throw error;
  }
}

/** The bytes of every GIF in `docs/media`, the README's whole budget whichever suite wrote them. */
function mediaBytes(): number {
  return readdirSync(MEDIA_DIRECTORY)
    .filter((file) => file.endsWith(GIF_EXTENSION))
    .reduce((sum, file) => sum + statSync(join(MEDIA_DIRECTORY, file)).size, 0);
}

/** One media suite: its scenes record only under `readme:media`, each in a fresh app and profile. */
export function mediaSuite(title: string, scenes: () => void): void {
  describe.runIf(README_MEDIA_ENABLED)(title, () => {
    beforeAll(() => {
      requireFfmpeg();
      sqliteDirectory = mkdtempSync(join(tmpdir(), "table-craft-readme-shop-"));
      buildShopSqlite(sqliteDirectory);
      mkdirSync(EXPORT_DIRECTORY, { recursive: true });
    });

    afterEach(async () => {
      const ending = teardown;
      teardown = null;
      try {
        await ending?.();
      } finally {
        await closeApp(running);
        running = null;
      }
    }, CLOSE_HOOK_TIMEOUT_MS);

    afterAll(() => {
      rmSync(sqliteDirectory, { recursive: true, force: true });
      rmSync(EXPORT_DIRECTORY, { recursive: true, force: true });
      if (ONLY.length > 0 || recorded.length === 0) return;
      const total = mediaBytes();
      expect(total, `all GIFs: ${String(total)} bytes`).toBeLessThanOrEqual(GIFS_MAX_BYTES);
    });

    scenes();
  });
}

// Locators -------------------------------------------------------------------------------------

export function treeRow(page: Page, name: string): Locator {
  return toolWindow(page, "Database").getByRole("treeitem", { name, exact: true });
}

/** The datasource row, not the PostgreSQL database of the same name under it. */
export function datasourceRow(page: Page, name: string): Locator {
  return toolWindow(page, "Database")
    .locator('[role="treeitem"][data-kind="datasource"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}

export function editor(page: Page): Locator {
  return page.getByTestId("table-editor");
}

export function cell(page: Page, row: number, column: number): Locator {
  return editor(page).locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

export function filterBar(page: Page, bar: "where" | "order-by"): Locator {
  return editor(page).getByTestId(`filter-${bar}`).locator(".cm-content");
}

export function resultTab(page: Page, title: string): Locator {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title}$`) });
}

export function resultState(page: Page): Locator {
  return page.getByTestId("result-state");
}

export function resultToolbarButton(page: Page, name: string): Locator {
  return page.getByRole("toolbar", { name: "Result" }).getByRole("button", { name, exact: true });
}

export function completionPopup(page: Page): Locator {
  return page.locator(".cm-tooltip-autocomplete");
}

export function executions(page: Page): Locator {
  return toolWindow(page, "Services").locator('[role="treeitem"][data-kind="execution"]');
}

// Steps ----------------------------------------------------------------------------------------

/** Connects off camera: the prompt for the password is not what any GIF is about. */
export async function connect(page: Page, name: string, password?: string): Promise<void> {
  await datasourceRow(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Connect/ }).click();
  if (password !== undefined) await answerSecretPrompt(page, name, password);
  await expect
    .poll(() => datasourceRow(page, name).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
    .toBe("connected");
}

export async function expandQuietly(page: Page, name: string): Promise<void> {
  const row = treeRow(page, name);
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await row.click();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded")).toBe("true");
}

export async function expandVisibly(page: Page, name: string): Promise<void> {
  const row = treeRow(page, name);
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await clickVisibly(page, row);
  await pressVisibly(page, "ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("true");
  await pause(page);
}

/** Connects `shop` and opens its tables group, the state most scenes start from. */
export async function shopTables(page: Page): Promise<void> {
  await connect(page, SHOP, PASSWORD);
  await expandQuietly(page, NAMESPACE);
  await expandQuietly(page, TABLES_GROUP);
}

export async function openConsole(page: Page, name: string): Promise<void> {
  await datasourceRow(page, name).click();
  await pressChord(page, "Shift+L");
  await expect.poll(() => activeEditorTab(page).textContent()).toBe(`console [${name}]`);
  await waitUntilReady(page);
}

/** Puts `sql` into the console without typing it, for text a scene shows rather than writes. */
export async function setConsoleText(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await page.keyboard.press("ControlOrMeta+End");
}

export async function waitForRows(page: Page, state: string | RegExp): Promise<void> {
  await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(state);
}

/** CodeMirror ignores Enter for `interactionDelay` after the popup opens; a reader never beats it. */
const INTERACTION_DELAY_MS = 75;
/** Basic Completion, CodeMirror's `Ctrl-Space` on every platform. */
const BASIC_COMPLETION = "Ctrl+Space";
const POPUP_GRACE_MS = 1_000;

/**
 * True once Enter would accept `label`, as `completion.smoke.test.ts` checks it. A string, because
 * the root program has no DOM lib.
 */
function acceptable(label: string): string {
  return `(() => {
    const popup = document.querySelector('.cm-tooltip-autocomplete');
    if (popup === null) return false;
    const seen = (window.__popupSeen ??= new WeakMap());
    if (!seen.has(popup)) seen.set(popup, performance.now());
    if (performance.now() - seen.get(popup) < ${String(INTERACTION_DELAY_MS)}) return false;
    if (popup.classList.contains('cm-tooltip-autocomplete-disabled')) return false;
    return popup.querySelector('[aria-selected] .cm-completionLabel')?.textContent === ${JSON.stringify(label)};
  })()`;
}

/**
 * Accepts `label` from the completion popup, asking for it with Basic Completion when typing did not
 * open the popup (it opens on a word, not after a space).
 */
export async function acceptCompletion(page: Page, label: string): Promise<void> {
  const opened = await completionPopup(page)
    .waitFor({ timeout: POPUP_GRACE_MS })
    .then(() => true)
    .catch(() => false);
  if (!opened) await pressVisibly(page, BASIC_COMPLETION);
  await expect.poll(() => page.evaluate<boolean>(acceptable(label)), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
  await pause(page);
  await pressVisibly(page, "Enter");
  await expect.poll(() => completionPopup(page).count()).toBe(0);
}

export async function selectInTree(page: Page, name: string): Promise<void> {
  await clickVisibly(page, treeRow(page, name));
  await expect.poll(() => treeRow(page, name).getAttribute("aria-selected")).toBe("true");
}

export async function editCell(page: Page, row: number, column: number, text: string): Promise<void> {
  await clickVisibly(page, cell(page, row, column), { double: true });
  const field = editor(page).locator('[data-editing] input[aria-label^="Edit "]');
  await field.waitFor();
  await page.keyboard.press("ControlOrMeta+A");
  await typeSlowly(page, text);
  await pressVisibly(page, "Enter");
  await expect.poll(() => field.count()).toBe(0);
}

/**
 * Clicking a header writes `ORDER BY`. PostgreSQL returns an updated row last in a plain scan, so a
 * scene that edits and reloads sorts first, or the edited row would seem to vanish.
 */
export async function sortTableBy(page: Page, column: string): Promise<void> {
  await clickVisibly(page, editor(page).getByRole("columnheader", { name: new RegExp(`^${column}\\b`) }));
  await expect
    .poll(() => editor(page).getByTestId("filter-order-by").locator(".cm-line").textContent(), {
      timeout: LAUNCH_TIMEOUT_MS,
    })
    .toContain(column);
  await pause(page);
}

/**
 * The centre of the first character of `needle` in the console's first line, which CodeMirror may
 * split across several spans. A string, because the root program has no DOM lib.
 */
function firstCharacterOf(needle: string): string {
  return `(() => {
    const line = document.querySelector('[data-testid="sql-editor"] .cm-line');
    const at = line?.textContent.indexOf(${JSON.stringify(needle)}) ?? -1;
    if (at < 0) return null;
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const length = node.textContent.length;
      if (seen + length > at) {
        const range = document.createRange();
        range.setStart(node, at - seen);
        range.setEnd(node, at - seen + 1);
        const box = range.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      seen += length;
    }
    return null;
  })()`;
}

export async function clickInConsole(page: Page, needle: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number } | null>(firstCharacterOf(needle));
  if (point === null) throw new Error(`"${needle}" is not on the console's first line.`);
  await clickAtVisibly(page, point.x, point.y);
}

/** Preview Pending Changes lists the SQL Submit will run; its Submit runs it. */
export async function previewAndSubmit(page: Page, readMs = 1600): Promise<void> {
  await pressVisibly(page, "Mod+Shift+P");
  const preview = page.getByRole("dialog", { name: "Pending changes" });
  await preview.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await pause(page, readMs);
  await clickVisibly(page, preview.getByRole("button", { name: "Submit", exact: true }));
  await preview.waitFor({ state: "detached" });
}
