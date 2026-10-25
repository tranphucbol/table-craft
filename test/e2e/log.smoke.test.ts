/**
 * Plan 017's live test: the app log, the Log tool window, Show in Log, Debug logging, an engine
 * crash, rotation and Export Diagnostics, against SQLite and, with the containers, PostgreSQL and
 * MySQL. Gated, because it needs a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/017 bun run test:smoke:db
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "@table-craft/plugin-postgres";
import { MYSQL_CONFIG, POSTGRES_CONFIG, withWrongPassword, WITHOUT_POSTGRES } from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  enginePids,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  pressChord,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  startStatement,
  toolWindow,
  waitUntilReady,
  type Datasource,
  type RunningApp,
} from "./harness.js";
import { stubSaveDialog } from "./workflows.js";

const captureWindow = evidenceFor("017");

const LOG_FILE = join("logs", "table-craft.log");
const SQLITE: Datasource = { id: "lite", pluginId: "sqlite", config: { path: ":memory:" } };
const POSTGRES_WRONG: Datasource = { id: "pg", pluginId: "postgres", config: withWrongPassword(POSTGRES_CONFIG) };
const MYSQL_WRONG: Datasource = { id: "mysql", pluginId: "mysql", config: withWrongPassword(MYSQL_CONFIG) };
const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const WRONG_PASSWORD = withWrongPassword(POSTGRES_CONFIG).password;

const MISSING_TABLE_SQL = "SELECT * FROM no_such_table";
const ROW_VALUE = "row-value-never-logged";
const VALUE_SQL = `SELECT '${ROW_VALUE}' AS secret_looking_value`;
/** Its own alias, so the kill below spares the sleeps other files run on the same server at once. */
const LONG_QUERY_MARKER = "log_smoke_slept";
const LONG_QUERY_SQL = `SELECT pg_sleep(30) AS ${LONG_QUERY_MARKER}`;

/** Five files of 5 MB: enough records of the 16 KB cap to pass 25 MB and rotate four times. */
const FILL_RECORD_CHARS = 15_000;
const FILL_BATCHES = 22;
const FILL_BATCH_RECORDS = 100;
/** `LOG_FILE_BYTES` in `main/log/writer.ts`; the e2e suite reads the profile, not the source. */
const LOG_FILE_BYTES = 5 * 1024 * 1024;
const ROTATED_FILES = [
  "table-craft.1.log",
  "table-craft.2.log",
  "table-craft.3.log",
  "table-craft.4.log",
  "table-craft.log",
];

interface LoggedLine {
  readonly level: string;
  readonly process: string;
  readonly scope: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

function logLines(userDataDir: string): readonly LoggedLine[] {
  const text = readProfileFile(userDataDir, LOG_FILE) ?? "";
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LoggedLine);
}

async function logged(userDataDir: string, msg: string): Promise<LoggedLine> {
  let found: LoggedLine | undefined;
  await expect
    .poll(
      () => {
        found = logLines(userDataDir).find((line) => line.msg === msg);
        return found !== undefined;
      },
      { timeout: LAUNCH_TIMEOUT_MS },
    )
    .toBe(true);
  return found as LoggedLine;
}

function logRows(page: Page) {
  return toolWindow(page, "Log").getByRole("log", { name: "Log records" }).getByRole("button");
}

