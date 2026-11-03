/**
 * Plan 148's live test: the SQL Scripts submenu of a schema node writes the whole schema's DDL to a
 * console, the clipboard or a file, on MySQL and SQLite. Gated, because it needs a display, a fresh
 * build and the `test/db/compose.yml` MySQL:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/148 bun run test:smoke:db:headless test/e2e/ddlScript.smoke.test.ts
 *
 * The recreating scenario runs the script in a scratch MySQL database it creates and drops as root.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import { MYSQL_CONFIG, MYSQL_ROOT_CONFIG, TIDB_SCRATCH_PREFIX } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  showServices,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { stubSaveDialog } from "./workflows.js";

const captureWindow = evidenceFor("148");
const writeEvidence = evidenceTextFor("148");

const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
/**
 * `SHOW CREATE VIEW` names the view's definer, `root`, and only an account holding `SET_USER_ID`
 * may create a view for another definer, which `table_craft` does not.
 */
const MYSQL_AS_ROOT: Datasource = { ...MYSQL, config: MYSQL_ROOT_CONFIG };

function sqlite(): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
}

const MYSQL_NAMESPACE = MYSQL_CONFIG.database;
const SQLITE_NAMESPACE = "main";
const TABLES_GROUP = "tables 6";
const SQL_SCRIPTS = "SQL Scripts";
const TO_CONSOLE = "Generate DDL to Console";
const TO_CLIPBOARD = "Generate DDL to Clipboard";
const TO_FILE = "Generate DDL to File…";
const RANDOM_BYTES = 4;
/** On the local MySQL container only; the prefix keeps it recognisable as a run's own. */
const SCRATCH_DATABASE = `${TIDB_SCRATCH_PREFIX}148_${randomBytes(RANDOM_BYTES).toString("hex")}`;
const RELATIONS_SQL = (database: string) =>
  `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${database}' ORDER BY TABLE_NAME`;

/** The whole console document, read from CodeMirror: it draws only the lines in view. */
const CONSOLE_DOC = `(() => {
  const content = document.querySelector('[data-testid="sql-editor"] .cm-content');
  const view = content?.cmTile?.root?.view ?? content?.cmTile?.view;
  return view === undefined ? null : view.state.doc.toString();
})()`;

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string) {
  return explorer(page).getByRole("treeitem", { name, exact: true });
}

function consoleTabs(page: Page) {
  return editorTabs(page).filter({ has: page.locator('[data-tab-kind="console"]') });
}

function consoleDoc(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(CONSOLE_DOC);
}

