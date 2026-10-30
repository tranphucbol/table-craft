/**
 * Plan 036's live test: data sources reached through the compose `ssh` bastion. Gated, because it
 * needs a display, a fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/036 bun run test:smoke:db:headless test/e2e/sshTunnel.smoke.test.ts
 *
 * The database host and port typed into the form are the bastion's view (`postgres:5432`), so the
 * same scenario runs in the headless box and on a host.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ssh2 from "ssh2";
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  MYSQL_BEHIND_BASTION,
  MYSQL_CONFIG,
  POSTGRES_BEHIND_BASTION,
  POSTGRES_CONFIG,
  SSH_BASTION,
  WITHOUT_POSTGRES,
} from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  dataSourcesDialog,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  testConnection,
  toolWindow,
  waitUntilReady,
  type RunningApp,
  chooseOption,
} from "./harness.js";

const captureWindow = evidenceFor("036");

const KNOWN_HOSTS_FILE = "ssh_known_hosts.json";
const DEFAULT_SSH_PORT = 22;

function field(page: Page, label: string) {
  return dataSourcesDialog(page).getByLabel(label, { exact: true });
}

function hostKeyPrompt(page: Page) {
  return page.getByRole("dialog", { name: "Unknown SSH host key" });
}

function output(page: Page) {
  return page.getByRole("log", { name: "Output" });
}

async function showOutput(page: Page): Promise<void> {
  await page.getByRole("tablist", { name: "Results" }).getByRole("tab", { name: "Output", exact: true }).click();
}

async function text(locator: Locator): Promise<string> {
  return (await locator.count()) === 0 ? "" : ((await locator.first().textContent()) ?? "");
}

/** The bastion as the app names it: bare on port 22, as OpenSSH writes it. */
function bastionName(): string {
  return SSH_BASTION.port === DEFAULT_SSH_PORT ? SSH_BASTION.host : `${SSH_BASTION.host}:${String(SSH_BASTION.port)}`;
}

async function newDatasource(page: Page, kind: string, name: string): Promise<void> {
  await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
  const dialog = dataSourcesDialog(page);
  await dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: kind }).click();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
}

interface Database {
  readonly kind: string;
  readonly config: typeof POSTGRES_CONFIG | typeof MYSQL_CONFIG;
  readonly behind: { readonly host: string; readonly port: number };
}

const POSTGRES: Database = { kind: "PostgreSQL", config: POSTGRES_CONFIG, behind: POSTGRES_BEHIND_BASTION };
const MYSQL: Database = { kind: "MySQL", config: MYSQL_CONFIG, behind: MYSQL_BEHIND_BASTION };

async function fillDatabase(page: Page, database: Database): Promise<void> {
  await field(page, "Host").fill(database.behind.host);
  await field(page, "Port").fill(String(database.behind.port));
  await field(page, "Database").fill(database.config.database);
  await field(page, "User").fill(database.config.user);
  await field(page, "Password").fill(database.config.password);
}

async function fillBastion(page: Page): Promise<void> {
  await dataSourcesDialog(page).getByLabel("Use SSH tunnel", { exact: true }).check();
  await field(page, "SSH host").fill(SSH_BASTION.host);
  await field(page, "SSH port").fill(String(SSH_BASTION.port));
  await field(page, "SSH user").fill(SSH_BASTION.user);
}

/** Answers the host-key question with Trust once it shows the bastion's fingerprint. */
async function trustHostKey(page: Page, capture?: string): Promise<void> {
  const prompt = hostKeyPrompt(page);
  await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  expect(await text(prompt.getByTestId("host-key-server"))).toBe(bastionName());
  expect(await text(prompt.getByTestId("host-key-fingerprint"))).toBe(SSH_BASTION.fingerprint);
  if (capture !== undefined) await captureWindow(page, capture);
  await prompt.getByRole("button", { name: "Trust", exact: true }).click();
  await prompt.waitFor({ state: "detached" });
}

/** Clicks Test Connection, trusts the bastion when asked, and returns both lines. */
async function testThroughBastion(page: Page, capture?: string): Promise<{ ok: boolean; hop: string; text: string }> {
  const dialog = dataSourcesDialog(page);
  await dialog.getByRole("button", { name: "Test Connection" }).click();
  await trustHostKey(page, capture);
  const result = dialog.getByTestId("test-result");
  await result.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  return {
    ok: (await result.getAttribute("data-ok")) === "true",
    hop: await text(dialog.getByTestId("test-hop")),
    text: (await result.textContent()) ?? "",
  };
}

