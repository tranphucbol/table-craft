import {
  arrange,
  parentFolder,
  topmostItems,
  type ArrangeTree,
  type MoveRequest,
  type TreeItemRef,
} from "@table-craft/desktop/datasourceTree/arrange.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import type { ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";

/** The drag payload's type, so the SQL editor and other panes ignore a tree drag (plan 136). */
export const DATASOURCE_DRAG_TYPE = "application/x-table-craft-tree-items";
/** How long a drag rests on a collapsed folder before it opens, as in DataGrip and Finder. */
export const FOLDER_SPRING_OPEN_MS = 700;
/** On a datasource row, the top half drops before it, the bottom half after it. */
const DATASOURCE_SPLIT = 0.5;
/** On a folder row, the top and bottom quarters drop beside it, the middle half into it. */
const FOLDER_EDGE = 0.25;

export type DropIndicator =
  /** A line along the top of `rows[index]`, or below the last row when `index` is the row count. */
  | { readonly kind: "line"; readonly index: number; readonly depth: number }
  /** The folder row at `index` takes the drop. */
  | { readonly kind: "into"; readonly index: number };

export interface DropTarget {
  readonly request: MoveRequest;
  readonly indicator: DropIndicator;
}

/** The datasources and folders `arrange` sees: the saved ones, as the ephemeral one never moves. */
export function arrangeTreeOf(
  datasources: readonly DatasourceView[],
  folders: readonly string[],
): ArrangeTree<DatasourceView> {
  return { folders, datasources: datasources.filter((datasource) => !datasource.ephemeral) };
}

/** The index past the row's own subtree: where a line drawn after it goes. */
function subtreeEnd(rows: readonly ExplorerRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0;
  let at = index + 1;
  while (at < rows.length && (rows[at]?.depth ?? 0) > depth) at += 1;
  return at;
}

/** The datasource row a row below a datasource belongs to. */
function owningDatasource(rows: readonly ExplorerRow[], index: number): number {
  for (let at = index; at >= 0; at -= 1) if (rows[at]?.node.kind === "datasource") return at;
  return -1;
}

/** The sibling after `id` in its folder; null at the end. */
function nextDatasource(tree: ArrangeTree<DatasourceView>, id: string): TreeItemRef | null {
  const folder = tree.datasources.find((datasource) => datasource.id === id)?.folder ?? null;
  const siblings = tree.datasources.filter((datasource) => datasource.folder === folder);
  const next = siblings[siblings.findIndex((datasource) => datasource.id === id) + 1];
  return next === undefined ? null : { kind: "datasource", id: next.id };
}

function firstDatasource(tree: ArrangeTree<DatasourceView>, folder: string | null): TreeItemRef | null {
  const first = tree.datasources.find((datasource) => datasource.folder === folder);
  return first === undefined ? null : { kind: "datasource", id: first.id };
}

/** What follows folder `path` among its parent's children: its next sibling folder, else the first datasource. */
function afterFolder(tree: ArrangeTree<DatasourceView>, path: string): TreeItemRef | null {
  const parent = parentFolder(path);
  const siblings = tree.folders.filter((candidate) => parentFolder(candidate) === parent);
  const next = siblings[siblings.indexOf(path) + 1];
  return next === undefined ? firstDatasource(tree, parent) : { kind: "folder", path: next };
}

/** The first child of folder `path`, its first folder or else its first datasource. */
function firstChild(tree: ArrangeTree<DatasourceView>, path: string): TreeItemRef | null {
  const folder = tree.folders.find((candidate) => parentFolder(candidate) === path);
  return folder === undefined ? firstDatasource(tree, path) : { kind: "folder", path: folder };
}

function candidate(
  rows: readonly ExplorerRow[],
  index: number,
  fraction: number,
  tree: ArrangeTree<DatasourceView>,
): Omit<DropTarget, "request"> & { readonly folder: string | null; readonly before: TreeItemRef | null } {
  const row = rows[index];
  if (row === undefined)
    return { folder: null, before: null, indicator: { kind: "line", index: rows.length, depth: 0 } };
  const { node, depth } = row;
  if (node.kind === "folder") {
    const parent = parentFolder(node.path);
    if (fraction < FOLDER_EDGE) {
      return { folder: parent, before: { kind: "folder", path: node.path }, indicator: { kind: "line", index, depth } };
    }
    if (fraction <= 1 - FOLDER_EDGE) return { folder: node.path, before: null, indicator: { kind: "into", index } };
    const end = subtreeEnd(rows, index);
    if (row.expanded && end > index + 1) {
      return {
        folder: node.path,
        before: firstChild(tree, node.path),
        indicator: { kind: "line", index: index + 1, depth: depth + 1 },
      };
    }
    return { folder: parent, before: afterFolder(tree, node.path), indicator: { kind: "line", index: end, depth } };
  }
  const owner = node.kind === "datasource" ? index : owningDatasource(rows, index);
  const ownerRow = rows[owner];
  if (ownerRow?.node.kind !== "datasource")
    return { folder: null, before: null, indicator: { kind: "line", index, depth } };
  const datasource = ownerRow.node.datasource;
  if (datasource.ephemeral) {
    return {
      folder: null,
      before: firstDatasource(tree, null),
      indicator: { kind: "line", index: subtreeEnd(rows, owner), depth: ownerRow.depth },
    };
  }
  if (owner === index && fraction < DATASOURCE_SPLIT) {
    return {
      folder: datasource.folder,
      before: { kind: "datasource", id: datasource.id },
      indicator: { kind: "line", index, depth },
    };
  }
  return {
    folder: datasource.folder,
    before: nextDatasource(tree, datasource.id),
    indicator: { kind: "line", index: subtreeEnd(rows, owner), depth: ownerRow.depth },
  };
}

