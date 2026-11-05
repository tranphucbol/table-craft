/**
 * Installs, updates and removes downloaded plugins (decision 110). Electron and the filesystem's
 * owner arrive as options, so this runs under Vitest against a loopback registry.
 */
import {
  catalogEntry,
  hostPlatform,
  OFFICIAL_SCOPE,
  packageFor,
  type CatalogEntry,
} from "@table-craft/desktop/main/pluginStore/catalog.js";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import {
  installManaged,
  listManaged,
  removeManaged,
  type ManagedPlugin,
} from "@table-craft/desktop/main/pluginStore/managed.js";
import {
  checkIntegrity,
  downloadTarball,
  fetchPackument,
  isNewerRelease,
  officialRegistry,
  pickVersion,
  type RegistryFetch,
} from "@table-craft/desktop/main/pluginStore/registry.js";
import { readPackageJson, type PackageJson } from "@table-craft/desktop/main/pluginStore/packageFile.js";
import { readPackageTarball, type PackageFile } from "@table-craft/desktop/main/pluginStore/tarball.js";
import { compareVersions } from "@table-craft/desktop/main/update/manifest.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";
import type { Logger } from "@table-craft/desktop/log/record.js";

export type InstallProgress =
  | { readonly status: "idle" }
  | { readonly status: "installing"; readonly received: number; readonly total: number | null }
  | { readonly status: "failed"; readonly message: string; readonly hint: string };

const IDLE: InstallProgress = { status: "idle" };

export interface InstallerOptions {
  /** `<userData>/managed-plugins`. */
  readonly root: string;
  readonly registryUrl: () => string;
  readonly fetch: RegistryFetch;
  readonly hostVersion?: string;
  /** Which versions the registry offers; stable when absent. Read at every install. */
  readonly channel?: () => ReleaseChannel;
  /** Null when the folder's manifest is valid, compatible and names `id`; otherwise why not. */
  readonly check: (directory: string, id: string) => Promise<string | null>;
  /** Plugin ids that ship inside the app; a file may not replace one. */
  readonly builtIn: () => readonly string[];
  /** Names of saved data sources that use the plugin; Remove is refused while any does. */
  readonly usedBy: (pluginId: string) => readonly string[];
  /** After every progress or install change, so main can rediscover and tell the windows. */
  readonly onChanged: (installed: boolean) => void;
  readonly log: Logger;
  /** `<process.platform>-<process.arch>`; which package a native plugin downloads as (decision 156). */
  readonly platform?: string;
}

export interface InstallOutcome {
  readonly id: string;
  readonly version: string;
  /** False when the newest compatible version was already current. */
  readonly changed: boolean;
}

export interface PluginInstaller {
  progress(id: string): InstallProgress;
  install(id: string): Promise<InstallOutcome>;
  /** A `.tgz` the user picked; the confirmation (decision 006) was asked before this. */
  installFile(bytes: Uint8Array): Promise<InstallOutcome>;
  remove(id: string): Promise<void>;
  /** Installs a newer compatible version of each registry plugin; failures are logged, never thrown. */
  updateAll(): Promise<InstallOutcome[]>;
  managed(): Promise<ManagedPlugin[]>;
}

function failureOf(cause: unknown): { message: string; hint: string } {
  if (cause instanceof PluginInstallError) return { message: cause.message, hint: cause.hint };
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    hint: "Try again; if it persists, export diagnostics from the Help menu and report it.",
  };
}

