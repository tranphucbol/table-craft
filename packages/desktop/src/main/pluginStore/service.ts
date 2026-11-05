/**
 * Main's view of every installed plugin and the downloads behind it (decision 110). It owns the
 * plugin roots the engines boot with, so a plugin installed while the app runs loads on the next
 * session open without a restart, while running engines keep what they imported.
 */
import { dirname, join, sep } from "node:path";
import type { PluginRoot } from "@table-craft/core";
import {
  catalogEntry,
  hostPlatform,
  installedRegistry,
  packageFor,
  PLUGIN_CATALOG,
} from "@table-craft/desktop/main/pluginStore/catalog.js";
import {
  PLUGIN_PACKAGES_FILE,
  readKnownPackages,
  type KnownPackage,
} from "@table-craft/desktop/main/pluginStore/knownPackages.js";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import {
  createPluginInstaller,
  type InstallOutcome,
  type PluginInstaller,
  type PrivateInstallRequest,
  type RegistryOutcome,
} from "@table-craft/desktop/main/pluginStore/installer.js";
import { listManaged, pruneManaged, type ManagedPlugin } from "@table-craft/desktop/main/pluginStore/managed.js";
import type { RegistryFetch } from "@table-craft/desktop/main/pluginStore/registry.js";
import {
  discoverInstalled,
  manifestProblem,
  type InstalledPlugins,
  type PluginReport,
} from "@table-craft/desktop/main/plugins.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";
import type { Logger } from "@table-craft/desktop/log/record.js";
import type {
  CatalogPlugin,
  PluginInfo,
  PluginRegistryState,
  PluginSource,
  PluginsState,
  RegistryCheck,
  RegistryTestRequest,
} from "@table-craft/desktop/preload/bridge.js";
import { checkedPackage, checkRegistry } from "@table-craft/desktop/main/pluginStore/registryCheck.js";
import type { PluginRegistry } from "@table-craft/desktop/settings/settings.js";

export interface PluginServiceOptions {
  readonly builtInRoot: string;
  /** The development build's optional plugins; empty in a packaged app. */
  readonly developmentRoots: readonly string[];
  /** `<userData>/managed-plugins`. */
  readonly managedRoot: string;
  /** `<userData>/plugins`, the folders a user drops in (decision 005). */
  readonly userRoot: string;
  readonly registryUrl: () => string;
  readonly fetch: RegistryFetch;
  readonly hostVersion?: string;
  readonly channel?: () => ReleaseChannel;
  /** Names of the saved data sources on the plugin. */
  readonly usedBy: (pluginId: string) => readonly string[];
  /** Asked before a plugin's first install from a private registry; refused when absent. */
  readonly confirm?: (request: PrivateInstallRequest) => Promise<boolean>;
  /** Adds an installed package to its registry's `packages` in settings. */
  readonly addPackage?: (registryId: string, packageName: string) => Promise<void>;
  readonly onChanged: (state: PluginsState) => void;
  readonly log: Logger;
  /** `<process.platform>-<process.arch>`; a native plugin without a build for it is not offered. */
  readonly platform?: string;
  /** The private registries of settings (decision 158); none when absent. */
  readonly registries?: () => readonly PluginRegistry[];
  /** A private registry's stored token, read from the secret store at each request. */
  readonly registryToken?: (registryId: string) => string | undefined;
  /** Stores a registry's token, or forgets it for null. */
  readonly storeToken?: (registryId: string, token: string | null) => Promise<void>;
}

