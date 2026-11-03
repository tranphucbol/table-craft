import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openQueryHistory } from "@table-craft/core";
import { createConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import { createDatasourceStore } from "@table-craft/desktop/main/datasources.js";
import { createHostRegistry } from "@table-craft/desktop/main/hosts.js";
import { createImporter } from "@table-craft/desktop/main/import/importer.js";
import type { CredentialReader, SecretLookup } from "@table-craft/desktop/main/import/keychain.js";
import { nodeImportFiles } from "@table-craft/desktop/main/import/nodeFiles.js";
import { isWorkbenchXml, readWorkbenchXml, splitSshHost } from "@table-craft/desktop/main/import/workbench.js";
import { zip } from "@table-craft/desktop/main/log/zip.js";
import { listPlugins } from "@table-craft/desktop/main/plugins.js";
import { createSecretStore } from "@table-craft/desktop/main/secrets.js";
import { createDatasourceService, DatasourceError } from "@table-craft/desktop/main/service.js";
import type { ImportPreview, ImportRow } from "@table-craft/desktop/preload/bridge.js";
import { fakeHostDependencies } from "../support/fakeHosts.js";
import {
  legacyWorkbenchXml,
  WORKBENCH_IDS,
  workbenchConnections,
  workbenchDirectory,
  workbenchXml,
  writeWorkbenchFixture,
} from "../support/import/workbenchFixtures.js";
import { fakeCipher, memoryFiles } from "../support/memoryFiles.js";

const BUILT_IN_PLUGINS = join(import.meta.dirname, "../../plugins");
const PROFILE = "/profile";
const MYSQL = { host: "mysql.test", port: 3307 };
const FIXTURE_DATE = new Date(2026, 10, 2);
const CONNECTION_COUNT = 8;

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tc-workbench-"));
  homes.push(home);
  return home;
}

function fixtureHome(platform: NodeJS.Platform = "darwin"): string {
  const home = newHome();
  writeWorkbenchFixture(home, platform, workbenchXml(workbenchConnections(MYSQL)));
  return home;
}

/** A keychain answering from `service|account`, recording each lookup the same way. */
function fakeKeychain(passwords: ReadonlyMap<string, string> = new Map(), available = true) {
  const asked: string[] = [];
  const reader: CredentialReader = {
    available,
    label: "macOS Keychain",
    lookup(service, account) {
      const key = `${service}|${account ?? ""}`;
      asked.push(key);
      const value = passwords.get(key);
      const lookup: SecretLookup = value === undefined ? { status: "notFound" } : { status: "found", value };
      return Promise.resolve(lookup);
    },
  };
  return { reader, asked };
}

