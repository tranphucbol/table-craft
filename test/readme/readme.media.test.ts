/**
 * Records the README's GIFs (plan 016, decision 036) from the built app against the demo shop:
 * PostgreSQL `shop` in the `test:db` container, reloaded before every scene, and a SQLite `shop.db`
 * built fresh. Gated, because it needs a display, a fresh build, Docker and ffmpeg:
 *
 *   bun run readme:media                          every GIF
 *   README_MEDIA=explain,grid bun run readme:media   only those
 *
 * Each scene sets up off camera (connect, open a console, fill text a reader need not watch typed),
 * then records only what the GIF is about, paced by `pace.ts` for a reader.
 */
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
  consoleToolbar,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  exportDialog,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  paletteInput,
  paletteRows,
  pressChord,
  type SavedDatasource,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  waitUntilReady,
} from "../e2e/harness.js";
import { stubSaveDialog } from "../e2e/workflows.js";
import { type Gif, GIF_MAX_BYTES, GIFS_MAX_BYTES, requireFfmpeg, startRecording } from "./recorder.js";
import { clickAtVisibly, clickVisibly, END_PAUSE_MS, pause, pointAt, pressVisibly, typeSlowly } from "./pace.js";
import { buildShopSqlite, loadShopPostgres, SHOP_DATABASE } from "./shop.js";