function output(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

/** The relation names a script creates, in its order. */
function createdNames(script: string): readonly string[] {
  return [...script.matchAll(/^CREATE (?:TABLE|(?:.* )?VIEW) [`"]?([^`"\s(]+)/gm)].map((match) => match[1] ?? "");
}

/** Right-clicks `node`, opens SQL Scripts and leaves the submenu open on its three items. */
async function openSqlScripts(page: Page, node: string): Promise<void> {
  await treeRow(page, node).click({ button: "right" });
  const trigger = page.getByRole("menuitem", { name: SQL_SCRIPTS });
  await trigger.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await trigger.click();
  await page.getByRole("menuitem", { name: TO_CONSOLE }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function chooseScript(page: Page, node: string, item: string): Promise<void> {
  await openSqlScripts(page, node);
  await page.getByRole("menuitem", { name: item }).click();
}

async function asMysqlRoot(statements: readonly string[]): Promise<readonly string[]> {
  const session = await mysql.connect(MYSQL_ROOT_CONFIG, { readOnly: false });
  const lines: string[] = [];
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const row of result.rows) lines.push(row.map(String).join(" "));
    }
  } finally {
    await session.close();
  }
  return lines;
}

describe.runIf(DATABASES_ENABLED)("whole-schema DDL live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await treeRow(running.page, TABLES_GROUP).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  /** Generates the namespace's DDL into a new console and returns its text. */
  async function scriptToConsole(page: Page, node: string): Promise<string> {
    const before = await consoleTabs(page).count();
    await chooseScript(page, node, TO_CONSOLE);
    await expect.poll(() => consoleTabs(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(before + 1);
    await expect.poll(() => consoleDoc(page), { timeout: LAUNCH_TIMEOUT_MS }).toMatch(/^-- /);
    return (await consoleDoc(page)) ?? "";
  }

  it(
    "givenMysqlSchemaNode_whenContextMenu_thenSqlScriptsSubmenuListsThreeTargets",
    async () => {
      const page = await launch(MYSQL);

      await openSqlScripts(page, MYSQL_NAMESPACE);

      for (const item of [TO_CONSOLE, TO_CLIPBOARD, TO_FILE]) {
        expect(await page.getByRole("menuitem", { name: item }).count()).toBe(1);
      }
      await captureWindow(page, "01-menu");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlSchema_whenScriptedToConsoleAndRunInAnEmptyDatabase_thenItHoldsTheSameRelations",
    async () => {
      await asMysqlRoot([`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`, `CREATE DATABASE ${SCRATCH_DATABASE}`]);
      try {
        const page = await launch(MYSQL_AS_ROOT);

        const script = await scriptToConsole(page, MYSQL_NAMESPACE);

        expect(script.split("\n").slice(0, 3)).toEqual([
          `-- ${MYSQL.id}: ${MYSQL_NAMESPACE}`,
          expect.stringMatching(/^-- Generated by TableCraft on \d{4}-\d\d-\d\d$/),
          "-- Routines and sequences are not included.",
        ]);
        const names = createdNames(script);
        expect(names.indexOf("customers")).toBeLessThan(names.indexOf("orders"));
        expect(names.at(-1)).toBe("customer_totals");
        await sqlEditor(page).press("Escape");
        await captureWindow(page, "02-console");

        await sqlEditor(page).press("ControlOrMeta+Home");
        await page.keyboard.type(`USE ${SCRATCH_DATABASE};\n`);
        await waitUntilReady(page);
        await runAllButton(page).click();

        const original = await asMysqlRoot([RELATIONS_SQL(MYSQL_NAMESPACE)]);
        await expect
          .poll(() => asMysqlRoot([RELATIONS_SQL(SCRATCH_DATABASE)]), { timeout: LAUNCH_TIMEOUT_MS })
          .toEqual(original);
        await waitUntilReady(page);
        expect(await output(page).textContent()).not.toMatch(/error/i);

        await pressChord(page, "Alt+Y");
        const scratchNode = treeRow(page, SCRATCH_DATABASE);
        await scratchNode.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await scratchNode.click();
        if ((await scratchNode.getAttribute("aria-expanded")) !== "true") await page.keyboard.press("ArrowRight");
        await expect.poll(() => scratchNode.getAttribute("aria-expanded")).toBe("true");
        await captureWindow(page, "03-recreated");
      } finally {
        await asMysqlRoot([`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`]);
      }
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenSqliteSchema_whenScriptedToClipboard_thenPastingItIntoAConsoleShowsTheScript",
    async () => {
      const page = await launch(sqlite());
      const app = running?.app;
      await app?.evaluate(({ clipboard }) => clipboard.clear());

      await chooseScript(page, SQLITE_NAMESPACE, TO_CLIPBOARD);

      await expect
        .poll(() => app?.evaluate(({ clipboard }) => clipboard.readText()), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/^-- lite: main\n/);
      const copied = (await app?.evaluate(({ clipboard }) => clipboard.readText())) ?? "";
      const names = createdNames(copied);
      expect(names.indexOf("customers")).toBeLessThan(names.indexOf("orders"));
      expect(names).toContain("customer_totals");

      await consoleTabs(page).first().click();
      await sqlEditor(page).click();
      await pressChord(page, "A");
      await pressChord(page, "V");
      await expect.poll(() => consoleDoc(page)).toBe(copied);
      await sqlEditor(page).press("Escape");
      await captureWindow(page, "04-clipboard");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlSchema_whenScriptedToFile_thenAnExportTaskWritesTheScript",
    async () => {
      const page = await launch(MYSQL);
      const directory = mkdtempSync(join(tmpdir(), "table-craft-ddl-script-"));
      scratch.push(directory);
      const path = join(directory, `${MYSQL_NAMESPACE}.sql`);
      if (running !== null) await stubSaveDialog(running.app, path);
      const services = await showServices(page);

      await chooseScript(page, MYSQL_NAMESPACE, TO_FILE);

      const done = services.locator('[role="treeitem"][data-kind="export"][data-state="done"]');
      await done.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await done.textContent()).toMatch(/table_craft\.sql.*relations/);
      const text = readFileSync(path, "utf8");
      expect(text).toMatch(new RegExp(`^-- ${MYSQL.id}: ${MYSQL_NAMESPACE}\n`));
      const names = createdNames(text);
      expect(names.indexOf("customers")).toBeLessThan(names.indexOf("orders"));
      expect(names.at(-1)).toBe("customer_totals");
      writeEvidence("05-file.sql", text);
      await captureWindow(page, "05-file");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteTablesGroup_whenScriptedToConsole_thenOnlyTablesAreScripted",
    async () => {
      const page = await launch(sqlite());

      const script = await scriptToConsole(page, TABLES_GROUP);

      const names = createdNames(script);
      expect(names).toHaveLength(6);
      expect(names).not.toContain("customer_totals");
      expect(script).not.toMatch(/^CREATE VIEW/m);
      // SQLite cannot switch namespaces, so the console must not ask it to (found live).
      await waitUntilReady(page);
      expect(await page.getByText(/currentNamespace/).count()).toBe(0);
      await sqlEditor(page).press("Escape");
      await captureWindow(page, "06-tables-group");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
