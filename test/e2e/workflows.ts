/**
 * The daily loop (plan 014): DataGrip's daily workflows 1–11 and 14–18
 * (`docs/design/datagrip-inventory.md`, section 11) chained in one window on one saved datasource,
 * asserting the state each step leaves before the next starts. The workflow suite runs it on the
 * development build against every database, the packaged suite on the packaged app against SQLite.
 *
 * The loop writes to `edit_probe` (edit, insert, delete), so a suite running it on a shared database
 * puts that table back afterwards; SQLite runs get a fresh seeded file each time.
 */
import { readFileSync } from "node:fs";
import type { ElectronApplication, Locator, Page } from "playwright-core";
import { expect } from "vitest";
import {
  activeEditorTab,
  answerSecretPrompt,
  columnSnapshot,
  editorTabs,
  exportDialog,
  LAUNCH_TIMEOUT_MS,
  openConsoleOn,
  paletteInput,
  paletteRows,
  pressChord,
  pressDoubleShift,
  runAllButton,
  runStatement,
  sqlEditor,
  toolWindow,
  treeNode,
  waitUntilReady,
  showServices,
} from "./harness.js";

/** What the loop needs to know about the datasource it drives. */
export interface LoopTarget {
  /** The saved datasource's name in the Database pane. */
  readonly name: string;
  /** Typed into the connect prompt; `undefined` for a datasource without one. */
  readonly password?: string;
  /** The namespace the tree opens on: `main`, `public`, `table_craft`. */
  readonly namespace: string;
  /** Where the stubbed save dialog sends the export (`stubSaveDialog`). */
  readonly exportPath: string;
}

export const DAILY_LOOP_STEPS = [
  "connect",
  "browse",
  "open table",
  "filter and sort",
  "edit and submit",
  "insert and delete",
  "new console",
  "run",
  "search everywhere",
  "export csv",
  "ddl",
  "sql generator",
  "follow foreign key",
  "query history",
  "explain plan",
] as const;

export type LoopStep = (typeof DAILY_LOOP_STEPS)[number];

/**
 * `edit_probe` as the fixture seeds it, so a suite can put it back after the loop, which deletes
 * row 2. Ids are explicit so the sequence does not matter.
 */
export const EDIT_PROBE_RESET = [
  "DELETE FROM edit_probe WHERE id > 0",
  `INSERT INTO edit_probe (id, label, qty, note, doc) VALUES (1, 'first', 1, NULL, '{"tags": ["a"]}'), (2, 'second', 2, 'kept', NULL)`,
] as const;

const TABLES_GROUP = "tables 6";
const CUSTOMERS_SQL = "SELECT * FROM customers ORDER BY id";
const CUSTOMERS_CSV = "id,name,email\n1,Ada Lovelace,ada@example.com\n2,Grace Hopper,grace@example.com\n";
const JOIN_SQL = "SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.total > 10";
const ORDERS_SELECT = /^SELECT id, customer_id, total, placed_at\nFROM \S*orders\S*;$/;
const ORDERS_OF_ADA = "customer_id = 1";
const NEWEST_FIRST = "id desc";
const EDITED_LABEL = "edited";
const DEFAULT_LABEL = "new";
const APPLY_ATTEMPTS = 3;
const APPLY_WAIT_MS = 3_000;

/** Makes Electron's save dialog answer `filePath`, as a user picking it would. */
export async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
  }, filePath);
}

/**
 * Runs every step of the loop on `target`, which the app shows saved and not yet connected, and
 * returns the steps it completed. A failing step throws naming itself.
 */
