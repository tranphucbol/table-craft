/**
 * Installs, updates and removes downloaded plugins (decision 110). Electron and the filesystem's
 * owner arrive as options, so this runs under Vitest against a loopback registry.
 */
import type { Brand } from "@table-craft/plugin-api";
import {
  catalogEntry,
  hostPlatform,
  installedRegistry,
  OFFICIAL_SCOPE,
  packageFor,
  registryFor,
  type CatalogEntry,
} from "@table-craft/desktop/main/pluginStore/catalog.js";
import { PluginInstallError } from "@table-craft/desktop/main/pluginStore/errors.js";
import {
  readKnownPackages,
  rememberPackage,
  type KnownPackage,
} from "@table-craft/desktop/main/pluginStore/knownPackages.js";
import {
  installManaged,
  listManaged,
  removeManaged,
  type ManagedPlugin,
} from "@table-craft/desktop/main/pluginStore/managed.js";
import { resolvePrivateRelease } from "@table-craft/desktop/main/pluginStore/privatePackage.js";
import {
  checkIntegrity,
  downloadTarball,
  fetchPackument,
  isNewerRelease,
  officialRegistry,
  pickVersion,
  type RegistryAccess,
  type RegistryFetch,
} from "@table-craft/desktop/main/pluginStore/registry.js";
import { readPackageJson, type PackageJson } from "@table-craft/desktop/main/pluginStore/packageFile.js";
import { readPackageTarball, type PackageFile } from "@table-craft/desktop/main/pluginStore/tarball.js";
import { compareVersions } from "@table-craft/desktop/main/update/manifest.js";
import type { ReleaseChannel } from "@table-craft/desktop/settings/channel.js";
import { OFFICIAL_PLUGIN_SCOPE, packageScope, type PluginRegistry } from "@table-craft/desktop/settings/settings.js";
import type { Logger } from "@table-craft/desktop/log/record.js";

export type InstallProgress =
  | { readonly status: "idle" }
  | { readonly status: "installing"; readonly received: number; readonly total: number | null }
  | { readonly status: "failed"; readonly message: string; readonly hint: string };

const IDLE: InstallProgress = { status: "idle" };
const NO_PACKAGES: ReadonlyMap<string, KnownPackage> = new Map();

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
  /** The private registries of settings (decision 158); none when absent. */
  readonly registries?: () => readonly PluginRegistry[];
  readonly registryToken?: (registryId: string) => string | undefined;
  /** `<userData>/plugin-packages.json`, where each private package's plugin id is remembered. */
  readonly packagesFile?: string;
  /** Asked before a plugin's first install from a private registry; refused when absent. */
  readonly confirm?: (request: PrivateInstallRequest) => Promise<boolean>;
  /** Adds an installed package to its registry's `packages` in settings. */
  readonly addPackage?: (registryId: string, packageName: string) => Promise<void>;
  /** Each private registry's answer to a download, for its card in Settings → Plugins. */
  readonly reached?: (registryId: string, outcome: RegistryOutcome) => void;
}

/** What the confirmation before a private registry's first install names (decision 158). */
export interface PrivateInstallRequest {
  readonly pluginId: string;
  readonly name: string;
  readonly packageName: string;
  readonly version: string;
  readonly registry: PluginRegistry;
  readonly brands: readonly Brand[];
  readonly bytes: number;
}

export type RegistryOutcome =
  { readonly ok: true; readonly integrity: "sha512" | "sha1" | null } | { readonly ok: false; readonly error: unknown };

export interface InstallOutcome {
  readonly id: string;
  readonly version: string;
  /** False when the newest compatible version was already current. */
  readonly changed: boolean;
}

export interface PluginInstaller {
  progress(id: string): InstallProgress;
  install(id: string): Promise<InstallOutcome>;
  /** A package a private registry serves, typed by the user; its progress is keyed by the package name. */
  installPackage(packageName: string): Promise<InstallOutcome>;
  /** A `.tgz` the user picked; the confirmation (decision 006) was asked before this. */
  installFile(bytes: Uint8Array): Promise<InstallOutcome>;
  remove(id: string): Promise<void>;
  /** Installs a newer compatible version of each registry plugin; failures are logged, never thrown. */
  updateAll(): Promise<InstallOutcome[]>;
  managed(): Promise<ManagedPlugin[]>;
}

