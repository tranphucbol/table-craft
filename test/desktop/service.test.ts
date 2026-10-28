import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openQueryHistory } from "@table-craft/core";
import { createConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import { createDatasourceStore, DATASOURCES_FILE } from "@table-craft/desktop/main/datasources.js";
import { createHostRegistry } from "@table-craft/desktop/main/hosts.js";
import { listPlugins } from "@table-craft/desktop/main/plugins.js";
import { createSecretStore } from "@table-craft/desktop/main/secrets.js";
import {
  createDatasourceService,
  DatasourceError,
  type EphemeralDatasource,
} from "@table-craft/desktop/main/service.js";
import type { DatasourceDraft, DatasourceList, SaveDatasourceRequest } from "@table-craft/desktop/preload/bridge.js";
import { fakeHostDependencies } from "../support/fakeHosts.js";
import { fakeCipher, memoryFiles } from "../support/memoryFiles.js";

const DIRECTORY = "/profile";
const BUILT_IN_PLUGINS = join(import.meta.dirname, "../../plugins");
const SECRET = "hunter2";
const WINDOW = "window-1";

const PG_DRAFT: DatasourceDraft = {
  name: "Local PG",
  pluginId: "postgres",
  folder: "Docker/Main",
  color: null,
  readOnly: false,
  comment: "",
  config: { host: "127.0.0.1", port: 55432, database: "table_craft", user: "table_craft", sslMode: "disable" },
  secretModes: { password: "forever" },
};

async function service(
  options: {
    ephemeral?: EphemeralDatasource;
    cipher?: ReturnType<typeof fakeCipher>;
    keyFiles?: Readonly<Record<string, string>>;
  } = {},
) {
  const files = memoryFiles();
  const cipher = options.cipher ?? fakeCipher();
  const dependencies = fakeHostDependencies();
  const changes: DatasourceList[] = [];
  let ids = 0;
  const hosts = createHostRegistry({ pluginRoots: () => [], dependencies, onExit: () => undefined });
  const history = openQueryHistory(":memory:");
  const plugins = await listPlugins([BUILT_IN_PLUGINS]);
  const created = await createDatasourceService({
    store: createDatasourceStore({ directory: DIRECTORY, files }),
    secrets: await createSecretStore({ directory: DIRECTORY, files, cipher }),
    hosts,
    plugins: () => plugins,
    ephemeral: options.ephemeral ?? null,
    newId: () => `id-${String(++ids)}`,
    consoles: createConsoleFiles({ directory: DIRECTORY, files }),
    history,
    onChanged: (list) => changes.push(list),
    readKeyFile: (path) => Promise.resolve(options.keyFiles?.[path] ?? null),
  });
  return { files, cipher, dependencies, changes, history, service: created };
}

function saving(datasource: DatasourceDraft, password?: string): SaveDatasourceRequest {
  return {
    datasource,
    secrets: password === undefined ? {} : { password: { action: "set", value: password } },
  };
}

function bootedConfig(dependencies: ReturnType<typeof fakeHostDependencies>, index = 0): unknown {
  return (dependencies.forked[index]?.posted[0] as { datasource?: unknown } | undefined)?.datasource;
}

describe("listPlugins", () => {
  it("givenBuiltInPluginSources_whenListed_thenFormsReadWithoutRunningCode", async () => {
    const plugins = await listPlugins([BUILT_IN_PLUGINS]);

    expect(plugins.map((plugin) => plugin.id).sort()).toEqual(["mysql", "oracle", "postgres", "redis", "sqlite"]);
    expect(plugins.find((plugin) => plugin.id === "sqlite")?.fields).toEqual([
      expect.objectContaining({ key: "path", kind: "file" }),
    ]);
    expect(plugins.every((plugin) => plugin.unavailableReason === null)).toBe(true);
  });
});

describe("datasource service", () => {
  it("givenForeverSecret_whenSaved_thenDatasourcesJsonHasNoSecretValue", async () => {
    const { files, service: datasources } = await service();

    const saved = await datasources.save(saving(PG_DRAFT, SECRET));

    const json = files.contents.get(`${DIRECTORY}/${DATASOURCES_FILE}`) ?? "";
    expect(json).not.toContain(SECRET);
    expect(JSON.parse(json)).toMatchObject({ datasources: [{ id: saved.id, secretModes: { password: "forever" } }] });
    expect(saved.storedSecrets).toEqual(["password"]);
    expect(JSON.stringify(datasources.list())).not.toContain(SECRET);
  });

  it("givenEncryptionUnavailable_whenSavingForever_thenRefusedWithReason", async () => {
    const cipher = fakeCipher();
    cipher.available = false;
    const { files, service: datasources } = await service({ cipher });

    await expect(datasources.save(saving(PG_DRAFT, SECRET))).rejects.toThrow(DatasourceError);
    await expect(datasources.save(saving(PG_DRAFT, SECRET))).rejects.toThrow("keychain");
    expect(files.contents.size).toBe(0);
  });

  it("givenEncryptionUnavailable_whenSecretModeOmitted_thenDefaultsToUntilRestart", async () => {
    const cipher = fakeCipher();
    cipher.available = false;
    const { service: datasources } = await service({ cipher });

    const saved = await datasources.save(saving({ ...PG_DRAFT, secretModes: {} }, SECRET));

    expect(saved.secretModes).toEqual({ password: "untilRestart" });
  });

  it("givenBlankSecretOnEdit_whenSaved_thenStoredSecretKept", async () => {
    const { dependencies, service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT, SECRET));

    await datasources.save({ datasource: { ...saved, name: "Renamed" }, secrets: { password: { action: "keep" } } });
    await datasources.connect(saved.id, {}, WINDOW);

    expect(datasources.list().datasources[0]?.name).toBe("Renamed");
    expect(bootedConfig(dependencies)).toMatchObject({ config: { password: SECRET } });
  });

  it("givenClearedSecret_whenSaved_thenNoLongerStored", async () => {
    const { service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT, SECRET));

    const cleared = await datasources.save({ datasource: saved, secrets: { password: { action: "clear" } } });

    expect(cleared.storedSecrets).toEqual([]);
  });

  it("givenNeverSecret_whenConnecting_thenNeedsSecretsReturned", async () => {
    const { dependencies, service: datasources } = await service();
    const saved = await datasources.save(saving({ ...PG_DRAFT, secretModes: { password: "never" } }, SECRET));

    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({ status: "needsSecrets", keys: ["password"] });
    expect(dependencies.forked).toHaveLength(0);

    expect(await datasources.connect(saved.id, { password: SECRET }, WINDOW)).toEqual({ status: "connected" });
    expect(bootedConfig(dependencies)).toMatchObject({ config: { password: SECRET } });
  });

  it("givenNeverSecretAndRunningEngine_whenSecondConsoleConnects_thenNotAskedAgain", async () => {
    const { dependencies, service: datasources } = await service();
    const saved = await datasources.save(saving({ ...PG_DRAFT, secretModes: { password: "never" } }));
    await datasources.connect(saved.id, { password: SECRET }, WINDOW);

    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({ status: "connected" });
    expect(dependencies.ports).toHaveLength(2);
  });

  it("givenKeychainLost_whenConnecting_thenAskedLikeNever", async () => {
    const { cipher, service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT, SECRET));
    cipher.lost = true;

    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({ status: "needsSecrets", keys: ["password"] });
  });

  it("givenReadOnlyDatasource_whenConnected_thenEngineBootsReadOnly", async () => {
    const { dependencies, service: datasources } = await service();
    const saved = await datasources.save(saving({ ...PG_DRAFT, readOnly: true }, SECRET));

    await datasources.connect(saved.id, {}, WINDOW);

    expect(bootedConfig(dependencies)).toMatchObject({ readOnly: true });
  });

  it("givenKeepAliveAndTimeout_whenSavedAndConnected_thenStoredAndKeepAliveBooted", async () => {
    const { files, dependencies, service: datasources } = await service();
    const saved = await datasources.save(
      saving({ ...PG_DRAFT, keepAliveSeconds: 0, statementTimeoutSeconds: 45 }, SECRET),
    );

    await datasources.connect(saved.id, {}, WINDOW);

    expect(JSON.parse(files.contents.get(`${DIRECTORY}/${DATASOURCES_FILE}`) ?? "")).toMatchObject({
      datasources: [{ keepAliveSeconds: 0, statementTimeoutSeconds: 45 }],
    });
    expect(bootedConfig(dependencies)).toMatchObject({ keepAliveSeconds: 0 });
  });

  it("givenNoKeepAlive_whenConnected_thenDefaultBooted", async () => {
    const { dependencies, service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT, SECRET));

    await datasources.connect(saved.id, {}, WINDOW);

    expect(bootedConfig(dependencies)).toMatchObject({ keepAliveSeconds: 30 });
  });

  it("givenPastedUrl_whenParsed_thenFieldsAndPasswordReturnedAndNothingSaved", async () => {
    const { files, service: datasources } = await service();

    const parsed = datasources.parseUrl("postgres", `postgresql://alice:${SECRET}@db:6543/sales?sslmode=require`);

    expect(parsed).toEqual({
      values: { host: "db", port: 6543, database: "sales", user: "alice", sslMode: "require" },
      secrets: { password: SECRET },
      ignored: [],
    });
    expect(files.contents.size).toBe(0);
  });

  it("givenBadUrl_whenParsed_thenDatasourceErrorWithHint", async () => {
    const { service: datasources } = await service();

    expect(() => datasources.parseUrl("postgres", "mysql://h/db")).toThrow(DatasourceError);
  });

  it("givenSavedDatasourceWithSecret_whenCopiedAsUrl_thenNoPassword", async () => {
    const { service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT, SECRET));

    const url = datasources.url(saved.id);

    expect(url).toBe("postgresql://table_craft@127.0.0.1:55432/table_craft");
    expect(url).not.toContain(SECRET);
  });

  it("givenEditedDatasourceWithBlankSecret_whenTested_thenStoredSecretMergedInMain", async () => {
    const { dependencies, service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT, SECRET));

    void datasources.test({ datasource: saved, secrets: {} });

    expect(bootedConfig(dependencies)).toMatchObject({ config: { password: SECRET } });
    expect(dependencies.forked[0]?.posted[0]).toMatchObject({ mode: "probe" });
  });

  it("givenRequiredFieldBlank_whenSaved_thenRefusedNamingIt", async () => {
    const { service: datasources } = await service();

    await expect(datasources.save(saving({ ...PG_DRAFT, config: { ...PG_DRAFT.config, user: "" } }))).rejects.toThrow(
      "User is required.",
    );
  });

  it("givenClusterModeWithoutDatabase_whenSaved_thenSavedSinceTheFormHidesDatabase", async () => {
    const { service: datasources } = await service();
    const cluster: DatasourceDraft = {
      ...PG_DRAFT,
      name: "Cache",
      pluginId: "redis",
      config: { mode: "cluster", host: "127.0.0.1", port: 7001 },
    };

    await expect(datasources.save(saving(cluster))).resolves.toMatchObject({ name: "Cache" });
    await expect(
      datasources.save(saving({ ...cluster, config: { mode: "standalone", host: "127.0.0.1", port: 6379 } })),
    ).rejects.toThrow("Database is required.");
  });

  it("givenConnectedDatasource_whenDeleted_thenEngineStoppedSecretsClearedAndBroadcast", async () => {
    const { dependencies, changes, service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT, SECRET));
    await datasources.connect(saved.id, {}, WINDOW);

    const deleting = datasources.delete(saved.id);
    dependencies.forked[0]?.exit(0);
    await deleting;

    expect(datasources.list().datasources).toEqual([]);
    expect(changes.at(-1)?.datasources).toEqual([]);
  });

  it("givenDatasourceWithConsoles_whenDeleted_thenItsConsoleDirectoryIsRemoved", async () => {
    const { files, service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT));
    const consoles = createConsoleFiles({ directory: DIRECTORY, files });
    await consoles.write(saved.id, "console", "SELECT 1");
    await consoles.write("other", "console", "SELECT 2");

    await datasources.delete(saved.id);

    expect(await consoles.list(saved.id)).toEqual([]);
    expect(await consoles.list("other")).toEqual(["console"]);
  });

  it("givenDatasourceDeleted_whenSearched_thenEmpty", async () => {
    const { history, service: datasources } = await service();
    const saved = await datasources.save(saving(PG_DRAFT));
    const run = {
      sql: "SELECT 1",
      startedAt: 1,
      durationMs: 2,
      outcome: "success",
      rowCount: 1,
      message: null,
      source: "console",
    } as const;
    history.record({ ...run, datasourceId: saved.id });
    history.record({ ...run, datasourceId: "other" });

    await datasources.delete(saved.id);

    expect(history.search(saved.id, "")).toEqual([]);
    expect(history.search("other", "")).toHaveLength(1);
  });

  it("givenEphemeralDatasource_whenListed_thenFirstNeverSavedAndWithoutSecret", async () => {
    const ephemeral = { id: "pg", pluginId: "postgres", config: { ...PG_DRAFT.config, password: SECRET } };
    const { files, dependencies, service: datasources } = await service({ ephemeral });

    const [listed] = datasources.list().datasources;
    await datasources.connect("pg", {}, WINDOW);

    expect(listed).toMatchObject({ id: "pg", name: "pg", ephemeral: true });
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(files.contents.size).toBe(0);
    expect(bootedConfig(dependencies)).toEqual({
      id: "pg",
      pluginId: "postgres",
      config: ephemeral.config,
      readOnly: false,
      keepAliveSeconds: 30,
    });
    await expect(datasources.save({ datasource: { ...PG_DRAFT, id: "pg" }, secrets: {} })).rejects.toThrow(
      "TABLE_CRAFT_DATASOURCE",
    );
  });
});

