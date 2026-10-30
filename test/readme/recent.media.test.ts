/**
 * The GIFs plan 128 added for features that shipped without one: etcd keys and their History,
 * snippets, side-by-side console groups, the theme catalogue and plugins downloaded on demand.
 * Recorded the same way as `readme.media.test.ts`, by the same `bun run readme:media`.
 */
import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
import { pluginPackageName, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";
import { builtRelease } from "../e2e/pluginFixtures.js";
import {
  chooseOption,
  dataSourcesDialog,
  LAUNCH_TIMEOUT_MS,
  type SavedDatasource,
  sqlEditor,
  toolWindow,
  waitUntilReady,
} from "../e2e/harness.js";
import { clickVisibly, pause, pointAt, pressVisibly, typeSlowly } from "./pace.js";
import {
  connect,
  datasourceRow,
  mediaSuite,
  openConsole,
  PASSWORD,
  READ_PAUSE_MS,
  scene,
  setConsoleText,
  SHOP,
  waitForRows,
} from "./scenes.js";
import { loadShopEtcd, SHOP_ETCD_NAMESPACE, SHOP_ETCD_PORT, stopShopEtcd } from "./shop.js";

const CONFIG = "config";
const CONFIG_ETCD: SavedDatasource = {
  id: CONFIG,
  name: CONFIG,
  pluginId: "etcd",
  color: "orange",
  config: { host: "127.0.0.1", port: SHOP_ETCD_PORT, namespace: SHOP_ETCD_NAMESPACE },
  secretModes: { password: "untilRestart" },
};
/** The demo etcd runs with auth off; the prompt for its password is answered with nothing. */
const NO_PASSWORD = "";
/** `shop.etcd` writes `db.json` this many times. */
const DB_JSON_VERSIONS = 3;

const SNIPPET = { name: "Peek at a table", prefix: "sel", body: "SELECT * FROM ${table} LIMIT 100;" };
const ALL_SQL_CONSOLES = "All SQL consoles";
/** How many completion options the scene steps through looking for the snippet before giving up. */
const MAX_COMPLETION_STEPS = 8;
/** CodeMirror ignores a key for `interactionDelay` after the selection moves. */
const CHOICE_SETTLE_MS = 100;

const TOKYONIGHT_DARK = "Tokyonight Dark";
const DARK_PREVIEWS = 3;

const POSTGRES = "postgres";
/** Long enough to read the progress line, short against the launch timeout (plan 057). */
const SLOW_REGISTRY_MS = 2_500;

function keyRows(page: Page, kind: string): Locator {
  return toolWindow(page, "Database").locator(`[role="treeitem"][data-kind="${kind}"]`);
}

function keyRow(page: Page, kind: string, label: RegExp): Locator {
  return keyRows(page, kind)
    .filter({ has: page.getByText(label) })
    .first();
}

function keyTab(page: Page): Locator {
  return page.getByTestId("key-tab");
}

function keyButton(page: Page, name: string): Locator {
  return keyTab(page).getByRole("button", { name, exact: true });
}

async function expandKeyRow(page: Page, row: Locator): Promise<void> {
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await clickVisibly(page, row);
  await pressVisibly(page, "ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded")).toBe("true");
}

function groups(page: Page): Locator {
  return page.getByTestId("editor-group");
}

function groupTabs(group: Locator): Locator {
  return group.getByRole("tablist", { name: "Editor tabs", exact: true }).getByRole("tab");
}

function groupEditor(group: Locator): Locator {
  return group.getByRole("textbox", { name: "SQL console", exact: true });
}

