import type { DatasourceView, ImportApp, ImportSource, PluginInfo } from "@table-craft/desktop/preload/bridge.js";
import { compareVersions, isVersion } from "@table-craft/desktop/version/compare.js";

export type NoticeKind = "update" | "import" | "plugin" | "feature";

export interface NoticeAction {
  readonly label: string;
  readonly actionId: string;
  readonly args?: unknown;
}

export interface Notice {
  /** `update:1.9.0`, `import:datagrip`, `plugin:postgres:1.4.0` or `feature:<id>`. */
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly body: string;
  readonly action: NoticeAction | null;
  /** Running the action leaves it listed: an import notice waits for the import itself (plan 145 ruling 18). */
  readonly sticky: boolean;
}

/** A catalog entry announcing a feature; its id is stable because the tree never names a version. */
export interface FeatureNotice {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly action?: NoticeAction;
}

/** What the bell remembers between launches, so a notice that is gone stays gone. */
export interface NoticeMemory {
  /** The version last announced or recorded; null until a released version runs. */
  readonly version: string | null;
  readonly features: readonly string[];
  /** Plugin id to the version last announced or recorded. */
  readonly plugins: Readonly<Record<string, string>>;
  /** Import notices dismissed for good. */
  readonly dismissed: readonly string[];
  readonly read: readonly string[];
}

export interface NoticeInput {
  readonly appVersion: string;
  /** Null until the launch scan answers, or when it failed. */
  readonly importSources: readonly ImportSource[] | null;
  readonly datasources: readonly DatasourceView[];
  readonly plugins: readonly PluginInfo[];
  readonly features: readonly FeatureNotice[];
}

export const NOTICES_STORAGE_KEY = "table-craft.notices.v1";
/** What a development run reports (`main/main.ts`); it never announces an update. */
export const DEVELOPMENT_VERSION = "0.0.0";

export const IMPORT_ACTION_ID = "datasource.import";
export const RELEASE_NOTES_ACTION_ID = "notifications.releaseNotes";
export const SETTINGS_ACTION_ID = "settings.show";

const KIND_ORDER: readonly NoticeKind[] = ["update", "import", "plugin", "feature"];
/** Only plugins TableCraft downloads update in the background; a built-in one moves with the app. */
const ANNOUNCED_PLUGIN_SOURCE = "managed";

function releasedVersion(version: string): string | null {
  return version !== DEVELOPMENT_VERSION && isVersion(version) ? version : null;
}

function announcedPlugins(plugins: readonly PluginInfo[]): readonly (PluginInfo & { readonly version: string })[] {
  return plugins.filter(
    (plugin): plugin is PluginInfo & { readonly version: string } =>
      plugin.source === ANNOUNCED_PLUGIN_SOURCE && isVersion(plugin.version),
  );
}

/** The memory of a profile that has none: everything that exists now counts as seen (ruling 10). */
export function firstMemory(input: NoticeInput): NoticeMemory {
  return {
    version: releasedVersion(input.appVersion),
    features: input.features.map((feature) => feature.id),
    plugins: Object.fromEntries(announcedPlugins(input.plugins).map((plugin) => [plugin.id, plugin.version])),
    dismissed: [],
    read: [],
  };
}

/**
 * Records silently what deserves no notice: the first released version, a downgrade, a plugin
 * installed since or rolled back. Returns `memory` itself when nothing changed.
 */
export function reconcileMemory(input: NoticeInput, memory: NoticeMemory): NoticeMemory {
  const running = releasedVersion(input.appVersion);
  const version =
    running !== null &&
    (memory.version === null || !isVersion(memory.version) || compareVersions(running, memory.version) < 0)
      ? running
      : memory.version;
  let plugins = memory.plugins;
  for (const plugin of announcedPlugins(input.plugins)) {
    const seen = plugins[plugin.id];
    if (seen === undefined || !isVersion(seen) || compareVersions(plugin.version, seen) < 0)
      plugins = { ...plugins, [plugin.id]: plugin.version };
  }
  return version === memory.version && plugins === memory.plugins ? memory : { ...memory, version, plugins };
}

function updateNotice(input: NoticeInput, memory: NoticeMemory): Notice | null {
  const running = releasedVersion(input.appVersion);
  if (running === null || memory.version === null || !isVersion(memory.version)) return null;
  if (compareVersions(running, memory.version) <= 0) return null;
  return {
    id: `update:${running}`,
    kind: "update",
    title: `Updated to TableCraft ${running}`,
    body: "See what changed in this release.",
    action: { label: "Release notes", actionId: RELEASE_NOTES_ACTION_ID, args: { version: running } },
    sticky: false,
  };
}

function connectionCount(count: number): string {
  return count === 1 ? "1 connection" : `${String(count)} connections`;
}