const SSH_PASSWORD = "bastion-secret";
const KEY_PATH = "/home/me/.ssh/id_rsa";
const ENCRYPTED_KEY =
  "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----\n";
const PLAIN_KEY = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n";
const SSH_SETTINGS = {
  enabled: true,
  host: "bastion",
  port: 22,
  user: "deploy",
  auth: "password",
  keyPath: "",
} as const;

describe("datasource service SSH tunnel", () => {
  it("givenSshPassword_whenSavedAndConnected_thenSecretStoredApartAndTunnelBooted", async () => {
    const { files, dependencies, service: datasources } = await service();

    const saved = await datasources.save({
      datasource: { ...PG_DRAFT, ssh: SSH_SETTINGS },
      secrets: { password: { action: "set", value: SECRET }, "ssh.password": { action: "set", value: SSH_PASSWORD } },
    });
    await datasources.connect(saved.id, {}, WINDOW);

    const json = files.contents.get(`${DIRECTORY}/${DATASOURCES_FILE}`) ?? "";
    expect(json).not.toContain(SSH_PASSWORD);
    expect(saved.ssh).toEqual(SSH_SETTINGS);
    expect(saved.storedSecrets).toEqual(["password", "ssh.password"]);
    expect(bootedConfig(dependencies)).toEqual(
      expect.objectContaining({
        config: expect.not.objectContaining({ "ssh.password": SSH_PASSWORD }) as unknown,
        ssh: { host: "bastion", port: 22, user: "deploy", auth: "password", password: SSH_PASSWORD },
      }),
    );
  });

  it("givenNeverSshPassword_whenConnecting_thenAskedForIt", async () => {
    const { service: datasources } = await service();
    const saved = await datasources.save({
      datasource: { ...PG_DRAFT, ssh: SSH_SETTINGS, secretModes: { password: "forever", "ssh.password": "never" } },
      secrets: { password: { action: "set", value: SECRET } },
    });

    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({ status: "needsSecrets", keys: ["ssh.password"] });
  });

  it("givenEncryptedKey_whenConnect_thenAsksForPassphrase", async () => {
    const { service: datasources } = await service({ keyFiles: { [KEY_PATH]: ENCRYPTED_KEY } });
    const saved = await datasources.save({
      datasource: { ...PG_DRAFT, ssh: { ...SSH_SETTINGS, auth: "key", keyPath: KEY_PATH } },
      secrets: { password: { action: "set", value: SECRET } },
    });

    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({
      status: "needsSecrets",
      keys: ["ssh.passphrase"],
    });
  });

  it("givenUnencryptedKey_whenConnect_thenNoPassphraseAsked", async () => {
    const { dependencies, service: datasources } = await service({ keyFiles: { [KEY_PATH]: PLAIN_KEY } });
    const saved = await datasources.save({
      datasource: { ...PG_DRAFT, ssh: { ...SSH_SETTINGS, auth: "key", keyPath: KEY_PATH } },
      secrets: { password: { action: "set", value: SECRET } },
    });

    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({ status: "connected" });
    expect(bootedConfig(dependencies)).toMatchObject({
      ssh: { host: "bastion", user: "deploy", auth: "key", keyPath: KEY_PATH },
    });
  });

  it("givenTunnelTurnedOff_whenConnected_thenDirectButSettingsAndSecretKept", async () => {
    const { dependencies, service: datasources } = await service();

    const saved = await datasources.save({
      datasource: { ...PG_DRAFT, ssh: { ...SSH_SETTINGS, enabled: false } },
      secrets: { password: { action: "set", value: SECRET }, "ssh.password": { action: "set", value: SSH_PASSWORD } },
    });
    await datasources.connect(saved.id, {}, WINDOW);

    expect(saved.ssh?.host).toBe("bastion");
    expect(saved.storedSecrets).toContain("ssh.password");
    expect(bootedConfig(dependencies)).not.toHaveProperty("ssh");
  });

  it("givenTunnelRemoved_whenSaved_thenSshSecretsCleared", async () => {
    const { service: datasources } = await service();
    const saved = await datasources.save({
      datasource: { ...PG_DRAFT, ssh: SSH_SETTINGS },
      secrets: { password: { action: "set", value: SECRET }, "ssh.password": { action: "set", value: SSH_PASSWORD } },
    });

    const cleared = await datasources.save({ datasource: { ...PG_DRAFT, id: saved.id }, secrets: {} });
    const restored = await datasources.save({
      datasource: { ...PG_DRAFT, id: saved.id, ssh: SSH_SETTINGS, secretModes: saved.secretModes },
      secrets: {},
    });

    expect(cleared.ssh).toBeUndefined();
    expect(restored.storedSecrets).toEqual(["password"]);
  });

  it("givenPluginWithoutNetwork_whenSavedWithSsh_thenSshDropped", async () => {
    const { service: datasources } = await service();

    const saved = await datasources.save({
      datasource: {
        ...PG_DRAFT,
        pluginId: "sqlite",
        config: { path: "/tmp/a.db" },
        secretModes: { "ssh.password": "forever" },
        ssh: SSH_SETTINGS,
      },
      secrets: { "ssh.password": { action: "set", value: SSH_PASSWORD } },
    });

    expect(saved.ssh).toBeUndefined();
    expect(saved.secretModes).toEqual({});
  });

  it("givenTunnelWithoutHost_whenSaved_thenRefusedNamingIt", async () => {
    const { service: datasources } = await service();

    await expect(
      datasources.save({ datasource: { ...PG_DRAFT, ssh: { ...SSH_SETTINGS, host: " " } }, secrets: {} }),
    ).rejects.toThrow("SSH host is required.");
  });

  it("givenEditedTunnelWithBlankSshPassword_whenTested_thenStoredSecretMergedInMain", async () => {
    const { dependencies, service: datasources } = await service();
    const saved = await datasources.save({
      datasource: { ...PG_DRAFT, ssh: SSH_SETTINGS },
      secrets: { password: { action: "set", value: SECRET }, "ssh.password": { action: "set", value: SSH_PASSWORD } },
    });

    void datasources.test({ datasource: saved, secrets: {} });

    expect(bootedConfig(dependencies)).toMatchObject({ ssh: { password: SSH_PASSWORD }, config: { password: SECRET } });
  });
});