async function setup(home: string, credentials: CredentialReader, platform: NodeJS.Platform = "darwin") {
  const files = memoryFiles();
  let ids = 0;
  const plugins = await listPlugins([BUILT_IN_PLUGINS]);
  const service = await createDatasourceService({
    store: createDatasourceStore({ directory: PROFILE, files }),
    secrets: await createSecretStore({ directory: PROFILE, files, cipher: fakeCipher() }),
    hosts: createHostRegistry({ pluginRoots: () => [], dependencies: fakeHostDependencies(), onExit: () => undefined }),
    plugins: () => plugins,
    ephemeral: null,
    newId: () => `id-${String(++ids)}`,
    consoles: createConsoleFiles({ directory: PROFILE, files }),
    history: openQueryHistory(":memory:"),
    onChanged: () => undefined,
  });
  const importer = createImporter({
    environment: {
      platform,
      home,
      appData: platform === "win32" ? join(home, "AppData", "Roaming") : null,
      files: nodeImportFiles,
    },
    credentials,
    tableProGroups: () => Promise.resolve([]),
    service,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { service, importer };
}

function ready(preview: ImportPreview) {
  if (preview.status !== "ready") throw new Error(`preview is ${preview.status}`);
  return preview;
}

function row(rows: readonly ImportRow[], name: string): ImportRow {
  const found = rows.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no row ${name}`);
  return found;
}

async function importAll(home: string, credentials: CredentialReader, importPasswords = true) {
  const { service, importer } = await setup(home, credentials);
  const preview = ready(await importer.preview({ source: "workbench" }));
  const keys = preview.rows.filter((candidate) => candidate.selected).map((candidate) => candidate.key);
  const summary = await importer.run(
    { previewId: preview.previewId, keys, importPasswords, topFolder: false },
    () => undefined,
  );
  const datasource = (name: string) => {
    const found = service.list().datasources.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`no datasource ${name}`);
    return found;
  };
  return { service, importer, preview, summary, datasource };
}

describe("MySQL Workbench reader", () => {
  it("givenWorkbenchXml_whenSniffed_thenTellsItFromDataGrip", () => {
    expect(isWorkbenchXml(workbenchXml([]))).toBe(true);
    expect(isWorkbenchXml('<?xml version="1.0"?>\n<project version="4"></project>')).toBe(false);
  });

  it.each([
    ["bastion.test", { host: "bastion.test", port: null }],
    ["bastion.test:2222", { host: "bastion.test", port: 2222 }],
    ["[2001:db8::1]:2200", { host: "2001:db8::1", port: 2200 }],
    ["2001:db8::1", { host: "2001:db8::1", port: null }],
  ])("givenSshHost%s_whenSplit_thenHostAndPort", (text, expected) => {
    expect(splitSshHost(text)).toEqual(expected);
  });

  it("givenLegacyFile_whenRead_thenOldKeysAndClearPasswordAreUsed", () => {
    const [old] = readWorkbenchXml(legacyWorkbenchXml(), "darwin");

    expect(old).toMatchObject({ host: "old.test", user: "legacy", database: "app" });
    expect(old?.password).toEqual({ kind: "bundle", value: "cleartext-secret" });
  });

  it("givenWindows_whenRead_thenPasswordsAreAskedOnConnect", () => {
    const connections = readWorkbenchXml(workbenchXml(workbenchConnections(MYSQL)), "win32");

    expect(connections.find((connection) => connection.id === WORKBENCH_IDS.shop)?.password).toEqual({
      kind: "elsewhere",
    });
  });
});

describe("MySQL Workbench import", () => {
  it("givenWorkbenchFolder_whenScanning_thenCardCountsItsConnections", async () => {
    const home = fixtureHome();
    const { importer } = await setup(home, fakeKeychain().reader);

    const card = (await importer.scan()).find((source) => source.app === "workbench");

    expect(card).toEqual({
      app: "workbench",
      label: "MySQL Workbench",
      found: true,
      count: CONNECTION_COUNT,
      locations: [join(workbenchDirectory(home, "darwin"), "connections.xml")],
      passwords: "macOS Keychain",
    });
  });

  it("givenNoWorkbench_whenScanning_thenCardIsNotFoundWithLookedPaths", async () => {
    const home = newHome();
    const { importer } = await setup(home, fakeKeychain().reader, "linux");

    const card = (await importer.scan()).find((source) => source.app === "workbench");

    expect(card).toMatchObject({ found: false, count: 0, locations: [workbenchDirectory(home, "linux")] });
  });

  it("givenTcpConnection_whenPreviewing_thenHostPortUserSchemaMap", async () => {
    const { importer } = await setup(fixtureHome(), fakeKeychain().reader);

    const { rows, topFolder } = ready(await importer.preview({ source: "workbench" }));

    expect(topFolder).toBe("MySQL Workbench");
    expect(row(rows, "Shop MySQL")).toMatchObject({
      key: `workbench:${WORKBENCH_IDS.shop}`,
      pluginId: "mysql",
      folder: "Docker",
      target: `${MYSQL.host}:${String(MYSQL.port)}/table_craft`,
      user: "table_craft",
      password: "keychain",
      warnings: [],
      status: "ready",
      selected: true,
    });
  });

  it("givenGroupedName_whenPreviewing_thenFolderIsTheTextBeforeTheFirstSlash", async () => {
    const { importer } = await setup(fixtureHome(), fakeKeychain().reader);

    const { rows } = ready(await importer.preview({ source: "workbench" }));

    expect(row(rows, "Reports/Daily").folder).toBe("Team");
  });

  it("givenSocketConnection_whenPreviewing_thenRowIsUnsupported", async () => {
    const { importer } = await setup(fixtureHome(), fakeKeychain().reader);

    const { rows } = ready(await importer.preview({ source: "workbench" }));

    expect(row(rows, "Local socket")).toMatchObject({ status: "unsupported", selected: false });
    expect(row(rows, "Local socket").warnings[0]).toMatch(/TableCraft's MySQL connects over TCP\/IP/);
  });

  it("givenLdapAndKerberos_whenPreviewing_thenWarnedAndKerberosHasNoPassword", async () => {
    const { importer } = await setup(fixtureHome(), fakeKeychain().reader);

    const { rows } = ready(await importer.preview({ source: "workbench" }));

    expect(row(rows, "Directory")).toMatchObject({ status: "ready", password: "keychain" });
    expect(row(rows, "Directory").warnings).toEqual([expect.stringMatching(/LDAP/)]);
    expect(row(rows, "Kerberos")).toMatchObject({ status: "ready", password: "notSaved" });
  });

  it("givenUseSslVerifyCa_whenImporting_thenModeAndFilesMapAndCipherIsNamed", async () => {
    const { preview, datasource } = await importAll(fixtureHome(), fakeKeychain().reader);

    expect(row(preview.rows, "Secure").warnings).toEqual(["Not imported: sslCipher."]);
    expect(datasource("Secure").config).toMatchObject({
      sslMode: "verify-ca",
      sslRootCert: "/certs/ca.pem",
      sslCert: "/certs/client.pem",
      sslKey: "/certs/client.key",
    });
    expect(datasource("Shop MySQL").config).toMatchObject({ sslMode: "disable" });
  });

  it("givenSshTunnelConnection_whenImporting_thenDatasourceHasTheTunnel", async () => {
    const { preview, datasource } = await importAll(fixtureHome(), fakeKeychain().reader);

    const orders = row(preview.rows, "Orders via bastion");
    expect(orders).toMatchObject({ folder: "Prod", target: "10.0.0.5:3306 via bastion.test", status: "ready" });
    expect(orders.warnings).toEqual([]);
    expect(datasource("Orders via bastion").config).toMatchObject({ sslMode: "disable" });
    expect(datasource("Orders via bastion").ssh).toEqual({
      enabled: true,
      host: "bastion.test",
      port: 2222,
      user: "deploy",
      auth: "key",
      keyPath: "/home/me/.ssh/id_ed25519",
    });
  });

  it("givenSshPasswordInKeychain_whenImporting_thenBothPasswordsAreStored", async () => {
    const passwords = new Map([
      ["Mysql@10.0.0.6:3306@jump.test|billing", "db-secret"],
      ["ssh@jump.test|ops", "ssh-secret"],
    ]);
    const { reader, asked } = fakeKeychain(passwords);
    const { service, preview, datasource } = await importAll(fixtureHome(), reader);

    const billing = datasource("Billing via jump");
    expect(row(preview.rows, "Billing via jump").warnings).toEqual(["Not imported: sshCompressionLevel."]);
    expect(billing.ssh).toMatchObject({ host: "jump.test", port: 22, user: "ops", auth: "password" });
    expect(asked).toContain("ssh@jump.test|ops");
    const view = service.list().datasources.find((candidate) => candidate.id === billing.id);
    expect(view?.storedSecrets).toEqual(expect.arrayContaining(["password", "ssh.password"]));
  });

  it("givenMissingHostIdentifier_whenImporting_thenLookupUsesTheTemplate", async () => {
    const { reader, asked } = fakeKeychain();

    await importAll(fixtureHome(), reader);

    expect(asked).toContain("Mysql@reports.test:3307|reader");
    expect(asked).toContain(`Mysql@${MYSQL.host}:${String(MYSQL.port)}|table_craft`);
  });

  it("givenImportedOnce_whenImportingAgain_thenRowsAreDuplicates", async () => {
    const home = fixtureHome();
    const { importer } = await importAll(home, fakeKeychain().reader, false);

    const again = ready(await importer.preview({ source: "workbench" }));

    const importable = again.rows.filter((candidate) => candidate.status !== "unsupported");
    expect(importable.map((candidate) => candidate.status)).toEqual(importable.map(() => "duplicate"));
  });

  it("givenLegacyFile_whenPreviewingFile_thenPasswordIsInTheFile", async () => {
    const home = newHome();
    const path = join(home, "connections.xml");
    writeFileSync(path, legacyWorkbenchXml());
    const { importer } = await setup(home, fakeKeychain().reader);

    const { app, rows } = ready(await importer.preview({ source: "file", path }));

    expect(app).toBe("workbench");
    expect(row(rows, "Old server")).toMatchObject({ target: "old.test:3306/app", user: "legacy", password: "inFile" });
  });

  it("givenBackupZip_whenPreviewingFile_thenConnectionsAreRead", async () => {
    const home = newHome();
    const path = join(home, "workbench-backup.zip");
    const encode = (text: string) => new TextEncoder().encode(text);
    writeFileSync(
      path,
      zip(
        [
          { name: "connections.xml", data: encode(workbenchXml(workbenchConnections(MYSQL))) },
          { name: "server_instances.xml", data: encode(workbenchXml([])) },
        ],
        FIXTURE_DATE,
      ),
    );
    const { importer } = await setup(home, fakeKeychain().reader);

    const { app, rows } = ready(await importer.preview({ source: "file", path }));

    expect(app).toBe("workbench");
    expect(rows).toHaveLength(CONNECTION_COUNT);
  });

  it.each([
    ["no connections.xml", () => zip([{ name: "server_instances.xml", data: new Uint8Array(1) }], FIXTURE_DATE)],
    ["not a zip", () => new TextEncoder().encode("not a zip archive at all, just text")],
  ])("givenZipWith%s_whenPreviewingFile_thenErrorSaysWhatToPick", async (_case, bytes) => {
    const home = newHome();
    const path = join(home, "backup.zip");
    writeFileSync(path, bytes());
    const { importer } = await setup(home, fakeKeychain().reader);

    const failure = importer.preview({ source: "file", path });

    await expect(failure).rejects.toBeInstanceOf(DatasourceError);
    await expect(failure).rejects.toMatchObject({
      hint: "Pick Workbench's connections.xml or a Backup Connections .zip.",
    });
  });

  it("givenWindows_whenScanning_thenAppDataIsReadAndPasswordsAskOnConnect", async () => {
    const home = fixtureHome("win32");
    const { importer } = await setup(home, fakeKeychain(new Map(), false).reader, "win32");

    const card = (await importer.scan()).find((source) => source.app === "workbench");
    const { rows } = ready(await importer.preview({ source: "workbench" }));

    expect(card).toMatchObject({ found: true, count: CONNECTION_COUNT });
    expect(card?.passwords).toMatch(/asked for on connect/);
    expect(row(rows, "Shop MySQL").password).toBe("askOnConnect");
  });
});
