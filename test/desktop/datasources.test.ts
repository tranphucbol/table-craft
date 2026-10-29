import { describe, expect, it } from "vitest";
import {
  createDatasourceStore,
  DATASOURCES_FILE,
  normalizeFolder,
  toDatasource,
} from "@table-craft/desktop/main/datasources.js";
import type { Datasource } from "@table-craft/desktop/preload/bridge.js";
import { POSTGRES_MANIFEST } from "../support/manifests.js";
import { memoryFiles } from "../support/memoryFiles.js";

const DIRECTORY = "/profile";
const PATH = `${DIRECTORY}/${DATASOURCES_FILE}`;
const NOW = 1_700_000_000_000;

const LOCAL_PG: Datasource = {
  id: "8f0c6a8e-2f0b-4f5e-9d38-2d5b8f0e6a11",
  name: "Local PG",
  pluginId: "postgres",
  folder: "Docker/Main",
  color: "red",
  readOnly: true,
  comment: "the compose database",
  config: { host: "127.0.0.1", port: 55432, database: "table_craft", user: "table_craft", sslMode: "disable" },
  secretModes: { password: "forever" },
};

function store(files = memoryFiles()) {
  return { files, store: createDatasourceStore({ directory: DIRECTORY, files, now: () => NOW }) };
}

describe("datasource store", () => {
  it("givenNoFile_whenLoaded_thenEmptyWithoutWarning", async () => {
    expect(await store().store.load()).toEqual({ datasources: [], warning: null });
  });

  it("givenDatasourcesFileV1_whenLoaded_thenRoundTrips", async () => {
    const { files, store: first } = store();
    await first.save([LOCAL_PG]);

    const reloaded = await createDatasourceStore({ directory: DIRECTORY, files }).load();

    expect(JSON.parse(files.contents.get(PATH) ?? "")).toMatchObject({ version: 1 });
    expect(reloaded).toEqual({ datasources: [LOCAL_PG], warning: null });
  });

  it("givenKeepAliveAndTimeout_whenSavedAndLoaded_thenRoundTrip", async () => {
    const { files, store: first } = store();
    const tuned = { ...LOCAL_PG, keepAliveSeconds: 0, statementTimeoutSeconds: 120 };
    await first.save([tuned]);

    const reloaded = await createDatasourceStore({ directory: DIRECTORY, files }).load();

    expect(reloaded.datasources).toEqual([tuned]);
  });

  it("givenEnforceAndAgentTimeout_whenSaved_thenReloads", async () => {
    const { files, store: first } = store();
    const tuned = {
      ...LOCAL_PG,
      statementTimeoutSeconds: 30,
      enforceTimeoutOnServer: true as const,
      agentAccess: "read" as const,
      agentTimeoutSeconds: 15,
    };
    await first.save([tuned]);

    const reloaded = await createDatasourceStore({ directory: DIRECTORY, files }).load();

    expect(reloaded.datasources).toEqual([tuned]);
    expect(toDatasource(tuned, LOCAL_PG.id, POSTGRES_MANIFEST.connection.fields)).toMatchObject({
      enforceTimeoutOnServer: true,
      agentTimeoutSeconds: 15,
    });
  });

  it("givenShownNamespaces_whenSavedAndLoaded_thenRoundTrip", async () => {
    const { files, store: first } = store();
    const filtered = { ...LOCAL_PG, shownNamespaces: ["table_craft", "shop"] };
    await first.save([filtered, LOCAL_PG]);

    const reloaded = await createDatasourceStore({ directory: DIRECTORY, files }).load();

    expect(reloaded.datasources).toEqual([filtered, LOCAL_PG]);
    expect(reloaded.datasources[1]).not.toHaveProperty("shownNamespaces");
  });

  it("givenDraftWithShownNamespaces_whenStored_thenKept", () => {
    const draft = { ...LOCAL_PG, shownNamespaces: ["shop"] };

    expect(toDatasource(draft, LOCAL_PG.id, POSTGRES_MANIFEST.connection.fields).shownNamespaces).toEqual(["shop"]);
    expect(toDatasource(LOCAL_PG, LOCAL_PG.id, POSTGRES_MANIFEST.connection.fields)).not.toHaveProperty(
      "shownNamespaces",
    );
  });

  it("givenBrand_whenDatasourcesSavedAndLoaded_thenKept", async () => {
    const { files, store: first } = store();
    const tidb = { ...LOCAL_PG, pluginId: "mysql", brand: "tidb" };
    await first.save([tidb, LOCAL_PG]);

    const reloaded = await createDatasourceStore({ directory: DIRECTORY, files }).load();

    expect(reloaded.datasources).toEqual([tidb, LOCAL_PG]);
    expect(reloaded.datasources[1]).not.toHaveProperty("brand");
    expect(toDatasource(tidb, tidb.id, POSTGRES_MANIFEST.connection.fields).brand).toBe("tidb");
  });

  it("givenBadBrandId_whenLoaded_thenSetAside", async () => {
    const file = JSON.stringify({ version: 1, datasources: [{ ...LOCAL_PG, brand: "Ti DB" }] });

    const loaded = await store(memoryFiles({ [PATH]: file })).store.load();

    expect(loaded.datasources).toEqual([]);
    expect(loaded.warning).not.toBeNull();
  });

  it("givenKeepAliveOutOfRange_whenLoaded_thenNotMisread", async () => {
    const file = JSON.stringify({ version: 1, datasources: [{ ...LOCAL_PG, keepAliveSeconds: 99_999 }] });

    const loaded = await store(memoryFiles({ [PATH]: file })).store.load();

    expect(loaded.datasources).toEqual([]);
    expect(loaded.warning).not.toBeNull();
  });

  it("givenCorruptDatasourcesFile_whenLoaded_thenBackedUpAndEmptyListWithWarning", async () => {
    const { files, store: corrupt } = store(memoryFiles({ [PATH]: "{ not json" }));

    const loaded = await corrupt.load();

    expect(loaded.datasources).toEqual([]);
    expect(loaded.warning).toContain(`${PATH}.corrupt-${String(NOW)}`);
    expect(files.contents.get(`${PATH}.corrupt-${String(NOW)}`)).toBe("{ not json");
    expect(files.contents.has(PATH)).toBe(false);
  });

  it("givenFileFromNewerVersion_whenLoaded_thenSetAsideRatherThanMisread", async () => {
    const newer = JSON.stringify({ version: 2, datasources: [] });
    const loaded = await store(memoryFiles({ [PATH]: newer })).store.load();

    expect(loaded.warning).toContain("version");
  });

  it("givenSaveWrite_whenProcessDiesMidWrite_thenPreviousFileIntact", async () => {
    const { files, store: saving } = store();
    await saving.save([LOCAL_PG]);
    const before = files.contents.get(PATH);
    files.dieDuringNextWrite();

    await expect(saving.save([])).rejects.toThrow("killed mid-write");

    expect(files.contents.get(PATH)).toBe(before);
    expect((await saving.load()).datasources).toEqual([LOCAL_PG]);
  });
});

