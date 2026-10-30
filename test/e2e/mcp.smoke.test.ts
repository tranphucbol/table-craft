/**
 * Plan 117's live test: the MCP server an AI agent reaches TableCraft through. An HTTP client in
 * this process plays the agent against the built app on a seeded SQLite file. Gated, because it
 * needs a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/117 bun run test:smoke:headless test/e2e/mcp.smoke.test.ts
 *
 * Plan 120's Ask before reads adds MySQL and Redis scenarios, so its live test runs on the databases:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/120 bun run test:smoke:db:headless:redis test/e2e/mcp.smoke.test.ts
 */
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import mysql from "@table-craft/plugin-mysql";
import { MYSQL_CONFIG, REDIS_CONFIG, TIDB_CONFIG, WITHOUT_REDIS } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { AgentClient, freePort } from "./mcpAgent.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  treeNode,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
  chooseOption,
  optionDisabled,
  optionValue,
} from "./harness.js";

const captureWindow = evidenceFor("117");
const captureAskReads = evidenceFor("120");

const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const RENAME_CUSTOMER = "UPDATE customers SET name = 'Ada King' WHERE id = 1";
const RENAME_REASON = "The customer asked to be renamed";
const DENY_FOCUSED = "document.activeElement?.getAttribute('data-testid') === 'mcp-deny'";
const KNOWN_CLIENTS = [
  { name: "Claude Code", allowed: true },
  { name: "OpenCode", allowed: true },
] as const;
/** Long enough on SQLite for the Services tree to show the call while it runs. */
const SLOW_COUNT =
  "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 30000000) SELECT count(*) FROM c";
const TOKEN_HINT = /^tc_•+[\w-]{4}$/;
const SELECT_CUSTOMERS = "SELECT id, name FROM customers ORDER BY id";
const SELECT_ORDERS = "SELECT id, customer_id FROM orders ORDER BY id";
const READ_REASON = "Checking the customer list";
const KEY_NAME = "user:{42}:session";
const { password: MYSQL_PASSWORD, ...MYSQL_PLAIN } = MYSQL_CONFIG;
const { password: REDIS_PASSWORD, ...REDIS_PLAIN } = REDIS_CONFIG;
const { password: TIDB_PASSWORD, ...TIDB_PLAIN } = TIDB_CONFIG;
const GONE = "gone";
/** No WHERE, so the plan reads every row; the user denies it, so it never runs. */
const RENAME_EVERYONE = `UPDATE customers SET name = '${GONE}'`;
/** Not analysed, so TiDB plans it with pseudo statistics. */
const TIDB_EVENTS = "approval_events";
const TIDB_UPDATE = `UPDATE ${TIDB_EVENTS} SET state = '${GONE}'`;

type MysqlConfig = typeof MYSQL_CONFIG | typeof TIDB_CONFIG;

interface AttributeHolder {
  getAttribute(name: string): string | null;
}

function shop(): SavedDatasource {
  return { id: "shop", name: "shop", pluginId: "sqlite", agentAccess: "ask", config: { path: seededSqliteFile() } };
}

function reports(): SavedDatasource {
  return {
    id: "reports",
    name: "reports",
    pluginId: "sqlite",
    agentAccess: "read",
    config: { path: seededSqliteFile() },
  };
}

function production(): SavedDatasource {
  return {
    id: "prod",
    name: "prod",
    pluginId: "sqlite",
    color: "red",
    agentAccess: "read",
    config: { path: ":memory:" },
  };
}

function hidden(): SavedDatasource {
  return { id: "hidden", name: "hidden", pluginId: "sqlite", config: { path: ":memory:" } };
}

function askingShop(): SavedDatasource {
  return { ...shop(), agentAccess: "askReads" };
}

/** The password is typed into the connect prompt and kept until restart, so the agent's engine finds it. */
function askingMysql(): SavedDatasource {
  return {
    id: "mysql",
    name: "mysql",
    pluginId: "mysql",
    agentAccess: "askReads",
    config: { ...MYSQL_PLAIN, sslMode: "disable" },
    secretModes: { password: "untilRestart" },
  };
}

