/**
 * Plan 041's live test: SQL files on disk. Open a file into a console and run it, edit it and see
 * it autosave (decision 089), press the save chords in a scratch console, Save As from a scratch
 * console, rename it, reopen the app onto the same file console, see an external edit, and Run SQL
 * Script on a 100 MB file with progress and cancel, and on a script that
 * stops at its error. SQLite always runs; PostgreSQL and MySQL need the `test/db/compose.yml`
 * containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/041 bun run test:smoke:db:headless test/e2e/sqlFiles.smoke.test.ts
 */
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  closeApp,
  consoleToolbar,
  DATABASES_ENABLED,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  showServices,
} from "./harness.js";

const captureWindow = evidenceFor("041");

type Plugin = typeof postgres;

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

/** The brief's size for the streamed run: far more than the renderer could hold as text. */
const LARGE_SCRIPT_BYTES = 100 * 1024 * 1024;
/** Statements the scenario waits for before it cancels, so the run is visibly under way. */
const SHOWN_PROGRESS_STATEMENTS = 2_000;
const LARGE_SCENARIO_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 3;
const LIVE_TABLE = "script_live";
const ERROR_TABLE = "script_error";
/** Pushes an external edit's mtime clear of the save's, whatever the file system's resolution. */
const LATER_SECONDS = 5;

function sqlite(path = seededSqliteFile()): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path } };
}

async function asOwner(plugin: Plugin, config: object, sql: string): Promise<unknown[][]> {
  const session = await plugin.connect(config, { readOnly: false });
  try {
    const result = await session.execute(sql);
    const rows: unknown[][] = [];
    for await (const row of result.rows) rows.push([...row]);
    return rows;
  } finally {
    await session.close();
  }
}

function sqliteRows(path: string, sql: string): unknown[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

/** Main's open dialog answers `paths` from now on, as if the user picked them. */
async function answerOpenDialog(app: ElectronApplication, paths: readonly string[]): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [...picked] });
  }, paths);
}

async function answerSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: picked });
  }, path);
}

/** What the window's focus event does: file consoles compare their files on disk. */
async function refocus(page: Page): Promise<void> {
  await page.evaluate("window.dispatchEvent(new Event('focus'))");
}

function editorText(page: Page): Promise<string> {
  return sqlEditor(page)
    .locator(".cm-line")
    .allTextContents()
    .then((lines) => lines.join("\n"));
}

function dirtyDot(page: Page) {
  return activeEditorTab(page).getByTestId("tab-dirty");
}

function scriptRows(page: Page, state?: string) {
  const rows = toolWindow(page, "Services").locator('[role="treeitem"][data-kind="script"]');
  return state === undefined ? rows : rows.and(page.locator(`[data-state="${state}"]`));
}

async function scriptStatements(page: Page): Promise<number> {
  const text = (await scriptRows(page).first().getByTestId("script-progress").textContent()) ?? "";
  const match = /^([\d,]+) statement/.exec(text);
  return match === null ? 0 : Number(match[1]?.replaceAll(",", ""));
}

/** A table, then INSERTs of about a hundred bytes each until the file holds `bytes`. */
function writeLargeScript(path: string, bytes: number): void {
  const descriptor = openSync(path, "w");
  try {
    writeSync(descriptor, `CREATE TABLE ${LIVE_TABLE} (id integer, label varchar(100));\n`);
    let written = 0;
    let id = 1;
    while (written < bytes) {
      const lines: string[] = [];
      for (let index = 0; index < 10_000; index += 1, id += 1) {
        lines.push(
          `INSERT INTO ${LIVE_TABLE} VALUES (${String(id)}, 'row ${String(id)} of the streamed live script');`,
        );
      }
      const chunk = `${lines.join("\n")}\n`;
      writeSync(descriptor, chunk);
      written += Buffer.byteLength(chunk);
    }
  } finally {
    closeSync(descriptor);
  }
}

const BROKEN_SCRIPT = [
  `CREATE TABLE ${ERROR_TABLE} (id integer);`,
  `INSERT INTO ${ERROR_TABLE} VALUES (1);`,
  "  SELEC broken;",
  `INSERT INTO ${ERROR_TABLE} VALUES (2);`,
  "",
].join("\n");

