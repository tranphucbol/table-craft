/**
 * Plan 134's live test: a system notification and the dock badge while an agent waits for an answer
 * and no TableCraft window is focused. The headless box has no notification daemon, so the suite
 * swaps Electron's `Notification`, `setBadgeCount` and the focused window for a recorder in the main
 * process, and draws each recorded notification over the window for the capture. An HTTP client in
 * this process plays the agent.
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/134 bun run test:smoke:db:headless test/e2e/mcpNotifications.smoke.test.ts
 */
import type { ElectronApplication, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_CONFIG } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { AgentClient, freePort, type ToolText } from "./mcpAgent.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  findAction,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  SMOKE_ENABLED,
  toolWindow,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("134");
const writeEvidence = evidenceTextFor("134");

const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const KNOWN_CLIENTS = [
  { name: "Claude Code", allowed: true },
  { name: "OpenCode", allowed: true },
] as const;
const RENAME_CUSTOMER = "UPDATE customers SET name = 'Ada King' WHERE id = 1";
const RENAME_REASON = "The customer asked to be renamed";
const SELECT_CUSTOMERS = "SELECT id, name FROM customers ORDER BY id";
const DENY_FOCUSED = "document.activeElement?.getAttribute('data-testid') === 'mcp-deny'";
const NOTICE_ID = "evidence-notice";
const NOTICE_MARGIN_PX = 12;
const NOTICE_WIDTH_PX = 340;
const { password: MYSQL_PASSWORD, ...MYSQL_PLAIN } = MYSQL_CONFIG;

interface Notice {
  readonly title: string;
  readonly body: string;
}

interface NoticeLog {
  readonly shown: readonly Notice[];
  readonly closed: readonly string[];
  readonly badge: readonly number[];
}

function shop(): SavedDatasource {
  return { id: "shop", name: "shop", pluginId: "sqlite", agentAccess: "ask", config: { path: seededSqliteFile() } };
}

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

/**
 * Replaces the native notification, the badge and the focused window with a recorder on
 * `globalThis.mcpNoticeRecorder`. The window starts in the background; `setFocused` brings it back.
 */
async function recordNotices(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow, Notification }) => {
    const recorder = { shown: [] as Notice[], closed: [] as string[], badge: [] as number[], focused: false };
    Object.assign(globalThis, { mcpNoticeRecorder: recorder });
    Notification.isSupported = () => true;
    Notification.prototype.show = function show(this: Notice) {
      recorder.shown.push(this);
    };
    Notification.prototype.close = function close(this: Notice) {
      recorder.closed.push(this.title);
    };
    BrowserWindow.getFocusedWindow = () => (recorder.focused ? (BrowserWindow.getAllWindows()[0] ?? null) : null);
    electronApp.setBadgeCount = (count?: number) => {
      recorder.badge.push(count ?? 0);
      return true;
    };
  });
}

async function noticeLog(app: ElectronApplication): Promise<NoticeLog> {
  return app.evaluate(() => {
    const recorder = (globalThis as unknown as { mcpNoticeRecorder: NoticeLog }).mcpNoticeRecorder;
    return {
      shown: recorder.shown.map(({ title, body }) => ({ title, body })),
      closed: [...recorder.closed],
      badge: [...recorder.badge],
    };
  });
}

/** Clicks the newest notification, as the user would in the notification centre. */
async function clickLastNotice(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const recorder = (globalThis as unknown as { mcpNoticeRecorder: { shown: { emit(event: string): void }[] } })
      .mcpNoticeRecorder;
    recorder.shown.at(-1)?.emit("click");
  });
}

/** The user switches back to TableCraft. */
async function focusWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    (globalThis as unknown as { mcpNoticeRecorder: { focused: boolean } }).mcpNoticeRecorder.focused = true;
    electronApp.emit("browser-window-focus");
  });
}

async function setFocused(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    (globalThis as unknown as { mcpNoticeRecorder: { focused: boolean } }).mcpNoticeRecorder.focused = true;
  });
}

/** A notification is drawn by the system, outside the window, so the capture draws it over the window's corner. */
async function showNotice(page: Page, notice: Notice): Promise<void> {
  const style = [
    "position: fixed",
    `top: ${String(NOTICE_MARGIN_PX)}px`,
    `right: ${String(NOTICE_MARGIN_PX)}px`,
    `width: ${String(NOTICE_WIDTH_PX)}px`,
    "padding: 10px 12px",
    "border: 1px solid var(--color-line)",
    "border-radius: 10px",
    "background: var(--color-raised)",
    "color: var(--color-ink)",
    "box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35)",
    "z-index: 9999",
  ].join("; ");
  await page.evaluate(`(() => {
    const box = document.createElement("div");
    box.id = ${JSON.stringify(NOTICE_ID)};
    box.setAttribute("style", ${JSON.stringify(style)});
    const app = document.createElement("div");
    app.textContent = "TableCraft · recorded system notification";
    app.setAttribute("style", "font-size: 11px; opacity: 0.7; margin-bottom: 4px");
    const title = document.createElement("div");
    title.textContent = ${JSON.stringify(notice.title)};
    title.setAttribute("style", "font-weight: 600");
    const body = document.createElement("div");
    body.textContent = ${JSON.stringify(notice.body)};
    box.append(app, title, body);
    document.body.append(box);
  })()`);
}

