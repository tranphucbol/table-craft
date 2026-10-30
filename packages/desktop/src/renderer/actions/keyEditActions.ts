import type { KeyChange, KeyExpiry, KeyName, KeyScan, KeyType } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  contextDatabase,
  openKey,
  selectedKey,
  type KeyDatabaseArgs,
} from "@table-craft/desktop/renderer/actions/keyActions.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { keyTreeRowOf } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { keyDeleteConfirmation } from "@table-craft/desktop/renderer/model/keyDeletePreview.js";
import { EXPIRY_HINT, parseExpiry } from "@table-craft/desktop/renderer/model/keyExpiry.js";
import { appendKeys, keyIdentity, ROOT_KEY } from "@table-craft/desktop/renderer/model/keyTree.js";
import type { OpenKeyArgs } from "@table-craft/desktop/renderer/palette/keysProvider.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useKeyDeletes } from "@table-craft/desktop/renderer/state/keyDeletes.js";
import { useKeyTabs } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { useKeys } from "@table-craft/desktop/renderer/state/keys.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { useTabs } from "@table-craft/desktop/renderer/state/tabs.js";

export const KEY_EDIT_ACTION_IDS = {
  newKey: "key.new",
  setTtl: "key.setTtl",
  persist: "key.persist",
  deleteFolder: "key.deleteFolder",
  cancelDelete: "key.cancelDelete",
  dismissDelete: "key.dismissDelete",
  loadChildren: "key.loadChildren",
  refreshFolder: "key.refreshFolder",
} as const;

/** How many names Delete Keys Under Folder lists before it asks. */
const LISTED_NAMES = 20;
const GLOB_SPECIAL = /[*?[\]\\]/g;

const NEW_KEY_TYPES: readonly { readonly type: KeyType; readonly label: string; readonly detail: string }[] = [
  { type: "string", label: "String", detail: "one value" },
  { type: "hash", label: "Hash", detail: "fields and values" },
  { type: "list", label: "List", detail: "values in order" },
  { type: "set", label: "Set", detail: "unique members" },
  { type: "zset", label: "Sorted set", detail: "members by score" },
  { type: "stream", label: "Stream", detail: "entries of fields" },
];

function text(value: string): KeyName {
  return { text: value, hex: null };
}

const browsesKeys = (context: ActionContext) => context.datasource?.capabilities.includes("keyValue") === true;
const writable = (context: ActionContext) => browsesKeys(context) && context.datasource?.view.readOnly !== true;

/** The key an edit works on: the active key tab's, else the tree's selection. */
export function targetKey(context: ActionContext): OpenKeyArgs | null {
  const tab = context.keyTab;
  if (context.activeTab?.kind === "key" && tab !== null) {
    return { datasourceId: tab.datasourceId, database: tab.database, key: tab.key };
  }
  return selectedKey(context);
}

/** The folder the tree's selection is, with its prefix. */
function selectedFolder(
  context: ActionContext,
): (KeyDatabaseArgs & { readonly prefix: string; readonly key: KeyName }) | null {
  const { selection } = context;
  if (selection?.kind !== "catalog") return null;
  const row = keyTreeRowOf(selection.key);
  const prefix = row?.rest[0];
  if (row?.kind !== "keyFolder" || typeof prefix !== "string") return null;
  const hex = row.rest[1];
  return {
    datasourceId: selection.id,
    database: row.database,
    prefix,
    key: { text: prefix, hex: typeof hex === "string" ? hex : null },
  };
}

async function failed(title: string, cause: unknown): Promise<void> {
  const error = toError(cause);
  await useModal.getState().ask({ kind: "notice", title, message: error.message, hint: error.hint });
}

function openTabsOf(target: OpenKeyArgs): readonly string[] {
  return Object.entries(useKeyTabs.getState().tabs)
    .filter(
      ([, tab]) =>
        tab.datasourceId === target.datasourceId &&
        tab.database === target.database &&
        keyIdentity(tab.key) === keyIdentity(target.key),
    )
    .map(([id]) => id);
}

/** Re-reads the key where it shows: its tree row's type and TTL, and its open tabs. */
function refreshKey(target: OpenKeyArgs): void {
  const keys = useKeys.getState();
  keys.forget(target.datasourceId, target.database, [target.key]);
  keys.remember(target.datasourceId, target.database, [target.key]);
  for (const id of openTabsOf(target)) void useKeyTabs.getState().reload(id);
}

