/**
 * Live test of fetch_rows on a result whose row limit is in its SQL (decision 162): rows the engine
 * holds come back at once, and rows past them wait for the user, because the statement runs again.
 * An HTTP client in this process plays the agent against the built app on a seeded SQLite file:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/159 bun run test:smoke:headless test/e2e/mcpRerun.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { AgentClient, freePort } from "./mcpAgent.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
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
  showServices,
  SMOKE_ENABLED,
  toolWindow,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("159");

const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const MORE_ROWS = /fetch_rows with handle "(\w+)"/;
const ROW_CAP = 100;
const COUNT_TO_1200 = "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1200) SELECT i FROM n";
const RERUN_REASON = "Reading the rows past the first page";
const KNOWN_CLIENTS = [{ name: "Claude Code", allowed: true }] as const;

function chip(page: Page) {
  return page.getByTestId("status-mcp");
}

describe.runIf(SMOKE_ENABLED)("fetch_rows re-run approval live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function agentOn(page: Page, port: number): Promise<AgentClient> {
    await findAction(page, "MCP Server Settings");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await settings.getByTestId("mcp-copy-config").click();
    await expect.poll(() => settings.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const clipboard = await running!.app.evaluate(({ clipboard: board }) => board.readText());
    const token = TOKEN_PATTERN.exec(clipboard)?.[1];
    if (token === undefined) throw new Error("The copied config holds no token.");
    await page.keyboard.press("Escape");
    const agent = new AgentClient(port, token);
    await agent.initialize("Claude Code");
    return agent;
  }

  it(
    "givenRowLimitInSql_whenAgentPagesPastHeldRows_thenItWaitsForApprovalAndTheRunIsRecorded",
    async () => {
      const port = await freePort();
      const userDataDir = newProfile();
      seedDatasources(userDataDir, [
        {
          id: "reports",
          name: "reports",
          pluginId: "sqlite",
          agentAccess: "read",
          config: { path: seededSqliteFile() },
        },
      ]);
      seedSettings(userDataDir, {
        version: 1,
        appearance: { motion: "off" },
        mcp: { enabled: true, port, rowCap: ROW_CAP, clients: KNOWN_CLIENTS },
      });
      running = await launchApp(null, { userDataDir });
      const { page } = running;
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect.poll(() => chip(page).isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
      const agent = await agentOn(page, port);

      const opened = await agent.tool("run_query", { datasource: "reports", sql: COUNT_TO_1200 });
      expect(opened.isError).toBe(false);
      expect(opened.text).toContain("Rows 1–100 of at least 500.");
      const handle = MORE_ROWS.exec(opened.text)?.[1];
      if (handle === undefined) throw new Error(`run_query kept no result open: ${opened.text.slice(0, 200)}`);

      const held = await agent.tool("fetch_rows", { handle, offset: 400 });
      expect(held.isError).toBe(false);
      expect(held.text).toContain("Rows 401–500 of at least 500.");
      expect(await chip(page).getAttribute("data-tone")).not.toBe("waiting");

      const far = agent.tool("fetch_rows", { handle, offset: 1000, reason: RERUN_REASON });
      await expect.poll(() => chip(page).getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("waiting");
      await chip(page).click();
      const dialog = page.getByTestId("mcp-approval");
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.getByRole("heading").first().textContent()).toContain(
        "Claude Code wants to run a query again",
      );
      expect(await dialog.getByTestId("mcp-approval-scope").textContent()).toMatch(
        /^Data read · 1 statement, run again up to row 1\D?100$/,
      );
      expect(await dialog.getByTestId("mcp-approval-sql").textContent()).toContain(COUNT_TO_1200);
      expect(await dialog.textContent()).toContain(RERUN_REASON);
      expect(await dialog.textContent()).toContain("Allow re-runs on reports for the rest of this agent session");
      await captureWindow(page, "01-rerun-approval");

      await dialog.getByTestId("mcp-allow").click();
      const answer = await far;
      expect(answer.isError).toBe(false);
      expect(answer.text).toContain("Rows 1001–1100 of at least 1100.");

      const services = await showServices(page);
      const calls = services.locator('[role="treeitem"][data-kind="agentCall"]');
      await expect.poll(() => calls.count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(3);
      expect(await calls.first().textContent()).toContain("fetch_rows");
      await captureWindow(page, "02-services-rerun");

      await openConsoleOn(page, "reports");
      await waitUntilReady(page);
      await pressChord(page, "Alt+E");
      const history = page.getByRole("dialog", { name: "Query History: reports" });
      await history.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await history.getByTestId("history-origin-agents").click();
      // History lists a statement once with its number of runs: run_query's and the re-run.
      await expect.poll(() => history.getByTestId("history-agent").count()).toBe(1);
      expect(await history.textContent()).toContain("×2");
      await captureWindow(page, "03-history-rerun");
      await page.keyboard.press("Escape");
      await agent.close();
    },
    SCENARIO_TIMEOUT_MS,
  );
});
