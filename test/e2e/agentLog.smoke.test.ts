/**
 * Plan 146's live test: an agent's run in the Log tool window. An HTTP client in this process plays
 * the agent against the compose MySQL; the Log, filtered by Show Agent Log, shows it connect, call,
 * wait for approvals and leave, keeps those rows across a restart, and Export Diagnostics carries
 * them.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/146 bun run test:smoke:db:headless test/e2e/agentLog.smoke.test.ts
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG } from "../support/databases.js";
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
  readProfileFile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { stubSaveDialog } from "./workflows.js";

const captureWindow = evidenceFor("146");

const LOG_FILE = join("logs", "table-craft.log");
const CLIENT_NAME = "Claude Code";
const CLIENTS = [{ name: CLIENT_NAME, allowed: true }];
const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const SELECT_CUSTOMERS = "SELECT id, name FROM customers ORDER BY id";
/** A write the classifier asks about that leaves the shared fixture rows as they are. */
const TOUCH_CUSTOMER = "UPDATE customers SET name = name WHERE id = 1";
const DENIED_UPDATE = `${TOUCH_CUSTOMER} AND id > 0`;
/** Past the 16 KB record cap of `main/log/hub.ts`, so the hub cuts the statement and keeps the rest. */
const LONG_COMMENT_CHARS = 20_000;
const LONG_MARKER = "agent_log_long_probe";
const LONG_SELECT = `SELECT 1 AS ${LONG_MARKER} /* ${"x".repeat(LONG_COMMENT_CHARS)} */`;
/** `CAPPED_TEXT_CHARS` in `main/log/hub.ts`; the e2e suite reads the profile, not the source. */
const CUT_TARGET_CHARS = 2048;
/** One run spans two launches, four approvals' worth of waiting and an export. */
const RUN_TIMEOUT_MS = SCENARIO_TIMEOUT_MS * 3;
const { password: MYSQL_PASSWORD, ...MYSQL_PLAIN } = MYSQL_CONFIG;

const MYSQL: SavedDatasource = {
  id: "mysql",
  name: "mysql",
  pluginId: "mysql",
  agentAccess: "ask",
  config: { ...MYSQL_PLAIN, sslMode: "disable" },
  secretModes: { password: "untilRestart" },
};

