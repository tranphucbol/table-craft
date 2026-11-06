/**
 * Plan 156's live test: an agent opens consoles it then edits, opens a filtered table and reveals a
 * column, against the built app. An HTTP client in this process plays the agent. SQLite always,
 * PostgreSQL with its server:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/156 bun run test:smoke:db:headless:postgres test/e2e/mcpConsoles.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { POSTGRES_CONFIG, WITHOUT_POSTGRES } from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
import { AgentClient, freePort } from "./mcpAgent.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  editorTabs,
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
  sqlEditor,
  toolWindow,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("156");

const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const CLIENT = "Claude Code";
const FIRST_DRAFT = "SELECT id, name FROM customers";
const WITH_EMAIL = "SELECT id, name, email FROM customers";
const USER_FILTER = " WHERE id = 1";
const STALE_REWRITE = "SELECT count(*) FROM orders";
const EDITOR_FOCUSED = "document.activeElement?.closest('[data-testid=\"sql-editor\"]') != null";
const SWITCH_ANIMATIONS =
  "document.querySelector('[data-testid=\"mcp-allow-focus\"]')?.getAnimations({ subtree: true }).length ?? 0";
const { password: POSTGRES_PASSWORD, ...POSTGRES_PLAIN } = POSTGRES_CONFIG;

function shop(): SavedDatasource {
  return { id: "shop", name: "shop", pluginId: "sqlite", agentAccess: "ask", config: { path: seededSqliteFile() } };
}

function postgres(id: string, agentAccess: "read" | "askReads"): SavedDatasource {
  return {
    id,
    name: id,
    pluginId: "postgres",
    agentAccess,
    config: POSTGRES_PLAIN,
    secretModes: { password: "untilRestart" },
  };
}

function editorText(page: Page) {
  return page.locator('[data-testid="sql-editor"] .cm-content').last().textContent();
}

function agentTab(page: Page, name: string) {
  return editorTabs(page).filter({ hasText: name });
}

describe.runIf(SMOKE_ENABLED)("agents drive consoles live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launchServing(datasources: readonly SavedDatasource[]): Promise<{ page: Page; agent: AgentClient }> {
    const port = await freePort();
    const userDataDir = newProfile();
    seedDatasources(userDataDir, datasources);
    seedSettings(userDataDir, {
      version: 1,
      appearance: { motion: "off" },
      mcp: { enabled: true, port, rowCap: 100, clients: [{ name: CLIENT, allowed: true }] },
    });
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    const { page, app } = running;
    await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect.poll(() => page.getByTestId("status-mcp").isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
    await findAction(page, "MCP Server Settings");
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByTestId("mcp-copy-config").click();
    await expect.poll(() => dialog.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const token = TOKEN_PATTERN.exec(await app.evaluate(({ clipboard }) => clipboard.readText()))?.[1];
    if (token === undefined) throw new Error("The copied config holds no token.");
    await page.keyboard.press("Escape");
    const agent = new AgentClient(port, token);
    await agent.initialize(CLIENT);
    return { page, agent };
  }

  it(
    "givenAgent_whenOpenThenEdit_thenConsoleShowsEditAndAiMarker",
    async () => {
      const { page, agent } = await launchServing([shop()]);
      const opened = await agent.tool("open_in_console", {
        datasource: "shop",
        sql: FIRST_DRAFT,
        title: "top customers",
      });
      expect(opened.isError).toBe(false);
      const handle = opened.structured?.["console"];
      expect(handle).toBe("c1");
      const tab = agentTab(page, "top_customers");
      await tab.getByTestId("tab-agent").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await tab.getByTestId("tab-agent").getAttribute("title")).toBe(
        `Opened by ${CLIENT}; it can edit this console`,
      );
      await expect.poll(() => editorText(page)).toBe(FIRST_DRAFT);

      const edited = await agent.tool("edit_console", {
        console: handle,
        edits: [{ oldText: "SELECT id, name", newText: "SELECT id, name, email" }],
      });
      expect(edited.isError).toBe(false);
      await expect.poll(() => editorText(page)).toBe(WITH_EMAIL);
      await captureWindow(page, "02-edit");

      await sqlEditor(page).click();
      await pressChord(page, "z");
      await expect.poll(() => editorText(page)).toBe(FIRST_DRAFT);
      await captureWindow(page, "02-undo");
      const read = await agent.tool("read_console", { console: handle });
      expect(read.structured?.["sql"]).toBe(FIRST_DRAFT);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUserTyped_whenAgentReplacesWholeTextAtOldRevision_thenRefusedAndUserTextKept",
    async () => {
      const { page, agent } = await launchServing([shop()]);
      const opened = await agent.tool("open_in_console", { datasource: "shop", sql: FIRST_DRAFT });
      const handle = opened.structured?.["console"];
      const revision = opened.structured?.["revision"];
      await expect.poll(() => editorText(page)).toBe(FIRST_DRAFT);

      await sqlEditor(page).click();
      await page.keyboard.press("End");
      await page.keyboard.type(USER_FILTER);
      await page.keyboard.press("Escape");
      await expect.poll(() => editorText(page)).toBe(FIRST_DRAFT + USER_FILTER);

      const stale = await agent.tool("edit_console", { console: handle, text: STALE_REWRITE, revision });
      expect(stale.isError).toBe(true);
      expect(stale.text).toContain("The user changed the console since that revision");
      expect(await editorText(page)).toBe(FIRST_DRAFT + USER_FILTER);
      await captureWindow(page, "03-stale-refused");

      const kept = await agent.tool("edit_console", {
        console: handle,
        edits: [{ oldText: "id, name", newText: "id, name, email" }],
      });
      expect(kept.isError).toBe(false);
      await expect.poll(() => editorText(page)).toBe(WITH_EMAIL + USER_FILTER);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenAgentDisconnects_whenTabShown_thenMarkerGoneAndConsoleStays",
    async () => {
      const { page, agent } = await launchServing([shop()]);
      await agent.tool("open_in_console", { datasource: "shop", sql: FIRST_DRAFT, title: "draft" });
      const tab = agentTab(page, "draft");
      await tab.getByTestId("tab-agent").waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await agent.close();
      await expect.poll(() => tab.getByTestId("tab-agent").count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(0);
      expect(await tab.count()).toBe(1);
      expect(await editorText(page)).toBe(FIRST_DRAFT);
      await captureWindow(page, "06-released");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFocusAsked_whenAllowFocusOnThenOff_thenEditorFocusedThenWindowLeftAlone",
    async () => {
      const { page, agent } = await launchServing([shop()]);
      await openConsoleOn(page, "shop");
      await toolWindow(page, "Database").click();
      const focused = await agent.tool("open_in_console", { datasource: "shop", sql: FIRST_DRAFT, focus: true });
      expect(focused.structured?.["focused"]).toBe(true);
      await expect.poll(() => page.evaluate(EDITOR_FOCUSED)).toBe(true);
      await captureWindow(page, "07-focus");

      await findAction(page, "MCP Server Settings");
      const dialog = page.getByRole("dialog", { name: "Settings" });
      const allowFocus = dialog.getByRole("switch", { name: "Let agents bring TableCraft forward" });
      await allowFocus.click();
      await expect.poll(() => allowFocus.getAttribute("aria-checked")).toBe("false");
      await page.mouse.move(0, 0);
      await expect.poll(() => page.evaluate(SWITCH_ANIMATIONS)).toBe(0);
      await captureWindow(page, "07-focus-setting");
      await page.keyboard.press("Escape");

      await expect
        .poll(
          async () => (await agent.tool("open_in_console", { datasource: "shop", sql: WITH_EMAIL, focus: true })).text,
          { timeout: LAUNCH_TIMEOUT_MS },
        )
        .toContain("the window stayed where it was");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(!DATABASES_ENABLED || WITHOUT_POSTGRES)(
    "givenPostgres_whenAgentOpensInSchemaThenOpensTableAndReveals_thenEachShown",
    async () => {
      const { page, agent } = await launchServing([postgres("pg", "read"), postgres("pgask", "askReads")]);
      await openConsoleOn(page, "pg");
      await answerSecretPrompt(page, "pg", POSTGRES_PASSWORD);
      await openConsoleOn(page, "pgask");
      await answerSecretPrompt(page, "pgask", POSTGRES_PASSWORD);

      const opened = await agent.tool("open_in_console", {
        datasource: "pg",
        sql: "SELECT id, total FROM old_orders",
        schema: "archive",
        title: "old orders",
      });
      expect(opened.isError).toBe(false);
      expect(opened.text).toContain("The console works in archive.");
      const tab = agentTab(page, "old_orders");
      await tab.getByTestId("tab-agent").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect
        .poll(() => page.getByTestId("console-namespace-switcher").last().textContent(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toContain("archive");
      await captureWindow(page, "01-open-with-schema");

      const table = await agent.tool("open_table", {
        datasource: "pg",
        schema: "public",
        table: "customers",
        where: "id = 2",
        orderBy: "name",
      });
      expect(table.isError).toBe(false);
      const editor = page.getByTestId("table-editor");
      await expect
        .poll(() => editor.getByRole("gridcell").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual(expect.arrayContaining(["Grace Hopper"]));
      expect(await editor.getByRole("gridcell").allTextContents()).not.toContain("Ada Lovelace");
      await captureWindow(page, "04-open-table");

      const refused = await agent.tool("open_table", {
        datasource: "pg",
        schema: "public",
        table: "customers",
        where: "id = 2; DELETE FROM customers",
      });
      expect(refused.isError).toBe(true);

      const drafted = await agent.tool("open_table", {
        datasource: "pgask",
        schema: "public",
        table: "orders",
        where: "total > 10",
      });
      expect(drafted.isError).toBe(false);
      expect(drafted.structured?.["applied"]).toBe(false);
      await expect
        .poll(() => editor.getByRole("gridcell").allTextContents(), { timeout: LAUNCH_TIMEOUT_MS })
        .toContain("5.00");
      await expect
        .poll(() => editor.getByTestId("filter-where").locator(".cm-content").textContent(), {
          timeout: LAUNCH_TIMEOUT_MS,
        })
        .toBe("total > 10");
      await captureWindow(page, "04-open-table-drafted");

      const revealed = await agent.tool("reveal_in_explorer", {
        datasource: "pg",
        schema: "public",
        table: "customers",
        column: "email",
      });
      expect(revealed.structured?.["found"]).toBe(true);
      const selected = toolWindow(page, "Database").locator('[role="treeitem"][aria-selected="true"]');
      await expect.poll(() => selected.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).toContain("email");
      await captureWindow(page, "05-reveal");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
