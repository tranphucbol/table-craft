/**
 * Plan 027's live test: running a statement while the previous result is still being read, on
 * MySQL, TiDB 4 and PostgreSQL, cancelling on a TiDB that cannot stop a statement, reloading a
 * large table twice, and a result whose close never finishes. Gated, because it needs a display, a
 * fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/027 bun run test:smoke:db
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import { chaosProxy, type ChaosProxy } from "../support/chaosProxy.js";
import { MYSQL_CONFIG, POSTGRES_CONFIG, TIDB_CONFIG, serverSkipped } from "../support/databases.js";
import { hundredThousandRows, tenThousandRows } from "../support/manyRows.js";
import {
  activeEditorTab,
  cancelButton,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  expectNotSpinning,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  runButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  startStatement,
  toolWindow,
  waitUntilReady,
  waitUntilSpinning,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("027");
const captureSpinner = evidenceFor("112");

const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const TIDB: Datasource = { id: "tidb", pluginId: "mysql", config: TIDB_CONFIG };
const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };

/** Matches the engine's `CURSOR_CLOSE_GRACE_MS`. */
const CLOSE_GRACE_MS = 5_000;
const LARGE_TABLE = "cursor_probe";
const TIDB_RUNS = 3;
const CANCEL_DEADLINE_MS = 5_000;

async function asOwner(statements: readonly string[]): Promise<void> {
  const session = await mysql.connect(MYSQL_CONFIG, { readOnly: false });
  try {
    for (const sql of statements) {
      const result = await session.execute(sql);
      for await (const _row of result.rows) {
        // Drained so the statement completes before the next.
      }
    }
  } finally {
    await session.close();
  }
}

const dropLargeTable = () => asOwner([`DROP TABLE IF EXISTS ${LARGE_TABLE}`]);

function output(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

async function showOutput(page: Page): Promise<void> {
  await page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: "Output", exact: true }).click();
}

async function outputText(page: Page): Promise<string> {
  const log = output(page);
  return (await log.count()) === 0 ? "" : ((await log.first().textContent()) ?? "");
}

async function alertText(page: Page): Promise<string> {
  const alert = consoleAlert(page);
  return (await alert.count()) === 0 ? "" : ((await alert.first().textContent()) ?? "");
}

