import type {
  EngineError,
  KeyDatabase,
  KeyInfo,
  KeyName,
  KeyType,
  ServerNode,
  KeyAdvancedCalls,
  KeyChildrenPage,
  KeyRange,
  KeyRevision,
} from "@table-craft/desktop/engine/protocol.js";
import type { ErrorNode, ExplorerNode, LoadingNode } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { isCluster, nodeLabel } from "@table-craft/desktop/renderer/model/runOn.js";

/** A pass of the key tree's scan stops after this many keys, behind a Load more row (decision 113). */
export const KEYS_PER_PASS = 10_000;

/** The server-side filter of one database's scan: a `MATCH` glob and a type. */
export interface KeyFilter {
  readonly match: string;
  readonly type: KeyType | null;
  readonly mode?: "prefix" | "range" | "loadedName";
  readonly end?: string;
  readonly leasedOnly?: boolean;
}

export const CHILDREN_PER_PAGE = 500;
export const CHILDREN_TIMEOUT_MS = 5000;
export const ROOT_KEY: KeyName = { text: "", hex: null };

export interface FolderKeys {
  readonly parent: KeyName;
  readonly children: KeyChildrenPage["children"];
  readonly revision: string | null;
  readonly cursor: string | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  readonly started: boolean;
}

export const UNLISTED_FOLDER: FolderKeys = {
  parent: ROOT_KEY,
  children: [],
  revision: null,
  cursor: null,
  loading: false,
  error: null,
  started: false,
};

export function keyFilterRange(filter: KeyFilter): KeyRange {
  if (filter.mode === "range")
    return { kind: "range", from: { text: filter.match, hex: null }, to: { text: filter.end ?? "", hex: null } };
  if (filter.mode === "loadedName" || filter.match === "" || (filter.mode === undefined && filter.match === "*"))
    return { kind: "all" };
  return { kind: "prefix", prefix: { text: filter.match, hex: null } };
}

export const NO_KEY_FILTER: KeyFilter = { match: "*", type: null };

/** One database's keys as far as they are scanned. */
export interface DatabaseKeys {
  /** In scan order, each once. */
  readonly keys: readonly KeyName[];
  /** Where the next pass starts; null once the scan reached its end. */
  readonly cursor: string | null;
  /** Whether a scan has started; a database expanded before connecting has not. */
  readonly started: boolean;
  readonly loading: boolean;
  readonly error: EngineError | null;
  readonly filter: KeyFilter;
  /** Type and expiry of the keys described so far, by `keyIdentity`. */
  readonly info: Readonly<Record<string, KeyInfo>>;
  readonly folders?: Readonly<Record<string, FolderKeys>>;
  readonly counts?: Readonly<Record<string, string | null>>;
}

export const UNSCANNED_KEYS: DatabaseKeys = {
  keys: [],
  cursor: null,
  started: false,
  loading: false,
  error: null,
  filter: NO_KEY_FILTER,
  info: {},
};

/** What the renderer holds of one key-value datasource's keyspace; it dies with the engine. */
export interface DatasourceKeyspace {
  readonly leaseTtls?: Readonly<Record<string, { readonly seconds: string | null; readonly readAt: number }>>;
  readonly features?: KeyAdvancedCalls["keyspace.features"]["result"];
  readonly delimiter: string;
  /** `null` until listed. */
  readonly databases: readonly KeyDatabase[] | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  readonly byDatabase: Readonly<Record<number, DatabaseKeys>>;
  /** The servers behind the datasource; a cluster's show under Cluster nodes. */
  readonly nodes: readonly ServerNode[];
}

export const EMPTY_KEYSPACE: DatasourceKeyspace = {
  delimiter: "",
  databases: null,
  loading: false,
  error: null,
  byDatabase: {},
  nodes: [],
};

interface KeyNodeBase {
  readonly datasourceId: string;
  /** Always empty: a keyspace has no namespaces, but every catalog row carries a path. */
  readonly path: readonly string[];
  readonly database: number;
}

export interface KeyDatabaseNode extends KeyNodeBase {
  readonly kind: "keyDatabase";
  readonly summary: KeyDatabase;
  readonly keys: DatabaseKeys;
}

export interface KeyFilterNode extends KeyNodeBase {
  readonly kind: "keyFilter";
  readonly filter: KeyFilter;
  readonly serverChildren?: boolean;
}

