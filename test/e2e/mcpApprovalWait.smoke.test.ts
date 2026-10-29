/**
 * Plan 125's live test: an agent call's time leaves out the wait for the user's approval. An HTTP
 * client in this process plays the agent; the user answers each request after APPROVAL_WAIT_MS.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/125 bun run test:smoke:db:headless:redis test/e2e/mcpApprovalWait.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG, REDIS_CONFIG, WITHOUT_REDIS } from "../support/databases.js";
import { AgentClient, freePort } from "./mcpAgent.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
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
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("125");

const APPROVAL_WAIT_MS = 5_000;
const MS_PER_SECOND = 1_000;
const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const CLIENTS = [{ name: "Claude Code", allowed: true }];
/** A write the classifier asks about that leaves the shared fixture rows as they are. */
const TOUCH_CUSTOMER = "UPDATE customers SET name = name WHERE id = 1";
const SELECT_CUSTOMERS = "SELECT id, name FROM customers ORDER BY id";
const KEY_NAME = "user:{42}:session";
const TITLE_ID = "evidence-title";
const TITLE_GAP_PX = 4;
const WAITED = /^Waited (\d+\.\d) s for approval, not counted$/;
const { password: MYSQL_PASSWORD, ...MYSQL_PLAIN } = MYSQL_CONFIG;
const { password: REDIS_PASSWORD, ...REDIS_PLAIN } = REDIS_CONFIG;

function asking(pluginId: "mysql" | "redis", agentAccess: "ask" | "askReads"): SavedDatasource {
  return {
    id: pluginId,
    name: pluginId,
    pluginId,
    agentAccess,
    config: pluginId === "mysql" ? { ...MYSQL_PLAIN, sslMode: "disable" } : REDIS_PLAIN,
    secretModes: { password: "untilRestart" },
  };
}

/** `42 ms` or `1.4 s`, as `formatDuration` writes it, in milliseconds. */
function milliseconds(text: string): number {
  const [value = "", unit] = text.trim().split(" ");
  return unit === "s" ? Number(value) * MS_PER_SECOND : Number(value);
}

/** The native tooltip never reaches a screenshot, so the capture draws the title just above the element. */
async function showTitle(page: Page, target: Locator): Promise<void> {
  await target.hover();
  const title = (await target.getAttribute("title")) ?? "";
  const box = await target.boundingBox();
  if (box === null) throw new Error("The element to annotate is not on screen.");
  const style = [
    "position: fixed",
    `left: ${String(box.x + box.width)}px`,
    `top: ${String(box.y - TITLE_GAP_PX)}px`,
    "transform: translate(-100%, -100%)",
    "padding: 2px 6px",
    "border: 1px solid var(--color-line)",
    "background: var(--color-raised)",
    "color: var(--color-ink)",
    "z-index: 9999",
    "white-space: nowrap",
  ].join("; ");
  await page.evaluate(`(() => {
    const tip = document.createElement("div");
    tip.id = ${JSON.stringify(TITLE_ID)};
    tip.textContent = ${JSON.stringify(title)};
    tip.setAttribute("style", ${JSON.stringify(style)});
    document.body.append(tip);
  })()`);
}

async function hideTitle(page: Page): Promise<void> {
  await page.evaluate(`document.getElementById(${JSON.stringify(TITLE_ID)})?.remove()`);
}

