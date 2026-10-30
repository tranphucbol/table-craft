/**
 * The README GIFs plan 061 added, one per feature section that had none: modifying a table, the
 * console's inspections and Run All, the grid's find, local filters and aggregates, CSV import,
 * Import Data Sources, Execute Routine, Sessions, and the two Redis views. Recorded the same way
 * as `readme.media.test.ts`, by the same `bun run readme:media`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
import postgres from "@table-craft/plugin-postgres";
import type { Session } from "@table-craft/plugin-api";
import { MYSQL_CONFIG, POSTGRES_CONFIG, REDIS_CONFIG } from "../support/databases.js";
import { writeImportFixture } from "../support/import/fixtures.js";
import {
  LAUNCH_TIMEOUT_MS,
  type SavedDatasource,
  sqlEditor,
  startStatement,
  toolWindow,
  treeNode,
} from "../e2e/harness.js";
import { clickVisibly, pause, pointAt, pressVisibly, typeSlowly } from "./pace.js";
import {
  cell,
  connect,
  datasourceRow,
  expandQuietly,
  EXPORT_DIRECTORY,
  mediaSuite,
  NAMESPACE,
  openConsole,
  PASSWORD,
  READ_PAUSE_MS,
  resultState,
  scene,
  selectInTree,
  setConsoleText,
  SHOP,
  shopTables,
  treeRow,
  waitForRows,
} from "./scenes.js";
import { loadShopRedis, SHOP_DATABASE, SHOP_REDIS_DATABASE } from "./shop.js";

const CACHE = "cache";
const CACHE_REDIS: SavedDatasource = {
  id: CACHE,
  name: CACHE,
  pluginId: "redis",
  color: "red",
  config: {
    mode: REDIS_CONFIG.mode,
    host: REDIS_CONFIG.host,
    port: REDIS_CONFIG.port,
    database: SHOP_REDIS_DATABASE,
    user: REDIS_CONFIG.user,
  },
  secretModes: { password: "untilRestart" },
};

const SUPPLIERS_FILE = join(EXPORT_DIRECTORY, "suppliers.csv");
const SUPPLIERS = 40;
const COUNTRIES = ["Vietnam", "Colombia", "Ethiopia", "Brazil", "Kenya", "Japan", "Portugal", "Germany"];
const SUPPLIER_NAMES = ["Highland", "Riverside", "Summit", "Harbor", "Meadow", "Cedar", "Lantern", "Copper"];
const SUPPLIER_SUFFIXES = ["Roasters", "Trading", "Imports", "Supply", "Farms"];

/** A CSV the import scene reads, deterministic like the rest of the demo shop. */
function writeSuppliers(): void {
  const rows = Array.from({ length: SUPPLIERS }, (_, index) => {
    const id = index + 1;
    const name = `${SUPPLIER_NAMES[index % SUPPLIER_NAMES.length] ?? ""} ${SUPPLIER_SUFFIXES[index % SUPPLIER_SUFFIXES.length] ?? ""}`;
    const since = `${String(2012 + (id % 13))}-${String(1 + (id % 12)).padStart(2, "0")}-15`;
    const rating = (3 + ((id * 7) % 21) / 10).toFixed(1);
    return [String(id), name, COUNTRIES[(id * 3) % COUNTRIES.length] ?? "", since, rating].join(",");
  });
  writeFileSync(SUPPLIERS_FILE, ["id,name,country,since,rating", ...rows, ""].join("\n"));
}

const SHOP_SERVER = { ...POSTGRES_CONFIG, database: SHOP_DATABASE };
const HOLDING_UPDATE = "UPDATE products SET stock = stock + 0 WHERE id = 1";
const BLOCKED_UPDATE = "UPDATE products SET stock = stock - 1 WHERE id = 1";

async function run(session: Session, sql: string): Promise<void> {
  const result = await session.execute(sql);
  for await (const _row of result.rows) {
    // Drained so the statement completes.
  }
}

