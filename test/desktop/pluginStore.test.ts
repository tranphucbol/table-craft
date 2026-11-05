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
const OUTSIDE_CATALOG = "clickhouse";
const HOST = "linux-x64";
const DUCKDB_PACKAGE = `@tablecraft-app/plugin-duckdb-${HOST}`;
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
  extra: Pick<PluginServiceOptions, "channel" | "hostVersion" | "platform"> = {},
): PluginService {
  return createPluginService({
    platform: HOST,
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

async function started(
  registryUrl?: string,
  extra: Pick<PluginServiceOptions, "platform"> = {},
): Promise<PluginService> {
  const plugins = service(registryUrl, extra);
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
      expect.objectContaining({ id: "duckdb", packageName: DUCKDB_PACKAGE, installedVersion: null }),
    ]);
  });

  describe("native plugins", () => {
    const DUCKDB_RELEASE = release({ id: "duckdb", version: "1.0.0", platform: HOST });

    it("givenNativePlugin_whenInstalled_thenTheHostPlatformPackageIsManaged", async () => {
      registry.publish(DUCKDB_PACKAGE, [DUCKDB_RELEASE]);
      const plugins = await started();

      const outcome = await plugins.install("duckdb");

      expect(outcome).toEqual({ id: "duckdb", version: "1.0.0", changed: true });
      expect((await listManaged(managedRoot()))[0]).toMatchObject({ id: "duckdb", packageName: DUCKDB_PACKAGE });
      expect(registry.requests.every((path) => path.includes("plugin-duckdb-linux-x64"))).toBe(true);
    });

    it("givenPlatformWithoutPackage_whenInstalled_thenUnsupportedPlatformAndNothingDownloaded", async () => {
      const plugins = await started(registry.url, { platform: "freebsd-x64" });

      const error = await rejectionOf(plugins.install("duckdb"));

      expect(error.failure).toBe("unsupportedPlatform");
      expect(error.message).toContain("freebsd-x64");
      expect(registry.requests).toEqual([]);
      expect(plugins.state().catalog.map((entry) => entry.id)).not.toContain("duckdb");
    });

    it("givenOtherPlatformsPackageFile_whenInstalled_thenRefusedNamingTheRightPackage", async () => {
      const plugins = await started();

      const error = await rejectionOf(
        plugins.installFile(pluginTarball({ id: "duckdb", version: "1.0.0", platform: "win32-x64" })),
      );

      expect(error.failure).toBe("unsupportedPlatform");
      expect(error.hint).toContain(DUCKDB_PACKAGE);
      expect(await listManaged(managedRoot())).toEqual([]);
    });

    it("givenOutdatedDuckdbFromRegistry_whenLaunch_thenHostPlatformPackageReinstalled", async () => {
      registry.publish(DUCKDB_PACKAGE, [
        release({ id: "duckdb", version: "1.0.0", apiVersion: "1.0.0", platform: HOST }),
      ]);
      const older = service(registry.url, { hostVersion: "1.10.0" });
      await older.start();
      await older.install("duckdb");
      registry.publish(DUCKDB_PACKAGE, [
        release({ id: "duckdb", version: "1.0.0", apiVersion: "1.0.0", platform: HOST }),
        release({ id: "duckdb", version: "2.0.0", platform: HOST }),
      ]);
      const plugins = await started();
      expect(plugins.outdated()).toEqual(["duckdb"]);

      await plugins.installMissing([]);

      expect(plugins.plugins().find((plugin) => plugin.id === "duckdb")).toMatchObject({
        version: "2.0.0",
        unavailableReason: null,
      });
      expect(registry.requests.some((path) => path.includes("plugin-duckdb-linux-x64-2.0.0.tgz"))).toBe(true);
    });
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

  it("givenOldCurrentJson_whenListing_thenOfficialRegistryAssumed", async () => {
    const directory = join(managedRoot(), "postgres", "1.0.0");
    await mkdir(directory, { recursive: true });
    const current = { version: "1.0.0", packageName: PACKAGE, source: "registry" };
    await writeFile(join(managedRoot(), "postgres", "current.json"), JSON.stringify(current));

    const [listed] = await listManaged(managedRoot());

    expect(listed).toEqual({ id: "postgres", ...current, directory });
    expect(listed?.registry).toBeUndefined();
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
      release({ id: "postgres", version: "2.0.0", apiVersion: "3.0.0" }),
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
      release({ id: "postgres", version: "1.1.0-beta.1", apiVersion: "2.1.0" }),
    ]);
    const beta = service(registry.url, { channel: () => "beta", hostVersion: "2.1.0" });
    await beta.start();
    await beta.install("postgres");
    const older = service(registry.url, { channel: () => "stable", hostVersion: "2.0.0" });
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

  describe("outdated plugins", () => {
    const OLDER_HOST = "1.10.0";
    const OLDER_API = "1.0.0";
    const OLD_RELEASE = release({ id: "postgres", version: "1.0.0", apiVersion: OLDER_API });
    const NEW_RELEASE = release({ id: "postgres", version: "2.0.0" });

    /** A profile an older TableCraft left: postgres 1.0.0, built for plugin API 1.x. */
    async function seedOlder(how: "registry" | "file"): Promise<void> {
      registry.publish(PACKAGE, [OLD_RELEASE]);
      const older = service(registry.url, { hostVersion: OLDER_HOST });
      await older.start();
      if (how === "registry") await older.install("postgres");
      else await older.installFile(pluginTarball({ id: "postgres", version: "1.0.0", apiVersion: OLDER_API }));
      changes = [];
      records = [];
    }

    const postgresOf = (plugins: PluginService) => plugins.plugins().find((plugin) => plugin.id === "postgres");

    it("givenManagedPluginOnOlderMajor_whenInstallMissing_thenReinstalledFromRegistry", async () => {
      await seedOlder("registry");
      registry.publish(PACKAGE, [OLD_RELEASE, NEW_RELEASE]);
      const plugins = await started();
      expect(postgresOf(plugins)).toMatchObject({
        needs: "pluginUpdate",
        unavailableReason: "Built for an older TableCraft. Updating…",
      });
      expect(plugins.outdated()).toEqual(["postgres"]);

      await plugins.installMissing([]);

      expect(postgresOf(plugins)).toMatchObject({ version: "2.0.0", unavailableReason: null, needs: null });
      expect(plugins.outdated()).toEqual([]);
      expect(messages()).toContain("plugin outdated; updating");
    });

    it("givenFileInstalledPluginOnOlderMajor_whenInstallMissing_thenLeftUnavailable", async () => {
      await seedOlder("file");
      registry.publish(PACKAGE, [OLD_RELEASE, NEW_RELEASE]);
      const plugins = await started();

      await plugins.installMissing(["postgres"]);

      expect(plugins.outdated()).toEqual([]);
      expect(postgresOf(plugins)).toMatchObject({ version: "1.0.0", needs: "pluginUpdate" });
      expect(postgresOf(plugins)?.unavailableReason).toContain("an older major");
      expect(await plugins.updateOutdated("postgres")).toBe(false);
    });

    it("givenNoCompatibleVersionYet_whenInstallMissing_thenFailedStateAndRetryLater", async () => {
      await seedOlder("registry");
      const plugins = await started();

      await plugins.installMissing([]);

      expect(plugins.state().catalog[0]?.install.status).toBe("failed");
      expect(postgresOf(plugins)?.unavailableReason).toMatch(/^Update failed: /);
      await expect(plugins.updateOutdated("postgres")).rejects.toBeInstanceOf(PluginInstallError);

      registry.publish(PACKAGE, [OLD_RELEASE, NEW_RELEASE]);
      expect(await plugins.updateOutdated("postgres")).toBe(true);
      expect(postgresOf(plugins)).toMatchObject({ version: "2.0.0", unavailableReason: null });
    });

    it("givenAutomaticChecksOff_whenLaunchedWithOutdatedPlugin_thenStillUpdated", async () => {
      await seedOlder("registry");
      registry.publish(PACKAGE, [OLD_RELEASE, NEW_RELEASE]);
      const plugins = await started();

      // The launch call `startBackground` makes before it builds the schedule `checkAutomatically` gates.
      await plugins.installMissing([]);

      expect(postgresOf(plugins)).toMatchObject({ version: "2.0.0", unavailableReason: null });
      expect(registry.requests.some((path) => path.includes("postgres-2.0.0.tgz"))).toBe(true);
    });
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
