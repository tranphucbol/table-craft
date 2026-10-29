/**
 * Plan 117's live test: the MCP server an AI agent reaches TableCraft through. An HTTP client in
 * this process plays the agent against the built app on a seeded SQLite file. Gated, because it
 * needs a display and a fresh build:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/117 bun run test:smoke:headless test/e2e/mcp.smoke.test.ts
 */
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { AgentClient, freePort } from "./mcpAgent.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
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
} from "./harness.js";

const captureWindow = evidenceFor("117");

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
      expect(await dialog.getByLabel("AI agent access for shop").inputValue()).toBe("ask");
      expect(await dialog.getByLabel("AI agent access for hidden").inputValue()).toBe("off");
      const productionAccess = dialog.getByLabel("AI agent access for prod");
      expect(await productionAccess.locator('option[value="ask"]').isDisabled()).toBe(true);
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
      expect(await access.inputValue()).toBe("read");
      await access.selectOption("ask");
      await captureWindow(page, "07-datasource-agent-access");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await findAction(page, "MCP Server Settings");
      const settings = settingsDialog(page);
      await expect.poll(() => settings.getByLabel("AI agent access for prod").inputValue()).toBe("ask");
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
      await activity.getByTestId("mcp-activity-outcome").selectOption("denied");
      await expect.poll(() => calls.count()).toBe(1);
      await activity.getByTestId("mcp-activity-outcome").selectOption("");
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
});
