/**
 * Plan 025's live test: the statement timeout, reconnecting after a dropped connection, failing a
 * statement whose network went away, pasting a connection URL and Copy as URL. Gated, because it
 * needs a display, a fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/025 bun run test:smoke:db
 *
 * The dropped and blackholed networks are the chaos proxy's, between the engine and the database.
 */
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { chaosProxy, type ChaosProxy } from "../support/chaosProxy.js";
import { MYSQL_CONFIG, POSTGRES_CONFIG, WITHOUT_POSTGRES, serverSkipped } from "../support/databases.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  SCRATCH,
  seedDatasources,
  seedSettings,
  setWindowSize,
  sqlEditor,
  startStatement,
  testConnection,
  toolWindow,
  treeNode,
  waitUntilReady,
  type Datasource,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("025");

const TIMEOUT_SECONDS = 5;
/** Short, so a statement in flight notices a blackhole within a scenario's time. */
const KEEPALIVE_SECONDS = 2;
const PASSWORD = POSTGRES_CONFIG.password;

interface Dialect {
  readonly name: string;
  readonly pluginId: string;
  readonly config: typeof POSTGRES_CONFIG | typeof MYSQL_CONFIG;
  readonly sleep: string;
}

const DIALECTS: readonly Dialect[] = [
  { name: "postgres", pluginId: "postgres", config: POSTGRES_CONFIG, sleep: "SELECT pg_sleep(60)" },
  { name: "mysql", pluginId: "mysql", config: MYSQL_CONFIG, sleep: "SELECT SLEEP(60)" },
];

function output(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

async function showOutput(page: Page): Promise<void> {
  await page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: "Output", exact: true }).click();
}

/** Fires a real `paste` event carrying `text` on the input, as ⌘V does. */
async function paste(page: Page, label: string, text: string): Promise<void> {
  await dataSourcesDialog(page).getByLabel(label, { exact: true }).focus();
  await page.evaluate(`(() => {
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(text)});
    document.activeElement.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  })()`);
}

async function text(locator: Locator): Promise<string> {
  return (await locator.count()) === 0 ? "" : ((await locator.first().textContent()) ?? "");
}

function field(page: Page, label: string) {
  return dataSourcesDialog(page).getByLabel(label, { exact: true });
}

function urlNote(page: Page) {
  return dataSourcesDialog(page).getByTestId("url-note");
}

async function newDatasource(page: Page, kind: string, name: string): Promise<void> {
  await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
  const dialog = dataSourcesDialog(page);
  await dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: kind }).click();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
}