async function saveDialog(page: Page): Promise<void> {
  await dataSourcesDialog(page).getByRole("button", { name: "OK", exact: true }).click();
  await dataSourcesDialog(page).waitFor({ state: "detached" });
}

/** Ends every SSH session of the bastion's user, the app's tunnel included, as a dropped link would. */
function dropBastionSessions(): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    client
      .on("ready", () => {
        client.exec("kill -9 -1", (error) => {
          if (error !== undefined) reject(error);
        });
      })
      .on("close", () => resolve())
      .on("error", () => resolve())
      .connect({
        host: SSH_BASTION.host,
        port: SSH_BASTION.port,
        username: SSH_BASTION.user,
        password: SSH_BASTION.password,
      });
  });
}

describe.runIf(DATABASES_ENABLED)("SSH tunnel live test", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  async function launch(userDataDir = newProfile()): Promise<Page> {
    running = await launchApp(null, { userDataDir });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return running.page;
  }

  it.skipIf(WITHOUT_POSTGRES)(
    "givenPostgresBehindBastionWithPassword_whenTested_thenAsksForHostKeyAndReportsBothHops",
    async () => {
      const page = await launch();
      await newDatasource(page, "PostgreSQL", "pg-ssh");
      await fillDatabase(page, POSTGRES);
      await fillBastion(page);
      await field(page, "SSH password").fill(SSH_BASTION.password);
      await field(page, "SSH user").scrollIntoViewIfNeeded();
      await captureWindow(page, "01-postgres-ssh-section-filled");

      const result = await testThroughBastion(page, "02-postgres-host-key-prompt");

      expect(result.ok).toBe(true);
      expect(result.hop).toContain(`SSH: connected to ${SSH_BASTION.host} as ${SSH_BASTION.user}`);
      await dataSourcesDialog(page).getByTestId("test-result").scrollIntoViewIfNeeded();
      await captureWindow(page, "03-postgres-test-connection-both-hops");

      await saveDialog(page);
      const profile = running?.userDataDir ?? "";
      const saved = readProfileFile(profile, "datasources.json") ?? "";
      const [stored] = (JSON.parse(saved) as { datasources: { config: object; ssh: object }[] }).datasources;
      expect(stored?.config).not.toHaveProperty("password");
      expect(stored?.ssh).not.toHaveProperty("password");
      expect(JSON.parse(saved)).toMatchObject({
        datasources: [{ ssh: { enabled: true, host: SSH_BASTION.host, user: SSH_BASTION.user, auth: "password" } }],
      });
      expect(readProfileFile(profile, KNOWN_HOSTS_FILE)).toContain('"algorithm": "ssh-ed25519"');

      await openConsoleOn(page, "pg-ssh");
      await waitUntilReady(page);
      await runStatement(page, "SELECT current_user AS who, inet_server_port() AS server_port");
      await page.getByRole("gridcell", { name: POSTGRES_CONFIG.user }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await hostKeyPrompt(page).count()).toBe(0);
      await captureWindow(page, "04-postgres-console-through-tunnel");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlBehindBastionWithKeyAndPassphrase_whenTestedAndQueried_thenRunsThroughTunnel",
    async () => {
      const page = await launch();
      await newDatasource(page, "MySQL", "mysql-ssh-key");
      await fillDatabase(page, MYSQL);
      await fillBastion(page);
      await chooseOption(field(page, "Authentication"), { label: "Key pair" });
      await field(page, "Private key").fill(SSH_BASTION.keyPath);
      await field(page, "Key passphrase").fill(SSH_BASTION.passphrase);
      await field(page, "Key passphrase").scrollIntoViewIfNeeded();
      await captureWindow(page, "05-mysql-key-auth-filled");

      const result = await testThroughBastion(page);

      expect(result.ok).toBe(true);
      expect(result.hop).toContain(`as ${SSH_BASTION.user}`);
      await dataSourcesDialog(page).getByTestId("test-result").scrollIntoViewIfNeeded();
      await captureWindow(page, "06-mysql-key-auth-test-connection");

      await saveDialog(page);
      await openConsoleOn(page, "mysql-ssh-key");
      await waitUntilReady(page);
      await runStatement(page, "SELECT CURRENT_USER() AS who, @@port AS server_port");
      await page.getByRole("columnheader", { name: "server_port" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.getByRole("gridcell", { name: String(MYSQL_BEHIND_BASTION.port) }).waitFor();
      await captureWindow(page, "07-mysql-console-through-key-tunnel");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenWrongSshPassword_whenTested_thenSshAuthenticationFailed",
    async () => {
      const page = await launch();
      await newDatasource(page, "PostgreSQL", "pg-ssh-wrong");
      await fillDatabase(page, POSTGRES);
      await fillBastion(page);
      await field(page, "SSH password").fill("not-the-password");

      const result = await testThroughBastion(page);

      expect(result.ok).toBe(false);
      expect(result.hop).toBe("");
      expect(result.text).toContain("SSH authentication failed");
      await dataSourcesDialog(page).getByTestId("test-result").scrollIntoViewIfNeeded();
      await captureWindow(page, "08-wrong-ssh-password");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenChangedHostKey_whenTested_thenRefusedNamingBothFingerprints",
    async () => {
      const profile = newProfile();
      const [algorithm = "", otherKey = ""] = readFileSync(`${SSH_BASTION.keyPath}.pub`, "utf8").split(" ");
      const recordedName =
        SSH_BASTION.port === DEFAULT_SSH_PORT ? SSH_BASTION.host : `[${SSH_BASTION.host}]:${String(SSH_BASTION.port)}`;
      writeFileSync(
        join(profile, KNOWN_HOSTS_FILE),
        JSON.stringify({
          version: 1,
          hosts: [{ host: recordedName, algorithm, key: otherKey, addedAt: Date.UTC(2026, 0, 1) }],
        }),
      );
      const page = await launch(profile);
      await newDatasource(page, "PostgreSQL", "pg-ssh-changed");
      await fillDatabase(page, POSTGRES);
      await fillBastion(page);
      await field(page, "SSH password").fill(SSH_BASTION.password);

      const result = await testConnection(page);

      expect(result.ok).toBe(false);
      expect(result.text).toContain(SSH_BASTION.fingerprint);
      expect(result.text).toContain(KNOWN_HOSTS_FILE);
      expect(await hostKeyPrompt(page).count()).toBe(0);
      await dataSourcesDialog(page).getByTestId("test-result").scrollIntoViewIfNeeded();
      await captureWindow(page, "09-changed-host-key-refused");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenTunnelKilled_whenNextQuery_thenReconnectsThroughNewTunnel",
    async () => {
      const profile = newProfile();
      const { password: _password, ...plain } = POSTGRES_CONFIG;
      seedDatasources(profile, [
        {
          id: "pg-ssh",
          name: "pg-ssh",
          pluginId: "postgres",
          config: { ...plain, ...POSTGRES_BEHIND_BASTION },
          secretModes: { password: "never", "ssh.password": "never" },
          ssh: {
            enabled: true,
            host: SSH_BASTION.host,
            port: SSH_BASTION.port,
            user: SSH_BASTION.user,
            auth: "password",
            keyPath: "",
          },
        },
      ]);
      const page = await launch(profile);
      await openConsoleOn(page, "pg-ssh");
      const prompt = page.getByRole("dialog", { name: "Connect to pg-ssh" });
      await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await prompt.getByLabel("Password", { exact: true }).fill(POSTGRES_CONFIG.password);
      await prompt.getByLabel("SSH password", { exact: true }).fill(SSH_BASTION.password);
      await captureWindow(page, "10-connect-asks-database-and-ssh-passwords");
      await prompt.getByRole("button", { name: "Connect", exact: true }).click();
      await trustHostKey(page);
      await waitUntilReady(page);
      await runStatement(page, "SELECT 1 AS before_drop");
      await page.getByRole("columnheader", { name: "before_drop" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });

      await dropBastionSessions();
      await runStatement(page, "SELECT 2 AS after_drop");

      await page.getByRole("columnheader", { name: "after_drop" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await showOutput(page);
      await expect.poll(() => text(output(page))).toContain("Reconnected");
      expect(await hostKeyPrompt(page).count()).toBe(0);
      await captureWindow(page, "11-tunnel-killed-reconnected");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSqlite_whenDialogRenders_thenNoSshSection",
    async () => {
      const page = await launch();
      await newDatasource(page, "SQLite", "local-file");

      await field(page, "File").waitFor();
      expect(await dataSourcesDialog(page).getByText("SSH/SSL", { exact: true }).count()).toBe(0);
      expect(await dataSourcesDialog(page).getByLabel("Use SSH tunnel").count()).toBe(0);
      await captureWindow(page, "12-sqlite-no-ssh-section");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
