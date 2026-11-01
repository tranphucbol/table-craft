import { compareFolderPaths, FOLDER_SEPARATOR } from "@table-craft/desktop/datasourceTree/arrange.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";

export interface FolderNode {
  readonly kind: "folder";
  /** The full `/`-separated path, which is the folder's identity. */
  readonly path: string;
  readonly name: string;
  readonly children: readonly TreeNode[];
}

export interface DatasourceNode {
  readonly kind: "datasource";
  readonly datasource: DatasourceView;
}

export type TreeNode = FolderNode | DatasourceNode;

interface MutableFolder {
  readonly path: string;
  readonly name: string;
  readonly folders: Map<string, MutableFolder>;
  readonly datasources: DatasourceView[];
}

function folder(path: string, name: string): MutableFolder {
  return { path, name, folders: new Map(), datasources: [] };
}

function ensure(root: MutableFolder, path: string): MutableFolder {
  let current = root;
  for (const part of path.split(FOLDER_SEPARATOR)) {
    const childPath = current.path === "" ? part : `${current.path}${FOLDER_SEPARATOR}${part}`;
    let child = current.folders.get(part);
    if (child === undefined) {
      child = folder(childPath, part);
      current.folders.set(part, child);
    }
    current = child;
  }
  return current;
}

function freeze(node: MutableFolder): readonly TreeNode[] {
  const folders = [...node.folders.values()].map((child): FolderNode => ({
    kind: "folder",
    path: child.path,
    name: child.name,
    children: freeze(child),
  }));
  const datasources = node.datasources.map((datasource): DatasourceNode => ({ kind: "datasource", datasource }));
  return [...folders, ...datasources];
}

/**
 * The Database pane's tree in the stored order (plan 136): each level its folders, then its
 * datasources, both in the order `folders` and `datasources` list them.
 */
export function buildTree(
  datasources: readonly DatasourceView[],
  folders: readonly string[] = [],
): readonly TreeNode[] {
  const root = folder("", "");
  for (const path of folders) ensure(root, path);
  for (const datasource of datasources) {
    (datasource.folder === null ? root : ensure(root, datasource.folder)).datasources.push(datasource);
  }
  return freeze(root);
}

export interface VisibleRow {
  readonly node: TreeNode;
  readonly depth: number;
  /** The selection key: `datasource:<id>` or `folder:<path>`. */
  readonly key: string;
}

export function nodeKey(node: TreeNode): string {
  return node.kind === "folder" ? `folder:${node.path}` : `datasource:${node.datasource.id}`;
}

/** The rows a keyboard walks, in order, skipping the children of collapsed folders. */
export function visibleRows(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): readonly VisibleRow[] {
  return nodes.flatMap((node) => {
    const row: VisibleRow = { node, depth, key: nodeKey(node) };
    if (node.kind === "datasource" || collapsed.has(node.path)) return [row];
    return [row, ...visibleRows(node.children, collapsed, depth + 1)];
  });
}

/** Every folder path the datasources use, A–Z, for the folder field's suggestions. */
export function folderPaths(datasources: readonly DatasourceView[], folders: readonly string[] = []): string[] {
  const paths = new Set<string>(folders);
  for (const { folder: path } of datasources) {
    if (path === null) continue;
    const parts = path.split(FOLDER_SEPARATOR);
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join(FOLDER_SEPARATOR)));
  }
  return [...paths].sort(compareFolderPaths);
}
