/**
 * Plan 158's live test: the page size goes into a plain SELECT as a row limit (decision 162), and
 * each fetch runs the statement again with a larger one. Each server shows the text it received.
 * Gated, because it needs a display, a fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql,postgres,mssql,oracle TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/158 \
 *     bun run test:smoke:db:headless test/e2e/rowLimit.smoke.test.ts
 *
 * The suite makes and drops `row_cap_probe` in MySQL.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import {
  databaseEnabled,
  MSSQL_CONFIG,
  MYSQL_CONFIG,
  MYSQL_ROOT_CONFIG,
  ORACLE_CONFIG,
  POSTGRES_CONFIG,
  WITHOUT_POSTGRES,
} from "../support/databases.js";
import {
  activeEditorTab,
  answerExportDialog,
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  columnSnapshot,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  optionValue,
  pressChord,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedSettings,
  setWindowSize,
  showServices,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("158");
const MARKER = "row_cap_live";
const SERIES_ROWS = 50_000;
const POSTGRES_SERIES = `SELECT g AS n, '${MARKER}' AS marker FROM generate_series(1, ${String(SERIES_ROWS)}) g`;
/** MySQL caps recursive CTEs at 1,000 levels, so its rows come from a cross join of digits. */
const DIGITS =
  "(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
const SQLITE_SERIES = "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 10000) SELECT n FROM g";
const NO_MOTION = { version: 1, appearance: { motion: "off", theme: "light" } };
const SMALL_PAGE = 100;
const PROBE_TABLE = "row_cap_probe";
const PROBE_ROWS = 250;
const PROBE_SETUP = [
  `DROP TABLE IF EXISTS ${PROBE_TABLE}`,
  `CREATE TABLE ${PROBE_TABLE} (id int PRIMARY KEY, label varchar(20) NOT NULL)`,
  [
    `INSERT INTO ${PROBE_TABLE} (id, label)`,
    `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < ${String(PROBE_ROWS)})`,
    "SELECT n, CONCAT('row ', n) FROM g",
  ].join(" "),
];

interface Target {
  readonly name: string;
  readonly enabled: boolean;
  readonly datasource: Datasource;
  readonly rows: string;
  /** Lists the text the server received from other sessions holding the marker. */
  readonly serverText: string;
  /** What the server saw after Fetch Next Page, with the default page of 500. */
  readonly secondRun: string;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    enabled: databaseEnabled("postgres"),
    datasource: { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG },
    rows: POSTGRES_SERIES,
    serverText: `SELECT right(query, 32) AS ends_with, query FROM pg_stat_activity WHERE query LIKE '%${MARKER}%' AND pid <> pg_backend_pid()`,
    secondRun: "LIMIT 1001",
  },
  {
    name: "mysql",
    enabled: databaseEnabled("mysql"),
    // root reads performance_schema; the fixture user has no grant on it.
    datasource: { id: "mysql-root", pluginId: "mysql", config: MYSQL_ROOT_CONFIG },
    rows: `SELECT 1 + a.d + 10 * b.d + 100 * c.d + 1000 * e.d AS n, '${MARKER}' AS marker FROM ${DIGITS} a, ${DIGITS} b, ${DIGITS} c, ${DIGITS} e`,
    // The compose MySQL keeps neither statement text nor digests (performance_schema_max_sql_text_length
    // and performance_schema_max_digest_length are 0), so the rows each run of the 10,000 sent stand in.
    serverText: `SELECT EVENT_ID, CONCAT('sent ', ROWS_SENT, ' rows') AS sent FROM performance_schema.events_statements_history WHERE THREAD_ID <> PS_CURRENT_THREAD_ID() AND ROWS_SENT > 500`,
    secondRun: "sent 1001 rows",
  },
  {
    name: "mssql",
    enabled: databaseEnabled("mssql"),
    datasource: { id: "mssql", pluginId: "mssql", config: MSSQL_CONFIG },
    rows: `SELECT ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n, '${MARKER}' AS marker FROM sys.all_objects a CROSS JOIN sys.all_objects b`,
    serverText: `SELECT t.text FROM sys.dm_exec_connections c CROSS APPLY sys.dm_exec_sql_text(c.most_recent_sql_handle) t WHERE t.text LIKE '%${MARKER}%' AND c.session_id <> @@SPID`,
    secondRun: "SELECT TOP (1001) ROW_NUMBER()",
  },
  {
    name: "oracle",
    enabled: databaseEnabled("oracle"),
    datasource: { id: "ora", pluginId: "oracle", config: ORACLE_CONFIG },
    rows: `SELECT level AS n, '${MARKER}' AS marker FROM dual CONNECT BY level <= ${String(SERIES_ROWS)}`,
    serverText: `SELECT SUBSTR(sql_text, -32) AS ends_with, sql_text FROM v$sql WHERE sql_text LIKE '%${MARKER}%' AND sql_text NOT LIKE '%v$sql%'`,
    secondRun: "FETCH FIRST 1001 ROWS ONLY",
  },
];

const POSTGRES = TARGETS[0]!.datasource;
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

