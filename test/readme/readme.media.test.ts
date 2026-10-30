/**
 * Records the README's GIFs (plan 016, decision 036) from the built app against the demo shop:
 * PostgreSQL `shop` in the `test:db` container, reloaded before every scene, a SQLite `shop.db`
 * built fresh and, for the Redis scenes, database 3 of the `test:db` `redis` service. Gated,
 * because it needs a display, a fresh build, Docker and ffmpeg:
 *
 *   bun run readme:media                          every GIF
 *   README_MEDIA=explain,grid bun run readme:media   only those
 *
 * Each scene sets up off camera (connect, open a console, fill text a reader need not watch typed),
 * then records only what the GIF is about, paced by `pace.ts` for a reader. This file holds the
 * plan 016 scenes, `features.media.test.ts` the plan 061 ones, `scenes.ts` what they share.
 */
import { join } from "node:path";
import { expect } from "vitest";
import { POSTGRES_CONFIG } from "../support/databases.js";
import {
  activeEditorTab,
  consoleToolbar,
  dataSourcesDialog,
  exportDialog,
  LAUNCH_TIMEOUT_MS,
  paletteInput,
  paletteRows,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  chooseOption,
} from "../e2e/harness.js";
import { stubSaveDialog } from "../e2e/workflows.js";
import { clickVisibly, pause, pointAt, pressVisibly, typeSlowly } from "./pace.js";
import {
  acceptCompletion,
  cell,
  clickInConsole,
  connect,
  datasourceRow,
  editCell,
  editor,
  executions,
  expandVisibly,
  EXPORT_DIRECTORY,
  filterBar,
  mediaSuite,
  NAMESPACE,
  openConsole,
  PASSWORD,
  previewAndSubmit,
  READ_PAUSE_MS,
  resultTab,
  resultToolbarButton,
  scene,
  selectInTree,
  setConsoleText,
  SHOP,
  shopTables,
  sortTableBy,
  TABLES_GROUP,
  treeRow,
  waitForRows,
} from "./scenes.js";
import { SHOP_DATABASE } from "./shop.js";

mediaSuite("README media", () => {
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
      await chooseOption(mode, "manual");
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
      await chooseOption(extractor, "markdown");
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
