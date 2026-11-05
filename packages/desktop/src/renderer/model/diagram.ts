import {
  hiddenKeyId,
  virtualKeyId,
  type DiagramColumnMode,
  type DiagramState,
  type NamespaceLayout,
  type VirtualKey,
} from "@table-craft/desktop/diagrams/state.js";
import type { DescribedCatalog, InferredKey, Relation, RelationKind } from "@table-craft/desktop/engine/protocol.js";

/** Where an edge comes from, which is how it is drawn (plan 152, decision 2). */
export type EdgeOrigin = "declared" | "inferred" | "virtual";
export const EDGE_ORIGINS = ["declared", "inferred", "virtual"] as const satisfies readonly EdgeOrigin[];

/** Up to this many tables a new diagram shows every column; above it, keys only (decision 13). */
export const DIAGRAM_FULL_COLUMNS_TABLES = 40;
/** Above this many tables a new diagram shows none and opens the Tables picker (decision 13). */
export const DIAGRAM_AUTO_SHOW_TABLES = 200;

export interface DiagramColumn {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  /** The source of a drawn edge. */
  readonly foreignKey: boolean;
  /** The target of a drawn edge. */
  readonly referenced: boolean;
}

export interface DiagramTable {
  /** The relation's name in this namespace; a ghost's `JSON.stringify([...path, relation])`. */
  readonly id: string;
  /** What the header reads: the relation's name, or a ghost's `namespace.table`. */
  readonly name: string;
  readonly kind: RelationKind | "external";
  readonly path: readonly string[];
  readonly relation: string;
  /** Empty for a ghost, which is drawn header-only (decision 15). */
  readonly columns: readonly DiagramColumn[];
}

export interface DiagramEdge {
  readonly id: string;
  readonly origin: EdgeOrigin;
  /** The inferred key's or virtual key's own id, which hide, keep and delete refer to. */
  readonly keyId: string;
  readonly from: { readonly relation: string; readonly columns: readonly string[] };
  readonly to: { readonly path: readonly string[]; readonly relation: string; readonly columns: readonly string[] };
  /** The table ids of both ends. */
  readonly source: string;
  readonly target: string;
  /** Any source column is nullable: the target end reads zero-or-one. */
  readonly optional: boolean;
}

export interface DiagramGraph {
  readonly tables: readonly DiagramTable[];
  readonly edges: readonly DiagramEdge[];
}

/** A virtual key this namespace holds whose table or columns are gone from the schema. */
export interface MissingKey {
  readonly key: VirtualKey;
  readonly reason: string;
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index]);
}

function columnsKey(relation: string, columns: readonly string[]): string {
  return JSON.stringify([relation, columns]);
}

/** The id a ghost table carries: the target's full path, which no local name can equal. */
export function ghostTableId(path: readonly string[], relation: string): string {
  return JSON.stringify([...path, relation]);
}

function hasColumns(relation: Relation | undefined, columns: readonly string[]): boolean {
  return (
    relation !== undefined &&
    columns.length > 0 &&
    columns.every((name) => relation.columns.some((column) => column.name === name))
  );
}

interface Draft {
  readonly origin: EdgeOrigin;
  readonly keyId: string;
  readonly from: DiagramEdge["from"];
  readonly to: DiagramEdge["to"];
}

function declaredDrafts(relations: readonly Relation[]): Draft[] {
  return relations.flatMap((relation) =>
    relation.foreignKeys.map((key) => ({
      origin: "declared" as const,
      keyId: key.name,
      from: { relation: relation.name, columns: key.columns },
      to: key.target,
    })),
  );
}

/**
 * Splits a namespace's virtual keys into those it can draw and those naming a table or column the
 * schema no longer has, which stay saved and are listed rather than dropped (plan 152 phase 2).
 */
export function virtualKeysOf(
  catalog: DescribedCatalog,
  keys: readonly VirtualKey[],
): { readonly drawn: readonly VirtualKey[]; readonly missing: readonly MissingKey[] } {
  const { path, relations } = catalog.catalog;
  const byName = new Map(relations.map((relation) => [relation.name, relation]));
  const drawn: VirtualKey[] = [];
  const missing: MissingKey[] = [];
  for (const key of keys) {
    if (!samePath(key.path, path)) continue;
    const local = samePath(key.target.path, path);
    if (!hasColumns(byName.get(key.relation), key.columns))
      missing.push({ key, reason: `${key.relation} or its columns are gone` });
    else if (local && !hasColumns(byName.get(key.target.relation), key.target.columns))
      missing.push({ key, reason: `${key.target.relation} or its columns are gone` });
    else drawn.push(key);
  }
  return { drawn, missing };
}

/**
 * The diagram of one described namespace (plan 152 phase 1): its relations, the declared keys, the
 * inferred ones the user has not hidden and that no declared or virtual key already draws on the same
 * columns, and the virtual keys; a target in another namespace becomes a header-only ghost table.
 */