describe.runIf(DATABASES_ENABLED)("connection hardening live test", () => {
  let running: RunningApp | null = null;
  let proxy: ChaosProxy | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    await proxy?.close();
    proxy = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(datasource: Datasource | null, userDataDir = newProfile()): Promise<Page> {
    running = await launchApp(datasource, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    if (datasource !== null) await waitUntilReady(running.page);
    return running.page;
  }

  for (const dialect of DIALECTS) {
    const scenario = it.skipIf(serverSkipped(dialect.pluginId));
    scenario(
      `given${dialect.name}SleepPastTimeout_whenRun_thenTimedOutAndSessionStillRuns`,
      async () => {
        const profile = newProfile();
        seedSettings(profile, { version: 1, console: { statementTimeoutSeconds: TIMEOUT_SECONDS } });
        const page = await launch({ id: dialect.name, pluginId: dialect.pluginId, config: dialect.config }, profile);

        const started = Date.now();
        await runStatement(page, dialect.sleep);
        const elapsedMs = Date.now() - started;

        await expect.poll(() => text(consoleAlert(page).first())).toContain(`timed out after ${TIMEOUT_SECONDS} s`);
        expect(elapsedMs).toBeLessThan(TIMEOUT_SECONDS * 1000 * 3);
        await captureWindow(page, `01-${dialect.name}-statement-timeout`);

        await runStatement(page, "SELECT 1 AS still_alive");
        await page.getByRole("columnheader", { name: "still_alive" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await showOutput(page);
        expect(await text(output(page))).not.toContain("Reconnected");
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenario(
      `given${dialect.name}ConnectionDroppedWhileIdle_whenRun_thenReconnectsAndRuns`,
      async () => {
        proxy = await chaosProxy({ host: dialect.config.host, port: dialect.config.port });
        const page = await launch({
          id: dialect.name,
          pluginId: dialect.pluginId,
          config: { ...dialect.config, host: proxy.host, port: proxy.port },
        });
        await runStatement(page, "SELECT 1 AS before_drop");

        proxy.reset();
        await expect.poll(() => proxy?.openLinks ?? 0).toBe(0);
        await runStatement(page, "SELECT 2 AS after_drop");

        await page.getByRole("columnheader", { name: "after_drop" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await showOutput(page);
        await expect.poll(() => text(output(page))).toContain("Reconnected: the connection had been lost.");
        await captureWindow(page, `02-${dialect.name}-idle-drop-reconnected`);
      },
      SCENARIO_TIMEOUT_MS,
    );

    scenario(
      `given${dialect.name}StatementInFlight_whenNetworkBlackholed_thenLostWithinKeepAliveWindow`,
      async () => {
        proxy = await chaosProxy({ host: dialect.config.host, port: dialect.config.port });
        const profile = newProfile();
        const { password: _password, ...plain } = dialect.config;
        const saved: SavedDatasource = {
          id: dialect.name,
          name: dialect.name,
          pluginId: dialect.pluginId,
          keepAliveSeconds: KEEPALIVE_SECONDS,
          config: { ...plain, host: proxy.host, port: proxy.port },
          secretModes: { password: "never" },
        };
        seedDatasources(profile, [saved]);
        const page = await launch(null, profile);
        await openConsoleOn(page, dialect.name);
        await answerSecretPrompt(page, dialect.name, PASSWORD);
        await waitUntilReady(page);

        await startStatement(page, dialect.sleep);
        await expect.poll(() => proxy?.openLinks ?? 0).toBeGreaterThan(0);
        const started = Date.now();
        proxy.blackhole();
        await consoleAlert(page).first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        const elapsedMs = Date.now() - started;

        await expect.poll(() => text(consoleAlert(page).first())).toContain("lost while the statement ran");
        expect(elapsedMs).toBeLessThan((KEEPALIVE_SECONDS + 10) * 1000);
        await captureWindow(page, `03-${dialect.name}-in-flight-blackhole`);
      },
      SCENARIO_TIMEOUT_MS,
    );
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresUrl_whenPasted_thenFieldsFilledAndPasswordSavedOutsideTheFile",
    async () => {
      const page = await launch(null);
      await newDatasource(page, "PostgreSQL", "from-url");
      const url =
        `postgres://${POSTGRES_CONFIG.user}:${PASSWORD}@${POSTGRES_CONFIG.host}:${POSTGRES_CONFIG.port}` +
        `/${POSTGRES_CONFIG.database}?sslmode=disable&target_session_attrs=any`;

      await paste(page, "URL", url);

      await expect.poll(() => field(page, "Host").inputValue()).toBe(POSTGRES_CONFIG.host);
      await expect.poll(() => field(page, "Port").inputValue()).toBe(String(POSTGRES_CONFIG.port));
      await expect.poll(() => field(page, "Database").inputValue()).toBe(POSTGRES_CONFIG.database);
      await expect.poll(() => field(page, "User").inputValue()).toBe(POSTGRES_CONFIG.user);
      expect(await field(page, "URL").inputValue()).not.toMatch(new RegExp(`:${PASSWORD}@`));
      await expect.poll(() => text(urlNote(page))).toContain("Password from the URL; saved with Forever.");
      await expect.poll(() => text(urlNote(page))).toContain("Ignored: target_session_attrs.");
      expect((await testConnection(page)).ok).toBe(true);
      await captureWindow(page, "04-postgres-url-pasted");

      await dataSourcesDialog(page).getByRole("button", { name: "OK", exact: true }).click();
      await dataSourcesDialog(page).waitFor({ state: "detached" });
      const file = readProfileFile(running?.userDataDir ?? "", "datasources.json") ?? "";
      expect((JSON.parse(file) as { datasources: { config: object }[] }).datasources[0]?.config).not.toHaveProperty(
        "password",
      );
      expect(file).toContain('"password": "forever"');

      await openConsoleOn(page, "from-url");
      await runStatement(page, "SELECT current_user AS who");
      await page.getByRole("gridcell", { name: POSTGRES_CONFIG.user }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlUrlPastedIntoHost_whenTested_thenFieldsFilledAndConnects",
    async () => {
      const page = await launch(null);
      await newDatasource(page, "MySQL", "mysql-url");
      const url =
        `mysql://${MYSQL_CONFIG.user}:${MYSQL_CONFIG.password}@${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}` +
        `/${MYSQL_CONFIG.database}?ssl-mode=DISABLED`;

      await paste(page, "Host", url);

      await expect.poll(() => field(page, "Host").inputValue()).toBe(MYSQL_CONFIG.host);
      await expect.poll(() => field(page, "Port").inputValue()).toBe(String(MYSQL_CONFIG.port));
      await expect.poll(() => field(page, "Database").inputValue()).toBe(MYSQL_CONFIG.database);
      await expect.poll(() => text(urlNote(page))).toContain("Password from the URL");
      expect((await testConnection(page)).ok).toBe(true);
      await captureWindow(page, "05-mysql-url-pasted-into-host");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqliteUrl_whenPasted_thenFileFilledAndConnects",
    async () => {
      const profile = newProfile();
      const path = join(profile, "pasted.sqlite");
      const page = await launch(null, profile);
      await newDatasource(page, "SQLite", "sqlite-url");

      await paste(page, "URL", `sqlite://${path}`);

      await expect.poll(() => field(page, "File").inputValue()).toBe(path);
      expect((await testConnection(page)).ok).toBe(true);
      await captureWindow(page, "05-sqlite-url-pasted");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenSavedPostgres_whenCopiedAsUrl_thenClipboardHasNoPassword",
    async () => {
      const profile = newProfile();
      const { password: _password, ...plain } = POSTGRES_CONFIG;
      seedDatasources(profile, [
        {
          id: "pg-saved",
          name: "pg-saved",
          pluginId: "postgres",
          config: { ...plain, sslMode: "require" },
          secretModes: { password: "forever" },
        },
      ]);
      const page = await launch(SCRATCH, profile);

      await treeNode(page, "pg-saved").click({ button: "right" });
      const copy = page.getByRole("menuitem", { name: /^Copy as URL/ });
      await copy.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "06-copy-as-url-menu");
      await copy.click();

      const expected =
        `postgresql://${POSTGRES_CONFIG.user}@${POSTGRES_CONFIG.host}:${POSTGRES_CONFIG.port}` +
        `/${POSTGRES_CONFIG.database}?sslmode=require`;
      const app = running?.app;
      if (app === undefined) throw new Error("The app is not running.");
      await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe(expected);
      await sqlEditor(page).fill(`-- Copied: ${expected}`);
      await captureWindow(page, "06-copy-as-url-pasted");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
