import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openQueryHistory } from "@table-craft/core";
import { createConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import { createDatasourceStore } from "@table-craft/desktop/main/datasources.js";
import { createHostRegistry } from "@table-craft/desktop/main/hosts.js";
import { scanDataGrip } from "@table-craft/desktop/main/import/datagrip.js";
import { createImporter } from "@table-craft/desktop/main/import/importer.js";
import { chacha20, KdbxError, readKdbx, readMainKey, salsa20 } from "@table-craft/desktop/main/import/kdbx.js";
import {
  createCredentialReader,
  splitJoinedSecret,
  type CommandResult,
  type CredentialReader,
  type SecretLookup,
} from "@table-craft/desktop/main/import/keychain.js";
import { nodeImportFiles } from "@table-craft/desktop/main/import/nodeFiles.js";
import {
  parseTableProDefaults,
  readTableProBundle,
  TableProBundleError,
} from "@table-craft/desktop/main/import/tablepro.js";
import { mapConnection } from "@table-craft/desktop/main/import/mapping.js";
import type { ForeignConnection, ImportEnvironment } from "@table-craft/desktop/main/import/types.js";
import { listPlugins } from "@table-craft/desktop/main/plugins.js";
import { createSecretStore } from "@table-craft/desktop/main/secrets.js";
import { createDatasourceService } from "@table-craft/desktop/main/service.js";
import type { ImportPreview, ImportRow } from "@table-craft/desktop/preload/bridge.js";
import { fakeHostDependencies } from "../support/fakeHosts.js";
import {
  DATAGRIP_CONFIG,
  DATAGRIP_IDS,
  dataGripService,
  encryptTableProBundle,
  FOREIGN_DIALECT_SOURCES,
  writeImportFixture,
  writeKdbx,
  writeMainKey,
  type ImportFixture,
} from "../support/import/fixtures.js";
import { fakeCipher, memoryFiles } from "../support/memoryFiles.js";

const BUILT_IN_PLUGINS = join(import.meta.dirname, "../../plugins");
const PROFILE = "/profile";
const SECRET = "fixture-secret-9431";
const MYSQL = { host: "mysql.test", port: 3307 };
const POSTGRES = { host: "pg.test", port: 5433 };

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(
  options: { passwords?: "keepass" | "native"; platform?: NodeJS.Platform; oracleAndSqlServer?: boolean } = {},
): ImportFixture {
  const home = mkdtempSync(join(tmpdir(), "tc-import-"));
  homes.push(home);
  return writeImportFixture(home, {
    mysql: MYSQL,
    postgres: POSTGRES,
    passwords: options.passwords ?? "native",
    platform: options.platform ?? "darwin",
    password: SECRET,
    oracleAndSqlServer: options.oracleAndSqlServer,
  });
}

function environment(home: string, platform: NodeJS.Platform = "darwin"): ImportEnvironment {
  return { platform, home, appData: null, files: nodeImportFiles };
}

/** A keychain that answers from a map, counting each lookup; `deny` answers Deny once. */
function fakeCredentials(passwords: ReadonlyMap<string, string>, deny: ReadonlySet<string> = new Set()) {
  const asked: string[] = [];
  const reader: CredentialReader = {
    available: true,
    label: "macOS Keychain",
    lookup(service) {
      asked.push(service);
      const value = passwords.get(service);
      const lookup: SecretLookup = deny.has(service)
        ? { status: "denied" }
        : value === undefined
          ? { status: "notFound" }
          : { status: "found", value };
      return Promise.resolve(lookup);
    },
  };
  return { reader, asked };
}

async function setup(
  home: string,
  credentials: CredentialReader,
  platform: NodeJS.Platform = "darwin",
  absent: readonly string[] = [],
) {
  const files = memoryFiles();
  const cipher = fakeCipher();
  let ids = 0;
  const plugins = (await listPlugins([BUILT_IN_PLUGINS])).filter((plugin) => !absent.includes(plugin.id));
  const service = await createDatasourceService({
    store: createDatasourceStore({ directory: PROFILE, files }),
    secrets: await createSecretStore({ directory: PROFILE, files, cipher }),
    hosts: createHostRegistry({ pluginRoots: () => [], dependencies: fakeHostDependencies(), onExit: () => undefined }),
    plugins: () => plugins,
    ephemeral: null,
    newId: () => `id-${String(++ids)}`,
    consoles: createConsoleFiles({ directory: PROFILE, files }),
    history: openQueryHistory(":memory:"),
    onChanged: () => undefined,
  });
  const logs: unknown[] = [];
  const log = {
    info: (...args: unknown[]) => logs.push(args),
    warn: (...args: unknown[]) => logs.push(args),
  };
  const importer = createImporter({
    environment: environment(home, platform),
    credentials,
    tableProGroups: () => Promise.resolve([]),
    service,
    log,
  });
  return { files, service, importer, logs };
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

function selected(rows: readonly ImportRow[]): string[] {
  return rows.filter((candidate) => candidate.selected).map((candidate) => candidate.key);
}

describe("DataGrip reader", () => {
  it("givenDataGripProject_whenScanned_thenLocalFieldsWin", async () => {
    const { home, configDir, project } = fixture();

    const scan = await scanDataGrip(environment(home));

    expect(scan.configDir).toBe(configDir);
    expect(scan.projects).toBe(1);
    expect(scan.connections).toHaveLength(7);
    const shop = scan.connections.find((connection) => connection.id === DATAGRIP_IDS.shopMysql);
    expect(shop).toMatchObject({ name: "Shop MySQL", user: "table_craft", folder: "Docker", driver: "mysql.8" });
    expect(shop?.password).toEqual({
      kind: "store",
      service: dataGripService(DATAGRIP_IDS.shopMysql),
      user: "table_craft",
    });
    const file = scan.connections.find((connection) => connection.id === DATAGRIP_IDS.localFile);
    expect(file).toMatchObject({
      url: `jdbc:sqlite:${project}/data/app.db`,
      folder: "shop",
      password: { kind: "none" },
    });
    expect(scan.connections.find((connection) => connection.id === DATAGRIP_IDS.global)?.folder).toBeNull();
    expect(scan.passwordStore).toEqual({ kind: "native" });
  });

  it("givenNoDataGrip_whenScanned_thenReportsWhereItLooked", async () => {
    const home = mkdtempSync(join(tmpdir(), "tc-import-"));
    homes.push(home);

    const scan = await scanDataGrip(environment(home, "linux"));

    expect(scan.configDir).toBeNull();
    expect(scan.looked).toEqual([join(home, ".config", "JetBrains", "DataGrip*")]);
  });

  it("givenLinuxLayout_whenScanned_thenReadsConfigUnderDotConfig", async () => {
    const { home } = fixture({ platform: "linux" });

    const scan = await scanDataGrip(environment(home, "linux"));

    expect(scan.configDir).toBe(join(home, ".config", "JetBrains", DATAGRIP_CONFIG));
    expect(scan.connections).toHaveLength(7);
  });
});

describe("KeePass reader", () => {
  it("givenIntellijMainKey_whenRead_thenOpensTheDatabase", () => {
    const mainKey = Buffer.from("a main key of sixty-four bytes, as IntelliJ generates one.......", "utf8");
    const database = writeKdbx([{ title: "IntelliJ Platform DB \u2014 x", user: "u", password: SECRET }], mainKey);

    const entries = readKdbx(database, readMainKey(writeMainKey(mainKey)));

    expect(entries).toEqual([{ title: "IntelliJ Platform DB \u2014 x", user: "u", password: SECRET }]);
  });

  it("givenWrongMainKey_whenRead_thenWrongKeyError", () => {
    const database = writeKdbx([{ title: "t", user: "u", password: SECRET }], Buffer.from("right"));

    expect(() => readKdbx(database, Buffer.from("wrong"))).toThrow(
      expect.objectContaining({ name: KdbxError.name, problem: "wrongKey" }),
    );
  });

  it("givenNonBuiltInMainKey_whenRead_thenUnsupported", () => {
    expect(() => readMainKey("encryption: CRYPT_32\nvalue: !!binary AAAA\n")).toThrow(
      expect.objectContaining({ problem: "unsupported" }),
    );
  });

  it("givenEcryptSet1Vector0_whenSalsa20_thenMatchesPublishedKeystream", () => {
    const key = Buffer.alloc(32);
    key[0] = 0x80;

    const stream = salsa20(key, Buffer.alloc(8))(64);

    expect(stream.toString("hex").toUpperCase()).toBe(
      "E3BE8FDD8BECA2E3EA8EF9475B29A6E7003951E1097A5C38D23B7A5FAD9F6844" +
        "B22C97559E2723C7CBBD3FE4FC8D9A0744652A83E72A9C461876AF4D7EF1A117",
    );
  });

  it("givenRfc8439BlockVector_whenChaCha20_thenSecondBlockMatches", () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const nonce = Buffer.from("000000090000004a00000000", "hex");

    const stream = chacha20(key, nonce)(128);

    expect(stream.subarray(64).toString("hex")).toBe(
      "10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e" +
        "d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e",
    );
  });
});

describe("TablePro reader", () => {
  it("givenEncryptedBundle_whenWrongPassphrase_thenTypedError", async () => {
    const bytes = encryptTableProBundle(JSON.stringify({ formatVersion: 2, connections: [] }), "right");

    await expect(readTableProBundle(bytes, "wrong", "x.tablepro")).rejects.toMatchObject({
      name: TableProBundleError.name,
      problem: "wrongPassphrase",
    });
    await expect(readTableProBundle(bytes, null, "x.tablepro")).rejects.toMatchObject({ problem: "needsPassphrase" });
  });

  it("givenVersion1Bundle_whenRead_thenGroupsByNameAndCredentialsByIndex", async () => {
    const bundle = {
      formatVersion: 1,
      connections: [
        { name: "A", type: "MySQL", host: "a", port: 3306, database: "d", username: "u", groupName: "Team" },
        { name: "B", type: "MySQL", host: "b", port: 3306, database: "d", username: "u" },
      ],
      groups: [{ name: "Team" }],
      credentials: { "1": { password: SECRET } },
    };

    const connections = await readTableProBundle(Buffer.from(JSON.stringify(bundle)), null, "old.tablepro");

    expect(connections.map(({ folder, password }) => ({ folder, password }))).toEqual([
      { folder: "Team", password: { kind: "none" } },
      { folder: null, password: { kind: "bundle", value: SECRET } },
    ]);
  });

  it("givenExportedDefaults_whenParsed_thenGroupsFromDataKey", () => {
    const groups = [
      { id: "g1", name: "Work", color: "Blue" },
      { id: "g2", name: "Shop", parentId: "g1" },
    ];
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "<key>other</key><string>x</string>",
      `<key>com.TablePro.groups</key><data>${Buffer.from(JSON.stringify(groups)).toString("base64")}</data>`,
      "</dict></plist>",
    ].join("\n");

    expect(parseTableProDefaults(plist)).toEqual([
      { id: "g1", name: "Work", parentId: null },
      { id: "g2", name: "Shop", parentId: "g1" },
    ]);
  });
});

