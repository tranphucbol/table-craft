import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@table-craft/plugin-api";
import { createLogger, type LogRecord } from "@table-craft/desktop/log/record.js";
import { PLUGIN_CATALOG } from "@table-craft/desktop/main/pluginStore/catalog.js";
import { confirmationText, createPluginChannels } from "@table-craft/desktop/main/pluginStore/channels.js";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import { listManaged, pruneManaged } from "@table-craft/desktop/main/pluginStore/managed.js";
import {
  createPluginService,
  type PluginService,
  type PluginServiceOptions,
} from "@table-craft/desktop/main/pluginStore/service.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";
import type { PluginsState } from "@table-craft/desktop/preload/bridge.js";
import { OPTIONAL_PLUGINS } from "../../packages/desktop/vite.plugins.config.js";
import { pluginTarball, release, sha512, startRegistry, type LoopbackRegistry } from "../support/pluginRegistry.js";

const PACKAGE = "@tablecraft-app/plugin-postgres";
const OUTSIDE_CATALOG = "duckdb";
const SOURCE_PLUGINS = "plugins";

let profile: string;
let registry: LoopbackRegistry;
let records: LogRecord[];
let changes: PluginsState[];
let users: Record<string, string[]>;

async function makeProfile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tc-plugin-store-"));
  await mkdir(join(directory, "built-in", "sqlite"), { recursive: true });
  await writeFile(
    join(directory, "built-in", "sqlite", MANIFEST_FILE),
    await readFile(join(SOURCE_PLUGINS, "sqlite", MANIFEST_FILE)),
  );
  return directory;
}

function managedRoot(): string {
  return join(profile, "managed-plugins");
}

function service(
  registryUrl = registry.url,
  extra: Pick<PluginServiceOptions, "channel" | "hostVersion"> = {},
): PluginService {
  return createPluginService({
    ...extra,
    builtInRoot: join(profile, "built-in"),
    developmentRoots: [],
    managedRoot: managedRoot(),
    userRoot: join(profile, "plugins"),
    registryUrl: () => registryUrl,
    fetch: (url, init) => fetch(url, init),
    usedBy: (id) => users[id] ?? [],
    onChanged: (state) => changes.push(state),
    log: createLogger({ process: "main", scope: "plugins", sink: (record) => records.push(record) }),
  });
}

async function started(registryUrl?: string): Promise<PluginService> {
  const plugins = service(registryUrl);
  await plugins.start();
  return plugins;
}

async function rejectionOf(work: Promise<unknown>): Promise<PluginInstallError> {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof PluginInstallError) return cause;
    throw cause;
  }
  throw new Error("expected a PluginInstallError");
}

function messages(): string[] {
  return records.map((record) => record.msg);
}

beforeEach(async () => {
  profile = await makeProfile();
  registry = await startRegistry({ [PACKAGE]: [release({ id: "postgres", version: "1.0.0" })] });
  records = [];
  changes = [];
  users = {};
});

afterEach(async () => {
  await registry.close();
  await rm(profile, { recursive: true, force: true });
});