async function hideNotice(page: Page): Promise<void> {
  await page.evaluate(`document.getElementById(${JSON.stringify(NOTICE_ID)})?.remove()`);
}

async function captureNotice(page: Page, notice: Notice, name: string): Promise<void> {
  await showNotice(page, notice);
  await captureWindow(page, name);
  await hideNotice(page);
}

/** Lets a call the test leaves unanswered end with the app instead of as an unhandled rejection. */
function settled(call: Promise<ToolText>): Promise<ToolText | null> {
  return call.catch(() => null);
}

describe.runIf(SMOKE_ENABLED)("Notifications for waiting agent requests", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launchServing(
    datasources: readonly SavedDatasource[],
    clients: readonly { name: string; allowed: boolean }[] = KNOWN_CLIENTS,
  ): Promise<{ app: ElectronApplication; page: Page; port: number }> {
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
    return { app: running.app, page: running.page, port };
  }

  /** Copies the config from Settings › MCP Server, leaving the dialog open, and reads the token. */
  async function copiedToken(app: ElectronApplication, page: Page): Promise<string> {
    await findAction(page, "MCP Server Settings");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await dialog.getByTestId("mcp-copy-config").click();
    await expect.poll(() => dialog.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const match = TOKEN_PATTERN.exec(await app.evaluate(({ clipboard }) => clipboard.readText()));
    if (match?.[1] === undefined) throw new Error("The copied config holds no token.");
    return match[1];
  }

  async function agentAs(page: Page, port: number, token: string, client: string): Promise<AgentClient> {
    await page.keyboard.press("Escape");
    const agent = new AgentClient(port, token);
    await agent.initialize(client);
    return agent;
  }

  async function untilShown(app: ElectronApplication, count: number): Promise<NoticeLog> {
    await expect.poll(async () => (await noticeLog(app)).shown.length, { timeout: LAUNCH_TIMEOUT_MS }).toBe(count);
    return noticeLog(app);
  }

  async function untilWaiting(page: Page): Promise<void> {
    await expect
      .poll(() => page.getByTestId("status-mcp").getAttribute("data-tone"), { timeout: LAUNCH_TIMEOUT_MS })
      .toBe("waiting");
  }

  it(
    "givenWindowInBackground_whenAgentAsksToWrite_thenNoticeWithoutStatementAndClickOpensApproval",
    async () => {
      const { app, page, port } = await launchServing([shop()]);
      const agent = await agentAs(page, port, await copiedToken(app, page), "Claude Code");
      await recordNotices(app);

      const write = agent.tool("run_query", { datasource: "shop", sql: RENAME_CUSTOMER, reason: RENAME_REASON });
      const [notice] = (await untilShown(app, 1)).shown;
      expect(notice?.title).toBe("Claude Code wants to change data");
      expect(notice?.body).toMatch(/^On shop\. Answer in TableCraft within \d+ s\.$/);
      expect(notice?.body).not.toContain("UPDATE");
      expect(notice?.body).not.toContain(RENAME_REASON);
      expect((await noticeLog(app)).badge.at(-1)).toBe(1);
      expect(await page.getByTestId("mcp-approval").count()).toBe(0);
      await captureNotice(page, notice!, "01-banner-write");

      await clickLastNotice(app);
      const dialog = page.getByTestId("mcp-approval");
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await dialog.getByTestId("mcp-approval-sql").textContent()).toContain(RENAME_CUSTOMER);
      await expect.poll(() => page.evaluate(DENY_FOCUSED)).toBe(true);
      await captureWindow(page, "02-click-opens-approval");

      await dialog.getByTestId("mcp-allow").click();
      expect((await write).isError).toBe(false);
      await expect.poll(async () => (await noticeLog(app)).badge.at(-1)).toBe(0);
      const log = await noticeLog(app);
      expect(log.closed).toContain(notice?.title);
      expect(log.shown).toHaveLength(1);
      writeEvidence("04-badge.json", `${JSON.stringify(log, null, 2)}\n`);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTwoAgentsInBackground_whenBothAsk_thenOneNoticeCountsBothAndFocusClosesIt",
    async () => {
      const { app, page, port } = await launchServing([shop()]);
      const token = await copiedToken(app, page);
      const claude = await agentAs(page, port, token, "Claude Code");
      const opencode = new AgentClient(port, token);
      await opencode.initialize("OpenCode");
      await recordNotices(app);

      const first = settled(claude.tool("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }));
      await untilShown(app, 1);
      const second = settled(opencode.tool("run_query", { datasource: "shop", sql: RENAME_CUSTOMER }));
      const log = await untilShown(app, 2);
      const [replaced, counted] = log.shown;
      expect(counted?.title).toBe("2 agent requests are waiting");
      expect(counted?.body).toMatch(/^From Claude Code and OpenCode\. Answer in TableCraft within \d+ s\.$/);
      expect(log.closed).toContain(replaced?.title);
      expect(log.badge.at(-1)).toBe(2);
      await captureNotice(page, counted!, "03-banner-count");

      await focusWindow(app);
      await expect.poll(async () => (await noticeLog(app)).closed).toContain(counted?.title);
      expect((await noticeLog(app)).badge.at(-1)).toBe(2);
      writeEvidence("03-count.json", `${JSON.stringify(await noticeLog(app), null, 2)}\n`);
      await closeApp(app);
      running = null;
      await Promise.all([first, second]);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUnknownClientInBackground_whenItCalls_thenNoticeAsksToConnectAndClickOpensThePopover",
    async () => {
      const { app, page, port } = await launchServing([shop()], []);
      const agent = await agentAs(page, port, await copiedToken(app, page), "Cursor");
      await recordNotices(app);

      const listed = agent.tool("list_datasources", {});
      const [notice] = (await untilShown(app, 1)).shown;
      expect(notice?.title).toBe("Cursor wants to connect");
      expect(notice?.body).toMatch(/^Allow or block it in TableCraft within \d+ s\.$/);
      await captureNotice(page, notice!, "05-banner-client");

      await clickLastNotice(app);
      const pending = page.getByTestId("mcp-popover").getByTestId("mcp-pending-client");
      await pending.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "05b-click-opens-popover");
      await pending.getByTestId("mcp-allow-client").click();
      expect((await listed).isError).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenWindowFocused_whenAgentAsks_thenNoNoticeOnlyTheChipAndTheBadge",
    async () => {
      const { app, page, port } = await launchServing([shop()]);
      const agent = await agentAs(page, port, await copiedToken(app, page), "Claude Code");
      await recordNotices(app);
      await setFocused(app);

      const write = agent.tool("run_query", { datasource: "shop", sql: RENAME_CUSTOMER });
      await untilWaiting(page);
      await expect.poll(async () => (await noticeLog(app)).badge.at(-1)).toBe(1);
      expect((await noticeLog(app)).shown).toHaveLength(0);
      await captureWindow(page, "06-focused-no-banner");

      await page.getByTestId("status-mcp").click();
      await page.getByTestId("mcp-approval").getByTestId("mcp-deny").click();
      expect((await write).isError).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenNotificationsSwitchedOff_whenAgentAsksInBackground_thenNoNoticeAndNoBadge",
    async () => {
      const { app, page, port } = await launchServing([shop()]);
      const token = await copiedToken(app, page);
      const settings = page.getByRole("dialog", { name: "Settings" });
      const toggle = settings.getByTestId("mcp-notifications");
      expect(await toggle.getAttribute("aria-checked")).toBe("true");
      await toggle.click();
      await expect.poll(() => toggle.getAttribute("aria-checked")).toBe("false");
      await toggle.scrollIntoViewIfNeeded();
      await captureWindow(page, "07-switch-off");
      const agent = await agentAs(page, port, token, "Claude Code");
      await recordNotices(app);

      const write = agent.tool("run_query", { datasource: "shop", sql: RENAME_CUSTOMER });
      await untilWaiting(page);
      await expect.poll(async () => (await noticeLog(app)).badge.length).toBeGreaterThan(0);
      const log = await noticeLog(app);
      expect(log.shown).toHaveLength(0);
      expect(log.badge.every((count) => count === 0)).toBe(true);

      await page.getByTestId("status-mcp").click();
      await page.getByTestId("mcp-approval").getByTestId("mcp-deny").click();
      expect((await write).isError).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(DATABASES_ENABLED)(
    "givenAskBeforeReadsOnMysqlInBackground_whenAgentSelects_thenNoticeSaysReadData",
    async () => {
      const { app, page, port } = await launchServing([askingMysql()]);
      await openConsoleOn(page, "mysql");
      await answerSecretPrompt(page, "mysql", MYSQL_PASSWORD);
      const agent = await agentAs(page, port, await copiedToken(app, page), "Claude Code");
      await recordNotices(app);

      const read = agent.tool("run_query", { datasource: "mysql", sql: SELECT_CUSTOMERS });
      const [notice] = (await untilShown(app, 1)).shown;
      expect(notice?.title).toBe("Claude Code wants to read data");
      expect(notice?.body).toMatch(/^On mysql\. Answer in TableCraft within \d+ s\.$/);
      expect(notice?.body).not.toContain("SELECT");
      await captureNotice(page, notice!, "08-banner-read");

      await clickLastNotice(app);
      const dialog = page.getByTestId("mcp-approval");
      await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await dialog.getByTestId("mcp-allow").click();
      expect((await read).isError).toBe(false);
    },
    SCENARIO_TIMEOUT_MS,
  );
});