describe("credential readers", () => {
  function runner(result: Partial<CommandResult>) {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run = (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return Promise.resolve({ code: 0, stdout: "", stderr: "", startError: null, ...result });
    };
    return { run, calls };
  }

  it("givenMacOs_whenLookedUp_thenRunsSecurityWithoutShell", async () => {
    const { run, calls } = runner({ stdout: "keychain: attributes\n", stderr: `password: "${SECRET}"\n` });
    const reader = createCredentialReader({ platform: "darwin", run, keychains: ["/tmp/test.keychain-db"] });

    expect(await reader.lookup("svc")).toEqual({ status: "found", value: SECRET });
    expect(calls).toEqual([
      {
        file: "/usr/bin/security",
        args: ["find-generic-password", "-s", "svc", "-g", "/tmp/test.keychain-db"],
      },
    ]);
  });

  it("givenNonAsciiPassword_whenSecurityPrintsHex_thenDecodesUtf8", async () => {
    const stderr = 'password: 0x70407373207722C3B65C7264  "p@ss w"\\303\\266\\134rd"\n';
    const reader = createCredentialReader({ platform: "darwin", run: runner({ stderr }).run });

    expect(await reader.lookup("svc")).toEqual({ status: "found", value: 'p@ss w"\u00f6\\rd' });
  });

  it.each([
    [44, "notFound"],
    [128, "denied"],
    [51, "denied"],
    [36, "locked"],
  ] as const)("givenSecurityExit%i_whenLookedUp_then%s", async (code, status) => {
    const reader = createCredentialReader({ platform: "darwin", run: runner({ code }).run });

    expect((await reader.lookup("svc")).status).toBe(status);
  });

  it("givenSecretServiceJoinedData_whenLookedUp_thenPasswordAfterFirstUnescapedAt", async () => {
    const { run, calls } = runner({ stdout: `me\\@corp@${SECRET}@x` });
    const reader = createCredentialReader({ platform: "linux", run });

    expect(await reader.lookup("svc")).toEqual({ status: "found", value: `${SECRET}@x` });
    expect(calls[0]).toEqual({ file: "secret-tool", args: ["lookup", "service", "svc"] });
    expect(splitJoinedSecret("a\\\\b@p")).toEqual({ user: "a\\b", password: "p" });
  });

  it("givenNoSecretTool_whenLookedUp_thenLockedWithInstallHint", async () => {
    const reader = createCredentialReader({ platform: "linux", run: runner({ code: null, startError: "ENOENT" }).run });

    const lookup = await reader.lookup("svc");

    expect(lookup.status === "locked" ? lookup.reason : "").toContain("libsecret");
  });
});