interface LoggedLine {
  readonly level: string;
  readonly process: string;
  readonly scope: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

function agentLines(userDataDir: string): readonly LoggedLine[] {
  return (readProfileFile(userDataDir, LOG_FILE) ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as LoggedLine)
    .filter((line) => line.scope === "agent");
}

async function agentLine(userDataDir: string, match: (line: LoggedLine) => boolean): Promise<LoggedLine> {
  let found: LoggedLine | undefined;
  await expect
    .poll(
      () => {
        found = agentLines(userDataDir).find(match);
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

async function showAgentLog(page: Page): Promise<void> {
  await findAction(page, "Show Agent Log");
  await toolWindow(page, "Log").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Selects the newest Log row holding `text` and returns the record the pane shows for it. */
async function selectRow(page: Page, text: string): Promise<Record<string, unknown>> {
  const row = logRows(page).filter({ hasText: text }).first();
  await row.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await row.click();
  const record = toolWindow(page, "Log").getByLabel("Log record", { exact: true });
  await record.waitFor();
  return JSON.parse((await record.textContent()) ?? "{}") as Record<string, unknown>;
}

async function answer(page: Page, choice: "mcp-allow" | "mcp-deny"): Promise<void> {
  const chip = page.getByTestId("status-mcp");
  await expect.poll(() => chip.getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("waiting");
  await chip.click();
  const dialog = page.getByTestId("mcp-approval");
  await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  await dialog.getByTestId(choice).click();
  await expect.poll(() => dialog.count()).toBe(0);
}

describe.runIf(SMOKE_ENABLED && DATABASES_ENABLED)("Agent runs in the Log (MySQL)", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(userDataDir: string): Promise<RunningApp> {
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    await toolWindow(running.page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    return running;
  }

  /** Launches serving MySQL, connects it with its password and an agent with the copied token. */
  async function served(): Promise<{ current: RunningApp; agent: AgentClient }> {
    const port = await freePort();
    const userDataDir = newProfile();
    seedDatasources(userDataDir, [MYSQL]);
    seedSettings(userDataDir, {
      version: 1,
      appearance: { motion: "off" },
      mcp: { enabled: true, port, rowCap: 100, clients: CLIENTS },
    });
    const current = await launch(userDataDir);
    const { app, page } = current;
    await openConsoleOn(page, MYSQL.name);
    await answerSecretPrompt(page, MYSQL.name, MYSQL_PASSWORD);
    await findAction(page, "MCP Server Settings");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByTestId("mcp-copy-config").click();
    await expect.poll(() => settings.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const token = TOKEN_PATTERN.exec(await app.evaluate(({ clipboard }) => clipboard.readText()))?.[1];
    if (token === undefined) throw new Error("The copied config holds no token.");
    await page.keyboard.press("Escape");
    const agent = new AgentClient(port, token);
    await agent.initialize(CLIENT_NAME);
    return { current, agent };
  }

  it(
    "givenAgentOnAskBeforeWrites_whenItConnectsCallsWaitsAndIsDisconnected_thenTheLogShowsEachStepAndKeepsThem",
    async () => {
      const { current, agent } = await served();
      const { page, userDataDir } = current;

      const connected = await agentLine(userDataDir, (line) => line.msg === "agent connected");
      expect(connected).toMatchObject({ process: "mcp", level: "info", clientName: CLIENT_NAME });
      await showAgentLog(page);
      expect((await selectRow(page, "agent connected"))["clientName"]).toBe(CLIENT_NAME);
      await captureWindow(page, "01-agent-connected");

      expect((await agent.tool("list_tables", { datasource: "mysql", schema: MYSQL_CONFIG.database })).isError).toBe(
        false,
      );
      expect((await agent.tool("run_query", { datasource: "mysql", sql: SELECT_CUSTOMERS })).isError).toBe(false);
      await agentLine(userDataDir, (line) => line.tool === "list_tables");
      const select = await agentLine(userDataDir, (line) => line.target === SELECT_CUSTOMERS);
      expect(select).toMatchObject({ msg: "agent call", outcome: "ok", datasourceId: "mysql" });
      expect((await selectRow(page, SELECT_CUSTOMERS))["target"]).toBe(SELECT_CUSTOMERS);
      await captureWindow(page, "02-agent-calls");

      const update = agent.tool("run_query", { datasource: "mysql", sql: TOUCH_CUSTOMER, reason: "Live test" });
      await answer(page, "mcp-allow");
      expect((await update).isError).toBe(false);
      const asked = await agentLine(userDataDir, (line) => line.msg === "approval asked");
      expect(asked).toMatchObject({ target: TOUCH_CUSTOMER, reason: "Live test", clientName: CLIENT_NAME });
      const allowed = await agentLine(userDataDir, (line) => line.msg === "approval answered");
      expect(allowed).toMatchObject({ approvalId: asked["approvalId"], outcome: "allowed" });
      expect((await selectRow(page, "approval answered"))["outcome"]).toBe("allowed");
      await captureWindow(page, "03-approval-pair");

      const denied = agent.tool("run_query", { datasource: "mysql", sql: DENIED_UPDATE });
      await answer(page, "mcp-deny");
      expect((await denied).isError).toBe(true);
      await agentLine(userDataDir, (line) => line.msg === "approval answered" && line.outcome === "denied");
      const deniedCall = await agentLine(
        userDataDir,
        (line) => line.msg === "agent call" && line.target === DENIED_UPDATE,
      );
      expect(deniedCall).toMatchObject({ msg: "agent call", outcome: "denied" });
      expect((await selectRow(page, "outcome=denied"))["outcome"]).toBe("denied");
      await captureWindow(page, "04-approval-denied");

      expect((await agent.tool("run_query", { datasource: "mysql", sql: LONG_SELECT })).isError).toBe(false);
      const long = await agentLine(
        userDataDir,
        (line) => typeof line.target === "string" && line.target.includes(LONG_MARKER),
      );
      expect(long).toMatchObject({ msg: "agent call", tool: "run_query", clientName: CLIENT_NAME, truncated: true });
      expect(long.outcome).toMatch(/^(ok|capped)$/);
      expect((long.target as string).length).toBeLessThanOrEqual(CUT_TARGET_CHARS);
      expect((await selectRow(page, LONG_MARKER))["truncated"]).toBe(true);
      await captureWindow(page, "05-long-statement");

      await page.getByTestId("status-mcp").click();
      const popover = page.getByTestId("mcp-popover");
      await popover.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await popover.getByTestId("mcp-client").getByRole("button", { name: "Disconnect" }).click();
      const left = await agentLine(userDataDir, (line) => line.msg === "agent disconnected");
      expect(left).toMatchObject({ by: "user", clientName: CLIENT_NAME });
      await page.keyboard.press("Escape");
      expect((await selectRow(page, "agent disconnected"))["by"]).toBe("user");
      await captureWindow(page, "06-disconnected");

      const before = agentLines(userDataDir).length;
      await closeApp(current.app);
      running = null;
      const again = await launch(userDataDir);
      await showAgentLog(again.page);
      await expect
        .poll(
          () =>
            logRows(again.page)
              .filter({ hasText: /agent (connected|call|disconnected)|approval/ })
              .count(),
          {
            timeout: LAUNCH_TIMEOUT_MS,
          },
        )
        .toBeGreaterThanOrEqual(before);
      expect(await logRows(again.page).filter({ hasText: "TableCraft started" }).count()).toBe(0);
      await captureWindow(again.page, "07-after-restart");

      const zip = join(userDataDir, "diagnostics.zip");
      await stubSaveDialog(again.app, zip);
      await findAction(again.page, "Export Diagnostics");
      const confirm = again.page.getByRole("dialog", { name: "Export Diagnostics" });
      await confirm.waitFor();
      expect(await confirm.textContent()).toContain("The log does hold the statements agents sent");
      await captureWindow(again.page, "08-diagnostics");
      await confirm.getByRole("button", { name: "Export…", exact: true }).click();
      const done = again.page.getByRole("dialog", { name: "Diagnostics exported" });
      await done.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await done.getByRole("button", { name: "OK", exact: true }).click();
      const text = execFileSync("unzip", ["-p", zip], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      expect(text).toContain('"msg":"agent call"');
      expect(text).toContain(SELECT_CUSTOMERS);
    },
    RUN_TIMEOUT_MS,
  );
});