/** A plugin id never holds a slash; a scoped package name always does. */
function targetOf(key: string): { pluginId: string } | { packageName: string } {
  return key.includes("/") ? { packageName: key } : { pluginId: key };
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

  async function stage(
    files: readonly PackageFile[],
    meta: PackageJson,
    source: ManagedPlugin["source"],
    registry?: string,
  ) {
    return installManaged(options.root, {
      id: meta.id,
      version: meta.version,
      packageName: meta.name,
      source,
      ...(registry === undefined ? {} : { registry }),
      files,
      check: (directory) => options.check(directory, meta.id),
    });
  }

  const registries = () => options.registries?.() ?? [];

  function privateAccess(registry: PluginRegistry): RegistryAccess {
    return { url: registry.url, token: options.registryToken?.(registry.id) ?? null, private: true };
  }

  /** The private registry a package's scope routes to; refused before anything is downloaded. */
  function routeOf(packageName: string): PluginRegistry {
    const scope = packageScope(packageName);
    if (scope === OFFICIAL_PLUGIN_SCOPE) {
      throw new PluginInstallError(
        "notFound",
        `${packageName} is an official TableCraft package.`,
        "Install it from Available in Settings → Plugins.",
      );
    }
    const registry = registryFor(packageName, registries());
    if (registry === null) {
      throw new PluginInstallError(
        "notFound",
        `No registry in Settings → Plugins serves ${scope ?? packageName}.`,
        `Add a registry for ${scope ?? "the package's scope"} under Registries, then install it again.`,
      );
    }
    return registry;
  }

  /** Decision 158: a private package adds a plugin; it never replaces one TableCraft provides or another package installed. */
  function refuseTaken(id: string, packageName: string, installed: readonly ManagedPlugin[]): void {
    if (options.builtIn().includes(id) || catalogEntry(id) !== undefined) {
      throw new PluginInstallError(
        "builtIn",
        `${packageName} holds the plugin "${id}", which TableCraft provides itself.`,
        "Nothing was installed. A private registry adds plugins; it cannot replace TableCraft's own.",
      );
    }
    const other = installed.find((plugin) => plugin.id === id && plugin.packageName !== packageName);
    if (other !== undefined) {
      throw new PluginInstallError(
        "invalid",
        `${packageName} holds the plugin "${id}", already installed from ${other.packageName}.`,
        `Nothing was installed. Remove "${id}" first to install it from ${packageName}.`,
      );
    }
  }

  async function confirmed(request: PrivateInstallRequest): Promise<void> {
    if ((await options.confirm?.(request)) === true) return;
    throw new PluginInstallError("cancelled", `The install of ${request.packageName} was cancelled.`, "");
  }

  async function downloadPrivate(packageName: string, registry: PluginRegistry, key: string): Promise<InstallOutcome> {
    const installed = await listManaged(options.root);
    const current = installed.find((plugin) => plugin.packageName === packageName && plugin.source === "registry");
    log.info("plugin download started", { packageName, registry: registry.url });
    let release: Awaited<ReturnType<typeof resolvePrivateRelease>>;
    try {
      release = await resolvePrivateRelease({
        fetch: options.fetch,
        access: privateAccess(registry),
        packageName,
        channel: options.channel?.() ?? "stable",
        ...(options.hostVersion === undefined ? {} : { hostVersion: options.hostVersion }),
        onProgress: (received, total) => setProgress(key, { status: "installing", received, total }),
        ...(current === undefined ? {} : { keeps: (version: string) => keeps(current, version) }),
      });
    } catch (cause) {
      options.reached?.(registry.id, { ok: false, error: cause });
      throw cause;
    }
    options.reached?.(registry.id, { ok: true, integrity: release?.integrity ?? null });
    if (release === null) return { id: current?.id ?? key, version: current?.version ?? "", changed: false };
    const { meta, summary } = release;
    refuseTaken(meta.id, packageName, installed);
    if (!installed.some((plugin) => plugin.id === meta.id && plugin.registry === registry.id)) {
      await confirmed({
        pluginId: meta.id,
        name: summary.name,
        packageName,
        version: meta.version,
        registry,
        brands: summary.brands,
        bytes: release.bytes,
      });
    }
    const staged = await stage(release.files, meta, "registry", registry.id);
    if (options.packagesFile !== undefined) {
      await rememberPackage(options.packagesFile, packageName, {
        id: meta.id,
        name: summary.name,
        brands: summary.brands,
        schemes: summary.schemes,
        bytes: release.bytes,
      });
    }
    if (!registry.packages.includes(packageName)) await options.addPackage?.(registry.id, packageName);
    log.info("plugin installed", { pluginId: meta.id, version: staged.version, directory: staged.directory });
    return { id: meta.id, version: staged.version, changed: true };
  }

  /** A plugin id outside the catalog: the package a private registry installed it from, or that settings and plugin-packages.json name. */
  async function privateSource(id: string): Promise<{ packageName: string; registry: PluginRegistry } | null> {
    const current = (await listManaged(options.root)).find((plugin) => plugin.id === id);
    const known = options.packagesFile === undefined ? NO_PACKAGES : await readKnownPackages(options.packagesFile);
    const names =
      current?.registry !== undefined
        ? [current.packageName]
        : [...known].filter(([, entry]) => entry.id === id).map(([packageName]) => packageName);
    for (const packageName of names) {
      const registry = registryFor(packageName, registries());
      if (registry?.packages.includes(packageName) === true) return { packageName, registry };
    }
    return null;
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
    if (catalogEntry(id) === undefined) {
      const source = await privateSource(id);
      if (source !== null) return downloadPrivate(source.packageName, source.registry, id);
    }
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

  /** One install per key at a time, its progress under `key`: a plugin id, or a typed package name. */
  function track(key: string, work: () => Promise<InstallOutcome>): Promise<InstallOutcome> {
    const pending = running.get(key);
    if (pending !== undefined) return pending;
    setProgress(key, { status: "installing", received: 0, total: null });
    const started = work()
      .then(
        (outcome) => {
          setProgress(key, IDLE, outcome.changed);
          return outcome;
        },
        (cause: unknown) => {
          if (cause instanceof PluginInstallError && cause.failure === "cancelled") {
            log.info("plugin install cancelled", targetOf(key));
            setProgress(key, IDLE);
            throw cause;
          }
          const failure = failureOf(cause);
          log.warn("plugin install failed", { ...targetOf(key), error: failure.message });
          setProgress(key, { status: "failed", ...failure });
          throw cause;
        },
      )
      .finally(() => running.delete(key));
    running.set(key, started);
    return started;
  }

  const install = (id: string) => track(id, () => download(id));

  const installPackage = (packageName: string) =>
    track(packageName, async () => downloadPrivate(packageName, routeOf(packageName), packageName));

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
      if (plugin.source !== "registry") continue;
      const official = plugin.registry === undefined && catalogEntry(plugin.id) !== undefined;
      if (!official && installedRegistry(plugin, registries()) === null) continue;
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
    installPackage,
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