export function createPluginInstaller(options: InstallerOptions): PluginInstaller {
  const progress = new Map<string, InstallProgress>();
  const running = new Map<string, Promise<InstallOutcome>>();
  const log = options.log;
  const platform = options.platform ?? hostPlatform();

  function setProgress(id: string, next: InstallProgress, installed = false): void {
    progress.set(id, next);
    options.onChanged(installed);
  }

  function officialEntry(id: string): CatalogEntry {
    const entry = catalogEntry(id);
    if (entry === undefined) {
      throw new PluginInstallError(
        "notFound",
        `"${id}" is not a plugin TableCraft can download.`,
        "Install it from a file in Settings → Plugins.",
      );
    }
    return entry;
  }

  function packageOf(entry: CatalogEntry): string {
    const name = packageFor(entry, platform);
    if (name === null) {
      throw new PluginInstallError(
        "unsupportedPlatform",
        `${entry.name} has no build for this computer (${platform}).`,
        `It is published for ${(entry.platforms ?? []).join(", ")}.`,
      );
    }
    return name;
  }

  async function stage(files: readonly PackageFile[], meta: PackageJson, source: ManagedPlugin["source"]) {
    return installManaged(options.root, {
      id: meta.id,
      version: meta.version,
      packageName: meta.name,
      source,
      files,
      check: (directory) => options.check(directory, meta.id),
    });
  }

  /**
   * A beta installed before the user left the beta channel stays until a stable release passes it,
   * as the app itself does; replacing it with an older stable would undo its fixes and data formats.
   */
  async function keeps(current: ManagedPlugin, picked: string): Promise<boolean> {
    if (current.version === picked) return true;
    if (compareVersions(picked, current.version) > 0) return false;
    return (await options.check(current.directory, current.id)) === null;
  }

  async function download(id: string): Promise<InstallOutcome> {
    const entry = officialEntry(id);
    const packageName = packageOf(entry);
    const registry = options.registryUrl();
    const access = officialRegistry(registry);
    const packument = await fetchPackument(options.fetch, access, packageName);
    const picked = pickVersion(packument, id, packageName, options.hostVersion, options.channel?.() ?? "stable");
    const current = (await listManaged(options.root)).find((plugin) => plugin.id === id);
    if (current?.source === "registry" && (await keeps(current, picked.version))) {
      return { id, version: current.version, changed: false };
    }
    log.info("plugin download started", { pluginId: id, version: picked.version, registry });
    const bytes = await downloadTarball(options.fetch, access, picked.tarball, (received, total) =>
      setProgress(id, { status: "installing", received, total }),
    );
    checkIntegrity(bytes, { integrity: picked.integrity }, packageName, false);
    const files = readPackageTarball(bytes);
    const meta = readPackageJson(files);
    if (meta.id !== id || meta.name !== packageName || meta.version !== picked.version) {
      throw new PluginInstallError(
        "invalid",
        `The registry's ${packageName} ${picked.version} holds ${meta.name} ${meta.version} (${meta.id}).`,
        "Nothing was installed. Check the registry in Settings → Plugins.",
      );
    }
    const installed = await stage(files, meta, "registry");
    log.info("plugin installed", { pluginId: id, version: installed.version, directory: installed.directory });
    return { id, version: installed.version, changed: true };
  }

  function install(id: string): Promise<InstallOutcome> {
    const pending = running.get(id);
    if (pending !== undefined) return pending;
    setProgress(id, { status: "installing", received: 0, total: null });
    const started = download(id)
      .then(
        (outcome) => {
          setProgress(id, IDLE, outcome.changed);
          return outcome;
        },
        (cause: unknown) => {
          const failure = failureOf(cause);
          log.warn("plugin install failed", { pluginId: id, error: failure.message });
          setProgress(id, { status: "failed", ...failure });
          throw cause;
        },
      )
      .finally(() => running.delete(id));
    running.set(id, started);
    return started;
  }

  async function installFile(bytes: Uint8Array): Promise<InstallOutcome> {
    const files = readPackageTarball(bytes);
    const meta = readPackageJson(files);
    if (options.builtIn().includes(meta.id)) {
      throw new PluginInstallError(
        "builtIn",
        `"${meta.id}" ships with TableCraft and cannot be replaced from a file.`,
        "Update TableCraft to update it.",
      );
    }
    if (meta.platform !== undefined && meta.platform !== platform) {
      const entry = catalogEntry(meta.id);
      const wanted = entry === undefined ? null : packageFor(entry, platform);
      throw new PluginInstallError(
        "unsupportedPlatform",
        `${meta.name} is built for ${meta.platform}, not this computer (${platform}).`,
        wanted === null ? "Pick the package built for this computer." : `Pick ${wanted} instead.`,
      );
    }
    const installed = await stage(files, meta, "file");
    log.info("plugin installed from file", {
      pluginId: meta.id,
      packageName: meta.name,
      version: installed.version,
      official: meta.name.startsWith(OFFICIAL_SCOPE),
    });
    setProgress(meta.id, IDLE, true);
    return { id: meta.id, version: installed.version, changed: true };
  }

  async function remove(id: string): Promise<void> {
    const users = options.usedBy(id);
    if (users.length > 0) {
      throw new PluginInstallError(
        "inUse",
        `The plugin is used by ${users.map((name) => `"${name}"`).join(", ")}.`,
        "Delete those data sources first, then remove the plugin.",
      );
    }
    await removeManaged(options.root, id);
    log.info("plugin removed", { pluginId: id });
    setProgress(id, IDLE, true);
  }

  async function updateAll(): Promise<InstallOutcome[]> {
    const outcomes: InstallOutcome[] = [];
    for (const plugin of await listManaged(options.root)) {
      if (plugin.source !== "registry" || catalogEntry(plugin.id) === undefined) continue;
      try {
        const outcome = await install(plugin.id);
        if (outcome.changed) {
          log.info("plugin updated", { pluginId: plugin.id, from: plugin.version, to: outcome.version });
        }
        outcomes.push(outcome);
      } catch {
        // Silent, as the app's own update check is (decision 110); install() logged it.
      }
    }
    return outcomes;
  }

  return {
    progress: (id) => progress.get(id) ?? IDLE,
    install,
    installFile,
    remove,
    updateAll,
    managed: () => listManaged(options.root),
  };
}

/** True when `version` would replace `current`; exported for the Settings page's Update state. */
export function wouldUpdate(version: string, current: string): boolean {
  return isNewerRelease(version, current);
}