async function ask(title: string, label: string, placeholder: string, initial = ""): Promise<string | null> {
  return useModal.getState().ask({ kind: "text", title, label, initial, confirm: "OK", placeholder });
}

/** The first value New Key… writes, asked one field at a time; null when cancelled. */
async function firstValue(type: KeyType): Promise<KeyChange | null> {
  const title = "New Key";
  if (type === "string") {
    const value = await ask(title, "Value", "hello");
    return value === null ? null : { kind: "setString", value: text(value), original: null };
  }
  if (type === "list" || type === "set") {
    const value = await ask(title, type === "list" ? "First value" : "First member", "a");
    if (value === null) return null;
    return type === "list" ? { kind: "push", value: text(value) } : { kind: "addMember", member: text(value) };
  }
  if (type === "zset") {
    const member = await ask(title, "First member", "ann");
    const score = member === null ? null : await ask(title, `Score of ${member}`, "1");
    if (member === null || score === null) return null;
    const number = Number(score);
    if (score.trim() === "" || !Number.isFinite(number)) throw new Error(`${score} is not a number.`);
    return { kind: "setScore", member: text(member), score: number, original: null };
  }
  const field = await ask(title, "First field", type === "stream" ? "event" : "name");
  const value = field === null ? null : await ask(title, `Value of ${field}`, "Ann");
  if (field === null || value === null) return null;
  return type === "stream"
    ? { kind: "addEntry", fields: [[text(field), text(value)]] }
    : { kind: "setField", field: text(field), value: text(value), original: null };
}

async function newKey(context: ActionContext): Promise<void> {
  const datasourceId = context.datasource?.view.id;
  if (datasourceId === undefined) return;
  const database = contextDatabase(context, datasourceId);
  const picked = await useModal.getState().ask({
    kind: "pick",
    title: "New Key",
    searchLabel: "Type",
    items: NEW_KEY_TYPES.map(({ type, label, detail }) => ({ id: type, label, detail })),
    empty: "No such type.",
    confirm: "Next",
  });
  const type = NEW_KEY_TYPES.find((entry) => entry.type === picked)?.type;
  if (type === undefined) return;
  const name = await ask("New Key", "Key name", "user:42:profile");
  if (name === null || name === "") return;
  const key = text(name);
  try {
    const client = await useDatasources.getState().connect(datasourceId);
    const [found] = await client.call("keyspace.describe", { database, keys: [key] });
    if (found !== undefined && found.type !== null) throw new Error(`${name} already exists; open it instead.`);
    const change = await firstValue(type);
    if (change === null) return;
    await client.call("keyspace.apply", { database, key, changes: [change], options: { type, guard: true } });
    useKeys.getState().remember(datasourceId, database, [key]);
    openKey(context, { datasourceId, database, key });
  } catch (cause) {
    await failed("New Key", cause);
  }
}

async function setTtl(context: ActionContext): Promise<void> {
  const target = targetKey(context);
  if (target === null) return;
  const typed = await useModal.getState().ask({
    kind: "text",
    title: `Set TTL of ${target.key.text}`,
    label: "Seconds or expiry",
    initial: "",
    confirm: "Set TTL",
    placeholder: "3600",
  });
  if (typed === null) return;
  const parsed = parseExpiry(typed, Date.now());
  if ("problem" in parsed) {
    await useModal.getState().ask({ kind: "notice", title: "Set TTL", message: parsed.problem, hint: EXPIRY_HINT });
    return;
  }
  await expire(target, parsed.expiry);
}

async function expire(target: OpenKeyArgs, expiry: KeyExpiry): Promise<void> {
  try {
    const client = await useDatasources.getState().connect(target.datasourceId);
    await client.call("keyspace.expire", { database: target.database, key: target.key, expiry });
    refreshKey(target);
  } catch (cause) {
    await failed("Set TTL", cause);
  }
}

