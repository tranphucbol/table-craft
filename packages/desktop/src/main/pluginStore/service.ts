/**
 * Main's view of every installed plugin and the downloads behind it (decision 110). It owns the
 * plugin roots the engines boot with, so a plugin installed while the app runs loads on the next
 * session open without a restart, while running engines keep what they imported.
 */
import { sep } from "node:path";
import type { PluginRoot } from "@table-craft/core";
import { PLUGIN_CATALOG } from "@table-craft/desktop/main/pluginStore/catalog.js";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import {
  createPluginInstaller,
  type InstallOutcome,
  type PluginInstaller,
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
import type { PluginInfo, PluginSource, PluginsState } from "@table-craft/desktop/preload/bridge.js";

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
  readonly onChanged: (state: PluginsState) => void;
  readonly log: Logger;
}

export interface PluginService {
  /** Prunes old downloaded versions and discovers every plugin; call once before any engine starts. */
  start(): Promise<PluginReport[]>;
  roots(): readonly PluginRoot[];
  plugins(): readonly PluginInfo[];
  report(): readonly PluginReport[];
  state(): PluginsState;
  install(pluginId: string): Promise<InstallOutcome>;
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
}

const UPDATING_REASON = "Built for an older TableCraft. Updating…";

function within(directory: string, root: string): boolean {
  return directory.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function createPluginService(options: PluginServiceOptions): PluginService {
  let managed: ManagedPlugin[] = [];
  let installed: InstalledPlugins = { plugins: [], report: [] };
  const log = options.log;

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

  /** Only a registry download is replaced: a plugin installed from a file stays what its user chose. */
  function outdated(): string[] {
    const ids = installed.plugins
      .filter(
        (plugin, index) =>
          plugin.needs === "pluginUpdate" &&
          PLUGIN_CATALOG.some((entry) => entry.id === plugin.id) &&
          managedAt(installed.report[index]?.directory ?? "")?.source === "registry",
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

  function state(): PluginsState {
    return {
      plugins: plugins(),
      catalog: PLUGIN_CATALOG.map((entry) => {
        const plugin = installed.plugins.find((info) => info.id === entry.id && info.unavailableReason === null);
        return { ...entry, installedVersion: plugin?.version ?? null, install: installer.progress(entry.id) };
      }),
    };
  }

  async function rediscover(): Promise<void> {
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
  };
}