export function diagramGraph(input: {
  readonly catalog: DescribedCatalog;
  readonly inferred: readonly InferredKey[];
  readonly state: DiagramState;
}): DiagramGraph {
  const { path, relations } = input.catalog.catalog;
  const local = new Set(relations.map((relation) => relation.name));
  const declared = declaredDrafts(relations);
  const virtual: Draft[] = virtualKeysOf(input.catalog, input.state.virtualKeys).drawn.map((key) => ({
    origin: "virtual",
    keyId: key.id,
    from: { relation: key.relation, columns: key.columns },
    to: key.target,
  }));
  const taken = new Set([...declared, ...virtual].map((draft) => columnsKey(draft.from.relation, draft.from.columns)));
  const hidden = new Set(input.state.hiddenKeys);
  const inferred: Draft[] = input.state.inferKeys
    ? input.inferred
        .filter((key) => !hidden.has(hiddenKeyId(path, key.id)) && !taken.has(columnsKey(key.relation, key.columns)))
        .map((key) => ({
          origin: "inferred",
          keyId: key.id,
          from: { relation: key.relation, columns: key.columns },
          to: { path, relation: key.target.relation, columns: key.target.columns },
        }))
    : [];
  const drafts = [...declared, ...inferred, ...virtual];
  const ghosts = new Map<string, DiagramTable>();
  const targetOf = (to: Draft["to"]): string => {
    if (samePath(to.path, path) && local.has(to.relation)) return to.relation;
    const id = ghostTableId(to.path, to.relation);
    if (!ghosts.has(id))
      ghosts.set(id, {
        id,
        name: [to.path.at(-1), to.relation].filter((part) => part !== undefined).join("."),
        kind: "external",
        path: to.path,
        relation: to.relation,
        columns: [],
      });
    return id;
  };
  const byName = new Map(relations.map((relation) => [relation.name, relation]));
  const edges: DiagramEdge[] = drafts.map((draft) => {
    const source = byName.get(draft.from.relation);
    return {
      id: `${draft.origin}:${draft.from.relation}:${draft.keyId}`,
      origin: draft.origin,
      keyId: draft.keyId,
      from: draft.from,
      to: draft.to,
      source: draft.from.relation,
      target: targetOf(draft.to),
      optional: draft.from.columns.some(
        (name) => source?.columns.find((column) => column.name === name)?.nullable ?? false,
      ),
    };
  });
  const sources = new Set(edges.flatMap((edge) => edge.from.columns.map((name) => columnsKey(edge.source, [name]))));
  const targets = new Set(edges.flatMap((edge) => edge.to.columns.map((name) => columnsKey(edge.target, [name]))));
  const tables: DiagramTable[] = relations.map((relation) => ({
    id: relation.name,
    name: relation.name,
    kind: relation.kind,
    path,
    relation: relation.name,
    columns: relation.columns.map((column) => ({
      name: column.name,
      type: column.type,
      nullable: column.nullable,
      primaryKey: relation.primaryKey?.columns.includes(column.name) ?? false,
      foreignKey: sources.has(columnsKey(relation.name, [column.name])),
      referenced: targets.has(columnsKey(relation.name, [column.name])),
    })),
  }));
  return { tables: [...tables, ...ghosts.values()], edges };
}

/**
 * What a namespace opened for the first time shows (decision 13): every column up to
 * `DIAGRAM_FULL_COLUMNS_TABLES` tables, keys only above it, and above `DIAGRAM_AUTO_SHOW_TABLES` no
 * table at all, the Tables picker open instead of a hairball.
 */
export function openingLayout(tableIds: readonly string[]): {
  readonly layout: NamespaceLayout;
  readonly pickerOpen: boolean;
} {
  const many = tableIds.length > DIAGRAM_AUTO_SHOW_TABLES;
  return {
    layout: {
      positions: {},
      hiddenTables: many ? [...tableIds] : [],
      columns: tableIds.length > DIAGRAM_FULL_COLUMNS_TABLES ? "keys" : "all",
    },
    pickerOpen: many,
  };
}

/** The tables and edges left once hidden tables drop out; a ghost shows while an edge reaches it. */
export function shownGraph(graph: DiagramGraph, hiddenTables: readonly string[]): DiagramGraph {
  const hidden = new Set(hiddenTables);
  const localShown = new Set(
    graph.tables.filter((table) => table.kind !== "external" && !hidden.has(table.id)).map((table) => table.id),
  );
  const ghosts = new Set(graph.tables.filter((table) => table.kind === "external").map((table) => table.id));
  const edges = graph.edges.filter(
    (edge) => localShown.has(edge.source) && (localShown.has(edge.target) || ghosts.has(edge.target)),
  );
  const reached = new Set(edges.map((edge) => edge.target));
  const tables = graph.tables.filter((table) =>
    table.kind === "external" ? reached.has(table.id) : localShown.has(table.id),
  );
  return { tables, edges };
}