describe("importer", () => {
  it("givenTidbDriverRef_whenMapped_thenMysqlPlugin", async () => {
    const { home } = fixture();
    const { importer } = await setup(home, fakeCredentials(new Map()).reader);

    const { rows } = ready(await importer.preview({ source: "datagrip" }));

    expect(row(rows, "Analytics TiDB")).toMatchObject({
      pluginId: "mysql",
      target: "tidb.internal:4000/analytics",
      user: "root",
      status: "ready",
      password: "keychain",
    });
    expect(row(rows, "Local file")).toMatchObject({ pluginId: "sqlite", password: "notNeeded", status: "ready" });
  });

  it("givenUnknownScheme_whenMapped_thenUnsupported", async () => {
    const { home } = fixture();
    const { importer } = await setup(home, fakeCredentials(new Map()).reader);

    const { rows } = ready(await importer.preview({ source: "datagrip" }));

    expect(row(rows, "Events")).toMatchObject({ pluginId: null, status: "unsupported", selected: false });
    expect(row(rows, "Events").warnings[0]).toContain("mongodb");
  });

  it("givenPostgresNotInstalled_whenMapped_thenUnsupportedRowNamesTheDownloadablePlugin", async () => {
    const { home } = fixture();
    const { importer } = await setup(home, fakeCredentials(new Map()).reader, "darwin", ["postgres"]);

    const { rows } = ready(await importer.preview({ source: "datagrip" }));

    expect(row(rows, "Shop PG")).toMatchObject({
      pluginId: "postgres",
      status: "unsupported",
      selected: false,
      warnings: ["No installed plugin reads postgresql: URLs."],
    });
  });

  it("givenDataGripOracleAndSqlServer_whenImported_thenSchemesMapped", async () => {
    const { home } = fixture({ oracleAndSqlServer: true });
    const { importer } = await setup(home, fakeCredentials(new Map()).reader);

    const { rows } = ready(await importer.preview({ source: "datagrip" }));

    expect(row(rows, FOREIGN_DIALECT_SOURCES.oracle)).toMatchObject({
      pluginId: "oracle",
      pluginName: "Oracle",
      status: "ready",
      selected: true,
      warnings: [],
    });
    expect(row(rows, FOREIGN_DIALECT_SOURCES.sqlServer)).toMatchObject({
      pluginId: null,
      pluginName: "sqlserver.ms",
      status: "unsupported",
      warnings: ["No installed plugin reads sqlserver: URLs."],
    });
  });

  it.each([
    ["Oracle", "oracle"],
    ["SQL Server", "sqlserver"],
    ["MSSQL", "sqlserver"],
    ["Azure", "sqlserver"],
  ])("givenTableProType%s_whenMapped_thenScheme", (driver, scheme) => {
    const connection: ForeignConnection = {
      app: "tablepro",
      id: driver,
      name: driver,
      folder: null,
      driver,
      url: null,
      host: "db.internal",
      port: null,
      database: null,
      user: null,
      path: null,
      ssh: null,
      ssl: null,
      color: null,
      comment: "",
      readOnly: false,
      password: { kind: "none" },
    };

    const mapped = mapConnection(connection, { plugins: [], existing: [], availability: () => "none" });

    expect(mapped.row.warnings).toEqual([`No installed plugin reads ${scheme}: URLs.`]);
  });

  it("givenSsh_whenMapped_thenWarnedAndUnticked", async () => {
    const { home } = fixture();
    const { importer } = await setup(home, fakeCredentials(new Map()).reader);

    const { rows } = ready(await importer.preview({ source: "datagrip" }));

    expect(row(rows, "Prod via bastion")).toMatchObject({ status: "sshTunnel", selected: false });
    expect(row(rows, "Prod via bastion").warnings[0]).toBe(
      "SSH tunnel through bastion.example:22 was not imported; TableCraft has no SSH tunnels yet.",
    );
  });

  it("givenKeePass_whenImported_thenPasswordsSavedWithoutAskingTheKeychain", async () => {
    const { home } = fixture({ passwords: "keepass" });
    const { reader, asked } = fakeCredentials(new Map());
    const { importer, service } = await setup(home, reader);
    const preview = ready(await importer.preview({ source: "datagrip" }));
    expect(row(preview.rows, "Shop MySQL").password).toBe("found");
    expect(row(preview.rows, "Analytics TiDB").password).toBe("notSaved");

    const summary = await importer.run(
      { previewId: preview.previewId, keys: selected(preview.rows), importPasswords: true, topFolder: true },
      () => undefined,
    );

    expect(asked).toEqual([]);
    expect(summary).toMatchObject({ imported: 5, withPasswords: 3, skipped: 0, cancelled: false });
    const list = service.list().datasources;
    const shop = list.find((datasource) => datasource.name === "Shop MySQL");
    expect(shop).toMatchObject({
      folder: "DataGrip/Docker",
      pluginId: "mysql",
      config: { host: MYSQL.host, port: MYSQL.port, user: "table_craft" },
      origin: { app: "datagrip", id: DATAGRIP_IDS.shopMysql },
      storedSecrets: ["password"],
    });
    expect(list.find((datasource) => datasource.name === "Global PG")?.folder).toBe("DataGrip");
  });

  it("givenKeychainDenied_whenImporting_thenStopsAskingAndImportsRest", async () => {
    const { home } = fixture();
    const passwords = new Map([
      [dataGripService(DATAGRIP_IDS.shopMysql), SECRET],
      [dataGripService(DATAGRIP_IDS.shopPostgres), SECRET],
    ]);
    const { reader, asked } = fakeCredentials(passwords, new Set([dataGripService(DATAGRIP_IDS.shopMysql)]));
    const { importer, service } = await setup(home, reader);
    const preview = ready(await importer.preview({ source: "datagrip" }));
    const keys = [
      row(preview.rows, "Shop MySQL").key,
      row(preview.rows, "Shop PG").key,
      row(preview.rows, "Global PG").key,
    ];
    const messages: string[] = [];

    const summary = await importer.run(
      { previewId: preview.previewId, keys, importPasswords: true, topFolder: false },
      (progress) => messages.push(progress.message),
    );

    expect(asked).toEqual([dataGripService(DATAGRIP_IDS.shopMysql)]);
    expect(summary).toMatchObject({ imported: 3, withPasswords: 0, keychainDenied: true });
    expect(messages[0]).toBe("Reading macOS Keychain 1 of 3… the system may ask; click Allow.");
    expect(service.list().datasources.every((datasource) => datasource.storedSecrets.length === 0)).toBe(true);
  });

  it("givenImportPasswordsOff_whenImporting_thenKeychainNeverAsked", async () => {
    const { home } = fixture();
    const { reader, asked } = fakeCredentials(new Map([[dataGripService(DATAGRIP_IDS.shopMysql), SECRET]]));
    const { importer } = await setup(home, reader);
    const preview = ready(await importer.preview({ source: "datagrip" }));

    await importer.run(
      { previewId: preview.previewId, keys: selected(preview.rows), importPasswords: false, topFolder: true },
      () => undefined,
    );

    expect(asked).toEqual([]);
  });

  it("givenSameOrigin_whenReimported_thenUnticked", async () => {
    const { home } = fixture();
    const { importer, service } = await setup(home, fakeCredentials(new Map()).reader);
    const first = ready(await importer.preview({ source: "datagrip" }));
    await importer.run(
      { previewId: first.previewId, keys: selected(first.rows), importPasswords: false, topFolder: true },
      () => undefined,
    );

    const second = ready(await importer.preview({ source: "datagrip" }));

    expect(row(second.rows, "Shop MySQL")).toMatchObject({ status: "duplicate", selected: false });
    expect(selected(second.rows)).toEqual([]);
    const summary = await importer.run(
      {
        previewId: second.previewId,
        keys: [row(second.rows, "Shop MySQL").key],
        importPasswords: false,
        topFolder: true,
      },
      () => undefined,
    );
    expect(summary.imported).toBe(1);
    expect(
      service
        .list()
        .datasources.filter((datasource) => datasource.name.startsWith("Shop MySQL"))
        .map((d) => d.name),
    ).toEqual(["Shop MySQL", "Shop MySQL (2)"]);
  });

  it("givenStalePreview_whenRun_thenTypedError", async () => {
    const { home } = fixture();
    const { importer } = await setup(home, fakeCredentials(new Map()).reader);
    const first = ready(await importer.preview({ source: "datagrip" }));
    ready(await importer.preview({ source: "datagrip" }));

    await expect(
      importer.run({ previewId: first.previewId, keys: [], importPasswords: false, topFolder: true }, () => undefined),
    ).rejects.toMatchObject({ name: "DatasourceError" });
  });

  it("givenCancel_whenImporting_thenStopsBetweenItems", async () => {
    const { home } = fixture();
    const { importer } = await setup(home, fakeCredentials(new Map()).reader);
    const preview = ready(await importer.preview({ source: "datagrip" }));
    const keys = selected(preview.rows);

    const summary = await importer.run(
      { previewId: preview.previewId, keys, importPasswords: false, topFolder: true },
      (progress) => {
        if (progress.done === 1) importer.cancel();
      },
    );

    expect(summary).toMatchObject({ imported: 1, skipped: keys.length - 1, cancelled: true });
  });

  it("givenTableProConnections_whenPreviewed_thenMappedWithColoursAndSsl", async () => {
    const { home } = fixture();
    const { importer, service } = await setup(home, fakeCredentials(new Map()).reader);

    const preview = ready(await importer.preview({ source: "tablepro" }));

    expect(row(preview.rows, "Orders MySQL")).toMatchObject({
      pluginId: "mysql",
      password: "askOnConnect",
      status: "ready",
    });
    expect(row(preview.rows, "Reports PG").warnings).toEqual([expect.stringContaining("Preferred")]);
    expect(row(preview.rows, "Cache")).toMatchObject({ status: "unsupported" });
    await importer.run(
      { previewId: preview.previewId, keys: selected(preview.rows), importPasswords: true, topFolder: false },
      () => undefined,
    );
    const orders = service.list().datasources.find((datasource) => datasource.name === "Orders MySQL");
    expect(orders).toMatchObject({
      color: "violet",
      folder: null,
      storedSecrets: [],
      config: { sslMode: "disable" },
    });
    expect(service.list().datasources.find((datasource) => datasource.name === "Reports PG")?.config).toMatchObject({
      sslMode: "require",
    });
  });

  it("givenEncryptedBundleFile_whenPreviewed_thenAsksPassphraseThenImportsPasswords", async () => {
    const { home, encryptedBundle, bundlePassphrase } = fixture();
    const { importer, service } = await setup(home, fakeCredentials(new Map()).reader);

    expect(await importer.preview({ source: "file", path: encryptedBundle })).toMatchObject({
      status: "needsPassphrase",
    });
    expect(await importer.preview({ source: "file", path: encryptedBundle, passphrase: "nope" })).toMatchObject({
      status: "wrongPassphrase",
    });
    const preview = ready(
      await importer.preview({ source: "file", path: encryptedBundle, passphrase: bundlePassphrase }),
    );

    expect(row(preview.rows, "Orders MySQL")).toMatchObject({ folder: "Work/Shop", password: "inFile" });
    expect(row(preview.rows, "Notes")).toMatchObject({ pluginId: "sqlite", target: join(home, "notes.db") });
    const summary = await importer.run(
      { previewId: preview.previewId, keys: selected(preview.rows), importPasswords: true, topFolder: true },
      () => undefined,
    );
    expect(summary).toMatchObject({ imported: 3, withPasswords: 2 });
    expect(service.list().datasources.find((datasource) => datasource.name === "Orders MySQL")?.folder).toBe(
      "TablePro/Work/Shop",
    );
  });

  it("givenDataSourcesXmlFile_whenPreviewed_thenReadsWithLocalFile", async () => {
    const { home, project } = fixture();
    const { importer } = await setup(home, fakeCredentials(new Map()).reader);

    const preview = ready(await importer.preview({ source: "file", path: join(project, ".idea", "dataSources.xml") }));

    expect(preview.app).toBe("datagrip");
    expect(row(preview.rows, "Shop MySQL").user).toBe("table_craft");
  });

  it("givenPasswords_whenPreviewedAndImported_thenNoSecretInPayloadOrLog", async () => {
    const { home, encryptedBundle, bundlePassphrase } = fixture({ passwords: "keepass" });
    const { importer, logs, files } = await setup(home, fakeCredentials(new Map()).reader);

    const dataGrip = ready(await importer.preview({ source: "datagrip" }));
    await importer.run(
      { previewId: dataGrip.previewId, keys: selected(dataGrip.rows), importPasswords: true, topFolder: true },
      () => undefined,
    );
    const bundle = ready(
      await importer.preview({ source: "file", path: encryptedBundle, passphrase: bundlePassphrase }),
    );
    await importer.run(
      { previewId: bundle.previewId, keys: selected(bundle.rows), importPasswords: true, topFolder: true },
      () => undefined,
    );

    const visible = JSON.stringify([
      dataGrip,
      bundle,
      logs,
      [...files.contents.entries()].filter(([path]) => path.endsWith("datasources.json")),
    ]);
    expect(visible).not.toContain(SECRET);
    expect(visible).not.toContain(bundlePassphrase);
    expect(JSON.stringify(logs)).not.toContain(MYSQL.host);
  });
});
