/**
 * A console that ran `USE` keeps its database across the reconnect a slow close forces (decision
 * 054): on TiDB 4, which cannot stop a statement, closing an unfinished result over a large table
 * outlasts the close grace, and the fresh session must replay the `USE` or the next statement
 * fails with "No database selected". Gated, because it needs a display, a fresh build and the
 * `test/db/compose.yml` TiDB:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/027 bun run test:smoke:db
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import { TIDB_CONFIG } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  runButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  startStatement,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("027");

const PROBE_DATABASE = "tc_ns_probe";
const PROBE_TABLE = "big_rows";
const SEED_TABLE = "seed_rows";
const PAD_LENGTH = 100;
/** 2^16 rows in one table, built by doubling inside single statements. */
const DOUBLINGS = 16;
/**
 * Copies of the 2^16-row seed appended one statement at a time, for 2^20 rows: one statement
 * copying more would pass TiDB 4's transaction limits. Reading them all takes about 45 s on the
 * emulated amd64 image, so closing an unfinished result outlasts the engine's 5 s close grace.
 */
const SEED_COPIES = 15;
/**
 * Spread over many regions, so TiDB scans them as the client reads: in one region it answers the
 * whole table in a single response, which finishes reading before the grace and runs TiDB out of
 * memory (found live).
 */
const REGIONS = 64;
const LAST_ROW_ID = 2_000_000;
/** TiDB's scan up to the first rows (~20 s), after the close grace and a reconnect on a second run. */
const RUN_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 600_000;
const RESULT_CLOSE_RECONNECTED = "The previous result could not be closed in time; reconnected.";

/** TiDB with no default database, so only the console's `USE` puts it anywhere. */
const { database: _database, ...TIDB_WITHOUT_DATABASE } = TIDB_CONFIG;

async function asRoot(statements: readonly string[]): Promise<void> {
  const session = await mysql.connect(TIDB_WITHOUT_DATABASE, { readOnly: false });
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

const dropProbe = () => asRoot([`DROP DATABASE IF EXISTS ${PROBE_DATABASE}`]);

async function createProbe(): Promise<void> {
  const table = `${PROBE_DATABASE}.${PROBE_TABLE}`;
  const seed = `${PROBE_DATABASE}.${SEED_TABLE}`;
  await dropProbe();
  await asRoot([
    `CREATE DATABASE ${PROBE_DATABASE}`,
    `CREATE TABLE ${table} (n BIGINT, pad VARCHAR(${PAD_LENGTH}))`,
    `SPLIT TABLE ${table} BETWEEN (0) AND (${LAST_ROW_ID}) REGIONS ${REGIONS}`,
    `INSERT INTO ${table} VALUES (1, REPEAT('x', ${PAD_LENGTH}))`,
    ...Array.from(
      { length: DOUBLINGS },
      () => `INSERT INTO ${table} SELECT n + (SELECT COUNT(*) FROM ${table}), pad FROM ${table}`,
    ),
    `CREATE TABLE ${seed} LIKE ${table}`,
    `INSERT INTO ${seed} SELECT * FROM ${table}`,
    ...Array.from({ length: SEED_COPIES }, () => `INSERT INTO ${table} SELECT * FROM ${seed}`),
    `DROP TABLE ${seed}`,
  ]);
}

function namespaceLabel(page: Page) {
  return page.getByTestId("console-namespace");
}

async function labelText(page: Page): Promise<string | null> {
  return (await namespaceLabel(page).count()) === 0 ? null : namespaceLabel(page).textContent();
}

async function alertText(page: Page): Promise<string> {
  const alert = consoleAlert(page);
  return (await alert.count()) === 0 ? "" : ((await alert.first().textContent()) ?? "");
}

async function showOutput(page: Page): Promise<void> {
  await page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: "Output", exact: true }).click();
}

async function outputText(page: Page): Promise<string> {
  const log = page.getByRole("log", { name: "Output" });
  return (await log.count()) === 0 ? "" : ((await log.first().textContent()) ?? "");
}

describe.runIf(DATABASES_ENABLED)("namespace kept across a reconnect live test", () => {
  let running: RunningApp | null = null;

  beforeAll(createProbe, SETUP_TIMEOUT_MS);
  afterAll(dropProbe);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenTidbUseThenUnfinishedLargeResult_whenRunAgain_thenReconnectsInTheUsedDatabase",
    async () => {
      running = await launchApp({ id: "tidb", pluginId: "mysql", config: TIDB_WITHOUT_DATABASE });
      const { page } = running;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await waitUntilReady(page);
      await startStatement(page, `use ${PROBE_DATABASE}`);
      await expect.poll(() => labelText(page), { timeout: LAUNCH_TIMEOUT_MS }).toBe(PROBE_DATABASE);
      await waitUntilReady(page);
      const select = `select * from ${PROBE_TABLE}`;
      await startStatement(page, select);
      await page.getByRole("columnheader", { name: "pad", exact: true }).waitFor({ timeout: RUN_TIMEOUT_MS });
      await waitUntilReady(page);

      await startStatement(page, select);
      await expect.poll(() => runButton(page).isEnabled()).toBe(false);
      await expect.poll(() => runButton(page).isEnabled(), { timeout: RUN_TIMEOUT_MS }).toBe(true);

      const alert = await alertText(page);
      await captureWindow(page, "07-tidb-use-kept-after-reconnect");
      await showOutput(page);
      const output = await outputText(page);
      await captureWindow(page, "08-tidb-use-kept-after-reconnect-output");
      expect(alert).toBe("");
      expect(output).toContain(RESULT_CLOSE_RECONNECTED);
      expect(output).not.toContain("No database selected");
      expect(await labelText(page)).toBe(PROBE_DATABASE);
    },
    SCENARIO_TIMEOUT_MS * 4,
  );
});
