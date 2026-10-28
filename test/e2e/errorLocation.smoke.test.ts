/**
 * Plan 042's live test: a failed statement is underlined where the database says it failed, with
 * its message on hover; Go to Error and F2 reach it; Run All asks, skips or continues past a
 * failure; Run SQL Script asks too and Go to statement underlines every failure in its file.
 * SQLite always runs; PostgreSQL and MySQL need the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/042 bun run test:smoke:db:headless test/e2e/errorLocation.smoke.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  activeEditorTab,
  closeApp,
  consoleToolbar,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  expectNotSpinning,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  runAllButton,
  runButton,
  SCENARIO_TIMEOUT_MS,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("042");
const captureSpinner = evidenceFor("112");

const SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: seededSqliteFile() } };
const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };

/** `BYE` is the one token every dialect names: PostgreSQL by offset, MySQL by fragment, SQLite by word. */
const ERROR_TOKEN = "BYE";
const ONE_FAILURE = [
  "SELECT 1 AS one;",
  "SELECT label",
  "  FROM (SELECT 'a' AS label) AS t",
  ` ORDER ${ERROR_TOKEN} label;`,
  "SELECT 3 AS three;",
].join("\n");
const SECOND_TOKEN = "WHEN";
const TWO_FAILURES = [
  "SELECT 1 AS one;",
  `SELECT 2 AS two ORDER ${ERROR_TOKEN} two;`,
  `SELECT 3 AS three ${SECOND_TOKEN} 1;`,
  "SELECT 4 AS four;",
].join("\n");

const FAIL_THEN_SELECT = [`SELECT 1 ORDER ${ERROR_TOKEN} 1;`, "SELECT 2 AS two;"].join("\n");
/** Past the Run spinner's 300 ms delay (plan 112 decision 3), with room for a render. */
const PAST_SPINNER_DELAY_MS = 1_000;

const ON_ERROR = { ask: "ask", continue: "continue" } as const;

function errorQuestion(page: Page) {
  return page.getByTestId("error-question");
}

function errorMarks(page: Page) {
  return sqlEditor(page).locator(".tc-error-mark");
}

function flashed(page: Page) {
  return page.locator(".tc-statement-flash");
}

function outputEntries(page: Page) {
  return page.getByRole("log", { name: "Output" }).locator("[data-tone]");
}

function scriptRows(page: Page, state?: string) {
  const rows = toolWindow(page, "Services").locator('[role="treeitem"][data-kind="script"]');
  return state === undefined ? rows : rows.and(page.locator(`[data-state="${state}"]`));
}

async function answerOpenDialog(app: ElectronApplication, paths: readonly string[]): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [...picked] });
  }, paths);
}