describe.runIf(SMOKE_ENABLED)("SQL files live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  /** A relaunch onto `userDataDir` may meet a notice first, so it does not wait for Run. */
  async function launch(datasource: Datasource, userDataDir?: string): Promise<RunningApp> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (userDataDir === undefined) {
      await waitUntilReady(running.page);
      await showServices(running.page);
    }
    return running;
  }

  function folder(): string {
    const directory = mkdtempSync(join(tmpdir(), "table-craft-sql-files-"));
    scratch.push(directory);
    return directory;
  }

  function file(directory: string, name: string, content: string): string {
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  }

  /** Open File… with the dialog answering `paths`; resolves once the last one's tab is active. */
  async function openFiles(current: RunningApp, paths: readonly string[], activeTitle: string): Promise<void> {
    await answerOpenDialog(current.app, paths);
    await sqlEditor(current.page).click();
    await pressChord(current.page, "O");
    await expect.poll(() => activeEditorTab(current.page).getAttribute("title")).toContain(activeTitle);
  }

  /** Opens `report.sql`, runs it and edits it, which autosaves it: the daily loop on one database. */
  async function openRunEditSave(datasource: Datasource, label: string): Promise<void> {
    const current = await launch(datasource);
    const { page } = current;
    const directory = folder();
    const path = file(directory, "report.sql", "SELECT 41 AS answer;\n");

    await openFiles(current, [path], "report.sql");
    await expect.poll(() => editorText(page)).toBe("SELECT 41 AS answer;\n");
    await runAllButton(page).click();
    await page.getByRole("columnheader", { name: /answer/ }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect(consoleToolbar(page).getByTestId("console-datasource").textContent()).resolves.toContain(
      datasource.id,
    );
    await captureWindow(page, `open-and-run-${label}`);

    await sqlEditor(page).fill("SELECT 42 AS answer;\n");
    await expect.poll(() => readFileSync(path, "utf8")).toBe("SELECT 42 AS answer;\n");
    await dirtyDot(page).waitFor({ state: "detached" });
    await captureWindow(page, `autosaved-${label}`);
    await sqlEditor(page).fill("SELECT 43 AS answer;\n");
    await pressChord(page, "S");
    await expect.poll(() => readFileSync(path, "utf8")).toBe("SELECT 43 AS answer;\n");
  }

  it(
    "givenSqliteFile_whenOpenedRunEditedAndSaved_thenRunsAndDiskMatches",
    async () => {
      await openRunEditSave(sqlite(), "sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenPostgresFile_whenOpenedRunEditedAndSaved_thenRunsAndDiskMatches",
    async () => {
      await openRunEditSave(POSTGRES, "postgres");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenMysqlFile_whenOpenedRunEditedAndSaved_thenRunsAndDiskMatches",
    async () => {
      await openRunEditSave(MYSQL, "mysql");
    },
    SCENARIO_TIMEOUT_MS,
  );

  /** Both chords from inside the editor of a scratch console reach the native save dialog. */
  it(
    "givenTypingInScratchConsole_whenSaveChordsPressed_thenSaveDialogOpens",
    async () => {
      const { app, page } = await launch(sqlite());
      await app.evaluate(({ dialog }) => {
        const record = globalThis as { saveDialogTitles?: string[] };
        record.saveDialogTitles = [];
        dialog.showSaveDialog = (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          record.saveDialogTitles?.push(options.title ?? "");
          return Promise.resolve({ canceled: true, filePath: "" });
        };
      });
      const titles = () =>
        app.evaluate(() => (globalThis as { saveDialogTitles?: string[] }).saveDialogTitles?.length ?? 0);
      await sqlEditor(page).click();
      await page.keyboard.type("SELECT 1;");
      await pressChord(page, "Shift+S");
      await expect.poll(titles).toBe(1);
      await pressChord(page, "S");
      await expect.poll(titles).toBe(2);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenScratchConsole_whenSavedAsRenamedAndAppReopened_thenFileConsoleComesBackOnItsDatasource",
    async () => {
      const datasource = sqlite();
      const first = await launch(datasource);
      const directory = folder();
      const saved = join(directory, "orders.sql");
      const gone = file(directory, "gone.sql", "SELECT 'gone';\n");

      await sqlEditor(first.page).fill("SELECT count(*) AS orders FROM orders;\n");
      await answerSaveDialog(first.app, saved);
      await pressChord(first.page, "Shift+S");
      await expect.poll(() => activeEditorTab(first.page).textContent()).toContain("orders.sql");
      expect(readFileSync(saved, "utf8")).toBe("SELECT count(*) AS orders FROM orders;\n");
      await captureWindow(first.page, "save-as-from-scratch");

      await findAction(first.page, "Rename File");
      const prompt = first.page.getByRole("dialog", { name: "Rename File" });
      await prompt.getByLabel("File name", { exact: true }).fill("order-count.sql");
      await captureWindow(first.page, "rename-prompt");
      await prompt.getByRole("button", { name: "Rename", exact: true }).click();
      await expect.poll(() => activeEditorTab(first.page).textContent()).toContain("order-count.sql");
      const renamed = join(directory, "order-count.sql");
      expect(readFileSync(renamed, "utf8")).toBe("SELECT count(*) AS orders FROM orders;\n");
      await captureWindow(first.page, "renamed");

      await openFiles(first, [gone], "gone.sql");
      await editorTabs(first.page).filter({ hasText: "order-count.sql" }).click();
      await closeApp(first.app);
      running = null;
      rmSync(gone);

      const second = await launch(datasource, first.userDataDir);
      const notice = second.page.getByRole("dialog", { name: "A file did not reopen" });
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect(notice.textContent()).resolves.toContain("gone.sql");
      await captureWindow(second.page, "reopen-missing-file");
      await notice.getByRole("button", { name: "OK", exact: true }).click();
      await waitUntilReady(second.page);
      await expect.poll(() => activeEditorTab(second.page).getAttribute("title")).toBe(renamed);
      expect(await editorTabs(second.page).filter({ hasText: "gone.sql" }).count()).toBe(0);
      await expect(consoleToolbar(second.page).getByTestId("console-datasource").textContent()).resolves.toContain(
        datasource.id,
      );
      await runAllButton(second.page).click();
      await second.page.getByRole("columnheader", { name: /orders/ }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(second.page, "reopened-file-console");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenFileChangedOnDisk_whenFocus_thenCleanReloadsDirtyBannersAndKeepMineWrites",
    async () => {
      const current = await launch(sqlite());
      const { page } = current;
      const directory = folder();
      const path = file(directory, "watched.sql", "SELECT 1;\n");
      await openFiles(current, [path], "watched.sql");

      writeFileSync(path, "SELECT 2; -- edited outside\n");
      const later = Date.now() / 1000 + LATER_SECONDS;
      utimesSync(path, later, later);
      await refocus(page);
      await expect.poll(() => editorText(page)).toBe("SELECT 2; -- edited outside\n");
      expect(await dirtyDot(page).count()).toBe(0);
      await captureWindow(page, "external-edit-reloaded");

      // The edit lands on disk before the autosave reads the file's time, so it banners, not overwrites.
      writeFileSync(path, "SELECT 4; -- theirs\n");
      utimesSync(path, later + LATER_SECONDS, later + LATER_SECONDS);
      await sqlEditor(page).fill("SELECT 3; -- mine\n");
      const banner = page.getByTestId("disk-changed");
      await banner.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(readFileSync(path, "utf8")).toBe("SELECT 4; -- theirs\n");
      await captureWindow(page, "external-edit-banner");

      await pressChord(page, "W");
      const ask = page.getByRole("dialog", { name: "Unsaved file" });
      await ask.waitFor();
      await captureWindow(page, "close-conflict-asks");
      await ask.getByRole("button", { name: "Cancel", exact: true }).click();
      await ask.waitFor({ state: "detached" });
      await expect.poll(() => activeEditorTab(page).getAttribute("title")).toBe(path);

      await banner.getByRole("button", { name: "Keep mine", exact: true }).click();
      await banner.waitFor({ state: "detached" });
      expect(readFileSync(path, "utf8")).toBe("SELECT 3; -- mine\n");
      await pressChord(page, "W");
      await expect.poll(() => editorTabs(page).filter({ hasText: "watched.sql" }).count()).toBe(0);
      expect(await ask.count()).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  /** Run SQL Script… from the datasource's tree menu, on a 100 MB file, cancelled mid-way. */
  async function runLargeAndCancel(datasource: Datasource, label: string): Promise<void> {
    const current = await launch(datasource);
    const { page } = current;
    const path = join(folder(), "large.sql");
    writeLargeScript(path, LARGE_SCRIPT_BYTES);

    await answerOpenDialog(current.app, [path]);
    await treeNode(page, datasource.id).click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Run SQL Script/ }).click();
    await scriptRows(page, "running").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect
      .poll(() => scriptStatements(page), { timeout: LAUNCH_TIMEOUT_MS })
      .toBeGreaterThan(SHOWN_PROGRESS_STATEMENTS);
    await expect(scriptRows(page).first().getByTestId("script-progress").textContent()).resolves.toMatch(
      /of 10\d(\.\d)? MB/,
    );
    await captureWindow(page, `script-running-${label}`);

    await scriptRows(page, "running").locator('[data-action="script.cancel"]').click();
    await scriptRows(page, "cancelled").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await captureWindow(page, `script-cancelled-${label}`);
  }

  it(
    "givenLargeScriptOnSqlite_whenRunScriptThenCancelled_thenProgressShownAndRunStops",
    async () => {
      await runLargeAndCancel(sqlite(), "sqlite");
    },
    LARGE_SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenLargeScriptOnPostgres_whenRunScriptThenCancelled_thenProgressShownAndRunStops",
    async () => {
      await asOwner(postgres, POSTGRES_CONFIG, `DROP TABLE IF EXISTS public.${LIVE_TABLE}`);
      try {
        await runLargeAndCancel(POSTGRES, "postgres");
      } finally {
        await asOwner(postgres, POSTGRES_CONFIG, `DROP TABLE IF EXISTS public.${LIVE_TABLE}`);
      }
    },
    LARGE_SCENARIO_TIMEOUT_MS,
  );

  /** Run SQL Script… from Find Action on a script that fails at line 3, then Go to statement. */
  async function runBroken(datasource: Datasource, label: string): Promise<void> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, console: { runAllOnError: "stop" } });
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await showServices(running.page);
    const current = running;
    const { page } = current;
    const path = file(folder(), "broken.sql", BROKEN_SCRIPT);

    await answerOpenDialog(current.app, [path]);
    await sqlEditor(page).click();
    await findAction(page, "Run SQL Script");
    const notice = page.getByRole("dialog", { name: "SQL script failed" });
    await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect(notice.textContent()).resolves.toContain("broken.sql, line 3, column 3");
    await captureWindow(page, `script-failed-notice-${label}`);
    await notice.getByRole("button", { name: "OK", exact: true }).click();

    const failed = scriptRows(page, "failed");
    await expect(failed.getByTestId("script-error").textContent()).resolves.toMatch(/^line 3: /);
    await expect(failed.getByTestId("script-progress").textContent()).resolves.toMatch(/^2 statements/);
    await captureWindow(page, `script-failed-${label}`);
    await failed.locator('[data-action="script.goTo"]').click();
    await expect.poll(() => activeEditorTab(page).getAttribute("title")).toBe(path);
    await expect.poll(() => page.locator(".tc-statement-flash").allTextContents()).toEqual(["SELEC"]);
    await expect.poll(() => page.locator(".tc-error-mark").allTextContents()).toEqual(["SELEC"]);
    await captureWindow(page, `script-go-to-statement-${label}`);
  }

  it(
    "givenScriptErrorOnSqlite_whenRunScript_thenStopsAndLinksStatement",
    async () => {
      const database = seededSqliteFile();
      await runBroken(sqlite(database), "sqlite");
      expect(sqliteRows(database, `SELECT id FROM ${ERROR_TABLE}`)).toEqual([{ id: 1 }]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenScriptErrorOnMysql_whenRunScript_thenStopsAndLinksStatement",
    async () => {
      await asOwner(mysql, MYSQL_CONFIG, `DROP TABLE IF EXISTS ${ERROR_TABLE}`);
      try {
        await runBroken(MYSQL, "mysql");
        expect(await asOwner(mysql, MYSQL_CONFIG, `SELECT id FROM ${ERROR_TABLE}`)).toEqual([[1]]);
      } finally {
        await asOwner(mysql, MYSQL_CONFIG, `DROP TABLE IF EXISTS ${ERROR_TABLE}`);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
