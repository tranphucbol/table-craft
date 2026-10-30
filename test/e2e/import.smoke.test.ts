/**
 * Plan 021's live test: Import Data from the explorer into an existing table and into a new one,
 * a semicolon-separated UTF-16 file with quoted newlines, bad rows skipped into the rejected file or
 * stopping the import, a link dropped mid-import and resumed, and a cancel. SQLite always runs;
 * PostgreSQL and MySQL need the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/021 bun run test:smoke:db
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import { chaosProxy, type ChaosProxy } from "../support/chaosProxy.js";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  chooseOption,
  optionValue,
} from "./harness.js";

const captureWindow = evidenceFor("021");

const LIVE_TABLE = "import_live";
/** Enough rows that the import is still writing when the scenario looks, over a slowed link. */
const LIVE_ROWS = 60_000;
const COMMIT_EVERY = 5_000;
const SLOW_LINK_BYTES_PER_SECOND = 200_000;
/** Rows the scenario waits for before it breaks the link, so some commits are behind it. */
const SHOWN_PROGRESS_ROWS = 12_000;
const CHAOS_SCENARIO_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 3;
const UTF16_LE_BOM = Buffer.from([0xff, 0xfe]);

type Plugin = typeof postgres;

function sqlite(path = seededSqliteFile()): Datasource {
  return { id: "lite", pluginId: "sqlite", config: { path } };
}

/** Runs `sql` as the fixture's owner outside the app and answers its rows as text. */
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

function liveCsv(rows: number): string {
  const lines = ["id,label"];
  for (let id = 1; id <= rows; id++) lines.push(`${String(id)},"row ${String(id)}, imported live"`);
  return `${lines.join("\n")}\n`;
}

function explorer(page: Page) {
  return toolWindow(page, "Database");
}

function treeRow(page: Page, name: string | RegExp) {
  return explorer(page).getByRole("treeitem", { name, exact: typeof name === "string" });
}

function importDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByTestId("import-file") });
}

function importRows(page: Page, state?: string) {
  const rows = toolWindow(page, "Services").locator('[role="treeitem"][data-kind="import"]');
  return state === undefined ? rows : rows.and(page.locator(`[data-state="${state}"]`));
}

/** The rows the running import reports in its Services line. */
async function importedRows(page: Page): Promise<number> {
  const text = (await importRows(page).first().getByTestId("import-progress").textContent()) ?? "";
  const match = /^([\d,]+) /.exec(text);
  return match === null ? 0 : Number(match[1]?.replaceAll(",", ""));
}

/** Opens the tables group if it is closed, then right-clicks `table` and picks Import. */
async function importInto(page: Page, table: string): Promise<void> {
  const group = treeRow(page, /^tables \d+$/).first();
  await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if ((await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
    await page.keyboard.press("ArrowRight");
  }
  await treeRow(page, table).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Import Data from File/ }).click();
  await importDialog(page).waitFor();
}