export async function dailyLoop(page: Page, target: LoopTarget): Promise<readonly LoopStep[]> {
  const done: LoopStep[] = [];
  const step = async (name: LoopStep, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Daily loop on ${target.name}, step "${name}": ${reason}`, { cause: error });
    }
    done.push(name);
  };
  const tab = (relation: string) => `${relation} [${target.name}]`;

  await step("connect", async () => {
    await treeNode(page, target.name).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Connect/ }).click();
    if (target.password !== undefined) await answerSecretPrompt(page, target.name, target.password);
    await expect
      .poll(() => treeNode(page, target.name).getAttribute("data-state"), { timeout: LAUNCH_TIMEOUT_MS })
      .toBe("connected");
  });

  await step("browse", async () => {
    const namespace = treeRow(page, target.namespace);
    await namespace.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    if ((await namespace.getAttribute("aria-expanded")) !== "true") await expand(page, target.namespace);
    await expand(page, TABLES_GROUP);
    for (const relation of ["customers", "orders", "edit_probe"]) {
      await expect.poll(() => treeRow(page, relation).count()).toBe(1);
    }
  });

  await step("open table", async () => {
    await openFromTree(page, "orders");
    expect(await activeEditorTab(page).textContent()).toBe(tab("orders"));
    // Unordered: on a reused PostgreSQL container a reseeded row may land anywhere in the heap.
    await expect.poll(async () => (await columnValues(page, 0)).sort()).toEqual(["1", "2", "3"]);
  });

  await step("filter and sort", async () => {
    await applyFilter(page, ORDERS_OF_ADA, NEWEST_FIRST);
    await expect.poll(() => columnValues(page, 0)).toEqual(["2", "1"]);
    expect(await columnValues(page, 1)).toEqual(["1", "1"]);
  });

  await step("edit and submit", async () => {
    await openFromTree(page, "edit_probe");
    // PostgreSQL returns an updated row last without ORDER BY.
    await applyFilter(page, "", "id");
    await expect.poll(() => columnValues(page, 1)).toEqual(["first", "second"]);
    await editCell(page, 0, 1, EDITED_LABEL);
    await expect.poll(() => pending(page).textContent()).toBe("1 pending change");
    await editorButton(page, "Submit").click();
    await expect.poll(() => notice(page).textContent()).toBe("Submitted 1 statement");
    await expect.poll(() => columnValues(page, 1)).toEqual([EDITED_LABEL, "second"]);
  });

  await step("insert and delete", async () => {
    await cell(page, 1, 0).click();
    await pressChord(page, "Backspace");
    await editorButton(page, "Add Row").click();
    await expect.poll(() => pending(page).textContent()).toBe("2 pending changes");
    expect(await cell(page, 1, 0).getAttribute("data-edit")).toBe("deleted");
    expect(await cell(page, 2, 0).getAttribute("data-edit")).toBe("inserted");
    await editorButton(page, "Submit").click();
    await expect.poll(() => notice(page).textContent()).toBe("Submitted 2 statements");
    await expect.poll(() => columnValues(page, 1)).toEqual([EDITED_LABEL, DEFAULT_LABEL]);
    expect(await pending(page).count()).toBe(0);
  });

  await step("new console", async () => {
    await openConsoleOn(page, target.name);
    await expect.poll(() => activeEditorTab(page).textContent()).toBe(tab("console"));
    await waitUntilReady(page);
  });

  await step("run", async () => {
    await runStatement(page, CUSTOMERS_SQL);
    await expect.poll(() => resultState(page).textContent()).toBe("2 rows");
    const cells = await page.getByRole("gridcell").allTextContents();
    expect(cells).toEqual(expect.arrayContaining(["Ada Lovelace", "Grace Hopper"]));
  });

  await step("search everywhere", async () => {
    await pressDoubleShift(page);
    await page.getByRole("tab", { name: "Tables" }).click();
    await paletteInput(page, "Search Everywhere").fill("customers");
    // PostgreSQL's path names the database between the datasource and the schema.
    await expect
      .poll(() => paletteRows(page).first().textContent())
      .toMatch(new RegExp(`^customers${target.name} › (\\S+ › )?${target.namespace}$`));
    await page.keyboard.press("Enter");
    await expect.poll(() => activeEditorTab(page).textContent()).toBe(tab("customers"));
    await expect.poll(() => columnValues(page, 1)).toEqual(["Ada Lovelace", "Grace Hopper"]);
  });

  await step("export csv", async () => {
    await editorTabs(page)
      .filter({ hasText: tab("console") })
      .click();
    await page.getByRole("columnheader").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await page.getByRole("toolbar", { name: "Result" }).getByRole("button", { name: "Export Data…" }).click();
    const dialog = exportDialog(page);
    await dialog.getByRole("button", { name: "Browse…" }).click();
    await expect.poll(() => dialog.getByTestId("export-file").inputValue()).toBe(target.exportPath);
    await dialog.getByRole("button", { name: "Export", exact: true }).click();
    await resultTab(page, "Output").click();
    await expect
      .poll(() => page.getByRole("log", { name: "Output" }).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
      .toContain(`2 rows exported to ${target.exportPath}`);
    expect(readFileSync(target.exportPath, "utf8")).toBe(CUSTOMERS_CSV);
  });

  await step("ddl", async () => {
    await selectRelation(page, "orders");
    await pressChord(page, "B");
    const ddl = editorTabs(page).filter({ has: page.locator('[data-tab-kind="ddl"]') });
    await expect.poll(() => ddl.count()).toBe(1);
    await expect.poll(() => activeEditorTab(page).textContent()).toBe(tab("orders"));
    await expect.poll(() => linesOf(page, "ddl-text"), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/CREATE TABLE/);
    expect(await linesOf(page, "ddl-text")).toContain("customer_id");
  });

  await step("sql generator", async () => {
    await selectRelation(page, "orders");
    await pressChord(page, "Alt+G");
    const generator = page.getByRole("dialog", { name: "SQL Generator: orders" });
    await generator.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect.poll(() => linesOf(page, "generator-preview")).toMatch(ORDERS_SELECT);
    const select = await linesOf(page, "generator-preview");
    await generator.getByRole("button", { name: "Open in Console", exact: true }).click();
    await expect.poll(() => linesOf(page, "sql-editor")).toBe(select);
    await waitUntilReady(page);
    await runAllButton(page).click();
    await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("3 rows");
  });

  await step("follow foreign key", async () => {
    await editorTabs(page)
      .filter({ hasText: tab("orders") })
      .first()
      .click();
    await expect.poll(() => columnValues(page, 0)).toEqual(["2", "1"]);
    await cell(page, 0, 1).click();
    await pressChord(page, "B");
    await expect.poll(() => activeEditorTab(page).textContent()).toBe(tab("customers"));
    await expect.poll(() => columnValues(page, 1)).toEqual(["Ada Lovelace"]);
  });

  await step("query history", async () => {
    await editorTabs(page)
      .filter({ hasText: tab("console") })
      .click();
    await waitUntilReady(page);
    await sqlEditor(page).fill("");
    await pressChord(page, "Alt+E");
    const history = page.getByRole("dialog", { name: `Query History: ${target.name}` });
    await history.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    const search = history.getByRole("combobox", { name: "Search history" });
    await search.fill("FROM customers ORDER BY");
    await expect.poll(() => history.getByRole("option").first().getAttribute("aria-label")).toBe(CUSTOMERS_SQL);
    await search.press("Enter");
    await history.waitFor({ state: "detached" });
    await expect.poll(() => linesOf(page, "sql-editor")).toBe(CUSTOMERS_SQL);
  });

  await step("explain plan", async () => {
    await sqlEditor(page).fill(JOIN_SQL);
    await expect.poll(() => linesOf(page, "sql-editor")).toBe(JOIN_SQL);
    await pressChord(page, "Shift+E");
    await resultTab(page, "Plan").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    const operations = page.getByRole("treegrid").locator("tbody").getByRole("row");
    await operations.first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await waitUntilReady(page);
    expect(await resultTab(page, "Plan").getAttribute("aria-selected")).toBe("true");
    const operationColumn = await operations.locator("td:first-child").allTextContents();
    expect(operationColumn.join("\n")).toMatch(/\bo\b/);
  });

  return done;
}

function treeRow(page: Page, name: string): Locator {
  return toolWindow(page, "Database").getByRole("treeitem", { name, exact: true });
}

async function expand(page: Page, name: string): Promise<void> {
  const target = treeRow(page, name);
  await target.click();
  if ((await target.getAttribute("aria-expanded")) !== "true") await page.keyboard.press("ArrowRight");
  await expect.poll(() => target.getAttribute("aria-expanded")).toBe("true");
}

/** Selects `relation` under the expanded tables group, leaving focus in the Database pane. */
async function selectRelation(page: Page, relation: string): Promise<void> {
  await treeRow(page, relation).click();
  await expect.poll(() => treeRow(page, relation).getAttribute("aria-selected")).toBe("true");
}

/** Opens a table's data from the Database pane: select its row, press F4. */
async function openFromTree(page: Page, relation: string): Promise<void> {
  await selectRelation(page, relation);
  await page.keyboard.press("F4");
  await expect.poll(() => activeEditorTab(page).textContent()).toContain(relation);
  await cell(page, 0, 0).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

function editor(page: Page): Locator {
  return page.getByTestId("table-editor");
}

function cell(page: Page, row: number, column: number): Locator {
  return editor(page).locator(`[role="gridcell"][data-row="${String(row)}"][data-col="${String(column)}"]`);
}

/** The loaded cells of one column of the table editor, top to bottom. */
async function columnValues(page: Page, column: number): Promise<string[]> {
  return columnSnapshot(editor(page).locator(`[role="gridcell"][data-col="${String(column)}"]`));
}

function filterBar(page: Page, bar: "where" | "order-by"): Locator {
  return editor(page).getByTestId(`filter-${bar}`).locator(".cm-content");
}

/**
 * Fills both bars and applies them with Enter. Typing opens the bar's completion popup once the
 * engine answers; when that lands before Enter, Enter accepts an option instead of applying (as
 * DataGrip's does), so Enter is pressed again until the Services tree shows the rows reloaded.
 */
export async function applyFilter(page: Page, where: string, orderBy: string): Promise<void> {
  await filterBar(page, "where").fill(where);
  await filterBar(page, "order-by").fill(orderBy);
  const executions = (await showServices(page)).locator('[role="treeitem"][data-kind="execution"]');
  const before = await executions.count();
  for (let attempt = 1; ; attempt++) {
    await filterBar(page, "order-by").press("Enter");
    try {
      await expect.poll(() => executions.count(), { timeout: APPLY_WAIT_MS }).toBeGreaterThan(before);
      return;
    } catch (error) {
      if (attempt === APPLY_ATTEMPTS) throw error;
    }
  }
}

/** Writes `text` into a cell through the inline editor: select, Enter, type, Enter. */
async function editCell(page: Page, row: number, column: number, text: string): Promise<void> {
  await cell(page, row, column).click();
  await page.keyboard.press("Enter");
  const field = editor(page).locator("[data-editing] input");
  await field.waitFor();
  await field.fill(text);
  await field.press("Enter");
  await expect.poll(() => field.count()).toBe(0);
}

function editorButton(page: Page, name: string): Locator {
  return editor(page).getByRole("button", { name, exact: true });
}

function pending(page: Page): Locator {
  return editor(page).getByTestId("pending-changes");
}

function notice(page: Page): Locator {
  return editor(page).getByTestId("table-notice");
}

function resultState(page: Page): Locator {
  return page.getByTestId("result-state");
}

function resultTab(page: Page, title: string): Locator {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title}$`) });
}

async function linesOf(page: Page, testId: string): Promise<string> {
  return (await page.getByTestId(testId).locator(".cm-line").allTextContents()).join("\n");
}