async function showLog(page: Page): Promise<void> {
  await findAction(page, "Show Log");
  await toolWindow(page, "Log").waitFor();
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

async function setDebugLogging(page: Page, on: boolean): Promise<void> {
  await pressChord(page, ",");
  await settingsDialog(page)
    .getByRole("tablist", { name: "Settings pages" })
    .getByRole("tab", { name: "Advanced", exact: true })
    .click();
  const box = settingsDialog(page).getByLabel("Debug logging");
  if ((await box.isChecked()) !== on) await box.click();
  await expect.poll(() => box.isChecked()).toBe(on);
}

async function closeSettings(page: Page): Promise<void> {
  await settingsDialog(page).getByRole("button", { name: "Close", exact: true }).click();
  await expect.poll(() => settingsDialog(page).count()).toBe(0);
}

/** Runs Export Diagnostics to a file in the profile and returns the zip's entries and text. */
async function exportDiagnostics(
  running: RunningApp,
  capture: string | null,
): Promise<{ readonly path: string; readonly entries: readonly string[]; readonly text: string }> {
  const path = join(running.userDataDir, "diagnostics.zip");
  await stubSaveDialog(running.app, path);
  await findAction(running.page, "Export Diagnostics");
  const confirm = running.page.getByRole("dialog", { name: "Export Diagnostics" });
  await confirm.waitFor();
  // What the zip holds is information, not a list of failures.
  expect(await confirm.locator(".text-danger").count()).toBe(0);
  if (capture !== null) await captureWindow(running.page, `${capture}-confirm`);
  await confirm.getByRole("button", { name: "Export…", exact: true }).click();
  const done = running.page.getByRole("dialog", { name: "Diagnostics exported" });
  await done.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  if (capture !== null) await captureWindow(running.page, `${capture}-done`);
  await done.getByRole("button", { name: "OK", exact: true }).click();
  const entries = execFileSync("unzip", ["-Z1", path], { encoding: "utf8" }).split("\n").filter(Boolean);
  // `-t` checks every entry's CRC: the in-house writer must produce a zip any tool accepts.
  execFileSync("unzip", ["-tq", path]);
  const text = execFileSync("unzip", ["-p", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { path, entries, text };
}

describe.runIf(SMOKE_ENABLED)("app log live test (SQLite)", () => {
  let running: RunningApp | null = null;

  async function open(datasource: Datasource | null = SQLITE, userDataDir?: string): Promise<RunningApp> {
    running = await launchApp(datasource, userDataDir === undefined ? {} : { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return running;
  }

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenLaunch_whenLogShown_thenStartRecordNamesVersionsAndPlugins",
    async () => {
      const { page, userDataDir } = await open();
      await waitUntilReady(page);

      const started = await logged(userDataDir, "TableCraft started");
      expect(started).toMatchObject({ level: "info", process: "main" });
      expect(Object.keys(started)).toEqual(
        expect.arrayContaining(["version", "electron", "platform", "osRelease", "arch"]),
      );
      await logged(userDataDir, "plugin found");
      expect(
        logLines(userDataDir)
          .filter((line) => line.msg === "plugin found")
          .map((line) => line["id"]),
      ).toEqual(expect.arrayContaining(["postgres", "mysql", "sqlite"]));

      await showLog(page);
      await expect.poll(() => logRows(page).filter({ hasText: "TableCraft started" }).count()).toBeGreaterThan(0);
      await captureWindow(page, "01-start-record");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFailedStatement_whenShowInLog_thenLogFilteredToTheFailure",
    async () => {
      const { page, userDataDir } = await open();
      await waitUntilReady(page);
      await runStatement(page, VALUE_SQL);
      await runStatement(page, MISSING_TABLE_SQL);
      await consoleAlert(page).waitFor();

      await page.getByRole("button", { name: "Show in Log", exact: true }).click();
      await toolWindow(page, "Log").waitFor();
      await expect.poll(() => logRows(page).filter({ hasText: "statement failed" }).count()).toBe(1);
      await expect.poll(() => logRows(page).filter({ hasText: "statement finished" }).count()).toBe(0);
      await logRows(page).filter({ hasText: "statement failed" }).click();
      await captureWindow(page, "02-show-in-log-sqlite");

      const failed = await logged(userDataDir, "statement failed");
      expect(failed).toMatchObject({ level: "warn", scope: "query", kind: "read" });
      const text = readProfileFile(userDataDir, LOG_FILE) ?? "";
      expect(text).not.toContain(ROW_VALUE);
      expect(text).not.toContain(MISSING_TABLE_SQL);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenDebugLogging_whenToggled_thenRequestEnvelopesStartAndStopLive",
    async () => {
      const { page, userDataDir } = await open();
      await waitUntilReady(page);
      await setDebugLogging(page, true);
      await captureWindow(page, "03-settings-debug-logging");
      await closeSettings(page);

      await runStatement(page, "SELECT 1");
      await expect
        .poll(() =>
          logLines(userDataDir).find((line) => line.msg === "request" && line["type"] === "statement.execute"),
        )
        .toMatchObject({ level: "debug", outcome: "ok", process: "engine:lite" });
      await showLog(page);
      await expect.poll(() => logRows(page).filter({ hasText: "request" }).count()).toBeGreaterThan(0);
      await captureWindow(page, "04-debug-records");

      await setDebugLogging(page, false);
      await closeSettings(page);
      const before = logLines(userDataDir).filter((line) => line.level === "debug").length;
      await runStatement(page, "SELECT 2");
      await logged(userDataDir, "statement finished");
      await expect.poll(() => logLines(userDataDir).filter((line) => line.msg === "statement finished").length).toBe(2);
      expect(logLines(userDataDir).filter((line) => line.level === "debug").length).toBe(before);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenEngineKilled_whenLogRead_thenUnexpectedExitRecorded",
    async () => {
      const { app, page, userDataDir } = await open();
      await waitUntilReady(page);
      const [pid] = await enginePids(app);
      expect(pid).toBeDefined();

      process.kill(pid ?? 0, "SIGKILL");

      const exited = await logged(userDataDir, "engine host exited unexpectedly");
      expect(exited).toMatchObject({ level: "warn", process: "main", scope: "engine", datasourceId: "lite" });
      await showLog(page);
      await expect
        .poll(() => logRows(page).filter({ hasText: "engine host exited unexpectedly" }).count())
        .toBeGreaterThan(0);
      await logRows(page).filter({ hasText: "engine host exited unexpectedly" }).first().click();
      await captureWindow(page, "05-engine-crash");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLogPast25Mb_whenWritten_thenFiveFilesAndNoMore",
    async () => {
      const { page, userDataDir } = await open(null);
      await toolWindow(page, "Database").waitFor();

      for (let batch = 0; batch < FILL_BATCHES; batch += 1) {
        await page.evaluate(
          async ({ batch: index, records, chars }) => {
            const bridge = (
              globalThis as unknown as {
                tableCraft: { logWrite(records: readonly object[]): Promise<unknown> };
              }
            ).tableCraft;
            const at = new Date().toISOString();
            await bridge.logWrite(
              Array.from({ length: records }, (_unused, n) => ({
                ts: at,
                level: "info",
                scope: "fill",
                msg: "filler",
                batch: index,
                n,
                pad: "x".repeat(chars),
              })),
            );
          },
          { batch, records: FILL_BATCH_RECORDS, chars: FILL_RECORD_CHARS },
        );
      }

      const logs = join(userDataDir, "logs");
      await expect.poll(() => readdirSync(logs).sort(), { timeout: LAUNCH_TIMEOUT_MS }).toEqual(ROTATED_FILES);
      expect(existsSync(join(logs, "table-craft.5.log"))).toBe(false);
      for (const name of ROTATED_FILES) {
        expect(statSync(join(logs, name)).size).toBeLessThanOrEqual(LOG_FILE_BYTES);
      }
      await showLog(page);
      await expect
        .poll(() => logRows(page).filter({ hasText: "filler" }).count(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBeGreaterThan(0);
      await logRows(page).first().click();
      await captureWindow(page, "06-rotated-log");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSession_whenDiagnosticsExported_thenZipHoldsLogsAndMetadataOnly",
    async () => {
      const running = await open();
      await waitUntilReady(running.page);
      await runStatement(running.page, VALUE_SQL);

      const { entries, text } = await exportDiagnostics(running, "07-export-sqlite");

      expect(entries).toEqual(
        expect.arrayContaining(["logs/table-craft.log", "about.json", "datasources.json", "history.json"]),
      );
      expect(text).toContain("TableCraft started");
      expect(text).toContain("diagnostics export started");
      expect(text).not.toContain(ROW_VALUE);
    },
    SCENARIO_TIMEOUT_MS,
  );
});

describe.runIf(DATABASES_ENABLED)("app log live test (PostgreSQL and MySQL)", () => {
  let running: RunningApp | null = null;

  async function open(datasource: Datasource): Promise<RunningApp> {
    running = await launchApp(datasource, { userDataDir: newProfile() });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return running;
  }

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  for (const target of [
    { name: "postgres", datasource: POSTGRES_WRONG },
    { name: "mysql", datasource: MYSQL_WRONG },
  ]) {
    it(
      `givenWrongPassword_${target.name}_whenShowInLog_thenConnectFailureLoggedWithoutThePassword`,
      async () => {
        const current = await open(target.datasource);
        await consoleAlert(current.page).waitFor({ timeout: SCENARIO_TIMEOUT_MS });

        await current.page.getByRole("button", { name: "Show in Log", exact: true }).click();
        await expect.poll(() => logRows(current.page).filter({ hasText: "connect failed" }).count()).toBeGreaterThan(0);
        await logRows(current.page).filter({ hasText: "connect failed" }).first().click();
        await captureWindow(current.page, `08-wrong-password-${target.name}`);

        const failed = await logged(current.userDataDir, "connect failed");
        expect(failed).toMatchObject({ level: "warn", process: `engine:${target.datasource.id}`, scope: "connection" });
        expect(failed["err"]).toBeDefined();
        expect(readProfileFile(current.userDataDir, LOG_FILE)).not.toContain(WRONG_PASSWORD);

        const { text } = await exportDiagnostics(current, target.name === "postgres" ? "09-export-postgres" : null);
        expect(text).toContain("connect failed");
        expect(text).not.toContain(WRONG_PASSWORD);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenServerDropsConnectionMidQuery_whenLogRead_thenFailureWithDriverErrorLogged",
    async () => {
      const current = await open(POSTGRES);
      await waitUntilReady(current.page);
      await startStatement(current.page, LONG_QUERY_SQL);

      const admin = await postgres.connect(POSTGRES_CONFIG, { readOnly: false });
      try {
        await expect
          .poll(
            async () => {
              const result = await admin.execute(
                `SELECT pg_terminate_backend(pid) AS gone FROM pg_stat_activity WHERE query LIKE '%${LONG_QUERY_MARKER}%' AND pid <> pg_backend_pid()`,
              );
              let gone = 0;
              for await (const _row of result.rows) gone += 1;
              return gone;
            },
            { timeout: LAUNCH_TIMEOUT_MS },
          )
          .toBeGreaterThan(0);
      } finally {
        await admin.close();
      }

      await consoleAlert(current.page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const failed = await logged(current.userDataDir, "statement failed");
      expect(failed).toMatchObject({ level: "warn", process: "engine:pg", scope: "query" });
      expect(JSON.stringify(failed["err"])).toMatch(/terminat/i);
      expect(readProfileFile(current.userDataDir, LOG_FILE)).not.toContain(LONG_QUERY_MARKER);
      await current.page.getByRole("button", { name: "Show in Log", exact: true }).click();
      await expect.poll(() => logRows(current.page).filter({ hasText: "statement failed" }).count()).toBeGreaterThan(0);
      await logRows(current.page).filter({ hasText: "statement failed" }).first().click();
      await captureWindow(current.page, "10-postgres-connection-dropped");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