/** Runs `sql` and waits for its grid by a column only that statement returns. */
async function runFor(page: Page, sql: string, column: string): Promise<void> {
  await startStatement(page, sql);
  await page.getByRole("columnheader", { name: column, exact: true }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await waitUntilReady(page);
}

function editor(page: Page) {
  return page.getByTestId("table-editor");
}

function filterBar(page: Page, bar: "where" | "order-by") {
  return editor(page).getByTestId(`filter-${bar}`).locator(".cm-content");
}

function firstCell(page: Page) {
  return editor(page).locator('[role="gridcell"][data-row="0"][data-col="0"]');
}

describe.runIf(DATABASES_ENABLED)("closing result live test", () => {
  let running: RunningApp | null = null;
  let proxy: ChaosProxy | null = null;

  beforeAll(dropLargeTable);
  afterAll(dropLargeTable);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await proxy?.close();
    proxy = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  async function unfinishedThenRun(page: Page, column: string): Promise<void> {
    await runFor(page, tenThousandRows(), "pad");
    await runFor(page, `SELECT 1 AS ${column}`, column);
    expect(await alertText(page)).toBe("");
  }

  for (const [step, datasource] of [
    ["01", MYSQL],
    ["04", POSTGRES],
  ] as const) {
    it.skipIf(serverSkipped(datasource.pluginId))(
      `given${datasource.id}UnfinishedResult_whenRunAgain_thenRunsWithoutBusyError`,
      async () => {
        const page = await launch(datasource);

        await unfinishedThenRun(page, "after_unfinished");

        await showOutput(page);
        expect(await outputText(page)).not.toMatch(/still running|Reconnected/);
        await captureWindow(page, `${step}-${datasource.id}-run-after-unfinished`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it(
    "givenTidbUnfinishedResults_whenRunAgainThreeTimes_thenEveryRunSucceeds",
    async () => {
      const page = await launch(TIDB);

      for (let run = 1; run <= TIDB_RUNS; run += 1) await unfinishedThenRun(page, `after_unfinished_${run}`);

      await showOutput(page);
      expect(await outputText(page)).not.toMatch(/still running|Reconnected/);
      await captureWindow(page, "02-tidb-run-after-unfinished-x3");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenTidbSleep_whenCancelled_thenStopsAndSaysTheSessionWasReset",
    async () => {
      const page = await launch(TIDB);

      await startStatement(page, "SELECT SLEEP(30) AS slept");
      await expect.poll(() => cancelButton(page).isEnabled()).toBe(true);
      await waitUntilSpinning(runButton(page));
      await captureSpinner(page, "03-cancel-tidb-spinning");
      const started = Date.now();
      await cancelButton(page).click();
      await waitUntilReady(page);
      const elapsedMs = Date.now() - started;

      expect(elapsedMs).toBeLessThan(CANCEL_DEADLINE_MS);
      await expectNotSpinning(runButton(page));
      await captureSpinner(page, "03-cancel-tidb-after");
      await showOutput(page);
      await expect
        .poll(() => outputText(page))
        .toContain("Cancelled: The statement was cancelled by resetting the session");
      await captureWindow(page, "03-tidb-cancel-resets-session");

      await runFor(page, "SELECT 1 AS after_cancel", "after_cancel");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLargeMysqlTable_whenWhereReloadedTwiceQuickly_thenTheSecondFilterShows",
    async () => {
      await asOwner([`CREATE TABLE ${LARGE_TABLE} AS ${tenThousandRows()}`]);
      const page = await launch(MYSQL);
      const tables = toolWindow(page, "Database").getByRole("treeitem", { name: /^tables \d+$/ });
      await tables.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await tables.click();
      await page.keyboard.press("ArrowRight");
      await toolWindow(page, "Database").getByRole("treeitem", { name: LARGE_TABLE, exact: true }).click();
      await page.keyboard.press("F4");
      await expect.poll(() => activeEditorTab(page).textContent()).toContain(LARGE_TABLE);
      await firstCell(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await filterBar(page, "order-by").fill("n");
      await filterBar(page, "where").fill("n > 10");
      await filterBar(page, "where").press("Enter");
      // The editor ignores a reload while one loads, so the second follows the first's answer at once.
      await expect.poll(() => firstCell(page).textContent()).toBe("11");
      await filterBar(page, "where").fill("n > 20");
      await filterBar(page, "where").press("Enter");

      await expect.poll(() => firstCell(page).textContent()).toBe("21");
      expect(await editor(page).getByTestId("query-error").count()).toBe(0);
      await captureWindow(page, "05-mysql-table-reloaded-twice");
    },
    SCENARIO_TIMEOUT_MS,
  );

  for (const [datasource, config] of [
    [MYSQL, MYSQL_CONFIG],
    [POSTGRES, POSTGRES_CONFIG],
  ] as const) {
    it.skipIf(serverSkipped(datasource.pluginId))(
      `given${datasource.id}ResultWhoseLinkVanished_whenRunAgain_thenReconnectsWithinTheGrace`,
      async () => {
        proxy = await chaosProxy({ host: config.host, port: config.port });
        const page = await launch({ ...datasource, config: { ...config, host: proxy.host, port: proxy.port } });
        await runFor(page, hundredThousandRows(), "pad");

        proxy.strand();
        const started = Date.now();
        await runFor(page, "SELECT 1 AS after_vanished", "after_vanished");
        const elapsedMs = Date.now() - started;

        expect(elapsedMs).toBeGreaterThanOrEqual(CLOSE_GRACE_MS);
        expect(elapsedMs).toBeLessThan(CLOSE_GRACE_MS * 3);
        await showOutput(page);
        await expect
          .poll(() => outputText(page))
          .toContain("The previous result could not be closed in time; reconnected.");
        await captureWindow(page, `06-${datasource.id}-close-vanished-reconnected`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }
});
