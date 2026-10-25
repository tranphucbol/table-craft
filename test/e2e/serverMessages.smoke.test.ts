/**
 * Plan 033's live test: server warnings and notices, and Explain on TiDB 4, against TiDB, MySQL and
 * PostgreSQL from the `test/db/compose.yml` databases. Gated, because it needs a display,
 * a fresh build and the containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/033 bun run test:smoke:db:headless test/e2e/serverMessages.smoke.test.ts
 *
 * It creates `order_events_202601` in TiDB's `test` database and drops it afterwards.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import { MYSQL_CONFIG, POSTGRES_CONFIG, TIDB_CONFIG, TIDB_DATABASE, WITHOUT_POSTGRES } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  runAllButton,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("033");

const TIDB: Datasource = { id: "tidb", pluginId: "mysql", config: TIDB_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };

const EVENTS_TABLE = "order_events_202601";
const EVENTS_INDEX = "order_events_shop_id";
const FIXED_STATEMENT = `EXPLAIN SELECT /*+ USE_INDEX(${EVENTS_TABLE}, ${EVENTS_INDEX}) */ * FROM ${EVENTS_TABLE} LIMIT 10;`;
const HINT_WITHOUT_TABLE = `SELECT /*+ USE_INDEX(${EVENTS_INDEX}) */ * FROM ${EVENTS_TABLE} LIMIT 10`;
const FIXED_SELECT = `SELECT /*+ USE_INDEX(${EVENTS_TABLE}, ${EVENTS_INDEX}) */ * FROM ${EVENTS_TABLE} LIMIT 10`;
const WARNING_1815 = `Warning 1815: use_index(${TIDB_DATABASE}.${EVENTS_INDEX}) is inapplicable, check whether the table(${TIDB_DATABASE}.${EVENTS_INDEX}) exists`;
const MYSQL_WARNING = "SELECT CAST('1x' AS SIGNED) AS n";
const PG_NOTICE = "DO $$ BEGIN RAISE NOTICE 'server messages live test'; END $$";

/** Runs `statements` on TiDB straight through the plugin, outside the app. */
async function onTidb(statements: readonly string[]): Promise<void> {
  const session = await mysql.connect(TIDB_CONFIG, { readOnly: false });
  try {
    for (const sql of statements) {
      for await (const _row of (await session.execute(sql)).rows) {
        // Drained so the statement completes before the next.
      }
    }
  } finally {
    await session.close();
  }
}

async function editorText(page: Page): Promise<string> {
  return (await page.locator('[data-testid="sql-editor"] .cm-line').allTextContents()).join("\n");
}

async function typeStatement(page: Page, sql: string): Promise<void> {
  await sqlEditor(page).fill(sql);
  await expect.poll(() => editorText(page)).toBe(sql);
}

function outputEntries(page: Page) {
  return page.getByRole("log", { name: "Output" }).locator("[data-tone]");
}

function resultTab(page: Page, title: string) {
  return page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: title });
}

function warningBadge(page: Page) {
  return page.getByTestId("warning-badge");
}

function popup(page: Page) {
  return page.locator(".cm-tooltip-autocomplete");
}

describe.runIf(DATABASES_ENABLED)("server warnings and TiDB Explain live test", () => {
  let running: RunningApp | null = null;

  beforeAll(async () => {
    await onTidb([
      `DROP TABLE IF EXISTS ${EVENTS_TABLE}`,
      `CREATE TABLE ${EVENTS_TABLE} (id BIGINT PRIMARY KEY, shop_id INT NOT NULL, state VARCHAR(16), KEY ${EVENTS_INDEX} (shop_id))`,
      `INSERT INTO ${EVENTS_TABLE} VALUES (1, 10, 'new'), (2, 20, 'done'), (3, 10, 'done')`,
    ]);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    await onTidb([`DROP TABLE IF EXISTS ${EVENTS_TABLE}`]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  it(
    "givenHintWithoutTableOnTidb_whenRun_thenWarning1815InOutputAndBadge",
    async () => {
      const page = await launch(TIDB);

      await runStatement(page, HINT_WITHOUT_TABLE);

      await expect.poll(() => warningBadge(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("1");
      expect(await warningBadge(page).getAttribute("aria-label")).toBe("1 warning");
      await resultTab(page, "Output").click();
      await expect
        .poll(() => outputEntries(page).allTextContents())
        .toEqual(expect.arrayContaining([expect.stringContaining(WARNING_1815)]));
      expect(await outputEntries(page).last().getAttribute("data-tone")).toBe("warning");
      await captureWindow(page, "warning-1815");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFixedHintOnTidb_whenExplainRun_thenIndexLookUpOnTheIndex",
    async () => {
      const page = await launch(TIDB);

      await runStatement(page, FIXED_STATEMENT);

      const { cells } = await gridText(page);
      expect(cells.join("\n")).toMatch(/IndexLookUp/);
      expect(cells.join("\n")).toContain(`index:${EVENTS_INDEX}(shop_id)`);
      expect(cells.join("\n")).not.toMatch(/TableFullScan/);
      expect(await warningBadge(page).count()).toBe(0);
      await captureWindow(page, "hint-index-used");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFixedHintOnTidb_whenExplainPlanPressed_thenTreeFromTheTidbTable",
    async () => {
      const page = await launch(TIDB);

      await typeStatement(page, FIXED_SELECT);
      await page.getByRole("button", { name: "Explain Plan", exact: true }).click();

      const tree = page.getByRole("treegrid");
      await tree.locator("tbody").getByRole("row").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await waitUntilReady(page);
      const rows = tree.locator("tbody").getByRole("row");
      expect(await rows.first().textContent()).toContain("IndexLookUp");
      expect(await rows.nth(1).getAttribute("aria-level")).toBe("2");
      expect(await tree.textContent()).toContain(EVENTS_INDEX);
      await captureWindow(page, "tidb-explain-tree");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenMysqlWarningAndPostgresNotice_whenRun_thenOutputListsThem",
    async () => {
      let page = await launch(MYSQL);
      await runStatement(page, MYSQL_WARNING);
      await expect.poll(() => warningBadge(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toBe("1");
      await resultTab(page, "Output").click();
      await expect
        .poll(() => outputEntries(page).allTextContents())
        .toEqual(
          expect.arrayContaining([expect.stringContaining("Warning 1292: Truncated incorrect INTEGER value: '1x'")]),
        );
      await captureWindow(page, "mysql-warning");
      await closeApp(running?.app);
      running = null;

      page = await launch(POSTGRES);
      await typeStatement(page, PG_NOTICE);
      await runAllButton(page).click();
      await expect
        .poll(() => outputEntries(page).allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining([expect.stringContaining("Note 00000: server messages live test")]));
      await sqlEditor(page).press("Escape");
      await popup(page).waitFor({ state: "hidden" });
      await captureWindow(page, "pg-notice");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
