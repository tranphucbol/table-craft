/**
 * The live test of exporting a result Run Settings read to the Fetch All limit: the grid stops at
 * the limit, and the export still writes every row past it, from the cursor the result kept. Both
 * scenarios keep the export off the rerun path: in-memory SQLite is private to its session, and
 * MySQL in manual mode has the read's transaction open. MySQL needs the `test/db/compose.yml`
 * containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/export-past-cap \
 *     bun run test:smoke:db:headless test/e2e/exportPastCap.smoke.test.ts
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { databaseEnabled, MYSQL_CONFIG } from "../support/databases.js";
import {
  answerExportDialog,
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleToolbar,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  optionValue,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedSettings,
  setWindowSize,
  showServices,
  SMOKE_ENABLED,
  toolWindow,
  type Datasource,
  type RunningApp,
  waitUntilReady,
} from "./harness.js";

const captureWindow = evidenceFor("export-past-cap");
/** The default Fetch All limit, the one the bug report hit. */
const FETCH_ALL_CAP = 100_000;
const ROWS = 100_500;
const SQLITE_ROWS_SQL = `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < ${String(ROWS)}) SELECT n FROM g`;
/** MySQL caps recursive CTEs at 1,000 levels, so its rows come from a cross join of digits. */
const DIGITS =
  "(SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)";
const MYSQL_ROWS_SQL = `SELECT n FROM (SELECT 1 + a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 10000 * f.d + 100000 * h.d AS n FROM ${DIGITS} a, ${DIGITS} b, ${DIGITS} c, ${DIGITS} e, ${DIGITS} f, ${DIGITS} h) g WHERE n <= ${String(ROWS)} ORDER BY n`;
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const CAPPED_STATE = `${FETCH_ALL_CAP.toLocaleString("en-US")}+ rows · fetch cap reached`;
const EXPORTED_STATE = `${FETCH_ALL_CAP.toLocaleString("en-US")}+ rows · rest exported`;

function gear(page: Page) {
  return consoleToolbar(page).getByRole("button", { name: /^Run Settings…/ });
}

function resultState(page: Page) {
  return page.getByTestId("result-state");
}

function exportRows(page: Page, state: string) {
  return toolWindow(page, "Services").locator(`[role="treeitem"][data-kind="export"][data-state="${state}"]`);
}

async function readAllRows(page: Page): Promise<void> {
  await gear(page).click();
  const popover = page.getByTestId("run-settings");
  await popover.getByRole("group", { name: "Rows" }).locator("label", { hasText: "All" }).click();
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
}

/** The numbers in the CSV's one column, header dropped. */
function exportedNumbers(path: string): number[] {
  const [header, ...lines] = readFileSync(path, "utf8").trimEnd().split(/\r?\n/);
  expect(header).toBe("n");
  return lines.map(Number);
}

describe.runIf(SMOKE_ENABLED)("export past the Fetch All limit", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    const userDataDir = newProfile();
    scratch.push(userDataDir);
    // A row-limited result exports by running again (decision 162); this suite is the cursor's.
    seedSettings(userDataDir, {
      version: 1,
      appearance: { motion: "off", theme: "light" },
      data: { limitInSql: false },
    });
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    await showServices(running.page);
    return running.page;
  }

  function csvPath(name: string): string {
    const folder = mkdtempSync(join(tmpdir(), "table-craft-export-cap-"));
    scratch.push(folder);
    return join(folder, name);
  }

  async function exportPastCap(page: Page, sql: string, path: string, evidence: string): Promise<void> {
    await readAllRows(page);
    await runStatement(page, sql);
    await expect.poll(() => resultState(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(CAPPED_STATE);
    await captureWindow(page, `${evidence}-1-capped`);

    await page
      .getByRole("toolbar", { name: "Result" })
      .getByRole("button", { name: "Export Data…", exact: true })
      .click();
    await answerExportDialog(page, path, "CSV");
    await exportRows(page, "done").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    expect(await exportRows(page, "done").first().getAttribute("aria-label")).toContain(
      `${ROWS.toLocaleString("en-US")} rows`,
    );
    await expect.poll(() => resultState(page).textContent()).toBe(EXPORTED_STATE);

    const numbers = exportedNumbers(path);
    expect(numbers).toHaveLength(ROWS);
    expect(numbers[0]).toBe(1);
    expect(numbers.at(-1)).toBe(ROWS);
    await captureWindow(page, `${evidence}-2-exported`);
  }

  it(
    "givenRowsAllOnPrivateSqlite_whenResultPassesTheCapAndIsExported_thenEveryRowWritten",
    async () => {
      const page = await launch(SCRATCH);
      await exportPastCap(page, SQLITE_ROWS_SQL, csvPath("sqlite.csv"), "01-sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED && databaseEnabled("mysql"))(
    "givenRowsAllInMysqlManualMode_whenResultPassesTheCapAndIsExported_thenEveryRowWritten",
    async () => {
      const page = await launch(MYSQL);
      const mode = page.getByLabel("Transaction mode", { exact: true });
      await expect.poll(() => mode.isEnabled()).toBe(true);
      await chooseOption(mode, "manual");
      await expect.poll(() => optionValue(mode)).toBe("manual");

      await exportPastCap(page, MYSQL_ROWS_SQL, csvPath("mysql.csv"), "02-mysql");
      await expect.poll(() => page.getByText("transaction open", { exact: true }).count()).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