function gridCell(page: Page, row: number, column: number): Locator {
  return page.locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]:visible`);
}

function header(page: Page, column: string): Locator {
  return page.locator(`[role="columnheader"][data-column-name="${column}"]`);
}

function hideServices(page: Page): Promise<void> {
  return toolWindow(page, "Services").getByRole("button", { name: "Hide Services" }).click();
}

function keyRows(page: Page, kind: string): Locator {
  return toolWindow(page, "Database").locator(`[role="treeitem"][data-kind="${kind}"]`);
}

function keyRow(page: Page, kind: string, label: string): Locator {
  return keyRows(page, kind).filter({ hasText: label }).first();
}

function keyTab(page: Page): Locator {
  return page.getByTestId("key-tab");
}

async function expandKeyRow(page: Page, row: Locator): Promise<void> {
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await row.getAttribute("aria-expanded")) === "true") return;
  await clickVisibly(page, row);
  await pressVisibly(page, "ArrowRight");
  await expect.poll(() => row.getAttribute("aria-expanded")).toBe("true");
}

/** Connects `cache` and waits for its database 3 to list keys, off camera. */
async function cacheKeys(page: Page): Promise<void> {
  await connect(page, CACHE, REDIS_CONFIG.password);
  await datasourceRow(page, CACHE).click();
  await page.keyboard.press("ArrowRight");
  await keyRows(page, "keyFolder").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Replaces what the focused field holds with `text`, typed for the reader. */
async function retype(page: Page, field: Locator, text: string): Promise<void> {
  await clickVisibly(page, field);
  await page.keyboard.press("ControlOrMeta+A");
  await typeSlowly(page, text);
}

mediaSuite("README feature media", () => {
  scene("modify-table", {
    setup: async ({ page }) => {
      await shopTables(page);
    },
    run: async ({ page }) => {
      await selectInTree(page, "products");
      await pressVisibly(page, "Mod+F6");
      const designer = page.getByRole("dialog").filter({ has: page.getByTestId("design-name") });
      await designer.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, designer.getByRole("button", { name: "Add Column", exact: true }));
      await retype(page, designer.getByLabel(/^Name of column_\d+$/).last(), "weight_kg");
      await retype(page, designer.getByLabel("Type of weight_kg", { exact: true }), "numeric(6,2)");
      await page.keyboard.press("Tab");
      const ddl = designer.getByTestId("object-ddl").locator(".cm-line");
      await expect.poll(async () => (await ddl.allTextContents()).join("\n")).toContain("weight_kg");
      await pointAt(page, ddl.first());
      await pause(page, READ_PAUSE_MS);
      const apply = designer.getByRole("button", { name: "Apply", exact: true });
      await expect.poll(() => apply.isEnabled()).toBe(true);
      await clickVisibly(page, apply);
      await designer.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, treeRow(page, "products"));
      await pressVisibly(page, "ArrowRight");
      await clickVisibly(page, treeRow(page, "columns 6"));
      await pressVisibly(page, "ArrowRight");
      await treeRow(page, "weight_kg numeric(6,2)").or(treeRow(page, "weight_kg")).first().waitFor();
    },
  });

  scene("inspections", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await hideServices(page);
      await setConsoleText(page, "SELECT count(*) AS orders FROM orders;\n");
    },
    run: async ({ page }) => {
      await typeSlowly(page, "DELETE FROM orders;");
      await page.keyboard.press("Escape");
      const warning = sqlEditor(page).locator(".tc-problem-warning").first();
      await warning.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pointAt(page, warning);
      await page.locator(".tc-problem-tooltip").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, warning);
      await pressVisibly(page, "Alt+Enter");
      const actions = page.getByRole("listbox", { name: "Context actions" });
      await actions.waitFor();
      await pause(page);
      await clickVisibly(page, actions.getByRole("option", { name: /Add WHERE clause/ }));
      await typeSlowly(page, "status = 'cancelled'");
      await page.keyboard.press("ControlOrMeta+End");
      await typeSlowly(page, "\nSELECT status, count(*) FROM orders GROUP BY status;");
      await page.keyboard.press("Escape");
      await pause(page);
      await pressVisibly(page, "Mod+Shift+Enter");
      const question = page.getByTestId("error-question");
      await question.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pointAt(page, question);
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, question.getByRole("button", { name: "Skip", exact: true }));
      await expect
        .poll(() => page.getByRole("log", { name: "Output" }).locator("[data-tone]").last().textContent(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toContain("3 run, 1 failed.");
      await pause(page, READ_PAUSE_MS);
    },
  });

  scene("grid-helpers", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await hideServices(page);
      await setConsoleText(page, "SELECT * FROM products ORDER BY id");
      await page.keyboard.press("Escape");
    },
    run: async ({ page }) => {
      await pressVisibly(page, "Mod+Enter");
      await waitForRows(page, /^30 rows/);
      await pause(page);
      await clickVisibly(page, gridCell(page, 0, 1));
      await pressVisibly(page, "Mod+F");
      await page.getByTestId("find-input").waitFor();
      await typeSlowly(page, "Brewing");
      await expect.poll(() => page.getByTestId("find-status").textContent()).toBe("1 of 15");
      await pause(page);
      const find = page.getByRole("search", { name: "Find in result" });
      await clickVisibly(page, find.getByRole("button", { name: "Filter Rows", exact: true }));
      await waitForRows(page, /^15 of 30 rows/);
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, page.getByTestId("find-input"));
      await pressVisibly(page, "Escape");
      await waitForRows(page, /^30 rows/);
      await clickVisibly(page, gridCell(page, 0, 2));
      await clickVisibly(page, header(page, "category"), { button: "right" });
      await clickVisibly(page, page.getByRole("menuitem", { name: "Filter by This Value", exact: true }));
      await expect.poll(() => resultState(page).textContent()).toMatch(/^3 of 30 rows/);
      await pause(page);
      await clickVisibly(page, gridCell(page, 0, 3));
      await clickVisibly(page, gridCell(page, 2, 3), { shift: true });
      await page.getByTestId("aggregate-line").locator('[data-aggregate="sum"]').waitFor();
      await pointAt(page, page.getByTestId("aggregate-line"));
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, gridCell(page, 0, 1));
      await pressVisibly(page, "Mod+Alt+T");
      await page.locator("[data-transposed]").waitFor();
    },
  });

  scene("import", {
    setup: async ({ app, page }) => {
      writeSuppliers();
      await shopTables(page);
      await app.evaluate(({ dialog }, picked) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [picked] });
      }, SUPPLIERS_FILE);
    },
    run: async ({ page }) => {
      await clickVisibly(page, treeRow(page, NAMESPACE), { button: "right" });
      await clickVisibly(page, page.getByRole("menuitem", { name: /^Import Data into New Table/ }));
      const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("import-file") });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, dialog.getByRole("button", { name: "Browse…" }));
      await dialog.getByTestId("import-preview").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
      await pointAt(page, dialog.getByTestId("import-columns"));
      await pause(page);
      await pointAt(page, dialog.getByTestId("import-ddl"));
      await pause(page, READ_PAUSE_MS);
      const start = dialog.getByRole("button", { name: "Import", exact: true });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await clickVisibly(page, start);
      await dialog.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      await toolWindow(page, "Services")
        .locator('[role="treeitem"][data-kind="import"][data-state="done"]')
        .waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await selectInTree(page, "suppliers");
      await pressVisibly(page, "F4");
      await cell(page, 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    },
  });

  let importHome = "";
  scene("import-datasources", {
    env: () => {
      importHome = mkdtempSync(join(tmpdir(), "table-craft-readme-import-"));
      const fixture = writeImportFixture(importHome, {
        mysql: { host: MYSQL_CONFIG.host, port: MYSQL_CONFIG.port },
        postgres: { host: POSTGRES_CONFIG.host, port: POSTGRES_CONFIG.port },
        passwords: "keepass",
        platform: process.platform,
        password: MYSQL_CONFIG.password,
      });
      return { HOME: fixture.home };
    },
    teardown: () => {
      rmSync(importHome, { recursive: true, force: true });
      return Promise.resolve();
    },
    setup: () => Promise.resolve(),
    run: async ({ page }) => {
      await pressVisibly(page, "Mod+Shift+A");
      await typeSlowly(page, "Import Data Sources");
      await pause(page);
      await pressVisibly(page, "Enter");
      const dialog = page.getByRole("dialog", { name: "Import Data Sources" });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const dataGrip = dialog.getByTestId("import-source-datagrip");
      await expect.poll(() => dataGrip.isEnabled(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      await pause(page);
      await clickVisibly(page, dataGrip);
      await dialog.getByTestId("import-rows").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
      await pointAt(page, dialog.getByTestId("import-row").filter({ hasText: "Prod via bastion" }));
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, dialog.getByRole("button", { name: "Import", exact: true }));
      await dialog.getByTestId("import-summary").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, dialog.getByRole("button", { name: "Done", exact: true }));
      await dialog.waitFor({ state: "detached" });
      const folder = treeNode(page, "DataGrip").first();
      await clickVisibly(page, folder);
      await pressVisibly(page, "ArrowRight");
      await expect.poll(() => folder.getAttribute("aria-expanded")).toBe("true");
    },
  });

  scene("routine", {
    setup: async ({ page }) => {
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await page.keyboard.press("Escape");
      await expandQuietly(page, NAMESPACE);
    },
    run: async ({ page }) => {
      const routines = toolWindow(page, "Database").getByRole("treeitem", { name: /^routines \d+$/ });
      await clickVisibly(page, routines);
      await pressVisibly(page, "ArrowRight");
      const restock = toolWindow(page, "Database").getByRole("treeitem", { name: /^restock\b/ });
      await restock.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await clickVisibly(page, restock, { button: "right" });
      await clickVisibly(page, page.getByRole("menuitem", { name: /^Execute Routine/ }));
      const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("routine-sql") });
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      await retype(page, dialog.getByLabel("Value of product_id", { exact: true }), "1");
      await retype(page, dialog.getByLabel("Value of quantity", { exact: true }), "24");
      await pointAt(page, dialog.getByTestId("routine-sql"));
      await pause(page, READ_PAUSE_MS);
      const execute = dialog.getByRole("button", { name: "Run", exact: true });
      await expect.poll(() => execute.isEnabled()).toBe(true);
      await clickVisibly(page, execute);
      await dialog.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      await expect
        .poll(() => page.getByRole("gridcell").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("37");
    },
  });

  let holder: Session | null = null;
  scene("sessions", {
    setup: async ({ page }) => {
      holder = await postgres.connect(SHOP_SERVER, { readOnly: false });
      await run(holder, "BEGIN");
      await run(holder, HOLDING_UPDATE);
      await connect(page, SHOP, PASSWORD);
      await openConsole(page, SHOP);
      await startStatement(page, BLOCKED_UPDATE);
      await page.keyboard.press("Escape");
    },
    teardown: async () => {
      const held = holder;
      holder = null;
      await held?.close().catch(() => undefined);
    },
    run: async ({ page }) => {
      await clickVisibly(page, datasourceRow(page, SHOP), { button: "right" });
      await clickVisibly(page, page.getByRole("menuitem", { name: /^Show Sessions…/ }));
      const view = page.getByTestId("sessions-view");
      const button = (name: string) => view.getByRole("button", { name, exact: true });
      const rows = page.getByTestId("sessions-grid").locator("tbody tr");
      const blocked = rows.filter({ hasText: BLOCKED_UPDATE });
      await expect
        .poll(
          async () => {
            if ((await blocked.count()) === 0) await button("Refresh Sessions").click();
            return blocked.first().getAttribute("data-tone");
          },
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toBe("danger");
      await pause(page, READ_PAUSE_MS);
      const holding = rows.filter({ hasText: HOLDING_UPDATE }).first();
      await clickVisibly(page, holding);
      await pointAt(page, page.getByTestId("sessions-details"));
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, button("Terminate Session…"));
      const confirm = page.getByRole("dialog", { name: "Terminate Session" });
      await confirm.waitFor();
      await pause(page);
      await clickVisibly(page, confirm.getByRole("button", { name: "Terminate", exact: true }));
      await expect
        .poll(() => page.getByTestId("sessions-status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^Terminated session \d+\.$/);
      await pause(page);
      await clickVisibly(page, button("Refresh Sessions"));
      await expect.poll(() => blocked.first().getAttribute("data-tone")).not.toBe("danger");
    },
  });

  scene("redis-keys", {
    alsoSaved: [CACHE_REDIS],
    setup: async ({ page }) => {
      await loadShopRedis();
      await cacheKeys(page);
    },
    run: async ({ page }) => {
      await expandKeyRow(page, keyRow(page, "keyFolder", "session:"));
      await pause(page);
      await expandKeyRow(page, keyRow(page, "keyFolder", "cart:"));
      await pause(page);
      const filter = toolWindow(page, "Database").getByTestId("key-filter").first();
      await clickVisibly(page, filter);
      await typeSlowly(page, "product:*");
      await pressVisibly(page, "Enter");
      await expect
        .poll(() => keyRows(page, "keyFolder").first().getAttribute("aria-label"), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^product: /);
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, filter);
      await page.keyboard.press("ControlOrMeta+A");
      await pressVisibly(page, "Backspace");
      await pressVisibly(page, "Enter");
      const cart = keyRow(page, "keyEntry", "{1042}");
      await expandKeyRow(page, keyRow(page, "keyFolder", "cart:"));
      await clickVisibly(page, cart, { double: true });
      await expect
        .poll(() => keyTab(page).getByTestId("key-name").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("cart:{1042}");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, keyTab(page).locator('[role="gridcell"][data-row="2"][data-col="1"]'));
      await pressVisibly(page, "Enter");
      const field = keyTab(page).locator("[data-editing] input");
      await field.waitFor();
      await page.keyboard.press("ControlOrMeta+A");
      await typeSlowly(page, "6");
      await pressVisibly(page, "Enter");
      await keyTab(page).getByTestId("pending-changes").waitFor();
      await pause(page);
      await clickVisibly(page, keyTab(page).getByRole("button", { name: "Preview Pending Changes", exact: true }));
      const preview = page.getByRole("dialog");
      await expect.poll(() => preview.textContent()).toContain("atomically");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, preview.getByRole("button", { name: "Submit", exact: true }));
      await expect
        .poll(() => keyTab(page).getByTestId("key-notice").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("saved atomically");
    },
  });

  scene("redis-console", {
    alsoSaved: [CACHE_REDIS],
    setup: async ({ page }) => {
      await loadShopRedis();
      await connect(page, CACHE, REDIS_CONFIG.password);
      await openConsole(page, CACHE);
      await hideServices(page);
    },
    run: async ({ page }) => {
      await typeSlowly(page, "KEYS *");
      await page.keyboard.press("Escape");
      const warning = sqlEditor(page).locator(".tc-problem-warning").first();
      await warning.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pointAt(page, warning);
      await expect.poll(() => page.locator(".tc-problem-fix").first().textContent()).toContain("Use SCAN");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, sqlEditor(page));
      await page.keyboard.press("ControlOrMeta+A");
      await typeSlowly(page, "HGETALL cart:{1042}");
      await page.keyboard.press("Escape");
      await pause(page);
      await pressVisibly(page, "Mod+Enter");
      await gridCell(page, 0, 1).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, gridCell(page, 2, 1));
      await pressVisibly(page, "Enter");
      await page.locator("[data-editing] input").waitFor();
      await page.keyboard.press("ControlOrMeta+A");
      await typeSlowly(page, "6");
      await pressVisibly(page, "Enter");
      await page.getByTestId("pending-changes").first().waitFor();
      await pause(page);
      await pressVisibly(page, "Mod+Shift+P");
      const preview = page.getByRole("dialog");
      await expect.poll(() => preview.textContent()).toContain("atomically");
      await pause(page, READ_PAUSE_MS);
      await clickVisibly(page, preview.getByRole("button", { name: "Submit", exact: true }));
      await preview.waitFor({ state: "detached" });
      await pause(page);
      await clickVisibly(page, page.getByRole("button", { name: "Open Key", exact: true }));
      await expect
        .poll(() => keyTab(page).getByTestId("key-name").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe("cart:{1042}");
    },
  });
});