describe("datasource service client key", () => {
  const CLIENT_KEY = "/home/me/certs/client.key";
  const PASSPHRASE = "open sesame";
  const WITH_KEY: DatasourceDraft = {
    ...PG_DRAFT,
    config: { ...PG_DRAFT.config, sslMode: "verify-full", sslCert: "/home/me/certs/client.crt", sslKey: CLIENT_KEY },
  };
  const ENCRYPTED_PKCS8 = "-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n";
  const PLAIN_PKCS8 = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";

  it("givenEncryptedClientKey_whenConnect_thenAsksForPassphrase", async () => {
    const { service: datasources } = await service({ keyFiles: { [CLIENT_KEY]: ENCRYPTED_PKCS8 } });
    const saved = await datasources.save(saving({ ...WITH_KEY, secretModes: { password: "forever" } }, SECRET));

    expect(saved.secretModes).toEqual({ password: "forever", sslKeyPassphrase: "forever" });
    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({
      status: "needsSecrets",
      keys: ["sslKeyPassphrase"],
    });
  });

  it("givenEncryptedClientKeyAndTypedPassphrase_whenConnect_thenBootedWithIt", async () => {
    const { dependencies, service: datasources } = await service({ keyFiles: { [CLIENT_KEY]: ENCRYPTED_PKCS8 } });
    const saved = await datasources.save(saving(WITH_KEY, SECRET));

    expect(await datasources.connect(saved.id, { sslKeyPassphrase: PASSPHRASE }, WINDOW)).toEqual({
      status: "connected",
    });
    expect(bootedConfig(dependencies)).toMatchObject({ config: { sslKey: CLIENT_KEY, sslKeyPassphrase: PASSPHRASE } });
  });

  it("givenUnencryptedClientKey_whenConnect_thenNoPassphraseAsked", async () => {
    const { dependencies, service: datasources } = await service({ keyFiles: { [CLIENT_KEY]: PLAIN_PKCS8 } });
    const saved = await datasources.save(saving(WITH_KEY, SECRET));

    expect(await datasources.connect(saved.id, {}, WINDOW)).toEqual({ status: "connected" });
    expect(bootedConfig(dependencies)).toMatchObject({ config: { sslKey: CLIENT_KEY } });
    expect(bootedConfig(dependencies)).not.toHaveProperty("config.sslKeyPassphrase");
  });

  it("givenNoClientKey_whenSaved_thenNoPassphraseKept", async () => {
    const { service: datasources } = await service();

    const saved = await datasources.save(saving(PG_DRAFT, SECRET));

    expect(saved.secretModes).toEqual({ password: "forever" });
  });

  it("givenClientKeyCleared_whenSaved_thenPassphraseForgotten", async () => {
    const { service: datasources } = await service({ keyFiles: { [CLIENT_KEY]: ENCRYPTED_PKCS8 } });
    const saved = await datasources.save({
      datasource: WITH_KEY,
      secrets: { password: { action: "set", value: SECRET }, sslKeyPassphrase: { action: "set", value: PASSPHRASE } },
    });

    const cleared = await datasources.save({
      datasource: { ...WITH_KEY, id: saved.id, config: { ...WITH_KEY.config, sslKey: "" } },
      secrets: {},
    });
    const restored = await datasources.save({ datasource: { ...WITH_KEY, id: saved.id }, secrets: {} });

    expect(saved.storedSecrets).toEqual(["password", "sslKeyPassphrase"]);
    expect(cleared.storedSecrets).toEqual(["password"]);
    expect(restored.storedSecrets).toEqual(["password"]);
  });
});