describe("datasource records", () => {
  it("givenMessyFolderPath_whenNormalized_thenTrimmedSlashSeparated", () => {
    expect(normalizeFolder(" Docker / /Main/ ")).toBe("Docker/Main");
    expect(normalizeFolder(" / ")).toBeNull();
    expect(normalizeFolder(null)).toBeNull();
  });

  it("givenDraftCarryingSecretAndUnknownKeys_whenStored_thenOnlyDeclaredNonSecretConfigKept", () => {
    const draft = {
      ...LOCAL_PG,
      name: "  Local PG ",
      config: { ...LOCAL_PG.config, password: "hunter2", extra: "x" },
    };

    const stored = toDatasource(draft, LOCAL_PG.id, POSTGRES_MANIFEST.connection.fields);

    expect(stored.config).toEqual(LOCAL_PG.config);
    expect(stored.name).toBe("Local PG");
  });

  it("givenDraftWithSsh_whenStored_thenKeptWithItsSecretModesOnlyWhenTheTunnelIsOffered", () => {
    const ssh = { enabled: true, host: " bastion ", port: 22, user: "deploy", auth: "password", keyPath: "" } as const;
    const draft = { ...LOCAL_PG, ssh, secretModes: { "ssh.password": "never", "ssh.other": "never" } as const };

    const offered = toDatasource(draft, LOCAL_PG.id, POSTGRES_MANIFEST.connection.fields, true);
    const refused = toDatasource(draft, LOCAL_PG.id, POSTGRES_MANIFEST.connection.fields);

    expect(offered.ssh).toEqual({ ...ssh, host: "bastion" });
    expect(offered.secretModes).toEqual({ "ssh.password": "never" });
    expect(refused.ssh).toBeUndefined();
    expect(refused.secretModes).toEqual({});
  });
});