function askingRedis(): SavedDatasource {
  return {
    id: "redis",
    name: "redis",
    pluginId: "redis",
    agentAccess: "askReads",
    config: REDIS_PLAIN,
    secretModes: { password: "untilRestart" },
  };
}

function askingTidb(): SavedDatasource {
  return {
    id: "tidb",
    name: "tidb",
    pluginId: "mysql",
    agentAccess: "ask",
    config: TIDB_PLAIN,
    ...(TIDB_PASSWORD === "" ? {} : { secretModes: { password: "untilRestart" } }),
  };
}

/** Runs `sql` straight through the plugin, outside the app, and returns the first cell as a number. */
async function countOn(config: MysqlConfig, sql: string): Promise<number> {
  const session = await mysql.connect(config, { readOnly: false });
  try {
    let first: unknown = null;
    for await (const row of (await session.execute(sql)).rows) first ??= row[0];
    return Number(first ?? 0);
  } finally {
    await session.close();
  }
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

function chip(page: Page) {
  return page.getByTestId("status-mcp");
}

function approval(page: Page) {
  return page.getByTestId("mcp-approval");
}

async function clipboardText(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText());
}

describe.runIf(SMOKE_ENABLED)("MCP server live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  /** Launches with the MCP server on at a free port and the given datasources saved. */
  async function launchServing(
    datasources: readonly SavedDatasource[],
    clients: readonly { name: string; allowed: boolean }[] = KNOWN_CLIENTS,
  ): Promise<{ page: Page; port: number }> {
    const port = await freePort();
    const userDataDir = newProfile();
    seedDatasources(userDataDir, datasources);
    seedSettings(userDataDir, {
      version: 1,
      appearance: { motion: "off" },
      mcp: { enabled: true, port, rowCap: 100, clients },
    });
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect.poll(() => chip(running!.page).isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
    return { page: running.page, port };
  }

  /** Copies the Claude Code config from Settings › MCP Server and reads the token out of it. */
  async function copiedToken(page: Page): Promise<string> {
    await findAction(page, "MCP Server Settings");
    const dialog = settingsDialog(page);
    await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await dialog.getByTestId("mcp-copy-config").click();
    await expect.poll(() => dialog.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const match = TOKEN_PATTERN.exec(await clipboardText(running!.app));
    if (match?.[1] === undefined) throw new Error("The copied config holds no token.");
    return match[1];
  }

  /** Connects an agent as `client` with the copied token, closing Settings behind it. */
  async function agentAs(page: Page, port: number, client: string): Promise<AgentClient> {
    const token = await copiedToken(page);
    await page.keyboard.press("Escape");
    const agent = new AgentClient(port, token);
    await agent.initialize(client);
    return agent;
  }

  /** Opens a console on a saved datasource and types its password, which it keeps until restart. */
  async function connectWithPassword(page: Page, name: string, password: string): Promise<void> {
    await openConsoleOn(page, name);
    await answerSecretPrompt(page, name, password);
  }

  async function untilWaiting(page: Page): Promise<void> {
    await expect.poll(() => chip(page).getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("waiting");
  }

  it(
    "givenMcpOn_whenSettingsPageOpened_thenRunningWithEndpointSnippetAndAccessPerDatasource",
    async () => {
      const { page, port } = await launchServing([shop(), reports(), production(), hidden()]);
      await page
        .getByRole("navigation", { name: "Right tool window stripe" })
        .getByRole("button", { name: "MCP Server Settings…" })
        .click();
      const dialog = settingsDialog(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await expect.poll(() => dialog.getByTestId("mcp-state").textContent()).toContain("Running");
      expect(
        await dialog.getByRole("switch", { name: "Let AI agents reach TableCraft" }).getAttribute("aria-checked"),
      ).toBe("true");
      expect(await dialog.getByRole("tablist", { name: "Settings pages" }).textContent()).toContain("Tools");
      expect(await dialog.getByTestId("mcp-endpoint").textContent()).toBe(`http://127.0.0.1:${String(port)}/mcp`);
      await expect.poll(() => dialog.getByTestId("mcp-token-hint").textContent()).toMatch(TOKEN_HINT);
      expect(await dialog.getByTestId("mcp-known-client").allTextContents()).toEqual([
        expect.stringContaining("Claude Code"),
        expect.stringContaining("OpenCode"),
      ]);
      expect(await dialog.getByRole("columnheader").allTextContents()).toEqual([
        "Data source",
        "Access",
        "Schemas",
        "Row cap",
        "Timeout",
      ]);
      const snippet = (await dialog.getByTestId("mcp-client-config").textContent()) ?? "";
      expect(snippet).toContain("claude mcp add --transport http tablecraft");
      expect(snippet).toContain("${TABLECRAFT_TOKEN}");
      expect(snippet).not.toMatch(TOKEN_PATTERN);

      const rows = dialog.getByTestId("mcp-access-row");
      expect(await rows.count()).toBe(4);
      expect(await optionValue(dialog.getByLabel("AI agent access for shop"))).toBe("ask");
      expect(await optionValue(dialog.getByLabel("AI agent access for hidden"))).toBe("off");
      const productionAccess = dialog.getByLabel("AI agent access for prod");
      expect(await optionDisabled(productionAccess, "ask")).toBe(true);
      await captureWindow(page, "01-settings-page");

      await dialog.getByLabel("Row cap for shop").fill("25");
      await dialog.getByLabel("Row cap for shop").press("Enter");
      await expect.poll(() => dialog.getByLabel("Row cap for shop").inputValue()).toBe("25");
      await dialog.getByTestId("mcp-access-filter").fill("rep");
      await expect.poll(() => rows.count()).toBe(1);
      await dialog.getByTestId("mcp-access-filter").fill("");
      const hiddenRow = rows.filter({ hasText: "hidden" });
      expect(await hiddenRow.getByTestId("mcp-access-schemas").count()).toBe(0);
      expect(await hiddenRow.textContent()).toContain("—");
      const productionNote = dialog.getByTestId("mcp-production-note");
      expect(await productionNote.textContent()).toContain("prod is coloured red.");
      await productionNote.scrollIntoViewIfNeeded();
      await captureWindow(page, "11-access-table");
      await dialog.getByTestId("mcp-production-note-close").click();
      await expect.poll(() => productionNote.count()).toBe(0);
      const showNote = dialog.getByTestId("mcp-production-note-show");
      expect(await showNote.count()).toBe(1);
      expect(await showNote.getAttribute("aria-label")).toBe("Why prod stays at Read only");
      await captureWindow(page, "12-access-note-closed");
      await showNote.click();
      await expect.poll(() => productionNote.count()).toBe(1);
      expect(await showNote.count()).toBe(0);

      await dialog.getByRole("button", { name: "OpenCode" }).click();
      expect(await dialog.getByTestId("mcp-client-config").textContent()).toContain('"type": "remote"');
      await captureWindow(page, "02-settings-opencode");

      await dialog.getByTestId("mcp-copy-config").click();
      await expect.poll(() => clipboardText(running!.app)).toMatch(TOKEN_PATTERN);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRedDatasource_whenAskSetOnItsDataSourcesPage_thenSettingsTableShowsAsk",
    async () => {
      const { page } = await launchServing([production()]);
      await treeNode(page, "prod").click();
      await findAction(page, "Data Source Properties");
      const dialog = dataSourcesDialog(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const access = dialog.getByTestId("datasource-agent-access");
      expect(await optionValue(access)).toBe("read");
      await chooseOption(access, "ask");
      await captureWindow(page, "07-datasource-agent-access");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await findAction(page, "MCP Server Settings");
      const settings = settingsDialog(page);
      await expect.poll(() => optionValue(settings.getByLabel("AI agent access for prod"))).toBe("ask");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenClientConnected_whenItReadsAndIsRefused_thenChipCountsItAndPopoverShowsLastCall",
    async () => {
      const { page, port } = await launchServing([shop(), reports(), hidden()]);
      const token = await copiedToken(page);
      await page.keyboard.press("Escape");
      const agent = new AgentClient(port, token);
      await agent.initialize("Claude Code");

      const listed = await agent.tool("list_datasources", {});
      expect(listed.text).toContain("shop");
      expect(listed.text).toContain("reports");
      expect(listed.text).not.toContain("hidden");

      const tables = await agent.tool("list_tables", { datasource: "shop", schema: "main" });
      expect(tables.text).toContain("customers");

      const read = await agent.tool("run_query", {
        datasource: "shop",
        sql: "SELECT id, name FROM customers ORDER BY id",
      });
      expect(read.isError).toBe(false);
      expect(read.text).toContain("Rows 1–");

      const refused = await agent.tool("run_query", { datasource: "reports", sql: RENAME_CUSTOMER });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("read only for agents");

      const hiddenCall = await agent.tool("run_query", { datasource: "hidden", sql: "SELECT 1" });
      expect(hiddenCall.isError).toBe(true);

      await expect.poll(() => chip(page).textContent()).toContain("MCP 1");
      await chip(page).click();
      const popover = page.getByTestId("mcp-popover");
      await popover.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const client = popover.getByTestId("mcp-client");
      expect(await client.textContent()).toContain("Claude Code");
      expect(await client.textContent()).toContain("run_query");
      expect(await client.textContent()).toContain("connected");
      const badges = toolWindow(page, "Database").getByTestId("agent-access-badge");
      expect(
        await badges.evaluateAll((all: readonly AttributeHolder[]) =>
          all.map((badge) => badge.getAttribute("data-access")).sort(),
        ),
      ).toEqual(["ask", "read"]);
      await captureWindow(page, "03-chip-popover");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAgentWantsToWrite_whenChipClickedAndAllowed_thenWriteRunsAndHistoryTagsAgent",
    async () => {
      const { page, port } = await launchServing([shop()]);
      const token = await copiedToken(page);
      await page.keyboard.press("Escape");
      const agent = new AgentClient(port, token);
      await agent.initialize("OpenCode");

      const write = agent.tool("run_query", { datasource: "shop", sql: RENAME_CUSTOMER, reason: RENAME_REASON });
      await expect.poll(() => chip(page).getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("waiting");
      expect(await chip(page).textContent()).toContain("1 waiting");
      expect(await approval(page).count()).toBe(0);
      await captureWindow(page, "04-chip-waiting");

      await chip(page).click();
      const dialog = approval(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.getByRole("heading").first().textContent()).toContain("OpenCode wants to change data");
      expect(await dialog.getByTestId("mcp-approval-datasource").textContent()).toContain("shop");
      expect(await dialog.getByTestId("mcp-approval-sql").textContent()).toContain(RENAME_CUSTOMER);
      expect(await dialog.textContent()).toContain(RENAME_REASON);
      expect(await dialog.getByTestId("mcp-approval-countdown").textContent()).toMatch(
        /Denied automatically in [01]:\d\d/,
      );
      await expect.poll(() => page.evaluate(DENY_FOCUSED)).toBe(true);
      await captureWindow(page, "05-approval-dialog");

      await dialog.getByTestId("mcp-allow").click();
      const answer = await write;
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain("1 row affected");
      await expect.poll(() => chip(page).getAttribute("data-tone")).toBe("running");

      const again = agent.tool("run_query", { datasource: "shop", sql: RENAME_CUSTOMER });
      await expect.poll(() => chip(page).getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("waiting");
      await chip(page).click();
      await approval(page).getByTestId("mcp-deny").click();
      const denied = await again;
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/denied/i);

      const handed = agent.tool("run_query", { datasource: "shop", sql: "DELETE FROM orders WHERE id = 1" });
      await expect.poll(() => chip(page).getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("waiting");
      await chip(page).click();
      await approval(page).getByTestId("mcp-hand-off").click();
      const handedOff = await handed;
      expect(handedOff.isError).toBe(true);
      await expect
        .poll(() => page.locator('[data-testid="sql-editor"] .cm-content').last().textContent())
        .toContain("DELETE FROM orders WHERE id = 1");

      await openConsoleOn(page, "shop");
      await waitUntilReady(page);
      await pressChord(page, "Alt+E");
      const history = page.getByRole("dialog", { name: "Query History: shop" });
      await history.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await history.getByTestId("history-origin-agents").click();
      await expect.poll(() => history.getByTestId("history-agent").first().textContent()).toBe("OpenCode");
      await captureWindow(page, "06-history-agent");
      await page.keyboard.press("Escape");

      await findAction(page, "Show Agent Activity");
      const activity = page.getByTestId("mcp-activity");
      await activity.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const calls = activity.getByTestId("mcp-activity-row");
      await expect.poll(() => calls.count()).toBe(3);
      expect(
        await calls.evaluateAll((rows: readonly AttributeHolder[]) =>
          rows.map((row) => row.getAttribute("data-outcome")),
        ),
      ).toEqual(["handedOff", "denied", "ok"]);
      await chooseOption(activity.getByTestId("mcp-activity-outcome"), "denied");
      await expect.poll(() => calls.count()).toBe(1);
      await chooseOption(activity.getByTestId("mcp-activity-outcome"), "");
      await captureWindow(page, "09-agent-activity");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUnknownClient_whenItCallsAndUserAllowsFromChip_thenCallRunsAndClientIsRemembered",
    async () => {
      const { page, port } = await launchServing([shop()], []);
      const token = await copiedToken(page);
      await page.keyboard.press("Escape");
      const agent = new AgentClient(port, token);
      await agent.initialize("Cursor");

      const listed = agent.tool("list_datasources", {});
      await expect.poll(() => chip(page).textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("Cursor asks");
      expect(await chip(page).getAttribute("data-tone")).toBe("waiting");
      await chip(page).click();
      const popover = page.getByTestId("mcp-popover");
      const pending = popover.getByTestId("mcp-pending-client");
      await pending.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await pending.textContent()).toContain("Refused automatically in");
      await captureWindow(page, "08-client-asks");
      await pending.getByTestId("mcp-allow-client").click();

      const answer = await listed;
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain("shop");
      await page.keyboard.press("Escape");
      await findAction(page, "MCP Server Settings");
      const known = settingsDialog(page).getByTestId("mcp-known-client");
      await expect.poll(() => known.allTextContents()).toEqual([expect.stringContaining("Cursor")]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAgentStatementRunning_whenServicesShown_thenAgentsNodeListsClientDatasourceAndCall",
    async () => {
      const { page, port } = await launchServing([shop()]);
      const token = await copiedToken(page);
      await page.keyboard.press("Escape");
      const agent = new AgentClient(port, token);
      await agent.initialize("Claude Code");

      const slow = agent.tool("run_query", { datasource: "shop", sql: SLOW_COUNT });
      const services = toolWindow(page, "Services");
      const call = services.locator('[role="treeitem"][data-kind="agentRun"]');
      await call.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await services.locator('[role="treeitem"][data-kind="agentClient"]').textContent()).toContain(
        "Claude Code",
      );
      expect(await services.locator('[role="treeitem"][data-kind="agentDatasource"]').textContent()).toContain("shop");
      expect(await call.textContent()).toContain("run_query");
      // SQLite declares no `cancel` capability, so its run offers no Cancel (decision 007).
      expect(await call.locator('[data-action="mcp.cancel"]').count()).toBe(0);
      await captureWindow(page, "10-services-agents");

      expect((await slow).isError).toBe(false);
      await expect.poll(() => call.count()).toBe(0);
      const finished = services.locator('[role="treeitem"][data-kind="agentCall"]');
      await expect.poll(() => finished.getAttribute("data-state")).toBe("ok");
      expect(await finished.textContent()).toContain("WITH RECURSIVE");
      await agent.close();
      await expect
        .poll(() => services.locator('[role="treeitem"][data-kind="agentClient"]').textContent())
        .toContain("disconnected");
      expect(await finished.count()).toBe(1);
      await captureWindow(page, "13-services-agent-history");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAskReadsDatasource_whenDataSourcesOpened_thenLevelListedAndBadgeAmber",
    async () => {
      const { page } = await launchServing([askingShop()]);
      const badge = toolWindow(page, "Database").getByTestId("agent-access-badge");
      await expect.poll(() => badge.getAttribute("data-access")).toBe("askReads");
      expect(await badge.getAttribute("class")).toContain("border-warning");

      await treeNode(page, "shop").click();
      await findAction(page, "Data Source Properties");
      const dialog = dataSourcesDialog(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const access = dialog.getByTestId("datasource-agent-access");
      expect(await optionValue(access)).toBe("askReads");
      expect(await access.textContent()).toBe("Ask before reads");
      await captureAskReads(page, "01-level");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenProductionDatasource_whenMcpSettings_thenAskReadsSelectable",
    async () => {
      const { page } = await launchServing([production()]);
      await findAction(page, "MCP Server Settings");
      const dialog = settingsDialog(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const access = dialog.getByLabel("AI agent access for prod");
      expect(await optionDisabled(access, "askReads")).toBe(false);
      expect(await optionDisabled(access, "ask")).toBe(true);

      await chooseOption(access, "askReads");
      await expect.poll(() => optionValue(access)).toBe("askReads");
      expect(await optionDisabled(access, "ask")).toBe(true);
      await dialog.getByTestId("mcp-production-note").scrollIntoViewIfNeeded();
      await captureAskReads(page, "09-production");
      await page.keyboard.press("Escape");
      await expect
        .poll(() => toolWindow(page, "Database").getByTestId("agent-access-badge").getAttribute("data-access"))
        .toBe("askReads");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(!DATABASES_ENABLED)(
    "givenAskReads_whenAgentSelects_thenChipAmberAndAllowRunsIt",
    async () => {
      const { page, port } = await launchServing([askingMysql()]);
      const agent = await agentAs(page, port, "OpenCode");
      await connectWithPassword(page, "mysql", MYSQL_PASSWORD);

      const tables = await agent.tool("list_tables", { datasource: "mysql", schema: MYSQL_PLAIN.database });
      expect(tables.isError).toBe(false);
      expect(tables.text).toContain("customers");
      const described = await agent.tool("describe_table", {
        datasource: "mysql",
        schema: MYSQL_PLAIN.database,
        table: "customers",
      });
      expect(described.isError).toBe(false);
      expect(described.text).toContain("email");
      expect(await chip(page).getAttribute("data-tone")).not.toBe("waiting");
      await chip(page).click();
      const popover = page.getByTestId("mcp-popover");
      await popover.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => popover.getByTestId("mcp-client").textContent()).toContain("describe_table");
      await captureAskReads(page, "07-catalog");
      await page.keyboard.press("Escape");

      const refused = await agent.tool("run_query", { datasource: "mysql", sql: RENAME_CUSTOMER });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("read only with the user's approval");
      expect(await chip(page).getAttribute("data-tone")).not.toBe("waiting");
      expect(await approval(page).count()).toBe(0);
      await chip(page).click();
      await popover.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => popover.getByTestId("mcp-client").textContent()).toContain("run_query");
      await captureAskReads(page, "06-refused");
      await page.keyboard.press("Escape");

      const read = agent.tool("run_query", { datasource: "mysql", sql: SELECT_CUSTOMERS, reason: READ_REASON });
      await untilWaiting(page);
      expect(await chip(page).textContent()).toContain("1 waiting");
      await chip(page).click();
      const dialog = approval(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.getByRole("heading").first().textContent()).toContain("OpenCode wants to read data");
      expect(await dialog.getByTestId("mcp-approval-sql").textContent()).toContain(SELECT_CUSTOMERS);
      expect(await dialog.textContent()).toContain("Data read");
      expect(await dialog.textContent()).toContain(READ_REASON);
      await expect.poll(() => page.evaluate(DENY_FOCUSED)).toBe(true);
      await captureAskReads(page, "02-read-request");

      await dialog.getByTestId("mcp-allow").click();
      const rows = await read;
      expect(rows.isError).toBe(false);
      expect(rows.text).toContain("Rows 1–");

      const again = agent.tool("run_query", { datasource: "mysql", sql: SELECT_ORDERS });
      await untilWaiting(page);
      await captureAskReads(page, "03-allowed");
      await chip(page).click();
      await approval(page).getByTestId("mcp-allow").click();
      expect((await again).isError).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(!DATABASES_ENABLED)(
    "givenAskReads_whenAgentSelectsAndUserDenies_thenAgentHearsDenied",
    async () => {
      const { page, port } = await launchServing([askingMysql()]);
      const agent = await agentAs(page, port, "Claude Code");
      await connectWithPassword(page, "mysql", MYSQL_PASSWORD);
      await waitUntilReady(page);

      const read = agent.tool("run_query", { datasource: "mysql", sql: SELECT_CUSTOMERS });
      await untilWaiting(page);
      await chip(page).click();
      await approval(page).getByTestId("mcp-deny").click();
      const denied = await read;
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/denied/i);

      await pressChord(page, "Alt+E");
      const history = page.getByRole("dialog", { name: "Query History: mysql" });
      await history.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await history.getByTestId("history-origin-agents").click();
      const entry = history.getByRole("option").filter({ hasText: SELECT_CUSTOMERS });
      await expect.poll(() => entry.locator("[data-outcome]").getAttribute("data-outcome")).toBe("cancelled");
      expect(await entry.getByTestId("history-agent").textContent()).toBe("Claude Code");
      await captureAskReads(page, "04-denied");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAskReads_whenAllowReadsForSession_thenNextSelectRunsUnasked",
    async () => {
      const { page, port } = await launchServing([askingShop()]);
      const agent = await agentAs(page, port, "OpenCode");

      const first = agent.tool("run_query", { datasource: "shop", sql: SELECT_CUSTOMERS });
      await untilWaiting(page);
      await chip(page).click();
      const dialog = approval(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await dialog.getByLabel("Allow reads on shop for the rest of this agent session").check();
      expect(await dialog.getByTestId("mcp-allow").textContent()).toBe("Allow");
      await captureAskReads(page, "05-session");
      await dialog.getByTestId("mcp-allow").click();
      expect((await first).isError).toBe(false);

      const second = await agent.tool("run_query", { datasource: "shop", sql: SELECT_ORDERS });
      expect(second.isError).toBe(false);
      expect(second.text).toContain("Rows 1–");
      expect(await approval(page).count()).toBe(0);
      expect(await chip(page).getAttribute("data-tone")).not.toBe("waiting");

      await findAction(page, "Show Agent Activity");
      const activity = page.getByTestId("mcp-activity");
      await activity.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const calls = activity.getByTestId("mcp-activity-row");
      await expect.poll(() => calls.count()).toBe(2);
      expect(
        await calls.evaluateAll((all: readonly AttributeHolder[]) =>
          all.map((row) => row.getAttribute("data-outcome")),
        ),
      ).toEqual(["ok", "ok"]);
      await captureAskReads(page, "05-session-activity");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(!DATABASES_ENABLED || WITHOUT_REDIS)(
    "givenAskReads_whenGetKey_thenDialogShowsKeyAndDatabase",
    async () => {
      const { page, port } = await launchServing([askingRedis()]);
      const agent = await agentAs(page, port, "OpenCode");
      await connectWithPassword(page, "redis", REDIS_PASSWORD);

      const scanned = await agent.tool("scan_keys", { datasource: "redis", pattern: "user:*", database: 0 });
      expect(scanned.isError).toBe(false);
      expect(scanned.text).toContain(KEY_NAME);
      expect(await approval(page).count()).toBe(0);

      const value = agent.tool("get_key", { datasource: "redis", key: KEY_NAME, database: 0, reason: READ_REASON });
      await untilWaiting(page);
      await chip(page).click();
      const dialog = approval(page);
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.getByRole("heading").first().textContent()).toContain("OpenCode wants to read data");
      const key = await dialog.getByTestId("mcp-approval-key").textContent();
      expect(key).toContain(KEY_NAME);
      expect(key).toContain("database 0");
      expect(await dialog.getByTestId("mcp-approval-sql").count()).toBe(0);
      expect(await dialog.getByTestId("mcp-approval-view").count()).toBe(0);
      await captureAskReads(page, "08-key");

      await dialog.getByTestId("mcp-allow").click();
      const answer = await value;
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain("token-42");
    },
    SCENARIO_TIMEOUT_MS,
  );

  /** Opens the waiting request's Plan view and waits for the plan. */
  async function planOf(page: Page) {
    await chip(page).click();
    const dialog = approval(page);
    await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await dialog.getByTestId("mcp-approval-view").getByRole("button", { name: "Plan" }).click();
    const plan = dialog.getByTestId("mcp-approval-plan");
    const status = dialog.getByTestId("mcp-approval-plan-status");
    await plan.or(dialog.getByRole("alert")).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    if (!(await plan.isVisible())) throw new Error(`No plan: ${(await status.textContent()) ?? ""}`);
    return dialog;
  }

  async function warnedRows(dialog: ReturnType<typeof approval>): Promise<number> {
    return dialog.locator('[data-testid="mcp-approval-plan-row"][data-warned="true"]').count();
  }

  it.skipIf(!DATABASES_ENABLED)(
    "givenWaitingUpdateOnMysql_whenPlanShown_thenFullScanAmberAndRequestStillWaits",
    async () => {
      const { page, port } = await launchServing([{ ...askingMysql(), agentAccess: "ask" }]);
      const agent = await agentAs(page, port, "OpenCode");
      await connectWithPassword(page, "mysql", MYSQL_PASSWORD);

      const update = agent.tool("run_query", { datasource: "mysql", sql: RENAME_EVERYONE, reason: RENAME_REASON });
      await untilWaiting(page);
      const dialog = await planOf(page);

      expect(await warnedRows(dialog)).toBeGreaterThan(0);
      expect(await dialog.getByTestId("mcp-approval-plan-warnings").textContent()).toContain(
        "Full table scan: reads every row of customers.",
      );
      expect(await dialog.getByTestId("mcp-approval-plan-note").textContent()).toContain("the statement did not run");
      expect(await chip(page).getAttribute("data-tone")).toBe("waiting");
      expect(await dialog.getByTestId("mcp-approval-countdown").isVisible()).toBe(true);
      await captureAskReads(page, "10-plan-mysql");

      await dialog.getByTestId("mcp-approval-view").getByRole("button", { name: "SQL" }).click();
      expect(await dialog.getByTestId("mcp-approval-sql").textContent()).toContain(RENAME_EVERYONE);
      await dialog.getByTestId("mcp-deny").click();
      expect((await update).isError).toBe(true);
      expect(await countOn(MYSQL_CONFIG, `SELECT COUNT(*) FROM customers WHERE name = '${GONE}'`)).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(!DATABASES_ENABLED)(
    "givenWaitingUpdateOnTidb_whenPlanShown_thenFullScanAndGuessedEstimatesWarnedOnce",
    async () => {
      await countOn(TIDB_CONFIG, `DROP TABLE IF EXISTS ${TIDB_EVENTS}`);
      await countOn(
        TIDB_CONFIG,
        `CREATE TABLE ${TIDB_EVENTS} (id BIGINT PRIMARY KEY, shop_id INT NOT NULL, state VARCHAR(16))`,
      );
      await countOn(TIDB_CONFIG, `INSERT INTO ${TIDB_EVENTS} VALUES (1, 10, 'new'), (2, 20, 'done')`);
      try {
        const { page, port } = await launchServing([askingTidb()]);
        const agent = await agentAs(page, port, "Claude Code");
        if (TIDB_PASSWORD === "") await openConsoleOn(page, "tidb");
        else await connectWithPassword(page, "tidb", TIDB_PASSWORD);
        // The server may be shared; its other databases stay out of the evidence.
        await page.getByRole("button", { name: "Hide Database" }).click();
        await toolWindow(page, "Database").waitFor({ state: "hidden" });

        const update = agent.tool("run_query", { datasource: "tidb", sql: TIDB_UPDATE, reason: RENAME_REASON });
        await untilWaiting(page);
        const dialog = await planOf(page);

        const warnings = await dialog.getByTestId("mcp-approval-plan-warnings").locator("li").allTextContents();
        expect(warnings).toContain(`Full table scan: reads every row of ${TIDB_EVENTS}.`);
        expect(warnings.filter((warning) => warning.startsWith("Full table scan"))).toHaveLength(1);
        expect(await dialog.getByTestId("mcp-approval-plan").textContent()).toContain("TableFullScan");
        expect(await chip(page).getAttribute("data-tone")).toBe("waiting");
        await captureAskReads(page, "11-plan-tidb");

        await dialog.getByTestId("mcp-deny").click();
        expect((await update).isError).toBe(true);
        expect(await countOn(TIDB_CONFIG, `SELECT COUNT(*) FROM ${TIDB_EVENTS} WHERE state = '${GONE}'`)).toBe(0);
      } finally {
        await countOn(TIDB_CONFIG, `DROP TABLE IF EXISTS ${TIDB_EVENTS}`);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
