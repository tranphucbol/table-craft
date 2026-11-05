import type {
  Brand,
  CatalogPlugin,
  PluginInfo,
  PluginInstallState,
  PluginNeed,
  PluginRegistryState,
  PluginSource,
  RegistryCheck,
} from "@table-craft/desktop/preload/bridge.js";
import { formatBytes, relativeTime } from "@table-craft/desktop/renderer/model/format.js";

const PERCENT = 100;

/**
 * One line of the New Data Source picker: a product an installed plugin speaks (null when it names
 * none), or a plugin TableCraft can download.
 */
export type PickerEntry =
  | { readonly kind: "plugin"; readonly plugin: PluginInfo; readonly brand: Brand | null }
  | { readonly kind: "download"; readonly entry: CatalogPlugin };

export const SOURCE_LABELS: Readonly<Record<PluginSource, string>> = {
  builtIn: "Built in",
  development: "Development build",
  managed: "Downloaded",
  user: "Your plugin",
};

/** What makes `pluginId` usable when every installed plugin with that id is unavailable for its API version. */
export function pluginNeed(plugins: readonly PluginInfo[], pluginId: string): PluginNeed | null {
  const installed = plugins.filter((plugin) => plugin.id === pluginId);
  if (installed.some((plugin) => plugin.unavailableReason === null)) return null;
  return installed.find((plugin) => plugin.needs !== null)?.needs ?? null;
}

/**
 * The catalog entry for `pluginId` while no plugin with that id is installed, or only one built for
 * an older TableCraft (decision 155); it can be downloaded.
 */
export function missingPlugin(
  catalog: readonly CatalogPlugin[],
  plugins: readonly PluginInfo[],
  pluginId: string,
): CatalogPlugin | undefined {
  if (plugins.some((plugin) => plugin.id === pluginId) && pluginNeed(plugins, pluginId) !== "pluginUpdate") {
    return undefined;
  }
  return catalog.find((entry) => entry.id === pluginId);
}

/** True when the only plugins installed for `pluginId` need a newer TableCraft. */
export function needsNewerApp(plugins: readonly PluginInfo[], pluginId: string): boolean {
  return pluginNeed(plugins, pluginId) === "appUpdate";
}

/** Each product the installed plugins speak, and the downloadable plugins not installed, by name. */
export function pickerEntries(
  plugins: readonly PluginInfo[],
  catalog: readonly CatalogPlugin[],
): readonly PickerEntry[] {
  const installed = plugins.flatMap((plugin): PickerEntry[] =>
    plugin.brands.length === 0
      ? [{ kind: "plugin", plugin, brand: null }]
      : plugin.brands.map((brand) => ({ kind: "plugin", plugin, brand })),
  );
  const downloadable = catalog
    .filter((entry) => !plugins.some((plugin) => plugin.id === entry.id))
    .map((entry): PickerEntry => ({ kind: "download", entry }));
  return [...installed, ...downloadable].sort((a, b) => entryName(a).localeCompare(entryName(b)));
}

export function entryName(entry: PickerEntry): string {
  if (entry.kind === "download") return entry.entry.name;
  return entry.brand?.name ?? entry.plugin.name;
}

/** "Download (about 781.3 KB)". */
export function downloadLabel(entry: CatalogPlugin): string {
  return `Download (about ${formatBytes(entry.approximateBytes)})`;
}

/** "Installing PostgreSQL… 40%" while it downloads, the failure after, null when idle. */
export function installText(entry: CatalogPlugin): string | null {
  const { install } = entry;
  if (install.status === "idle") return null;
  if (install.status === "failed") return install.message;
  return `Installing ${entry.name}…${percentText(install)}`;
}

function percentText(install: Extract<PluginInstallState, { status: "installing" }>): string {
  if (install.total === null || install.total === 0) return "";
  return ` ${String(Math.min(PERCENT, Math.floor((install.received / install.total) * PERCENT)))}%`;
}

export interface MissingText {
  /** Short enough to sit beside a data source's name in the Database pane. */
  readonly text: string;
  readonly title: string;
}

export const NEWER_APP_TEXT: MissingText = {
  text: "Needs a newer TableCraft",
  title: "This plugin was built for a newer TableCraft. Update TableCraft to use it.",
};

/**
 * What a data source whose plugin is missing, or built for an older TableCraft (`outdated`), shows:
 * a short state, with the whole story as its tooltip.
 */
export function missingText(entry: CatalogPlugin, outdated = false): MissingText {
  const { install } = entry;
  if (install.status === "failed") {
    return { text: outdated ? "Update failed" : "Install failed", title: `${install.message} ${install.hint}` };
  }
  if (install.status === "installing") {
    const text = `${outdated ? "Updating" : "Installing"}…${percentText(install)}`;
    return { text, title: outdated ? `Updating ${entry.name}…${percentText(install)}` : (installText(entry) ?? "") };
  }
  if (outdated) {
    return {
      text: "Update needed",
      title: `The ${entry.name} plugin was built for an older TableCraft. Update downloads the build for this one.`,
    };
  }
  return {
    text: "Plugin missing",
    title: `The ${entry.name} plugin is not installed. Install downloads it; Settings → Plugins manages plugins.`,
  };
}

/** Why an installed plugin cannot be used, as the Plugins page says it; null when it can. */
export function unavailableText(plugin: PluginInfo): string | null {
  if (plugin.unavailableReason === null) return null;
  return plugin.needs === "appUpdate" ? `${NEWER_APP_TEXT.text}.` : plugin.unavailableReason;
}

/** "PostgreSQL 1.4.0 · Downloaded". */
export function pluginVersionText(plugin: PluginInfo): string {
  const version = plugin.version === null ? "" : ` ${plugin.version}`;
  return `${plugin.name}${version} · ${SOURCE_LABELS[plugin.source]}`;
}

export const REGISTRY_REMOVED_TEXT = "Registry removed";
export const REFUSED_UPDATE_TEXT = "Update failed: the registry refused the token.";

/**
 * Where an installed plugin comes from, as its row says it: the name of the private registry it
 * was installed from, "Registry removed" once that registry is gone (plan 154), else its source.
 */
export function registryLabel(
  plugin: PluginInfo,
  registries: readonly PluginRegistryState[],
  registryRemoved: readonly string[],
): string {
  if (plugin.source !== "managed") return SOURCE_LABELS[plugin.source];
  if (registryRemoved.includes(plugin.id)) return REGISTRY_REMOVED_TEXT;
  return registries.find((registry) => registry.plugins.includes(plugin.id))?.name ?? SOURCE_LABELS.managed;
}

/** The private registry `pluginId` was installed from, while it is configured. */
export function registryOfPlugin(
  registries: readonly PluginRegistryState[],
  pluginId: string,
): PluginRegistryState | undefined {
  return registries.find((registry) => registry.plugins.includes(pluginId));
}

/** "Reached 3 min ago", "Token refused (401) just now", "Unreachable 2 min ago". */
export function registryCheckText(check: RegistryCheck, now: number): string {
  const when = relativeTime(check.at, now);
  if (check.status === "reached") return `Reached ${when}`;
  if (check.status === "refused") return `Token refused (${String(check.httpStatus)}) ${when}`;
  return `Unreachable ${when}`;
}

/** The host a registry's token is sent to: "gitlab.example.com". */
export function registryHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