function resultState(page: Page) {
  return page.getByTestId("result-state");
}

function resultToolbar(page: Page) {
  return page.getByRole("toolbar", { name: "Result" });
}

function toolbarButton(page: Page, name: string) {
  return resultToolbar(page).getByRole("button", { name, exact: true });
}

function resultTab(page: Page, title: string) {
  return page
    .getByRole("tablist", { name: "Results" })
    .getByRole("tab")
    .filter({ hasText: new RegExp(`^${title}$`) });
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function tableEditor(page: Page) {
  return page.getByTestId("table-editor");
}

function exportRows(page: Page, state: string) {
  return toolWindow(page, "Services").locator(`[role="treeitem"][data-kind="export"][data-state="${state}"]`);
}

async function cellsWith(page: Page, text: string): Promise<string[]> {
  return (await gridText(page)).cells.filter((cell) => cell.includes(text));
}

async function onMysql(statements: readonly string[]): Promise<void> {
  const session = await mysql.connect(mysql.connectionSchema.parse(MYSQL_CONFIG), { readOnly: false });
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const row of result.rows) void row;
    }
  } finally {
    await session.close();
  }
}

describe.runIf(SMOKE_ENABLED)("row limit in the SQL live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  beforeAll(async () => {
    if (DATABASES_ENABLED && databaseEnabled("mysql")) await onMysql(PROBE_SETUP);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (DATABASES_ENABLED && databaseEnabled("mysql")) await onMysql([`DROP TABLE IF EXISTS ${PROBE_TABLE}`]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource, settings: object = NO_MOTION): Promise<Page> {
    const userDataDir = newProfile();
    scratch.push(userDataDir);
    seedSettings(userDataDir, settings);
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  function csvPath(name: string): string {
    const folder = mkdtempSync(join(tmpdir(), "table-craft-row-limit-"));
    scratch.push(folder);
    return join(folder, name);
  }

  TARGETS.forEach((target, index) => {
    const step = String(index + 1).padStart(2, "0");
    it.runIf(DATABASES_ENABLED && target.enabled)(
      `givenPlainSelectOn_${target.name}_whenRunThenNextPage_thenTheServerSawEachLimit`,
      async () => {
        const page = await launch(target.datasource);
        await runStatement(page, target.rows);
        await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("500+ rows");
        await toolbarButton(page, "Fetch Next Page").click();
        await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("1,000+ rows");
        expect(await toolbarButton(page, "Fetch Next Page").isEnabled()).toBe(true);
        await captureWindow(page, `${step}-${target.name}-next-page`);

        await openConsoleOn(page, target.datasource.id);
        await waitUntilReady(page);
        await runStatement(page, target.serverText);
        await expect
          .poll(async () => (await cellsWith(page, target.secondRun)).length, { timeout: LAUNCH_TIMEOUT_MS })
          .toBeGreaterThan(0);
        await captureWindow(page, `${step}-${target.name}-server-text`);
      },
      SCENARIO_TIMEOUT_MS * 2,
    );
  });

  it.runIf(DATABASES_ENABLED && !WITHOUT_POSTGRES)(
    "givenRowLimitedResult_whenFetchAll_thenOneRunReadsEveryRow",
    async () => {
      const page = await launch(POSTGRES);
      await runStatement(page, POSTGRES_SERIES);
      await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("500+ rows");
      await toolbarButton(page, "Fetch All").click();
      await expect
        .poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`${SERIES_ROWS.toLocaleString("en-US")} rows`);
      expect(await toolbarButton(page, "Fetch All").isDisabled()).toBe(true);
      await captureWindow(page, "05-postgres-fetch-all");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.runIf(DATABASES_ENABLED && !WITHOUT_POSTGRES)(
    "givenOwnLimit_whenRun_thenTheServerSawTheStatementAsWritten",
    async () => {
      const own = `SELECT g AS n, '${MARKER}' AS marker FROM generate_series(1, ${String(SERIES_ROWS)}) g LIMIT 2000`;
      const page = await launch(POSTGRES);
      await runStatement(page, own);
      await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("500+ rows");

      await openConsoleOn(page, POSTGRES.id);
      await waitUntilReady(page);
      await runStatement(page, TARGETS[0]!.serverText);
      await expect
        .poll(async () => cellsWith(page, "LIMIT"), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([own.slice(-32), own]);
      await captureWindow(page, "06-postgres-own-limit");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it.runIf(DATABASES_ENABLED && !WITHOUT_POSTGRES)(
    "givenFailingSelects_whenRun_thenErrorsNameTheStatementAsWritten",
    async () => {
      const page = await launch(POSTGRES);
      await runStatement(page, "SELECT g, no_such_column FROM generate_series(1, 10) g");
      await consoleAlert(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await consoleAlert(page).textContent()).toContain("no_such_column");
      await captureWindow(page, "07-postgres-error-position");

      await runStatement(page, "SELECT g FROM generate_series(1, 10) g WHERE");
      await expect
        .poll(async () => (await consoleAlert(page).textContent()) ?? "", { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(/syntax error at end of input/);
      expect(await consoleAlert(page).textContent()).not.toContain("LIMIT");
      await captureWindow(page, "08-postgres-unfinished");
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const mode of ["auto", "manual"] as const) {
    it.runIf(DATABASES_ENABLED && !WITHOUT_POSTGRES)(
      `givenRowLimitedResultIn_${mode}_mode_whenExported_thenEveryRowWritten`,
      async () => {
        const page = await launch(POSTGRES);
        await showServices(page);
        if (mode === "manual") {
          const select = page.getByLabel("Transaction mode", { exact: true });
          await expect.poll(() => select.isEnabled()).toBe(true);
          await chooseOption(select, "manual");
          await expect.poll(() => optionValue(select)).toBe("manual");
        }
        await runStatement(page, POSTGRES_SERIES);
        await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("500+ rows");

        const path = csvPath(`${mode}.csv`);
        await toolbarButton(page, "Export Data…").click();
        await answerExportDialog(page, path, "CSV");
        await exportRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        expect(await exportRows(page, "done").first().getAttribute("aria-label")).toContain(
          `${SERIES_ROWS.toLocaleString("en-US")} rows`,
        );
        const lines = readFileSync(path, "utf8").trimEnd().split(/\r?\n/);
        expect(lines).toHaveLength(SERIES_ROWS + 1);
        expect(lines.at(-1)).toBe(`${String(SERIES_ROWS)},${MARKER}`);
        await captureWindow(page, `${mode === "auto" ? "09" : "10"}-postgres-export-${mode}`);
      },
      SCENARIO_TIMEOUT_MS * 2,
    );
  }

  it.runIf(DATABASES_ENABLED && databaseEnabled("mysql"))(
    "givenSortedTable_whenNextPageThenEdited_thenOrderKeptAndFetchWaitsForTheEdit",
    async () => {
      const page = await launch(MYSQL, { ...NO_MOTION, data: { pageRows: SMALL_PAGE } });
      const tree = toolWindow(page, "Database");
      const group = tree.getByRole("treeitem", { name: /^tables \d+$/ }).first();
      await group.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      if ((await group.getAttribute("aria-expanded")) !== "true") {
        await group.click();
        await page.keyboard.press("ArrowRight");
      }
      await tree.getByRole("treeitem", { name: PROBE_TABLE, exact: true }).click();
      await page.keyboard.press("F4");
      await expect.poll(() => activeEditorTab(page).textContent()).toContain(PROBE_TABLE);
      const editor = tableEditor(page);
      const state = editor.getByTestId("result-state");
      await expect.poll(() => state.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(`${String(SMALL_PAGE)}+ rows`);

      const idHeader = editor.locator('[role="columnheader"][data-column-name="id"]');
      await idHeader.click();
      await idHeader.click();
      await expect.poll(() => idHeader.getAttribute("aria-sort")).toBe("descending");
      const ids = () => columnSnapshot(editor.locator('[role="gridcell"][data-col="0"]'));
      const descending = (values: readonly string[]) =>
        values.map(Number).every((value, at, all) => at === 0 || all[at - 1]! > value);

      const fetchNext = editor.getByRole("button", { name: "Fetch Next Page", exact: true });
      await fetchNext.click();
      await expect
        .poll(() => state.textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`${String(SMALL_PAGE * 2)}+ rows`);
      expect(await idHeader.getAttribute("aria-sort")).toBe("descending");
      expect(descending(await ids())).toBe(true);
      await captureWindow(page, "11-mysql-table-sorted-next-page");

      await editor.locator('[role="gridcell"][data-row="0"][data-col="1"]').click();
      await page.keyboard.press("Enter");
      const field = editor.locator("[data-editing] input");
      await field.waitFor();
      await field.fill("edited");
      await field.press("Enter");
      await expect.poll(() => field.count()).toBe(0);
      await expect.poll(() => fetchNext.isDisabled()).toBe(true);
      await captureWindow(page, "12-mysql-table-pending-edit");
      await findAction(page, "Revert All");
      await expect.poll(() => fetchNext.isEnabled()).toBe(true);
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenRowLimitSwitchedOff_whenAnotherStatementRuns_thenTheOpenCursorStops",
    async () => {
      const page = await launch(SCRATCH);
      await pressChord(page, ",");
      await settingsDialog(page).waitFor();
      await settingsDialog(page).getByRole("tab", { name: "Data Editor", exact: true }).click();
      const toggle = settingsDialog(page).getByLabel("Write the page size into the SQL as a row limit");
      expect(await toggle.isChecked()).toBe(true);
      await toggle.uncheck();
      await toggle.scrollIntoViewIfNeeded();
      await captureWindow(page, "13-setting-off");
      await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect.poll(() => settingsDialog(page).count()).toBe(0);

      await runStatement(page, SQLITE_SERIES);
      await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("500+ rows");
      await page.getByRole("button", { name: "Pin Result 1" }).click();
      await runStatement(page, "SELECT 1 AS one");
      await resultTab(page, "Result 1").click();
      await expect.poll(() => resultState(page).textContent()).toBe("500+ rows · fetching stopped");
      await captureWindow(page, "14-setting-off-cursor-stopped");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
