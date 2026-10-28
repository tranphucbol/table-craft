/**
 * Drives the built app against Postgres and MySQL in `test/db/compose.yml` and against a seeded
 * SQLite file. Gated, because it needs a display, a fresh build and the containers:
 *
 *   bun run test:smoke:db
 *
 * With `TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/NNN` it also saves one window PNG per scenario.
 */
import { formatCell } from "@table-craft/desktop/renderer/grid/format.js";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, withWrongPassword, serverSkipped } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { TYPE_PROBE_EXPECTED } from "../support/typeProbe.js";
import {
  cancelButton,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  expectNotSpinning,
  gridText,
  launchApp,
  runButton,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  startStatement,
  waitUntilReady,
  waitUntilSpinning,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("002");
const captureSpinner = evidenceFor("112");

const TYPE_PROBE_SQL = "SELECT * FROM type_probe ORDER BY id";
const TYPE_PROBE_HEADERS = [
  "id",
  "small_int",
  "big_int",
  "exact_decimal",
  "unicode_text",
  "flag",
  "doc",
  "payload",
  "day",
  "moment",
];
const TYPE_PROBE_CELLS = TYPE_PROBE_EXPECTED.flat().map((value) => formatCell(value));
const INVALID_SQL = "SELEC * FROM type_probe";
const SLEEP_SECONDS = 30;
/** Long enough for the statement to reach the server before the cancel does. */
const CANCEL_DELAY_MS = 500;
/** Far below `SLEEP_SECONDS`, so passing proves the cancel ended the statement. */
const CANCEL_DEADLINE_MS = 10_000;

interface Target {
  readonly name: string;
  /** A thunk, so the gated-off suite creates no SQLite file. */
  readonly datasource: () => Datasource;
  /** A statement that sleeps for `SLEEP_SECONDS`, when the plugin declares `cancel`. */
  readonly sleepSql?: string;
  readonly wrongPassword?: Datasource;
}

const TARGETS: readonly Target[] = [
  {
    name: "postgres",
    datasource: () => ({ id: "postgres", pluginId: "postgres", config: POSTGRES_CONFIG }),
    sleepSql: `SELECT pg_sleep(${SLEEP_SECONDS})`,
    wrongPassword: { id: "postgres", pluginId: "postgres", config: withWrongPassword(POSTGRES_CONFIG) },
  },
  {
    name: "mysql",
    datasource: () => ({ id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG }),
    sleepSql: `SELECT SLEEP(${SLEEP_SECONDS})`,
    wrongPassword: { id: "mysql", pluginId: "mysql", config: withWrongPassword(MYSQL_CONFIG) },
  },
  {
    name: "sqlite",
    datasource: () => ({ id: "sqlite", pluginId: "sqlite", config: { path: seededSqliteFile() } }),
  },
];

describe.runIf(DATABASES_ENABLED)("desktop against real databases", () => {
  let running: RunningApp | null = null;

  async function open(datasource: Datasource): Promise<RunningApp> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return running;
  }

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  describe.each(TARGETS)("$name", (target) => {
    const scenario = it.skipIf(serverSkipped(target.datasource().pluginId));
    scenario(
      "givenTypeProbe_whenSelected_thenGridShowsTheSameCellsAsEveryDatabase",
      async () => {
        const { page } = await open(target.datasource());
        await waitUntilReady(page);

        await runStatement(page, TYPE_PROBE_SQL);

        expect(await gridText(page)).toEqual({ headers: TYPE_PROBE_HEADERS, cells: TYPE_PROBE_CELLS });
        const cancelButtons = target.sleepSql === undefined ? 0 : 1;
        expect(await cancelButton(page).count()).toBe(cancelButtons);
        await captureWindow(page, `${target.name}-type-probe`);
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenario(
      "givenInvalidStatement_whenRun_thenErrorIsShownAndSessionStaysUsable",
      async () => {
        const { page } = await open(target.datasource());
        await waitUntilReady(page);

        await runStatement(page, INVALID_SQL);

        await expect.poll(() => consoleAlert(page).textContent()).toMatch(/SELEC/);
        await captureWindow(page, `${target.name}-invalid-statement`);
        await runStatement(page, TYPE_PROBE_SQL);
        expect(await consoleAlert(page).count()).toBe(0);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it.runIf(target.sleepSql !== undefined && !serverSkipped(target.datasource().pluginId))(
      "givenSleepingStatement_whenCancelButtonClicked_thenCancelledWellBeforeItEnds",
      async () => {
        const { page } = await open(target.datasource());
        await waitUntilReady(page);
        const cancel = cancelButton(page);

        await startStatement(page, target.sleepSql ?? "");
        await expect.poll(() => cancel.isEnabled()).toBe(true);
        await page.waitForTimeout(CANCEL_DELAY_MS);
        await waitUntilSpinning(runButton(page));
        await captureSpinner(page, `03-cancel-${target.name}-spinning`);
        const clickedAt = Date.now();
        await cancel.click();

        await consoleAlert(page).waitFor({ timeout: CANCEL_DEADLINE_MS });
        expect(Date.now() - clickedAt).toBeLessThan(CANCEL_DEADLINE_MS);
        expect(await consoleAlert(page).textContent()).toContain("The statement was cancelled.");
        await waitUntilReady(page);
        expect(await cancel.isEnabled()).toBe(false);
        await expectNotSpinning(runButton(page));
        await captureWindow(page, `${target.name}-cancelled`);
        await captureSpinner(page, `03-cancel-${target.name}-after`);
        await runStatement(page, TYPE_PROBE_SQL);
        expect((await gridText(page)).cells).toEqual(TYPE_PROBE_CELLS);
      },
      SCENARIO_TIMEOUT_MS,
    );

    it.runIf(target.wrongPassword !== undefined)(
      "givenWrongPassword_whenAppStarts_thenConnectionErrorIsShown",
      async () => {
        const { page } = await open(target.wrongPassword ?? target.datasource());

        await consoleAlert(page).waitFor({ timeout: SCENARIO_TIMEOUT_MS });

        expect(await consoleAlert(page).textContent()).toContain("Could not connect");
        // Plan 004: Run on a failed console retries the connection instead of staying disabled.
        expect(await runButton(page).isEnabled()).toBe(true);
        await captureWindow(page, `${target.name}-wrong-password`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  });
});