/** Whether main would take the move and it changes something; arrange's own check, run early. */
export function acceptsMove(tree: ArrangeTree<DatasourceView>, request: MoveRequest): boolean {
  try {
    return arrange(tree, request).changed;
  } catch {
    return false;
  }
}

/**
 * Where dropping `dragged` at `fraction` (0 top, 1 bottom) of `rows[index]` lands; `index` past the
 * last row is the empty space below, the end of the top level. Null when the drop would change
 * nothing or main would refuse it, so the pane shows no target there.
 */
export function dropTarget(
  rows: readonly ExplorerRow[],
  index: number,
  fraction: number,
  dragged: readonly TreeItemRef[],
  tree: ArrangeTree<DatasourceView>,
): DropTarget | null {
  const { folder, before, indicator } = candidate(rows, index, fraction, tree);
  const request: MoveRequest = { items: dragged, folder, before };
  if (!acceptsMove(tree, request)) return null;
  const onlyDatasources = dragged.every((item) => item.kind === "datasource");
  const onlyFolders = dragged.every((item) => item.kind === "folder");
  const crossesFolders =
    indicator.kind === "line" &&
    ((onlyDatasources && before?.kind === "folder") || (onlyFolders && before?.kind !== "folder"));
  return { request, indicator: crossesFolders ? levelBoundary(rows, tree, folder, indicator.depth) : indicator };
}

/**
 * The line between a level's folders and its datasources: where `arrange` puts datasources aimed
 * among the folders, and folders aimed among the datasources, as folders always come first.
 */
function levelBoundary(
  rows: readonly ExplorerRow[],
  tree: ArrangeTree<DatasourceView>,
  folder: string | null,
  depth: number,
): DropIndicator {
  const first = tree.datasources.find((datasource) => datasource.folder === folder);
  const firstRow =
    first === undefined
      ? -1
      : rows.findIndex((row) => row.node.kind === "datasource" && row.node.datasource.id === first.id);
  if (firstRow !== -1) return { kind: "line", index: firstRow, depth };
  const owner = folder === null ? -1 : rows.findIndex((row) => row.node.kind === "folder" && row.node.path === folder);
  return { kind: "line", index: owner === -1 ? rows.length : subtreeEnd(rows, owner), depth };
}

export type StepDirection = "up" | "down";

/** The parent all the items sit in; undefined when they span several or name nothing. */
export function commonParent(
  tree: ArrangeTree<DatasourceView>,
  items: readonly TreeItemRef[],
): string | null | undefined {
  const parents = new Set(
    items.map((item) =>
      item.kind === "folder"
        ? parentFolder(item.path)
        : (tree.datasources.find((datasource) => datasource.id === item.id)?.folder ?? null),
    ),
  );
  if (parents.size !== 1) return undefined;
  return [...parents][0];
}

function sameRef(a: TreeItemRef, b: TreeItemRef): boolean {
  return a.kind === "folder" ? b.kind === "folder" && a.path === b.path : b.kind === "datasource" && a.id === b.id;
}

/**
 * Move Up or Move Down (Alt+Shift+↑/↓): the items step past their neighbour among their siblings.
 * Null at the edge, when they span parents, or when one is not saved.
 */
export function stepRequest(
  tree: ArrangeTree<DatasourceView>,
  selected: readonly TreeItemRef[],
  direction: StepDirection,
): MoveRequest | null {
  const items = topmostItems(selected, tree.datasources);
  if (items.length === 0) return null;
  if (items.some((item) => item.kind === "datasource" && !tree.datasources.some((d) => d.id === item.id))) return null;
  const parent = commonParent(tree, items);
  if (parent === undefined) return null;
  const siblings: TreeItemRef[] = [
    ...tree.folders
      .filter((path) => parentFolder(path) === parent)
      .map((path): TreeItemRef => ({ kind: "folder", path })),
    ...tree.datasources
      .filter((datasource) => datasource.folder === parent)
      .map((datasource): TreeItemRef => ({ kind: "datasource", id: datasource.id })),
  ];
  const isMoved = (sibling: TreeItemRef) => items.some((item) => sameRef(item, sibling));
  const positions = siblings.flatMap((sibling, index) => (isMoved(sibling) ? [index] : []));
  let before: TreeItemRef | null;
  if (direction === "up") {
    const first = positions[0] ?? 0;
    const previous = siblings
      .slice(0, first)
      .reverse()
      .find((sibling) => !isMoved(sibling));
    if (previous === undefined) return null;
    before = previous;
  } else {
    const last = positions[positions.length - 1] ?? siblings.length;
    const rest = siblings.slice(last + 1).filter((sibling) => !isMoved(sibling));
    if (rest.length === 0) return null;
    before = rest[1] ?? null;
  }
  const request: MoveRequest = { items, folder: parent, before };
  return acceptsMove(tree, request) ? request : null;
}