export interface PluginService {
  /** Prunes old downloaded versions and discovers every plugin; call once before any engine starts. */
  start(): Promise<PluginReport[]>;
  roots(): readonly PluginRoot[];
  plugins(): readonly PluginInfo[];
  report(): readonly PluginReport[];
  state(): PluginsState;
  install(pluginId: string): Promise<InstallOutcome>;
  /** A package a private registry serves (decision 158); rejects with `cancelled` when the user declined. */
  installPackage(packageName: string): Promise<InstallOutcome>;
  installFile(bytes: Uint8Array): Promise<InstallOutcome>;
  remove(pluginId: string): Promise<void>;
  updateAll(): Promise<InstallOutcome[]>;
  /**
   * Downloads each catalog plugin a saved data source names and no root provides (decision 110),
   * and each one downloaded from the registry for an older plugin API major (decision 155).
   */
  installMissing(pluginIds: readonly string[]): Promise<void>;
  /** The downloaded plugins built for an older plugin API major, which only an update makes usable. */
  outdated(): readonly string[];
  /**
   * Installs `pluginId`'s build for this TableCraft when it is outdated, sharing a download already
   * running; false when it is not outdated. Rejects when the update fails.
   */
  updateOutdated(pluginId: string): Promise<boolean>;
  /** Test connection; a saved registry tested with its stored token keeps the result for its card. */
  testRegistry(request: RegistryTestRequest): Promise<RegistryCheck>;
  /** Stores or, for null, forgets a registry's token; its last check no longer applies. */
  setRegistryToken(registryId: string, token: string | null): Promise<void>;
  /**
   * Settings changed: when the registries did, forgets the token and the check of each registry no
   * longer listed (decision 158) and tells the windows, since the registries are part of the state.
   */
  registriesChanged(): Promise<void>;
}

const UPDATING_REASON = "Built for an older TableCraft. Updating…";

