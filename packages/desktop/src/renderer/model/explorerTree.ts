import type {
  ColumnMeta,
  DescribedCatalog,
  EngineError,
  ForeignKey,
  Index,
  Key,
  Namespace,
  Relation,
  RelationKind,
  Routine,
  Sequence,
} from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import {
  nodeKey,
  type DatasourceNode,
  type FolderNode,
  type TreeNode,
} from "@table-craft/desktop/renderer/model/datasourceTree.js";
import {
  EMPTY_KEYSPACE,
  keyspaceRows,
  type DatasourceKeyspace,
  type KeyTreeNode,
} from "@table-craft/desktop/renderer/model/keyTree.js";

/** One namespace's catalog in the renderer: the last one read, and whether a read is running or failed. */
export interface NamespaceState {
  readonly described: DescribedCatalog | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
}

/** What the renderer holds of one datasource's catalog; it dies with the engine (decision 022). */
export interface DatasourceCatalog {
  /** `null` until listed. */
  readonly namespaces: readonly Namespace[] | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  /** By `pathKey`. */
  readonly namespaceStates: Readonly<Record<string, NamespaceState>>;
}

export const EMPTY_CATALOG: DatasourceCatalog = { namespaces: null, loading: false, error: null, namespaceStates: {} };

export type ObjectGroup = "tables" | "views" | "materializedViews" | "routines" | "sequences";
export type RelationGroup = "columns" | "keys" | "foreignKeys" | "indexes";

export const GROUP_LABELS: Readonly<Record<ObjectGroup | RelationGroup, string>> = {
  tables: "tables",
  views: "views",
  materializedViews: "materialized views",
  routines: "routines",
  sequences: "sequences",
  columns: "columns",
  keys: "keys",
  foreignKeys: "foreign keys",
  indexes: "indexes",
};

const RELATION_GROUPS: Readonly<Record<RelationKind, ObjectGroup>> = {
  table: "tables",
  view: "views",
  materializedView: "materializedViews",
};

interface CatalogNodeBase {
  readonly datasourceId: string;
  /** The namespace the node is in, or is. */
  readonly path: readonly string[];
}

export interface NamespaceNode extends CatalogNodeBase {
  readonly kind: "namespace";
  readonly namespace: Namespace;
  readonly state: NamespaceState | null;
}

export interface ObjectGroupNode extends CatalogNodeBase {
  readonly kind: "objectGroup";
  readonly group: ObjectGroup;
  readonly count: number;
}

export interface RelationNode extends CatalogNodeBase {
  readonly kind: "relation";
  readonly relation: Relation;
}

interface InRelation extends CatalogNodeBase {
  readonly relation: string;
}

export interface RelationGroupNode extends InRelation {
  readonly kind: "relationGroup";
  readonly group: RelationGroup;
  readonly count: number;
}

export interface ColumnNode extends InRelation {
  readonly kind: "column";
  readonly column: ColumnMeta;
  readonly primary: boolean;
  readonly foreign: boolean;
}

export interface KeyNode extends InRelation {
  readonly kind: "key";
  readonly key: Key;
  readonly primary: boolean;
}

export interface ForeignKeyNode extends InRelation {
  readonly kind: "foreignKey";
  readonly foreignKey: ForeignKey;
}

export interface IndexNode extends InRelation {
  readonly kind: "index";
  readonly index: Index;
}

export interface RoutineNode extends CatalogNodeBase {
  readonly kind: "routine";
  readonly routine: Routine;
}

export interface SequenceNode extends CatalogNodeBase {
  readonly kind: "sequence";
  readonly sequence: Sequence;
}

/** The `loading…` row under a datasource listing its namespaces or a namespace being described. */
export interface LoadingNode {
  readonly kind: "loading";
  readonly datasourceId: string;
}

/** Why a datasource's namespaces could not be listed. */
export interface ErrorNode {
  readonly kind: "error";
  readonly datasourceId: string;
  readonly error: EngineError;
}

export type CatalogNode =
  | NamespaceNode
  | ObjectGroupNode
  | RelationNode
  | RelationGroupNode
  | ColumnNode
  | KeyNode
  | ForeignKeyNode
  | IndexNode
  | RoutineNode
  | SequenceNode;

export type ExplorerNode = FolderNode | DatasourceNode | CatalogNode | KeyTreeNode | LoadingNode | ErrorNode;

