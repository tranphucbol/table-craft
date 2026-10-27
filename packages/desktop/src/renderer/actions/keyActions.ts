import type { KeyName } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { datasourceKey, keyTreeKey, keyTreeRowOf } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { keyIdentity, type KeyFilter } from "@table-craft/desktop/renderer/model/keyTree.js";
import type { OpenKeyArgs } from "@table-craft/desktop/renderer/palette/keysProvider.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { formatPattern, VALUE_FORMATS, type ValueFormat } from "@table-craft/desktop/renderer/model/valueFormats.js";
import { canReloadKey, useKeyTabs, type KeyTab, type KeyTarget } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { useKeyDetails } from "@table-craft/desktop/renderer/state/keyDetails.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import { useConsoles } from "@table-craft/desktop/renderer/state/consoles.js";
import type { ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";

export const KEY_ACTION_IDS = {
  open: "key.open",
  goTo: "key.goTo",
  loadMore: "key.loadMore",
  filter: "key.filter",
  reload: "key.reload",
  details: "key.details",
  valueFormat: "key.valueFormat",
  toggleEmptyDatabases: "explorer.toggleEmptyDatabases",
  openFromResult: "key.openFromResult",
  resultValueFormat: "key.resultValueFormat",
  showReply: "console.showReply",
} as const;

/** Characters a Redis glob gives meaning to, escaped so Go to Key matches them literally. */
const GLOB_SPECIAL = /[*?[\]\\]/g;

const browsesKeys = (context: ActionContext) => context.datasource?.capabilities.includes("keyValue") === true;

/** The database the selection is in, else the datasource's configured one. */
export function contextDatabase(context: ActionContext, datasourceId: string): number {
  const { selection } = context;
  if (selection?.kind === "catalog" && selection.id === datasourceId) {
    const row = keyTreeRowOf(selection.key);
    if (row !== null) return row.database;
  }
  const databases = useKeys.getState().keyspaces[datasourceId]?.databases ?? [];
  return databases.find((database) => database.current)?.index ?? 0;
}

/** The key the tree's selection is, if it is one. */
export function selectedKey(context: ActionContext): OpenKeyArgs | null {
  const { selection } = context;
  if (selection?.kind !== "catalog") return null;
  const row = keyTreeRowOf(selection.key);
  if (row?.kind !== "keyEntry") return null;
  const identity = row.rest[0];
  const keys = useKeys.getState().keyspaces[selection.id]?.byDatabase[row.database]?.keys ?? [];
  const key = keys.find((candidate) => keyIdentity(candidate) === identity);
  return key === undefined ? null : { datasourceId: selection.id, database: row.database, key };
}

function isOpenKeyArgs(args: unknown): args is OpenKeyArgs {
  return typeof args === "object" && args !== null && "datasourceId" in args && "database" in args && "key" in args;
}

/** Expands the tree down to the key, loading its database when needed, and selects it. */
export function revealKey(context: ActionContext, { datasourceId, database, key }: OpenKeyArgs): void {
  if (!context.toolWindows.database) useLayout.getState().toggle("database");
  const keys = useKeys.getState();
  void keys.expandDatabase(datasourceId, database);
  keys.remember(datasourceId, database, [key]);
  const delimiter = keys.keyspaces[datasourceId]?.delimiter ?? "";
  const segments = delimiter === "" ? [] : key.text.split(delimiter).slice(0, -1);
  const prefixes = segments.map((_, index) => `${segments.slice(0, index + 1).join(delimiter)}${delimiter}`);
  useCatalog
    .getState()
    .expandAll([
      datasourceKey(datasourceId),
      keyTreeKey(datasourceId, "keyDatabase", database),
      ...prefixes.map((prefix) => keyTreeKey(datasourceId, "keyFolder", database, prefix)),
    ]);
  useDatasources.getState().select({
    kind: "catalog",
    id: datasourceId,
    key: keyTreeKey(datasourceId, "keyEntry", database, keyIdentity(key)),
    path: [],
    name: key.text,
  });
  useCatalog.getState().requestFocus();
}

const KEY_TAB_PREFIX = "key-";
let keyTabsOpened = 0;

function sameKey(a: KeyTarget, b: KeyTarget): boolean {
  return a.datasourceId === b.datasourceId && a.database === b.database && keyIdentity(a.key) === keyIdentity(b.key);
}

/** Opens the key in a key tab (decision 113), or brings its open tab forward. */
export function openKey(_context: ActionContext, target: OpenKeyArgs): void {
  const existing = Object.entries(useKeyTabs.getState().tabs).find(([, tab]) => sameKey(tab, target))?.[0];
  if (existing !== undefined) {
    useTabs.getState().activate(existing);
    return;
  }
  const tab: Tab = { id: `${KEY_TAB_PREFIX}${String(keyTabsOpened++)}`, kind: "key", title: target.key.text };
  useTabs.getState().open(tab);
  void useKeyTabs.getState().open(tab.id, target);
}

/** The key carries facts beyond the common ones, which the Details panel lists. */
export function hasAttributes(tab: KeyTab | null): boolean {
  return (tab?.details?.attributes?.length ?? 0) > 0;
}

/** The pattern the active key tab's value format is remembered under. */
export function formatPatternOf(tab: KeyTab | null): string | null {
  if (tab === null) return null;
  const delimiter = useKeys.getState().keyspaces[tab.datasourceId]?.delimiter ?? "";
  return formatPattern(tab.key.text, delimiter);
}

/** The format the active key tab's value panel reads with. */
export function valueFormatOf(tab: KeyTab | null): ValueFormat {
  const pattern = formatPatternOf(tab);
  return pattern === null ? "auto" : (useLayout.getState().layout.valueFormats[pattern] ?? "auto");
}

export interface ValueFormatArgs {
  readonly format: ValueFormat;
}

/** The pattern a command result's value format is remembered under: its source key's (decision 119). */
export function resultFormatPattern(datasourceId: string, result: ResultTab | null): string | null {
  if (result?.source === undefined) return null;
  const delimiter = useKeys.getState().keyspaces[datasourceId]?.delimiter ?? "";
  return formatPattern(result.source.key.text, delimiter);
}

/** The format a command result's value panel reads with: its key pattern's, else the tab's own. */
export function resultValueFormatOf(datasourceId: string, result: ResultTab | null): ValueFormat {
  const pattern = resultFormatPattern(datasourceId, result);
  const remembered = pattern === null ? undefined : useLayout.getState().layout.valueFormats[pattern];
  return remembered ?? result?.valueFormat ?? "auto";
}

function nextFormat(current: ValueFormat): ValueFormat {
  return VALUE_FORMATS[(VALUE_FORMATS.indexOf(current) + 1) % VALUE_FORMATS.length] ?? "auto";
}

/** The key Open Key opens from a console: the shown result's source, or on Output the last line that read one. */
function resultKey(context: ActionContext): OpenKeyArgs | null {
  const session = context.console;
  if (session === null || !browsesKeys(context)) return null;
  const source =
    context.result === null
      ? [...session.output].reverse().find((entry) => entry.key !== undefined)?.key
      : context.result.source;
  return source === undefined
    ? null
    : { datasourceId: session.datasourceId, database: source.database, key: source.key };
}

export interface ShowReplyArgs {
  readonly entryId: number;
}

function lastReply(context: ActionContext): number | null {
  const output = context.console?.output ?? [];
  return [...output].reverse().find((entry) => entry.result !== undefined)?.id ?? null;
}

async function goToKey(context: ActionContext): Promise<void> {
  const datasourceId = context.datasource?.view.id;
  if (datasourceId === undefined) return;
  const text = await useModal.getState().ask({
    kind: "text",
    title: "Go to Key",
    label: "Key name",
    initial: "",
    confirm: "Go to Key",
    placeholder: "user:42:profile",
  });
  if (text === null || text === "") return;
  const database = contextDatabase(context, datasourceId);
  const key: KeyName = { text, hex: null };
  const client = await useDatasources.getState().connect(datasourceId);
  const [found] = await client.call("keyspace.describe", { database, keys: [key] });
  if (found !== undefined && found.type !== null) {
    openKey(context, { datasourceId, database, key });
    return;
  }
  useCatalog.getState().expandAll([datasourceKey(datasourceId), keyTreeKey(datasourceId, "keyDatabase", database)]);
  await useKeys
    .getState()
    .setFilter(datasourceId, database, { match: `*${text.replace(GLOB_SPECIAL, "\\$&")}*`, type: null });
}

/** A database of a key-value datasource, as the tree's rows name it. */
export interface KeyDatabaseArgs {
  readonly datasourceId: string;
  readonly database: number;
}

/** A filter typed in a database's filter row. */
export interface KeyFilterArgs extends KeyDatabaseArgs {
  readonly filter: KeyFilter;
}

function databaseTarget(context: ActionContext, args: unknown): KeyDatabaseArgs | null {
  if (typeof args === "object" && args !== null && "datasourceId" in args && "database" in args) {
    return args as KeyDatabaseArgs;
  }
  const datasourceId = context.datasource?.view.id;
  if (datasourceId === undefined || !browsesKeys(context)) return null;
  return { datasourceId, database: contextDatabase(context, datasourceId) };
}

function canLoadMore(context: ActionContext): boolean {
  const target = databaseTarget(context, undefined);
  if (target === null) return false;
  const keys = useKeys.getState().keyspaces[target.datasourceId]?.byDatabase[target.database];
  return keys !== undefined && keys.started && !keys.loading && keys.cursor !== null;
}

async function filterKeys(context: ActionContext, args: KeyFilterArgs | undefined): Promise<void> {
  if (args !== undefined) {
    await useKeys.getState().setFilter(args.datasourceId, args.database, args.filter);
    return;
  }
  const target = databaseTarget(context, undefined);
  if (target === null) return;
  const current = useKeys.getState().keyspaces[target.datasourceId]?.byDatabase[target.database]?.filter;
  const match = await useModal.getState().ask({
    kind: "text",
    title: "Filter Keys",
    label: "MATCH pattern",
    initial: current?.match ?? "*",
    confirm: "Filter",
    placeholder: "user:*",
  });
  if (match === null) return;
  await useKeys.getState().setFilter(target.datasourceId, target.database, { match, type: current?.type ?? null });
}

/** The key tree's commands (decision 113); editing ones come with the key tab. */
export const KEY_ACTIONS: readonly AnyAction[] = [
  defineAction<KeyDatabaseArgs | undefined>({
    id: KEY_ACTION_IDS.loadMore,
    title: "Load More Keys",
    category: "Database",
    available: browsesKeys,
    when: canLoadMore,
    run: async (context, args) => {
      const target = databaseTarget(context, args);
      if (target !== null) await useKeys.getState().loadMore(target.datasourceId, target.database);
    },
  }),
  defineAction<KeyFilterArgs | undefined>({
    id: KEY_ACTION_IDS.filter,
    title: "Filter Keys…",
    category: "Database",
    available: browsesKeys,
    when: browsesKeys,
    run: filterKeys,
  }),
  defineAction<OpenKeyArgs | undefined>({
    id: KEY_ACTION_IDS.open,
    title: "Open Key",
    category: "Database",
    available: browsesKeys,
    when: (context) => selectedKey(context) !== null,
    run: (context, args) => {
      const target = isOpenKeyArgs(args) ? args : selectedKey(context);
      if (target !== null) openKey(context, target);
    },
  }),
  defineAction({
    id: KEY_ACTION_IDS.goTo,
    title: "Go to Key…",
    category: "Database",
    available: browsesKeys,
    when: browsesKeys,
    run: goToKey,
  }),
  defineAction({
    id: KEY_ACTION_IDS.reload,
    title: "Reload Key",
    category: "Key Editor",
    icon: "rerun",
    tabKind: "key",
    when: (context) => context.keyTab !== null && canReloadKey(context.keyTab.status),
    run: async (context) => {
      if (context.activeTab !== null && context.keyTab !== null) {
        await useKeyTabs.getState().reload(context.activeTab.id);
      }
    },
  }),
  defineAction({
    id: KEY_ACTION_IDS.details,
    title: "Key Details",
    category: "Key Editor",
    icon: "details",
    shortcut: "Mod+I",
    tabKind: "key",
    when: (context) => hasAttributes(context.keyTab),
    run: (context) => {
      if (context.activeTab !== null && hasAttributes(context.keyTab)) {
        useKeyDetails.getState().toggle(context.activeTab.id);
      }
    },
  }),
  defineAction<ValueFormatArgs | undefined>({
    id: KEY_ACTION_IDS.valueFormat,
    title: "Next Value Format",
    category: "Key Editor",
    tabKind: "key",
    when: (context) => context.keyTab !== null,
    run: (context, args) => {
      const pattern = formatPatternOf(context.keyTab);
      if (pattern === null) return;
      const current = valueFormatOf(context.keyTab);
      const next = args?.format ?? VALUE_FORMATS[(VALUE_FORMATS.indexOf(current) + 1) % VALUE_FORMATS.length];
      if (next !== undefined) useLayout.getState().setValueFormat(pattern, next);
    },
  }),
  defineAction<ValueFormatArgs | undefined>({
    id: KEY_ACTION_IDS.resultValueFormat,
    title: "Next Value Format",
    category: "Result Grid",
    tabKind: "console",
    available: browsesKeys,
    when: (context) => context.result !== null && browsesKeys(context),
    run: (context, args) => {
      const { result, console: session, activeTab } = context;
      if (result === null || session === null || activeTab === null) return;
      const next = args?.format ?? nextFormat(resultValueFormatOf(session.datasourceId, result));
      const pattern = resultFormatPattern(session.datasourceId, result);
      if (pattern === null) useConsoles.getState().setValueFormat(activeTab.id, result.id, next);
      else useLayout.getState().setValueFormat(pattern, next);
    },
  }),
  defineAction<OpenKeyArgs | undefined>({
    id: KEY_ACTION_IDS.openFromResult,
    title: "Open Key",
    category: "Result Grid",
    icon: "goTo",
    shortcut: "Mod+B",
    shortcutRegion: "grid",
    tabKind: "console",
    available: browsesKeys,
    when: (context) => resultKey(context) !== null,
    run: (context, args) => {
      const target = isOpenKeyArgs(args) ? args : resultKey(context);
      if (target !== null) openKey(context, target);
    },
  }),
  defineAction<ShowReplyArgs | undefined>({
    id: KEY_ACTION_IDS.showReply,
    title: "Show as Result",
    category: "Console",
    tabKind: "console",
    when: (context) => lastReply(context) !== null,
    run: (context, args) => {
      const entryId = args?.entryId ?? lastReply(context);
      if (context.activeTab !== null && entryId !== null)
        useConsoles.getState().showReply(context.activeTab.id, entryId);
    },
  }),
  defineAction({
    id: KEY_ACTION_IDS.toggleEmptyDatabases,
    title: "Show Empty Databases",
    category: "Database",
    run: () => useLayout.getState().toggleEmptyDatabases(),
  }),
];
