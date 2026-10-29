import type {
  Brand,
  CatalogPlugin,
  PluginInfo,
  PluginInstallState,
  PluginSource,
} from "@table-craft/desktop/preload/bridge.js";
import { formatBytes } from "@table-craft/desktop/renderer/model/format.js";

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

/** The catalog entry for `pluginId` while no plugin with that id is installed; it can be downloaded. */
export function missingPlugin(
  catalog: readonly CatalogPlugin[],
  plugins: readonly PluginInfo[],
  pluginId: string,
): CatalogPlugin | undefined {
  if (plugins.some((plugin) => plugin.id === pluginId)) return undefined;
  return catalog.find((entry) => entry.id === pluginId);
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

/** What a data source whose plugin is missing shows: a short state, with the whole story as its tooltip. */
export function missingText(entry: CatalogPlugin): MissingText {
  const { install } = entry;
  if (install.status === "failed") return { text: "Install failed", title: `${install.message} ${install.hint}` };
  if (install.status === "installing") {
    return { text: `Installing…${percentText(install)}`, title: installText(entry) ?? "" };
  }
  return {
    text: "Plugin missing",
    title: `The ${entry.name} plugin is not installed. Install downloads it; Settings → Plugins manages plugins.`,
  };
}

/** "PostgreSQL 1.4.0 · Downloaded". */
export function pluginVersionText(plugin: PluginInfo): string {
  const version = plugin.version === null ? "" : ` ${plugin.version}`;
  return `${plugin.name}${version} · ${SOURCE_LABELS[plugin.source]}`;
}
