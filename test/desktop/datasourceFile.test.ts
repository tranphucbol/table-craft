import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openQueryHistory } from "@table-craft/core";
import { createConsoleFiles } from "@table-craft/desktop/main/consoleFiles.js";
import { createDatasourceExport } from "@table-craft/desktop/main/datasourceExport.js";
import {
  DATASOURCE_FILE_FORMAT,
  DATASOURCE_FILE_NAME,
  DatasourceFileError,
  isDatasourceFile,
  NEWER_SETTINGS_WARNING,
  readDatasourceFile,
  writeDatasourceFile,
  type DatasourceFileProblem,
} from "@table-craft/desktop/main/datasourceFile.js";
import { createDatasourceStore } from "@table-craft/desktop/main/datasources.js";
import { createHostRegistry } from "@table-craft/desktop/main/hosts.js";
import { listPlugins } from "@table-craft/desktop/main/plugins.js";
import { createSecretStore } from "@table-craft/desktop/main/secrets.js";
import { createDatasourceService, type EphemeralDatasource } from "@table-craft/desktop/main/service.js";
import type { DatasourceDraft, DatasourceSelection } from "@table-craft/desktop/preload/bridge.js";
import { fakeHostDependencies } from "../support/fakeHosts.js";
import { fakeCipher, memoryFiles } from "../support/memoryFiles.js";

const DIRECTORY = "/profile";
const BUILT_IN_PLUGINS = join(import.meta.dirname, "../../plugins");
const SECRET = "export-secret-5521";
const PASSPHRASE = "correct horse battery";
const EXPORT_PATH = "/exports/tablecraft-datasources.json";
/** Cheap enough for a unit test; the default cost runs once, through the export channel. */
const FAST_KDF = { N: 2 ** 10, r: 8, p: 1 };

const MYSQL_DRAFT: DatasourceDraft = {
  name: "Shop MySQL",
  pluginId: "mysql",
  folder: "Work/Shop",
  color: "blue",
  readOnly: false,
  comment: "orders",
  config: { host: "mysql.test", port: 3307, user: "shop", database: "shop" },
  secretModes: { password: "forever" },
};

const SQLITE_DRAFT: DatasourceDraft = {
  name: "Notes",
  pluginId: "sqlite",
  folder: null,
  color: null,
  readOnly: true,
  comment: "",
  config: { path: "/data/notes.db" },
  secretModes: {},
};

async function setup(ephemeral: EphemeralDatasource | null = null) {
  const files = memoryFiles();
  let ids = 0;
  const plugins = await listPlugins([BUILT_IN_PLUGINS]);
  const service = await createDatasourceService({
    store: createDatasourceStore({ directory: DIRECTORY, files }),
    secrets: await createSecretStore({ directory: DIRECTORY, files, cipher: fakeCipher() }),
    hosts: createHostRegistry({ pluginRoots: () => [], dependencies: fakeHostDependencies(), onExit: () => undefined }),
    plugins: () => plugins,
    ephemeral,
    newId: () => `id-${String(++ids)}`,
    consoles: createConsoleFiles({ directory: DIRECTORY, files }),
    history: openQueryHistory(":memory:"),
    onChanged: () => undefined,
  });
  const mysql = await service.save({
    datasource: MYSQL_DRAFT,
    secrets: { password: { action: "set", value: SECRET } },
  });
  const sqlite = await service.save({ datasource: SQLITE_DRAFT, secrets: {} });
  const written = new Map<string, string>();
  const logs: unknown[] = [];
  const log = {
    info: (...args: unknown[]) => logs.push(args),
    warn: (...args: unknown[]) => logs.push(args),
    error: (...args: unknown[]) => logs.push(args),
    child: () => log,
  };
  const saveAs: { path: string | null } = { path: EXPORT_PATH };
  const channels = createDatasourceExport<string>({
    service,
    saveFile: () => Promise.resolve(saveAs.path),
    writeText: (path, text) => {
      written.set(path, text);
      return Promise.resolve();
    },
    log,
  });
  return { service, channels, written, logs, saveAs, mysql, sqlite };
}

function everything(...ids: string[]): DatasourceSelection {
  return { ids, folders: [] };
}

async function problemOf(reading: Promise<unknown>): Promise<DatasourceFileProblem | null> {
  try {
    await reading;
    return null;
  } catch (cause) {
    if (cause instanceof DatasourceFileError) return cause.problem;
    throw cause;
  }
}

function document(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    format: DATASOURCE_FILE_FORMAT,
    version: 1,
    exportedAt: "2026-11-03T00:00:00.000Z",
    folders: [],
    datasources: [],
    ...overrides,
  });
}

