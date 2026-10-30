/**
 * Plan 037's live test: data sources that verify the server's certificate and present a client
 * certificate, against the compose `postgres-tls` and `mysql-tls` servers. Gated, because it needs
 * a display, a fresh build and the `test/db/compose.yml` containers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/037 bun run test:smoke:db:headless test/e2e/sslCertificates.smoke.test.ts
 */
import type { Locator, Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { MYSQL_TLS_CONFIG, POSTGRES_TLS_CONFIG, TLS_FILES, WITHOUT_POSTGRES } from "../support/databases.js";
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

const captureWindow = evidenceFor("037");

/** Any value: the `tc_cert` role authenticates by its certificate, so the server never asks. */
const UNUSED_PASSWORD = "unused";
const SSL_SETTINGS_HINT = "Fix the SSL settings under SSH/SSL";

function field(page: Page, label: string) {
  return dataSourcesDialog(page).getByLabel(label, { exact: true });
}

async function text(locator: Locator): Promise<string> {
  return (await locator.count()) === 0 ? "" : ((await locator.first().textContent()) ?? "");
}

async function newDatasource(page: Page, kind: string, name: string): Promise<void> {
  await toolWindow(page, "Database").getByRole("button", { name: "New Data Source…", exact: true }).click();
  const dialog = dataSourcesDialog(page);
  await dialog.getByRole("list", { name: "Database kinds" }).getByRole("button", { name: kind }).click();
  await dialog.getByLabel("Name", { exact: true }).fill(name);
}

async function fillServer(page: Page, config: typeof POSTGRES_TLS_CONFIG | typeof MYSQL_TLS_CONFIG): Promise<void> {
  await field(page, "Host").fill(config.host);
  await field(page, "Port").fill(String(config.port));
  await field(page, "Database").fill(config.database);
}

async function saveDialog(page: Page): Promise<void> {
  await dataSourcesDialog(page).getByRole("button", { name: "OK", exact: true }).click();
  await dataSourcesDialog(page).waitFor({ state: "detached" });
}

async function showTestResult(page: Page): Promise<void> {
  await dataSourcesDialog(page).getByTestId("test-result").scrollIntoViewIfNeeded();
}

describe.runIf(DATABASES_ENABLED)("SSL certificates live test", () => {
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
    "givenPostgresVerifyFullWithCa_whenTestedAndQueried_thenReportsTlsAndRunsEncrypted",
    async () => {
      const page = await launch();
      await newDatasource(page, "PostgreSQL", "pg-verify-full");
      await fillServer(page, POSTGRES_TLS_CONFIG);
      await field(page, "User").fill(POSTGRES_TLS_CONFIG.user);
      await field(page, "Password").fill(POSTGRES_TLS_CONFIG.password);
      await chooseOption(field(page, "SSL mode"), { label: "Verify full" });
      await field(page, "SSL root certificate").fill(TLS_FILES.ca);
      await field(page, "Client key").scrollIntoViewIfNeeded();
      expect(await dataSourcesDialog(page).getByTestId("ca-file-note").count()).toBe(0);
      await captureWindow(page, "01-postgres-ssl-section-verify-full");

      const result = await testConnection(page);

      expect(result.ok).toBe(true);
      expect(await text(dataSourcesDialog(page).getByTestId("test-tls"))).toMatch(/^SSL: TLSv1\.[23] · \S+/);
      await showTestResult(page);
      await captureWindow(page, "02-postgres-test-connection-tls-line");

      await saveDialog(page);
      const profile = running?.userDataDir ?? "";
      expect(JSON.parse(readProfileFile(profile, "datasources.json") ?? "")).toMatchObject({
        datasources: [{ config: { sslMode: "verify-full", sslRootCert: TLS_FILES.ca } }],
      });
      await openConsoleOn(page, "pg-verify-full");
      await waitUntilReady(page);
      await runStatement(page, "SELECT ssl AS encrypted, version AS tls FROM pg_stat_ssl WHERE pid = pg_backend_pid()");
      await page.getByRole("columnheader", { name: "tls" }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await page.getByRole("gridcell", { name: "true" }).waitFor();
      await captureWindow(page, "03-postgres-console-over-verified-tls");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenCaFileWithRequire_whenShown_thenHintsAVerifyMode",
    async () => {
      const page = await launch();
      await newDatasource(page, "PostgreSQL", "pg-require-ca");
      await fillServer(page, POSTGRES_TLS_CONFIG);
      await chooseOption(field(page, "SSL mode"), { label: "Require" });
      await field(page, "SSL root certificate").fill(TLS_FILES.ca);

      const note = dataSourcesDialog(page).getByTestId("ca-file-note");

      await note.waitFor();
      expect(await text(note)).toBe("Use Verify CA or Verify full to check this CA file.");
      await note.scrollIntoViewIfNeeded();
      await captureWindow(page, "04-ca-file-with-require-hint");
      await chooseOption(field(page, "SSL mode"), { label: "Verify CA" });
      await note.waitFor({ state: "detached" });
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlWrongCa_whenTested_thenFailsNamingTheCaFile",
    async () => {
      const page = await launch();
      await newDatasource(page, "MySQL", "mysql-wrong-ca");
      await fillServer(page, MYSQL_TLS_CONFIG);
      await field(page, "User").fill(MYSQL_TLS_CONFIG.user);
      await field(page, "Password").fill(MYSQL_TLS_CONFIG.password);
      await chooseOption(field(page, "SSL mode"), { label: "Verify CA" });
      await field(page, "SSL root certificate").fill(TLS_FILES.wrongCa);

      const result = await testConnection(page);

      expect(result.ok).toBe(false);
      expect(result.text).toContain(`not signed by the CA in ${TLS_FILES.wrongCa}`);
      expect(result.text).toContain(SSL_SETTINGS_HINT);
      await showTestResult(page);
      await captureWindow(page, "05-mysql-wrong-ca-refused");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenMysqlClientCertificate_whenTestedAndQueried_thenAuthenticatesAsCertificateUser",
    async () => {
      const page = await launch();
      await newDatasource(page, "MySQL", "mysql-client-cert");
      await fillServer(page, MYSQL_TLS_CONFIG);
      await field(page, "User").fill(TLS_FILES.certUser);
      await chooseOption(field(page, "SSL mode"), { label: "Verify full" });
      await field(page, "SSL root certificate").fill(TLS_FILES.ca);
      await field(page, "Client certificate").fill(TLS_FILES.clientCert);
      await field(page, "Client key").fill(TLS_FILES.encryptedClientKey);
      await field(page, "Client key passphrase").fill(TLS_FILES.keyPassphrase);
      await field(page, "Client key passphrase").scrollIntoViewIfNeeded();
      await captureWindow(page, "06-mysql-client-certificate-filled");

      const result = await testConnection(page);

      expect(result.ok).toBe(true);
      expect(await text(dataSourcesDialog(page).getByTestId("test-tls"))).toMatch(/^SSL: TLSv1\.[23]/);
      await showTestResult(page);
      await captureWindow(page, "07-mysql-client-certificate-test-connection");

      await saveDialog(page);
      await openConsoleOn(page, "mysql-client-cert");
      // The certificate user has no password, and an empty one is never stored, so connect asks.
      const prompt = page.getByRole("dialog", { name: "Connect to mysql-client-cert" });
      await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await prompt.getByLabel("Client key passphrase", { exact: true }).count()).toBe(0);
      await prompt.getByRole("button", { name: "Connect", exact: true }).click();
      await waitUntilReady(page);
      await runStatement(page, "SELECT CURRENT_USER() AS who, note FROM tls_probe");
      await page.getByRole("gridcell", { name: `${TLS_FILES.certUser}@%` }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "08-mysql-console-as-certificate-user");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenEncryptedClientKeyNotSaved_whenConnect_thenAsksForPassphrase",
    async () => {
      const profile = newProfile();
      const { password: _password, ...plain } = POSTGRES_TLS_CONFIG;
      seedDatasources(profile, [
        {
          id: "pg-cert",
          name: "pg-cert",
          pluginId: "postgres",
          config: {
            ...plain,
            user: TLS_FILES.certUser,
            sslMode: "verify-full",
            sslRootCert: TLS_FILES.ca,
            sslCert: TLS_FILES.clientCert,
            sslKey: TLS_FILES.encryptedClientKey,
          },
          secretModes: { password: "never", sslKeyPassphrase: "never" },
        },
      ]);
      const page = await launch(profile);
      await openConsoleOn(page, "pg-cert");
      const prompt = page.getByRole("dialog", { name: "Connect to pg-cert" });
      await prompt.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await prompt.getByLabel("Password", { exact: true }).fill(UNUSED_PASSWORD);
      await prompt.getByLabel("Client key passphrase", { exact: true }).fill(TLS_FILES.keyPassphrase);
      await captureWindow(page, "09-connect-asks-client-key-passphrase");
      await prompt.getByRole("button", { name: "Connect", exact: true }).click();
      await waitUntilReady(page);

      await runStatement(page, "SELECT current_user AS who, note FROM tls_probe");

      await page.getByRole("gridcell", { name: TLS_FILES.certUser }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "10-postgres-console-as-certificate-user");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_POSTGRES)(
    "givenMissingClientKey_whenTested_thenErrorNamesTheField",
    async () => {
      const page = await launch();
      await newDatasource(page, "PostgreSQL", "pg-missing-key");
      await fillServer(page, POSTGRES_TLS_CONFIG);
      await field(page, "User").fill(TLS_FILES.certUser);
      await chooseOption(field(page, "SSL mode"), { label: "Verify full" });
      await field(page, "SSL root certificate").fill(TLS_FILES.ca);
      await field(page, "Client certificate").fill(TLS_FILES.clientCert);
      await field(page, "Client key").fill(`${TLS_FILES.clientKey}.missing`);

      const result = await testConnection(page);

      expect(result.ok).toBe(false);
      expect(result.text).toContain(`Cannot read the Client key ${TLS_FILES.clientKey}.missing`);
      expect(result.text).toContain(SSL_SETTINGS_HINT);
      await showTestResult(page);
      await captureWindow(page, "11-missing-client-key-named");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