export interface KeyFolderNode extends KeyNodeBase {
  readonly kind: "keyFolder";
  /** The folder's name with the delimiter after it, as `user:`. */
  readonly prefix: string;
  /** Keys loaded under it, never a guess. */
  readonly count: number;
  readonly exactCount?: string | null;
  readonly key?: KeyName;
  readonly accessError?: EngineError;
}

export interface KeyEntryNode extends KeyNodeBase {
  readonly kind: "keyEntry";
  readonly key: KeyName;
  readonly info: KeyInfo | null;
  readonly revision?: KeyRevision;
  readonly serverChildren?: boolean;
}

export interface KeyLoadMoreNode extends KeyNodeBase {
  readonly kind: "keyLoadMore";
  readonly loaded: number;
  /** The database's key count, the scan's estimate of its end. */
  readonly estimate: number;
  readonly parent?: KeyName;
  readonly restart?: boolean;
}

export interface ClusterNodesNode {
  readonly kind: "clusterNodes";
  readonly datasourceId: string;
  readonly path: readonly string[];
  readonly count: number;
}

export interface ClusterNodeNode {
  readonly kind: "clusterNode";
  readonly datasourceId: string;
  readonly path: readonly string[];
  readonly node: ServerNode;
}

export type KeyTreeNode =
  KeyDatabaseNode | KeyFilterNode | KeyFolderNode | KeyEntryNode | KeyLoadMoreNode | ClusterNodesNode | ClusterNodeNode;

/** A key's identity: its bytes, whichever way they travel. */
export function keyIdentity(key: KeyName): string {
  return key.hex === null ? `t${key.text}` : `x${key.hex}`;
}

