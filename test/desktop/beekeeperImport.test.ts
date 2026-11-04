import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openQueryHistory } from "@table-craft/core";
import { createConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import { createDatasourceStore } from "@table-craft/desktop/main/datasources.js";
import { createHostRegistry } from "@table-craft/desktop/main/hosts.js";
import {
  BeekeeperFormatError,
  beekeeperDirectories,
  isSqliteHeader,
  readBeekeeperDatabase,
} from "@table-craft/desktop/main/import/beekeeper.js";
import { beekeeperKey, openSealed } from "@table-craft/desktop/main/import/beekeeperCrypto.js";
import { createImporter } from "@table-craft/desktop/main/import/importer.js";
import type { CredentialReader } from "@table-craft/desktop/main/import/keychain.js";
import { nodeImportFiles } from "@table-craft/desktop/main/import/nodeFiles.js";
import type { ForeignConnection } from "@table-craft/desktop/main/import/types.js";
import { listPlugins } from "@table-craft/desktop/main/plugins.js";
import { createSecretStore } from "@table-craft/desktop/main/secrets.js";
import { createDatasourceService, DatasourceError } from "@table-craft/desktop/main/service.js";
import type { ImportPreview, ImportRow } from "@table-craft/desktop/preload/bridge.js";
import { fakeHostDependencies } from "../support/fakeHosts.js";
import {
  BEEKEEPER_FOLDERS,
  BEEKEEPER_INSTALL_KEY,
  beekeeperConnections,
  beekeeperDirectory,
  beekeeperKeyFile,
  sealForBeekeeper,
  writeBeekeeperDatabase,
  writeBeekeeperFixture,
  type BeekeeperFixture,
  type BeekeeperRow,
} from "../support/import/beekeeperFixtures.js";
import { fakeCipher, memoryFiles } from "../support/memoryFiles.js";

const BUILT_IN_PLUGINS = join(import.meta.dirname, "../../plugins");
const PROFILE = "/profile";
const SERVERS = { mysql: { host: "mysql.test", port: 3307 }, postgres: { host: "pg.test", port: 5433 } };
const LOCAL_CONNECTIONS = 7;

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "tc-beekeeper-"));
  homes.push(home);
  return home;
}

function sqlitePath(home: string): string {
  return join(home, "local.sqlite");
}

function fixtureHome(platform: NodeJS.Platform = "darwin", fixture: Partial<BeekeeperFixture> = {}): string {
  const home = newHome();
  writeBeekeeperFixture(home, platform, {
    connections: beekeeperConnections(SERVERS, sqlitePath(home)),
    folders: BEEKEEPER_FOLDERS,
    ...fixture,
  });
  return home;
}

const noKeychain: CredentialReader = {
  available: false,
  label: "macOS Keychain",
  lookup: () => Promise.reject(new Error("Beekeeper's passwords never come from a keychain")),
};