describe("data source file", () => {
  it("givenDataSources_whenExportWithoutPasswords_thenFileHasNoSecrets", async () => {
    const { channels, written, mysql, sqlite } = await setup();

    const result = await channels.export("window", everything(mysql.id, sqlite.id));

    expect(result).toEqual({ status: "saved", path: EXPORT_PATH, count: 2 });
    const text = written.get(EXPORT_PATH) ?? "";
    expect(text).not.toContain(SECRET);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("secrets");
    expect(parsed).toMatchObject({ format: DATASOURCE_FILE_FORMAT, version: 1, folders: ["Work", "Work/Shop"] });
    expect(parsed.datasources).toMatchObject([
      { id: mysql.id, name: "Shop MySQL", folder: "Work/Shop", color: "blue", secretModes: { password: "forever" } },
      { id: sqlite.id, name: "Notes", readOnly: true, config: { path: "/data/notes.db" } },
    ]);
  });

  it("givenPassphrase_whenExportThenRead_thenSecretsRestored", async () => {
    const { channels, written, logs, mysql } = await setup();

    await channels.export("window", { ...everything(mysql.id), passphrase: PASSPHRASE });

    const text = written.get(EXPORT_PATH) ?? "";
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toContain(PASSPHRASE);
    const read = await readDatasourceFile(text, { passphrase: PASSPHRASE });
    expect(read.secrets).toEqual({ [mysql.id]: { password: SECRET } });
    expect(read.records).toMatchObject([{ id: mysql.id, name: "Shop MySQL", warnings: [] }]);
  });

  it("givenWrongPassphrase_whenRead_thenWrongPassphrase", async () => {
    const { service, mysql } = await setup();
    const text = await writeDatasourceFile(service.exportDefinitions(everything(mysql.id), true), PASSPHRASE, {
      kdf: FAST_KDF,
    });

    expect(await problemOf(readDatasourceFile(text, { passphrase: "not the passphrase" }))).toBe("wrongPassphrase");
    expect(await problemOf(readDatasourceFile(text))).toBe("needsPassphrase");
    const skipped = await readDatasourceFile(text, { skipSecrets: true });
    expect(skipped.secrets).toBeNull();
    expect(skipped.records).toHaveLength(1);
  });

  it("givenNewerVersion_whenRead_thenRefusedWithUpdateHint", async () => {
    const reading = readDatasourceFile(document({ version: 2 }));

    expect(await problemOf(reading)).toBe("newerVersion");
    await expect(readDatasourceFile(document({ version: 2 }))).rejects.toThrow("Update TableCraft to import it.");
    expect(isDatasourceFile(document({ version: 2 }))).toBe(true);
  });

  it("givenUnknownField_whenRead_thenDroppedWithWarning", async () => {
    const { service, sqlite } = await setup();
    const [record] = service.exportDefinitions(everything(sqlite.id), false).datasources;
    const text = document({ datasources: [{ ...record, pinned: true, keepAliveSeconds: "often" }] });

    const read = await readDatasourceFile(text);

    expect(read.records[0]?.warnings).toEqual([NEWER_SETTINGS_WARNING]);
    expect(read.records[0]?.datasource).toMatchObject({ name: "Notes", readOnly: true });
    expect(read.records[0]?.datasource).not.toHaveProperty("pinned");
  });

  it("givenLastServer_whenExported_thenLeftOut", async () => {
    const { service, mysql } = await setup();
    await service.rememberServer(mysql.id, {
      brand: "mysql",
      lastServer: {
        version: "8.4.0",
        timeout: { setting: "max_execution_time", covers: "reads", counts: "statement" },
        cancel: { method: "KILL QUERY", reaches: "statement" },
        seenAt: 1_800_000_000_000,
      },
    });
    expect(service.exportDefinitions(everything(mysql.id), false).datasources[0]).toHaveProperty("lastServer");

    const text = await writeDatasourceFile(service.exportDefinitions(everything(mysql.id), false));

    expect(text).not.toContain("lastServer");
    expect(text).not.toContain("8.4.0");
    expect(JSON.parse(text)).toMatchObject({ datasources: [{ brand: "mysql" }] });
  });

  it("givenEphemeralDatasource_whenExportAll_thenLeftOut", async () => {
    const { service, mysql, sqlite } = await setup({
      id: "env",
      pluginId: "sqlite",
      config: { path: "/tmp/env.db" },
    });

    const content = service.exportDefinitions(everything("env", mysql.id, sqlite.id), true);

    expect(content.datasources.map((datasource) => datasource.id)).toEqual([mysql.id, sqlite.id]);
    expect(Object.keys(content.secrets ?? {})).toEqual([mysql.id]);
  });

  it("givenFolder_whenExported_thenItsDataSourcesAndAncestorsGo", async () => {
    const { service, mysql } = await setup();
    await service.createFolder("Work/Empty");

    const content = service.exportDefinitions({ ids: [], folders: ["Work"] }, false);

    expect(content.datasources.map((datasource) => datasource.id)).toEqual([mysql.id]);
    expect(content.folders).toEqual(["Work", "Work/Shop", "Work/Empty"]);
  });

  it("givenCancelledSaveDialog_whenExported_thenNothingWritten", async () => {
    const { channels, written, saveAs, sqlite } = await setup();
    saveAs.path = null;

    expect(await channels.export("window", everything(sqlite.id))).toEqual({ status: "cancelled" });
    expect(written.size).toBe(0);
  });

  it("givenEmptySelection_whenExported_thenRefusedWithHint", async () => {
    const { channels } = await setup();

    await expect(channels.export("window", everything())).rejects.toThrow("Nothing to export.");
  });

  it("givenCopy_whenRead_thenSameDataSourcesWithoutSecrets", async () => {
    const { channels, mysql } = await setup();

    const text = await channels.copy(everything(mysql.id));

    expect(text).not.toContain(SECRET);
    const read = await readDatasourceFile(text);
    expect(read.secrets).toBeNull();
    expect(read.records.map((record) => record.name)).toEqual(["Shop MySQL"]);
  });

  it("givenOtherJson_whenRead_thenNotOurs", async () => {
    expect(await problemOf(readDatasourceFile('{"snippets": []}'))).toBe("notOurs");
    expect(await problemOf(readDatasourceFile("not json"))).toBe("notOurs");
    expect(isDatasourceFile("[1, 2]")).toBe(false);
    expect(DATASOURCE_FILE_NAME).toBe("tablecraft-datasources.json");
  });
});