const README_MEDIA_ENABLED = SMOKE_ENABLED && process.env["TABLE_CRAFT_README_MEDIA"] === "1";
/** `README_MEDIA=explain,grid` re-records only those GIFs; unset records all of them. */
const ONLY = (process.env["README_MEDIA"] ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter((name) => name !== "");

const SCENE_TIMEOUT_MS = 120_000;
/** Long enough to read a result or a dialog before the scene moves on. */
const READ_PAUSE_MS = 1_500;
/** Plan 016 decision 20: a GIF a reader watches through, not a screencast to scrub. */
const MAX_GIF_SECONDS = 25;

const SHOP = "shop";
const SHOP_FILE = "shop.db";
const NAMESPACE = "public";
const TABLES_GROUP = "tables 4";
const PASSWORD = POSTGRES_CONFIG.password;
const EXPORT_DIRECTORY = "/tmp/table-craft-readme";

const SHOP_POSTGRES: SavedDatasource = {
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

/** The GIFs pin Dark (plan 016, Consequences), whatever the recording Mac's appearance is. */
const DARK = { version: 1, appearance: { theme: "dark" } };

interface Scene {
  readonly app: ElectronApplication;
  readonly page: Page;
}

const recorded: Gif[] = [];
let sqliteDirectory = "";
let running: ElectronApplication | null = null;

interface SceneScript {
  /** Off camera: connect, open a console, fill text the reader need not watch typed. */
  readonly setup: (scene: Scene) => Promise<void>;
  /** On camera. */
  readonly run: (scene: Scene) => Promise<void>;
  /** Only the SQLite file is saved, for the scene that adds `shop` itself. */
  readonly withoutShop?: boolean;
}

function scene(name: string, { setup, run, withoutShop = false }: SceneScript) {
  const skipped = ONLY.length > 0 && !ONLY.includes(name);
  it.skipIf(skipped)(
    name,
    async () => {
      loadShopPostgres();
      const profile = newProfile();
      const sqlite = shopSqlite(join(sqliteDirectory, SHOP_FILE));
      seedDatasources(profile, withoutShop ? [sqlite] : [SHOP_POSTGRES, sqlite]);
      seedSettings(profile, DARK);
      const { app, page } = await launchApp(null, { userDataDir: profile });
      running = app;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await setup({ app, page });
      await pause(page);
      const recording = await startRecording(app, page);
      try {
        await run({ app, page });
      } catch (error) {
        await page.screenshot({ path: join(tmpdir(), `table-craft-readme-${name}-failure.png`) });
        throw error;
      }
      await pause(page, END_PAUSE_MS);
      const gif = await recording.stop(name);
      recorded.push(gif);
      expect(statSync(gif.path).size).toBe(gif.bytes);
      expect(gif.bytes, `${name}.gif is ${String(gif.bytes)} bytes`).toBeLessThanOrEqual(GIF_MAX_BYTES);
      expect(gif.seconds, `${name}.gif lasts ${gif.seconds.toFixed(1)} s`).toBeLessThanOrEqual(MAX_GIF_SECONDS);
    },
    SCENE_TIMEOUT_MS,
  );
}

// Locators -------------------------------------------------------------------------------------

function treeRow(page: Page, name: string): Locator {
  return toolWindow(page, "Database").getByRole("treeitem", { name, exact: true });
}

/** The datasource row, not the PostgreSQL database of the same name under it. */
function datasourceRow(page: Page, name: string): Locator {
  return toolWindow(page, "Database")
    .locator('[role="treeitem"][data-kind="datasource"]')
    .filter({ has: page.getByText(name, { exact: true }) });
}

function editor(page: Page): Locator {
  return page.getByTestId("table-editor");
}

function cell(page: Page, row: number, column: number): Locator {
  return editor(page).locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

function filterBar(page: Page, bar: "where" | "order-by"): Locator {
  return editor(page).getByTestId(`filter-${bar}`).locator(".cm-content");
}

function resultTab(page: Page, title: string): Locator {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title}$`) });
}

function resultState(page: Page): Locator {
  return page.getByTestId("result-state");
}

function resultToolbarButton(page: Page, name: string): Locator {
  return page.getByRole("toolbar", { name: "Result" }).getByRole("button", { name, exact: true });
}

function completionPopup(page: Page): Locator {
  return page.locator(".cm-tooltip-autocomplete");
}

function executions(page: Page): Locator {
  return toolWindow(page, "Services").locator('[role="treeitem"][data-kind="execution"]');
}

// Steps ----------------------------------------------------------------------------------------

/** Connects off camera: the prompt for the password is not what any GIF is about. */
async function connect(page: Page, name: string, password?: string): Promise<void> {
  await datasourceRow(page, name).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Connect/ }).click();
  if (password !== undefined) await answerSecretPrompt(page, name, password);
  await expect
    .poll(() => datasourceRow(page, name).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
    .toBe("connected");
}

async function expandQuietly(page: Page, name: string): Promise<void> {
  const row = treeRow(page, name);
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await row.click();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded")).toBe("true");
}

async function expandVisibly(page: Page, name: string): Promise<void> {
  const row = treeRow(page, name);
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await clickVisibly(page, row);
  await pressVisibly(page, "ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("true");
  await pause(page);
}

/** Connects `shop` and opens its tables group, the state most scenes start from. */
async function shopTables(page: Page): Promise<void> {
  await connect(page, SHOP, PASSWORD);
  await expandQuietly(page, NAMESPACE);
  await expandQuietly(page, TABLES_GROUP);
}

async function openConsole(page: Page, name: string): Promise<void> {
  await datasourceRow(page, name).click();
  await pressChord(page, "Shift+L");
  await expect.poll(() => activeEditorTab(page).textContent()).toBe(`console [${name}]`);
  await waitUntilReady(page);
}

/** Puts `sql` into the console without typing it, for text a scene shows rather than writes. */
async function setConsoleText(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await page.keyboard.press("ControlOrMeta+End");
}

async function waitForRows(page: Page, state: string | RegExp): Promise<void> {
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
async function acceptCompletion(page: Page, label: string): Promise<void> {
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

async function selectInTree(page: Page, name: string): Promise<void> {
  await clickVisibly(page, treeRow(page, name));
  await expect.poll(() => treeRow(page, name).getAttribute("aria-selected")).toBe("true");
}

async function editCell(page: Page, row: number, column: number, text: string): Promise<void> {
  await clickVisibly(page, cell(page, row, column), { double: true });
  const field = editor(page).locator("[data-editing] input");
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
async function sortTableBy(page: Page, column: string): Promise<void> {
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

async function clickInConsole(page: Page, needle: string): Promise<void> {
  const point = await page.evaluate<{ x: number; y: number } | null>(firstCharacterOf(needle));
  if (point === null) throw new Error(`"${needle}" is not on the console's first line.`);
  await clickAtVisibly(page, point.x, point.y);
}

/** Preview Pending Changes lists the SQL Submit will run; its Submit runs it. */
async function previewAndSubmit(page: Page, readMs = 1600): Promise<void> {
  await pressVisibly(page, "Mod+Shift+P");
  const preview = page.getByRole("dialog", { name: "Pending changes" });
  await preview.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await pause(page, readMs);
  await clickVisibly(page, preview.getByRole("button", { name: "Submit", exact: true }));
  await preview.waitFor({ state: "detached" });
}

// Scenes ---------------------------------------------------------------------------------------

describe.runIf(README_MEDIA_ENABLED)("README media", () => {
  beforeAll(() => {
    requireFfmpeg();
    sqliteDirectory = mkdtempSync(join(tmpdir(), "table-craft-readme-shop-"));
    buildShopSqlite(sqliteDirectory);
    mkdirSync(EXPORT_DIRECTORY, { recursive: true });
  });

  afterEach(async () => {
    await closeApp(running);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  afterAll(() => {
    rmSync(sqliteDirectory, { recursive: true, force: true });
    rmSync(EXPORT_DIRECTORY, { recursive: true, force: true });
    const total = recorded.reduce((sum, gif) => sum + gif.bytes, 0);
    if (ONLY.length === 0) expect(total, `all GIFs: ${String(total)} bytes`).toBeLessThanOrEqual(GIFS_MAX_BYTES);
  });

  scene("how-it-works", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
    },
    run: async ({ page }) => {
      await expandVisibly(page, NAMESPACE);
      await expandVisibly(page, TABLES_GROUP);
      await clickVisibly(page, datasourceRow(page, SHOP));
      await pressVisibly(page, "Mod+Shift+L");
      await waitUntilReady(page);
      await pause(page);
      await typeSlowly(page, "SELECT c.name, o.placed_at FROM orders o JOIN ");
      await acceptCompletion(page, "customers c ON c.id = o.customer_id");
      await typeSlowly(page, " WHERE o.status = 'pending'");
      await pause(page);
      await pressVisibly(page, "Mod+Enter");
      await waitForRows(page, "10 rows");
      await pause(page, READ_PAUSE_MS);
      await selectInTree(page, "orders");
      await pressVisibly(page, "F4");
      await cell(page, 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await sortTableBy(page, "id");
      await editCell(page, 0, 2, "shipped");
      await pause(page);
      await previewAndSubmit(page);
      await expect.poll(() => editor(page).getByTestId("table-notice").textContent()).toBe("Submitted 1 statement");
    },
  });

  scene("connections", {
    withoutShop: true,
    setup: () => Promise.resolve(),
    run: async ({ page }) => {
      await clickVisibly(page, toolWindow(page, "Database").getByRole("button", { name: "New Data Source…" }));
      const dialog = dataSourcesDialog(page);
      await pause(page);
      await clickVisibly(
        page,
        dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: "PostgreSQL" }),
      );
      await pause(page);
      const type = async (label: string, text: string) => {
        await clickVisibly(page, dialog.getByLabel(label, { exact: true }));
        await page.keyboard.press("ControlOrMeta+A");
        await typeSlowly(page, text);
      };
      await type("Name", "shop");
      await type("Host", POSTGRES_CONFIG.host);
      await type("Port", String(POSTGRES_CONFIG.port));
      await type("Database", SHOP_DATABASE);
      await type("User", POSTGRES_CONFIG.user);
      await type("Password", PASSWORD);
      await pause(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "Test Connection" }));
      await expect
        .poll(() => dialog.getByTestId("test-result").getAttribute("data-ok"), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("true");
      await pause(page, 1200);
      await clickVisibly(
        page,
        dialog.getByRole("radiogroup", { name: "Colour" }).getByRole("radio", { name: "green" }),
      );
      await pause(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "OK", exact: true }));
      await dialog.waitFor({ state: "detached" });
      await pause(page);
      await clickVisibly(page, datasourceRow(page, SHOP));
      await pressVisibly(page, "ArrowRight");
      await expect
        .poll(() => datasourceRow(page, SHOP).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("connected");
      await expandVisibly(page, NAMESPACE);
      await expandVisibly(page, TABLES_GROUP);
    },
  });

  scene("explorer", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
    },
    run: async ({ page }) => {
      await expandVisibly(page, NAMESPACE);
      await expandVisibly(page, TABLES_GROUP);
      await expandVisibly(page, "orders");
      await expandVisibly(page, "columns 4");
      await pause(page);
      await clickVisibly(page, treeRow(page, TABLES_GROUP));
      await typeSlowly(page, "cust");
      await pause(page, 1200);
      await pressVisibly(page, "Escape");
      await selectInTree(page, "customers");
      await pressVisibly(page, "F1");
      await pause(page, 2500);
      await pressVisibly(page, "Escape");
      // Escape also leaves the tree for the editor (Back to Editor); Go to DDL acts on the tree.
      await selectInTree(page, "customers");
      await pressVisibly(page, "Mod+B");
      await expect
        .poll(() => page.getByTestId("ddl-text").locator(".cm-line").first().textContent(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toMatch(/CREATE/);
    },
  });

  scene("console", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await setConsoleText(
        page,
        "SELECT status, count(*) AS orders FROM orders GROUP BY status;\nSELECT name, city FROM customers WHERE city = 'Hanoi';",
      );
    },
    run: async ({ page }) => {
      await pressVisibly(page, "Mod+Shift+Enter");
      await expect.poll(() => resultTab(page, "Result 2").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(1);
      await pause(page);
      await clickVisibly(page, resultTab(page, "Result 1"));
      await pause(page);
      await clickVisibly(page, resultTab(page, "Output"));
      await pause(page, 1200);
      await clickVisibly(page, sqlEditor(page));
      await page.keyboard.press("ControlOrMeta+End");
      const mode = consoleToolbar(page).getByRole("combobox", { name: "Transaction mode" });
      await pointAt(page, mode);
      await mode.selectOption("manual");
      await pause(page);
      await typeSlowly(page, "\nUPDATE products SET stock = 0 WHERE id = 1;");
      await pressVisibly(page, "Mod+Enter");
      await consoleToolbar(page).getByRole("status").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, 1200);
      await clickVisibly(page, consoleToolbar(page).getByRole("button", { name: "Rollback", exact: true }));
      await expect.poll(() => consoleToolbar(page).getByRole("status").count()).toBe(0);
    },
  });

  scene("completion", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
    },
    run: async ({ page }) => {
      await typeSlowly(page, "SELECT c.name, o.status FROM orders o JOIN ");
      await acceptCompletion(page, "customers c ON c.id = o.customer_id");
      await typeSlowly(page, " WHERE c.ci");
      await acceptCompletion(page, "city");
      await typeSlowly(page, " = 'Lyon'");
      await pause(page);
      await pressVisibly(page, "Mod+Enter");
      await waitForRows(page, /rows?$/);
      await pause(page);
      await clickInConsole(page, "c.city");
      await pressVisibly(page, "Mod+B");
      await pause(page, 1200);
      await clickInConsole(page, "orders o");
      await pressVisibly(page, "Mod+B");
      await expect
        .poll(() => page.getByTestId("ddl-text").locator(".cm-line").first().textContent(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toMatch(/CREATE/);
    },
  });

  scene("grid", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      // The grid is the subject; Services would take a third of its height.
      await toolWindow(page, "Services").getByRole("button", { name: "Hide Services" }).click();
      await setConsoleText(page, "SELECT * FROM order_items");
    },
    run: async ({ app, page }) => {
      await pressVisibly(page, "Mod+Enter");
      await waitForRows(page, "500+ rows");
      await pause(page);
      await clickVisibly(page, page.getByRole("columnheader", { name: /^unit_price/ }));
      await pause(page);
      await clickVisibly(page, page.getByRole("columnheader", { name: /^unit_price/ }));
      await pause(page);
      await clickVisibly(page, resultToolbarButton(page, "Fetch All"));
      await waitForRows(page, /^594 rows/);
      await pause(page);
      await clickVisibly(page, page.getByRole("gridcell").nth(2));
      await pressVisibly(page, "Shift+Enter");
      await pause(page, 1200);
      const extractor = page.getByRole("toolbar", { name: "Result" }).getByLabel("Extractor");
      await pointAt(page, extractor);
      await extractor.selectOption("markdown");
      await pause(page);
      await clickVisibly(page, resultToolbarButton(page, "Copy"));
      await pause(page);
      await stubSaveDialog(app, join(EXPORT_DIRECTORY, "order_items.md"));
      await clickVisibly(page, resultToolbarButton(page, "Export Data…"));
      const dialog = exportDialog(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "Browse…" }));
      await pause(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "Export", exact: true }));
      await clickVisibly(page, resultTab(page, "Output"));
      await expect
        .poll(() => page.getByRole("log", { name: "Output" }).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("exported to");
    },
  });

  scene("table-editor", {
    setup: async ({ page }) => {
      await shopTables(page);
    },
    run: async ({ page }) => {
      await selectInTree(page, "orders");
      await pressVisibly(page, "F4");
      await cell(page, 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, filterBar(page, "where"));
      await typeSlowly(page, "status = 'pending'");
      await pressVisibly(page, "Escape");
      await pressVisibly(page, "Enter");
      await expect.poll(() => cell(page, 0, 0).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("191");
      await pause(page);
      await editCell(page, 0, 2, "shipped");
      await clickVisibly(page, cell(page, 9, 0));
      await pressVisibly(page, "Mod+Backspace");
      await pause(page);
      await pressVisibly(page, "Mod+N");
      await editCell(page, 10, 1, "7");
      await editCell(page, 10, 3, "2026-10-22 09:30");
      await pause(page);
      await previewAndSubmit(page, 2200);
      await expect
        .poll(() => editor(page).getByTestId("table-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("Submitted 3 statements");
      await pause(page);
      await clickVisibly(page, cell(page, 0, 1));
      await pressVisibly(page, "Mod+B");
      await expect.poll(() => activeEditorTab(page).textContent()).toBe(`customers [${SHOP}]`);
    },
  });

  scene("sql-generator", {
    setup: async ({ page }) => {
      await shopTables(page);
    },
    run: async ({ page }) => {
      await selectInTree(page, "orders");
      await pressVisibly(page, "Mod+B");
      await page.getByTestId("ddl-text").locator(".cm-line").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, 1500);
      await selectInTree(page, "customers");
      await pressVisibly(page, "Mod+Alt+G");
      const generator = page.getByRole("dialog", { name: "SQL Generator: customers" });
      await generator.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, generator.getByRole("radio", { name: "INSERT" }));
      await pause(page, 1500);
      await clickVisibly(page, generator.getByRole("radio", { name: "UPDATE" }));
      await pause(page, 1500);
      await clickVisibly(page, generator.getByRole("button", { name: "Open in Console", exact: true }));
      await generator.waitFor({ state: "detached" });
    },
  });

  scene("history-services", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      for (const sql of [
        "SELECT * FROM customer_revenue ORDER BY revenue DESC LIMIT 5",
        "SELECT status, count(*) FROM orders GROUP BY status",
        "SELECT * FROM products WHERE stock < 10",
      ]) {
        await setConsoleText(page, sql);
        await page.keyboard.press("ControlOrMeta+Enter");
        await waitForRows(page, /rows?$/);
      }
      await setConsoleText(page, "");
    },
    run: async ({ page }) => {
      await pointAt(page, executions(page).first());
      await pause(page, READ_PAUSE_MS);
      await pressVisibly(page, "Mod+Alt+E");
      const history = page.getByRole("dialog", { name: `Query History: ${SHOP}` });
      await history.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await typeSlowly(page, "revenue");
      await pause(page, READ_PAUSE_MS);
      await pressVisibly(page, "Enter");
      await history.waitFor({ state: "detached" });
      await pause(page, READ_PAUSE_MS);
      const before = await executions(page).count();
      await pressVisibly(page, "Mod+Enter");
      await expect.poll(() => executions(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBeGreaterThan(before);
      await pointAt(page, executions(page).last());
    },
  });

  scene("explain", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await setConsoleText(
        page,
        "SELECT c.name, sum(i.quantity * i.unit_price) AS revenue\nFROM orders o\n  JOIN customers c ON c.id = o.customer_id\n  JOIN order_items i ON i.order_id = o.id\nWHERE o.placed_at >= '2026-06-01'\nGROUP BY c.name",
      );
    },
    run: async ({ page }) => {
      await pressVisibly(page, "Mod+Shift+E");
      const rows = page.getByRole("treegrid").locator("tbody").getByRole("row");
      await rows.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, rows.nth(1));
      await pause(page, 1500);
      await clickVisibly(page, sqlEditor(page));
      await page.keyboard.press("ControlOrMeta+A");
      await typeSlowly(page, "UPDATE products SET stock = stock + 5 WHERE category = 'Tea'");
      await pause(page);
      await clickVisibly(page, page.getByRole("button", { name: "Explain Analyse", exact: true }));
      const confirm = page.getByRole("dialog", { name: "Explain Analyse runs this statement" });
      await confirm.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, 1500);
      await clickVisibly(page, confirm.getByRole("button", { name: "Run and Explain", exact: true }));
      await page.getByTestId("plan-banner").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    },
  });

  scene("search-everywhere", {
    setup: async ({ page }) => {
      await shopTables(page);
    },
    run: async ({ page }) => {
      await pressVisibly(page, "Shift Shift");
      await paletteInput(page, "Search Everywhere").waitFor();
      await typeSlowly(page, "orders");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, page.getByRole("tab", { name: "Tables", exact: true }));
      await pause(page);
      await pressVisibly(page, "Enter");
      await cell(page, 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
      await pressVisibly(page, "Mod+Shift+A");
      await paletteInput(page, "Find Action").waitFor();
      await typeSlowly(page, "font");
      await expect.poll(() => paletteRows(page).count()).toBeGreaterThan(0);
      await pause(page, READ_PAUSE_MS);
      await pressVisibly(page, "ArrowDown");
      await pause(page);
      await pressVisibly(page, "Escape");
    },
  });

  scene("settings", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await setConsoleText(page, "SELECT name, category, price\nFROM products\nWHERE stock > 0\nORDER BY price DESC;");
      await page.keyboard.press("ControlOrMeta+Enter");
      await waitForRows(page, /rows?$/);
    },
    run: async ({ page }) => {
      await pressVisibly(page, "Mod+,");
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await dialog.waitFor();
      await pause(page);
      const theme = async (name: string) => {
        await clickVisibly(page, dialog.getByTestId("theme-picker-trigger"));
        await clickVisibly(page, page.getByTestId("theme-picker").getByRole("option", { name, exact: true }));
      };
      await theme("Light");
      await pause(page, 1200);
      await theme("Gruvbox Dark");
      await pause(page, 1200);
      await theme("Dark");
      await pause(page);
      await clickVisibly(page, dialog.getByRole("radio", { name: "Compact", exact: true }));
      await pause(page, 1200);
      await clickVisibly(page, dialog.getByRole("button", { name: "Close", exact: true }));
      await dialog.waitFor({ state: "detached" });
      await clickVisibly(page, sqlEditor(page));
      for (let step = 0; step < 4; step++) {
        await pressVisibly(page, "Mod+=");
        await pause(page, 450);
      }
      await pause(page);
      await pressVisibly(page, "Mod+0");
    },
  });
});
