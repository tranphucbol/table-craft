/**
 * Plan 123's live test: the brand logo on an agent's datasource line in Services, and the Services
 * header's Expand All and Collapse All with their `⌘=` and `⌘-` chords. An HTTP client in this
 * process plays the agent, as in `mcp.smoke.test.ts`. Gated, because it needs a display, a fresh
 * build and the containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql,tidb,mariadb,postgres,redis TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/123 \
 *     bun run test:smoke:db:headless test/e2e/servicesHeader.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  databaseEnabled,
  MARIADB_CONFIG,
  MYSQL_CONFIG,
  POSTGRES_CONFIG,
  REDIS_CONFIG,
  TIDB_CONFIG,
} from "../support/databases.js";
import { seededSqliteFile } from "../support/sqliteFixture.js";
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
  toolWindow,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";

const captureWindow = evidenceFor("123");

const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
const CLIENT = "Claude Code";
const COLLAPSE_ALL = "Collapse All";
const EXPAND_ALL = "Expand All";
const COLLAPSE_TOOLTIP = /Collapse All.*(⌘-|Ctrl\+-)/;
const EDITOR_CONTENT = '[data-testid="sql-editor"] .cm-content';
const SELECT_ONE = "SELECT 1";
const SERVICES_GROWTH_PX = 300;

type Config = Readonly<Record<string, string | number | boolean>>;

interface Target {
  readonly id: string;
  readonly pluginId: string;
  readonly config: Config;
  /** Typed into the connect prompt and kept until restart, so the agent's engine finds it. */
  readonly password: string;
  readonly brand?: string;
  /** The glyph its agent datasource line draws with brand icons on. */
  readonly glyph: string;
}

interface Styled {
  readonly ownerDocument: { readonly defaultView: { getComputedStyle(element: Styled): { fontSize: string } } };
}

function withoutPassword(config: Config & { readonly password: string }): Config {
  const { password: _password, ...plain } = config;
  return plain;
}

function mysqlTarget(): Target {
  return {
    id: "orders",
    pluginId: "mysql",
    config: { ...withoutPassword(MYSQL_CONFIG), sslMode: "disable" },
    password: MYSQL_CONFIG.password,
    glyph: "mysql",
  };
}

function tidbTarget(): Target {
  return {
    id: "warehouse",
    pluginId: "mysql",
    config: withoutPassword(TIDB_CONFIG),
    password: TIDB_CONFIG.password,
    brand: "tidb",
    glyph: "tidb",
  };
}

function everyTarget(): readonly Target[] {
  return [
    mysqlTarget(),
    tidbTarget(),
    ...(databaseEnabled("mariadb")
      ? [
          {
            id: "ledger",
            pluginId: "mysql",
            config: withoutPassword(MARIADB_CONFIG),
            password: MARIADB_CONFIG.password,
            brand: "mariadb",
            glyph: "mariadb",
          },
        ]
      : []),
    ...(databaseEnabled("postgres")
      ? [
          {
            id: "analytics",
            pluginId: "postgres",
            config: withoutPassword(POSTGRES_CONFIG),
            password: POSTGRES_CONFIG.password,
            glyph: "postgresql",
          },
        ]
      : []),
    ...(databaseEnabled("redis")
      ? [
          {
            id: "cache",
            pluginId: "redis",
            config: withoutPassword(REDIS_CONFIG),
            password: REDIS_CONFIG.password,
            glyph: "redis",
          },
        ]
      : []),
    { id: "local", pluginId: "sqlite", config: { path: seededSqliteFile() }, password: "", glyph: "sqlite" },
  ];
}

function saved(target: Target): SavedDatasource {
  return {
    id: target.id,
    name: target.id,
    pluginId: target.pluginId,
    agentAccess: "read",
    config: target.config,
    ...(target.brand === undefined ? {} : { brand: target.brand }),
    ...(target.password === "" ? {} : { secretModes: { password: "untilRestart" } }),
  };
}

function services(page: Page) {
  return toolWindow(page, "Services");
}

function headerButton(page: Page, name: string) {
  return services(page).getByRole("toolbar", { name: "Services toolbar" }).getByRole("button", { name, exact: true });
}

function lines(page: Page, kind: string) {
  return services(page).locator(`[role="treeitem"][data-kind="${kind}"]`);
}

