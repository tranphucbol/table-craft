/**
 * Plan 045's live test: the Sessions tab against PostgreSQL, MySQL and TiDB 4 from the
 * `test/db/compose.yml` databases. Gated, because it needs a display, a fresh build and the
 * containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/045 bun run test:smoke:db:headless test/e2e/sessions.smoke.test.ts
 *
 * The lock-wait scenarios hold a row of `sessions_live` from a connection outside the app, created
 * and dropped by this suite.
 */
import type { Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatasourcePlugin, Session } from "@table-craft/plugin-api";
import mysql from "@table-craft/plugin-mysql";
import postgres from "@table-craft/plugin-postgres";
import {
  MYSQL_CONFIG,
  MYSQL_ROOT_CONFIG,
  POSTGRES_CONFIG,
  TIDB_CONFIG,
  TIDB_DATABASE,
  WITHOUT_POSTGRES,
  serverSkipped,
} from "../support/databases.js";
import {
  activeEditorTab,
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  EVIDENCE_WINDOW,
  evidenceFor,
  DATABASES_ENABLED,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  startStatement,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
  showServices,
} from "./harness.js";

const captureWindow = evidenceFor("045");

const POSTGRES: Datasource = { id: "pg", pluginId: "postgres", config: POSTGRES_CONFIG };
const MYSQL_ROOT: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_ROOT_CONFIG };
const MYSQL_LIMITED: Datasource = { id: "mysql", pluginId: "mysql", config: MYSQL_CONFIG };
const TIDB: Datasource = { id: "tidb", pluginId: "mysql", config: TIDB_CONFIG };

const { password: PASSWORD, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;

function savedPostgres(overrides: Partial<SavedDatasource>): SavedDatasource {
  return {
    id: "pg",
    name: "pg",
    pluginId: "postgres",
    config: { ...POSTGRES_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
    ...overrides,
  };
}

const LOCK_TABLE = "sessions_live";
const PG_SLEEP = "SELECT pg_sleep(60)";
const MYSQL_SLEEP = "SELECT SLEEP(60)";
const TIDB_SLEEP = "SELECT SLEEP(30)";
const BLOCKED_UPDATE = `UPDATE ${LOCK_TABLE} SET n = n + 10 WHERE id = 1`;
const HOLDING_UPDATE = `UPDATE ${LOCK_TABLE} SET n = n + 1 WHERE id = 1`;

interface Server {
  readonly plugin: DatasourcePlugin;
  readonly config: object;
}

const PG_SERVER: Server = { plugin: postgres, config: POSTGRES_CONFIG };
const MYSQL_SERVER: Server = { plugin: mysql, config: MYSQL_ROOT_CONFIG };
const TIDB_SERVER: Server = { plugin: mysql, config: TIDB_CONFIG };

async function run(session: Session, sql: string): Promise<void> {
  for await (const _row of (await session.execute(sql)).rows) {
    // Drained so the statement completes before the next.
  }
}

/** Runs `statements` on `server` through the plugin, outside the app. */
async function onServer(server: Server, statements: readonly string[]): Promise<void> {
  const session = await server.plugin.connect(server.config, { readOnly: false });
  try {
    for (const sql of statements) await run(session, sql);
  } finally {
    await session.close();
  }
}

/** A connection outside the app holding row 1 of `sessions_live` in an open transaction. */
async function holdLock(server: Server, begin: string): Promise<Session> {
  const session = await server.plugin.connect(server.config, { readOnly: false });
  await run(session, begin);
  await run(session, HOLDING_UPDATE);
  return session;
}

async function closeQuietly(session: Session | null): Promise<void> {
  await session?.close().catch(() => undefined);
}

function sessionsView(page: Page) {
  return page.getByTestId("sessions-view");
}

function sessionRows(page: Page) {
  return page.getByTestId("sessions-grid").locator("tbody tr");
}

function sessionRow(page: Page, id: string) {
  return page.getByTestId("sessions-grid").locator(`tbody tr[data-session="${id}"]`);
}

function rowWithQuery(page: Page, sql: string) {
  return sessionRows(page).filter({ hasText: sql });
}

/** The row's cell under `column`, counted from the grid's header. */
async function cellText(page: Page, row: ReturnType<typeof sessionRows>, column: string): Promise<string> {
  const headers = await page.getByTestId("sessions-grid").locator("thead th").allTextContents();
  return (await row.locator("td").nth(headers.indexOf(column)).textContent()) ?? "";
}

/** The DOM element as far as `revealBlockedBy` needs it; this program has no DOM lib. */
interface Scrollable {
  scrollIntoView(options: { inline: "center" }): void;
}

/** Scrolls the grid sideways until the Blocked by column is in view, for the capture. */
async function revealBlockedBy(page: Page): Promise<void> {
  await page
    .getByTestId("sessions-grid")
    .locator("thead th", { hasText: "Blocked by" })
    .evaluate((header: Scrollable) => header.scrollIntoView({ inline: "center" }));
}

function sessionsButton(page: Page, name: string) {
  return sessionsView(page).getByRole("button", { name, exact: true });
}

function terminateDialog(page: Page) {
  return page.getByRole("dialog", { name: "Terminate Session" });
}

async function showSessions(page: Page, datasource: string): Promise<void> {
  await treeNode(page, datasource).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Show Sessions…/ }).click();
  await expect.poll(() => activeEditorTab(page).textContent()).toBe(`Sessions · ${datasource}`);
  await expect
    .poll(() => page.getByTestId("sessions-count").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
    .toMatch(/^\d+ of \d+ sessions$/);
}

/** Refreshes until `row` is listed, since a statement reaches the server's list a moment after it starts. */
async function refreshUntilListed(page: Page, row: ReturnType<typeof sessionRows>): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await row.count()) > 0) return true;
        await sessionsButton(page, "Refresh Sessions").click();
        return false;
      },
      { timeout: LAUNCH_TIMEOUT_MS },
    )
    .toBe(true);
}