export function keyStartsWith(key: KeyName, prefix: KeyName): boolean {
  const bytes = (value: KeyName) =>
    value.hex ??
    Array.from(new TextEncoder().encode(value.text), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return bytes(key).startsWith(bytes(prefix));
}

/** `keys` followed by those of `more` it does not hold yet; SCAN may return a key twice. */
export function appendKeys(keys: readonly KeyName[], more: readonly KeyName[]): readonly KeyName[] {
  const seen = new Set(keys.map(keyIdentity));
  const added = more.filter((key) => {
    const identity = keyIdentity(key);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return added.length === 0 ? keys : [...keys, ...added];
}

export interface KeyLeaf {
  readonly key: KeyName;
  /** The last segment, or the whole name when that is empty. */
  readonly name: string;
}

export interface KeyFolder {
  readonly prefix: string;
  readonly folders: readonly KeyFolder[];
  readonly keys: readonly KeyLeaf[];
  readonly count: number;
}

interface FolderDraft {
  readonly prefix: string;
  readonly folders: Map<string, FolderDraft>;
  readonly keys: KeyLeaf[];
  count: number;
}

function draft(prefix: string): FolderDraft {
  return { prefix, folders: new Map(), keys: [], count: 0 };
}

const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function sealed(folder: FolderDraft): KeyFolder {
  return {
    prefix: folder.prefix,
    folders: [...folder.folders.values()].sort((left, right) => byText(left.prefix, right.prefix)).map(sealed),
    keys: folder.keys.sort((left, right) => byText(left.name, right.name) || byText(left.key.text, right.key.text)),
    count: folder.count,
  };
}

const grouped = new WeakMap<readonly KeyName[], { readonly delimiter: string; readonly root: KeyFolder }>();

/**
 * The keys as folders split at `delimiter`, folders first and each level sorted; a key whose name
 * holds no delimiter sits at the top. Cached per key list, since the tree regroups on every render.
 */
export function groupKeys(keys: readonly KeyName[], delimiter: string): KeyFolder {
  const cached = grouped.get(keys);
  if (cached?.delimiter === delimiter) return cached.root;
  const root = draft("");
  for (const key of keys) {
    const segments = delimiter === "" ? [key.text] : key.text.split(delimiter);
    let folder = root;
    folder.count += 1;
    let prefix = "";
    for (const segment of segments.slice(0, -1)) {
      prefix = `${prefix}${segment}${delimiter}`;
      let child = folder.folders.get(segment);
      if (child === undefined) {
        child = draft(prefix);
        folder.folders.set(segment, child);
      }
      child.count += 1;
      folder = child;
    }
    const name = segments[segments.length - 1] ?? "";
    folder.keys.push({ key, name: name === "" ? key.text : name });
  }
  const sealedRoot = sealed(root);
  grouped.set(keys, { delimiter, root: sealedRoot });
  return sealedRoot;
}

/** Where the key tree's rows go; `explorerTree` owns the row list and the key scheme. */
export interface KeyRowSink {
  readonly push: (node: ExplorerNode, depth: number, key: string, label: string, expandable: boolean) => boolean;
  readonly keyOf: (...parts: readonly unknown[]) => string;
}

export interface KeyTreeOptions {
  /** Whether empty databases other than the configured one show (Show Empty Databases). */
  readonly showEmpty: boolean;
}

export function keyDatabaseKey(sink: Pick<KeyRowSink, "keyOf">, database: number): string {
  return sink.keyOf("keyDatabase", database);
}

const SECOND_MS = 1000;
const TTL_UNITS: readonly (readonly [string, number])[] = [
  ["d", 86_400],
  ["h", 3600],
  ["m", 60],
  ["s", 1],
];

/** A TTL as the tree and the key tab show it: `no TTL`, `14 m`, `3 d`. */
export function ttlText(ttlMs: number | null): string {
  if (ttlMs === null) return "no TTL";
  const seconds = Math.max(0, Math.round(ttlMs / SECOND_MS));
  const unit = TTL_UNITS.find(([, size]) => seconds >= size);
  if (unit === undefined) return "0 s";
  return `${String(Math.floor(seconds / unit[1]))} ${unit[0]}`;
}

/** `db0` and its key count, as the database row reads. */
export function databaseLabel(database: number): string {
  return `db${String(database)}`;
}

function folderRows(sink: KeyRowSink, base: KeyNodeBase, folder: KeyFolder, keys: DatabaseKeys, depth: number): void {
  for (const child of folder.folders) {
    const node: KeyFolderNode = { ...base, kind: "keyFolder", prefix: child.prefix, count: child.count };
    if (sink.push(node, depth, sink.keyOf("keyFolder", base.database, child.prefix), child.prefix, true)) {
      folderRows(sink, base, child, keys, depth + 1);
    }
  }
  for (const leaf of folder.keys) {
    const identity = keyIdentity(leaf.key);
    const node: KeyEntryNode = { ...base, kind: "keyEntry", key: leaf.key, info: keys.info[identity] ?? null };
    sink.push(node, depth, sink.keyOf("keyEntry", base.database, identity), leaf.name, false);
  }
}

function databaseRows(
  sink: KeyRowSink,
  datasourceId: string,
  keyspace: DatasourceKeyspace,
  summary: KeyDatabase,
  depth: number,
): void {
  const base: KeyNodeBase = { datasourceId, path: [], database: summary.index };
  const keys = keyspace.byDatabase[summary.index] ?? UNSCANNED_KEYS;
  const node: KeyDatabaseNode = { ...base, kind: "keyDatabase", summary, keys };
  if (
    !sink.push(
      node,
      depth,
      keyDatabaseKey(sink, summary.index),
      keyspace.features?.children === true ? "Keys" : databaseLabel(summary.index),
      true,
    )
  )
    return;
  const filter: KeyFilterNode = {
    ...base,
    kind: "keyFilter",
    filter: keys.filter,
    serverChildren: keyspace.features?.children === true,
  };
  sink.push(filter, depth + 1, sink.keyOf("keyFilter", summary.index), "", false);
  if (keyspace.features?.children === true) {
    childrenRows(sink, base, ROOT_KEY, keys, depth + 1, keyspace.delimiter);
    return;
  }
  if (keys.error !== null) {
    const error: ErrorNode = { kind: "error", datasourceId, error: keys.error };
    sink.push(error, depth + 1, sink.keyOf("keyError", summary.index), keys.error.message, false);
  }
  folderRows(sink, base, groupKeys(keys.keys, keyspace.delimiter), keys, depth + 1);
  if (keys.loading || !keys.started) {
    const loading: LoadingNode = { kind: "loading", datasourceId };
    sink.push(loading, depth + 1, sink.keyOf("keyLoading", summary.index), "", false);
  } else if (keys.cursor !== null) {
    const more: KeyLoadMoreNode = {
      ...base,
      kind: "keyLoadMore",
      loaded: keys.keys.length,
      estimate: summary.keys,
    };
    sink.push(more, depth + 1, sink.keyOf("keyLoadMore", summary.index), loadMoreText(more), false);
  }
}

/** `name` relative to `parent`, without the delimiter a top-level etcd key starts with. */
function childLabel(name: KeyName, parent: KeyName, delimiter: string): string {
  const rest = name.text.slice(parent.text.length);
  const label = delimiter !== "" && rest.startsWith(delimiter) ? rest.slice(delimiter.length) : rest;
  return label === "" ? name.text : label;
}

/**
 * The page's children with every key that names a folder (`/config` or `/config/` beside the
 * folder `/config/`) moved just above that folder: the server orders by bytes, which can put a
 * same-bytes key after its folder, and the two must stay separate rows, never merged.
 */
export function orderedChildren(children: FolderKeys["children"], delimiter: string): FolderKeys["children"] {
  const twinsOf = (folder: KeyName): ReadonlySet<string> => {
    const twins = new Set([keyIdentity(folder)]);
    if (folder.hex === null && delimiter !== "" && folder.text.endsWith(delimiter)) {
      twins.add(keyIdentity({ text: folder.text.slice(0, -delimiter.length), hex: null }));
    }
    return twins;
  };
  const moved = new Set<string>();
  const ordered: FolderKeys["children"][number][] = [];
  for (const child of children) {
    if (child.kind === "key") {
      if (!moved.has(keyIdentity(child.key))) ordered.push(child);
      continue;
    }
    const twins = twinsOf(child.key);
    for (const twin of children) {
      const identity = keyIdentity(twin.key);
      if (twin.kind === "key" && twins.has(identity) && !moved.has(identity) && !ordered.includes(twin)) {
        moved.add(identity);
        ordered.push(twin);
      }
    }
    ordered.push(child);
  }
  return ordered;
}

function childrenRows(
  sink: KeyRowSink,
  base: KeyNodeBase,
  parent: KeyName,
  keys: DatabaseKeys,
  depth: number,
  delimiter: string,
): void {
  const folder = keys.folders?.[keyIdentity(parent)] ?? UNLISTED_FOLDER;
  for (const child of orderedChildren(folder.children, delimiter)) {
    const identity = keyIdentity(child.key);
    if (child.kind === "key") {
      if (keys.filter.mode === "loadedName" && !child.key.text.includes(keys.filter.match)) continue;
      if (keys.filter.leasedOnly === true && (child.revision === undefined || child.revision.lease === "0")) continue;
      const node: KeyEntryNode = {
        ...base,
        kind: "keyEntry",
        key: child.key,
        info: keys.info[identity] ?? null,
        serverChildren: true,
        ...(child.revision === undefined ? {} : { revision: child.revision }),
      };
      sink.push(
        node,
        depth,
        sink.keyOf("keyEntry", base.database, identity),
        childLabel(child.key, parent, delimiter),
        false,
      );
    } else {
      const error = keys.folders?.[identity]?.error;
      const accessError =
        error != null && /permission denied|access denied|not authorized/i.test(error.message) ? error : undefined;
      const node: KeyFolderNode = {
        ...base,
        kind: "keyFolder",
        prefix: child.key.text,
        count: 0,
        exactCount: keys.counts?.[identity] ?? null,
        key: child.key,
        ...(accessError === undefined ? {} : { accessError }),
      };
      const rowKey =
        child.key.hex === null
          ? sink.keyOf("keyFolder", base.database, child.key.text)
          : sink.keyOf("keyFolder", base.database, child.key.text, child.key.hex);
      if (
        sink.push(node, depth, rowKey, childLabel(child.key, parent, delimiter), accessError === undefined) &&
        accessError === undefined
      )
        childrenRows(sink, base, child.key, keys, depth + 1, delimiter);
    }
  }
  if (folder.loading || !folder.started) {
    sink.push(
      { kind: "loading", datasourceId: base.datasourceId },
      depth,
      sink.keyOf("keyChildrenLoading", base.database, keyIdentity(parent)),
      "",
      false,
    );
  } else if (folder.error !== null || folder.cursor !== null) {
    const more: KeyLoadMoreNode = {
      ...base,
      kind: "keyLoadMore",
      parent,
      loaded: folder.children.length,
      estimate: 0,
      restart: folder.error !== null,
    };
    const label =
      folder.error === null
        ? `Listed ${folder.children.length.toLocaleString("en-US")} children · Load more`
        : `${folder.error.message} · Restart listing`;
    sink.push(more, depth, sink.keyOf("keyLoadMore", base.database, keyIdentity(parent)), label, false);
  }
}

/** `Scanned 10,000 of ~48,213 · Load more`. */
export function loadMoreText(node: Pick<KeyLoadMoreNode, "loaded" | "estimate">): string {
  return `Scanned ${node.loaded.toLocaleString("en-US")} of ~${node.estimate.toLocaleString("en-US")} · Load more`;
}

/**
 * The status bar's keyspace part: `db0 · 48,213 keys`, or for a cluster `cluster · 3 primaries`;
 * null before the databases are listed.
 */
export function keyspaceStatusText(
  keyspace: DatasourceKeyspace | undefined,
  nodes: readonly ServerNode[],
): string | null {
  const primaries = nodes.filter((node) => node.role === "primary").length;
  if (isCluster(nodes)) return `cluster · ${String(primaries)} ${primaries === 1 ? "primary" : "primaries"}`;
  const current = keyspace?.databases?.find((database) => database.current);
  if (current === undefined) return null;
  const keys = current.keys.toLocaleString("en-US");
  return `${databaseLabel(current.index)} · ${keys} ${current.keys === 1 ? "key" : "keys"}`;
}

/** The databases the tree lists: those holding keys and the configured one, or all of them. */
export function shownDatabases(databases: readonly KeyDatabase[], showEmpty: boolean): readonly KeyDatabase[] {
  return showEmpty ? databases : databases.filter((database) => database.keys > 0 || database.current);
}

/**
 * A key-value datasource's rows under its node (decision 113): its databases, each with its filter
 * row, folders by delimiter, keys and the Load more row; then the nodes, when there are several.
 */
export function keyspaceRows(
  sink: KeyRowSink,
  datasourceId: string,
  keyspace: DatasourceKeyspace,
  options: KeyTreeOptions,
  depth: number,
): void {
  if (keyspace.databases === null) {
    if (keyspace.error !== null) {
      const error: ErrorNode = { kind: "error", datasourceId, error: keyspace.error };
      sink.push(error, depth, sink.keyOf("error"), keyspace.error.message, false);
    } else {
      sink.push({ kind: "loading", datasourceId }, depth, sink.keyOf("loading"), "", false);
    }
    return;
  }
  for (const summary of shownDatabases(keyspace.databases, options.showEmpty)) {
    databaseRows(sink, datasourceId, keyspace, summary, depth);
  }
  if (keyspace.nodes.length <= 1) return;
  const group: ClusterNodesNode = { kind: "clusterNodes", datasourceId, path: [], count: keyspace.nodes.length };
  const label = isCluster(keyspace.nodes) ? "Cluster nodes" : "Nodes";
  if (!sink.push(group, depth, sink.keyOf("clusterNodes"), label, true)) return;
  for (const node of keyspace.nodes) {
    const row: ClusterNodeNode = { kind: "clusterNode", datasourceId, path: [], node };
    sink.push(row, depth + 1, sink.keyOf("clusterNode", node.id), nodeLabel(node, keyspace.nodes), false);
  }
}

/** The keys among `rows` with no type read yet, by datasource and database: what the tree describes. */
export function undescribedKeys(
  rows: readonly ({ readonly node: ExplorerNode } | undefined)[],
): readonly { readonly datasourceId: string; readonly database: number; readonly keys: readonly KeyName[] }[] {
  const groups = new Map<string, { datasourceId: string; database: number; keys: KeyName[] }>();
  for (const row of rows) {
    if (row?.node.kind !== "keyEntry" || row.node.info !== null || row.node.serverChildren === true) continue;
    const { datasourceId, database, key } = row.node;
    const group = `${datasourceId}\u0000${String(database)}`;
    const found = groups.get(group) ?? { datasourceId, database, keys: [] };
    found.keys.push(key);
    groups.set(group, found);
  }
  return [...groups.values()];
}

/** The keys loaded so far in every keyspace, for Search Everywhere's Keys tab. */
export function loadedKeys(
  keyspaces: Readonly<Record<string, DatasourceKeyspace>>,
): readonly { readonly datasourceId: string; readonly database: number; readonly key: KeyName }[] {
  return Object.entries(keyspaces).flatMap(([datasourceId, keyspace]) =>
    Object.entries(keyspace.byDatabase).flatMap(([database, keys]) =>
      keys.keys.map((key) => ({ datasourceId, database: Number(database), key })),
    ),
  );
}
