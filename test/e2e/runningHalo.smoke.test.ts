/**
 * The halo on a connection dot while a console on it runs, and on the MCP chip's dot while an
 * agent's request waits for approval.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/137 bun run test:smoke:headless test/e2e/runningHalo.smoke.test.ts
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentClient, freePort } from "./mcpAgent.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  datasourceStatus,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  mainToolbarButton,
  newProfile,
  openConsoleOn,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  startStatement,
  toolWindow,
  type RunningApp,
  waitUntilReady,
} from "./harness.js";

const captureWindow = evidenceFor("137");

/** SQLite cannot cancel, so the statement is long enough to capture yet ends on its own. */
const SLOW_QUERY =
  "WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 20000000) SELECT count(*) FROM g";
const RUNNING = "[data-running]";
const WAITING = "[data-waiting]";
const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const CLIENTS = [{ name: "Claude Code", allowed: true }];
const SHOP = "shop";
const CREATE_TABLE = "CREATE TABLE halo_probe (id INTEGER)";

describe.runIf(SMOKE_ENABLED)("Halo on a busy dot", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenConsoleRunning_whenWatched_thenExplorerStatusBarAndToolbarDotsHaloUntilItStops",
    async () => {
      running = await launchApp();
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await waitUntilReady(page);
      const explorer = toolWindow(page, "Database");
      const dots = [
        explorer.locator(RUNNING),
        datasourceStatus(page).locator(RUNNING),
        mainToolbarButton(page, "Data source").locator(RUNNING),
      ];
      for (const dot of dots) expect(await dot.count()).toBe(0);
      await captureWindow(page, "01-idle");

      await startStatement(page, SLOW_QUERY);
      for (const dot of dots) await dot.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      for (const dot of dots) expect(await dot.getAttribute("class")).toContain("halo");
      await captureWindow(page, "02-running");

      for (const dot of dots) await dot.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "03-stopped");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAgentRequestWaitingForApproval_whenWatched_thenMcpChipDotHalosUntilAnswered",
    async () => {
      const port = await freePort();
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [
        {
          id: SHOP,
          name: SHOP,
          pluginId: "sqlite",
          agentAccess: "ask",
          config: { path: join(userDataDir, "shop.db") },
        },
      ]);
      seedSettings(userDataDir, { version: 1, mcp: { enabled: true, port, rowCap: 100, clients: CLIENTS } });
      running = await launchApp(null, { userDataDir });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await openConsoleOn(page, SHOP);
      await waitUntilReady(page);
      await findAction(page, "MCP Server Settings");
      const settings = page.getByRole("dialog", { name: "Settings" });
      await settings.getByTestId("mcp-copy-config").click();
      await expect.poll(() => settings.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
      const token = TOKEN_PATTERN.exec(await app.evaluate(({ clipboard }) => clipboard.readText()))?.[1];
      if (token === undefined) throw new Error("The copied config holds no token.");
      await page.keyboard.press("Escape");
      const agent = new AgentClient(port, token);
      await agent.initialize("Claude Code");

      const chip = page.getByTestId("status-mcp");
      const dot = chip.locator(WAITING);
      expect(await dot.count()).toBe(0);

      const call = agent.tool("run_query", { datasource: SHOP, sql: CREATE_TABLE, reason: "Live test" });
      await dot.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dot.getAttribute("class")).toContain("halo");
      await captureWindow(page, "04-approval-waiting");

      await chip.click();
      const dialog = page.getByTestId("mcp-approval");
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await dialog.getByTestId("mcp-deny").click();
      expect((await call).isError).toBe(true);
      await dot.waitFor({ state: "detached", timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "05-approval-answered");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