export interface ExplorerRow {
  readonly node: ExplorerNode;
  readonly depth: number;
  /** Unique across the tree; the expansion and selection identity. */
  readonly key: string;
  /** The text speed search matches. */
  readonly label: string;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

export interface ExplorerInput {
  readonly tree: readonly TreeNode[];
  readonly catalogs: Readonly<Record<string, DatasourceCatalog>>;
  /** Expanded datasource and catalog node keys; everything below a datasource starts collapsed. */
  readonly expanded: ReadonlySet<string>;
  /** Collapsed folder paths; folders start expanded. */
  readonly collapsedFolders: ReadonlySet<string>;
  readonly showSystem: boolean;
  /** Whether the datasource's plugin can list its schemas (`schemaTree`) or its keys (`keyValue`, decision 007). */
  readonly canExpand: (datasource: DatasourceView) => boolean;
  /** Key-value datasources' keyspaces (decision 113); absent, none. */
  readonly keyspaces?: Readonly<Record<string, DatasourceKeyspace>>;
  /** Whether the datasource lists keys rather than namespaces (`keyValue`). */
  readonly browsesKeys?: (datasource: DatasourceView) => boolean;
  /** Whether a keyspace lists its empty databases too (Show Empty Databases). */
  readonly showEmptyDatabases?: boolean;
}

export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

const CATALOG_KEY_PREFIX = "cat:";

function catalogKey(datasourceId: string, ...parts: readonly unknown[]): string {
  return `${CATALOG_KEY_PREFIX}${JSON.stringify([datasourceId, ...parts])}`;
}

/** A key-tree row's key; catalog-prefixed, so a detach forgets it with the rest. */
export function keyTreeKey(datasourceId: string, ...parts: readonly unknown[]): string {
  return catalogKey(datasourceId, ...parts);
}

/** Every catalog key of `datasourceId` starts with this, so a detach can forget them all. */
export function catalogKeyPrefix(datasourceId: string): string {
  return `${CATALOG_KEY_PREFIX}${JSON.stringify([datasourceId]).slice(0, -1)},`;
}

export function datasourceKey(datasourceId: string): string {
  return `datasource:${datasourceId}`;
}

export function namespaceKey(datasourceId: string, path: readonly string[]): string {
  return catalogKey(datasourceId, "namespace", path);
}

export function objectGroupKey(datasourceId: string, path: readonly string[], group: ObjectGroup): string {
  return catalogKey(datasourceId, "objectGroup", path, group);
}

export function relationKey(datasourceId: string, path: readonly string[], relation: string): string {
  return catalogKey(datasourceId, "relation", path, relation);
}

/** Name, kind and signature, since a PostgreSQL overload shares its name (decision 090). */
export function routineKey(
  datasourceId: string,
  path: readonly string[],
  routine: Pick<Routine, "name" | "kind" | "signature">,
): string {
  return catalogKey(datasourceId, "routine", path, routine.name, routine.kind, routine.signature);
}

export function sequenceKey(datasourceId: string, path: readonly string[], sequence: string): string {
  return catalogKey(datasourceId, "sequence", path, sequence);
}

/** The keys to expand so `relation` shows, ending with the relation's own key. */
export function revealKeys(
  datasourceId: string,
  path: readonly string[],
  relation: Pick<Relation, "name" | "kind">,
): readonly string[] {
  return [
    datasourceKey(datasourceId),
    ...path.map((_, index) => namespaceKey(datasourceId, path.slice(0, index + 1))),
    objectGroupKey(datasourceId, path, RELATION_GROUPS[relation.kind]),
    relationKey(datasourceId, path, relation.name),
  ];
}

/** The keys to expand so `column` of `relation` shows, ending with the column's own key. */
export function columnRevealKeys(
  datasourceId: string,
  path: readonly string[],
  relation: Pick<Relation, "name" | "kind">,
  column: string,
): readonly string[] {
  return [
    ...revealKeys(datasourceId, path, relation),
    catalogKey(datasourceId, "relationGroup", path, relation.name, "columns"),
    columnKey(datasourceId, path, relation.name, column),
  ];
}

export function columnKey(datasourceId: string, path: readonly string[], relation: string, column: string): string {
  return catalogKey(datasourceId, "column", path, relation, column);
}

const COLUMN_NAME_PART = 4;

/** The column a column node's key names, or null for any other key. */
export function columnNameOf(key: string): string | null {
  if (!key.startsWith(`${CATALOG_KEY_PREFIX}[`)) return null;
  const parts: unknown = JSON.parse(key.slice(CATALOG_KEY_PREFIX.length));
  if (!Array.isArray(parts) || parts[1] !== "column") return null;
  const name: unknown = parts[COLUMN_NAME_PART];
  return typeof name === "string" ? name : null;
}

/** The kind and database a key-tree row's key names, or null for any other key. */
export function keyTreeRowOf(
  key: string,
): { readonly kind: string; readonly database: number; readonly rest: readonly unknown[] } | null {
  if (!key.startsWith(`${CATALOG_KEY_PREFIX}[`)) return null;
  const parts: unknown = JSON.parse(key.slice(CATALOG_KEY_PREFIX.length));
  if (!Array.isArray(parts)) return null;
  const [, kind, database, ...rest] = parts as unknown[];
  if (typeof kind !== "string" || !kind.startsWith("key") || typeof database !== "number") return null;
  return { kind, database, rest };
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length < path.length && prefix.every((part, index) => path[index] === part);
}

/** The namespaces directly under `parent` (`null`: the datasource), in the plugin's order. */
function childNamespaces(namespaces: readonly Namespace[], parent: readonly string[] | null): readonly Namespace[] {
  return namespaces.filter((namespace) => {
    const ancestors = namespaces.filter((other) => isPrefix(other.path, namespace.path));
    if (parent === null) return ancestors.length === 0;
    const nearest = ancestors.reduce<Namespace | null>(
      (best, other) => (best === null || other.path.length > best.path.length ? other : best),
      null,
    );
    return nearest !== null && pathKey(nearest.path) === pathKey(parent);
  });
}

interface Builder {
  readonly input: ExplorerInput;
  readonly rows: ExplorerRow[];
}

function push(
  builder: Builder,
  node: ExplorerNode,
  depth: number,
  key: string,
  label: string,
  expandable: boolean,
): boolean {
  const expanded =
    expandable &&
    (node.kind === "folder" ? !builder.input.collapsedFolders.has(node.path) : builder.input.expanded.has(key));
  builder.rows.push({ node, depth, key, label, expandable, expanded });
  return expanded;
}

function relationRows(
  builder: Builder,
  datasourceId: string,
  path: readonly string[],
  relation: Relation,
  depth: number,
) {
  const base = { datasourceId, path, relation: relation.name };
  const foreignColumns = new Set(relation.foreignKeys.flatMap((foreignKey) => foreignKey.columns));
  const primaryColumns = new Set(relation.primaryKey?.columns ?? []);
  const keys = [
    ...(relation.primaryKey === null ? [] : [{ key: relation.primaryKey, primary: true }]),
    ...relation.uniqueKeys.map((key) => ({ key, primary: false })),
  ];
  const groups: readonly { readonly group: RelationGroup; readonly items: readonly CatalogNode[] }[] = [
    {
      group: "columns",
      items: relation.columns.map((column): ColumnNode => ({
        ...base,
        kind: "column",
        column,
        primary: primaryColumns.has(column.name),
        foreign: foreignColumns.has(column.name),
      })),
    },
    { group: "keys", items: keys.map(({ key, primary }): KeyNode => ({ ...base, kind: "key", key, primary })) },
    {
      group: "foreignKeys",
      items: relation.foreignKeys.map((foreignKey): ForeignKeyNode => ({ ...base, kind: "foreignKey", foreignKey })),
    },
    { group: "indexes", items: relation.indexes.map((index): IndexNode => ({ ...base, kind: "index", index })) },
  ];
  for (const { group, items } of groups) {
    if (items.length === 0) continue;
    const groupNode: RelationGroupNode = { ...base, kind: "relationGroup", group, count: items.length };
    const key = catalogKey(datasourceId, "relationGroup", path, relation.name, group);
    if (!push(builder, groupNode, depth, key, GROUP_LABELS[group], true)) continue;
    for (const item of items) {
      const name = itemName(item);
      push(builder, item, depth + 1, catalogKey(datasourceId, item.kind, path, relation.name, name), name, false);
    }
  }
}

function itemName(node: CatalogNode): string {
  switch (node.kind) {
    case "column":
      return node.column.name;
    case "key":
      return node.key.name;
    case "foreignKey":
      return node.foreignKey.name;
    case "index":
      return node.index.name;
    default:
      return "";
  }
}

function catalogRows(builder: Builder, datasourceId: string, described: DescribedCatalog, depth: number): void {
  const { path, relations, routines, sequences } = described.catalog;
  const base = { datasourceId, path };
  const byGroup = (group: ObjectGroup) => relations.filter((relation) => RELATION_GROUPS[relation.kind] === group);
  const groups: readonly { readonly group: ObjectGroup; readonly count: number; readonly rows: () => void }[] = [
    ...(["tables", "views", "materializedViews"] as const).map((group) => {
      const members = byGroup(group);
      return {
        group,
        count: members.length,
        rows: () => {
          for (const relation of members) {
            const node: RelationNode = { ...base, kind: "relation", relation };
            const key = relationKey(datasourceId, path, relation.name);
            if (push(builder, node, depth + 1, key, relation.name, true)) {
              relationRows(builder, datasourceId, path, relation, depth + 2);
            }
          }
        },
      };
    }),
    {
      group: "routines",
      count: routines.length,
      rows: () => {
        for (const routine of routines) {
          const key = routineKey(datasourceId, path, routine);
          push(builder, { ...base, kind: "routine", routine }, depth + 1, key, routine.name, false);
        }
      },
    },
    {
      group: "sequences",
      count: sequences.length,
      rows: () => {
        for (const sequence of sequences) {
          const key = sequenceKey(datasourceId, path, sequence.name);
          push(builder, { ...base, kind: "sequence", sequence }, depth + 1, key, sequence.name, false);
        }
      },
    },
  ];
  for (const { group, count, rows } of groups) {
    if (count === 0) continue;
    const node: ObjectGroupNode = { ...base, kind: "objectGroup", group, count };
    if (push(builder, node, depth, objectGroupKey(datasourceId, path, group), GROUP_LABELS[group], true)) rows();
  }
}

/** The top-level namespaces Manage Shown Schemas keeps (decision 117); null when it keeps them all. */
function shownFilter(datasource: Pick<DatasourceView, "shownNamespaces">): ReadonlySet<string> | null {
  return datasource.shownNamespaces === undefined ? null : new Set(datasource.shownNamespaces);
}

/** The top-level namespaces a datasource lists, as Manage Shown Schemas offers them. */
export function topLevelNamespaces(namespaces: readonly Namespace[]): readonly Namespace[] {
  return childNamespaces(namespaces, null);
}

/**
 * How many of the listed top-level namespaces Manage Shown Schemas keeps, for the datasource row's
 * "N of M"; null when it keeps them all or nothing is listed yet. Hidden system schemas count on
 * neither side, so the number matches the rows the tree draws.
 */
export function shownNamespaceCount(
  datasource: Pick<DatasourceView, "shownNamespaces">,
  namespaces: readonly Namespace[] | null,
  showSystem: boolean,
): { readonly shown: number; readonly total: number } | null {
  const filter = shownFilter(datasource);
  if (filter === null || namespaces === null) return null;
  const top = topLevelNamespaces(namespaces).filter((namespace) => showSystem || !namespace.system);
  return { shown: top.filter((namespace) => filter.has(namespace.name)).length, total: top.length };
}

function namespaceRows(
  builder: Builder,
  datasourceId: string,
  catalog: DatasourceCatalog,
  namespaces: readonly Namespace[],
  parent: readonly string[] | null,
  depth: number,
  shown: ReadonlySet<string> | null = null,
): void {
  for (const namespace of childNamespaces(namespaces, parent)) {
    if (namespace.system && !builder.input.showSystem) continue;
    if (parent === null && shown !== null && !shown.has(namespace.name)) continue;
    const state = catalog.namespaceStates[pathKey(namespace.path)] ?? null;
    const node: NamespaceNode = { kind: "namespace", datasourceId, path: namespace.path, namespace, state };
    if (!push(builder, node, depth, namespaceKey(datasourceId, namespace.path), namespace.name, true)) continue;
    namespaceRows(builder, datasourceId, catalog, namespaces, namespace.path, depth + 1);
    if (namespace.kind !== "schema") continue;
    if (state?.error != null) {
      const errorNode: ErrorNode = { kind: "error", datasourceId, error: state.error };
      push(
        builder,
        errorNode,
        depth + 1,
        catalogKey(datasourceId, "error", namespace.path),
        state.error.message,
        false,
      );
    }
    if (state?.described != null) catalogRows(builder, datasourceId, state.described, depth + 1);
    else if (state === null || state.error === null) {
      push(
        builder,
        { kind: "loading", datasourceId },
        depth + 1,
        catalogKey(datasourceId, "loading", namespace.path),
        "",
        false,
      );
    }
  }
}

function datasourceRows(builder: Builder, node: DatasourceNode, depth: number): void {
  const { datasource } = node;
  const expandable = builder.input.canExpand(datasource);
  if (!push(builder, node, depth, nodeKey(node), datasource.name, expandable)) return;
  if (builder.input.browsesKeys?.(datasource) === true) {
    const sink = {
      push: (child: ExplorerNode, at: number, key: string, label: string, opens: boolean) =>
        push(builder, child, at, key, label, opens),
      keyOf: (...parts: readonly unknown[]) => catalogKey(datasource.id, ...parts),
    };
    const keyspace = builder.input.keyspaces?.[datasource.id] ?? EMPTY_KEYSPACE;
    const options = {
      showEmpty: builder.input.showEmptyDatabases === true,
      loadOnDemand: datasource.loadKeysOnDemand === true,
    };
    keyspaceRows(sink, datasource.id, keyspace, options, depth + 1);
    return;
  }
  const catalog = builder.input.catalogs[datasource.id] ?? EMPTY_CATALOG;
  if (catalog.namespaces !== null) {
    namespaceRows(builder, datasource.id, catalog, catalog.namespaces, null, depth + 1, shownFilter(datasource));
  } else if (catalog.error !== null) {
    const errorNode: ErrorNode = { kind: "error", datasourceId: datasource.id, error: catalog.error };
    push(builder, errorNode, depth + 1, catalogKey(datasource.id, "error"), catalog.error.message, false);
  } else {
    push(
      builder,
      { kind: "loading", datasourceId: datasource.id },
      depth + 1,
      catalogKey(datasource.id, "loading"),
      "",
      false,
    );
  }
}

function treeRows(builder: Builder, nodes: readonly TreeNode[], depth: number): void {
  for (const node of nodes) {
    if (node.kind === "datasource") {
      datasourceRows(builder, node, depth);
      continue;
    }
    if (push(builder, node, depth, nodeKey(node), node.name, true)) treeRows(builder, node.children, depth + 1);
  }
}

/**
 * The Database pane's rows, in order: folders and datasources (plan 004), then each expanded
 * datasource's namespaces and each expanded namespace's objects in DataGrip's groups. Only what is
 * expanded becomes a row, so a 500-table schema costs rows only once its group is open.
 */
export function explorerRows(input: ExplorerInput): readonly ExplorerRow[] {
  const builder: Builder = { input, rows: [] };
  treeRows(builder, input.tree, 0);
  return builder.rows;
}

/** The datasource a row belongs to, if any. */
export function datasourceIdOf(node: ExplorerNode): string | null {
  if (node.kind === "folder") return null;
  if (node.kind === "datasource") return node.datasource.id;
  return node.datasourceId;
}

/** The relation, routine or sequence a catalog node is or belongs to. */
export function objectNameOf(node: ExplorerNode): string | null {
  switch (node.kind) {
    case "relation":
      return node.relation.name;
    case "routine":
      return node.routine.name;
    case "sequence":
      return node.sequence.name;
    case "relationGroup":
    case "column":
    case "key":
    case "foreignKey":
    case "index":
      return node.relation;
    case "keyEntry":
      return node.key.text;
    default:
      return null;
  }
}

/** The relations of every catalog loaded so far, for Search Everywhere's Tables tab. */
export function loadedRelations(
  catalogs: Readonly<Record<string, DatasourceCatalog>>,
): readonly { readonly datasourceId: string; readonly path: readonly string[]; readonly relation: Relation }[] {
  return Object.entries(catalogs).flatMap(([datasourceId, catalog]) =>
    Object.values(catalog.namespaceStates).flatMap(({ described }) =>
      described === null
        ? []
        : described.catalog.relations.map((relation) => ({ datasourceId, path: described.catalog.path, relation })),
    ),
  );
}