describe.runIf(SMOKE_ENABLED && DATABASES_ENABLED)("Agent call time without the approval wait", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  /** Launches serving `datasource`, connects it with its password and an agent with the copied token. */
  async function served(datasource: SavedDatasource, password: string): Promise<{ page: Page; agent: AgentClient }> {
    const port = await freePort();
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [datasource]);
    seedSettings(userDataDir, {
      version: 1,
      appearance: { motion: "off" },
      mcp: { enabled: true, port, rowCap: 100, clients: CLIENTS },
    });
    running = await launchApp(null, { userDataDir });
    const { app, page } = running;
    await setWindowSize(app, EVIDENCE_WINDOW);
    await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await openConsoleOn(page, datasource.name);
    await answerSecretPrompt(page, datasource.name, password);
    await findAction(page, "MCP Server Settings");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByTestId("mcp-copy-config").click();
    await expect.poll(() => settings.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const token = TOKEN_PATTERN.exec(await app.evaluate(({ clipboard }) => clipboard.readText()))?.[1];
    if (token === undefined) throw new Error("The copied config holds no token.");
    await page.keyboard.press("Escape");
    const agent = new AgentClient(port, token);
    await agent.initialize("Claude Code");
    return { page, agent };
  }

  /** Waits for the request, lets it wait APPROVAL_WAIT_MS as a user reading it would, then answers. */
  async function answerLate(page: Page, answer: "mcp-allow" | "mcp-deny"): Promise<void> {
    const chip = page.getByTestId("status-mcp");
    await expect.poll(() => chip.getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("waiting");
    await chip.click();
    const dialog = page.getByTestId("mcp-approval");
    await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await page.waitForTimeout(APPROVAL_WAIT_MS);
    await dialog.getByTestId(answer).click();
  }

  /** The finished call's line in Services, and its duration: working time, the wait in its title. */
  async function finishedCall(page: Page, text: string): Promise<{ line: Locator; duration: Locator }> {
    const services = toolWindow(page, "Services");
    if (!(await services.isVisible())) await findAction(page, "Services");
    const line = services.locator('[role="treeitem"][data-kind="agentCall"]').filter({ hasText: text });
    await line.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    const duration = line.locator("span[title]").filter({ hasText: /^\d+(\.\d)? m?s$/ });
    expect(milliseconds((await duration.textContent()) ?? "")).toBeLessThan(APPROVAL_WAIT_MS);
    const waited = WAITED.exec((await duration.getAttribute("title")) ?? "");
    expect(Number(waited?.[1]) * MS_PER_SECOND).toBeGreaterThanOrEqual(APPROVAL_WAIT_MS);
    return { line, duration };
  }

  it(
    "givenAskBeforeWrites_whenUpdateAllowedOrDeniedAfter5s_thenServicesShowsWorkingTimeAndTheWaitInItsTooltip",
    async () => {
      const { page, agent } = await served(asking("mysql", "ask"), MYSQL_PASSWORD);

      const update = agent.tool("run_query", { datasource: "mysql", sql: TOUCH_CUSTOMER, reason: "Live test" });
      await answerLate(page, "mcp-allow");
      expect((await update).isError).toBe(false);
      const allowed = await finishedCall(page, TOUCH_CUSTOMER);
      expect(await allowed.line.getAttribute("data-state")).toBe("ok");
      await captureWindow(page, "01-write-allowed");
      await showTitle(page, allowed.duration);
      await captureWindow(page, "02-tooltip");
      await hideTitle(page);

      const denied = agent.tool("run_query", { datasource: "mysql", sql: `${TOUCH_CUSTOMER} AND id > 0` });
      await answerLate(page, "mcp-deny");
      expect((await denied).isError).toBe(true);
      const refused = await finishedCall(page, "AND id > 0");
      expect(await refused.line.getAttribute("data-state")).toBe("denied");
      await showTitle(page, refused.duration);
      await captureWindow(page, "06-denied");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAskBeforeReads_whenSelectAllowedAfter5s_thenActivityAndHistoryShowWorkingTime",
    async () => {
      const { page, agent } = await served(asking("mysql", "askReads"), MYSQL_PASSWORD);

      const read = agent.tool("run_query", { datasource: "mysql", sql: SELECT_CUSTOMERS });
      await answerLate(page, "mcp-allow");
      expect((await read).isError).toBe(false);
      const { duration } = await finishedCall(page, SELECT_CUSTOMERS);
      await showTitle(page, duration);
      await captureWindow(page, "03-read-allowed");
      await hideTitle(page);

      await findAction(page, "Show Agent Activity");
      const activity = page.getByTestId("mcp-activity");
      await activity.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const cell = activity.getByTestId("mcp-activity-duration").first();
      const shown = (await cell.textContent()) ?? "";
      expect(shown).toMatch(/^\d+(\.\d)? m?s \+\d+\.\d s approval$/);
      expect(milliseconds(shown.split(" +")[0] ?? "")).toBeLessThan(APPROVAL_WAIT_MS);
      expect(await cell.getAttribute("title")).toMatch(WAITED);
      await captureWindow(page, "04-activity");
      await page.keyboard.press("Escape");

      await pressChord(page, "Alt+E");
      const history = page.getByRole("dialog", { name: "Query History: mysql" });
      await history.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await history.getByTestId("history-origin-agents").click();
      const entry = history.getByRole("option").filter({ hasText: SELECT_CUSTOMERS });
      await entry.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const took = (await entry.locator("span.tabular-nums").allTextContents()).at(-2) ?? "";
      expect(milliseconds(took)).toBeLessThan(APPROVAL_WAIT_MS);
      await captureWindow(page, "05-history");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_REDIS)(
    "givenGetKeyOnAskBeforeReads_whenAllowedAfter5s_thenTheWaitIsLeftOut",
    async () => {
      const { page, agent } = await served(asking("redis", "askReads"), REDIS_PASSWORD);

      const value = agent.tool("get_key", { datasource: "redis", key: KEY_NAME, database: 0 });
      await answerLate(page, "mcp-allow");
      expect((await value).isError).toBe(false);
      const { duration } = await finishedCall(page, KEY_NAME);
      await showTitle(page, duration);
      await captureWindow(page, "07-get-key");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