async function setup(home: string, platform: NodeJS.Platform = "darwin") {
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
    credentials: noKeychain,
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

async function importAll(home: string, importPasswords = true) {
  const { service, importer } = await setup(home);
  const preview = ready(await importer.preview({ source: "beekeeper" }));
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

/** Reads one row written with the current schema and the install key in place. */
async function readOne(connection: BeekeeperRow, options: Partial<BeekeeperFixture> = {}): Promise<ForeignConnection> {
  const home = newHome();
  const path = writeBeekeeperFixture(home, "darwin", {
    connections: [{ id: 1, createdAt: "2026-01-01 00:00:00", name: "One", ...connection }],
    ...options,
  });
  const read = await readBeekeeperDatabase(nodeImportFiles, path, { secrets: true, home });
  const [only] = read.connections;
  if (only === undefined) throw new Error("no connection read");
  return only;
}

describe("Beekeeper Studio sealed values", () => {
  it("givenSealedValue_whenOpened_thenReturnsItsJson", () => {
    expect(openSealed("k", sealForBeekeeper("k", "secret"))).toBe("secret");
    expect(openSealed("k", sealForBeekeeper("k", { a: 1 }))).toEqual({ a: 1 });
  });

  it("givenTamperedOrForeignValue_whenOpened_thenNull", () => {
    const sealed = sealForBeekeeper("k", "secret");
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}=`;
    expect(openSealed("k", flipped)).toBeNull();
    expect(openSealed("other", sealed)).toBeNull();
    expect(openSealed("k", "not sealed")).toBeNull();
  });

  it("givenKeyFile_whenRead_thenReturnsTheInstallKey", () => {
    expect(beekeeperKey(beekeeperKeyFile())).toBe(BEEKEEPER_INSTALL_KEY);
    expect(beekeeperKey("garbage")).toBeNull();
    expect(beekeeperKey(sealForBeekeeper("not the wrapper key", { encryptionKey: "x" }))).toBeNull();
  });
});

describe("Beekeeper Studio reader", () => {
  it("givenEachPlatform_whenLooking_thenPackagedFolderFirst", () => {
    const environment = (platform: NodeJS.Platform) => ({
      platform,
      home: "/home/u",
      appData: platform === "win32" ? "C:\\Users\\u\\AppData\\Roaming" : null,
      files: nodeImportFiles,
    });
    expect(beekeeperDirectories(environment("darwin"))).toEqual([
      join("/home/u", "Library", "Application Support", "beekeeper-studio"),
      join("/home/u", "Library", "Application Support", "Beekeeper Studio"),
    ]);
    expect(beekeeperDirectories(environment("win32"))).toEqual([
      join("C:\\Users\\u\\AppData\\Roaming", "beekeeper-studio"),
      join("C:\\Users\\u\\AppData\\Roaming", "Beekeeper Studio"),
    ]);
    expect(beekeeperDirectories(environment("linux"))).toEqual([
      join("/home/u", ".config", "beekeeper-studio"),
      join("/home/u", ".config", "Beekeeper Studio"),
      join("/home/u", "snap", "beekeeper-studio", "current", ".config", "beekeeper-studio"),
      join("/home/u", ".var", "app", "io.beekeeperstudio.Studio", "config", "beekeeper-studio"),
    ]);
  });

  it("givenSqliteBytes_whenSniffed_thenTellsThemFromOtherFiles", () => {
    expect(isSqliteHeader(new TextEncoder().encode("SQLite format 3\u0000rest"))).toBe(true);
    expect(isSqliteHeader(new TextEncoder().encode('{"tableCraft":1}'))).toBe(false);
    expect(isSqliteHeader(new Uint8Array())).toBe(false);
  });

  it("givenCurrentSchema_whenRead_thenLocalConnectionsInFolderOrder", async () => {
    const home = fixtureHome();
    const read = await readBeekeeperDatabase(nodeImportFiles, join(beekeeperDirectory(home, "darwin"), "app.db"), {
      secrets: true,
      home,
    });
    expect(read.secrets).toBe("read");
    expect(read.folders).toEqual(["Archive", "Production", "Production/EU"]);
    expect(read.connections.map((connection) => connection.name)).toEqual([
      "Key tunnel",
      "Local file",
      "Mongo",
      "Socket",
      "Through bastion",
      "Reporting",
      "Shop MySQL",
    ]);
    expect(read.connections.find((connection) => connection.name === "Shop MySQL")).toMatchObject({
      app: "beekeeper",
      id: "1@2026-01-05 10:00:00",
      folder: "Production/EU",
      driver: "mysql",
      url: null,
      host: "mysql.test",
      port: 3307,
      database: "shop",
      user: "shop",
      color: "pink",
      readOnly: false,
      ssl: { mode: "disabled" },
      password: { kind: "bundle", value: "mysql-secret" },
    });
    expect(read.connections.find((connection) => connection.name === "Local file")).toMatchObject({
      driver: "sqlite",
      path: sqlitePath(home),
      host: null,
      color: null,
      password: { kind: "none" },
    });
  });

  it("givenLegacySchema_whenRead_thenReadsWithoutTheNewerColumns", async () => {
    const connection = await readOne(
      { connectionType: "postgres", host: "old.test", port: 5432, username: "u", password: "p", sshMode: "keyfile" },
      { legacy: true },
    );
    expect(connection).toMatchObject({
      driver: "postgresql",
      host: "old.test",
      folder: null,
      readOnly: false,
      ssh: null,
      password: { kind: "bundle", value: "p" },
    });
  });

  it("givenFolderCycle_whenRead_thenThePathStops", async () => {
    const connection = await readOne(
      { connectionType: "mysql", connectionFolderId: 1 },
      {
        folders: [
          { id: 1, name: "A", parentId: 2 },
          { id: 2, name: "B", parentId: 1 },
        ],
      },
    );
    expect(connection.folder).toBe("B/A");
  });

  it("givenRememberPasswordOff_whenRead_thenNoPassword", async () => {
    const connection = await readOne({ connectionType: "mysql", password: "kept anyway", rememberPassword: 0 });
    expect(connection.password).toEqual({ kind: "none" });
  });

  it("givenNoKeyFile_whenRead_thenAskedOnConnectAndSaysWhy", async () => {
    const connection = await readOne({ connectionType: "mysql", password: "p" }, { keyFile: null });
    expect(connection.password).toEqual({ kind: "elsewhere" });
    expect(connection.warnings).toContain(
      "Beekeeper's .key could not be read, so the password is asked for on connect.",
    );
  });

  it("givenValueSealedUnderAnotherKey_whenRead_thenAskedOnConnect", async () => {
    const connection = await readOne({ connectionType: "mysql", password: { raw: sealForBeekeeper("other", "p") } });
    expect(connection.password).toEqual({ kind: "elsewhere" });
    expect(connection.warnings).toContain("The saved password could not be decrypted, so it is asked for on connect.");
  });

  it("givenSecretsNotWanted_whenRead_thenKeyIsNotOpened", async () => {
    const home = fixtureHome("darwin", { keyFile: "would fail to open" });
    const read = await readBeekeeperDatabase(nodeImportFiles, join(beekeeperDirectory(home, "darwin"), "app.db"), {
      secrets: false,
      home,
    });
    expect(read.secrets).toBeNull();
    expect(read.connections.find((connection) => connection.name === "Shop MySQL")).toMatchObject({
      password: { kind: "elsewhere" },
      warnings: [],
    });
  });

  it.each([
    ["off", { ssl: 0 }, { mode: "disabled" }],
    ["on without files", { ssl: 1, sslRejectUnauthorized: 1 }, { mode: "required" }],
    [
      "on with a CA, checking",
      { ssl: 1, sslCaFile: "/ca.pem", sslRejectUnauthorized: 1 },
      { mode: "verifyIdentity", caFile: "/ca.pem" },
    ],
    [
      "on with a CA, not checking",
      { ssl: 1, sslCaFile: "/ca.pem", sslRejectUnauthorized: 0 },
      { mode: "required", caFile: "/ca.pem" },
    ],
  ])("givenSsl%s_whenRead_thenTheModeBeekeeperConnectsWith", async (_label, columns, expected) => {
    const connection = await readOne({ connectionType: "postgresql", ...columns });
    expect(connection.ssl).toMatchObject(expected);
  });

  it.each([
    ["agent", {}, { auth: "agent", keyPath: null, password: { kind: "none" } }],
    ["userpass", { sshPassword: "s" }, { auth: "password", password: { kind: "bundle", value: "s" } }],
    [
      "keyfile",
      { sshKeyfile: "/k", sshKeyfilePassword: "phrase" },
      { auth: "key", keyPath: "/k", passphrase: { kind: "bundle", value: "phrase" } },
    ],
  ])("givenSshMode%s_whenRead_thenTheTunnelSignsInTheSameWay", async (mode, columns, expected) => {
    const connection = await readOne({
      connectionType: "mysql",
      sshEnabled: 1,
      sshHost: "jump.test",
      sshUsername: "deploy",
      sshMode: mode,
      ...columns,
    });
    expect(connection.ssh).toMatchObject({ host: "jump.test", port: null, user: "deploy", ...expected });
  });

  it("givenKeyfileModeWithoutAFile_whenRead_thenBeekeepersDefaultKey", async () => {
    const home = newHome();
    const path = writeBeekeeperFixture(home, "darwin", {
      connections: [
        {
          id: 1,
          name: "One",
          connectionType: "mysql",
          sshEnabled: 1,
          sshHost: "h",
          sshUsername: "u",
          sshMode: "keyfile",
        },
      ],
    });
    const read = await readBeekeeperDatabase(nodeImportFiles, path, { secrets: true, home });
    expect(read.connections[0]?.ssh?.keyPath).toBe(join(home, ".ssh", "id_rsa"));
  });

  it("givenJumpHost_whenRead_thenTheTunnelIsLeftToTheUser", async () => {
    const connection = await readOne({
      connectionType: "mysql",
      sshEnabled: 1,
      sshHost: "inner.test",
      sshUsername: "deploy",
      sshBastionHost: "outer.test",
    });
    expect(connection.ssh?.unsupported).toBe(
      "Beekeeper reaches this server through the jump host outer.test; TableCraft tunnels through one SSH host, so set the tunnel up after import.",
    );
  });

  it("givenOracleServiceAndPrivilege_whenRead_thenServiceKeptAndPrivilegeNamed", async () => {
    const connection = await readOne({
      connectionType: "oracle",
      serviceName: "ORCLPDB1",
      defaultDatabase: "ignored",
      options: JSON.stringify({ privilege: "SYSDBA" }),
    });
    expect(connection.database).toBe("ORCLPDB1");
    expect(connection.warnings).toContain("The Oracle privilege SYSDBA was not imported.");
  });

  it.each([
    ["a socket", { connectionType: "mysql", socketPathEnabled: 1 }, "Connects through a local socket"],
    [
      "an Oracle connect string",
      { connectionType: "oracle", options: JSON.stringify({ connectionMethod: "connectionString" }) },
      "Uses an Oracle connect string",
    ],
  ])("givenConnectionThrough%s_whenRead_thenSaysWhyItIsNotImported", async (_label, columns, problem) => {
    const connection = await readOne(columns);
    expect(connection.problem).toContain(problem);
  });

  it("givenWindowsSignIn_whenRead_thenNoPasswordAndAWarning", async () => {
    const connection = await readOne({ connectionType: "mssql", windowsAuthEnabled: 1, password: "p" });
    expect(connection.password).toEqual({ kind: "none" });
    expect(connection.warnings).toContain(
      "Beekeeper signs in another way here; TableCraft signs in with a user and password.",
    );
  });

  it.each([
    ["the trust column on", { trustServerCertificate: 1 }, "trustServerCertificate=true"],
    ["the trust column off", { trustServerCertificate: 0 }, "trustServerCertificate=false"],
    [
      "all three files and checking",
      { ssl: 1, trustServerCertificate: 1, sslCaFile: "/ca", sslCertFile: "/c", sslKeyFile: "/k" },
      "trustServerCertificate=false;trustStore=/ca",
    ],
  ])("givenSqlServerWith%s_whenRead_thenTheUrlCarriesTheTrust", async (_label, columns, params) => {
    const connection = await readOne({
      connectionType: "sqlserver",
      host: "sql.test",
      port: 1433,
      defaultDatabase: "app",
      ...columns,
    });
    expect(connection.url).toBe(`jdbc:sqlserver://sql.test:1433;databaseName=app;${params}`);
    expect(connection.ssl).toBeNull();
  });

  it("givenOtherSqliteFile_whenRead_thenNotBeekeeper", async () => {
    const home = newHome();
    const path = join(home, "other.db");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE t (a integer)");
    database.close();
    await expect(readBeekeeperDatabase(nodeImportFiles, path, { secrets: true, home })).rejects.toBeInstanceOf(
      BeekeeperFormatError,
    );
  });
});

describe("Beekeeper Studio import", () => {
  it("givenInstall_whenScanned_thenCardCountsLocalConnections", async () => {
    const home = fixtureHome();
    const { importer } = await setup(home);
    const card = (await importer.scan()).find((source) => source.app === "beekeeper");
    expect(card).toEqual({
      app: "beekeeper",
      label: "Beekeeper Studio",
      found: true,
      count: LOCAL_CONNECTIONS,
      locations: [join(beekeeperDirectory(home, "darwin"), "app.db")],
      passwords: "In Beekeeper's app.db; TableCraft decrypts them on import",
    });
  });

  it("givenNoInstall_whenScanned_thenCardNamesWhereItLooked", async () => {
    const home = newHome();
    const { importer } = await setup(home, "linux");
    const card = (await importer.scan()).find((source) => source.app === "beekeeper");
    expect(card).toMatchObject({ found: false, count: 0 });
    expect(card?.locations).toContain(join(home, ".config", "beekeeper-studio"));
  });

  it("givenInstall_whenPreviewed_thenRowsSayWhatImports", async () => {
    const { importer } = await setup(fixtureHome());
    const { rows, topFolder } = ready(await importer.preview({ source: "beekeeper" }));
    expect(topFolder).toBe("Beekeeper Studio");
    expect(row(rows, "Shop MySQL")).toMatchObject({
      pluginId: "mysql",
      target: "mysql.test:3307/shop",
      password: "inFile",
      status: "ready",
    });
    expect(row(rows, "Reporting")).toMatchObject({ pluginId: "postgres", password: "inFile", status: "ready" });
    expect(row(rows, "Through bastion")).toMatchObject({ target: "10.0.0.5:3306 via bastion.test", status: "ready" });
    expect(row(rows, "Socket")).toMatchObject({ status: "unsupported", selected: false });
    expect(row(rows, "Mongo")).toMatchObject({ status: "unsupported", selected: false });
    expect(rows.some((candidate) => candidate.name === "Cloud only")).toBe(false);
  });

  it("givenInstall_whenImported_thenPasswordsTunnelSecretsAndFoldersLand", async () => {
    const { summary, service, datasource } = await importAll(fixtureHome());
    expect(summary).toMatchObject({ imported: 5, keychainDenied: false });
    expect(datasource("Shop MySQL")).toMatchObject({
      folder: "Production/EU",
      color: "red",
      origin: { app: "beekeeper", id: "1@2026-01-05 10:00:00" },
      storedSecrets: ["password"],
    });
    expect(datasource("Reporting")).toMatchObject({ readOnly: true, config: { sslMode: "require" } });
    expect(datasource("Through bastion").storedSecrets).toEqual(["password", "ssh.password"]);
    expect(datasource("Key tunnel")).toMatchObject({
      ssh: { auth: "key", keyPath: "/keys/deploy", host: "jump.test" },
      storedSecrets: ["ssh.passphrase"],
    });
    expect(service.list().folders).toEqual(expect.arrayContaining(["Archive", "Production", "Production/EU"]));
  });

  it("givenPasswordsOff_whenImported_thenNoSecretStored", async () => {
    const { datasource } = await importAll(fixtureHome(), false);
    expect(datasource("Shop MySQL").storedSecrets).toEqual([]);
    expect(datasource("Key tunnel").storedSecrets).toEqual([]);
  });

  it("givenImportedOnce_whenPreviewedAgain_thenRowsAreDuplicates", async () => {
    const { importer } = await importAll(fixtureHome());
    const { rows } = ready(await importer.preview({ source: "beekeeper" }));
    expect(row(rows, "Shop MySQL")).toMatchObject({ status: "duplicate", selected: false });
  });

  it("givenAppDbPicked_whenPreviewed_thenReadAsBeekeeper", async () => {
    const home = fixtureHome();
    const { importer } = await setup(newHome());
    const path = join(beekeeperDirectory(home, "darwin"), "app.db");
    const { app, rows } = ready(await importer.preview({ source: "file", path }));
    expect(app).toBe("beekeeper");
    expect(row(rows, "Shop MySQL").password).toBe("inFile");
    const skipped = ready(await importer.preview({ source: "file", path, skipSecrets: true }));
    expect(row(skipped.rows, "Shop MySQL").password).toBe("askOnConnect");
  });

  it("givenOtherSqliteFilePicked_whenPreviewed_thenSaysItIsNotBeekeepers", async () => {
    const home = newHome();
    const path = join(home, "notes.db");
    writeBeekeeperDatabase(path, { connections: [] });
    const database = new DatabaseSync(path);
    database.exec("DROP TABLE saved_connection");
    database.close();
    const { importer } = await setup(home);
    const preview = importer.preview({ source: "file", path });
    await expect(preview).rejects.toBeInstanceOf(DatasourceError);
    await expect(preview).rejects.toThrow("This SQLite file is not a Beekeeper Studio app.db.");
  });

  it("givenJumpHost_whenPreviewed_thenImportsWithoutTheTunnel", async () => {
    const home = newHome();
    writeBeekeeperFixture(home, "darwin", {
      connections: [
        {
          id: 1,
          name: "Deep",
          connectionType: "mysql",
          host: "10.0.0.9",
          sshEnabled: 1,
          sshHost: "inner.test",
          sshUsername: "deploy",
          sshBastionHost: "outer.test",
        },
      ],
    });
    const { rows } = ready(await (await setup(home)).importer.preview({ source: "beekeeper" }));
    expect(row(rows, "Deep")).toMatchObject({ status: "sshTunnel", target: "10.0.0.9:3306" });
    expect(row(rows, "Deep").warnings[0]).toContain("jump host outer.test");
  });

  it("givenRedisWithTls_whenImported_thenTlsModeRequire", async () => {
    const home = newHome();
    writeBeekeeperFixture(home, "darwin", {
      connections: [{ id: 1, name: "Cache", connectionType: "redis", host: "redis.test", port: 6380, ssl: 1 }],
    });
    const { datasource } = await importAll(home);
    expect(datasource("Cache").config).toMatchObject({ host: "redis.test", port: 6380, tlsMode: "require" });
  });

  it("givenSqlServerTrusting_whenImported_thenTrustServerCertificateOn", async () => {
    const home = newHome();
    writeBeekeeperFixture(home, "darwin", {
      connections: [
        {
          id: 1,
          name: "Warehouse",
          connectionType: "sqlserver",
          host: "sql.test",
          port: 1433,
          username: "sa",
          defaultDatabase: "dw",
          trustServerCertificate: 1,
        },
      ],
    });
    const { datasource } = await importAll(home);
    expect(datasource("Warehouse").config).toMatchObject({
      host: "sql.test",
      port: 1433,
      database: "dw",
      user: "sa",
      trustServerCertificate: true,
    });
  });

  it("givenInstall_whenScannedAndImported_thenBeekeepersFolderIsUntouched", async () => {
    const home = fixtureHome();
    const directory = beekeeperDirectory(home, "darwin");
    const before = readdirSync(directory).sort();
    const appDb = readFileSync(join(directory, "app.db"));
    await importAll(home);
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(readFileSync(join(directory, "app.db")).equals(appDb)).toBe(true);
  });
});
