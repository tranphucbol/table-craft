/**
 * Plan 121's live test: the (i) in Settings › MCP Server › Data source access says how an agent's
 * statement timeout is enforced on each server, from what a console connect or an agent session
 * last saw there. Gated, because it needs a display, a fresh build and the containers:
 *
 *   TABLE_CRAFT_DATABASES=all TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/121 \
 *     bun run test:smoke:db:headless test/e2e/timeoutInfo.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  databaseEnabled,
  MARIADB_CONFIG,
  MYSQL_CONFIG,
  POSTGRES_CONFIG,
  REDIS_CONFIG,
  tidbConfigFromEnv,
  type DatabaseId,
} from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  fillNewDatasource,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  readProfileFile,
  seedDatasources,
  seedSettings,
  setWindowSize,
  toolWindow,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
  chooseOption,
  optionValue,
} from "./harness.js";
import { AgentClient, freePort } from "./mcpAgent.js";

const captureNow = evidenceFor("121");
/** Run in the page: dialogs and popovers fade in, so a capture waits for every finite animation. */
const ANIMATIONS_FINISHED =
  "Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished))";

async function captureWindow(page: Page, name: string): Promise<void> {
  await page.evaluate(ANIMATIONS_FINISHED);
  await captureNow(page, name);
}

const SCENARIO_MS = 120_000;
const OWN_SECONDS = 30;
const KNOWN_CLIENTS = [{ name: "Claude Code", allowed: true }] as const;
const DEFAULT_SOURCE = "120 s, the Statement timeout above";
const INFO_FOCUSED = "document.activeElement?.matches('[data-testid=\"mcp-timeout-info\"]') === true";

type Config = Readonly<Record<string, string | number | boolean>>;

function withoutPassword(config: Config & { readonly password: string }): Config {
  const { password: _password, ...plain } = config;
  return plain;
}