/** Types the file and waits for the engine's preview of it. */
async function chooseFile(page: Page, path: string): Promise<void> {
  const dialog = importDialog(page);
  await dialog.getByTestId("import-file").fill(path);
  await dialog.getByTestId("import-preview").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

async function submit(page: Page): Promise<void> {
  const dialog = importDialog(page);
  await expect.poll(() => dialog.getByRole("button", { name: "Import", exact: true }).isEnabled()).toBe(true);
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
}

function sqliteRows(path: string, sql: string): unknown[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

describe.runIf(SMOKE_ENABLED)("CSV import live test", () => {
  let running: RunningApp | null = null;
  let proxy: ChaosProxy | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await proxy?.close();
    proxy = null;
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  function file(name: string, content: string | Buffer): string {
    const directory = mkdtempSync(join(tmpdir(), "table-craft-import-"));
    scratch.push(directory);
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  }

  it(
    "givenCsvWithHeader_whenImportedIntoSqliteTable_thenRowsAddedAndServicesShowsDone",
    async () => {
      const database = seededSqliteFile();
      const page = await launch(sqlite(database));
      const path = file(
        "people.csv",
        'id,name,email\n3,"Hopper, Grace Jr.",gj@example.com\n4,Alan Turing,alan@example.com\n5,Edsger Dijkstra,ewd@example.com\n',
      );

      await importInto(page, "customers");
      await chooseFile(page, path);
      const dialog = importDialog(page);
      await expect.poll(() => optionValue(dialog.getByLabel("Field for email"))).toBe("2");
      await expect(dialog.getByTestId("import-preview").textContent()).resolves.toContain("Hopper, Grace Jr.");
      await captureWindow(page, "import-dialog");
      await submit(page);

      await importRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await importRows(page).first().getAttribute("aria-label")).toMatch(
        /^people\.csv into .*customers.*, done, 3 rows imported/,
      );
      expect(sqliteRows(database, "SELECT name FROM customers WHERE id > 2 ORDER BY id")).toEqual([
        { name: "Hopper, Grace Jr." },
        { name: "Alan Turing" },
        { name: "Edsger Dijkstra" },
      ]);
      await captureWindow(page, "import-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUtf16SemicolonFileWithQuotedNewlines_whenImportedIntoNewTable_thenDdlPreviewedAndTableCreated",
    async () => {
      const database = seededSqliteFile();
      const page = await launch(sqlite(database));
      const text =
        'city;founded;population;note\r\nZürich;1218-01-01;421878;"lake\r\nand river"\r\nKraków;1257-06-05;803282;"rynek ""main"""\r\n';
      const path = file("cities.csv", Buffer.concat([UTF16_LE_BOM, Buffer.from(text, "utf16le")]));

      await treeRow(page, "main").click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Import Data into New Table/ }).click();
      const dialog = importDialog(page);
      await dialog.waitFor();
      await dialog.getByTestId("import-file").fill(path);
      await chooseOption(dialog.getByTestId("import-delimiter"), ";");
      await dialog.getByTestId("import-preview").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => dialog.getByTestId("import-table").inputValue()).toBe("cities");
      await expect
        .poll(async () => (await dialog.getByTestId("import-ddl").locator(".cm-line").allTextContents()).join("\n"))
        .toContain('CREATE TABLE "main"."cities"');
      await expect(dialog.getByTestId("import-summary").textContent()).resolves.toMatch(/^UTF-16 LE/);
      await captureWindow(page, "import-new-table-ddl");
      await submit(page);

      await importRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(sqliteRows(database, "SELECT city, founded, population, note FROM cities ORDER BY city")).toEqual([
        { city: "Kraków", founded: "1257-06-05", population: 803282, note: 'rynek "main"' },
        { city: "Zürich", founded: "1218-01-01", population: 421878, note: "lake\r\nand river" },
      ]);
      // The namespace refreshed when the task ended: its tables group counts the new table.
      const group = treeRow(page, "tables 7");
      await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await group.click();
      await page.keyboard.press("ArrowRight");
      await treeRow(page, "cities").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "import-new-table-done");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenBadRow_whenSkipped_thenRejectedFileHoldsItAndTheRestImported",
    async () => {
      const database = seededSqliteFile();
      const page = await launch(sqlite(database));
      const path = file(
        "mixed.csv",
        "id,name,email\n3,Alan Turing,alan@example.com\n4,Ada Again,ada@example.com\n5,Edsger Dijkstra,ewd@example.com\n",
      );

      await importInto(page, "customers");
      await chooseFile(page, path);
      await importDialog(page)
        .getByRole("radio", { name: /^Skip up to/ })
        .check();
      await submit(page);

      await importRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await importRows(page).first().getAttribute("aria-label")).toMatch(
        /2 rows imported.*1 row rejected into mixed\.csv\.rejected\.csv$/,
      );
      const rejected = readFileSync(`${path}.rejected.csv`, "utf8");
      expect(rejected).toMatch(/^id,name,email,rejected_line,rejected_reason\n4,Ada Again,ada@example\.com,3,.*UNIQUE/);
      expect(sqliteRows(database, "SELECT count(*) AS n FROM customers")).toEqual([{ n: 4 }]);
      await captureWindow(page, "import-rejected");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenBadRow_whenStopPolicy_thenFailedNoticeAndNothingImported",
    async () => {
      const database = seededSqliteFile();
      const page = await launch(sqlite(database));
      const path = file("stop.csv", "id,name,email\n3,Alan Turing,alan@example.com\n4,Ada Again,ada@example.com\n");

      await importInto(page, "customers");
      await chooseFile(page, path);
      await submit(page);

      const notice = page.getByRole("dialog", { name: "Import failed" });
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect(notice.textContent()).resolves.toMatch(/Row 2 \(line 3\).*Nothing was imported/);
      await captureWindow(page, "import-stopped");
      await notice.getByRole("button", { name: "OK", exact: true }).click();
      await importRows(page, "failed").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await importRows(page).first().getAttribute("aria-label")).toMatch(/, failed, 0 rows committed/);
      expect(existsSync(`${path}.rejected.csv`)).toBe(false);
      expect(sqliteRows(database, "SELECT count(*) AS n FROM customers")).toEqual([{ n: 2 }]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenCommitEveryOverPostgres_whenLinkDropped_thenCommittedReportedAndResumeFinishes",
    async () => {
      await asOwner(postgres, POSTGRES_CONFIG, `DROP TABLE IF EXISTS public.${LIVE_TABLE}`);
      await asOwner(postgres, POSTGRES_CONFIG, `CREATE TABLE public.${LIVE_TABLE} (id bigint PRIMARY KEY, label text)`);
      try {
        proxy = await chaosProxy({ host: POSTGRES_CONFIG.host, port: POSTGRES_CONFIG.port });
        const page = await launch({
          id: "pg",
          pluginId: "postgres",
          config: { ...POSTGRES_CONFIG, host: proxy.host, port: proxy.port },
        });
        const path = file("live.csv", liveCsv(LIVE_ROWS));

        await importInto(page, LIVE_TABLE);
        await chooseFile(page, path);
        const dialog = importDialog(page);
        await dialog.getByRole("radio", { name: /^Commit every/ }).check();
        await dialog.getByLabel("Rows per commit").fill(String(COMMIT_EVERY));
        // Skip, not Stop: a link dropped during COMMIT leaves that batch's fate unknown, and Resume
        // then meets its rows again as duplicate keys, which go to the rejected file.
        await dialog.getByRole("radio", { name: /^Skip up to/ }).check();
        await dialog.getByLabel("Rows to reject").fill(String(COMMIT_EVERY));
        await captureWindow(page, "import-commit-every");
        proxy.bytesPerSecond = SLOW_LINK_BYTES_PER_SECOND;
        await submit(page);

        await importRows(page, "running").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await expect
          .poll(() => importedRows(page), { timeout: LAUNCH_TIMEOUT_MS })
          .toBeGreaterThan(SHOWN_PROGRESS_ROWS);
        await expect(page.getByTestId("status-importing").textContent()).resolves.toMatch(/^Importing 1/);
        await captureWindow(page, "import-running");
        proxy.reset();

        const notice = page.getByRole("dialog", { name: "Import failed" });
        await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await expect(notice.textContent()).resolves.toMatch(/[\d,]+ rows (are|were) committed/);
        await captureWindow(page, "import-link-dropped");
        await notice.getByRole("button", { name: "OK", exact: true }).click();

        proxy.bytesPerSecond = 0;
        await importRows(page, "failed").locator('[data-action="import.resume"]').click();
        await importRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        expect(
          await asOwner(
            postgres,
            POSTGRES_CONFIG,
            `SELECT count(*)::text, count(DISTINCT id)::text FROM public.${LIVE_TABLE}`,
          ),
        ).toEqual([[String(LIVE_ROWS), String(LIVE_ROWS)]]);
        await captureWindow(page, "import-resumed");
      } finally {
        await asOwner(postgres, POSTGRES_CONFIG, `DROP TABLE IF EXISTS public.${LIVE_TABLE}`);
      }
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenMysqlTable_whenImportedThenAnotherCancelled_thenFirstKeptAndCancelledRolledBack",
    async () => {
      await asOwner(mysql, MYSQL_CONFIG, `DROP TABLE IF EXISTS ${LIVE_TABLE}`);
      await asOwner(mysql, MYSQL_CONFIG, `CREATE TABLE ${LIVE_TABLE} (id BIGINT PRIMARY KEY, label TEXT)`);
      try {
        proxy = await chaosProxy({ host: MYSQL_CONFIG.host, port: MYSQL_CONFIG.port });
        const page = await launch({
          id: "mysql",
          pluginId: "mysql",
          config: { ...MYSQL_CONFIG, host: proxy.host, port: proxy.port },
        });
        const small = file("first.csv", liveCsv(1_000));
        await importInto(page, LIVE_TABLE);
        await chooseFile(page, small);
        await submit(page);
        await importRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });

        const large = liveCsv(LIVE_ROWS).replace(/^(\d+),/gmu, (_, id: string) => `${String(Number(id) + 1_000)},`);
        const path = file("second.csv", large);
        await importInto(page, LIVE_TABLE);
        await chooseFile(page, path);
        proxy.bytesPerSecond = SLOW_LINK_BYTES_PER_SECOND;
        await submit(page);
        await importRows(page, "running").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await expect
          .poll(() => importedRows(page), { timeout: LAUNCH_TIMEOUT_MS })
          .toBeGreaterThan(SHOWN_PROGRESS_ROWS);
        await importRows(page, "running").locator('[data-action="import.cancel"]').click();

        await importRows(page, "cancelled").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        proxy.bytesPerSecond = 0;
        expect(await asOwner(mysql, MYSQL_CONFIG, `SELECT CAST(COUNT(*) AS CHAR) FROM ${LIVE_TABLE}`)).toEqual([
          ["1000"],
        ]);
        await captureWindow(page, "import-cancelled");
      } finally {
        await asOwner(mysql, MYSQL_CONFIG, `DROP TABLE IF EXISTS ${LIVE_TABLE}`);
      }
    },
    CHAOS_SCENARIO_TIMEOUT_MS,
  );
});