describe("plugin service", () => {
  it("givenFreshProfile_whenStarted_thenOnlyTheBuiltInIsInstalledAndTheCatalogOffersTheOptionalOnes", async () => {
    const plugins = await started();

    expect(plugins.plugins().map((plugin) => [plugin.id, plugin.source])).toEqual([["sqlite", "builtIn"]]);
    expect(plugins.state().catalog).toEqual([
      expect.objectContaining({ id: "postgres", installedVersion: null, install: { status: "idle" } }),
      expect.objectContaining({ id: "redis", installedVersion: null, install: { status: "idle" } }),
      expect.objectContaining({ id: "oracle", installedVersion: null, install: { status: "idle" } }),
      expect.objectContaining({ id: "mssql", installedVersion: null, install: { status: "idle" } }),
      expect.objectContaining({ id: "etcd", installedVersion: null, install: { status: "idle" } }),
    ]);
  });

  it("givenRegistryPlugin_whenInstalled_thenCurrentPointsAtItAndItLoadsFromItsOwnRoot", async () => {
    const plugins = await started();

    const outcome = await plugins.install("postgres");

    expect(outcome).toEqual({ id: "postgres", version: "1.0.0", changed: true });
    const postgres = plugins.plugins().find((plugin) => plugin.id === "postgres");
    expect(postgres).toMatchObject({ source: "managed", version: "1.0.0", unavailableReason: null });
    expect(plugins.roots()).toContainEqual({ directory: join(managedRoot(), "postgres", "1.0.0") });
    expect(JSON.parse(await readFile(join(managedRoot(), "postgres", "current.json"), "utf8"))).toEqual({
      version: "1.0.0",
      packageName: PACKAGE,
      source: "registry",
    });
    expect(changes.at(-1)?.catalog[0]).toMatchObject({ installedVersion: "1.0.0", install: { status: "idle" } });
    expect(changes.some((state) => state.catalog[0]?.install.status === "installing")).toBe(true);
    expect(messages()).toEqual(expect.arrayContaining(["plugin download started", "plugin installed"]));
  });

  it("givenInstalledVersion_whenInstalledAgain_thenNothingIsDownloaded", async () => {
    const plugins = await started();
    await plugins.install("postgres");
    const tarballs = () => registry.requests.filter((path) => path.startsWith("/tarballs/")).length;

    const outcome = await plugins.install("postgres");

    expect(outcome.changed).toBe(false);
    expect(tarballs()).toBe(1);
  });

  it("givenTwoInstallsAtOnce_whenBothRun_thenOneDownloadServesBoth", async () => {
    const plugins = await started();

    const [first, second] = await Promise.all([plugins.install("postgres"), plugins.install("postgres")]);

    expect(first).toEqual(second);
    expect(registry.requests.filter((path) => path.startsWith("/tarballs/"))).toHaveLength(1);
  });

  it("givenNewerVersionPublished_whenUpdated_thenCurrentSwitchesAndTheOldVersionGoesAtNextStart", async () => {
    const plugins = await started();
    await plugins.install("postgres");
    registry.publish(PACKAGE, [
      release({ id: "postgres", version: "1.0.0" }),
      release({ id: "postgres", version: "1.1.0" }),
    ]);

    const outcomes = await plugins.updateAll();

    expect(outcomes).toEqual([{ id: "postgres", version: "1.1.0", changed: true }]);
    expect(plugins.plugins().find((plugin) => plugin.id === "postgres")?.version).toBe("1.1.0");
    expect(records.find((record) => record.msg === "plugin updated")).toMatchObject({ from: "1.0.0", to: "1.1.0" });
    expect((await readdir(join(managedRoot(), "postgres"))).sort()).toEqual(["1.0.0", "1.1.0", "current.json"]);

    await service().start();

    expect((await readdir(join(managedRoot(), "postgres"))).sort()).toEqual(["1.1.0", "current.json"]);
  });

  it("givenNewerApiOnlyRelease_whenUpdated_thenTheInstalledVersionStays", async () => {
    const plugins = await started();
    await plugins.install("postgres");
    registry.publish(PACKAGE, [
      release({ id: "postgres", version: "1.0.0" }),
      release({ id: "postgres", version: "2.0.0", apiVersion: "2.0.0" }),
    ]);

    expect(await plugins.updateAll()).toEqual([{ id: "postgres", version: "1.0.0", changed: false }]);
  });

  it("givenBetaChannel_whenUpdated_thenNewestBetaInstalls", async () => {
    const plugins = service(registry.url, { channel: () => "beta" });
    await plugins.start();
    await plugins.install("postgres");
    registry.publish(PACKAGE, [
      release({ id: "postgres", version: "1.0.0" }),
      release({ id: "postgres", version: "1.1.0-beta.1" }),
    ]);

    expect(await plugins.updateAll()).toEqual([{ id: "postgres", version: "1.1.0-beta.1", changed: true }]);
  });

  it("givenBetaPluginInstalled_whenListed_thenItsNpmVersionNotTheManifestOne", async () => {
    const plugins = service(registry.url, { channel: () => "beta" });
    registry.publish(PACKAGE, [release({ id: "postgres", version: "1.1.0-beta.1" })]);
    await plugins.start();
    await plugins.install("postgres");

    expect(plugins.plugins().find((plugin) => plugin.id === "postgres")?.version).toBe("1.1.0-beta.1");
    expect(plugins.state().catalog.find((entry) => entry.id === "postgres")?.installedVersion).toBe("1.1.0-beta.1");
    expect(plugins.report().find((entry) => entry.id === "postgres")?.version).toBe("1.1.0-beta.1");
  });

  it("givenStableChannelAndBetaInstalled_whenUpdateAll_thenKeepsBeta", async () => {
    let channel: ReleaseChannel = "beta";
    const plugins = service(registry.url, { channel: () => channel });
    await plugins.start();
    registry.publish(PACKAGE, [
      release({ id: "postgres", version: "1.0.0" }),
      release({ id: "postgres", version: "1.1.0-beta.1" }),
    ]);
    await plugins.install("postgres");
    channel = "stable";

    expect(await plugins.updateAll()).toEqual([{ id: "postgres", version: "1.1.0-beta.1", changed: false }]);
    registry.publish(PACKAGE, [
      release({ id: "postgres", version: "1.1.0-beta.1" }),
      release({ id: "postgres", version: "1.1.0" }),
    ]);
    expect(await plugins.updateAll()).toEqual([{ id: "postgres", version: "1.1.0", changed: true }]);
  });

  it("givenStableChannelAndBetaInstalledIncompatible_whenUpdateAll_thenInstallsStable", async () => {
    registry.publish(PACKAGE, [
      release({ id: "postgres", version: "1.0.0" }),
      release({ id: "postgres", version: "1.1.0-beta.1", apiVersion: "1.1.0" }),
    ]);
    const beta = service(registry.url, { channel: () => "beta" });
    await beta.start();
    await beta.install("postgres");
    const older = service(registry.url, { channel: () => "stable", hostVersion: "1.0.0" });
    await older.start();

    expect(await older.updateAll()).toEqual([{ id: "postgres", version: "1.0.0", changed: true }]);
  });

  it("givenTamperedTarball_whenInstalled_thenIntegrityFailsAndNothingIsWritten", async () => {
    const real = pluginTarball({ id: "postgres", version: "1.0.0" });
    registry.publish(PACKAGE, [
      { ...release({ id: "postgres", version: "1.0.0", indexJs: "steal();\n" }), integrity: sha512(real) },
    ]);
    const plugins = await started();

    const error = await rejectionOf(plugins.install("postgres"));

    expect(error.failure).toBe("integrity");
    expect(await readdir(profile)).not.toContain("managed-plugins");
    expect(plugins.state().catalog[0]?.install).toMatchObject({ status: "failed", message: error.message });
    expect(records.find((record) => record.msg === "plugin install failed")).toMatchObject({ level: "warn" });
  });

  it("givenUnloadableUpdate_whenInstalled_thenThePreviousVersionStaysCurrent", async () => {
    const plugins = await started();
    await plugins.install("postgres");
    const broken = release({
      id: "postgres",
      version: "1.1.0",
      manifest: { id: "postgres", name: "PostgreSQL", version: "1.1.0", apiVersion: "9.0.0", entry: "index.js" },
    });
    registry.publish(PACKAGE, [release({ id: "postgres", version: "1.0.0" }), broken]);

    const error = await rejectionOf(plugins.install("postgres"));

    expect(error.failure).toBe("invalid");
    expect((await listManaged(managedRoot())).map((plugin) => plugin.version)).toEqual(["1.0.0"]);
    expect((await readdir(join(managedRoot(), "postgres"))).sort()).toEqual(["1.0.0", "current.json"]);
  });

  it("givenRegistryDown_whenInstalled_thenFailedStateCarriesTheInstallFromFileHint", async () => {
    await registry.close();
    const plugins = await started();

    const error = await rejectionOf(plugins.install("postgres"));

    expect(error.failure).toBe("offline");
    expect(plugins.state().catalog[0]?.install).toMatchObject({ status: "failed", hint: error.hint });
    registry = await startRegistry();
  });

  it("givenIdOutsideTheCatalog_whenInstalled_thenNotFound", async () => {
    const plugins = await started();

    expect((await rejectionOf(plugins.install(OUTSIDE_CATALOG))).failure).toBe("notFound");
  });

  it("givenPackageFile_whenInstalled_thenItIsManagedFromFileAndUpdatesSkipIt", async () => {
    const plugins = await started();

    await plugins.installFile(pluginTarball({ id: "postgres", version: "0.9.0" }));
    registry.publish(PACKAGE, [release({ id: "postgres", version: "1.1.0" })]);

    expect((await listManaged(managedRoot()))[0]).toMatchObject({ version: "0.9.0", source: "file" });
    expect(await plugins.updateAll()).toEqual([]);
    expect(messages()).toContain("plugin installed from file");
  });

  it("givenFileNamingABuiltInId_whenInstalled_thenRefused", async () => {
    const plugins = await started();

    const error = await rejectionOf(plugins.installFile(pluginTarball({ id: "sqlite", version: "9.0.0" })));

    expect(error.failure).toBe("builtIn");
  });

  it("givenDatasourceOnThePlugin_whenRemoved_thenRefusedNamingIt", async () => {
    const plugins = await started();
    await plugins.install("postgres");
    users = { postgres: ["shop"] };

    const error = await rejectionOf(plugins.remove("postgres"));

    expect(error.failure).toBe("inUse");
    expect(error.message).toContain('"shop"');
  });

  it("givenUnusedDownloadedPlugin_whenRemoved_thenItIsGone", async () => {
    const plugins = await started();
    await plugins.install("postgres");

    await plugins.remove("postgres");

    expect(plugins.plugins().map((plugin) => plugin.id)).toEqual(["sqlite"]);
    expect(await readdir(managedRoot())).toEqual([]);
    expect(messages()).toContain("plugin removed");
  });

  it("givenBuiltInPlugin_whenRemoved_thenRefused", async () => {
    const plugins = await started();

    expect((await rejectionOf(plugins.remove("sqlite"))).failure).toBe("builtIn");
  });

  it("givenSavedDatasourceOnAMissingCatalogPlugin_whenMissingInstalled_thenItIsDownloaded", async () => {
    users = { postgres: ["shop"] };
    const plugins = await started();

    await plugins.installMissing(["postgres", "sqlite", OUTSIDE_CATALOG]);

    expect(plugins.plugins().find((plugin) => plugin.id === "postgres")?.source).toBe("managed");
    expect(records.find((record) => record.msg === "plugin missing; installing")).toMatchObject({
      pluginId: "postgres",
      usedBy: ["shop"],
    });
    expect(records.filter((record) => record.msg === "plugin missing; installing")).toHaveLength(1);
  });

  it("givenRegistryDown_whenMissingInstalled_thenItFailsQuietly", async () => {
    await registry.close();
    const plugins = await started();

    await expect(plugins.installMissing(["postgres"])).resolves.toBeUndefined();
    registry = await startRegistry();
  });

  it("givenLeftoversOnDisk_whenPruned_thenStagingOrphansAndOldVersionsGo", async () => {
    const plugins = await started();
    await plugins.install("postgres");
    await mkdir(join(managedRoot(), "postgres", ".staging-x"), { recursive: true });
    await mkdir(join(managedRoot(), "postgres", "0.1.0"), { recursive: true });
    await mkdir(join(managedRoot(), "orphan", "1.0.0"), { recursive: true });

    const removed = await pruneManaged(managedRoot());

    expect(removed).toHaveLength(3);
    expect((await readdir(managedRoot())).sort()).toEqual(["postgres"]);
  });
});