function saved(id: string, pluginId: string, config: Config & { readonly password: string }): SavedDatasource {
  return { id, name: id, pluginId, config: withoutPassword(config), secretModes: { password: "never" } };
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function infoButton(settings: Locator, name: string) {
  return settings.getByRole("button", { name: `How the timeout works on ${name}`, exact: true });
}

function explainer(page: Page) {
  return page.getByTestId("mcp-timeout-explainer");
}

async function openAccess(page: Page): Promise<Locator> {
  await findAction(page, "MCP Server Settings");
  const settings = settingsDialog(page);
  await settings.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return settings;
}

/** Sets the row to Read only, the way every scenario starts (plan 121's live test). */
async function exposeReadOnly(settings: Locator, name: string): Promise<void> {
  const access = settings.getByLabel(`AI agent access for ${name}`, { exact: true });
  await chooseOption(access, "read");
  await expect.poll(() => optionValue(access)).toBe("read");
}

/** Hovers the (i), checks its one-line summary, then clicks it open. */
async function openExplainer(page: Page, settings: Locator, name: string, summary: RegExp): Promise<Locator> {
  const button = infoButton(settings, name);
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  expect(await button.getAttribute("title")).toMatch(summary);
  await button.click();
  const popover = explainer(page);
  await popover.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return popover;
}

async function coverage(popover: Locator): Promise<(string | null)[]> {
  const cells = await popover.locator("[data-coverage]").all();
  return Promise.all(cells.map((cell) => cell.getAttribute("data-coverage")));
}

async function connectConsole(page: Page, name: string, password: string | null): Promise<void> {
  await openConsoleOn(page, name);
  if (password !== null) await answerSecretPrompt(page, name, password);
  await waitUntilReady(page);
}

interface Server {
  readonly id: DatabaseId | "sqlite";
  readonly evidence: string;
  readonly datasource: () => SavedDatasource;
  readonly password: () => string | null;
  readonly tone: "covered" | "gap" | null;
  readonly summary: RegExp;
  /** TableCraft's reads and writes, then the server's; null where the shared server decides. */
  readonly cells: readonly string[] | null;
  readonly mentions: readonly string[];
  readonly seen: RegExp;
}

const SERVERS: readonly Server[] = [
  {
    id: "mysql",
    evidence: "02-mysql",
    datasource: () => saved("orders", "mysql", MYSQL_CONFIG),
    password: () => MYSQL_CONFIG.password,
    tone: "covered",
    summary: /^TableCraft cancels at 120 s; MySQL also stops reads itself\.$/,
    cells: ["stops", "stops", "stops", "none"],
    mentions: ["KILL QUERY", "max_execution_time", "fetch_rows"],
    seen: /^Seen on MySQL 8\.4\.\d+ · just now$/,
  },
  {
    id: "mariadb",
    evidence: "03-mariadb",
    datasource: () => saved("ledger", "mysql", MARIADB_CONFIG),
    password: () => MARIADB_CONFIG.password,
    tone: "covered",
    summary: /^TableCraft cancels at 120 s; MariaDB also stops every statement\.$/,
    cells: ["stops", "stops", "stops", "stops"],
    mentions: ["KILL QUERY", "max_statement_time"],
    seen: /^Seen on MariaDB 10\.11\.\S+ · just now$/,
  },
  {
    id: "tidb",
    evidence: "04-tidb",
    datasource: () => saved("warehouse", "mysql", tidbConfigFromEnv()),
    password: () => tidbConfigFromEnv().password,
    tone: null,
    summary: /TiDB/,
    cells: null,
    mentions: ["max_execution_time"],
    seen: /^Seen on TiDB \S+ · just now$/,
  },
  {
    id: "postgres",
    evidence: "05-postgres",
    datasource: () => saved("analytics", "postgres", POSTGRES_CONFIG),
    password: () => POSTGRES_CONFIG.password,
    tone: "covered",
    summary: /^TableCraft cancels at 120 s; PostgreSQL also stops every statement\.$/,
    cells: ["stops", "stops", "stops", "stops"],
    mentions: ["pg_cancel_backend", "statement_timeout", "fetch_rows"],
    seen: /^Seen on PostgreSQL 17\.\S+ · just now$/,
  },
  {
    id: "redis",
    evidence: "06-redis",
    datasource: () => saved("cache", "redis", REDIS_CONFIG),
    password: () => REDIS_CONFIG.password,
    tone: "gap",
    summary: /^TableCraft stops only blocking Redis commands at 120 s\.$/,
    cells: ["blockingOnly", "blockingOnly", "none", "none"],
    mentions: ["CLIENT UNBLOCK", "Redis has no limit of its own here."],
    seen: /^Seen on Redis 7\.4\.\S+ · just now$/,
  },
  {
    id: "sqlite",
    evidence: "07-sqlite",
    datasource: () => ({ id: "local", name: "local", pluginId: "sqlite", config: { path: seededSqliteFile() } }),
    password: () => null,
    tone: "gap",
    summary: /^SQLite cannot stop a running statement: agents' statements run to the end\.$/,
    cells: ["none", "none", "none", "none"],
    mentions: ["TableCraft cannot cancel a statement on SQLite; it runs to the end."],
    seen: /^Seen on SQLite \S+ · just now$/,
  },
];

const MYSQL_ORDERS = (): SavedDatasource => saved("orders", "mysql", MYSQL_CONFIG);

describe.runIf(DATABASES_ENABLED)("agent timeout explainer live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launched(datasources: readonly SavedDatasource[], settings: object = {}): Promise<Page> {
    const userDataDir = newProfile();
    seedDatasources(userDataDir, datasources);
    seedSettings(userDataDir, { version: 1, appearance: { motion: "off" }, ...settings });
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running.page;
  }

  it.skipIf(!databaseEnabled("mysql"))(
    "givenNeverConnected_whenInfoOpened_thenUnseenAndTestConnectionOpensDataSources",
    async () => {
      const page = await launched([MYSQL_ORDERS()]);
      const settings = await openAccess(page);
      await exposeReadOnly(settings, "orders");
      expect(await infoButton(settings, "orders").getAttribute("data-tone")).toBe("unseen");

      const popover = await openExplainer(page, settings, "orders", /^Connect or test orders to see/);
      expect(await popover.textContent()).toContain("Connect or test it once");
      expect(await popover.getByTestId("mcp-timeout-seen").textContent()).toBe("Not seen yet");
      expect(await coverage(popover)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
      await captureWindow(page, "01-unseen");

      await popover.getByTestId("mcp-timeout-test").click();
      const dialog = dataSourcesDialog(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await settings.waitFor({ state: "detached" });
      expect(await dialog.getByLabel("Name", { exact: true }).inputValue()).toBe("orders");
      await captureWindow(page, "01-unseen-test-connection");
    },
    SCENARIO_MS,
  );

  for (const server of SERVERS) {
    it.skipIf(server.id !== "sqlite" && !databaseEnabled(server.id))(
      `given${server.id}Connected_whenInfoOpened_thenSaysWhatStopsAStatement`,
      async () => {
        const datasource = server.datasource();
        const page = await launched([datasource]);
        await connectConsole(page, datasource.name, server.password());

        const settings = await openAccess(page);
        await exposeReadOnly(settings, datasource.name);
        const button = infoButton(settings, datasource.name);
        await expect.poll(() => button.getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).not.toBe("unseen");
        if (server.tone !== null) expect(await button.getAttribute("data-tone")).toBe(server.tone);

        const popover = await openExplainer(page, settings, datasource.name, server.summary);
        const text = (await popover.textContent()) ?? "";
        for (const mention of server.mentions) expect(text).toContain(mention);
        if (server.cells !== null) expect(await coverage(popover)).toEqual(server.cells);
        expect(await popover.getByTestId("mcp-timeout-limit").textContent()).toBe(DEFAULT_SOURCE);
        expect(await popover.getByTestId("mcp-timeout-seen").textContent()).toMatch(server.seen);
        await captureWindow(page, server.evidence);
      },
      SCENARIO_MS,
    );
  }

  it.skipIf(!databaseEnabled("postgres"))(
    "givenNeverConnectedInTheUi_whenAnAgentRunsAQuery_thenTheInfoTurnsSeen",
    async () => {
      const port = await freePort();
      const page = await launched([], {
        mcp: { enabled: true, port, rowCap: 100, clients: KNOWN_CLIENTS },
      });
      await fillNewDatasource(page, {
        kind: "PostgreSQL",
        name: "analytics",
        fields: {
          Host: POSTGRES_CONFIG.host,
          Port: String(POSTGRES_CONFIG.port),
          Database: POSTGRES_CONFIG.database,
          User: POSTGRES_CONFIG.user,
        },
        password: POSTGRES_CONFIG.password,
        passwordMode: "forever",
      });
      const dialog = dataSourcesDialog(page);
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      const settings = await openAccess(page);
      await exposeReadOnly(settings, "analytics");
      const button = infoButton(settings, "analytics");
      expect(await button.getAttribute("data-tone")).toBe("unseen");
      await captureWindow(page, "08-agent-teaches-before");

      await settings.getByTestId("mcp-copy-config").click();
      await expect.poll(() => settings.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
      const app = running?.app;
      if (app === undefined) throw new Error("The app is not running.");
      const token = /Bearer (tc_[\w-]+)/.exec(await app.evaluate(({ clipboard }) => clipboard.readText()))?.[1];
      if (token === undefined) throw new Error("The copied config holds no token.");
      const agent = new AgentClient(port, token);
      await agent.initialize("Claude Code");
      const answered = await agent.tool("run_query", { datasource: "analytics", sql: "SELECT 1 AS one" });
      expect(answered.isError).toBe(false);

      await expect.poll(() => button.getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("covered");
      const popover = await openExplainer(page, settings, "analytics", /PostgreSQL also stops every statement/);
      expect(await popover.getByTestId("mcp-timeout-seen").textContent()).toMatch(/^Seen on PostgreSQL 17\.\S+ · /);
      await captureWindow(page, "08-agent-teaches");
      await agent.close();

      const stored = JSON.parse(readProfileFile(running?.userDataDir ?? "", "datasources.json") ?? "{}") as {
        datasources?: { lastServer?: { cancel?: unknown } }[];
      };
      expect(stored.datasources?.[0]?.lastServer?.cancel).toEqual({
        method: "pg_cancel_backend",
        reaches: "statement",
      });
    },
    SCENARIO_MS,
  );

  it.skipIf(!databaseEnabled("mysql"))(
    "givenOwnTimeout_whenInfoOpened_thenNamesItsSource",
    async () => {
      const page = await launched([MYSQL_ORDERS()]);
      await connectConsole(page, "orders", MYSQL_CONFIG.password);
      const settings = await openAccess(page);
      await exposeReadOnly(settings, "orders");

      const own = settings.getByLabel("Statement timeout for orders", { exact: true });
      await own.fill(String(OWN_SECONDS));
      await own.press("Enter");
      await expect.poll(() => own.inputValue()).toBe(String(OWN_SECONDS));
      let popover = await openExplainer(page, settings, "orders", /at 30 s/);
      expect(await popover.getByTestId("mcp-timeout-limit").textContent()).toBe("30 s, this data source's own");
      expect(await popover.textContent()).toContain("KILL QUERY at 30 s");
      await captureWindow(page, "09-own-timeout");
      await page.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });

      await own.fill("");
      await own.press("Enter");
      await expect.poll(() => own.inputValue()).toBe("");
      popover = await openExplainer(page, settings, "orders", /at 120 s/);
      expect(await popover.getByTestId("mcp-timeout-limit").textContent()).toBe(DEFAULT_SOURCE);
      await captureWindow(page, "09-own-timeout-blank");
    },
    SCENARIO_MS,
  );

  it.skipIf(!databaseEnabled("mysql"))(
    "givenKeyboard_whenInfoReached_thenEnterOpensAndEscapeClosesOnlyThePopover",
    async () => {
      const page = await launched([MYSQL_ORDERS()]);
      await connectConsole(page, "orders", MYSQL_CONFIG.password);
      const settings = await openAccess(page);
      await exposeReadOnly(settings, "orders");

      await settings.getByLabel("Row cap for orders", { exact: true }).focus();
      await page.keyboard.press("Tab");
      const button = infoButton(settings, "orders");
      await expect.poll(() => page.evaluate(INFO_FOCUSED)).toBe(true);
      await page.keyboard.press("Enter");
      const popover = explainer(page);
      await popover.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await button.getAttribute("aria-expanded")).toBe("true");
      await captureWindow(page, "10-keyboard");

      await page.keyboard.press("Escape");
      await popover.waitFor({ state: "detached" });
      expect(await settings.isVisible()).toBe(true);
      await expect.poll(() => page.evaluate(INFO_FOCUSED)).toBe(true);
      expect(await button.getAttribute("aria-expanded")).toBe("false");
      await captureWindow(page, "10-keyboard-closed");
    },
    SCENARIO_MS,
  );

  for (const theme of ["light", "highContrast"] as const) {
    it(
      `givenOffRowIn${theme}_whenAccessShown_thenNoInfoAndTonesReadable`,
      async () => {
        const sqlite: SavedDatasource = {
          id: "local",
          name: "local",
          pluginId: "sqlite",
          config: { path: seededSqliteFile() },
        };
        const off: SavedDatasource = {
          id: "archive",
          name: "archive",
          pluginId: "sqlite",
          config: { path: ":memory:" },
        };
        const page = await launched([sqlite, off], { appearance: { motion: "off", theme } });
        const settings = await openAccess(page);
        await exposeReadOnly(settings, "local");

        expect(await infoButton(settings, "archive").count()).toBe(0);
        const offRow = settings.getByRole("row").filter({ hasText: "archive" });
        expect(await offRow.textContent()).toContain("—");
        const popover = await openExplainer(page, settings, "local", /^SQLite cannot stop/);
        expect(await coverage(popover)).toEqual(["none", "none", "none", "none"]);
        await captureWindow(page, theme === "light" ? "11-off-and-themes" : "11-off-and-themes-high-contrast");
      },
      SCENARIO_MS,
    );
  }
});