/** Rename… on a key (decision 17): RENAMENX, then Overwrite when the new name is taken. */
export async function renameKey(context: ActionContext, target: OpenKeyArgs): Promise<void> {
  const name = await useModal.getState().ask({
    kind: "text",
    title: `Rename ${target.key.text}`,
    label: "New name",
    initial: target.key.hex === null ? target.key.text : "",
    confirm: "Rename",
  });
  if (name === null || name === "" || name === target.key.text) return;
  const to = text(name);
  try {
    const client = await useDatasources.getState().connect(target.datasourceId);
    const rename = (overwrite: boolean) =>
      client.call("keyspace.rename", { database: target.database, key: target.key, to, overwrite });
    try {
      await rename(false);
    } catch (cause) {
      if (!toError(cause).message.includes("already exists")) throw cause;
      const answer = await useModal.getState().ask({
        kind: "choice",
        title: `Rename ${target.key.text}`,
        message: `${name} already exists. Overwrite it? RENAME replaces it; this cannot be undone.`,
        choices: [{ id: "overwrite", label: "Overwrite", variant: "danger" }],
      });
      if (answer !== "overwrite") return;
      await rename(true);
    }
    const keys = useKeys.getState();
    keys.forget(target.datasourceId, target.database, [target.key, to]);
    keys.remember(target.datasourceId, target.database, [to]);
    const open = openTabsOf(target);
    for (const id of open) useTabs.getState().close(id);
    if (open.length > 0) openKey(context, { ...target, key: to });
  } catch (cause) {
    await failed("Rename", cause);
  }
}

async function guardedDeletes(client: EngineClient): Promise<boolean> {
  const features = await client.call("keyspace.features", {});
  if (!features.prepareDelete && (features.revisionGuard === true || features.children)) {
    throw new Error(
      "Guarded deletion is unavailable on this connection. Reconnect before deleting; an unguarded full scan will not be used.",
    );
  }
  return features.prepareDelete;
}

/** Delete… on a key: guarded when supported, otherwise UNLINK after confirmation. */
export async function deleteKey(target: OpenKeyArgs): Promise<void> {
  try {
    const client = await useDatasources.getState().connect(target.datasourceId);
    if (await guardedDeletes(client)) {
      const range = { kind: "key", key: target.key } as const;
      const preview = await client.call("keyspace.prepareDelete", { database: target.database, range });
      const answer = await useModal.getState().ask(keyDeleteConfirmation(preview, range));
      if (answer === null) return;
      await client.call("keyspace.deletePrepared", { token: preview.token });
      await useKeys.getState().refreshRange(target.datasourceId, target.database, target.key);
      for (const id of openTabsOf(target)) void useKeyTabs.getState().reload(id);
      return;
    }
  } catch (cause) {
    await failed("Delete Key", cause);
    return;
  }
  const answer = await useModal.getState().ask({
    kind: "confirm",
    title: "Delete Key",
    message: `Delete ${target.key.text}? UNLINK removes it; this cannot be undone.`,
    confirm: "Delete",
    destructive: true,
  });
  if (answer === null) return;
  try {
    const client = await useDatasources.getState().connect(target.datasourceId);
    await client.call("keyspace.remove", { database: target.database, keys: [target.key] });
    useKeys.getState().forget(target.datasourceId, target.database, [target.key]);
    for (const id of openTabsOf(target)) void useKeyTabs.getState().reload(id);
  } catch (cause) {
    await failed("Delete Key", cause);
  }
}

async function deleteFolder(context: ActionContext): Promise<void> {
  const folder = selectedFolder(context);
  if (folder === null) return;
  const { datasourceId, database, prefix } = folder;
  try {
    const client = await useDatasources.getState().connect(datasourceId);
    if (await guardedDeletes(client)) {
      const range = { kind: "prefix", prefix: folder.key } as const;
      const preview = await client.call("keyspace.prepareDelete", { database, range });
      const answer = await useModal.getState().ask(keyDeleteConfirmation(preview, range));
      if (answer === null) return;
      await useKeyDeletes.getState().startPrepared(datasourceId, database, folder.key, preview);
      for (const [id, tab] of Object.entries(useKeyTabs.getState().tabs)) {
        if (tab.datasourceId === datasourceId && tab.database === database) void useKeyTabs.getState().reload(id);
      }
      return;
    }
    const match = `${prefix.replace(GLOB_SPECIAL, "\\$&")}*`;
    let keys: readonly KeyName[] = [];
    let cursor: string | null = null;
    do {
      const scan: KeyScan = await client.call("keyspace.scan", { database, cursor, match, keyType: null });
      keys = appendKeys(keys, scan.keys);
      cursor = scan.cursor;
    } while (cursor !== null);
    if (keys.length === 0) {
      await useModal
        .getState()
        .ask({ kind: "notice", title: "Delete Keys", message: `No keys match ${match}.`, hint: "", tone: "info" });
      return;
    }
    const answer = await useModal.getState().ask({
      kind: "confirm",
      title: "Delete Keys Under Folder",
      message: `Delete ${keys.length.toLocaleString("en-US")} keys matching ${match}? UNLINK removes them in the background; this cannot be undone.`,
      items: keys.slice(0, LISTED_NAMES).map((key) => ({ label: key.text, detail: "", tone: "info" as const })),
      confirm: "Delete",
      destructive: true,
    });
    if (answer === null) return;
    void useKeyDeletes.getState().start(datasourceId, database, prefix, keys);
  } catch (cause) {
    await failed("Delete Keys", cause);
  }
}