describe.runIf(SMOKE_ENABLED)("error location live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  async function launch(datasource: Datasource, onError: string = ON_ERROR.ask): Promise<RunningApp> {
    const userDataDir = newProfile();
    seedSettings(userDataDir, { version: 1, console: { runAllOnError: onError } });
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running;
  }

  async function typeScript(page: Page, sql: string): Promise<void> {
    await sqlEditor(page).fill(sql);
    await expect.poll(async () => (await sqlEditor(page).locator(".cm-line").allTextContents()).join("\n")).toBe(sql);
  }

  /** Run All asks on the failed statement; its token is underlined, the hover names the error. */
  async function askThenSkip(datasource: Datasource, label: string): Promise<void> {
    const { page } = await launch(datasource);
    await typeScript(page, ONE_FAILURE);
    await runAllButton(page).click();

    const question = errorQuestion(page);
    await question.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect(question.textContent()).resolves.toContain("Statement 2 of 3 failed:");
    await expect.poll(() => errorMarks(page).allTextContents()).toEqual([ERROR_TOKEN]);
    await toolWindow(page, "Services").getByText("waiting on a failed statement", { exact: true }).waitFor();
    await captureWindow(page, `ask-banner-${label}`);

    await question.getByRole("button", { name: "Skip", exact: true }).click();
    await question.waitFor({ state: "detached" });
    await waitUntilReady(page);
    await expect.poll(() => outputEntries(page).last().textContent()).toContain("3 run, 1 failed.");

    await errorMarks(page).first().hover();
    const tooltip = page.locator(".tc-error-tooltip");
    await tooltip.waitFor();
    await expect(tooltip.textContent()).resolves.toMatch(/syntax|BYE/i);
    await captureWindow(page, `underline-hover-${label}`);

    await page.mouse.move(0, 0);
    await sqlEditor(page).press("ControlOrMeta+Home");
    await consoleToolbar(page).getByRole("button", { name: "Go to Error", exact: true }).click();
    await expect.poll(() => flashed(page).allTextContents()).toEqual([ERROR_TOKEN]);
    await captureWindow(page, `go-to-error-${label}`);
  }

  it(
    "givenSyntaxErrorOnSqlite_whenRunAllAsksAndSkipped_thenUnderlinedAndRunGoesOn",
    async () => {
      await askThenSkip(SQLITE, "sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenSyntaxErrorOnPostgres_whenRunAllAsksAndSkipped_thenUnderlinedAndRunGoesOn",
    async () => {
      await askThenSkip(POSTGRES, "postgres");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenSyntaxErrorOnMysql_whenRunAllAsksAndSkipped_thenUnderlinedAndRunGoesOn",
    async () => {
      await askThenSkip(MYSQL, "mysql");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenFailedStatementOnMysql_whenRunAllAsks_thenRunAndRunAllDoNotSpin",
    async () => {
      const { page } = await launch(MYSQL);
      await typeScript(page, FAIL_THEN_SELECT);
      await runAllButton(page).click();

      const question = errorQuestion(page);
      await question.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.waitForTimeout(PAST_SPINNER_DELAY_MS);

      for (const button of [runButton(page), runAllButton(page)]) {
        await expectNotSpinning(button);
        expect(await button.isEnabled()).toBe(false);
      }
      await captureSpinner(page, "05-asking");
      await question.getByRole("button", { name: "Skip", exact: true }).click();
      await waitUntilReady(page);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoFailures_whenSkipAll_thenAsksOnceAndF2StepsThroughBoth",
    async () => {
      const { page } = await launch(SQLITE);
      await typeScript(page, TWO_FAILURES);
      await runAllButton(page).click();
      const question = errorQuestion(page);
      await question.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await question.getByRole("button", { name: "Skip All", exact: true }).click();
      await waitUntilReady(page);
      await expect(question.count()).resolves.toBe(0);
      await expect.poll(() => outputEntries(page).last().textContent()).toContain("4 run, 2 failed.");
      await expect.poll(() => errorMarks(page).allTextContents()).toEqual([ERROR_TOKEN, SECOND_TOKEN]);
      await captureWindow(page, "skip-all-two-marks");

      await sqlEditor(page).press("ControlOrMeta+Home");
      await sqlEditor(page).press("F2");
      await expect.poll(() => flashed(page).allTextContents()).toEqual([ERROR_TOKEN]);
      await sqlEditor(page).press("F2");
      await expect.poll(() => flashed(page).allTextContents()).toEqual([SECOND_TOKEN]);
      await captureWindow(page, "f2-second-error");
      await sqlEditor(page).press("Shift+F2");
      await expect.poll(() => flashed(page).allTextContents()).toEqual([ERROR_TOKEN]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  async function continuePastErrors(datasource: Datasource, label: string): Promise<void> {
    const { page } = await launch(datasource, ON_ERROR.continue);
    await typeScript(page, TWO_FAILURES);
    await runAllButton(page).click();
    await waitUntilReady(page);
    await expect.poll(() => outputEntries(page).last().textContent()).toContain("4 run, 2 failed.");
    await expect(errorQuestion(page).count()).resolves.toBe(0);
    await expect.poll(() => errorMarks(page).count()).toBe(2);
    await captureWindow(page, `continue-summary-${label}`);
  }

  it(
    "givenContinueOnSqlite_whenRunAll_thenRunsEveryStatementAndSummarises",
    async () => {
      await continuePastErrors(SQLITE, "sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(!WITHOUT_POSTGRES && DATABASES_ENABLED)(
    "givenContinueOnPostgres_whenRunAll_thenRunsEveryStatementAndSummarises",
    async () => {
      await continuePastErrors(POSTGRES, "postgres");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSettingsChangedToContinue_whenRunAll_thenNothingIsAsked",
    async () => {
      const { page } = await launch(SQLITE);
      await pressChord(page, ",");
      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.waitFor();
      await settings
        .getByRole("tablist", { name: "Settings pages" })
        .getByRole("tab", { name: "Advanced", exact: true })
        .click();
      await settings.getByLabel("When a statement fails").selectOption({ label: "Skip it and go on" });
      await captureWindow(page, "settings-when-a-statement-fails");
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "detached" });

      await typeScript(page, TWO_FAILURES);
      await runAllButton(page).click();
      await waitUntilReady(page);
      await expect.poll(() => outputEntries(page).last().textContent()).toContain("4 run, 2 failed.");
      await expect(errorQuestion(page).count()).resolves.toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  /** Run SQL Script… asks on the Services line; Skip All, then Go to statement marks both. */
  async function scriptSkipAll(datasource: Datasource, label: string): Promise<void> {
    const current = await launch(datasource);
    const { page } = current;
    const directory = mkdtempSync(join(tmpdir(), "table-craft-error-location-"));
    scratch.push(directory);
    const path = join(directory, "two-failures.sql");
    writeFileSync(path, `${TWO_FAILURES}\n`);

    await answerOpenDialog(current.app, [path]);
    await sqlEditor(page).click();
    await findAction(page, "Run SQL Script");
    const asking = scriptRows(page, "running");
    await asking.locator('[data-action="script.skipAll"]').waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect(asking.getByTestId("script-state").textContent()).resolves.toContain("waiting on a failed statement");
    await captureWindow(page, `script-asks-${label}`);

    await asking.locator('[data-action="script.skipAll"]').click();
    const done = scriptRows(page, "done");
    await done.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect(done.getByTestId("script-state").textContent()).resolves.toContain("done, 2 failed");
    await captureWindow(page, `script-done-with-failures-${label}`);

    await done.locator('[data-action="script.goTo"]').click();
    await expect.poll(() => activeEditorTab(page).getAttribute("title")).toBe(path);
    await expect.poll(() => errorMarks(page).allTextContents()).toEqual([ERROR_TOKEN, SECOND_TOKEN]);
    await captureWindow(page, `script-go-to-statement-${label}`);
  }

  it(
    "givenScriptWithTwoFailuresOnSqlite_whenSkipAll_thenDoneWithFailuresAndBothMarked",
    async () => {
      await scriptSkipAll(SQLITE, "sqlite");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenScriptWithTwoFailuresOnMysql_whenSkipAll_thenDoneWithFailuresAndBothMarked",
    async () => {
      await scriptSkipAll(MYSQL, "mysql");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
