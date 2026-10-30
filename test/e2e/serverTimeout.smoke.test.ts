/**
 * Plan 119's live test: the database stops a statement at the limit by itself. An agent's query is
 * cut by the server on MySQL, MariaDB, TiDB and PostgreSQL; a console opts in from the Data Sources
 * dialog; the agent limit comes from `mcp.statementTimeoutSeconds` or the datasource's own; a
 * datasource without the opt-in keeps only the engine's timer. Gated, because it needs a display,
 * a fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_DATABASES=mysql,tidb,mariadb,postgres TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/119 \
 *     bun run test:smoke:db:headless test/e2e/serverTimeout.smoke.test.ts
 */
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  databaseEnabled,
  MARIADB_CONFIG,
  MYSQL_CONFIG,
  POSTGRES_CONFIG,
  tidbConfigFromEnv,
  type DatabaseId,
} from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  fillNewDatasource,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  runStatement,
  seedSettings,
  setWindowSize,
  sqlEditor,
  testConnection,
  toolWindow,
  waitUntilReady,
  type RunningApp,
  chooseOption,
} from "./harness.js";
import { AgentClient, freePort } from "./mcpAgent.js";

const captureWindow = evidenceFor("119");
const writeEvidence = evidenceTextFor("119");

const CONSOLE_SECONDS = 2;
const AGENT_SECONDS = 3;
const AGENT_OVERRIDE_SECONDS = 2;
/** Past every limit above, so the open result's statement has outlived it when read again. */
const PAUSE_MS = 4_000;
/** Well past what the driver and the sockets buffer, so the next read reaches the server. */
const FAR_OFFSET = 90_000;
const SCENARIO_MS = 180_000;
const MORE_ROWS = /fetch_rows with handle "(\w+)"/;
const DIGITS = `(${Array.from({ length: 10 }, (_, digit) => `SELECT ${String(digit)} AS n`).join(" UNION ALL ")})`;
/** A million wide rows the server makes only as they are read. */
const MYSQL_BIG_READ =
  "SELECT a.n + 10 * b.n + 100 * c.n + 1000 * d.n + 10000 * e.n + 100000 * f.n AS id, REPEAT('x', 500) AS pad " +
  `FROM ${["a", "b", "c", "d", "e", "f"].map((alias) => `${DIGITS} ${alias}`).join(", ")}`;
const KNOWN_CLIENTS = [{ name: "Claude Code", allowed: true }] as const;

interface Dialect {
  readonly id: DatabaseId;
  readonly kind: string;
  readonly pluginId: string;
  readonly server: string;
  readonly setting: string;
  readonly config: () => {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
  };
  /** One row, one column: `limit=<what the server holds>`. */
  readonly readLimit: string;
  readonly limitText: (seconds: number) => string;
  readonly bigRead: string;
  readonly sleep: string;
  readonly testResult: string;
  readonly hint: string;
}

const MYSQL_LIMIT = "SELECT CONCAT('limit=', @@SESSION.max_execution_time) AS server_limit";
const millis = (seconds: number): string => `limit=${String(seconds * 1000)}`;
const STATEMENT_HINT = "The database stops every statement at the limit, counting while rows wait to be read.";

const DIALECTS: readonly Dialect[] = [
  {
    id: "mysql",
    kind: "MySQL",
    pluginId: "mysql",
    server: "MySQL",
    setting: "max_execution_time",
    config: () => MYSQL_CONFIG,
    readLimit: MYSQL_LIMIT,
    limitText: millis,
    bigRead: MYSQL_BIG_READ,
    sleep: "SELECT SLEEP(60)",
    testResult: "limit: max_execution_time, SELECT only",
    hint: "The database stops SELECTs at the limit, counting while rows wait to be read.",
  },
  {
    id: "mariadb",
    kind: "MySQL",
    pluginId: "mysql",
    server: "MariaDB",
    setting: "max_statement_time",
    config: () => MARIADB_CONFIG,
    readLimit: "SELECT CONCAT('limit=', ROUND(@@SESSION.max_statement_time * 1000)) AS server_limit",
    limitText: millis,
    bigRead: MYSQL_BIG_READ,
    sleep: "SELECT SLEEP(60)",
    testResult: "limit: max_statement_time",
    hint: STATEMENT_HINT,
  },
  {
    id: "tidb",
    kind: "MySQL",
    pluginId: "mysql",
    server: "TiDB",
    setting: "max_execution_time",
    config: tidbConfigFromEnv,
    readLimit: MYSQL_LIMIT,
    limitText: millis,
    bigRead: MYSQL_BIG_READ,
    // Bounded: TiDB 4 has no Global Kill, so the engine's cancel drops the session instead.
    sleep: "SELECT SLEEP(10)",
    testResult: "limit: max_execution_time",
    hint: STATEMENT_HINT,
  },
  {
    id: "postgres",
    kind: "PostgreSQL",
    pluginId: "postgres",
    server: "PostgreSQL",
    setting: "statement_timeout",
    config: () => POSTGRES_CONFIG,
    readLimit: "SELECT 'limit=' || current_setting('statement_timeout') AS server_limit",
    limitText: (seconds) => (seconds === 0 ? "limit=0" : `limit=${String(seconds)}s`),
    bigRead: "SELECT g AS id, repeat('x', 500) AS pad FROM generate_series(1, 1000000) AS g",
    sleep: "SELECT pg_sleep(60)",
    testResult: "limit: statement_timeout",
    hint: STATEMENT_HINT,
  },
];

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function settingsDialog(page: Page) {
  return page.getByRole("dialog", { name: "Settings" });
}