const LOCK_SERVERS = WITHOUT_POSTGRES ? [MYSQL_SERVER] : [PG_SERVER, MYSQL_SERVER];

describe.runIf(DATABASES_ENABLED)("sessions live test", () => {
  let running: RunningApp | null = null;
  let holder: Session | null = null;

  beforeAll(async () => {
    const table = `CREATE TABLE ${LOCK_TABLE} (id INT PRIMARY KEY, n INT NOT NULL)`;
    for (const server of LOCK_SERVERS) {
      await onServer(server, [`DROP TABLE IF EXISTS ${LOCK_TABLE}`, table, `INSERT INTO ${LOCK_TABLE} VALUES (1, 0)`]);
    }
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    for (const server of LOCK_SERVERS) await onServer(server, [`DROP TABLE IF EXISTS ${LOCK_TABLE}`]);
  }, SCENARIO_TIMEOUT_MS);

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await closeQuietly(holder);
    holder = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource): Promise<Page> {
    running = await launchApp(datasource);
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await waitUntilReady(running.page);
    return running.page;
  }

  async function launchSaved(datasource: SavedDatasource): Promise<Page> {
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [datasource]);
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await openConsoleOn(running.page, datasource.name);
    await answerSecretPrompt(running.page, datasource.name, PASSWORD);
    await waitUntilReady(running.page);
    return running.page;
  }

  for (const target of [
    { name: "pg", datasource: POSTGRES, sleep: PG_SLEEP },
    { name: "mysql", datasource: MYSQL_ROOT, sleep: MYSQL_SLEEP },
  ]) {
    it.skipIf(serverSkipped(target.datasource.pluginId))(
      `givenSleepInConsoleOn${target.name}_whenShowSessionsThenCancel_thenActiveRowThenIdle`,
      async () => {
        const page = await launch(target.datasource);
        await startStatement(page, target.sleep);

        await showSessions(page, target.name);
        const sleeping = rowWithQuery(page, target.sleep);
        await refreshUntilListed(page, sleeping);
        expect(await cellText(page, sleeping, "State")).toBe("active");
        expect(await cellText(page, sleeping, "PID")).toMatch(/^\d+you$/);
        const id = (await sleeping.getAttribute("data-session")) ?? "";
        await sleeping.click();
        await expect.poll(() => sleeping.getAttribute("aria-selected")).toBe("true");
        await expect.poll(() => page.getByTestId("sessions-query").textContent()).toContain(target.sleep);
        expect(await page.getByTestId("sessions-details").textContent()).toContain("One of TableCraft's own sessions.");
        await captureWindow(page, `${target.name}-sleep-listed`);

        await page.getByLabel("Hide idle", { exact: true }).check();
        const states = await page.getByTestId("sessions-grid").locator("tbody tr").count();
        for (let row = 0; row < states; row += 1) {
          expect(await cellText(page, sessionRows(page).nth(row), "State")).not.toBe("idle");
        }
        expect(await sessionRow(page, id).count()).toBe(1);
        await captureWindow(page, `${target.name}-hide-idle`);
        await page.getByLabel("Hide idle", { exact: true }).uncheck();

        await sessionsButton(page, "Cancel Session Query").click();
        await expect
          .poll(() => page.getByTestId("sessions-status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
          .toBe(`Cancelled the query of session ${id}.`);
        await expect
          .poll(async () => {
            await sessionsButton(page, "Refresh Sessions").click();
            return cellText(page, sessionRow(page, id), "State");
          })
          .toBe("idle");
        await captureWindow(page, `${target.name}-cancelled`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenLockWaitOnRedPostgres_whenHolderTerminated_thenBlockedByShownAndPidTypedToConfirm",
    async () => {
      holder = await holdLock(PG_SERVER, "BEGIN");
      const holderId = holder.serverSessionId ?? "";
      const page = await launchSaved(savedPostgres({ name: "pg-prod", color: "red" }));
      await startStatement(page, BLOCKED_UPDATE);

      await showSessions(page, "pg-prod");
      const blocked = rowWithQuery(page, BLOCKED_UPDATE);
      await refreshUntilListed(page, blocked);
      expect(await blocked.getAttribute("data-tone")).toBe("danger");
      expect(await cellText(page, blocked, "Blocked by")).toBe(holderId);
      const holding = sessionRow(page, holderId);
      expect(await holding.getAttribute("data-tone")).toBe("warning");
      expect(await cellText(page, holding, "State")).toBe("idle in transaction");
      await revealBlockedBy(page);
      await captureWindow(page, "pg-lock-wait");

      await holding.click();
      await sessionsButton(page, "Terminate Session…").click();
      const dialog = terminateDialog(page);
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain(`SELECT pg_terminate_backend(${holderId})`);
      const confirm = dialog.getByRole("button", { name: "Terminate", exact: true });
      expect(await confirm.isDisabled()).toBe(true);
      await dialog.getByLabel(`Type ${holderId} to confirm`).fill(holderId);
      await captureWindow(page, "pg-terminate-typed-pid");
      await confirm.click();

      await expect
        .poll(() => page.getByTestId("sessions-status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`Terminated session ${holderId}.`);
      await expect.poll(() => sessionRow(page, holderId).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await expect
        .poll(
          async () => {
            await sessionsButton(page, "Refresh Sessions").click();
            return blocked.getAttribute("data-tone");
          },
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .not.toBe("danger");
      expect(await cellText(page, blocked, "Blocked by")).toBe("—");
      await captureWindow(page, "pg-terminated");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenLockWaitOnMysql_whenHolderTerminated_thenBlockedByShownAndConfirmShowsKill",
    async () => {
      holder = await holdLock(MYSQL_SERVER, "START TRANSACTION");
      const holderId = holder.serverSessionId ?? "";
      const page = await launch(MYSQL_ROOT);
      await startStatement(page, BLOCKED_UPDATE);

      await showSessions(page, "mysql");
      const blocked = rowWithQuery(page, BLOCKED_UPDATE);
      await expect
        .poll(
          async () => {
            await sessionsButton(page, "Refresh Sessions").click();
            return (await blocked.count()) > 0 ? cellText(page, blocked, "Blocked by") : "";
          },
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toBe(holderId);
      expect(await blocked.getAttribute("data-tone")).toBe("danger");
      expect(await sessionRow(page, holderId).getAttribute("data-tone")).toBe("warning");
      await revealBlockedBy(page);
      await captureWindow(page, "mysql-lock-wait");

      await sessionRow(page, holderId).click();
      await sessionsButton(page, "Terminate Session…").click();
      const dialog = terminateDialog(page);
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain(`KILL ${holderId}`);
      expect(await dialog.getByLabel(`Type ${holderId} to confirm`).count()).toBe(0);
      await captureWindow(page, "mysql-terminate-confirm");
      await dialog.getByRole("button", { name: "Terminate", exact: true }).click();

      await expect
        .poll(() => page.getByTestId("sessions-status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`Terminated session ${holderId}.`);
      await expect.poll(() => sessionRow(page, holderId).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      await captureWindow(page, "mysql-terminated");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenReadOnlyPostgres_whenSessionsTab_thenCancelAndTerminateDisabled",
    async () => {
      const page = await launchSaved(savedPostgres({ name: "pg-ro", readOnly: true }));

      await showSessions(page, "pg-ro");
      await sessionRows(page).first().waitFor();
      await sessionRows(page).first().click();

      expect(await sessionsButton(page, "Cancel Session Query").isDisabled()).toBe(true);
      expect(await sessionsButton(page, "Terminate Session…").isDisabled()).toBe(true);
      expect(await sessionsButton(page, "Terminate Session…").getAttribute("title")).toBe(
        "The data source is read-only.",
      );
      await captureWindow(page, "pg-read-only");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenExecutionInServices_whenShowInSessions_thenItsConsoleRowSelected",
    async () => {
      const page = await launch(MYSQL_ROOT);
      await runStatement(page, "SELECT 1 AS one");

      const execution = (await showServices(page)).locator('[role="treeitem"][data-kind="execution"]').first();
      await execution.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Show in Sessions/ }).click();

      await expect.poll(() => activeEditorTab(page).textContent()).toBe("Sessions · mysql");
      const selected = page.getByTestId("sessions-grid").locator('tbody tr[aria-selected="true"]');
      await selected.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await cellText(page, selected, "PID")).toMatch(/^\d+you$/);
      expect(await page.getByTestId("sessions-details").textContent()).toContain("One of TableCraft's own sessions.");
      await captureWindow(page, "mysql-show-in-sessions");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlUserWithoutProcess_whenShowSessions_thenOwnThreadsAndGrantNote",
    async () => {
      const page = await launch(MYSQL_LIMITED);

      await showSessions(page, "mysql");

      await expect
        .poll(() => page.getByTestId("sessions-note").allTextContents())
        .toEqual(expect.arrayContaining([expect.stringContaining("GRANT PROCESS ON *.* TO 'table_craft'@")]));
      const users = new Set<string>();
      for (const row of await sessionRows(page).all()) users.add(await cellText(page, row, "User"));
      expect([...users]).toEqual([MYSQL_CONFIG.user]);
      await captureWindow(page, "mysql-limited-note");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSleepOnTidb4_whenShowSessions_thenActiveWithoutCancelAndTerminateRuns",
    async () => {
      holder = await TIDB_SERVER.plugin.connect(TIDB_SERVER.config, { readOnly: false });
      const holderId = holder.serverSessionId ?? "";
      if (holder.serverInstance === undefined) throw new Error("A TiDB 4 session knows the server it is on.");
      const page = await launch(TIDB);
      await startStatement(page, TIDB_SLEEP);

      await showSessions(page, "tidb");
      // The TiDB may be shared: keep to this run's own sessions, which all sit in its database.
      await page.getByRole("textbox", { name: "Search sessions" }).fill(TIDB_DATABASE);
      const sleeping = rowWithQuery(page, TIDB_SLEEP);
      await refreshUntilListed(page, sleeping);
      expect(await cellText(page, sleeping, "State")).toBe("active");
      expect(await cellText(page, sleeping, "Wait")).toBe("—");
      await sleeping.click();
      expect(await sessionsButton(page, "Cancel Session Query").isDisabled()).toBe(true);
      await expect
        .poll(() => page.getByTestId("sessions-note").allTextContents())
        .toEqual(expect.arrayContaining([expect.stringContaining("This TiDB version cannot cancel")]));
      await captureWindow(page, "tidb-sleep-listed");

      const holderRow = sessionRow(page, `${holder.serverInstance}/${holderId}`);
      await holderRow.click();
      await sessionsButton(page, "Terminate Session…").click();
      const dialog = terminateDialog(page);
      await dialog.waitFor();
      expect(await dialog.textContent()).toContain(`KILL TIDB ${holderId}`);
      await dialog.getByRole("button", { name: "Terminate", exact: true }).click();
      await expect
        .poll(() => page.getByTestId("sessions-status").textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toBe(`Terminated session ${holderId}.`);
      await expect(run(holder, "SELECT 1")).rejects.toThrow();
      await expect
        .poll(async () => {
          await sessionsButton(page, "Refresh Sessions").click();
          return holderRow.count();
        })
        .toBe(0);
      await captureWindow(page, "tidb-terminated");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