function importNotices(input: NoticeInput, memory: NoticeMemory): readonly Notice[] {
  if (input.importSources === null) return [];
  const imported = new Set<ImportApp>(input.datasources.flatMap((datasource) => datasource.origin?.app ?? []));
  return input.importSources
    .filter((source) => source.found && source.count > 0 && !imported.has(source.app))
    .map((source) => ({
      id: `import:${source.app}`,
      kind: "import" as const,
      title: `${connectionCount(source.count)} found in ${source.label}`,
      body: "Import them with their folders, and passwords if you allow it.",
      action: { label: "Import…", actionId: IMPORT_ACTION_ID, args: { app: source.app } },
      sticky: true,
    }))
    .filter((notice) => !memory.dismissed.includes(notice.id));
}

function pluginNotices(input: NoticeInput, memory: NoticeMemory): readonly Notice[] {
  return announcedPlugins(input.plugins).flatMap((plugin) => {
    const seen = memory.plugins[plugin.id];
    if (seen === undefined || !isVersion(seen) || compareVersions(plugin.version, seen) <= 0) return [];
    return [
      {
        id: `plugin:${plugin.id}:${plugin.version}`,
        kind: "plugin" as const,
        title: `${plugin.name} plugin updated to ${plugin.version}`,
        body: "TableCraft updated it in the background.",
        action: { label: "Plugins", actionId: SETTINGS_ACTION_ID, args: { page: "plugins" } },
        sticky: false,
      },
    ];
  });
}

function featureNotices(input: NoticeInput, memory: NoticeMemory): readonly Notice[] {
  return input.features
    .filter((feature) => !memory.features.includes(feature.id))
    .map((feature) => ({
      id: `feature:${feature.id}`,
      kind: "feature" as const,
      title: feature.title,
      body: feature.body,
      action: feature.action ?? null,
      sticky: false,
    }));
}

/** The notices to list now, ordered update, import, plugin, feature. */
export function deriveNotices(input: NoticeInput, memory: NoticeMemory): readonly Notice[] {
  const update = updateNotice(input, memory);
  const notices = [
    ...(update === null ? [] : [update]),
    ...importNotices(input, memory),
    ...pluginNotices(input, memory),
    ...featureNotices(input, memory),
  ];
  return notices.sort((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
}

function without(list: readonly string[], id: string): readonly string[] {
  return list.filter((entry) => entry !== id);
}

/** The memory once `notice` is dismissed, or its action ran and it is not sticky: it does not come back. */
export function settleNotice(memory: NoticeMemory, notice: Notice, input: NoticeInput): NoticeMemory {
  const read = without(memory.read, notice.id);
  switch (notice.kind) {
    case "update":
      return { ...memory, read, version: releasedVersion(input.appVersion) ?? memory.version };
    case "import":
      return { ...memory, read, dismissed: [...without(memory.dismissed, notice.id), notice.id] };
    case "plugin": {
      const [, pluginId = "", version = ""] = notice.id.split(":");
      return { ...memory, read, plugins: { ...memory.plugins, [pluginId]: version } };
    }
    case "feature": {
      const featureId = notice.id.slice("feature:".length);
      return { ...memory, read, features: [...without(memory.features, featureId), featureId] };
    }
  }
}

export function markRead(memory: NoticeMemory, notices: readonly Notice[]): NoticeMemory {
  const unseen = notices.filter((notice) => !memory.read.includes(notice.id));
  return unseen.length === 0 ? memory : { ...memory, read: [...memory.read, ...unseen.map((notice) => notice.id)] };
}

export function unreadIds(notices: readonly Notice[], memory: NoticeMemory): readonly string[] {
  return notices.filter((notice) => !memory.read.includes(notice.id)).map((notice) => notice.id);
}

function stringsOf(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null;
}

function versionsOf(value: unknown): Readonly<Record<string, string>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, version]) => typeof version === "string") ? Object.fromEntries(entries) : null;
}

/** The stored memory, or null when there is none or it no longer reads as one (ruling 10). */
export function loadNoticeMemory(storage: Pick<Storage, "getItem">): NoticeMemory | null {
  const text = storage.getItem(NOTICES_STORAGE_KEY);
  if (text === null) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof saved !== "object" || saved === null) return null;
  const { version, features, plugins, dismissed, read } = saved as Record<string, unknown>;
  const featuresRead = stringsOf(features);
  const pluginsRead = versionsOf(plugins);
  const dismissedRead = stringsOf(dismissed);
  const readRead = stringsOf(read);
  if (featuresRead === null || pluginsRead === null || dismissedRead === null || readRead === null) return null;
  if (version !== null && typeof version !== "string") return null;
  return { version, features: featuresRead, plugins: pluginsRead, dismissed: dismissedRead, read: readRead };
}

export function saveNoticeMemory(storage: Pick<Storage, "setItem">, memory: NoticeMemory): void {
  storage.setItem(NOTICES_STORAGE_KEY, JSON.stringify(memory));
}