async function firstCell(page: Page): Promise<string> {
  return (await gridText(page)).cells[0] ?? "";
}

describe.runIf(DATABASES_ENABLED)("server-enforced statement timeout live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function copiedToken(page: Page): Promise<string> {
    await findAction(page, "MCP Server Settings");
    const dialog = settingsDialog(page);
    await dialog.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    await dialog.getByTestId("mcp-copy-config").click();
    await expect.poll(() => dialog.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
    const app = running?.app;
    if (app === undefined) throw new Error("The app is not running.");
    const match = /Bearer (tc_[\w-]+)/.exec(await app.evaluate(({ clipboard }) => clipboard.readText()));
    if (match?.[1] === undefined) throw new Error("The copied config holds no token.");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    return match[1];
  }

  for (const dialect of DIALECTS) {
    const scenario = it.skipIf(!databaseEnabled(dialect.id));
    const name = `${dialect.id}-119`;

    scenario(
      `given${dialect.server}OptedIn_whenConsoleAndAgentRun_thenTheDatabaseHoldsAndEnforcesTheLimit`,
      async () => {
        const port = await freePort();
        const userDataDir = newProfile();
        seedSettings(userDataDir, {
          version: 1,
          appearance: { motion: "off" },
          mcp: { enabled: true, port, rowCap: 100, statementTimeoutSeconds: AGENT_SECONDS, clients: KNOWN_CLIENTS },
        });
        running = await launchApp(null, { userDataDir });
        const { page } = running;
        await setWindowSize(running.app, EVIDENCE_WINDOW);
        await toolWindow(page, "Database").waitFor({ timeout: LAUNCH_TIMEOUT_MS });

        const config = dialect.config();
        await fillNewDatasource(page, {
          kind: dialect.kind,
          name,
          fields: { Host: config.host, Port: String(config.port), Database: config.database, User: config.user },
          password: config.password,
          passwordMode: "forever",
        });
        const dialog = dataSourcesDialog(page);
        await dialog.getByLabel("Statement timeout (s)", { exact: true }).fill(String(CONSOLE_SECONDS));
        const enforce = dialog.getByTestId("enforce-timeout-on-server");
        expect(await enforce.isEnabled()).toBe(true);
        await enforce.check();
        await chooseOption(dialog.getByTestId("datasource-agent-access"), "read");
        const tested = await testConnection(page);
        expect(tested.ok).toBe(true);
        expect(tested.text).toContain(dialect.testResult);
        const hint = dialog.getByTestId("server-timeout-hint");
        await hint.scrollIntoViewIfNeeded();
        await hint.hover();
        await expect.poll(() => page.getByRole("tooltip").textContent()).toBe(dialect.hint);
        await captureWindow(page, `01-${dialect.id}-advanced-opt-in`);
        await dialog.getByRole("button", { name: "OK", exact: true }).click();
        await dialog.waitFor({ state: "detached" });

        await openConsoleOn(page, name);
        await waitUntilReady(page);
        await runStatement(page, dialect.readLimit);
        await expect.poll(() => firstCell(page)).toBe(dialect.limitText(CONSOLE_SECONDS));
        await captureWindow(page, `02-${dialect.id}-console-server-limit`);

        const agent = new AgentClient(port, await copiedToken(page));
        await agent.initialize("Claude Code");
        const fromSetting = await agent.tool("run_query", { datasource: name, sql: dialect.readLimit });
        expect(fromSetting.isError).toBe(false);
        expect(fromSetting.text).toContain(dialect.limitText(AGENT_SECONDS));

        await findAction(page, "MCP Server Settings");
        const settings = settingsDialog(page);
        await settings.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        expect(await settings.getByLabel("Statement timeout", { exact: true }).inputValue()).toBe(
          String(AGENT_SECONDS),
        );
        const override = settings.getByLabel(`Statement timeout for ${name}`);
        await override.fill(String(AGENT_OVERRIDE_SECONDS));
        await override.press("Enter");
        await expect.poll(() => override.inputValue()).toBe(String(AGENT_OVERRIDE_SECONDS));
        await override.scrollIntoViewIfNeeded();
        await captureWindow(page, `03-${dialect.id}-mcp-timeouts`);
        await page.keyboard.press("Escape");
        await settings.waitFor({ state: "detached" });

        await expect
          .poll(async () => (await agent.tool("run_query", { datasource: name, sql: dialect.readLimit })).text, {
            timeout: LAUNCH_TIMEOUT_MS,
          })
          .toContain(dialect.limitText(AGENT_OVERRIDE_SECONDS));

        const opened = await agent.tool("run_query", { datasource: name, sql: dialect.bigRead });
        expect(opened.isError).toBe(false);
        const handle = MORE_ROWS.exec(opened.text)?.[1];
        if (handle === undefined) throw new Error(`run_query kept no result open: ${opened.text.slice(0, 200)}`);
        await new Promise((settle) => setTimeout(settle, PAUSE_MS));
        const cut = await agent.tool("fetch_rows", { handle, offset: FAR_OFFSET, limit: 1 });
        expect(cut.isError).toBe(true);
        expect(cut.text).toMatch(
          new RegExp(
            `${dialect.server} stopped the statement at its ${String(AGENT_OVERRIDE_SECONDS)} s limit \\(${escaped(dialect.setting)}\\)\\.`,
          ),
        );
        expect(cut.text).toContain("Narrow it with LIMIT or WHERE");

        const transcript = [
          `-- An agent's run_query on ${dialect.server}, paused ${String(PAUSE_MS / 1000)} s with its result open:`,
          `-- ${dialect.bigRead.slice(0, 90)}…`,
          `-- fetch_rows({ handle: "${handle}", offset: ${String(FAR_OFFSET)} }) answered:`,
          ...cut.text.split("\n").map((line) => `-- ${line}`),
        ].join("\n");
        writeEvidence(`04-${dialect.id}-agent-cut-by-server.txt`, `${transcript}\n`);
        await sqlEditor(page).fill(transcript);
        await sqlEditor(page).press("ControlOrMeta+Home");
        await captureWindow(page, `04-${dialect.id}-agent-cut-by-server`);
        await findAction(page, "Show Agent Activity");
        const activity = page.getByTestId("mcp-activity");
        await activity.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
        await expect
          .poll(() => activity.locator('[data-testid="mcp-activity-row"][data-outcome="error"]').count())
          .toBe(1);
        await captureWindow(page, `05-${dialect.id}-agent-activity`);
        await agent.close();
      },
      SCENARIO_MS,
    );

    scenario(
      `given${dialect.server}NotOptedIn_whenStatementOverruns_thenOnlyTheEngineTimesItOut`,
      async () => {
        const userDataDir = newProfile();
        seedSettings(userDataDir, {
          version: 1,
          appearance: { motion: "off" },
          console: { statementTimeoutSeconds: CONSOLE_SECONDS },
        });
        running = await launchApp(
          { id: dialect.id, pluginId: dialect.pluginId, config: dialect.config() },
          { userDataDir },
        );
        const { page } = running;
        await setWindowSize(running.app, EVIDENCE_WINDOW);
        await waitUntilReady(page);

        await runStatement(page, dialect.readLimit);
        await expect.poll(() => firstCell(page)).toBe(dialect.limitText(0));
        await captureWindow(page, `06-${dialect.id}-no-opt-in-server-untouched`);
        await runStatement(page, dialect.sleep);
        await expect
          .poll(() => consoleAlert(page).first().textContent(), { timeout: LAUNCH_TIMEOUT_MS })
          .toContain(`timed out after ${String(CONSOLE_SECONDS)} s`);
        await captureWindow(page, `07-${dialect.id}-no-opt-in-engine-timer`);
      },
      SCENARIO_MS,
    );
  }
});