describe("plugin channels", () => {
  function channels(plugins: PluginService, answer: boolean, file: Uint8Array | null) {
    const asked: Parameters<typeof confirmationText>[0][] = [];
    const created = createPluginChannels<string>({
      service: plugins,
      choose: () => Promise.resolve(file === null ? null : "/picked/plugin.tgz"),
      readFile: () => Promise.resolve(file ?? new Uint8Array()),
      confirm: (_, choice) => {
        asked.push(choice);
        return Promise.resolve(answer);
      },
    });
    return { created, asked };
  }

  it("givenCancelledPicker_whenInstallingAFile_thenCancelled", async () => {
    const { created, asked } = channels(await started(), true, null);

    expect(await created.installFile("window")).toEqual({ status: "cancelled" });
    expect(asked).toEqual([]);
  });

  it("givenDeclinedConfirmation_whenInstallingAFile_thenNothingIsInstalled", async () => {
    const plugins = await started();
    const { created, asked } = channels(plugins, false, pluginTarball({ id: "postgres", version: "1.0.0" }));

    expect(await created.installFile("window")).toEqual({ status: "cancelled" });
    expect(asked).toEqual([{ name: PACKAGE, version: "1.0.0", pluginId: "postgres", official: true }]);
    expect(await listManaged(managedRoot())).toEqual([]);
  });

  it("givenConfirmedThirdPartyFile_whenInstalled_thenItLoads", async () => {
    const plugins = await started();
    const file = pluginTarball({ id: "postgres", version: "1.0.0", name: "table-craft-postgres-fork" });
    const { created, asked } = channels(plugins, true, file);

    expect(await created.installFile("window")).toEqual({
      status: "installed",
      pluginId: "postgres",
      version: "1.0.0",
    });
    expect(asked[0]?.official).toBe(false);
    expect(created.state().plugins.map((plugin) => plugin.id)).toContain("postgres");
  });

  it("givenThirdPartyPackage_whenConfirming_thenTheTextSaysItIsNotOfficial", () => {
    const text = confirmationText({ name: "x", version: "1.0.0", pluginId: "x", official: false });

    expect(text.message).toBe("Install the plugin x 1.0.0?");
    expect(text.detail).toContain("not an official TableCraft plugin");
  });
});

describe("plugin catalog", () => {
  it("givenOptionalPlugins_whenListed_thenTheCatalogOffersEachOne", () => {
    expect(PLUGIN_CATALOG.map((entry) => entry.id).sort()).toEqual([...OPTIONAL_PLUGINS].sort());
  });

  it.each(PLUGIN_CATALOG.map((entry) => [entry.id, entry] as const))(
    "givenCatalogEntry%s_whenComparedWithItsPlugin_thenNamePackageSchemesAndBrandsMatch",
    async (id, entry) => {
      const manifest = JSON.parse(await readFile(join(SOURCE_PLUGINS, id, MANIFEST_FILE), "utf8")) as {
        name: string;
        brands?: { id: string; name: string }[];
        connection?: { url?: { schemes: string[] } };
      };

      expect(entry.name).toBe(manifest.name);
      expect(entry.brands).toEqual(manifest.brands ?? []);
      expect(entry.packageName).toBe(`@tablecraft-app/plugin-${id}`);
      expect(entry.schemes).toEqual(manifest.connection?.url?.schemes ?? []);
    },
  );
});