function within(directory: string, root: string): boolean {
  return directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function createPluginService(options: PluginServiceOptions): PluginService {
  let managed: ManagedPlugin[] = [];
  let installed: InstalledPlugins = { plugins: [], report: [] };
  let known: ReadonlyMap<string, KnownPackage> = new Map();
  const packagesFile = join(dirname(options.managedRoot), PLUGIN_PACKAGES_FILE);
  const checks = new Map<string, RegistryCheck>();
  const weakIntegrity = new Set<string>();
  const typed = new Set<string>();
  let listed: ReadonlySet<string> | null = null;
  let listedJson: string | null = null;
  const log = options.log;
  const platform = options.platform ?? hostPlatform();

  function roots(): PluginRoot[] {
    return [
      options.builtInRoot,
      ...options.developmentRoots,
      ...managed.map((plugin) => ({ directory: plugin.directory })),
      options.userRoot,
    ];
  }

  function sourceOf(directory: string): PluginSource {
    if (within(directory, options.builtInRoot)) return "builtIn";
    if (options.developmentRoots.some((root) => within(directory, root))) return "development";
    if (within(directory, options.managedRoot)) return "managed";
    return "user";
  }

  const managedAt = (directory: string) =>
    managed.find((plugin) => directory === plugin.directory || within(directory, plugin.directory));

  /** A registry download, official or from a private registry that still names it (decision 158). */
  function updatable(plugin: ManagedPlugin | undefined): boolean {
    if (plugin?.source !== "registry") return false;
    if (plugin.registry === undefined) return PLUGIN_CATALOG.some((entry) => entry.id === plugin.id);
    return registryOf(plugin) !== null;
  }

  /** Only a registry download is replaced: a plugin installed from a file stays what its user chose. */
  function outdated(): string[] {
    const ids = installed.plugins
      .filter(
        (plugin, index) =>
          plugin.needs === "pluginUpdate" && updatable(managedAt(installed.report[index]?.directory ?? "")),
      )
      .map((plugin) => plugin.id)
      .filter((id) => !installed.plugins.some((plugin) => plugin.id === id && plugin.unavailableReason === null));
    return [...new Set(ids)];
  }

  function plugins(): PluginInfo[] {
    const updating = outdated();
    return installed.plugins.map((plugin) => {
      if (plugin.needs !== "pluginUpdate" || !updating.includes(plugin.id)) return plugin;
      const progress = installer.progress(plugin.id);
      const reason = progress.status === "failed" ? `Update failed: ${progress.message}` : UPDATING_REASON;
      return { ...plugin, unavailableReason: reason };
    });
  }

  const registries = () => options.registries?.() ?? [];
  const usableVersion = (id: string) =>
    installed.plugins.find((info) => info.id === id && info.unavailableReason === null)?.version ?? null;

  const registryOf = (plugin: ManagedPlugin) => installedRegistry(plugin, registries());

  function reached(registryId: string, outcome: RegistryOutcome): void {
    const at = Date.now();
    if (outcome.ok) {
      checks.set(registryId, { status: "reached", at });
      if (outcome.integrity === "sha1") weakIntegrity.add(registryId);
      if (outcome.integrity === "sha512") weakIntegrity.delete(registryId);
      return;
    }
    const error = outcome.error;
    if (!(error instanceof PluginInstallError)) return;
    if (error.failure === "unauthorized") {
      checks.set(registryId, { status: "refused", at, httpStatus: error.httpStatus ?? 0 });
    } else if (error.failure === "offline" || error.failure === "insecureUrl") {
      checks.set(registryId, { status: "failed", at, message: error.message });
    } else if (error.failure !== "notFound" || options.registryToken?.(registryId) !== undefined) {
      // Without a token, GitLab answers 404 for packages it serves, so a 404 then proves nothing.
      checks.set(registryId, { status: "reached", at });
    }
  }

  function privateCatalog(): CatalogPlugin[] {
    return registries().flatMap((registry) =>
      registry.packages.flatMap((packageName) => {
        const entry = known.get(packageName);
        if (entry === undefined || catalogEntry(entry.id) !== undefined) return [];
        return [
          {
            id: entry.id,
            name: entry.name,
            packageName,
            schemes: entry.schemes,
            brands: entry.brands,
            approximateBytes: entry.bytes,
            installedVersion: usableVersion(entry.id),
            install: installer.progress(entry.id),
            registryId: registry.id,
          },
        ];
      }),
    );
  }

  function registryStates(): PluginRegistryState[] {
    return registries().map((registry) => ({
      ...registry,
      tokenStored: options.registryToken?.(registry.id) !== undefined,
      integrity: weakIntegrity.has(registry.id) ? "sha1" : "sha512",
      check: checks.get(registry.id) ?? null,
      plugins: managed.filter((plugin) => registryOf(plugin)?.id === registry.id).map((plugin) => plugin.id),
    }));
  }

  function state(): PluginsState {
    return {
      plugins: plugins(),
      catalog: [
        ...PLUGIN_CATALOG.flatMap((entry) => {
          const packageName = packageFor(entry, platform);
          if (packageName === null) return [];
          const { platforms: _platforms, ...offered } = entry;
          return [
            {
              ...offered,
              packageName,
              installedVersion: usableVersion(entry.id),
              install: installer.progress(entry.id),
            },
          ];
        }),
        ...privateCatalog(),
      ],
      registries: registryStates(),
      registryRemoved: managed
        .filter((plugin) => plugin.registry !== undefined && registryOf(plugin) === null)
        .map((plugin) => plugin.id),
      packageInstalls: [...typed]
        .map((packageName) => ({ packageName, install: installer.progress(packageName) }))
        .filter((entry) => entry.install.status !== "idle"),
    };
  }

  async function rediscover(): Promise<void> {
    known = await readKnownPackages(packagesFile);
    managed = await listManaged(options.managedRoot);
    installed = await discoverInstalled(roots(), sourceOf, (directory) => managedAt(directory)?.version);
  }

  let pending: Promise<void> = Promise.resolve();
  function changed(didInstall: boolean): void {
    if (!didInstall) {
      options.onChanged(state());
      return;
    }
    pending = pending
      .then(rediscover)
      .catch((cause: unknown) => log.warn("plugin rediscovery failed", { error: String(cause) }))
      .then(() => options.onChanged(state()));
  }

  const installer: PluginInstaller = createPluginInstaller({
    root: options.managedRoot,
    registryUrl: options.registryUrl,
    fetch: options.fetch,
    ...(options.hostVersion === undefined ? {} : { hostVersion: options.hostVersion }),
    ...(options.channel === undefined ? {} : { channel: options.channel }),
    check: (directory, id) => manifestProblem(directory, id, options.hostVersion),
    builtIn: () => installed.plugins.filter((plugin) => plugin.source === "builtIn").map((plugin) => plugin.id),
    usedBy: options.usedBy,
    onChanged: changed,
    log,
    platform,
    registries,
    registryToken: (registryId) => options.registryToken?.(registryId),
    packagesFile,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.addPackage === undefined ? {} : { addPackage: options.addPackage }),
    reached,
  });

  /** Resolves once the windows were told about the install, so the caller's answer is current. */
  async function settled<T>(work: Promise<T>): Promise<T> {
    const result = await work;
    await pending;
    return result;
  }

  return {
    async start() {
      for (const path of await pruneManaged(options.managedRoot))
        log.info("plugin version pruned", { directory: path });
      await rediscover();
      return installed.report;
    },
    roots,
    plugins,
    report: () => installed.report,
    state,
    install: (pluginId) => settled(installer.install(pluginId)),
    installPackage(packageName) {
      typed.add(packageName);
      return settled(installer.installPackage(packageName));
    },
    installFile: (bytes) => settled(installer.installFile(bytes)),
    remove(pluginId) {
      if (!managed.some((plugin) => plugin.id === pluginId)) {
        return Promise.reject(
          new PluginInstallError(
            "builtIn",
            `"${pluginId}" was not downloaded, so TableCraft does not remove it.`,
            "A built-in plugin goes with the app; delete a user plugin's folder from the profile's plugins folder.",
          ),
        );
      }
      return settled(installer.remove(pluginId));
    },
    updateAll: () => settled(installer.updateAll()),
    async installMissing(pluginIds) {
      const stale = outdated();
      const missing = [...new Set(pluginIds)].filter(
        (id) =>
          PLUGIN_CATALOG.some((entry) => entry.id === id) && !installed.plugins.some((plugin) => plugin.id === id),
      );
      for (const id of [...missing, ...stale.filter((id) => !missing.includes(id))]) {
        const message = stale.includes(id) ? "plugin outdated; updating" : "plugin missing; installing";
        log.info(message, { pluginId: id, usedBy: options.usedBy(id) });
        await installer.install(id).catch(() => undefined);
      }
      await pending;
    },
    outdated,
    async updateOutdated(pluginId) {
      if (!outdated().includes(pluginId)) return false;
      await settled(installer.install(pluginId));
      return true;
    },
    async testRegistry(request) {
      const saved = registries().find((registry) => registry.id === request.registryId);
      const packageName = checkedPackage(saved?.packages ?? [], request.scopes);
      const stored = request.registryId === null ? undefined : options.registryToken?.(request.registryId);
      const token = request.token ?? stored ?? null;
      if (packageName === null) {
        return { status: "failed", at: Date.now(), message: "Add a scope, such as @acme, to test the registry." };
      }
      const check = await checkRegistry(
        options.fetch,
        { url: request.url, token, private: true },
        packageName,
        !(saved?.packages.includes(packageName) ?? false),
      );
      log.info("plugin registry tested", { registry: request.url, packageName, status: check.status });
      if (saved !== undefined && saved.url === request.url && request.token === null) {
        checks.set(saved.id, check);
        options.onChanged(state());
      }
      return check;
    },
    async setRegistryToken(registryId, token) {
      await options.storeToken?.(registryId, token);
      checks.delete(registryId);
      options.onChanged(state());
    },
    async registriesChanged() {
      const json = JSON.stringify(registries());
      if (json === listedJson) return;
      listedJson = json;
      const ids = new Set(registries().map((registry) => registry.id));
      const gone = listed === null ? [] : [...listed].filter((id) => !ids.has(id));
      listed = ids;
      for (const id of gone) {
        checks.delete(id);
        weakIntegrity.delete(id);
        await options.storeToken?.(id, null);
        log.info("plugin registry removed", { registryId: id });
      }
      options.onChanged(state());
    },
  };
}