function agentLine(page: Page, id: string) {
  return lines(page, "agentDatasource").filter({ has: page.getByText(id, { exact: true }) });
}

function glyphOf(page: Page, id: string): Promise<string | null> {
  return agentLine(page, id).locator("[data-glyph]").first().getAttribute("data-glyph");
}

async function foldedCount(page: Page): Promise<number> {
  return services(page).locator('[role="treeitem"][aria-expanded="false"]').count();
}

async function unfoldedCount(page: Page): Promise<number> {
  return services(page).locator('[role="treeitem"][aria-expanded="true"]').count();
}

/** Drags the boundary above Services up, so the whole Agents subtree fits in a capture. */
async function tallServices(page: Page): Promise<void> {
  const box = await services(page).boundingBox();
  if (box === null) throw new Error("Services is not laid out.");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y);
  await page.mouse.down();
  await page.mouse.move(x, box.y - SERVICES_GROWTH_PX / 2);
  await page.mouse.move(x, box.y - SERVICES_GROWTH_PX);
  await page.mouse.up();
  await expect.poll(async () => (await services(page).boundingBox())?.height ?? 0).toBeGreaterThan(box.height);
}

async function agentsOnTop(page: Page): Promise<void> {
  await lines(page, "agents").evaluate((element: { scrollIntoView(options: { block: string }): void }) =>
    element.scrollIntoView({ block: "start" }),
  );
}

async function editorSize(page: Page): Promise<string> {
  return page
    .locator(EDITOR_CONTENT)
    .first()
    .evaluate((element: Styled) => element.ownerDocument.defaultView.getComputedStyle(element).fontSize);
}

/** One read per datasource: a query on SQL, a key scan on Redis. */
async function readOnce(agent: AgentClient, target: Target): Promise<void> {
  const answer =
    target.pluginId === "redis"
      ? await agent.tool("scan_keys", { datasource: target.id, pattern: "*", database: 0 })
      : await agent.tool("run_query", { datasource: target.id, sql: SELECT_ONE });
  expect(answer.isError, answer.text).toBe(false);
}