interface TaskArgs {
  readonly taskId: string;
}

export interface KeyChildrenArgs extends KeyDatabaseArgs {
  readonly parent: KeyName;
  readonly restart?: boolean;
}

function childrenDatasource(context: ActionContext): boolean {
  const id = context.datasource?.view.id;
  return id !== undefined && useKeys.getState().keyspaces[id]?.features?.children === true;
}

function childrenTarget(context: ActionContext): KeyChildrenArgs | null {
  const id = context.datasource?.view.id;
  if (id === undefined) return null;
  const database = contextDatabase(context, id);
  const row = context.selection?.kind === "catalog" ? keyTreeRowOf(context.selection.key) : null;
  const identity = row?.kind === "keyLoadMore" ? row.rest[0] : undefined;
  const folder =
    typeof identity === "string"
      ? useKeys.getState().keyspaces[id]?.byDatabase[database]?.folders?.[identity]
      : undefined;
  return { datasourceId: id, database, parent: folder?.parent ?? ROOT_KEY, restart: folder?.error != null };
}

/** The key editing commands without a chord (plan 058 decision 17); Rename and Delete reuse the explorer's. */
export const KEY_EDIT_ACTIONS: readonly AnyAction[] = [
  defineAction<KeyChildrenArgs | undefined>({
    id: KEY_EDIT_ACTION_IDS.loadChildren,
    title: "Load More Children",
    category: "Database",
    available: childrenDatasource,
    when: childrenDatasource,
    run: async (context, args) => {
      const target = args ?? childrenTarget(context);
      if (target !== null)
        await useKeys.getState().loadChildren(target.datasourceId, target.database, target.parent, target.restart);
    },
  }),
  defineAction({
    id: KEY_EDIT_ACTION_IDS.refreshFolder,
    title: "Refresh Folder",
    category: "Database",
    icon: "synchronize",
    available: childrenDatasource,
    when: browsesKeys,
    run: async (context) => {
      const id = context.datasource?.view.id;
      if (id === undefined) return;
      const folder = selectedFolder(context);
      await useKeys
        .getState()
        .loadChildren(id, folder?.database ?? contextDatabase(context, id), folder?.key ?? ROOT_KEY, true);
    },
  }),
  defineAction({
    id: KEY_EDIT_ACTION_IDS.newKey,
    title: "New Key…",
    category: "Database",
    icon: "add",
    available: browsesKeys,
    when: writable,
    run: newKey,
  }),
  defineAction({
    id: KEY_EDIT_ACTION_IDS.setTtl,
    title: "Set TTL…",
    category: "Database",
    available: browsesKeys,
    when: (context) => writable(context) && targetKey(context) !== null,
    run: setTtl,
  }),
  defineAction({
    id: KEY_EDIT_ACTION_IDS.persist,
    title: "Remove TTL",
    category: "Database",
    available: browsesKeys,
    when: (context) => writable(context) && targetKey(context) !== null,
    run: async (context) => {
      const target = targetKey(context);
      if (target !== null) await expire(target, null);
    },
  }),
  defineAction({
    id: KEY_EDIT_ACTION_IDS.deleteFolder,
    title: "Delete Keys Under Folder…",
    category: "Database",
    icon: "delete",
    available: browsesKeys,
    when: (context) => writable(context) && selectedFolder(context) !== null,
    run: deleteFolder,
  }),
  defineAction<TaskArgs | undefined>({
    id: KEY_EDIT_ACTION_IDS.cancelDelete,
    title: "Cancel Key Deletion",
    category: "Database",
    when: () => useKeyDeletes.getState().tasks.some((task) => task.state === "running" && task.atomic !== true),
    run: (_context, args) => {
      if (args !== undefined) useKeyDeletes.getState().cancel(args.taskId);
    },
  }),
  defineAction<TaskArgs | undefined>({
    id: KEY_EDIT_ACTION_IDS.dismissDelete,
    title: "Remove Key Deletion",
    category: "Database",
    when: () => useKeyDeletes.getState().tasks.some((task) => task.state !== "running"),
    run: (_context, args) => {
      if (args !== undefined) useKeyDeletes.getState().dismiss(args.taskId);
    },
  }),
];