/** The rows a table draws in a column mode: every column, or keys only (its primary key and edge ends). */
export function visibleColumns(table: DiagramTable, mode: DiagramColumnMode): readonly DiagramColumn[] {
  if (mode !== "keys") return table.columns;
  return table.columns.filter((column) => column.primaryKey || column.foreignKey || column.referenced);
}

/** Whether a column mode draws types beside names. */
export function showsTypes(mode: DiagramColumnMode): boolean {
  return mode !== "names";
}

/** The hover text of an edge: `orders.customer_id → customers.id` and where it comes from. */
export function edgeLabel(edge: DiagramEdge, tables: readonly DiagramTable[]): string {
  const target = tables.find((table) => table.id === edge.target)?.name ?? edge.to.relation;
  const ends = (relation: string, columns: readonly string[]): string =>
    columns.map((column) => `${relation}.${column}`).join(", ");
  return `${ends(edge.from.relation, edge.from.columns)} → ${ends(target, edge.to.columns)} (${edge.origin})`;
}

/** An inferred key the user hid from this namespace; `key` is null once the heuristic stops proposing it. */
export interface HiddenKey {
  readonly id: string;
  readonly label: string;
  readonly key: InferredKey | null;
}

function keyLabel(from: string, columns: readonly string[], to: string, targetColumns: readonly string[]): string {
  const ends = (relation: string, names: readonly string[]): string =>
    names.map((name) => `${relation}.${name}`).join(", ");
  return `${ends(from, columns)} → ${ends(to, targetColumns)}`;
}

/** What the toolbar's Hidden Keys lists for a namespace: the keys hidden in it and its virtual keys gone missing. */
export function hiddenKeysOf(
  catalog: DescribedCatalog,
  inferred: readonly InferredKey[],
  state: DiagramState,
): { readonly hidden: readonly HiddenKey[]; readonly missing: readonly MissingKey[] } {
  const { path } = catalog.catalog;
  const proposed = new Map(inferred.map((key) => [hiddenKeyId(path, key.id), key]));
  const hidden = state.hiddenKeys.flatMap((id): HiddenKey[] => {
    const parsed = JSON.parse(id) as unknown;
    if (!Array.isArray(parsed) || JSON.stringify(parsed[0]) !== JSON.stringify(path)) return [];
    const key = proposed.get(id) ?? null;
    const label =
      key === null ? String(parsed[1]) : keyLabel(key.relation, key.columns, key.target.relation, key.target.columns);
    return [{ id, label, key }];
  });
  return { hidden, missing: virtualKeysOf(catalog, state.virtualKeys).missing };
}

/** Hide Inferred Key (decision 7): the key stays proposed, and stops being drawn. */
export function withHiddenKey(state: DiagramState, path: readonly string[], keyId: string): DiagramState {
  const id = hiddenKeyId(path, keyId);
  return state.hiddenKeys.includes(id) ? state : { ...state, hiddenKeys: [...state.hiddenKeys, id] };
}

/** Restore: every hidden key named, or all of them when `ids` is absent. */
export function withRestoredKeys(state: DiagramState, ids?: readonly string[]): DiagramState {
  if (state.hiddenKeys.length === 0) return state;
  return { ...state, hiddenKeys: ids === undefined ? [] : state.hiddenKeys.filter((id) => !ids.includes(id)) };
}

/** A virtual key over the same columns as an edge: what Keep as Virtual Key saves for an inferred one. */
export function virtualKeyFor(path: readonly string[], edge: Pick<DiagramEdge, "from" | "to">): VirtualKey {
  const key = { path, relation: edge.from.relation, columns: edge.from.columns, target: edge.to };
  return { id: virtualKeyId(key), ...key };
}

/** Adds a virtual key unless one on the same two ends is saved already. */
export function withVirtualKey(state: DiagramState, key: VirtualKey): DiagramState {
  if (state.virtualKeys.some((saved) => saved.id === key.id)) return state;
  return { ...state, virtualKeys: [...state.virtualKeys, key] };
}

export function withoutVirtualKey(state: DiagramState, id: string): DiagramState {
  if (!state.virtualKeys.some((key) => key.id === id)) return state;
  return { ...state, virtualKeys: state.virtualKeys.filter((key) => key.id !== id) };
}

/** Why a drawn relationship cannot be saved, or null when it can: both ends named, as many columns each side. */
export function relationshipProblem(draft: {
  readonly from: string;
  readonly columns: readonly string[];
  readonly to: string;
  readonly targetColumns: readonly string[];
}): string | null {
  if (draft.from === "" || draft.to === "") return "Choose both tables.";
  if (draft.columns.length === 0 || draft.columns.some((column) => column === "")) return "Choose every source column.";
  if (draft.targetColumns.some((column) => column === "")) return "Choose every target column.";
  if (draft.columns.length !== draft.targetColumns.length)
    return "The source and the target need as many columns as each other.";
  if (new Set(draft.columns).size !== draft.columns.length) return "Choose each source column once.";
  return null;
}