describe.runIf(DATABASES_ENABLED)("Services brand icons and Collapse All live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  /**
   * Launches with the MCP server on, opens a console on each target so its password is kept, and
   * has one agent read each; the SQLite console opens last, so the active tab is a SQL editor.
   */
  async function launchWithAgent(targets: readonly Target[], appearance: Record<string, unknown> = {}): Promise<Page> {
    const port = await freePort();
    const userDataDir = newProfile();
    seedDatasources(userDataDir, targets.map(saved));
    seedSettings(userDataDir, {
      version: 1,
      appearance: { motion: "off", theme: "dark", ...appearance },
      mcp: { enabled: true, port, rowCap: 100, clients: [{ name: CLIENT, allowed: true }] },
    });
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    const page = running.page;
    await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect.poll(() => page.getByTestId("status-mcp").isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);

    const ordered = [
      ...targets.filter((t) => t.pluginId !== "sqlite"),
      ...targets.filter((t) => t.pluginId === "sqlite"),
    ];
    for (const target of ordered) {
      await openConsoleOn(page, target.id);
      if (target.password !== "") await answerSecretPrompt(page, target.id, target.password);
    }

    await findAction(page, "MCP Server Settings");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await settings.getByTestId("mcp-copy-config").click();
    await expect.poll(() => settings.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const copied = await running.app.evaluate(({ clipboard }) => clipboard.readText());
    const token = TOKEN_PATTERN.exec(copied)?.[1];
    if (token === undefined) throw new Error("The copied config holds no token.");
    await page.keyboard.press("Escape");
    await settings.waitFor({ state: "detached" });

    const agent = new AgentClient(port, token);
    await agent.initialize(CLIENT);
    for (const target of targets) await readOnce(agent, target);

    if ((await services(page).count()) === 0) await pressChord(page, "8");
    await services(page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await expect
      .poll(() => lines(page, "agentDatasource").count(), { timeout: LAUNCH_TIMEOUT_MS })
      .toBe(targets.length);
    await tallServices(page);
    await agentsOnTop(page);
    return page;
  }

  it(
    "givenAgentReadEveryDatasource_whenServicesShown_thenEachAgentLineDrawsItsLogoAndTheHeaderFoldsTheTree",
    async () => {
      const targets = everyTarget();
      const page = await launchWithAgent(targets);

      for (const target of targets) {
        await expect.poll(() => glyphOf(page, target.id), { timeout: LAUNCH_TIMEOUT_MS }).toBe(target.glyph);
      }
      await captureWindow(page, "01-agent-logos");

      const collapse = headerButton(page, COLLAPSE_ALL);
      const expand = headerButton(page, EXPAND_ALL);
      await expect.poll(() => expand.isDisabled()).toBe(true);
      await expect.poll(() => collapse.isEnabled()).toBe(true);
      await collapse.hover();
      await expect
        .poll(() => page.getByRole("tooltip").first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .toMatch(COLLAPSE_TOOLTIP);
      await captureWindow(page, "04-header");

      const call = lines(page, "agentCall").first();
      await call.click();
      await expect.poll(() => call.getAttribute("aria-selected")).toBe("true");
      await collapse.click();
      await expect.poll(() => unfoldedCount(page)).toBe(0);
      expect(await services(page).locator('[role="treeitem"]:not([aria-level="1"])').count()).toBe(0);
      const selected = services(page).locator('[role="treeitem"][aria-selected="true"]');
      expect(await selected.getAttribute("data-kind")).toBe("agents");
      await expect.poll(() => collapse.isDisabled()).toBe(true);
      await expect.poll(() => expand.isEnabled()).toBe(true);
      await page.mouse.move(0, 0);
      await captureWindow(page, "05-collapsed");

      await lines(page, "agents").click();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => lines(page, "agentClient").count()).toBe(1);
      expect(await lines(page, "agentClient").getAttribute("aria-expanded")).toBe("false");
      expect(await lines(page, "agentDatasource").count()).toBe(0);
      await captureWindow(page, "06-one-level");

      await expand.click();
      await expect.poll(() => foldedCount(page)).toBe(0);
      await expect.poll(() => lines(page, "agentCall").count()).toBe(targets.length);
      await expect.poll(() => expand.isDisabled()).toBe(true);
      await page.mouse.move(0, 0);
      await agentsOnTop(page);
      await captureWindow(page, "07-expanded");

      await lines(page, "agents").click();
      await pressChord(page, "Minus");
      await expect.poll(() => unfoldedCount(page)).toBe(0);
      await pressChord(page, "Equal");
      await expect.poll(() => foldedCount(page)).toBe(0);

      const before = await editorSize(page);
      await page.locator(EDITOR_CONTENT).first().click();
      await pressChord(page, "Equal");
      await expect.poll(() => editorSize(page)).not.toBe(before);
      expect(await foldedCount(page)).toBe(0);
      await agentsOnTop(page);
      await captureWindow(page, "08-keys");
    },
    SCENARIO_TIMEOUT_MS * 3,
  );

  it(
    "givenBrandIconsOff_whenAgentReadMysql_thenItsLineDrawsTheGenericGlyph",
    async () => {
      const page = await launchWithAgent([mysqlTarget()], { brandIcons: false });

      await expect.poll(() => glyphOf(page, "orders"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("generic");
      await captureWindow(page, "02-icons-off");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenGrayLogos_whenAgentReadTidb_thenItsLineDrawsTheTidbLogoInGray",
    async () => {
      const page = await launchWithAgent([tidbTarget()], { brandIconColor: "gray" });

      await expect.poll(() => glyphOf(page, "warehouse"), { timeout: LAUNCH_TIMEOUT_MS }).toBe("tidb");
      const glyph = agentLine(page, "warehouse").locator("[data-glyph]").first();
      await expect.poll(() => glyph.getAttribute("class")).toContain("text-ink-muted");
      expect(await glyph.getAttribute("style")).toBeNull();
      await captureWindow(page, "03-gray");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenLightTheme_whenAgentReadEveryDatasource_thenLogosAndHeaderButtonsShow",
    async () => {
      const targets = everyTarget();
      const page = await launchWithAgent(targets, { theme: "light" });

      for (const target of targets) {
        await expect.poll(() => glyphOf(page, target.id), { timeout: LAUNCH_TIMEOUT_MS }).toBe(target.glyph);
      }
      await expect.poll(() => headerButton(page, COLLAPSE_ALL).isEnabled()).toBe(true);
      await captureWindow(page, "09-light");
    },
    SCENARIO_TIMEOUT_MS * 3,
  );
});