async function groupRows(group: Locator, value: string): Promise<void> {
  await expect
    .poll(() => group.getByRole("gridcell").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
    .toContain(value);
}

/** Replaces what `field` holds with `text`, typed for the reader. */
async function retype(page: Page, field: Locator, text: string): Promise<void> {
  await clickVisibly(page, field);
  await page.keyboard.press("ControlOrMeta+A");
  await typeSlowly(page, text);
}

/** True once the completion popup's selected option names `label` and has settled. */
function chosen(label: string): string {
  return `(() => {
    const selected = document.querySelector('.cm-tooltip-autocomplete [aria-selected]');
    if (!selected?.textContent?.includes(${JSON.stringify(label)})) return false;
    const seen = (window.__readmeChoiceSeen ??= new WeakMap());
    if (!seen.has(selected)) seen.set(selected, performance.now());
    return performance.now() - seen.get(selected) >= ${String(CHOICE_SETTLE_MS)};
  })()`;
}

/** Moves the completion selection down to the option naming `label`, as a reader would. */
async function chooseCompletion(page: Page, label: string): Promise<void> {
  await page.locator(".cm-tooltip-autocomplete").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  for (let step = 0; step < MAX_COMPLETION_STEPS; step++) {
    const found = await expect
      .poll(() => page.evaluate<boolean>(chosen(label)), { timeout: CHOICE_SETTLE_MS * 4 })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    if (found) return;
    await pressVisibly(page, "ArrowDown");
  }
  throw new Error(`The completion popup never offered "${label}".`);
}

mediaSuite("README recent feature media", () => {
  scene("etcd", {
    alsoSaved: [CONFIG_ETCD],
    prepare: loadShopEtcd,
    teardown: () => {
      stopShopEtcd();
      return Promise.resolve();
    },
    setup: async ({ page }) => {
      await connect(page, CONFIG, NO_PASSWORD);
      await datasourceRow(page, CONFIG).click();
      await page.keyboard.press("ArrowRight");
      await keyRows(page, "keyFolder").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    },
    run: async ({ page }) => {
      await expandKeyRow(page, keyRow(page, "keyFolder", /^session\//));
      await pointAt(page, keyRow(page, "keyEntry", /^u17/));
      await pause(page, READ_PAUSE_MS);
      await expandKeyRow(page, keyRow(page, "keyFolder", /^config\//));
      await pause(page);
      await clickVisibly(page, keyRow(page, "keyEntry", /^db\.json/), { double: true });
      await expect
        .poll(() => keyTab(page).getByTestId("key-name").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("db.json");
      await expect
        .poll(() => keyTab(page).getByTestId("value-editor").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("replica");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, keyButton(page, "History"));
      const history = keyTab(page).getByTestId("key-history");
      const versions = history.getByRole("complementary", { name: "Key versions" }).getByRole("button");
      await expect.poll(() => versions.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(DB_JSON_VERSIONS);
      await pause(page);
      await clickVisibly(page, history.locator('button[title^="PUT · v1 "]'));
      const comparison = history.getByRole("region", { name: "Value comparison" });
      await expect.poll(() => comparison.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("replica");
      await pointAt(page, comparison);
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, keyButton(page, "Restore Selected Version"));
      await keyTab(page).getByTestId("pending-changes").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, keyButton(page, "Preview Pending Changes"));
      const preview = page.getByRole("dialog");
      await expect.poll(() => preview.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("txn");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, preview.getByRole("button", { name: "Submit", exact: true }));
      await expect
        .poll(() => keyTab(page).getByTestId("key-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`Saved as v${String(DB_JSON_VERSIONS + 1)}`);
    },
  });

  scene("snippets", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await page.keyboard.press("Escape");
    },
    run: async ({ page }) => {
      await pressVisibly(page, "Mod+Shift+A");
      await typeSlowly(page, "Snippets");
      await pause(page);
      await pressVisibly(page, "Enter");
      const dialog = page.getByRole("dialog", { name: "Snippets" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "New Snippet", exact: true }));
      await retype(page, dialog.locator("#snippet-name"), SNIPPET.name);
      await retype(page, dialog.locator("#snippet-prefix"), SNIPPET.prefix);
      await retype(page, dialog.locator("#snippet-body"), SNIPPET.body);
      const scope = dialog.locator("#snippet-scope");
      await clickVisibly(page, scope);
      await pause(page);
      await chooseOption(scope, { label: ALL_SQL_CONSOLES });
      await pause(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "Save", exact: true }));
      await expect.poll(() => dialog.getByRole("status").textContent()).toContain("Saved in this TableCraft profile.");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, dialog.getByRole("button", { name: "Close", exact: true }));
      await dialog.waitFor({ state: "detached" });
      await clickVisibly(page, sqlEditor(page));
      await typeSlowly(page, SNIPPET.prefix);
      await chooseCompletion(page, SNIPPET.name);
      await pause(page);
      await pressVisibly(page, "Tab");
      await expect
        .poll(async () => (await sqlEditor(page).locator(".cm-line").allTextContents()).join("\n"))
        .toBe("SELECT * FROM table LIMIT 100;");
      await pause(page);
      await typeSlowly(page, "orders");
      await page.keyboard.press("Escape");
      await pause(page);
      await pressVisibly(page, "Mod+Enter");
      await waitForRows(page, /rows?$/);
    },
  });

  scene("console-groups", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await setConsoleText(page, "SELECT status, count(*) AS orders FROM orders GROUP BY status;");
      await page.keyboard.press("ControlOrMeta+Enter");
      await waitForRows(page, /rows?$/);
      // Two groups side by side need the window's width more than the tree.
      await toolWindow(page, "Database").getByRole("button", { name: "Hide Database" }).click();
    },
    run: async ({ page }) => {
      await expect.poll(() => groups(page).count()).toBe(1);
      const strip = groups(page).first();
      await clickVisibly(page, strip.getByRole("button", { name: "New Console", exact: true }));
      await expect.poll(() => groupTabs(strip).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      await waitUntilReady(page);
      await pause(page);
      await clickVisibly(page, groupTabs(strip).last(), { button: "right" });
      await clickVisibly(page, page.getByRole("menuitem", { name: "Split Right", exact: true }));
      await expect.poll(() => groups(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      await pause(page);
      const right = groups(page).last();
      await clickVisibly(page, groupEditor(right));
      await typeSlowly(page, "SELECT name, city FROM customers WHERE city = 'Hanoi';");
      await page.keyboard.press("Escape");
      await pressVisibly(page, "Mod+Enter");
      await groupRows(right, "Hanoi");
      await pause(page, READ_PAUSE_MS);
      const left = groups(page).first();
      await clickVisibly(page, groupEditor(left));
      await page.keyboard.press("ControlOrMeta+A");
      await typeSlowly(page, "SELECT category, sum(stock) AS stock FROM products GROUP BY category;");
      await page.keyboard.press("Escape");
      await pressVisibly(page, "Mod+Enter");
      await groupRows(left, "Tea");
      await groupRows(right, "Hanoi");
      await pointAt(page, right.getByRole("gridcell").first());
    },
  });

  scene("themes", {
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
      await clickVisibly(page, dialog.getByTestId("theme-picker-trigger"));
      const picker = page.getByTestId("theme-picker");
      await picker.waitFor();
      await typeSlowly(page, "dark");
      await pause(page);
      for (let step = 0; step < DARK_PREVIEWS; step++) {
        await pressVisibly(page, "ArrowDown");
        await pause(page);
      }
      await page.keyboard.press("ControlOrMeta+A");
      await typeSlowly(page, "tokyo");
      await expect
        .poll(() => picker.locator('[role="option"][aria-selected="true"]').getAttribute("aria-label"))
        .toBe(TOKYONIGHT_DARK);
      await pause(page);
      await pressVisibly(page, "Enter");
      await picker.waitFor({ state: "detached" });
      await pause(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "Close", exact: true }));
      await dialog.waitFor({ state: "detached" });
      await pointAt(page, page.getByRole("gridcell").first());
    },
  });

  let registry: LoopbackRegistry | null = null;
  scene("plugins", {
    withoutShop: true,
    prepare: async () => {
      registry = await startRegistry({ [pluginPackageName(POSTGRES)]: [builtRelease(POSTGRES, "1.0.0")] });
    },
    settings: () => ({ plugins: { registryUrl: registry?.url ?? "" } }),
    env: () => ({ TABLE_CRAFT_DEVELOPMENT_PLUGINS: "0" }),
    teardown: async () => {
      const serving = registry;
      registry = null;
      await serving?.close();
    },
    setup: () => Promise.resolve(),
    run: async ({ page }) => {
      await clickVisibly(page, toolWindow(page, "Database").getByRole("button", { name: "New Data Source…" }));
      const kinds = dataSourcesDialog(page).getByRole("list", { name: "Database kinds" });
      const download = kinds.locator(`button[data-download="${POSTGRES}"]`);
      await expect.poll(() => download.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/Download \(about .+\)/);
      await pointAt(page, download);
      await pause(page, READ_PAUSE_MS);
      registry?.slowDown(SLOW_REGISTRY_MS);
      await clickVisibly(page, download);
      await expect
        .poll(() => kinds.getByRole("status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("Installing PostgreSQL…");
      await dataSourcesDialog(page).getByLabel("Host", { exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, dataSourcesDialog(page).getByRole("button", { name: "Cancel", exact: true }));
      await pressVisibly(page, "Mod+,");
      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await clickVisibly(page, settings.getByRole("tab", { name: "Plugins", exact: true }));
      const row = settings.locator(`[data-plugin-row="${POSTGRES}"]`);
      await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pointAt(page, row.getByText(/Downloaded/).first());
      expect(registry?.requests).toEqual([
        `/${pluginPackageName(POSTGRES).replace("/", "%2f")}`,
        `/tarballs/tablecraft-app-plugin-postgres-1.0.0.tgz`,
      ]);
    },
  });
});
